# Server-side video compression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Compress checkbox + target-size input to the video render dialog that hands the rendered master to the export server, which re-encodes it to a WebM/VP9 file at or under the requested size.

**Architecture:** The browser renders the master exactly as it does today, but streams it into an OPFS temp file instead of the user's chosen file. `editor.ts` uploads that master to a new `/api/video/compress` endpoint, which runs two-pass `libvpx-vp9` via spawned `ffmpeg` processes (auto-chunked and run in parallel), then returns the finished WebM through the existing job/SSE/result plumbing. `src/render.ts` is never modified.

**Tech Stack:** TypeScript, Fastify + `@fastify/multipart` (server), PCUI (dialog), Vitest, host `ffmpeg` spawned via `node:child_process`. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-08-13-video-compress-server-design.md`

## Global Constraints

- **No new npm dependencies.** ffmpeg is the host binary, located via `FFMPEG_PATH` or `ffmpeg` on PATH.
- **Never modify `src/render.ts`.** It is upstream-owned; every edit there is future merge-conflict debt.
- **Never build a shell command string.** All ffmpeg invocations use argv arrays via `spawn(bin, args)` with no `shell: true`.
- **Encoder settings are fixed and not user-exposed:** `libvpx-vp9`, `-row-mt 1`, `-pix_fmt yuv420p`, `-vf hqdn3d=1.5:1.5:6:6`, pass 1 `-cpu-used 4`, pass 2 `-cpu-used 1`.
- **Bitrate:** `kbps = max(32, floor(targetMB * 8000 / seconds * 0.97))`.
- **Chunking:** `n = clamp(floor(seconds / 10), 1, cores)`; per-chunk frame counts must sum **exactly** to the total frame count.
- **Output is always WebM/VP9.** Every other dialog control describes the master and must not be modified or disabled.
- **Run commands plainly** — no `cd`, `git -C`, or `npm --prefix` pointing at the cwd. Front-end commands run from the repo root; server commands run from `server/`.
- **ESLint:** do not reorder imports (`import/order` autofix crashes on the pinned ESLint 10). Match surrounding style.
- Front-end tests: `npm run test` (repo root). Server tests: `npm run test` from `server/`.

---

### Task 1: Pure planning math and argv builders

Everything here is a pure function so it is testable without ffmpeg installed. This mirrors `src/alignment-solve.ts`, which keeps its solver math free of engine dependencies for the same reason.

**Files:**
- Create: `server/src/video-compress-plan.ts`
- Test: `server/test/video-compress-plan.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type Chunk = { startFrame: number; frames: number }`
  - `type Plan = { kbps: number; seconds: number; chunks: Chunk[] }`
  - `type PassArgs = { master: string; chunk: Chunk; frameRate: number; kbps: number; pass: 1 | 2; cpuUsed: number; logPrefix: string; out: string }`
  - `computePlan(frames: number, frameRate: number, targetMB: number, cores: number): Plan`
  - `correctedKbps(kbps: number, actualBytes: number, targetBytes: number): number`
  - `buildPassArgs(o: PassArgs): string[]`
  - `buildConcatArgs(listPath: string, outPath: string): string[]`
  - `PASS1_CPU_USED = 4`, `PASS2_CPU_USED = 1`

- [ ] **Step 1: Write the failing test**

Create `server/test/video-compress-plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
    buildConcatArgs,
    buildPassArgs,
    computePlan,
    correctedKbps,
    PASS1_CPU_USED,
    PASS2_CPU_USED
} from '../src/video-compress-plan.js';

// A 60s clip at 30fps as the editor counts it: render.ts:734 computes
// `floor(duration * frameRate) + 1`, so a 0..1800 frame range yields 1801.
const FRAMES_60S = 1801;

describe('computePlan', () => {
    it('splits a 60s clip into 6 chunks of ~10s', () => {
        const plan = computePlan(FRAMES_60S, 30, 6, 32);
        expect(plan.chunks).toHaveLength(6);
    });

    it('per-chunk frame counts sum exactly to the total', () => {
        // The script produced 1351 frames from a 1350-frame source until chunk
        // boundaries became frame-exact. A seam off by one duplicates a frame
        // and is invisible without this assertion.
        for (const frames of [1801, 1800, 1799, 907, 601]) {
            const plan = computePlan(frames, 30, 6, 32);
            const total = plan.chunks.reduce((sum, c) => sum + c.frames, 0);
            expect(total).toBe(frames);
        }
    });

    it('lays chunks end to end with no gap or overlap', () => {
        const plan = computePlan(FRAMES_60S, 30, 6, 32);
        let expected = 0;
        for (const chunk of plan.chunks) {
            expect(chunk.startFrame).toBe(expected);
            expected += chunk.frames;
        }
        expect(expected).toBe(FRAMES_60S);
    });

    it('spreads the remainder across the leading chunks', () => {
        const plan = computePlan(FRAMES_60S, 30, 6, 32);   // 1801 = 300*6 + 1
        expect(plan.chunks[0].frames).toBe(301);
        expect(plan.chunks[1].frames).toBe(300);
    });

    it('uses a single chunk below 20 seconds', () => {
        const plan = computePlan(30 * 19, 30, 6, 32);
        expect(plan.chunks).toHaveLength(1);
        expect(plan.chunks[0]).toEqual({ startFrame: 0, frames: 570 });
    });

    it('caps the chunk count at the core count', () => {
        const plan = computePlan(30 * 600, 30, 6, 4);      // 600s would want 60
        expect(plan.chunks).toHaveLength(4);
    });

    it('computes kbps from the target size with a 3% safety margin', () => {
        const plan = computePlan(FRAMES_60S, 30, 6, 32);
        const seconds = FRAMES_60S / 30;
        expect(plan.seconds).toBeCloseTo(seconds, 6);
        expect(plan.kbps).toBe(Math.floor(6 * 8000 / seconds * 0.97));
    });

    it('floors kbps at 32 for absurdly small targets', () => {
        const plan = computePlan(FRAMES_60S, 30, 0.05, 32);
        expect(plan.kbps).toBe(32);
    });
});

describe('correctedKbps', () => {
    it('shrinks proportionally when the output overshot', () => {
        expect(correctedKbps(1000, 1200, 1000)).toBe(833);
    });

    it('never returns below the floor', () => {
        expect(correctedKbps(100, 1e9, 1)).toBe(32);
    });
});

