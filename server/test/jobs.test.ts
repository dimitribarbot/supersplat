import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The job queue now drives the export through a worker host. Mock the host so we
// can test the job lifecycle / abandon-cancel wiring without spawning a thread.
const cancelSpy = vi.fn();
let settle: { resolve: (v: any) => void; reject: (e: any) => void } | undefined;
vi.mock('../src/run-export-worker-host.js', () => ({
    runExportViaWorker: vi.fn(() => ({
        promise: new Promise((resolve, reject) => { settle = { resolve, reject }; }),
        cancel: cancelSpy
    }))
}));

const { createJob, getJob, subscribe } = await import('../src/jobs.js');

const OPTS = { fileType: 'sog', filename: 'o.sog' } as any;

describe('jobs abandon-cancel wiring', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        cancelSpy.mockClear();
        settle = undefined;
    });
    afterEach(() => { vi.useRealTimers(); });

    it('cancels a running job (terminates its worker) when its subscriber stays gone past the grace period', async () => {
        const id = createJob(Buffer.from('x'), OPTS);
        await vi.advanceTimersByTimeAsync(0);   // let the queue chain start the job
        expect(getJob(id)?.state).toBe('running');

        const unsub = subscribe(id, () => {});
        unsub();   // browser refresh / tab close

        expect(getJob(id)?.cancelled).toBe(false);    // within grace
        await vi.advanceTimersByTimeAsync(5000);
        expect(getJob(id)?.cancelled).toBe(true);      // grace elapsed
        expect(cancelSpy).toHaveBeenCalledTimes(1);    // the worker was terminated

        // terminating the worker rejects the export promise -> job is discarded
        settle!.reject(new Error('export worker exited before completing'));
        await vi.advanceTimersByTimeAsync(0);
        expect(getJob(id)).toBeUndefined();
    });

    it('does not cancel if the client reconnects within the grace period', async () => {
        const id = createJob(Buffer.from('x'), OPTS);
        await vi.advanceTimersByTimeAsync(0);

        subscribe(id, () => {})();          // subscribe then immediately disconnect
        await vi.advanceTimersByTimeAsync(2000);
        subscribe(id, () => {});            // reconnect before grace elapses
        await vi.advanceTimersByTimeAsync(5000);

        expect(getJob(id)?.cancelled).toBe(false);
        expect(cancelSpy).not.toHaveBeenCalled();

        settle!.resolve({ files: [{ name: 'o.sog', data: new Uint8Array([1]) }] });
        await vi.advanceTimersByTimeAsync(0);
        expect(getJob(id)?.state).toBe('done');
    });
});

describe('createVideoJob', () => {
    it('runs on the shared queue and exposes its result at the same shape', async () => {
        // A video job that fails immediately (no such master file) still proves
        // the wiring: it must be findable by id, reach a terminal state, and
        // deliver its terminal event to a subscriber like any export job.
        const { createVideoJob, getJob, subscribe } = await import('../src/jobs.js');

        const id = createVideoJob('/definitely/not/a/real/master.mp4', {
            targetMB: 1, frameRate: 30, frames: 90
        });
        expect(getJob(id)).toBeDefined();

        const terminal = await new Promise<any>((resolve) => {
            subscribe(id, (e) => {
                if (e.kind === 'done' || e.kind === 'error') resolve(e);
            });
        });

        expect(terminal.kind).toBe('error');
        expect(getJob(id)?.state).toBe('error');
    }, 30000);
});

describe('createVideoJob queued-cancel cleanup', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        cancelSpy.mockClear();
        settle = undefined;
    });
    afterEach(() => { vi.useRealTimers(); });

    it('removes the uploaded master directory when abandoned while still queued', async () => {
        const { createJob, createVideoJob, getJob, subscribe } = await import('../src/jobs.js');

        // Occupy the shared serial chain with a still-running (mocked) export
        // job so a video job enqueued behind it stays 'queued' until we let
        // the first one finish. This never touches ffmpeg, since the video
        // job's discard fires before `run` (and therefore runVideoCompress)
        // is ever invoked.
        const blockerId = createJob(Buffer.from('x'), OPTS);
        await vi.advanceTimersByTimeAsync(0);
        expect(getJob(blockerId)?.state).toBe('running');

        const uploadDir = await mkdtemp(join(tmpdir(), 'ssvc-up-test-'));
        const masterPath = join(uploadDir, 'master');
        await writeFile(masterPath, 'not a real video');

        const videoId = createVideoJob(masterPath, { targetMB: 1, frameRate: 30, frames: 90 });
        expect(getJob(videoId)?.state).toBe('queued');

        // Abandon it the same way the running-job test does: subscribe then
        // immediately disconnect, and let the grace period elapse.
        const unsub = subscribe(videoId, () => {});
        unsub();
        await vi.advanceTimersByTimeAsync(5000);
        expect(getJob(videoId)?.cancelled).toBe(true);

        // Let the blocker finish so the chain advances to the (now cancelled)
        // queued video job. Draining this needs several microtask hops (the
        // blocker's own completion, then the video job's discard callback,
        // which does a real fs.rm) plus real event-loop turns for that I/O,
        // so switch off fake timers and poll rather than assuming a single
        // advanceTimersByTimeAsync(0) flushes it all.
        vi.useRealTimers();
        settle!.resolve({ files: [{ name: 'o.sog', data: new Uint8Array([1]) }] });
        for (let i = 0; i < 50 && getJob(videoId); i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }

        expect(getJob(videoId)).toBeUndefined();
        await expect(stat(uploadDir)).rejects.toThrow();
    });
});
