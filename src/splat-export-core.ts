import {
    Column,
    combine,
    DataTable,
    logger as splatTransformLogger,
    MemoryFileSystem,
    simplifyGaussians,
    writeHtml,
    writeLod,
    writeSog,
    ZipFileSystem,
    type DeviceCreator,
    type FileSystem,
    type LogEvent,
    type Renderer
} from '@playcanvas/splat-transform';

import { Events } from './events';
import { buildAnnotationLinksInjection } from './viewer-companion/annotation-links';

// Inject the annotation-link companion into an HTML string before </body>.
// No-op (returns the input) when there are no annotation links.
const injectAnnotationLinks = (html: string, viewerSettingsJson: any): string => {
    const injection = buildAnnotationLinksInjection(viewerSettingsJson?.annotations ?? []);
    if (!injection) {
        return html;
    }
    if (html.includes('</body>')) {
        return html.replace('</body>', `${injection}</body>`);
    }
    return html + injection;
};

// Bridge splat-transform progress events to supersplat's events.
//
// An optional getPrefix supplies a phase label (e.g. "Building detail level 2",
// "Packaging streaming chunks") for multi-pass operations like streaming LOD
// export. splat-transform also emits an {index,total} counter on the scopes
// that wrap its repeated work units - decimation iterations
// (`logger.group('Decimate iteration', {index,total})`) and per-chunk SOG
// writes (`logger.group('<lod>_<i>', {index,total})`). When a prefix is present
// we fold the outermost active counter into each per-step message, so the
// otherwise-identical low-level GPU bars read as distinct numbered steps
// (e.g. "Packaging streaming chunks (5/40): k-means") instead of cycling
// through bare repeated labels. Exporters that pass no prefix keep their
// original output.
const createProgressRenderer = (header: string, events?: Events, getPrefix?: () => string, countSteps?: () => boolean, onLog?: (level: string, text: string) => void, shouldCancel?: () => boolean): Renderer => {
    // Active scopes carrying a counter, ordered outermost-first. The outermost
    // is the meaningful unit (e.g. the chunk number during packaging); inner SOG
    // sub-steps are ignored so the count stays stable across a unit. The counter
    // is only surfaced when countSteps() is true, because splat-transform's
    // decimation-iteration total is an estimate that can be exceeded - that
    // phase carries its level number in the prefix instead.
    const counters: { depth: number; index: number; total: number }[] = [];

    const stepText = (name: string): string => {
        const prefix = getPrefix?.();
        if (!prefix) {
            return name;
        }
        const counter = countSteps?.() ? counters[0] : undefined;
        return `${prefix}${counter ? ` (${counter.index}/${counter.total})` : ''}: ${name}`;
    };

    return {
        handle: (event: LogEvent) => {
            // Cooperative cancellation: throw on a forward-progress event so the
            // exception unwinds out of the in-flight splat-transform writer (the
            // library's logger emits these synchronously from inside its work
            // loops and does not catch renderer exceptions). Never throw on
            // scope/bar *end* events, which also fire during unwind cleanup.
            if (shouldCancel?.() && (event.kind === 'scopeStart' || event.kind === 'barStart' || event.kind === 'barTick')) {
                throw new Error('export cancelled');
            }
            switch (event.kind) {
                case 'scopeStart':
                    if (getPrefix && event.index !== undefined && event.total !== undefined) {
                        counters.push({ depth: event.depth, index: event.index, total: event.total });
                    }
                    if (event.depth === 0) {
                        events?.fire('progressStart', header);
                    } else if (getPrefix) {
                        events?.fire('progressUpdate', { text: stepText(event.name), progress: 0 });
                    } else {
                        events?.fire('progressUpdate', {
                            text: event.index !== undefined && event.total !== undefined ?
                                `Step ${event.index} of ${event.total}: ${event.name}` :
                                event.name,
                            progress: 0
                        });
                    }
                    break;
                case 'scopeEnd':
                    while (counters.length > 0 && counters[counters.length - 1].depth >= event.depth) {
                        counters.pop();
                    }
                    if (event.depth === 0) {
                        events?.fire('progressEnd');
                    }
                    break;
                case 'barStart':
                    events?.fire('progressUpdate', { text: stepText(event.name), progress: 0 });
                    break;
                case 'barTick':
                    events?.fire('progressUpdate', {
                        progress: event.total > 0 ? 100 * event.current / event.total : 0
                    });
                    break;
                case 'barEnd':
                    events?.fire('progressUpdate', { progress: 100 });
                    break;
                case 'message':
                    // When a host (e.g. the export server) supplies onLog, route all
                    // messages to it so it can reformat/suppress them; otherwise log
                    // to the console as before.
                    if (onLog) onLog(event.level, event.text);
                    else if (event.level === 'error') console.error(event.text);
                    else if (event.level === 'warn') console.warn(event.text);
                    else if (event.level === 'info') console.info(event.text);
                    else if (event.level === 'debug') console.debug(event.text);
                    break;
                case 'output':
                    if (onLog) onLog('output', event.text);
                    else console.log(event.text);
                    break;
            }
        }
    };
};

