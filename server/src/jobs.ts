import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { runExportViaWorker } from './run-export-worker-host.js';
import type { ExportOptions } from './run-export.js';
import type { ProgressEvent } from './progress.js';
import { publishZip, uploadFile, type PublishDest } from './s3.js';
import { runVideoCompress, type VideoCompressOptions } from './video-compress.js';

type Job = {
    id: string;
    state: 'queued' | 'running' | 'done' | 'error';
    listeners: ((e: ProgressEvent) => void)[];
    buffered: ProgressEvent[];
    result?: { name: string; data: Uint8Array }[];
    publishResult?: { url?: string; prefix: string };
    error?: string;
    createdAt: number;
    finishedAt?: number;
    cancelled: boolean;
    cancelTimer?: ReturnType<typeof setTimeout>;
    // Terminates the running export worker; set once the job starts running.
    cancel?: () => void;
};

const jobs = new Map<string, Job>();
const TTL_MS = 30 * 60 * 1000;

// When a job's last subscriber disconnects (e.g. the browser tab is refreshed
// or closed) we wait this long before cancelling, so a transient SSE drop that
// EventSource auto-reconnects through does not abort a still-wanted export.
const ABANDON_GRACE_MS = 5000;

// Arm a one-shot timer that cancels the job if it is still running with no
// subscribers when the grace period elapses. A (re)subscription clears it.
const scheduleAbandonCheck = (job: Job) => {
    if (job.cancelTimer) return;
    if (job.state !== 'queued' && job.state !== 'running') return;
    const t = setTimeout(() => {
        job.cancelTimer = undefined;
        if (job.listeners.length === 0 && (job.state === 'queued' || job.state === 'running')) {
            job.cancelled = true;
            job.cancel?.();   // terminate the worker thread if the export is running
        }
    }, ABANDON_GRACE_MS);
    t.unref();
    job.cancelTimer = t;
};

// Each job's worker stands up its own GPU device (and Dawn busy-poll pins a CPU
// core while alive), so we run one job at a time. A promise chain serializes all
// jobs (concurrency 1).
let chain: Promise<void> = Promise.resolve();

const push = (job: Job, e: ProgressEvent) => {
    job.buffered.push(e);
    for (const l of job.listeners) l(e);
};

// What a job actually does. Returning `cancel` alongside the promise lets the
// abandon timer terminate the underlying worker or child process.
type JobRunner = (onProgress: (e: ProgressEvent) => void) => {
    promise: Promise<{ files: { name: string; data: Uint8Array }[] }>;
    cancel: () => void;
};

const enqueue = (run: JobRunner, publish?: PublishDest, discard?: () => Promise<void> | void): string => {
    const id = `job_${randomBytes(16).toString('hex')}`;
    const job: Job = { id, state: 'queued', listeners: [], buffered: [], createdAt: Date.now(), cancelled: false };
    jobs.set(id, job);
    chain = chain.then(async () => {
        if (job.cancelled) {   // abandoned while still queued -> never start
            // The job never ran, so `run`'s own cleanup (e.g. runVideoCompress's
            // `finally`) never exists to reclaim whatever it was handed. Guarded
            // so a failing cleanup can't reject the shared chain and take down
            // every job queued behind this one.
            try {
                await discard?.();
            } catch (err) {
                console.warn('jobs: discard cleanup failed for abandoned queued job:', err);
            }
            jobs.delete(id);
            return;
        }
        job.state = 'running';
        const running = run((e: ProgressEvent) => push(job, e));
        job.cancel = running.cancel;
        try {
            const res = await running.promise;
            job.result = res.files;
            if (publish) {
                if (job.cancelled) { jobs.delete(id); return; }
                if (!res.files[0]) throw new Error('export produced no output to publish');
                const zipBytes = res.files[0].data;
                job.publishResult = await publishZip(zipBytes, publish, (e) => push(job, e));
            }
            job.state = 'done';
            job.finishedAt = Date.now();
            push(job, { kind: 'done', ...(job.publishResult ?? {}) });
        } catch (err: any) {
            if (job.cancelled) {   // aborted by the client disconnecting -> discard
                jobs.delete(id);
                return;
            }
            const message: string = err?.message ?? String(err);
            job.error = message;
            job.state = 'error';
            job.finishedAt = Date.now();
            push(job, { kind: 'error', message });
        }
    });
    return id;
};