describe('buildPassArgs', () => {
    const chunk = { startFrame: 300, frames: 300 };
    const base = {
        master: '/tmp/x/master.mp4',
        chunk,
        frameRate: 30,
        kbps: 776,
        logPrefix: '/tmp/x/p1',
        out: '/tmp/x/c1.webm'
    };

    it('seeks by frame index converted to seconds', () => {
        const args = buildPassArgs({ ...base, pass: 1, cpuUsed: PASS1_CPU_USED });
        expect(args[args.indexOf('-ss') + 1]).toBe('10.000000');
    });

    it('limits by exact frame count, never by duration', () => {
        const args = buildPassArgs({ ...base, pass: 2, cpuUsed: PASS2_CPU_USED });
        expect(args[args.indexOf('-frames:v') + 1]).toBe('300');
        expect(args).not.toContain('-t');
    });

    it('carries the fixed encoder settings', () => {
        const args = buildPassArgs({ ...base, pass: 2, cpuUsed: PASS2_CPU_USED });
        expect(args[args.indexOf('-c:v') + 1]).toBe('libvpx-vp9');
        expect(args[args.indexOf('-row-mt') + 1]).toBe('1');
        expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p');
        expect(args[args.indexOf('-vf') + 1]).toBe('hqdn3d=1.5:1.5:6:6');
        expect(args[args.indexOf('-b:v') + 1]).toBe('776k');
        expect(args).toContain('-an');
    });

    it('discards output on pass 1 and writes the file on pass 2', () => {
        const p1 = buildPassArgs({ ...base, pass: 1, cpuUsed: PASS1_CPU_USED });
        expect(p1.slice(-3)).toEqual(['-f', 'null', '-']);
        expect(p1[p1.indexOf('-cpu-used') + 1]).toBe('4');
        expect(p1).not.toContain('/tmp/x/c1.webm');

        const p2 = buildPassArgs({ ...base, pass: 2, cpuUsed: PASS2_CPU_USED });
        expect(p2[p2.length - 1]).toBe('/tmp/x/c1.webm');
        expect(p2[p2.indexOf('-cpu-used') + 1]).toBe('1');
    });

    it('requests machine-readable progress', () => {
        const args = buildPassArgs({ ...base, pass: 2, cpuUsed: PASS2_CPU_USED });
        expect(args[args.indexOf('-progress') + 1]).toBe('pipe:1');
        expect(args).toContain('-nostats');
    });

    it('returns every argument as its own array element', () => {
        // A single concatenated string would reintroduce shell-injection risk
        // via the master path. Every element must be a discrete token.
        const args = buildPassArgs({ ...base, pass: 2, cpuUsed: PASS2_CPU_USED });
        expect(args.every(a => typeof a === 'string')).toBe(true);
        expect(args.some(a => a.includes(' -'))).toBe(false);
    });
});

describe('buildConcatArgs', () => {
    it('uses the concat demuxer with stream copy', () => {
        expect(buildConcatArgs('/tmp/x/list.txt', '/tmp/x/out.webm')).toEqual([
            '-y', '-f', 'concat', '-safe', '0',
            '-i', '/tmp/x/list.txt', '-c', 'copy', '/tmp/x/out.webm'
        ]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --prefix server -- video-compress-plan` — or from `server/`: `npx vitest run test/video-compress-plan.test.ts`
Expected: FAIL — `Failed to resolve import "../src/video-compress-plan.js"`

- [ ] **Step 3: Write minimal implementation**

Create `server/src/video-compress-plan.ts`:

```ts
// Pure planning arithmetic and argv construction for the VP9 size-targeted
// encode. No I/O and no process spawning live here so the numbers can be
// unit-tested on machines without ffmpeg — the same split as
// src/alignment-solve.ts.

export type Chunk = { startFrame: number; frames: number };
export type Plan = { kbps: number; seconds: number; chunks: Chunk[] };

export type PassArgs = {
    master: string;
    chunk: Chunk;
    frameRate: number;
    kbps: number;
    pass: 1 | 2;
    cpuUsed: number;
    logPrefix: string;
    out: string;            // ignored on pass 1
};

// Chunking exists only to cut wall clock. The floor is on chunk *length*, not
// count: each boundary costs a keyframe and an independent rate-control budget,
// which measured at the edge of noise at 10s and ~0.15 VMAF at 4s.
export const MIN_CHUNK_SECONDS = 10;

// libvpx produces garbage below this; a target small enough to reach it is
// already hopeless, but the encode should still complete.
export const MIN_KBPS = 32;

// Budget 3% under the target so container overhead and VBR drift stay inside it.
export const SIZE_SAFETY = 0.97;

// Pass 1 emits no bits — only the stats log pass 2's rate control reads — so it
// runs fast. Pass 2 is where quality is decided.
export const PASS1_CPU_USED = 4;
export const PASS2_CPU_USED = 1;

export const DENOISE = 'hqdn3d=1.5:1.5:6:6';

export const computePlan = (frames: number, frameRate: number, targetMB: number, cores: number): Plan => {
    const seconds = frames / frameRate;
    const kbps = Math.max(MIN_KBPS, Math.floor(targetMB * 8000 / seconds * SIZE_SAFETY));

    const wanted = Math.floor(seconds / MIN_CHUNK_SECONDS);
    const n = Math.min(Math.max(wanted, 1), Math.max(1, cores));

    const base = Math.floor(frames / n);
    const remainder = frames % n;

    const chunks: Chunk[] = [];
    for (let i = 0; i < n; i++) {
        chunks.push({
            // Leading chunks absorb the remainder one frame each, so the counts
            // sum to `frames` exactly and no seam duplicates or drops a frame.
            startFrame: i * base + Math.min(i, remainder),
            frames: base + (i < remainder ? 1 : 0)
        });
    }

    return { kbps, seconds, chunks };
};

// Size scales near-linearly with bitrate at fixed settings, so a proportional
// correction lands close. Floor rather than round so the retry biases under.
export const correctedKbps = (kbps: number, actualBytes: number, targetBytes: number): number => {
    return Math.max(MIN_KBPS, Math.floor(kbps * targetBytes / actualBytes));
};

export const buildPassArgs = (o: PassArgs): string[] => {
    const args = [
        '-y',
        // Input seek: fast. Frame-exactness comes from -frames:v below, not
        // from this. Duration-based chunking (-t) rounds at the seams.
        '-ss', (o.chunk.startFrame / o.frameRate).toFixed(6),
        '-i', o.master,
        '-c:v', 'libvpx-vp9',
        '-row-mt', '1',
        '-pix_fmt', 'yuv420p',
        '-cpu-used', String(o.cpuUsed),
        '-b:v', `${o.kbps}k`,
        '-vf', DENOISE,
        '-frames:v', String(o.chunk.frames),
        '-an',
        '-pass', String(o.pass),
        '-passlogfile', o.logPrefix,
        // Machine-readable `frame=N` lines on stdout. Parsing the human -stats
        // output on stderr would be locale- and version-fragile.
        '-progress', 'pipe:1',
        '-nostats'
    ];

    // The null muxer writes no bytes, so pass 1's stdout carries only progress.
    return o.pass === 1 ? [...args, '-f', 'null', '-'] : [...args, o.out];
};

export const buildConcatArgs = (listPath: string, outPath: string): string[] => {
    return ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath];
};
```

- [ ] **Step 4: Run test to verify it passes**

Run from `server/`: `npx vitest run test/video-compress-plan.test.ts`
Expected: PASS, 15 tests

- [ ] **Step 5: Commit**

```bash
git add server/src/video-compress-plan.ts server/test/video-compress-plan.test.ts
git commit -m "feat(server): pure planning math for VP9 size-targeted encoding"
```

---

### Task 2: ffmpeg detection and the `video` capability

The dialog's rows appear only when the server reports ffmpeg, so detection must prove VP9 is actually available — an ffmpeg built without libvpx would pass a bare `-version` check and then fail every job.

**Files:**
- Create: `server/src/ffmpeg.ts`
- Modify: `server/src/index.ts:39-44` (probe + capabilities payload)
- Test: `server/test/video-capabilities.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `ffmpegPath(): string`
  - `probeFfmpeg(): Promise<boolean>`
  - `run(args: string[], onStdout?: (chunk: string) => void): { promise: Promise<void>; cancel: () => void }`
  - capabilities JSON gains `video: boolean` and `maxUpload: number`

- [ ] **Step 1: Write the failing test**

Create `server/test/video-capabilities.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';

describe('capabilities', () => {
    it('reports video support and the upload limit', async () => {
        const app = await buildApp();
        const res = await app.inject({ method: 'GET', url: '/api/export/capabilities' });
        expect(res.statusCode).toBe(200);

        const body = res.json();
        // Whether ffmpeg exists depends on the machine; the contract is that
        // the fields are always present and correctly typed, so the dialog can
        // rely on them without a defensive undefined check.
        expect(typeof body.video).toBe('boolean');
        expect(typeof body.maxUpload).toBe('number');
        expect(body.maxUpload).toBeGreaterThan(0);

        await app.close();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `server/`: `npx vitest run test/video-capabilities.test.ts`
Expected: FAIL — `expected "undefined" to be "boolean"`

- [ ] **Step 3: Write minimal implementation**

Create `server/src/ffmpeg.ts`:

```ts
import { spawn } from 'node:child_process';

// The host binary, not an npm package. fluent-ffmpeg would spawn the same
// process; ffmpeg-static ships a binary but is a platform-specific package of
// the kind that has broken this repo's Windows lockfile; ffmpeg.wasm is 10-20x
// slower. FFMPEG_PATH overrides the location.
export const ffmpegPath = (): string => process.env.FFMPEG_PATH ?? 'ffmpeg';

// Spawn ffmpeg with an argv array. Never `shell: true` — paths reach the child
// as discrete tokens, so nothing in a filename can be interpreted as syntax.
export const run = (args: string[], onStdout?: (chunk: string) => void) => {
    const child = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
        // Keep only the tail: a failing encode's stderr is mostly banner noise
        // and the useful error is at the end.
        stderr = (stderr + d.toString()).slice(-4000);
    });
    if (onStdout) {
        child.stdout.on('data', (d: Buffer) => onStdout(d.toString()));
    } else {
        child.stdout.resume();
    }

    const promise = new Promise<void>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
        });
    });

    return { promise, cancel: () => child.kill() };
};

