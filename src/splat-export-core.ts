import {
    bakeTransform,
    DataTable,
    dataTableToChunkSource,
    logger as splatTransformLogger,
    MemoryFileSystem,
    processDataTable,
    stackLods,
    Transform,
    writeHtml,
    writeLodSource,
    writeSog,
    writeVoxel,
    ZipFileSystem,
    type ChunkSource,
    type DeviceCreator,
    type FileSystem,
    type LogEvent,
    type Renderer
} from '@playcanvas/splat-transform';

import { collisionSeedFromSettings, collisionVoxelOptions, seedToPlySpace, subsetRowsWithinRadius, voxelResolutionLadder, type CollisionEnvironment } from './collision-voxel-options';
import { Events } from './events';
import { buildAnnotationLinksInjection } from './viewer-companion/annotation-links';
import { buildDeviceFallbackInjection } from './viewer-companion/device-fallback';
import { injectFaviconLink } from './viewer-companion/favicon';
import { buildOffLimitsZonesInjection } from './viewer-companion/off-limits-zones';
import { buildPortalsInjection } from './viewer-companion/portals';
import { injectPoster } from './viewer-companion/poster';
import { patchViewerEngine, VIEWER_ENGINE_PATCH_COUNT } from './viewer-engine-patch';

// Apply the engine patches (#8998 loader stall + #9011 unload race, see
// viewer-engine-patch.ts) to the viewer bundle in memFs: 'index.js' for
// unbundled exports. Warns when a pattern is missing (bundled engine changed
// shape) -- the injected portal companion's ready-gate watchdog then remains
// the runtime fallback.
const patchEngineLoaderInMemFs = (memFs: { results: Map<string, Uint8Array> }): void => {
    const raw = memFs.results.get('index.js');
    if (!raw) {
        return;
    }
    const { source, patched } = patchViewerEngine(new TextDecoder().decode(raw));
    if (patched < VIEWER_ENGINE_PATCH_COUNT) {
        console.warn(`Viewer engine patch: ${patched}/${VIEWER_ENGINE_PATCH_COUNT} patterns matched (bundled engine changed?)`);
    }
    if (patched > 0) {
        memFs.results.set('index.js', new TextEncoder().encode(source));
    }
};

// Environment-agnostic base64 (no Buffer/btoa: shared between browser and the
// Node export server via dist-shared). Used to inline the poster into the
// single-file HTML export.
const bytesToBase64 = (bytes: Uint8Array): string => {
    const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i];
        const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
        out += ALPHA[b0 >> 2] + ALPHA[((b0 & 3) << 4) | (b1 >> 4)];
        out += i + 1 < bytes.length ? ALPHA[((b1 & 15) << 2) | (b2 >> 6)] : '=';
        out += i + 2 < bytes.length ? ALPHA[b2 & 63] : '=';
    }
    return out;
};

// Poster for the exported viewer (see viewer-companion/poster.ts): a real
// export-time screenshot when the browser provided one, else the solid
// background-color cover. memFs given -> emit poster.jpg next to the viewer;
// memFs null (single-file HTML) -> inline as a data URI.
const applyPoster = (
    html: string,
    viewerSettingsJson: any,
    posterBytes: Uint8Array | undefined,
    memFs: { results: Map<string, Uint8Array> } | null
): string => {
    if (!posterBytes) {
        return injectPoster(html, viewerSettingsJson, null);
    }
    if (memFs) {
        memFs.results.set('poster.jpg', posterBytes);
        return injectPoster(html, viewerSettingsJson, './poster.jpg');
    }
    return injectPoster(html, viewerSettingsJson, `data:image/jpeg;base64,${bytesToBase64(posterBytes)}`);
};

// Optional favicon for ZIP exports: the export server fetched the bytes from
// its VIEWER_FAVICON_URL and handed them down (the browser never does, so local
// exports carry no icon). Emit the file beside the viewer and point the injected
// <head> link at it. Mirrors applyPoster's memFs handling — every memFs entry is
// zipped by the callers below.
type Favicon = { filename: string; mime: string; data: Uint8Array };

const applyFavicon = (
    html: string,
    favicon: Favicon | undefined,
    memFs: { results: Map<string, Uint8Array> }
): string => {
    if (!favicon) {
        return html;
    }
    memFs.results.set(favicon.filename, favicon.data);
    return injectFaviconLink(html, `./${favicon.filename}`, favicon.mime);
};

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

// Inject the WebGPU->WebGL2 crash-fallback companion into an HTML string
// before </body>. ALWAYS injected (every export benefits: field-observed
// Adreno WebGPU device loss kills plain single-scene viewers too). Publishes
// the viewer handle itself via the same bootstrap soft-replace as the zones
// injector, because on a plain export no other companion runs to publish it
// (a duplicate assignment when both run is harmless).
const injectDeviceFallback = (html: string): string => {
    const injection = buildDeviceFallbackInjection();
    const bootstrap = 'const viewer = await main(canvas, settingsJson, config);';
    const withHandle = html.includes(bootstrap) ?
        html.replace(bootstrap, `${bootstrap} window.__supersplatViewer = viewer;`) :
        html;
    if (withHandle.includes('</body>')) {
        return withHandle.replace('</body>', `${injection}</body>`);
    }
    return withHandle + injection;
};