export const createJob = (plyGz: Buffer, options: ExportOptions, publish?: PublishDest, extraPlyGz?: Buffer[]): string => {
    // The export runs in a worker thread so its heavy synchronous GPU/CPU work
    // (and Dawn's busy-poll) never blocks this event loop — keeping SSE
    // progress frames flushing in real time. The worker's device lives and
    // dies with the worker, reinforcing the "no idle device" invariant.
    return enqueue(onProgress => runExportViaWorker({ plyGz, options, onProgress, extraPlyGz }), publish);
};

// Video compression shares the one serial chain with splat exports on purpose:
// ffmpeg saturating every core while Dawn busy-polls a GPU worker is a worse
// failure than waiting for the queue.
export const createVideoJob = (masterPath: string, opts: VideoCompressOptions): string => {
    return enqueue((onProgress) => {
        const { promise, cancel } = runVideoCompress(masterPath, opts, onProgress);
        return { promise: promise.then(files => ({ files })), cancel };
    }, undefined, () => rm(dirname(masterPath), { recursive: true, force: true }));
};

// Store an already-received render (image/video) to S3, reporting progress.
//
// Deliberately NOT on the serial chain the exports and ffmpeg share: that chain
// exists because each of those pins a GPU or every CPU core, whereas a PutObject
// is network-bound. Queueing a few seconds of upload behind a multi-minute GPU
// export would strand the user's render for no benefit.
//
// There is no cancel path either: the bytes are already on disk and the client
// has nothing left to send, so a dropped SSE subscriber should not abort a
// half-written object in the bucket.
export const createUploadJob = (
    filePath: string,
    key: string,
    isPublic: boolean,
    cleanup: () => Promise<void> | void
): string => {
    const id = `job_${randomBytes(16).toString('hex')}`;
    const job: Job = { id, state: 'running', listeners: [], buffered: [], createdAt: Date.now(), cancelled: false };
    jobs.set(id, job);

    (async () => {
        try {
            // `message` is the English server-log line only; the editor supplies
            // its own localized text for this phase, so no `loc` is needed.
            const res = await uploadFile(filePath, key, isPublic, value => push(job, {
                kind: 'progress',
                message: `Storing ${key}`,
                value
            }));
            job.state = 'done';
            job.finishedAt = Date.now();
            push(job, { kind: 'done', url: res.url, key: res.key });
        } catch (err: any) {
            const message: string = err?.message ?? String(err);
            job.error = message;
            job.state = 'error';
            job.finishedAt = Date.now();
            push(job, { kind: 'error', message });
        } finally {
            try {
                await cleanup();
            } catch (err) {
                console.warn('jobs: upload temp cleanup failed:', err);
            }
        }
    })();

    return id;
};

export const getJob = (id: string): Job | undefined => jobs.get(id);

// Subscribe to a job's progress. Replays buffered events immediately, then
// streams new ones. Returns an unsubscribe fn. If the job already finished,
// replays everything (incl. the terminal event) and does not add a listener.
export const subscribe = (id: string, listener: (e: ProgressEvent) => void): (() => void) => {
    const job = jobs.get(id);
    if (!job) return () => {};
    // A (re)subscription means the client is still here: cancel any pending
    // abandon timer armed by a previous disconnect.
    if (job.cancelTimer) {
        clearTimeout(job.cancelTimer);
        job.cancelTimer = undefined;
    }
    for (const e of job.buffered) listener(e);
    if (job.state === 'done' || job.state === 'error') return () => {};
    job.listeners.push(listener);
    return () => {
        job.listeners = job.listeners.filter(l => l !== listener);
        if (job.listeners.length === 0) scheduleAbandonCheck(job);
    };
};

// Periodic TTL cleanup of finished jobs. unref so it never keeps the process alive.
setInterval(() => {
    const now = Date.now();
    for (const [id, j] of jobs) {
        if ((j.state === 'done' || j.state === 'error') && j.finishedAt && now - j.finishedAt > TTL_MS) {
            jobs.delete(id);
        }
    }
}, 60 * 1000).unref();