// A bare `-version` check would pass on an ffmpeg built without libvpx and then
// fail every job, so ask for the encoder list and look for the encoder we use.
export const probeFfmpeg = async (): Promise<boolean> => {
    try {
        let out = '';
        const { promise } = run(['-hide_banner', '-encoders'], (chunk) => {
            out += chunk;
        });
        await promise;
        return /\blibvpx-vp9\b/.test(out);
    } catch {
        return false;
    }
};
```

Modify `server/src/index.ts`. Add the import beside the existing ones (do not reorder imports):

```ts
import { probeFfmpeg } from './ffmpeg.js';
```

Then make exactly two edits inside `buildApp`.

**Edit A** — replace lines 20-25:

```ts
export const buildApp = async () => {
    const app = Fastify({ logger: true });
    await app.register(cors, { origin: true });
    await app.register(multipart, {
        limits: { fileSize: Number(process.env.MAX_UPLOAD ?? 1024 * 1024 * 1024) }
    });
```

with (the limit becomes a named const so the same number is both enforced and reported — the dialog blocks oversized masters against it):

```ts
export const buildApp = async () => {
    const maxUpload = Number(process.env.MAX_UPLOAD ?? 1024 * 1024 * 1024);

    const app = Fastify({ logger: true });
    await app.register(cors, { origin: true });
    await app.register(multipart, { limits: { fileSize: maxUpload } });
```

**Edit B** — replace lines 39-44:

```ts
    const { gpu } = await probeGpu();

    app.get('/api/export/capabilities', async () => {
        const formats = ALL_FORMATS.filter(f => gpu || !GPU_FORMATS.has(f));
        return { enabled: true, gpu, formats, publish: s3IsConfigured() };
    });
```

with:

```ts
    const { gpu } = await probeGpu();
    const video = await probeFfmpeg();

    app.get('/api/export/capabilities', async () => {
        const formats = ALL_FORMATS.filter(f => gpu || !GPU_FORMATS.has(f));
        return { enabled: true, gpu, formats, publish: s3IsConfigured(), video, maxUpload };
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run from `server/`: `npx vitest run test/video-capabilities.test.ts`
Expected: PASS

Then confirm nothing else broke: `npx vitest run test/routes.test.ts test/static.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/ffmpeg.ts server/src/index.ts server/test/video-capabilities.test.ts
git commit -m "feat(server): probe ffmpeg/libvpx and report it in export capabilities"
```

---

### Task 3: The compressor

**Files:**
- Create: `server/src/video-compress.ts`
- Test: `server/test/video-compress.test.ts`

**Interfaces:**
- Consumes: `computePlan`, `correctedKbps`, `buildPassArgs`, `buildConcatArgs`, `PASS1_CPU_USED`, `PASS2_CPU_USED` (Task 1); `run` (Task 2); `ProgressEvent` from `./progress.js`
- Produces:
  - `type VideoCompressOptions = { targetMB: number; frameRate: number; frames: number }`
  - `runVideoCompress(masterPath: string, opts: VideoCompressOptions, onProgress: (e: ProgressEvent) => void): { promise: Promise<{ name: string; data: Uint8Array }[]>; cancel: () => void }`

- [ ] **Step 1: Write the failing test**

Create `server/test/video-compress.test.ts`. The integration test is skipped when ffmpeg is absent so the suite stays green on machines without it:

```ts
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeFfmpeg, run } from '../src/ffmpeg.js';
import { runVideoCompress } from '../src/video-compress.js';

const hasFfmpeg = await probeFfmpeg();

describe.skipIf(!hasFfmpeg)('runVideoCompress', () => {
    let dir: string;
    let master: string;

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'ssvc-test-'));
        master = join(dir, 'master.mp4');
        // 3 seconds of moving, noisy 640x360 content at 30fps = 90 frames.
        // Noise matters: a flat synthetic gradient compresses to almost
        // nothing and would pass a size assertion without exercising anything.
        await run([
            '-y', '-f', 'lavfi', '-i', 'mandelbrot=size=640x360:rate=30',
            '-vf', 'noise=alls=20:allf=t+u', '-frames:v', '90',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', master
        ]).promise;
    }, 120000);

    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('produces a webm at or under the target size', async () => {
        const { promise } = runVideoCompress(
            master,
            { targetMB: 0.5, frameRate: 30, frames: 90 },
            () => {}
        );
        const files = await promise;

        expect(files).toHaveLength(1);
        expect(files[0].name).toBe('video.webm');
        expect(files[0].data.byteLength).toBeLessThanOrEqual(0.5 * 1e6);
        expect(files[0].data.byteLength).toBeGreaterThan(1000);
        // WebM/Matroska magic number
        expect(Array.from(files[0].data.slice(0, 4))).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    }, 300000);

    it('reports progress that ends at 1', async () => {
        const values: number[] = [];
        const { promise } = runVideoCompress(
            master,
            { targetMB: 0.5, frameRate: 30, frames: 90 },
            (e) => {
                if (e.kind === 'progress' && e.value !== undefined) values.push(e.value);
            }
        );
        await promise;

        expect(values.length).toBeGreaterThan(0);
        expect(Math.max(...values)).toBeLessThanOrEqual(1);
        expect(values.at(-1)).toBeCloseTo(1, 1);
    }, 300000);

    it('deletes the uploaded master directory when done', async () => {
        // The master must live in its own directory: runVideoCompress removes
        // dirname(masterPath), so pointing it at the shared fixture directory
        // would delete `master` and break the other tests.
        const uploadDir = join(dir, 'upload');
        await mkdir(uploadDir);
        const copy = join(uploadDir, 'master');
        await writeFile(copy, await readFile(master));

        const { promise } = runVideoCompress(
            copy,
            { targetMB: 0.5, frameRate: 30, frames: 90 },
            () => {}
        );
        await promise;

        await expect(stat(uploadDir)).rejects.toThrow();
    }, 300000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `server/`: `npx vitest run test/video-compress.test.ts`
Expected: FAIL — `Failed to resolve import "../src/video-compress.js"` (or the whole describe skipped if ffmpeg is missing, in which case verify by installing ffmpeg or accept the skip and rely on Task 1's coverage plus the manual E2E)

- [ ] **Step 3: Write minimal implementation**

Create `server/src/video-compress.ts`:

```ts
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { run } from './ffmpeg.js';
import type { ProgressEvent } from './progress.js';
import {
    buildConcatArgs,
    buildPassArgs,
    computePlan,
    correctedKbps,
    PASS1_CPU_USED,
    PASS2_CPU_USED,
    type Plan
} from './video-compress-plan.js';

export type VideoCompressOptions = {
    targetMB: number;
    frameRate: number;
    frames: number;
};

// `-progress pipe:1` emits `key=value` lines; we only need the frame counter.
const parseFrame = (chunk: string): number | null => {
    let last: number | null = null;
    for (const line of chunk.split('\n')) {
        const m = /^frame=(\d+)/.exec(line.trim());
        if (m) last = Number(m[1]);
    }
    return last;
};

export const runVideoCompress = (
    masterPath: string,
    opts: VideoCompressOptions,
    onProgress: (e: ProgressEvent) => void
) => {
    let cancelled = false;
    const children: (() => void)[] = [];

    const cancel = () => {
        cancelled = true;
        for (const kill of children) kill();
    };

    const exec = (args: string[], onFrame?: (n: number) => void) => {
        const child = run(args, onFrame && ((chunk) => {
            const n = parseFrame(chunk);
            if (n !== null) onFrame(n);
        }));
        children.push(child.cancel);
        return child.promise;
    };

    const encode = async (dir: string, plan: Plan, kbps: number): Promise<string> => {
        // Two passes over every chunk, so total work is 2 * frames. Each chunk
        // reports its own frame counter; sum them for a single 0..1 value.
        const done = new Array(plan.chunks.length * 2).fill(0);
        const totalWork = opts.frames * 2;
        const report = () => {
            const sum = done.reduce((a, b) => a + b, 0);
            onProgress({
                kind: 'progress',
                message: 'Compressing video',
                value: Math.min(1, sum / totalWork),
                // `loc` is the structured form the editor localizes; `message`
                // is the English fallback and the server log line. Same
                // contract the shared export core already uses.
                loc: { segments: [{ key: 'panel.render.compressing' }] }
            });
        };

        await Promise.all(plan.chunks.map(async (chunk, i) => {
            const logPrefix = join(dir, `p${i}`);
            const out = join(dir, `c${i}.webm`);
            const base = { master: masterPath, chunk, frameRate: opts.frameRate, kbps, logPrefix, out };

            await exec(
                buildPassArgs({ ...base, pass: 1, cpuUsed: PASS1_CPU_USED }),
                (n) => { done[i * 2] = n; report(); }
            );
            if (cancelled) throw new Error('cancelled');
            await exec(
                buildPassArgs({ ...base, pass: 2, cpuUsed: PASS2_CPU_USED }),
                (n) => { done[i * 2 + 1] = n; report(); }
            );
        }));

        // Chunk filenames are server-generated (`c0.webm`, ...), so no quoting
        // or escaping is required in the concat list.
        const listPath = join(dir, 'list.txt');
        const outPath = join(dir, 'out.webm');
        await writeFile(listPath, plan.chunks.map((_, i) => `file 'c${i}.webm'`).join('\n'));
        await exec(buildConcatArgs(listPath, outPath));
        return outPath;
    };

    const promise = (async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ssvc-'));
        try {
            const cores = availableParallelism?.() ?? 4;
            const plan = computePlan(opts.frames, opts.frameRate, opts.targetMB, cores);
            const targetBytes = opts.targetMB * 1e6;

            let outPath = await encode(dir, plan, plan.kbps);
            let size = (await stat(outPath)).size;

            if (size > targetBytes && !cancelled) {
                // Two-pass VP9 usually lands under; this fires rarely. Say so
                // out loud rather than leaving the extra minute unexplained.
                const retryKbps = correctedKbps(plan.kbps, size, targetBytes);
                const actualMB = (size / 1e6).toFixed(2);
                onProgress({
                    kind: 'progress',
                    message: `Over target (${actualMB} MB) — re-encoding at ${retryKbps}k`,
                    value: 0,
                    loc: { segments: [{ key: 'panel.render.compress-retry', params: { size: actualMB, kbps: retryKbps } }] }
                });
                outPath = await encode(dir, plan, retryKbps);
                size = (await stat(outPath)).size;
            }

            return [{ name: 'video.webm', data: new Uint8Array(await readFile(outPath)) }];
        } finally {
            await rm(dir, { recursive: true, force: true });
            // The uploaded master is this job's responsibility once handed over:
            // remove the whole upload directory, not just the file inside it.
            await rm(dirname(masterPath), { recursive: true, force: true });
        }
    })();

    return { promise, cancel };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run from `server/`: `npx vitest run test/video-compress.test.ts`
Expected: PASS, 3 tests (or skipped if ffmpeg is absent)

- [ ] **Step 5: Commit**

```bash
git add server/src/video-compress.ts server/test/video-compress.test.ts
git commit -m "feat(server): chunked two-pass VP9 compressor with overshoot retry"
```

---

### Task 4: Generalize the job queue

`createJob` hardcodes `runExportViaWorker`. Extract the bookkeeping so a video job can share the same queue, SSE stream, TTL, and abandon-cancel behaviour. Splat export behaviour and its public signature are unchanged.

**Files:**
- Modify: `server/src/jobs.ts:57-103`
- Test: `server/test/jobs.test.ts` (extend)

**Interfaces:**
- Consumes: `runVideoCompress`, `VideoCompressOptions` (Task 3)
- Produces: `createVideoJob(masterPath: string, opts: VideoCompressOptions): string`

- [ ] **Step 1: Write the failing test**

Append to `server/test/jobs.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run from `server/`: `npx vitest run test/jobs.test.ts`
Expected: FAIL — `createVideoJob is not a function`

- [ ] **Step 3: Write minimal implementation**

In `server/src/jobs.ts`, add the import beside the existing ones:

```ts
import { runVideoCompress, type VideoCompressOptions } from './video-compress.js';
```

Replace `createJob` (lines 57-103) with an internal `enqueue` plus two thin wrappers. The body is the existing one with `runExportViaWorker(...)` swapped for the injected `run`:

```ts
// What a job actually does. Returning `cancel` alongside the promise lets the
// abandon timer terminate the underlying worker or child process.
type JobRunner = (onProgress: (e: ProgressEvent) => void) => {
    promise: Promise<{ files: { name: string; data: Uint8Array }[] }>;
    cancel: () => void;
};

const enqueue = (run: JobRunner, publish?: PublishDest): string => {
    const id = `job_${randomBytes(16).toString('hex')}`;
    const job: Job = { id, state: 'queued', listeners: [], buffered: [], createdAt: Date.now(), cancelled: false };
    jobs.set(id, job);
    chain = chain.then(async () => {
        if (job.cancelled) {   // abandoned while still queued -> never start
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
    });
};
```

- [ ] **Step 4: Run test to verify it passes**

Run from `server/`: `npx vitest run test/jobs.test.ts test/routes.test.ts test/publish-routes.test.ts`
Expected: PASS — the existing export/publish job tests must still pass unchanged

- [ ] **Step 5: Commit**

```bash
git add server/src/jobs.ts server/test/jobs.test.ts
git commit -m "refactor(server): extract job bookkeeping so video jobs share the queue"
```

---

### Task 5: The `/api/video/compress` route

**Files:**
- Modify: `server/src/index.ts` (add the route after the `/api/export` handler)
- Test: `server/test/video-routes.test.ts`

**Interfaces:**
- Consumes: `createVideoJob` (Task 4)
- Produces: `POST /api/video/compress` → `202 { jobId }`; results served by the existing `GET /api/export/:id/result`

- [ ] **Step 1: Write the failing test**

Create `server/test/video-routes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';

// Minimal multipart body builder — the repo has no multipart test helper and
// this needs only two parts.
const multipart = (options: unknown, master: Buffer) => {
    const b = '----ssvcTestBoundary';
    const head = Buffer.from(
        `--${b}\r\nContent-Disposition: form-data; name="options"\r\n\r\n${JSON.stringify(options)}\r\n` +
        `--${b}\r\nContent-Disposition: form-data; name="master"; filename="m.mp4"\r\n` +
        'Content-Type: video/mp4\r\n\r\n'
    );
    const tail = Buffer.from(`\r\n--${b}--\r\n`);
    return {
        payload: Buffer.concat([head, master, tail]),
        headers: { 'content-type': `multipart/form-data; boundary=${b}` }
    };
};

const post = async (app: any, options: unknown, master = Buffer.from('fake master bytes')) => {
    const { payload, headers } = multipart(options, master);
    return app.inject({ method: 'POST', url: '/api/video/compress', payload, headers });
};

describe('POST /api/video/compress', () => {
    it('accepts a valid request and returns a job id', async () => {
        const app = await buildApp();
        const res = await post(app, { targetMB: 6, frameRate: 30, frames: 1801 });

        expect(res.statusCode).toBe(202);
        expect(res.json().jobId).toMatch(/^job_[0-9a-f]{32}$/);

        await app.close();
    });

    it('rejects a missing master file', async () => {
        const app = await buildApp();
        const b = '----ssvcTestBoundary';
        const res = await app.inject({
            method: 'POST',
            url: '/api/video/compress',
            payload: Buffer.from(
                `--${b}\r\nContent-Disposition: form-data; name="options"\r\n\r\n` +
                `${JSON.stringify({ targetMB: 6, frameRate: 30, frames: 1801 })}\r\n--${b}--\r\n`
            ),
            headers: { 'content-type': `multipart/form-data; boundary=${b}` }
        });

        expect(res.statusCode).toBe(400);
        await app.close();
    });

    it.each([
        ['missing options', undefined],
        ['zero target', { targetMB: 0, frameRate: 30, frames: 1801 }],
        ['negative target', { targetMB: -1, frameRate: 30, frames: 1801 }],
        ['absurd target', { targetMB: 99999, frameRate: 30, frames: 1801 }],
        ['zero frame rate', { targetMB: 6, frameRate: 0, frames: 1801 }],
        ['absurd frame rate', { targetMB: 6, frameRate: 1000, frames: 1801 }],
        ['zero frames', { targetMB: 6, frameRate: 30, frames: 0 }],
        ['absurd frames', { targetMB: 6, frameRate: 30, frames: 9999999 }],
        ['non-numeric target', { targetMB: '6', frameRate: 30, frames: 1801 }]
    ])('rejects %s with 400', async (_label, options) => {
        const app = await buildApp();
        const res = await post(app, options ?? {});

        expect(res.statusCode).toBe(400);
        await app.close();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `server/`: `npx vitest run test/video-routes.test.ts`
Expected: FAIL — 404 instead of 202/400

- [ ] **Step 3: Write minimal implementation**

In `server/src/index.ts`, add imports beside the existing ones:

```ts
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createVideoJob } from './jobs.js';
```

(`createJob` is already imported from `./jobs.js` at `:11` — add `createVideoJob` to that existing import rather than writing a second import line.)

Add the route immediately after the `/api/export` handler:

```ts
    app.post('/api/video/compress', async (req, reply) => {
        // The master is 150 MB+, so it streams to disk. The splat routes use
        // part.toBuffer() because their gzipped PLYs are far smaller; doing
        // that here would hold the whole video in memory.
        const dir = await mkdtemp(join(tmpdir(), 'ssvc-up-'));
        let masterPath: string | null = null;
        let options: any = null;

        const fail = async (code: number, error: string) => {
            await rm(dir, { recursive: true, force: true });
            return reply.code(code).send({ error });
        };

        try {
            for await (const part of req.parts()) {
                if (part.type === 'file' && part.fieldname === 'master') {
                    masterPath = join(dir, 'master');
                    await pipeline(part.file, createWriteStream(masterPath));
                } else if (part.type === 'field' && part.fieldname === 'options') {
                    try {
                        options = JSON.parse(part.value as string);
                    } catch {
                        return fail(400, 'options is not valid JSON');
                    }
                }
            }
        } catch (err: any) {
            return fail(400, `upload failed: ${err?.message ?? err}`);
        }

        if (!masterPath) return fail(400, 'missing master file');
        if (!options) return fail(400, 'missing options');

        const { targetMB, frameRate, frames } = options;
        const finite = (v: unknown, lo: number, hi: number) =>
            typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

        if (!finite(targetMB, 0.05, 2000)) return fail(400, 'targetMB must be a number between 0.05 and 2000');
        if (!finite(frameRate, 1, 240)) return fail(400, 'frameRate must be a number between 1 and 240');
        if (!finite(frames, 1, 200000) || !Number.isInteger(frames)) return fail(400, 'frames must be an integer between 1 and 200000');

        // The job owns the temp directory from here and removes it when done.
        const id = createVideoJob(masterPath, { targetMB, frameRate, frames });
        return reply.code(202).send({ jobId: id });
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run from `server/`: `npx vitest run test/video-routes.test.ts`
Expected: PASS, 11 tests

Then the whole server suite: `npm test` from `server/`
Expected: PASS (GPU-gated tests may skip)

- [ ] **Step 5: Commit**

```bash
git add server/src/index.ts server/test/video-routes.test.ts
git commit -m "feat(server): POST /api/video/compress streams the master and queues a job"
```

---

### Task 6: Browser client

**Files:**
- Modify: `src/export-server-client.ts:1` (Capabilities type), and append `runVideoCompress`

**Interfaces:**
- Consumes: the route from Task 5
- Produces: `runVideoCompress(master: Blob, options: { targetMB: number; frameRate: number; frames: number }, onProgress: (p: ServerProgress) => void, signal?: AbortSignal): Promise<Blob>`; `Capabilities` gains `video?: boolean` and `maxUpload?: number`

- [ ] **Step 1: Extend the Capabilities type**

Replace `src/export-server-client.ts:1`:

```ts
type Capabilities = { enabled: boolean; gpu: boolean; formats: string[]; publish?: boolean; video?: boolean; maxUpload?: number };
```

- [ ] **Step 2: Add the client function**

Append to `src/export-server-client.ts`:

```ts
export type VideoCompressOptions = {
    targetMB: number;
    frameRate: number;
    frames: number;
};

// POST the rendered master, follow SSE, then fetch the compressed result.
// Reuses the export job's event and result routes verbatim — only the start
// endpoint differs.
export const runVideoCompress = async (
    master: Blob,
    options: VideoCompressOptions,
    onProgress: (p: ServerProgress) => void,
    signal?: AbortSignal
): Promise<Blob> => {
    const form = new FormData();
    // options first so the server has them before the (large) file streams in
    form.append('options', JSON.stringify(options));
    form.append('master', master, 'master.bin');

    const startRes = await fetch(`${location.origin}/api/video/compress`, { method: 'POST', body: form, signal });
    if (!startRes.ok) throw new Error(`video compression failed to start (${startRes.status})`);
    const { jobId } = await startRes.json();
    if (!jobId) throw new Error('server did not return a job id');

    await new Promise<void>((resolve, reject) => {
        const es = new EventSource(`${location.origin}/api/export/${jobId}/events`);
        // Closing the stream is the cancel mechanism: the server's abandon
        // timer kills the job when its last subscriber disappears.
        const abort = () => {
            es.close();
            reject(new Error('cancelled'));
        };
        signal?.addEventListener('abort', abort, { once: true });

        es.onmessage = (ev) => {
            let e;
            try {
                e = JSON.parse(ev.data);
            } catch (err) {
                es.close();
                reject(new Error(`unexpected SSE data: ${ev.data}`));
                return;
            }
            if (e.kind === 'progress') {
                onProgress({ message: e.message, value: e.value, loc: e.loc });
            } else if (e.kind === 'done') {
                es.close();
                resolve();
            } else if (e.kind === 'error') {
                es.close();
                reject(new Error(e.message));
            }
        };
        es.onerror = () => {
            es.close();
            reject(new Error('progress stream error'));
        };
    });

    const resultRes = await fetch(`${location.origin}/api/export/${jobId}/result`);
    if (!resultRes.ok) throw new Error(`compressed video unavailable (${resultRes.status})`);
    return resultRes.blob();
};
```

- [ ] **Step 3: Verify it compiles and lints**

Run from the repo root: `npm run lint`
Expected: exit 0, no errors in `src/export-server-client.ts`

- [ ] **Step 4: Commit**

```bash
git add src/export-server-client.ts
git commit -m "feat(video): client for the server video compression endpoint"
```

---

### Task 7: Dialog UI

**Files:**
- Modify: `src/video-config.ts:3-16` (add `compress` to `VideoSettings`)
- Modify: `src/ui/video-settings-dialog.ts` (imports, two rows, hint, validation, `onOK`)
- Modify: `static/locales/en.json`

**Interfaces:**
- Consumes: `probeExportCapabilities` (existing), `Capabilities.video`/`maxUpload` (Task 6)
- Produces: `VideoSettings.compress?: { targetMB: number; frames: number }`

- [ ] **Step 1: Add the settings field**

In `src/video-config.ts`, add to the `VideoSettings` type after `levelHorizon`:

```ts
    // Present only when the user ticked Compress. `frames` is the exact output
    // frame count, computed here so editor.ts and the server never re-derive
    // (and never disagree with) render.ts:734.
    compress?: { targetMB: number; frames: number };
```

- [ ] **Step 2: Add the imports**

In `src/ui/video-settings-dialog.ts`, extend the existing PCUI import at `:1` to include `NumericInput`, and add the client import beside the existing `../` imports (do not reorder):

```ts
import { BooleanInput, Button, Container, Element, Label, NumericInput, SelectInput, VectorInput } from '@playcanvas/pcui';
```

```ts
import { probeExportCapabilities } from '../export-server-client';
```

- [ ] **Step 3: Add the rows**

Insert after the `showDebugRow` block (after `:351`), before `syncProjection`:

```ts
        // compression (server-side, only when the export server reports ffmpeg)

        const compressLabel = new Label({ class: 'label' });
        i18n.bindText(compressLabel, 'popup.render-video.compress');
        const compressBoolean = new BooleanInput({ class: 'boolean', value: false });
        const compressRow = new Container({ class: 'row', hidden: true });
        compressRow.append(compressLabel);
        compressRow.append(compressBoolean);

        const targetSizeLabel = new Label({ class: 'label' });
        i18n.bindText(targetSizeLabel, 'popup.render-video.target-size');
        const targetSizeInput = new NumericInput({
            class: 'select',
            value: 6,
            min: 0.1,
            precision: 1
        });
        const targetSizeRow = new Container({ class: 'row', hidden: true });
        targetSizeRow.append(targetSizeLabel);
        targetSizeRow.append(targetSizeInput);

        // Reuses the compatibility message's styling, which already carries the
        // `warning` and `error` modifiers this needs (settings-dialog.scss:103).
        // That rule's `display: block` is id-scoped (`#dialog #content`) and so
        // out-specifies pcui's `.pcui-element.pcui-hidden`, which means `hidden`
        // cannot hide this label — drive `display` directly instead.
        const compressHint = new Label({
            class: 'video-compatibility-message'
        });
        const setCompressHintVisible = (visible: boolean) => {
            compressHint.dom.style.display = visible ? '' : 'none';
        };
        setCompressHintVisible(false);
```

Append them to `content` alongside the other rows (after the `content.append(showDebugRow);` line at `:377`):

```ts
        content.append(compressRow);
        content.append(targetSizeRow);
        content.append(compressHint);
```

- [ ] **Step 4: Add the hint arithmetic and validation**

Insert after `encodingSettingsFor` (after `:444`):

```ts
        // Server-reported ffmpeg support and upload ceiling; defaults until probed.
        let compressAvailable = false;
        let maxUpload = Infinity;
        // Set by updateCompressUI, read by updateCompatibilityUI. Kept as a
        // variable rather than read back from the hint's CSS classes so the
        // button state never depends on styling.
        let compressBlocked = false;

        // Exact output frame count. Same formula as render.ts:734 so the two can
        // never disagree — note `duration` uses the TIMELINE rate while the
        // clip's real length uses the EXPORT rate, and only the latter is what
        // ffmpeg sees.
        const outputFrames = () => {
            const range = frameRangeInput.value as number[];
            const animFrameRate = events.invoke('timeline.frameRate');
            const frameRate = frameRates[frameRateSelect.value];
            const duration = (range[1] - range[0]) / animFrameRate;
            return Math.floor(duration * frameRate) + 1;
        };

        const updateCompressUI = () => {
            const on = compressAvailable && compressBoolean.value;
            targetSizeRow.hidden = !on;
            setCompressHintVisible(on);
            compressBlocked = false;
            if (!on) {
                compressHint.class.remove('warning', 'error');
                return;
            }

            if (targetSizeInput.value <= 0) {
                compressBlocked = true;
            }

            const frames = outputFrames();
            const frameRate = frameRates[frameRateSelect.value];
            const seconds = frames / frameRate;
            const targetMB = targetSizeInput.value;
            const kbps = Math.floor(targetMB * 8000 / seconds * 0.97);

            const { bitrate } = encodingSettingsFor(resolutionSelect.value);
            const uploadMB = bitrate / 8e6 * seconds;

            compressHint.text = i18n.t('popup.render-video.compress-hint', {
                codec: codecNames[codecSelect.value as VideoCodecChoice],
                bitrate: i18n.t(`popup.render-video.bitrate-value.${bitrateSelect.value}`),
                upload: Math.round(uploadMB),
                kbps
            });
            compressHint.class.remove('warning', 'error');

            if (uploadMB * 1e6 > maxUpload) {
                // Catch this now: discovering it after a multi-minute render
                // wastes the whole render.
                compressHint.text = i18n.t('popup.render-video.compress-too-large', {
                    upload: Math.round(uploadMB),
                    limit: Math.round(maxUpload / 1e6)
                });
                compressHint.class.add('error');
                compressBlocked = true;
            } else if (kbps < 200) {
                compressHint.text += ` ${i18n.t('popup.render-video.compress-low-bitrate')}`;
                compressHint.class.add('warning');
            }
        };
```

Extend `updateCompatibilityUI` so the OK button also respects the compress state. Replace the final `okButton.disabled = !selectedSupported;` assignment at `:526` with:

```ts
            okButton.disabled = !selectedSupported || compressBlocked;
```

and call `updateCompressUI()` at the top of `updateCompatibilityUI` (immediately after `const options = activeResolutionOptions();`) so the hint is fresh before the button state is derived from it.

- [ ] **Step 5: Wire the change handlers**

Add beside the existing handlers (after `:646`):

```ts
        compressBoolean.on('change', updateCompatibilityUI);
        targetSizeInput.on('change', updateCompatibilityUI);
        frameRangeInput.on('change', updateCompatibilityUI);
```

- [ ] **Step 6: Probe on show**

In `this.show()` at `:676`, after `refreshEncoderSupport();`, add:

```ts
            // Cached after the first call, so this is cheap on reopen.
            probeExportCapabilities().then((caps) => {
                compressAvailable = !!caps?.video;
                maxUpload = caps?.maxUpload ?? Infinity;
                compressRow.hidden = !compressAvailable;
                updateCompatibilityUI();
            });
```

In `this.hide()` at `:717`, reset the transient state:

```ts
            compressHint.class.remove('warning', 'error');
```

- [ ] **Step 7: Return the field**

In `onOK` at `:698`, add to the `videoSettings` object literal after `levelHorizon`:

```ts
                        ...(compressAvailable && compressBoolean.value ? {
                            compress: { targetMB: targetSizeInput.value, frames: outputFrames() }
                        } : {})
```

- [ ] **Step 8: Add the English strings**

In `static/locales/en.json`, after `"popup.render-video.show-debug-overlays"`:

```json
    "popup.render-video.compress": "Compress",
    "popup.render-video.target-size": "Target Size (MB)",
    "popup.render-video.compress-hint": "Master {{codec}} {{bitrate}}, ~{{upload}} MB upload · output WebM/VP9, ≈{{kbps}} kbps",
    "popup.render-video.compress-low-bitrate": "Quality will be poor at this size — raise the target or shorten the clip.",
    "popup.render-video.compress-too-large": "The master would be ~{{upload}} MB, above the export server's {{limit}} MB upload limit. Lower the resolution or bitrate.",
```

And after `"panel.render.failed"`:

```json
    "panel.render.compressing": "Compressing Video",
    "panel.render.compress-retry": "Over target ({{size}} MB) — re-encoding at {{kbps}} kbps",
```

- [ ] **Step 9: Verify**

Run from the repo root: `npm run lint`
Expected: exit 0

Run: `npm run build` then check for type errors — Rollup reports TypeScript problems as **warnings and still exits 0**, so the exit code proves nothing:

```bash
npm run build 2>&1 | tee /tmp/build.log; grep -c "plugin typescript" /tmp/build.log
```

Expected: `0`

- [ ] **Step 10: Commit**

```bash
git add src/video-config.ts src/ui/video-settings-dialog.ts static/locales/en.json
git commit -m "feat(video): compress checkbox and target size in the render dialog"
```

---

### Task 8: The save path

**Files:**
- Modify: `src/ui/editor.ts:304-383`

**Interfaces:**
- Consumes: `VideoSettings.compress` (Task 7), `runVideoCompress` (Task 6)
- Produces: nothing downstream

- [ ] **Step 1: Add the imports and download helper**

In `src/ui/editor.ts`, add beside the existing `../` imports (do not reorder):

```ts
import { runVideoCompress } from '../export-server-client';
```

Add near the top of the module, beside other file-scope helpers:

```ts
// render.ts has an identical private helper; it is not exported, and that file
// is upstream-owned so it must not be modified to export one.
const downloadBlob = (blob: Blob, filename: string) => {
    const url = window.URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.download = filename;
    el.href = url;
    el.click();
    window.URL.revokeObjectURL(url);
};
```

- [ ] **Step 2: Force the picker to WebM when compressing**

In `show.videoSettingsDialog`, immediately after the `codecName` const at `:321`, insert:

```ts
                    const compress = videoSettings.compress;
```

Then wrap the existing extension/type selection so compression overrides it — replace the `if (videoSettings.format === 'webm') { ... } else { ... }` chain at `:323-347` by adding this branch first:

```ts
                    if (compress) {
                        // The saved file is always the compressed WebM; the
                        // format/codec selects describe the master instead.
                        fileExtension = '.webm';
                        filePickerTypes = [{
                            description: 'WebM Video (VP9)',
                            accept: { 'video/webm': ['.webm'] }
                        }];
                    } else if (videoSettings.format === 'webm') {
```

(the remaining `else if` / `else` branches are unchanged)

- [ ] **Step 3: Do not create the writable up front when compressing**

Replace `:354-362`:

```ts
                    if (window.showSaveFilePicker) {
                        fileHandle = await window.showSaveFilePicker({
                            id: 'SuperSplatVideoFileExport',
                            types: filePickerTypes,
                            suggestedName: suggested
                        });

                        writable = await fileHandle.createWritable();
                    }
```

with:

```ts
                    if (window.showSaveFilePicker) {
                        fileHandle = await window.showSaveFilePicker({
                            id: 'SuperSplatVideoFileExport',
                            types: filePickerTypes,
                            suggestedName: suggested
                        });

                        // When compressing, the writable is created only once
                        // the compressed bytes exist, so no write lock is held
                        // across a multi-minute job. showSaveFilePicker itself
                        // must still run here: it needs transient user
                        // activation, which has long expired by the time the
                        // job finishes.
                        if (!compress) {
                            writable = await fileHandle.createWritable();
                        }
                    }
```

- [ ] **Step 4: Add the compress branch**

Replace `:364-369`:

```ts
                    const result = await events.invoke('render.video', videoSettings, writable);

                    // if the render was cancelled, remove the empty file left on disk
                    if (result === false && fileHandle?.remove) {
                        await fileHandle.remove();
                    }
```

with:

```ts
                    if (!compress) {
                        const result = await events.invoke('render.video', videoSettings, writable);

                        // if the render was cancelled, remove the empty file left on disk
                        if (result === false && fileHandle?.remove) {
                            await fileHandle.remove();
                        }
                        return;
                    }

                    // Compression path: render the master into an OPFS temp
                    // file rather than the user's file. render.video accepts
                    // any FileSystemWritableFileStream, so the master streams
                    // to disk through the existing code path and src/render.ts
                    // stays untouched.
                    const opfs = await navigator.storage.getDirectory();
                    const tempName = `video-master-${Date.now()}`;
                    const tempHandle = await opfs.getFileHandle(tempName, { create: true });

                    try {
                        const tempWritable = await tempHandle.createWritable();
                        const rendered = await events.invoke('render.video', videoSettings, tempWritable);
                        if (rendered === false) {
                            if (fileHandle?.remove) {
                                await fileHandle.remove();
                            }
                            return;
                        }

                        const master = await tempHandle.getFile();

                        const controller = new AbortController();
                        events.fire('progressStart', i18n.t('panel.render.compressing'), true);
                        const cancelHandler = events.on('progressCancel', () => controller.abort());

                        let output: Blob;
                        try {
                            output = await runVideoCompress(master, {
                                targetMB: compress.targetMB,
                                frameRate: videoSettings.frameRate,
                                frames: compress.frames
                            }, (p) => {
                                events.fire('progressUpdate', { text: p.message, progress: p.value, loc: p.loc });
                            }, controller.signal);
                        } catch (error) {
                            if (controller.signal.aborted) {
                                if (fileHandle?.remove) {
                                    await fileHandle.remove();
                                }
                                return;
                            }
                            throw error;
                        } finally {
                            cancelHandler.off();
                            events.fire('progressEnd');
                        }

                        if (fileHandle) {
                            const out = await fileHandle.createWritable();
                            await out.write(await output.arrayBuffer());
                            await out.close();
                        } else {
                            // No file picker (Brave disables the File System
                            // Access API by default; Firefox has none), so the
                            // browser's own download dialog handles it.
                            downloadBlob(output, suggested);
                        }
                    } finally {
                        await opfs.removeEntry(tempName).catch(() => {});
                    }
```

- [ ] **Step 5: Verify**

Run from the repo root: `npm run lint`
Expected: exit 0

```bash
npm run build 2>&1 | tee /tmp/build.log; grep -c "plugin typescript" /tmp/build.log
```

Expected: `0`

- [ ] **Step 6: Commit**

```bash
git add src/ui/editor.ts
git commit -m "feat(video): render the master to OPFS and compress it on the server"
```

---

### Task 9: Remaining locales and full verification

**Files:**
- Modify: `static/locales/de.json`, `es.json`, `fr.json`, `ja.json`, `ko.json`, `pt-BR.json`, `ru.json`, `zh-CN.json`

- [ ] **Step 1: Add the seven keys to each of the eight locales**

Each file gets the same seven keys added at the same positions as in `en.json` (five after `popup.render-video.show-debug-overlays`, two after `panel.render.failed`). Keep the `{{codec}}`, `{{bitrate}}`, `{{upload}}`, `{{kbps}}`, `{{limit}}` and `{{size}}` placeholders and the literal `WebM/VP9` verbatim.

French, as the reference for tone (the others follow the same pattern in their own language):

```json
    "popup.render-video.compress": "Compresser",
    "popup.render-video.target-size": "Taille cible (Mo)",
    "popup.render-video.compress-hint": "Master {{codec}} {{bitrate}}, ~{{upload}} Mo à envoyer · sortie WebM/VP9, ≈{{kbps}} kbps",
    "popup.render-video.compress-low-bitrate": "La qualité sera médiocre à cette taille — augmentez la cible ou raccourcissez le clip.",
    "popup.render-video.compress-too-large": "Le master ferait ~{{upload}} Mo, au-delà de la limite d'envoi de {{limit}} Mo du serveur d'export. Réduisez la résolution ou le débit.",
```

```json
    "panel.render.compressing": "Compression de la vidéo",
    "panel.render.compress-retry": "Au-dessus de la cible ({{size}} Mo) — réencodage à {{kbps}} kbps",
```

Mark these as **pending review** in the hand-off memo, per the convention used for previous machine-assisted translation batches.

- [ ] **Step 2: Verify every locale is valid JSON with matching keys**

```bash
for f in static/locales/*.json; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" || echo "BAD $f"; done
node -e "
const fs=require('fs');
const en=Object.keys(JSON.parse(fs.readFileSync('static/locales/en.json','utf8')));
for (const f of fs.readdirSync('static/locales')) {
  const k=new Set(Object.keys(JSON.parse(fs.readFileSync('static/locales/'+f,'utf8'))));
  const missing=en.filter(x=>!k.has(x));
  if (missing.length) console.log(f, 'missing', missing.length, missing.slice(0,8));
}"
```

Expected: no `BAD` lines; no locale missing any of the seven new keys.

- [ ] **Step 3: Run every gate**

```bash
npm run lint
npm run test
npm run build 2>&1 | tee /tmp/build.log; grep -c "plugin typescript" /tmp/build.log
npm test --prefix server
```

Expected: lint exit 0; front-end tests pass; `plugin typescript` count `0`; server tests pass.

- [ ] **Step 4: Commit**

```bash
git add static/locales
git commit -m "feat(video): localize the compression controls"
```

- [ ] **Step 5: Manual E2E**

Nothing above proves output *quality*; automated tests cover frame counts, byte budgets and argv shapes only. Run the server with `npm run dev` from `server/` (it serves the repo-root `dist/`, so the app and the API share an origin) and work through this list at **http://localhost:3334**:

1. Rows appear only with ffmpeg present. Stop the server, set `FFMPEG_PATH=/nonexistent`, restart → the Compress row is absent. Restore.
2. 1080p30, High, Compress + 6 MB on a ~60s scene → the saved file is under 6 MB and plays.
3. **Quality gate:** compare that file side-by-side against `encode-web-video.sh -s 6 -c vp9 -p 1` run on the same master. They should be indistinguishable. This is the acceptance criterion for the whole feature.
4. Target 1 MB → the retry fires; the progress line names the corrected bitrate and the final file is under 1 MB.
5. Cancel during compression → the editor returns to idle, no file is written, and the server logs the job ending. Confirm no `ssvc-*` directories are left in the OS temp directory.
6. Set the resolution to 4K + Ultra → the hint turns red and OK is disabled before any render starts.
7. On Brave (no file picker): the browser's download dialog appears at 100% on the finished small file.
8. Uncheck Compress → a normal export behaves exactly as before, with the picker up front.