// Inject the off-limits-zones companion into an HTML string before </body>.
// No-op (returns the input) when there are no zones.
const injectOffLimitsZones = (html: string, viewerSettingsJson: any): string => {
    const injection = buildOffLimitsZonesInjection(
        viewerSettingsJson?.offLimitsZones ?? [],
        viewerSettingsJson?.offLimitsMessage ?? ''
    );
    if (!injection) {
        return html;
    }
    // The exported viewer keeps its PlayCanvas app + camera in a private module
    // closure (no `pc`/app global), so the companion cannot reach the camera on
    // its own. Publish the viewer instance from its own bootstrap line; the
    // companion then clamps the camera via viewer.cameraManager. Soft replace:
    // if this anchor ever changes upstream the companion just no-ops (blocking
    // disabled) rather than corrupting the export.
    const bootstrap = 'const viewer = await main(canvas, settingsJson, config);';
    const withHandle = html.includes(bootstrap) ?
        html.replace(bootstrap, `${bootstrap} window.__supersplatViewer = viewer;`) :
        html;
    if (withHandle.includes('</body>')) {
        return withHandle.replace('</body>', `${injection}</body>`);
    }
    return withHandle + injection;
};

// Inject the portals companion into an HTML string before </body>.
// No-op (returns the input) when there are no portals. Idempotent with
// injectOffLimitsZones: if the viewer handle has already been published this
// function skips the bootstrap replacement to avoid a double-publish.
const injectPortals = (html: string, viewerSettingsJson: any): string => {
    const injection = buildPortalsInjection(viewerSettingsJson);
    if (!injection) {
        return html;
    }
    // Ensure the viewer handle is published (idempotent: only inject if not
    // already present, since injectOffLimitsZones may have added it first).
    const bootstrap = 'const viewer = await main(canvas, settingsJson, config);';
    const withHandle = (html.includes(bootstrap) && !html.includes('window.__supersplatViewer = viewer;')) ?
        html.replace(bootstrap, `${bootstrap} window.__supersplatViewer = viewer;`) :
        html;
    return withHandle.includes('</body>') ? withHandle.replace('</body>', `${injection}</body>`) : withHandle + injection;
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
// A localizable progress phase. `en` is the English label used by the server/SSE +
// log path (which has no locale); `key` + `params` let the browser (editor.ts)
// localize the same label. Produced by the PHASES factory below.
type PhaseInfo = { key: string; params?: Record<string, string | number>; en: string };

// The composed prefix surfaced to the progress renderer. `en` is the full English
// prefix (including any "Scene i/N" part) preserved verbatim for the server/log path;
// the browser rebuilds a localized version from `scene` + `key`/`params`. `key` is
// omitted for scene-only prefixes (the package path, which has no phase label).
type ProgressPrefix = { en: string; key?: string; params?: Record<string, string | number>; scene?: { index: number; total: number } };

// Phase-label descriptors. English lives here (single source for the server/log
// path, which never loads a locale file); the matching i18n keys live in the locale
// JSONs for the browser. Keep the two in sync when adding a phase.
const PHASES = {
    preparingViewer: (): PhaseInfo => ({ key: 'export.progress.preparing-viewer', en: 'Preparing viewer' }),
    generatingCollision: (): PhaseInfo => ({ key: 'export.progress.generating-collision', en: 'Generating collision data' }),
    buildingLod: (level: number, levelCount: number): PhaseInfo => ({ key: 'export.progress.building-lod', params: { level, levelCount }, en: `Building detail level ${level} of ${levelCount}` }),
    packagingChunks: (): PhaseInfo => ({ key: 'export.progress.packaging-chunks', en: 'Packaging streaming chunks' })
};

// Compose a ProgressPrefix from a phase + optional scene, reproducing the exact
// English string the server/log path emitted before (scene prefix + ": " + label).
const withScene = (info: PhaseInfo, scene?: { index: number; total: number }): ProgressPrefix => ({
    en: scene ? `Scene ${scene.index}/${scene.total}: ${info.en}` : info.en,
    key: info.key,
    params: info.params,
    scene
});

// Report a scene's DataTable extraction directly on the event bus. Extraction is
// our own JS loop and emits no splat-transform logger events, so the PHASES
// prefix mechanism (which only decorates library events) cannot surface it.
// `text` stays English for the server/SSE/log path; `loc.segments` lets the
// browser localize. No step name: the handler appends none when absent.
//
// The progress dialog is only visible between progressStart/progressEnd, which
// createProgressRenderer fires on the library's depth-0 scopes. Extraction runs
// BETWEEN writers, when the dialog is hidden and the next writer's progressStart
// would wipe our text -- so re-open it ourselves first. Re-firing progressStart is
// what the library's own depth-0 scopes do on every writer, so this is not a new
// pattern; the server path (file-handler.ts) keeps one dialog open regardless.
const fireExtracting = (events: Events | undefined, index: number, total: number, header: string, headerKey: string): void => {
    events?.fire('progressStart', header, undefined, headerKey);
    events?.fire('progressUpdate', {
        text: `Scene ${index}/${total}: Extracting scene data`,
        progress: 0,
        loc: {
            segments: [
                { key: 'export.progress.scene', params: { index, total } },
                { key: 'export.progress.extracting-scene' }
            ]
        }
    });
};

// Maps @playcanvas/splat-transform's own English step names (the library's
// logger group / progress-bar labels, appended after our phase prefix) to i18n
// keys so the browser can localize them. Best-effort: an unmapped name (a library
// rename, a step from an export path we haven't catalogued, or a dynamic id like a
// "0_0" chunk name) falls back to its English text. Keep in sync with the
// export.step.* locale keys. GPU / non-GPU label variants share one key.
const LIBRARY_STEP_KEYS: Record<string, string> = {
    'Allocating output table': 'export.step.allocating-output-table',
    'BFS': 'export.step.bfs',
    'Build voxels': 'export.step.build-voxels',
    'Building BVH': 'export.step.building-bvh',
    'Building grid': 'export.step.building-grid',
    'Building per-splat cache': 'export.step.building-per-splat-cache',
    'Building tree': 'export.step.building-tree',
    'Carve': 'export.step.carve',
    'chunking': 'export.step.chunking',
    'Collision mesh': 'export.step.collision-mesh',
    'Column walk': 'export.step.column-walk',
    'Combining': 'export.step.combining',
    'Computing edge costs': 'export.step.computing-edge-costs',
    'Computing edge costs (GPU)': 'export.step.computing-edge-costs',
    'computing merge priorities': 'export.step.computing-merge-priorities',
    'Copying kept splats': 'export.step.copying-kept-splats',
    'Cropping': 'export.step.cropping',
    'Cropping grid': 'export.step.cropping-grid',
    'Cull': 'export.step.cull',
    'Decimate generation': 'export.step.decimate-generation',
    'decoding': 'export.step.decoding',
    'Dilating': 'export.step.dilating',
    'Encoding': 'export.step.encoding',
    'Extracting': 'export.step.extracting',
    'Extracting voxel faces': 'export.step.extracting-voxel-faces',
    'Fill exterior': 'export.step.fill-exterior',
    'Fill floor': 'export.step.fill-floor',
    'Filtering': 'export.step.filtering',
    'Finding nearest neighbors': 'export.step.finding-nearest-neighbors',
    'Finding nearest neighbors (GPU)': 'export.step.finding-nearest-neighbors',
    'k-means': 'export.step.k-means',
    'Loading grid': 'export.step.loading-grid',
    'merging': 'export.step.merging',
    'Merging coplanar faces': 'export.step.merging-coplanar-faces',
    'Merging splats': 'export.step.merging-splats',
    'Partitioning': 'export.step.partitioning',
    'rasterizing': 'export.step.rasterizing',
    'reading positions': 'export.step.reading-positions',
    'Render': 'export.step.render',
    'Scanning bounds': 'export.step.scanning-bounds',
    'Selecting merges': 'export.step.selecting-merges',
    'Selecting pairs': 'export.step.selecting-pairs',
    'Voxelizing': 'export.step.voxelizing',
    'Writing': 'export.step.writing'
};

// Bundle a library step name with its i18n key (if known) for the progress `loc`.
// `name` stays English for the server/log + fallback; `nameKey` lets the browser
// localize it.
const nameLoc = (name: string): { name: string; nameKey?: string } => {
    const nameKey = LIBRARY_STEP_KEYS[name];
    return nameKey ? { name, nameKey } : { name };
};

// headerKey (optional) is an i18n key for `header`. It is forwarded verbatim on
// the progressStart event so the browser can localize the dialog title; `header`
// itself stays English for the server/SSE + log path (which has no locale). Likewise
// each progressUpdate carries a structured `loc` (scene + phase key + counter + the
// splat-transform step name) so the browser can localize the sub-line while `text`
// stays English. Keeping both leaves output bytes and the parity guarantee untouched
// (progress is UI-only).
const createProgressRenderer = (header: string, events?: Events, getPrefix?: () => ProgressPrefix | undefined, countSteps?: () => boolean, onLog?: (level: string, text: string) => void, shouldCancel?: () => boolean, headerKey?: string): Renderer => {
    // Active scopes carrying a counter, ordered outermost-first. The outermost
    // is the meaningful unit (e.g. the chunk number during packaging); inner SOG
    // sub-steps are ignored so the count stays stable across a unit. The counter
    // is only surfaced when countSteps() is true, because splat-transform's
    // decimation-iteration total is an estimate that can be exceeded - that
    // phase carries its level number in the prefix instead.
    const counters: { depth: number; index: number; total: number }[] = [];

    // Build the progressUpdate payload for a splat-transform step. `text` is the
    // English line (server/SSE/log + browser fallback); `loc` carries the structured
    // parts so the browser can localize (see the progressUpdate handler in editor.ts).
    // `name` is splat-transform's own step label and stays English in both paths.
    const stepUpdate = (name: string): { text: string; progress: number; loc?: any } => {
        const prefix = getPrefix?.();
        const counter = countSteps?.() ? counters[0] : undefined;
        const counterStr = counter ? ` (${counter.index}/${counter.total})` : '';
        if (!prefix) {
            // No phase prefix (e.g. the SOG path): the sub-line is just the library
            // step name, still localizable via nameLoc.
            return { text: name, progress: 0, loc: nameLoc(name) };
        }
        // Ordered translatable segments, joined by ": " on both paths. Scene prefix
        // (if any) first, then the phase label (absent for scene-only prefixes).
        const segments: { key: string; params?: Record<string, string | number> }[] = [];
        if (prefix.scene) {
            segments.push({ key: 'export.progress.scene', params: { index: prefix.scene.index, total: prefix.scene.total } });
        }
        if (prefix.key) {
            segments.push({ key: prefix.key, params: prefix.params });
        }
        return {
            text: `${prefix.en}${counterStr}: ${name}`,
            progress: 0,
            loc: { segments, counter: counter ? { index: counter.index, total: counter.total } : undefined, ...nameLoc(name) }
        };
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
                        events?.fire('progressStart', header, undefined, headerKey);
                    } else if (getPrefix) {
                        events?.fire('progressUpdate', stepUpdate(event.name));
                    } else if (event.index !== undefined && event.total !== undefined) {
                        // Generic splat-transform scope with a step counter but no phase
                        // prefix (e.g. the SOG path): "Step N of M: <library step>".
                        events?.fire('progressUpdate', {
                            text: `Step ${event.index} of ${event.total}: ${event.name}`,
                            progress: 0,
                            loc: { segments: [{ key: 'export.progress.step', params: { index: event.index, total: event.total } }], ...nameLoc(event.name) }
                        });
                    } else {
                        events?.fire('progressUpdate', { text: event.name, progress: 0, loc: nameLoc(event.name) });
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
                    events?.fire('progressUpdate', stepUpdate(event.name));
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

// Build a structural multi-LOD ChunkSource (LOD i = detail level i, 0 = finest),
// suitable for writeLodSource. Decimation chains off the previous level; each
// level becomes one single-LOD ChunkSource and they are stacked. lod0 is read
// (not mutated) into its own single-LOD source, so the passed table is left
// intact.
const buildStreamingLodSource = async (
    lod0: DataTable,
    createDevice: DeviceCreator,
    onPhase?: (info: PhaseInfo) => void
): Promise<{ mainSource: ChunkSource; levelCounts: number[] }> => {
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
        onPhase?.(PHASES.buildingLod(level, levelCount));
        const simplified = await processDataTable(prev, [{ kind: 'decimate', count: target, percent: null }], { createDevice });
        levels.push(simplified);
        prev = simplified;
        if (target < MIN_LOD_SPLATS) {
            break;  // current level dropped below the floor: terminal level
        }
        level++;
    }

    const levelCounts = levels.map(l => l.numRows);
    // v3 writeLodSource wants a STRUCTURAL multi-LOD source (LOD i = detail level i),
    // not a `lod`-tagged flat table. Each decimated level is one single-LOD source;
    // stack them. lod0 is tagged Transform.PLY, but v3's decimate bakes each
    // decimated level back to Transform.IDENTITY (its convertToSpace(...,IDENTITY)),
    // so the levels no longer share a space. Bake every level to Transform.PLY
    // before stacking: a no-op for lod0, and the IDENTITY->PLY delta for the
    // decimated levels, so all levels share Transform.PLY and stackLods' match
    // assertion holds. writeLodSource then bakes PLY (fast-path no-op).
    const mainSource = stackLods(levels.map(l => bakeTransform(dataTableToChunkSource(l), Transform.PLY)));
    return { mainSource, levelCounts };
};

// Coarsest voxel size the auto-fit ladder will try before giving up.
const COLLISION_VOXEL_FLOOR = 0.4;

// Voxelize a sphere of `radius` around the start seed into memFs as
// index.voxel.json + index.voxel.bin. Auto-coarsens the voxel size (ladder up to
// COLLISION_VOXEL_FLOOR) to work around splat-transform's 2^24 solid-block Set
// limit in filterAndFillBlocks. Must run before the streaming LOD build consumes
// the table. writeVoxel does not mutate its input; failures throw before any
// output file is written and after the GPU pass is cleaned up, so retrying is
// safe. Throws a clear, actionable error if even the floor resolution fails.
const writeCollisionVoxel = async (
    memFs: MemoryFileSystem,
    dataTable: DataTable,
    viewerSettingsJson: any,
    createDevice: DeviceCreator,
    collision: { environment: CollisionEnvironment; radius?: number; voxelSize?: number }
): Promise<void> => {
    const radius = collision.radius ?? 50;
    const baseVoxelSize = collision.voxelSize ?? 0.05;
    const seed = collisionSeedFromSettings(viewerSettingsJson);
    const seedPly = seedToPlySpace(seed);

    const x = dataTable.getColumnByName('x')?.data as Float32Array;
    const y = dataTable.getColumnByName('y')?.data as Float32Array;
    const z = dataTable.getColumnByName('z')?.data as Float32Array;
    if (!x || !y || !z) {
        throw new Error('Collision generation failed: data table is missing position columns');
    }

    const indices = subsetRowsWithinRadius(x, y, z, seedPly, radius);
    if (indices.length === 0) {
        throw new Error(`Collision generation failed - no splats within ${radius} m of the start position.`);
    }
    const subset = indices.length === dataTable.numRows ? dataTable : dataTable.clone({ rows: indices });

    const ladder = voxelResolutionLadder(baseVoxelSize, COLLISION_VOXEL_FLOOR);
    for (let i = 0; i < ladder.length; i++) {
        const voxelResolution = ladder[i];
        try {
            await writeVoxel({
                filename: 'index.voxel.json',
                dataTable: subset,
                voxelResolution,
                opacityCutoff: 0.1,
                createDevice,
                ...collisionVoxelOptions(collision.environment, seed)
            }, memFs);
            return;
        } catch (err) {
            if (i < ladder.length - 1) {
                console.warn(`Collision voxelization failed at ${voxelResolution} m voxels (${(err as Error)?.message ?? err}); retrying at ${ladder[i + 1]} m.`);
                continue;
            }
            // Final rung: log the exact underlying error for diagnosis, then
            // surface an actionable summary.
            console.error('Collision voxelization failed (underlying error):', err);
            if ((err as any)?.cause !== undefined) {
                console.error('  cause:', (err as any).cause);
            }
            throw new Error(`Collision generation failed - the region is still too large to voxelize at ${voxelResolution} m voxels. Reduce the collision radius or increase the voxel size. (${(err as Error)?.message ?? err})`);
        }
    }
};

// Write one extra portal scene's payload into memFs under `scenes/<index>/`.
// The collision voxel is only written when collisionUrl is non-null (i.e. the
// operator enabled collision and this scene has a collision URL). Voxel filenames
// are renamed from `index.voxel.*` to `scene.voxel.*` so they live alongside the
// scene bundle under the namespaced key. All produced entries are namespaced under
// `scenes/<index>/` in the caller's memFs.
const writePortalScene = async (
    memFs: MemoryFileSystem,
    index: number,
    scene: ExtraPortalScene,
    createDevice: DeviceCreator,
    radius: number,
    voxelSize: number,
    onPhase?: (info: PhaseInfo, counted: boolean) => void,
    onExtract?: () => void
): Promise<number[]> => {
    const base = `scenes/${index}`;
    const sub = new MemoryFileSystem();
    // Materialize this scene's table now and let it die with this call, so scene
    // i is collectable before scene i+1 loads. Peak = 1 table, not N.
    onExtract?.();
    // Yield a macrotask so the browser can actually paint the label above before
    // the loader's synchronous extraction (a tight per-gaussian loop) blocks the
    // main thread. Without this the label only appears once the freeze it
    // describes has already ended. Harmless on the server (Node) path.
    await new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
    const dataTable = await scene.loadDataTable();
    let counts: number[] = [dataTable.numRows];
    // Voxelize first, on the pristine full-resolution table, before the streaming
    // LOD build reads it. This mirrors the primary scene's collision→LOD order so
    // every scene's progress reads consistently. writeCollisionVoxel does not mutate
    // its input, so the subsequent LOD/SOG build still sees clean data.
    if (scene.collisionUrl) {
        onPhase?.(PHASES.generatingCollision(), false);
        // Synthesise a minimal settings object that places the seed at cameras[0].initial.position
        // so collisionSeedFromSettings picks it up for the per-scene voxel.
        const fakeSettings = { cameras: [{ initial: { position: scene.seed } }] };
        await writeCollisionVoxel(sub, dataTable, fakeSettings, createDevice, { environment: scene.environment, radius, voxelSize });
        // writeCollisionVoxel emits index.voxel.json / index.voxel.bin — rename to scene.voxel.*
        for (const name of ['index.voxel.json', 'index.voxel.bin']) {
            const data = sub.results.get(name);
            if (data) {
                sub.results.set(name.replace('index.', 'scene.'), data);
                sub.results.delete(name);
            }
        }
    }
    if (scene.streaming) {
        const { mainSource, levelCounts } = await buildStreamingLodSource(dataTable, createDevice, (info) => {
            onPhase?.(info, false);   // decimation passes carry their level in the label
        });
        counts = levelCounts;
        onPhase?.(PHASES.packagingChunks(), true);
        await writeLodSource({
            filename: '/lod-meta.json',
            mainSource,
            envSource: null,
            iterations: 10,
            createDevice,
            chunkCount: 512,
            chunkExtent: 16
        }, sub);
        // Release the stacked per-level sources so the decimated LOD chain is
        // collectable before the namespacing pass (the CLI closes here too).
        await mainSource.close();
    } else {
        await writeSog({ filename: 'scene.sog', dataTable, bundle: true, iterations: 10, createDevice, logging: 'silent' }, sub);
    }
    // Namespace every emitted key under scenes/<index>/
    for (const [name, data] of sub.results.entries()) {
        memFs.results.set(`${base}/${name.replace(/^\/+/, '')}`, data);
    }
    return counts;
};

// Repoint the viewer's default collisionUrl at the bundled voxel file so the
// exported viewer auto-loads collision without a ?voxel= query param. Guarded
// like the other index.html repoints: throw if the source string is missing
// (writeHtml output format changed).
const repointCollisionUrl = (memFs: MemoryFileSystem): void => {
    const rawHtml = memFs.results.get('index.html');
    if (!rawHtml) {
        throw new Error('Collision export failed: writeHtml did not produce index.html');
    }
    const html = new TextDecoder().decode(rawHtml);
    const search = 'url.searchParams.get(\'collision\') ?? url.searchParams.get(\'voxel\')';
    const repointed = html.replace(search, `${search} ?? './index.voxel.json'`);
    if (repointed === html) {
        throw new Error('Collision export failed: could not repoint viewer collisionUrl (writeHtml output format changed)');
    }
    memFs.results.set('index.html', new TextEncoder().encode(repointed));
};

// Produce a streaming viewer ZIP: a viewer shell (from unbundled writeHtml)
// repointed at lod-meta.json, plus the writeLodSource streaming bundle.
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
    shouldCancel?: () => boolean,
    collision?: { environment: CollisionEnvironment; radius: number; voxelSize: number },
    extraScenes?: ExtraPortalScene[],
    posterBytes?: Uint8Array,
    favicon?: Favicon
): Promise<void> => {
    // Phase label prefixed onto splat-transform's low-level progress steps so
    // the repeated decimation and chunk-compression passes read clearly.
    // `counted` enables the splat-transform per-unit counter (chunk number)
    // only during chunk packaging; decimation carries its level in the label.
    let phase: ProgressPrefix | undefined;
    let counted = false;
    // When a portal walkthrough adds extra scenes, prefix the primary's phases
    // with "Scene 1/N: " so its progress reads consistently with the extras
    // (which carry "Scene 2/N: …" etc.). No prefix for a single-scene export.
    const total = 1 + (extraScenes?.length ?? 0);
    const primaryScene = total > 1 ? { index: 1, total } : undefined;
    splatTransformLogger.setRenderer(createProgressRenderer('Exporting streaming viewer', events, () => phase, () => counted, onLog, shouldCancel, 'export.progress.exporting-streaming'));

    const memFs = new MemoryFileSystem();

    // A 1-row placeholder keeps writeHtml's throwaway content SOG cheap to
    // produce (we only want its index.html/css/js/settings.json shell).
    phase = withScene(PHASES.preparingViewer(), primaryScene);
    const placeholder = dataTable.clone({ rows: [0] });
    await writeHtml({
        filename: 'index.html',
        dataTable: placeholder,
        viewerSettingsJson,
        bundle: false,
        iterations: 10,
        createDevice
    }, memFs);

    // Voxelize the full-resolution table now, before buildStreamingLodSource
    // consumes/mutates it.
    if (collision) {
        phase = withScene(PHASES.generatingCollision(), primaryScene);
        await writeCollisionVoxel(memFs, dataTable, viewerSettingsJson, createDevice, collision);
    }

    // Streaming bundle: lod-meta.json + per-LOD SOG chunk folders. Decimation's
    // per-pass count is an estimate, so the level number lives in the label and
    // the per-step counter stays off here.
    const { mainSource, levelCounts: primaryLodCounts } = await buildStreamingLodSource(dataTable, createDevice, (info) => {
        phase = withScene(info, primaryScene);
    });

    // Chunk packaging emits one accurate {index,total} per chunk - surface it.
    phase = withScene(PHASES.packagingChunks(), primaryScene);
    counted = true;
    await writeLodSource({
        // Absolute root so splat-transform's pathe `resolve(outputDir, ...)` for
        // each per-LOD chunk short-circuits on the absolute base instead of
        // prepending the process CWD. On Node a relative 'lod-meta.json' would
        // resolve chunk paths against process.cwd() (e.g. C:/.../server/0_0/...),
        // leaking the server's working directory into the ZIP entry names; the
        // leading '/' yields the same '/'-rooted keys the browser already
        // produces, which are normalised to relative entries below.
        filename: '/lod-meta.json',
        mainSource,
        envSource: null,
        iterations: 10,
        createDevice,
        chunkCount: 512,   // ~gaussians per chunk, in thousands (splat-transform default)
        chunkExtent: 16    // ~chunk size in world units / metres (splat-transform default)
    }, memFs);
    await mainSource.close();

    // Write each extra portal scene's streaming bundle (lod-meta.json + chunk
    // folders) + per-scene voxel into the SAME memFs under scenes/N/, before the
    // HTML injection so the per-LOD counts are available for the payload. Mirrors
    // the package branch; uses the shared collision radius / voxel size (defaulting
    // when collision is off but a scene still carries a collision URL —
    // writePortalScene guards on it).
    const extraLodCounts: number[][] = [];
    if (extraScenes && extraScenes.length > 0) {
        const collRadius = collision?.radius ?? 50;
        const collVoxelSize = collision?.voxelSize ?? 0.05;
        // Hoisted out of the loop (no-loop-func); sceneRef is refreshed each
        // iteration before the awaited call, so the callback reads the right value.
        let sceneRef: { index: number; total: number } | undefined;
        const onSceneProgress = (info: PhaseInfo, c: boolean) => {
            phase = withScene(info, sceneRef);
            counted = c;
        };
        for (let i = 0; i < extraScenes.length; i++) {
            sceneRef = { index: i + 2, total: extraScenes.length + 1 };
            extraLodCounts.push(await writePortalScene(memFs, i + 1, extraScenes[i], createDevice, collRadius, collVoxelSize, onSceneProgress, () => fireExtracting(events, i + 2, total, 'Exporting streaming viewer', 'export.progress.exporting-streaming')));
        }
    }

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
    const settingsWithLods = { ...viewerSettingsJson, portalSceneLodCounts: [primaryLodCounts, ...extraLodCounts] };
    const withPoster = applyPoster(repointed, settingsWithLods, posterBytes, memFs);
    const withLinks = injectAnnotationLinks(withPoster, settingsWithLods);
    const withZones = injectOffLimitsZones(withLinks, settingsWithLods);
    const withPortals = injectPortals(withZones, settingsWithLods);
    memFs.results.set('index.html', new TextEncoder().encode(applyFavicon(injectDeviceFallback(withPortals), favicon, memFs)));
    patchEngineLoaderInMemFs(memFs);
    if (collision) {
        repointCollisionUrl(memFs);
    }

    // ZIP every emitted file. Keys are normalised to relative paths so the
    // viewer's relative chunk references resolve from the archive root
    // regardless of how writeLodSource composed its output paths.
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
    splatTransformLogger.setRenderer(createProgressRenderer('Exporting SOG', events, undefined, undefined, onLog, shouldCancel, 'export.progress.exporting-sog'));
    try {
        await writeSog({ filename: 'output.sog', dataTable, bundle: true, iterations, createDevice }, fs);
    } catch (err) {
        splatTransformLogger.unwindAll(true);
        throw err;
    }
};

// The scene's table is a thunk, not a value: portal exports hold one scene
// resident at a time. At SH degree 3 a table is ~236 B/gaussian, so eagerly
// materializing every scene cost ~N x the whole scene before a byte was written.
type ExtraPortalScene = {
    loadDataTable: () => Promise<DataTable>;
    streaming: boolean;
    collisionUrl: string | null;
    environment: 'indoor' | 'outdoor';
    seed: [number, number, number];
};

const writeViewerCore = async (
    dataTable: DataTable,
    viewerSettingsJson: any,
    viewerType: 'html' | 'package' | 'streaming',
    createDevice: DeviceCreator,
    fs: FileSystem,
    events?: Events,
    onLog?: (level: string, text: string) => void,
    shouldCancel?: () => boolean,
    collision?: { environment: CollisionEnvironment; radius: number; voxelSize: number },
    extraScenes?: ExtraPortalScene[],
    posterBytes?: Uint8Array,
    favicon?: Favicon
): Promise<void> => {
    // Scene-prefixed progress support: when extra portal scenes are present, we
    // label the primary write as "Scene 1/total" and each extra as "Scene N/total".
    const total = 1 + (extraScenes?.length ?? 0);
    const hasPortalScenes = (extraScenes?.length ?? 0) > 0;

    // Package/HTML path: the prefix is scene-only (no phase label). `en` preserves
    // the previous English string; `scene` lets the browser localize "Scene i/N".
    let scenePrefix: ProgressPrefix | undefined;
    const getScenePrefix = () => scenePrefix;

    splatTransformLogger.setRenderer(createProgressRenderer(
        'Exporting HTML',
        events,
        hasPortalScenes ? getScenePrefix : undefined,
        undefined,
        onLog,
        shouldCancel,
        'export.progress.exporting-html'
    ));
    try {
        if (viewerType === 'html') {
            // Interim guard: HTML export cannot carry extra portal scenes (the single-file
            // output has no place for scenes/N/ entries). Throw before any output is
            // produced so the export fails loudly rather than silently omitting scenes.
            // Future work: embed scene payloads as data-URIs or use a ZIP-wrapped HTML.
            if (hasPortalScenes) {
                throw new Error('Portal multi-scene export is only supported with the Package (ZIP) format. Disable streaming / choose Package format and re-export.');
            }
            const memFs = new MemoryFileSystem();
            await writeHtml({ filename: 'output.html', dataTable, viewerSettingsJson, bundle: true, iterations: 10, createDevice }, memFs);
            const raw = memFs.results.get('output.html');
            if (!raw) {
                throw new Error('HTML export failed: writeHtml did not produce output.html');
            }
            // Single-file output: the poster is inlined as a data URI (no memFs).
            const withPoster = applyPoster(new TextDecoder().decode(raw), viewerSettingsJson, posterBytes, null);
            const injected = injectDeviceFallback(injectPortals(injectOffLimitsZones(injectAnnotationLinks(withPoster, viewerSettingsJson), viewerSettingsJson), viewerSettingsJson));
            // Single-file export inlines the engine in the HTML: patch it there.
            const enginePatch = patchViewerEngine(injected);
            if (enginePatch.patched < VIEWER_ENGINE_PATCH_COUNT) {
                console.warn(`Viewer engine patch (html): ${enginePatch.patched}/${VIEWER_ENGINE_PATCH_COUNT} patterns matched (bundled engine changed?)`);
            }
            const writer = await fs.createWriter('output.html');
            await writer.write(new TextEncoder().encode(enginePatch.source));
            await writer.close();
        } else if (viewerType === 'streaming') {
            await writeStreamingViewerCore(dataTable, viewerSettingsJson, createDevice, fs, events, onLog, shouldCancel, collision, extraScenes, posterBytes, favicon);
        } else {
            // Package (ZIP) path: write primary scene, then extra portal scenes, then ZIP everything.
            const memFs = new MemoryFileSystem();
            if (hasPortalScenes) {
                scenePrefix = { en: `Scene 1/${total}`, scene: { index: 1, total } };
            }
            await writeHtml({ filename: 'index.html', dataTable, viewerSettingsJson, bundle: false, iterations: 10, createDevice }, memFs);
            if (collision) {
                await writeCollisionVoxel(memFs, dataTable, viewerSettingsJson, createDevice, collision);
            }
            const rawIndex = memFs.results.get('index.html');
            if (!rawIndex) {
                throw new Error('Package export failed: writeHtml did not produce index.html');
            }
            // Write extra portal scenes under scenes/N/ FIRST: their gaussian
            // counts are only known once each scene's table has been loaded, and
            // those counts are baked into index.html below. Scene writes touch
            // only scenes/<N>/ keys, so they cannot collide with index.html.
            const extraCounts: number[][] = [];
            if (hasPortalScenes) {
                const collRadius = collision?.radius ?? 50;
                const collVoxelSize = collision?.voxelSize ?? 0.05;
                for (let i = 0; i < extraScenes!.length; i++) {
                    const index = i + 1;
                    scenePrefix = { en: `Scene ${index + 1}/${total}`, scene: { index: index + 1, total } };
                    extraCounts.push(await writePortalScene(
                        memFs, index, extraScenes![i], createDevice, collRadius, collVoxelSize,
                        undefined, () => fireExtracting(events, index + 1, total, 'Exporting HTML', 'export.progress.exporting-html')
                    ));
                }
            }
            const sogSettings = hasPortalScenes ?
                { ...viewerSettingsJson, portalSceneLodCounts: [[dataTable.numRows], ...extraCounts] } :
                viewerSettingsJson;
            const withPoster = applyPoster(new TextDecoder().decode(rawIndex), sogSettings, posterBytes, memFs);
            const injected = injectDeviceFallback(injectPortals(injectOffLimitsZones(injectAnnotationLinks(withPoster, sogSettings), sogSettings), sogSettings));
            memFs.results.set('index.html', new TextEncoder().encode(applyFavicon(injected, favicon, memFs)));
            patchEngineLoaderInMemFs(memFs);
            if (collision) {
                repointCollisionUrl(memFs);
            }
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

export { createProgressRenderer, writeSogCore, writeViewerCore };
