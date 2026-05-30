import { randomBytes } from 'node:crypto';
import { runExport, type ExportOptions } from './run-export.js';
import { getDeviceCreator } from './gpu.js';
import type { ProgressEvent } from './progress.js';

type Job = {
    id: string;
    state: 'queued' | 'running' | 'done' | 'error';
    listeners: ((e: ProgressEvent) => void)[];
    buffered: ProgressEvent[];
    result?: { name: string; data: Uint8Array }[];
    error?: string;
    createdAt: number;
    finishedAt?: number;
    cancelled: boolean;
    cancelTimer?: ReturnType<typeof setTimeout>;
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
            // run-export polls job.cancelled and unwinds at the next progress tick.
            job.cancelled = true;
        }
    }, ABANDON_GRACE_MS);
    t.unref();
    job.cancelTimer = t;
};

// Single shared GPU device => GPU work must run one job at a time. A promise
// chain serializes all jobs (concurrency 1).
let chain: Promise<void> = Promise.resolve();

const push = (job: Job, e: ProgressEvent) => {
    job.buffered.push(e);
    for (const l of job.listeners) l(e);
};

export const createJob = (plyGz: Buffer, options: ExportOptions): string => {
    const id = `job_${randomBytes(16).toString('hex')}`;
    const job: Job = { id, state: 'queued', listeners: [], buffered: [], createdAt: Date.now(), cancelled: false };
    jobs.set(id, job);
    chain = chain.then(async () => {
        if (job.cancelled) {   // abandoned while still queued -> never start
            jobs.delete(id);
            return;
        }
        job.state = 'running';
        try {
            const res = await runExport({
                plyGz,
                options,
                sink: { emit: e => push(job, e) },
                getDeviceCreator,
                isCancelled: () => job.cancelled
            });
            job.result = res.files;
            job.state = 'done';
            job.finishedAt = Date.now();
            push(job, { kind: 'done' });
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
