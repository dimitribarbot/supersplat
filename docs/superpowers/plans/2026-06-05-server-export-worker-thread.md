# Server Export Worker-Thread Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run each server-side export in a Node `worker_thread` so the main event loop stays free to flush SSE progress frames in real time (fixing the bug where all progress — including the `Packaging streaming chunks … k-means` phase — arrives in one burst at the end and the bar never animates).

**Architecture:** The HTTP/SSE layer (`index.ts`, `jobs.ts`) stays on the main thread. The CPU/GPU-heavy `runExport` moves into a per-job worker thread (`export-worker.ts`). A thin main-thread host (`run-export-worker-host.ts`) spawns the worker, relays its `postMessage` progress straight into the existing `push(job, …)` SSE pipeline, and returns the result. Because Dawn's busy-poll now runs on the worker's thread, it no longer blocks the main loop, so buffered SSE writes flush as they happen. Cancellation becomes `worker.terminate()` (also stops Dawn), replacing the cooperative `isCancelled` poll for the job path.

**Tech Stack:** Node `worker_threads`, Fastify SSE, `@playcanvas/splat-transform`, `webgpu` (Dawn), Vitest.

**Verified before planning (on this machine, Node v24.12.0, RTX/Lovelace):**
- Dawn/`webgpu` initializes and runs a compute pass inside a `worker_thread`.
- `tsx` 4.22.4 spawns a `.ts` worker (dev path).
- Vitest 4.1.8 spawns a `.ts` worker (test path).
- So deriving the worker file extension from the spawner's own `import.meta.url` (`.ts` in dev/test, `.js` in prod) resolves correctly in all three environments.

**Out of scope:** Client code (`export-server-client.ts`, `file-handler.ts`, `progress.ts`) is correct and unchanged — it faithfully renders whatever it receives; the fix is purely server-side delivery. `run-export.ts`, `gpu.ts`, and `progress.ts` are unchanged (the worker imports them as-is).

---

## File Structure

- **Create `server/src/export-worker.ts`** — worker-thread entry. Receives `{ plyGz, options }`, runs `runExport`, relays each `ProgressEvent` via `postMessage`, and posts the result files (transferred) or an error. Owns the per-job GPU session.
- **Create `server/src/run-export-worker-host.ts`** — main-thread spawner. `runExportViaWorker({ plyGz, options, onProgress }) → { promise, cancel }`. Spawns the worker, wires messages, transfers the input bytes in, `cancel()` = `worker.terminate()`.
- **Modify `server/src/jobs.ts`** — replace the direct `runExport` + `createGpuSession` call in the queue chain with `runExportViaWorker`; store `cancel` on the job; have the abandon-grace path call it.
- **Create `server/test/worker-roundtrip.test.ts`** — CPU-only (no GPU) round-trip through a real worker (`compressedPly`), asserting the result returns intact.
- **Create `server/test/worker-progress.gpu.test.ts`** — GPU integration asserting progress events flow through the worker for a `sog` export (auto-skips without GPU).
- **Modify `server/test/jobs.test.ts`** — mock `run-export-worker-host.js` instead of `run-export.js`/`gpu.js`; assert abandon → `cancel()` called → job discarded; reconnect → result → done.

---

## Task 1: Worker host + worker entry (CPU round-trip)

**Files:**
- Create: `server/src/run-export-worker-host.ts`
- Create: `server/src/export-worker.ts`
- Test: `server/test/worker-roundtrip.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/test/worker-roundtrip.test.ts`:

