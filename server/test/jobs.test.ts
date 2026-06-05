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
