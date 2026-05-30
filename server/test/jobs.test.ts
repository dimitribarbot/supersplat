import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Avoid importing the real GPU/device module and the real export pipeline; we
// only want to test the job lifecycle / abandon-cancel wiring here.
vi.mock('../src/gpu.js', () => ({ getDeviceCreator: () => () => Promise.resolve({}) }));

let capturedIsCancelled: (() => boolean) | undefined;
let settle: { resolve: (v: any) => void; reject: (e: any) => void } | undefined;
vi.mock('../src/run-export.js', () => ({
    runExport: vi.fn((args: any) => {
        capturedIsCancelled = args.isCancelled;
        return new Promise((resolve, reject) => { settle = { resolve, reject }; });
    })
}));

const { createJob, getJob, subscribe } = await import('../src/jobs.js');

const OPTS = { fileType: 'sog', filename: 'o.sog' } as any;

describe('jobs abandon-cancel wiring', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        capturedIsCancelled = undefined;
        settle = undefined;
    });
    afterEach(() => { vi.useRealTimers(); });

    it('cancels a running job when its subscriber stays gone past the grace period', async () => {
        const id = createJob(Buffer.from('x'), OPTS);
        await vi.advanceTimersByTimeAsync(0);   // let the queue chain start the job
        expect(getJob(id)?.state).toBe('running');

        const unsub = subscribe(id, () => {});
        unsub();   // browser refresh / tab close

        expect(getJob(id)?.cancelled).toBe(false);    // within grace
        await vi.advanceTimersByTimeAsync(5000);
        expect(getJob(id)?.cancelled).toBe(true);      // grace elapsed
        expect(capturedIsCancelled?.()).toBe(true);    // the running export sees it

        // the writer unwinds with the cancel error -> job is discarded
        settle!.reject(new Error('export cancelled'));
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

        settle!.resolve({ files: [{ name: 'o.sog', data: new Uint8Array([1]) }] });
        await vi.advanceTimersByTimeAsync(0);
        expect(getJob(id)?.state).toBe('done');
    });
});