// Streaming LOD export tuning. LOD 0 is the full-resolution, fully-edited
// scene. Each subsequent level halves the PREVIOUS level (a true LOD chain:
// LOD1 = 50% of LOD0, LOD2 = 50% of LOD1, ...). The chain continues until a
// level first falls below MIN_LOD_SPLATS - that sub-floor level is built and
// kept as the terminal (coarsest) level, so the lowest LOD lands around the
// floor. There is no hard cap on the number of levels.
const LOD_DECIMATION_FACTOR = 2;
const MIN_LOD_SPLATS = 1024 * 1024;

// Build a single DataTable carrying a per-gaussian `lod` column (0 = finest),
// suitable for writeLod. Decimation chains off the untagged previous level, so
// the synthetic `lod` column is only added after all decimation completes (the
// merge/simplify math must never see it). Consumes lod0: a `lod` column is
// added to it in place (cloning the full-resolution table here would needlessly
// duplicate the largest dataset), so callers must not reuse the passed table
// after this call.
const buildStreamingLodTable = async (
    lod0: DataTable,
    createDevice: DeviceCreator,
    onPhase?: (label: string) => void
): Promise<DataTable> => {
    // Count the coarser levels we'll generate up front so the phase label can
    // show an accurate "level N of M" (M = number of decimated levels). Mirror
    // the build loop's stop condition: keep halving and count each level until
    // one first drops below the floor (that sub-floor level is the last kept).
    let levelCount = 0;
    for (let t = lod0.numRows; ;) {
        t = Math.floor(t / LOD_DECIMATION_FACTOR);
        if (t < 1) {
            break;
        }
        levelCount++;
        if (t < MIN_LOD_SPLATS) {
            break;
        }
    }

    // Chain decimation off the previous (untagged) level. levels[0] is lod0.
    const levels: DataTable[] = [lod0];
    let prev = lod0;
    let level = 1;
    for (let target = lod0.numRows; ;) {
        target = Math.floor(target / LOD_DECIMATION_FACTOR);
        if (target < 1) {
            break;
        }
        onPhase?.(`Building detail level ${level} of ${levelCount}`);
        const simplified = await simplifyGaussians(prev, target, createDevice);
        levels.push(simplified);
        prev = simplified;
        if (target < MIN_LOD_SPLATS) {
            break;  // current level dropped below the floor: terminal level
        }
        level++;
    }

    // Tag every level with its `lod` index (0 = lod0) only now that all
    // decimation is done, so simplifyGaussians never chains off a table
    // carrying the synthetic `lod` column.
    for (let i = 0; i < levels.length; ++i) {
        levels[i].addColumn(new Column('lod', new Float32Array(levels[i].numRows).fill(i)));
    }

    // All levels descend from lod0's Transform.PLY (clone preserves it), so
    // combine concatenates rows without any coordinate-space conversion.
    return combine(levels);
};