```ts
import { Column, DataTable, Transform, writeFile, MemoryFileSystem } from '@playcanvas/splat-transform';
import { gzipSync } from 'node:zlib';
import { describe, it, expect } from 'vitest';
import { runExportViaWorker } from '../src/run-export-worker-host.js';

const NAMES = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

const makePlyGz = async (n = 64): Promise<Buffer> => {
    const cols = NAMES.map((name, i) => new Column(name, Float32Array.from({ length: n }, (_, r) => Math.fround((i + 1) + r * 0.01))));
    const memFs = new MemoryFileSystem();
    await writeFile({ filename: 'p.ply', outputFormat: 'ply', dataTable: new DataTable(cols, Transform.PLY), options: {} }, memFs);
    return Buffer.from(gzipSync(Buffer.from(memFs.results.get('p.ply')!)));
};

describe('runExportViaWorker round-trip (CPU)', () => {
    it('runs a compressedPly export in a worker and returns the result', async () => {
        const plyGz = await makePlyGz();
        const events: any[] = [];
        const { promise } = runExportViaWorker({
            plyGz,
            options: { fileType: 'compressedPly', filename: 'out.compressed.ply' },
            onProgress: e => events.push(e)
        });
        const res = await promise;
        expect(res.files).toHaveLength(1);
        expect(res.files[0].name).toBe('out.compressed.ply');
        expect(res.files[0].data.byteLength).toBeGreaterThan(0);
    }, 30000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run test/worker-roundtrip.test.ts`
Expected: FAIL — cannot resolve `../src/run-export-worker-host.js` (module does not exist yet).

- [ ] **Step 3: Create the worker entry**

Create `server/src/export-worker.ts`:

```ts
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

type StartMsg = { type: 'start'; plyGz: Uint8Array; options: ExportOptions };

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
            getDeviceCreator: session.getDeviceCreator
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
        port.postMessage({ type: 'result', files }, files.map(f => f.data.buffer));
    } catch (err: any) {
        await session.dispose();
        port.postMessage({ type: 'error', message: err?.message ?? String(err) });
    }
});
```

- [ ] **Step 4: Create the worker host**

Create `server/src/run-export-worker-host.ts`:

```ts
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
    const worker = new Worker(workerUrl);
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
    worker.postMessage({ type: 'start', plyGz: bytes, options }, [bytes.buffer]);

    return { promise, cancel: () => { worker.terminate(); } };
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && npx vitest run test/worker-roundtrip.test.ts`
Expected: PASS — `runs a compressedPly export in a worker and returns the result`.

- [ ] **Step 6: Commit**

```bash
git add server/src/export-worker.ts server/src/run-export-worker-host.ts server/test/worker-roundtrip.test.ts
git commit -m "feat(server): run exports in a worker thread (host + entry)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Switch the job queue to the worker

**Files:**
- Modify: `server/src/jobs.ts`
- Modify: `server/test/jobs.test.ts`

- [ ] **Step 1: Rewrite the jobs unit test to mock the worker host**

Replace the entire contents of `server/test/jobs.test.ts` with:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run test/jobs.test.ts`
Expected: FAIL — `jobs.ts` still imports/uses `runExport`/`createGpuSession`, so `cancelSpy` is never called and the mock of `run-export-worker-host.js` is unused.

- [ ] **Step 3: Update the Job type and imports in `jobs.ts`**

In `server/src/jobs.ts`, replace the two source imports:

```ts
import { runExport, type ExportOptions } from './run-export.js';
import { createGpuSession } from './gpu.js';
import type { ProgressEvent } from './progress.js';
```

with:

```ts
import { runExportViaWorker } from './run-export-worker-host.js';
import type { ExportOptions } from './run-export.js';
import type { ProgressEvent } from './progress.js';
```

Add a `cancel` field to the `Job` type (insert after the `cancelTimer?` line):

```ts
    cancelTimer?: ReturnType<typeof setTimeout>;
    // Terminates the running export worker; set once the job starts running.
    cancel?: () => void;
```

- [ ] **Step 4: Have the abandon-grace timer terminate the worker**

In `server/src/jobs.ts`, inside `scheduleAbandonCheck`, replace:

```ts
        if (job.listeners.length === 0 && (job.state === 'queued' || job.state === 'running')) {
            // run-export polls job.cancelled and unwinds at the next progress tick.
            job.cancelled = true;
        }
```

