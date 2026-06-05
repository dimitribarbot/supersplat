import { Worker } from 'node:worker_threads';
import type { ExportOptions, RunResult } from './run-export.js';
import type { ProgressEvent } from './progress.js';

// In dev this module is loaded as `.ts` (tsx) and so is the worker; under vitest
// likewise; in production both are compiled `.js`. Derive the worker file's
// extension from our own module URL so `new Worker(url)` resolves in all three.
const workerExt = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
const workerUrl = new URL(`./export-worker.${workerExt}`, import.meta.url);

export type RunExportViaWorkerArgs = {
    plyGz: Buffer;
    options: ExportOptions;
    onProgress: (e: ProgressEvent) => void;
};

export type RunningExport = {
    promise: Promise<RunResult>;
    // Abort by terminating the worker thread. This also stops Dawn's busy-poll,
    // since the device lives on the worker's thread.
    cancel: () => void;
};

export const runExportViaWorker = ({ plyGz, options, onProgress }: RunExportViaWorkerArgs): RunningExport => {
    // When spawning a .ts worker (dev/test), Node won't know how to handle .ts
    // imports inside the worker. Pass tsx's ESM loader so the worker thread gets
    // the same TypeScript transform as the spawning process.
    const workerOptions = workerExt === 'ts' ? { execArgv: ['--import', 'tsx/esm'] } : {};
    const worker = new Worker(workerUrl, workerOptions);
    let settled = false;

    const promise = new Promise<RunResult>((resolve, reject) => {
        worker.on('message', (msg: any) => {
            if (msg?.type === 'progress') {
                onProgress(msg.event as ProgressEvent);
            } else if (msg?.type === 'result') {
                settled = true;
                resolve({ files: msg.files });
                worker.terminate();
            } else if (msg?.type === 'error') {
                settled = true;
                reject(new Error(msg.message));
                worker.terminate();
            }
        });
        // An uncaught error in the worker, or the worker exiting before sending a
        // terminal message (e.g. terminate() from cancel()), rejects the promise.
        worker.on('error', (err) => {
            if (!settled) { settled = true; reject(err); }
        });
        worker.on('exit', () => {
            if (!settled) { settled = true; reject(new Error('export worker exited before completing')); }
        });
    });

    // Transfer the input bytes into the worker (zero-copy when plyGz is a
    // standalone full-buffer Buffer, which it is for large multipart uploads).
    const standalone = plyGz.byteOffset === 0 && plyGz.byteLength === plyGz.buffer.byteLength;
    const bytes = standalone ? new Uint8Array(plyGz.buffer) : new Uint8Array(plyGz);
    worker.postMessage({ type: 'start', plyGz: bytes, options }, [bytes.buffer as ArrayBuffer]);

    return { promise, cancel: () => { worker.terminate(); } };
};
