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
// scene. Each subsequent level decimates the FULL scene (not the previous
// level) down to a quarter of the running target, so every level is an
// independent representation of the whole scene at lower density. Levels stop
// once the next would fall below MIN_LOD_SPLATS or once MAX_LOD_LEVELS exist.
const MAX_LOD_LEVELS = 4;
const LOD_DECIMATION_FACTOR = 4;
const MIN_LOD_SPLATS = 64 * 1024;

// Build a single DataTable carrying a per-gaussian `lod` column (0 = finest),
// suitable for writeLod. Decimation runs against the untagged lod0 so the
// merge math never sees the synthetic `lod` column; lod0 is tagged last.
// Consumes lod0: a `lod` column is added to it in place (cloning the
// full-resolution table here would needlessly duplicate the largest dataset),
// so callers must not reuse the passed table after this call.
const buildStreamingLodTable = async (
    lod0: DataTable,
    createDevice: DeviceCreator,
    onPhase?: (label: string) => void
): Promise<DataTable> => {
    const levels: DataTable[] = [];

    // Count the coarser levels we'll generate up front so the phase label can
    // show an accurate "level N of M" (M = number of decimated levels).
    let levelCount = 0;
    for (let level = 1, t = lod0.numRows; level < MAX_LOD_LEVELS; ++level) {
        t = Math.floor(t / LOD_DECIMATION_FACTOR);
        if (t < MIN_LOD_SPLATS) {
            break;
        }
        levelCount++;
    }

    let target = lod0.numRows;
    for (let level = 1; level < MAX_LOD_LEVELS; ++level) {
        target = Math.floor(target / LOD_DECIMATION_FACTOR);
        if (target < MIN_LOD_SPLATS) {
            break;
        }
        onPhase?.(`Building detail level ${level} of ${levelCount}`);
        const simplified = await simplifyGaussians(lod0, target, createDevice);
        simplified.addColumn(new Column('lod', new Float32Array(simplified.numRows).fill(level)));
        levels.push(simplified);
    }

    lod0.addColumn(new Column('lod', new Float32Array(lod0.numRows).fill(0)));
    levels.unshift(lod0);

    // All levels share lod0's Transform.PLY (clone preserves it), so combine
    // concatenates rows without any coordinate-space conversion.
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
    memFs.results.set('index.html', new TextEncoder().encode(repointed));

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
            await writeHtml({ filename: 'output.html', dataTable, viewerSettingsJson, bundle: true, iterations: 10, createDevice }, fs);
        } else if (viewerType === 'streaming') {
            await writeStreamingViewerCore(dataTable, viewerSettingsJson, createDevice, fs, events, onLog, shouldCancel);
        } else {
            const memFs = new MemoryFileSystem();
            await writeHtml({ filename: 'index.html', dataTable, viewerSettingsJson, bundle: false, iterations: 10, createDevice }, memFs);
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