// Produce a streaming viewer ZIP: a viewer shell (from unbundled writeHtml)
// repointed at lod-meta.json, plus the writeLod streaming bundle.
// Module-private: only called by writeViewerCore.
//
// viewerSettingsJson is typed `any` here to avoid a circular import with
// splat-serialize.ts (which owns the ExperienceSettings type). The browser
// wrapper in splat-serialize.ts retains the strong ExperienceSettings type.
const writeStreamingViewerCore = async (
    dataTable: DataTable,
    viewerSettingsJson: any,
    createDevice: DeviceCreator,
    fs: FileSystem,
    events?: Events,
    onLog?: (level: string, text: string) => void,
    shouldCancel?: () => boolean
): Promise<void> => {
    // Phase label prefixed onto splat-transform's low-level progress steps so
    // the repeated decimation and chunk-compression passes read clearly.
    // `counted` enables the splat-transform per-unit counter (chunk number)
    // only during chunk packaging; decimation carries its level in the label.
    let phase = '';
    let counted = false;
    splatTransformLogger.setRenderer(createProgressRenderer('Exporting streaming viewer', events, () => phase, () => counted, onLog, shouldCancel));

    const memFs = new MemoryFileSystem();

    // A 1-row placeholder keeps writeHtml's throwaway content SOG cheap to
    // produce (we only want its index.html/css/js/settings.json shell).
    phase = 'Preparing viewer';
    const placeholder = dataTable.clone({ rows: [0] });
    await writeHtml({
        filename: 'index.html',
        dataTable: placeholder,
        viewerSettingsJson,
        bundle: false,
        iterations: 10,
        createDevice
    }, memFs);

    // Streaming bundle: lod-meta.json + per-LOD SOG chunk folders. Decimation's
    // per-pass count is an estimate, so the level number lives in the label and
    // the per-step counter stays off here.
    const lodTable = await buildStreamingLodTable(dataTable, createDevice, (label) => {
        phase = label;
    });

    // Chunk packaging emits one accurate {index,total} per chunk - surface it.
    phase = 'Packaging streaming chunks';
    counted = true;
    await writeLod({
        // Absolute root so splat-transform's pathe `resolve(outputDir, ...)` for
        // each per-LOD chunk short-circuits on the absolute base instead of
        // prepending the process CWD. On Node a relative 'lod-meta.json' would
        // resolve chunk paths against process.cwd() (e.g. C:/.../server/0_0/...),
        // leaking the server's working directory into the ZIP entry names; the
        // leading '/' yields the same '/'-rooted keys the browser already
        // produces, which are normalised to relative entries below.
        filename: '/lod-meta.json',
        dataTable: lodTable,
        envDataTable: null,
        iterations: 10,
        createDevice,
        chunkCount: 512,   // ~gaussians per chunk, in thousands (splat-transform default)
        chunkExtent: 16    // ~chunk size in world units / metres (splat-transform default)
    }, memFs);

    // Drop the throwaway content SOG and repoint the viewer at the LOD bundle.
    // Unbundled writeHtml hardcodes the content fetch to the (now discarded) SOG
    // (`fetch("index.sog")`) and leaves the default contentUrl pointing at it.
    // Restore the fetch to `fetch(contentUrl)` and set the default contentUrl to
    // the LOD bundle. This keeps the default load working (contentUrl defaults to
    // ./lod-meta.json, whose basename selects the octree streaming parser) while
    // still honouring a `?content=` override: the override drives both the fetch
    // and the parser, so a different content file can actually be loaded.
    memFs.results.delete('index.sog');
    const rawHtml = memFs.results.get('index.html');
    if (!rawHtml) {
        throw new Error('Streaming export failed: writeHtml did not produce index.html');
    }
    const html = new TextDecoder().decode(rawHtml);
    const repointedFetch = html.replace('fetch("index.sog")', 'fetch(contentUrl)');
    if (repointedFetch === html) {
        throw new Error('Streaming export failed: could not repoint viewer content fetch to contentUrl (writeHtml output format changed)');
    }
    const repointed = repointedFetch.replace('./scene.sog', './lod-meta.json');
    if (repointed === repointedFetch) {
        throw new Error('Streaming export failed: could not repoint default content URL to lod-meta.json (writeHtml output format changed)');
    }
    const withLinks = injectAnnotationLinks(repointed, viewerSettingsJson);
    memFs.results.set('index.html', new TextEncoder().encode(withLinks));

    // ZIP every emitted file. Keys are normalised to relative paths so the
    // viewer's relative chunk references resolve from the archive root
    // regardless of how writeLod composed its output paths.
    const zipWriter = await fs.createWriter('output.zip');
    const zipFs = new ZipFileSystem(zipWriter);
    try {
        for (const [filename, data] of memFs.results.entries()) {
            const entry = filename.replace(/^\/+/, '');
            events?.fire('exportFile', { name: entry, bytes: data.length });
            const writer = await zipFs.createWriter(entry);
            await writer.write(data);
            await writer.close();
        }
    } finally {
        await zipFs.close();
    }
};

