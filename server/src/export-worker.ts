import { Buffer } from 'node:buffer';
import { parentPort } from 'node:worker_threads';
import { runExport, type ExportOptions } from './run-export.js';
import { createGpuSession } from './gpu.js';
import type { ProgressEvent } from './progress.js';

// This module only ever runs as a worker thread (spawned by
// run-export-worker-host.ts). Guard so a stray direct import fails loudly.
if (!parentPort) {
    throw new Error('export-worker.ts must be run as a worker thread');
}
const port = parentPort;

type StartMsg = { type: 'start'; plyGz: Uint8Array; options: ExportOptions; extraPlyGz?: Uint8Array[] };

port.on('message', async (msg: StartMsg) => {
    if (msg?.type !== 'start') return;

    // The GPU session owns this job's single device; it is destroyed before we
    // post the terminal message. For CPU-only formats (e.g. compressedPly) no
    // device is ever created because runExport returns before requesting one.
    const session = createGpuSession();
    try {
        const res = await runExport({
            // Wrap the transferred bytes without copying (Buffer view over the ArrayBuffer).
            plyGz: Buffer.from(msg.plyGz.buffer, msg.plyGz.byteOffset, msg.plyGz.byteLength),
            options: msg.options,
            sink: { emit: (e: ProgressEvent) => port.postMessage({ type: 'progress', event: e }) },
            getDeviceCreator: session.getDeviceCreator,
            extraPlyGz: (msg.extraPlyGz ?? []).map(u => Buffer.from(u.buffer, u.byteOffset, u.byteLength))
        });
        await session.dispose();

        // Normalize each file to a standalone full-length view so its ArrayBuffer
        // can be transferred zero-copy back to the main thread.
        const files = res.files.map(f => ({
            name: f.name,
            data: (f.data.byteOffset === 0 && f.data.byteLength === f.data.buffer.byteLength)
                ? f.data
                : new Uint8Array(f.data)
        }));
        port.postMessage({ type: 'result', files }, files.map(f => f.data.buffer as ArrayBuffer));
    } catch (err: any) {
        await session.dispose();
        port.postMessage({ type: 'error', message: err?.message ?? String(err) });
    }
});
