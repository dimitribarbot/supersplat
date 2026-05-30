import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
    readFile,
    writeCompressedPly,
    MemoryFileSystem,
    MemoryReadFileSystem,
    Transform
} from '@playcanvas/splat-transform';
import type { ProgressEvent } from './progress.js';

export type ExportOptions = {
    fileType: 'ply' | 'compressedPly' | 'splat' | 'sog' | 'htmlViewer' | 'packageViewer';
    filename: string;
    serializeSettings?: { maxSHBands?: number };
    sogIterations?: number;
    viewerExportSettings?: { type: 'html' | 'zip'; streaming?: boolean; experienceSettings: any };
};

export type RunResult = {
    files: { name: string; data: Uint8Array }[];
};

type Sink = { emit: (e: ProgressEvent) => void };

export type RunExportArgs = {
    plyGz: Buffer;
    options: ExportOptions;
    sink: Sink;
    getDeviceCreator: () => (() => Promise<any>);
    // Polled cooperatively: when it returns true, the export aborts at the next
    // checkpoint / progress tick (see the shared core's shouldCancel handling).
    isCancelled?: () => boolean;
};

// Human-readable byte size for friendly server logs (spaced units, e.g. "6.0 MB").
const fmtSize = (n: number): string => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

// Read options matching the library's defaults for a plain (non-LOD) PLY read.
const READ_OPTS = {
    iterations: 10,
    lodSelect: [0],
    unbundled: false,
    lodChunkCount: 512,
    lodChunkExtent: 16
};

export const runExport = async ({ plyGz, options, sink, getDeviceCreator, isCancelled }: RunExportArgs): Promise<RunResult> => {
    const ensureLive = () => {
        if (isCancelled?.()) throw new Error('export cancelled');
    };
    ensureLive();
    const ply = Buffer.from(gunzipSync(plyGz));

    // Plain PLY is a pure passthrough: just the gunzipped upload bytes.
    if (options.fileType === 'ply') {
        return { files: [{ name: options.filename, data: new Uint8Array(ply) }] };
    }

    // splat export is performed in the browser; the server never handles it.
    if (options.fileType === 'splat') {
        throw new Error('splat export is handled client-side, not on the server');
    }

    // All remaining formats need the parsed DataTable.
    const rfs = new MemoryReadFileSystem();
    rfs.set('input.ply', new Uint8Array(ply));
    const tables = await readFile({
        filename: 'input.ply',
        inputFormat: 'ply',
        options: READ_OPTS,
        params: [],
        fileSystem: rfs
    });
    const dataTable = tables[0];
    // Re-tag: the readback table is not guaranteed to carry the PLY transform.
    (dataTable as any).transform = Transform.PLY;

    const memFs = new MemoryFileSystem();

    if (options.fileType === 'compressedPly') {
        await writeCompressedPly({ filename: options.filename, dataTable }, memFs);
        return { files: [{ name: options.filename, data: memFs.results.get(options.filename)! }] };
    }

    // GPU formats. Lazily import the shared client core so CPU-only paths never
    // load it. The core is compiled to repo-root dist-shared/ by
    // tsconfig.shared.json (server `build:shared` script) and loaded at runtime.
    //
    // We resolve it to an absolute file:// URL (relative to this module's own
    // location) rather than importing a bare relative specifier. Both
    // server/src/run-export.ts (vitest) and server/dist/run-export.js
    // (production) sit two levels below the repo root, so the same
    // '../../dist-shared/...' offset is correct in both. Using an explicit
    // file:// URL also sidesteps Vite/vitest's transform pipeline, which cannot
    // load a relative path pointing outside the server project root; plain Node
    // resolves the URL identically.
    ensureLive();
    sink.emit({ kind: 'progress', message: 'Preparing GPU export' });
    const coreUrl = pathToFileURL(
        resolve(dirname(fileURLToPath(import.meta.url)), '../../dist-shared/splat-export-core.js')
    ).href;
    const eventsUrl = pathToFileURL(
        resolve(dirname(fileURLToPath(import.meta.url)), '../../dist-shared/events.js')
    ).href;
    const { writeSogCore, writeViewerCore } = await import(coreUrl);
    const { Events } = await import(eventsUrl);
    const createDevice = getDeviceCreator();

    // The shared core fires progress + per-file events on an Events instance (the
    // same class the browser feeds its progress UI). Without one, GPU export
    // progress is silently dropped. Bridge those to the SSE sink, and route
    // splat-transform's logs through onLog for friendly server-side logging.
    const events = new Events();
    events.on('progressStart', (header: string) => sink.emit({ kind: 'progress', message: header, value: 0 }));
    events.on('progressUpdate', (p: { text?: string; progress?: number }) => sink.emit({ kind: 'progress', message: p.text, value: p.progress }));

    // Friendly per-file logging: collapse the many files inside each streaming
    // chunk folder (e.g. 0_0/meta.json + textures) into one summary line, and log
    // top-level files individually. Chunk files arrive contiguously, so a change
    // of chunk id / a non-chunk file / the final flush closes the current chunk.
    let chunk: { id: string; count: number; bytes: number } | null = null;
    const flushChunk = () => {
        if (chunk) {
            console.log(`Created streaming chunk ${chunk.id} (${chunk.count} file${chunk.count === 1 ? '' : 's'}, ${fmtSize(chunk.bytes)})`);
            chunk = null;
        }
    };
    events.on('exportFile', ({ name, bytes }: { name: string; bytes: number }) => {
        const m = /^(\d+_\d+)\//.exec(name);
        if (m) {
            if (chunk && chunk.id !== m[1]) flushChunk();
            if (!chunk) chunk = { id: m[1], count: 0, bytes: 0 };
            chunk.count++;
            chunk.bytes += bytes;
        } else {
            flushChunk();
            const label = /^(index\.(html|css|js)|settings\.json)$/.test(name) ? `viewer ${name}` : name;
            console.log(`Created ${label} (${fmtSize(bytes)})`);
        }
    });

    // Drop splat-transform's raw "<name> (<size>)" per-file lines (now represented
    // by the summaries above); forward every other log message.
    const onLog = (level: string, text: string) => {
        if (/ \(\d[\d.,]*\s?[KMGT]?B\)$/.test(text)) return;
        if (level === 'error') console.error(text);
        else if (level === 'warn') console.warn(text);
        else console.log(text);
    };

    if (options.fileType === 'sog') {
        await writeSogCore(dataTable, options.sogIterations ?? 10, createDevice, memFs, events, onLog, isCancelled);
        const data = memFs.results.get('output.sog')!;
        console.log(`Created ${options.filename} (${fmtSize(data.length)})`);
        return { files: [{ name: options.filename, data }] };
    }

    if (options.fileType === 'htmlViewer') {
        await writeViewerCore(dataTable, options.viewerExportSettings!.experienceSettings, 'html', createDevice, memFs, events, onLog, isCancelled);
        const data = memFs.results.get('output.html')!;
        console.log(`Created ${options.filename} (${fmtSize(data.length)})`);
        return { files: [{ name: options.filename, data }] };
    }

    // packageViewer
    const viewerType = options.viewerExportSettings!.streaming ? 'streaming' : 'package';
    await writeViewerCore(dataTable, options.viewerExportSettings!.experienceSettings, viewerType, createDevice, memFs, events, onLog, isCancelled);
    flushChunk();
    return { files: [{ name: options.filename, data: memFs.results.get('output.zip')! }] };
};