const writeSogCore = async (dataTable: DataTable, iterations: number, createDevice: DeviceCreator, fs: FileSystem, events?: Events, onLog?: (level: string, text: string) => void, shouldCancel?: () => boolean): Promise<void> => {
    splatTransformLogger.setRenderer(createProgressRenderer('Exporting SOG', events, undefined, undefined, onLog, shouldCancel));
    try {
        await writeSog({ filename: 'output.sog', dataTable, bundle: true, iterations, createDevice }, fs);
    } catch (err) {
        splatTransformLogger.unwindAll(true);
        throw err;
    }
};

const writeViewerCore = async (
    dataTable: DataTable,
    viewerSettingsJson: any,
    viewerType: 'html' | 'package' | 'streaming',
    createDevice: DeviceCreator,
    fs: FileSystem,
    events?: Events,
    onLog?: (level: string, text: string) => void,
    shouldCancel?: () => boolean
): Promise<void> => {
    splatTransformLogger.setRenderer(createProgressRenderer('Exporting HTML', events, undefined, undefined, onLog, shouldCancel));
    try {
        if (viewerType === 'html') {
            const memFs = new MemoryFileSystem();
            await writeHtml({ filename: 'output.html', dataTable, viewerSettingsJson, bundle: true, iterations: 10, createDevice }, memFs);
            const raw = memFs.results.get('output.html');
            if (!raw) {
                throw new Error('HTML export failed: writeHtml did not produce output.html');
            }
            const injected = injectAnnotationLinks(new TextDecoder().decode(raw), viewerSettingsJson);
            const writer = await fs.createWriter('output.html');
            await writer.write(new TextEncoder().encode(injected));
            await writer.close();
        } else if (viewerType === 'streaming') {
            await writeStreamingViewerCore(dataTable, viewerSettingsJson, createDevice, fs, events, onLog, shouldCancel);
        } else {
            const memFs = new MemoryFileSystem();
            await writeHtml({ filename: 'index.html', dataTable, viewerSettingsJson, bundle: false, iterations: 10, createDevice }, memFs);
            const rawIndex = memFs.results.get('index.html');
            if (!rawIndex) {
                throw new Error('Package export failed: writeHtml did not produce index.html');
            }
            const injected = injectAnnotationLinks(new TextDecoder().decode(rawIndex), viewerSettingsJson);
            memFs.results.set('index.html', new TextEncoder().encode(injected));
            const zipWriter = await fs.createWriter('output.zip');
            const zipFs = new ZipFileSystem(zipWriter);
            try {
                for (const [filename, data] of memFs.results.entries()) {
                    const entry = filename.replace(/^\/+/, '');
                    events?.fire('exportFile', { name: entry, bytes: data.length });
                    const w = await zipFs.createWriter(entry);
                    await w.write(data);
                    await w.close();
                }
            } finally {
                await zipFs.close();
            }
        }
    } catch (err) {
        splatTransformLogger.unwindAll(true);
        throw err;
    }
};

export { createProgressRenderer, buildStreamingLodTable, writeSogCore, writeViewerCore };