with:

```ts
        if (job.listeners.length === 0 && (job.state === 'queued' || job.state === 'running')) {
            job.cancelled = true;
            job.cancel?.();   // terminate the worker thread if the export is running
        }
```

- [ ] **Step 5: Replace the queue-chain body to drive the worker**

In `server/src/jobs.ts`, replace the whole `chain = chain.then(async () => { … });` block inside `createJob` with:

```ts
    chain = chain.then(async () => {
        if (job.cancelled) {   // abandoned while still queued -> never start
            jobs.delete(id);
            return;
        }
        job.state = 'running';
        // The export runs in a worker thread so its heavy synchronous GPU/CPU work
        // (and Dawn's busy-poll) never blocks this event loop — keeping SSE
        // progress frames flushing in real time. The worker's device lives and
        // dies with the worker, reinforcing the "no idle device" invariant.
        const running = runExportViaWorker({
            plyGz,
            options,
            onProgress: (e: ProgressEvent) => push(job, e)
        });
        job.cancel = running.cancel;
        try {
            const res = await running.promise;
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
```

(The `createGpuSession`/`gpuSession.dispose()` and `getDeviceCreator`/`isCancelled` wiring are gone — the worker owns the device and cancellation is `terminate()`.)

- [ ] **Step 6: Run the jobs test to verify it passes**

Run: `cd server && npx vitest run test/jobs.test.ts`
Expected: PASS — both abandon-cancel and reconnect cases.

- [ ] **Step 7: Run the routes e2e test (real worker, CPU compressedPly through the HTTP layer)**

Run: `cd server && npx vitest run test/routes.test.ts`
Expected: PASS — `POST /api/export -> events(done) -> result returns a compressed PLY` (now served via a real worker thread) and the unsafe-filename rejection.

- [ ] **Step 8: Commit**

```bash
git add server/src/jobs.ts server/test/jobs.test.ts
git commit -m "feat(server): drive export jobs through the worker host

Cancellation is now worker.terminate() instead of cooperative isCancelled
polling; the device lifecycle moves into the worker.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: GPU progress-relay integration test

**Files:**
- Test: `server/test/worker-progress.gpu.test.ts`

- [ ] **Step 1: Write the GPU integration test**

Create `server/test/worker-progress.gpu.test.ts`:

```ts
import { Column, DataTable, Transform, writeFile, MemoryFileSystem } from '@playcanvas/splat-transform';
import { gzipSync } from 'node:zlib';
import { describe, it, expect, beforeAll } from 'vitest';
import { probeGpu } from '../src/gpu.js';
import { runExportViaWorker } from '../src/run-export-worker-host.js';
import type { ProgressEvent } from '../src/progress.js';

const NAMES = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

const makePlyGz = async (n = 2048): Promise<Buffer> => {
    const cols = NAMES.map((name, i) => new Column(name, Float32Array.from({ length: n }, (_, r) => Math.fround(Math.sin((i + 1) + r * 0.001)))));
    const memFs = new MemoryFileSystem();
    await writeFile({ filename: 'p.ply', outputFormat: 'ply', dataTable: new DataTable(cols, Transform.PLY), options: {} }, memFs);
    return Buffer.from(gzipSync(Buffer.from(memFs.results.get('p.ply')!)));
};

describe('runExportViaWorker GPU progress relay', () => {
    let gpu = false;
    beforeAll(async () => { gpu = (await probeGpu()).gpu; });

    it('relays progress events from the worker and returns a SOG', async () => {
        if (!gpu) { console.warn('No GPU available; skipping worker GPU progress test'); return; }
        const plyGz = await makePlyGz(2048);
        const events: ProgressEvent[] = [];
        const { promise } = runExportViaWorker({
            plyGz,
            options: { fileType: 'sog', filename: 'out.sog', sogIterations: 10 },
            onProgress: e => events.push(e)
        });
        const res = await promise;
        expect(res.files[0].name).toBe('out.sog');
        expect(res.files[0].data.byteLength).toBeGreaterThan(0);
        // The worker forwarded splat-transform's progress through postMessage.
        expect(events.some(e => e.kind === 'progress')).toBe(true);
        expect(events.some(e => e.kind === 'progress' && typeof e.value === 'number')).toBe(true);
    }, 180000);
});
```

- [ ] **Step 2: Run the GPU test**

Run: `cd server && npx vitest run test/worker-progress.gpu.test.ts`
Expected (GPU present): PASS — relays progress and returns a SOG.
Expected (no GPU): PASS with the `No GPU available` warning (test is a no-op).

- [ ] **Step 3: Commit**

```bash
git add server/test/worker-progress.gpu.test.ts
git commit -m "test(server): assert progress relays through the export worker

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Full verification (suite + dev smoke + manual browser)

**Files:** none (verification only)

- [ ] **Step 1: Build the server to prove the worker compiles to `dist/`**

Run: `cd server && npm run build`
Expected: succeeds; `server/dist/export-worker.js` and `server/dist/run-export-worker-host.js` exist.

- [ ] **Step 2: Run the full server test suite**

Run: `cd server && npm test`
Expected: all suites pass (`jobs`, `routes`, `run-export`, `gpu-session`, `progress`, `static`, `worker-roundtrip`, and — if a GPU is present — `streaming.gpu`, `run-export.gpu`, `worker-progress.gpu`).

- [ ] **Step 3: Manual browser verification (acceptance check for the cosmetic fix)**

This is the actual bug. There is no deterministic automated assertion for "the bar animates" (timing-dependent), so verify by hand:

1. Build the web app and start the server: `npm run build` (repo root) then `cd server && npm start`.
2. Open the served app, load a multi-million-gaussian scene with SH, choose **Export → viewer → ZIP, streaming**, and route it through the server.
3. Confirm the progress dialog now advances smoothly through `Building detail level N of M …` **and** `Packaging streaming chunks (n/m): k-means`, with the bar visibly moving — instead of freezing on `Building detail level 3 of 3: Computing edge costs (GPU)` and jumping straight to done.
4. Optional cross-check (DevTools → Network → the `…/events` request → EventStream): progress frames now arrive spread over time, not in a single end-of-export burst.
5. Confirm the downloaded `.zip` opens and renders correctly (output unchanged from before).

- [ ] **Step 4: Squash the branch into a single commit (per workflow) when finishing**

Defer to `superpowers:finishing-a-development-branch` at branch completion; squash all task commits into one summarizing the worker-thread change incl. this plan.

---

## Self-Review

**Spec coverage:**
- Root cause (main-loop blocking starves SSE) → addressed by moving `runExport` into a worker (Tasks 1–2).
- Dev/prod/test path resolution → `workerExt` trick, verified in all three environments (Task 1, host module).
- GPU in worker → verified feasible pre-plan; exercised by Task 3.
- Cancellation parity → abandon-grace now calls `worker.terminate()` and the job is discarded on the resulting rejection (Task 2, jobs test).
- No client changes required → stated in header; nothing in the plan touches client code.
- Result/​input large-buffer handling → zero-copy transfer with partial-view guard (Task 1).

**Placeholder scan:** No TBD/TODO; every code step shows full code; every run step shows the command and expected outcome.

**Type consistency:** `runExportViaWorker(args) → { promise: Promise<RunResult>; cancel: () => void }` is defined in Task 1 and consumed identically in Task 2 (`running.promise`, `running.cancel`) and the tests. `RunResult`/`ExportOptions`/`ProgressEvent` are imported from their existing modules (`run-export.ts`, `progress.ts`). Worker message protocol (`start` / `progress` / `result` / `error`) is symmetric between `export-worker.ts` (Task 1) and `run-export-worker-host.ts` (Task 1). `Job.cancel` added in Task 2 matches its use in `scheduleAbandonCheck` and the chain body.
