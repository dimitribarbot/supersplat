# Server-side Export (download) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Export on server" option to the export modal that ships browser-prepared scene data to a new self-hosted Node + Fastify server, which runs the `@playcanvas/splat-transform` writers on the host GPU and streams the resulting file back for download, with live progress over SSE.

**Architecture:** The client keeps the quality-critical preparation (`extractDataTable`: gaussian filtering, SH-band truncation, `Transform.PLY` tagging) and serializes to an in-memory uncompressed float32 PLY, which it gzips and POSTs. A new Fastify server in `server/` reads that PLY back into a `DataTable` and runs the same writers (SOG / viewer / compressed-PLY) on the host GPU via the library-exported `createDevice`, streaming progress over SSE and the result back for download. The GPU writer orchestration is extracted from `src/splat-serialize.ts` into a shared, environment-agnostic module (`src/splat-export-core.ts`) imported by both browser and server.

**Tech Stack:** TypeScript, Fastify, `@playcanvas/splat-transform`, `webgpu` (Dawn), `playcanvas`, rollup (existing client build), the existing client `Events` bus and PCUI export modal.

---

## ✅ STATUS — COMPLETE & MERGED (updated 2026-05-30)

This feature is fully implemented, tested, and **merged to `main` as a single squashed
commit `fd8002b` ("feat: server-side export (download)")**. The `feature/server-side-export`
branch has been deleted. Nothing was pushed — `main` is ahead of `origin/main` locally.

**Task status:**
- Tasks 0–4 and 6–13: DONE (implemented, reviewed, committed, then squashed into `fd8002b`).
- Task 5 (`BufferReadFileSystem`): **SKIPPED** — superseded by the library's `MemoryReadFileSystem`.
- Task 14 (final pass): DONE — see verification below. Share-strategy decision: **keep
  `dist-shared/`** (not promoted to an npm workspace package).

**Verified by automated gates (all green):**
- `npm run lint` (root) — clean.
- `npm run build` (root) and `( cd server && npm run build )` — clean.
- `npm test` (root) — 11/11. `( cd server && npx vitest run )` — 9/9, including a REAL GPU
  SOG export on the RTX 4090 and the `compressedPly` server-vs-direct byte-identical parity
  test. Re-run on merged `main` — still green.
- Whole-branch review passed: all six integration seams (client↔server wire contract, SSE
  contract, parity settings, refactor safety, result delivery, plan completeness) verified OK.

**NOT yet done — pick up here in a new session:**
1. **Manual browser end-to-end** (the only unverified path). Start the server
   (`( cd server && npm run dev )`) and the app (`npm run develop`), import a small splat, and
   with the "Export on server" toggle ON export compressedPly, SOG, HTML viewer, and streaming
   ZIP; confirm each downloads a valid file that re-imports identically to a local export.
   Toggle OFF, and `.splat`/plain `.ply` (toggle hidden), must still use the local path.
2. **Translations** — `popup.export.use-server` uses the English string as a placeholder in
   every non-English `static/locales/*.json`; a real translation pass is pending.
3. **Feature B (future, separate spec)** — publish to a private DigitalOcean Space, reusing
   this same engine with an S3 upload as the terminal sink instead of a download.

**Known intentional limitation:** server-routed SOG/viewer exports show a spinner (not a
determinate progress bar) because the server emits only `done`/`error` over SSE. The
`SseProgressSink` (`server/src/progress.ts`) is the wired extension point if granular
server-side progress is added later (e.g. with Feature B).

See also the session handoff `2026-05-30-server-side-export-RESUME.md` for the hard-won
architecture facts and process rules (device init, `dist-shared/` loading, SSE TDZ note, etc.).

---

## Spec

Implements `docs/superpowers/specs/2026-05-30-server-side-export-design.md` (approved). Read it first.

## Verified library facts (rely on these; re-confirm only if the dep version changes)

- `@playcanvas/splat-transform@2.4.0` re-exports `createDevice: (adapterName?: string) => Promise<GraphicsDevice>` from `./cli/node-device` (present in `dist/index.mjs`). The server imports this; it does NOT hand-roll a headless device. Internally it uses the `webgpu` (Dawn) package.
- Library writer signatures (all `(options, fs: FileSystem) => Promise<void>`):
  - `writeSog({ filename, dataTable, indices?, bundle, iterations, createDevice?, logging? })` — GPU
  - `writeHtml({ filename, dataTable, viewerSettingsJson?, bundle, iterations, createDevice? })` — GPU
  - `writeLod({ filename, dataTable, envDataTable, iterations, createDevice?, chunkCount, chunkExtent })` — GPU
  - `writeCompressedPly({ filename, dataTable })` — CPU only
  - `writePly` IS exported but takes `{ filename, plyData: PlyData }` (an internal reader type), NOT a DataTable — calling it with a DataTable throws at runtime. To write a DataTable to PLY (test fixtures only) use `writeFile({ filename, outputFormat: 'ply', dataTable, options: {} })` (VERIFIED). `writeSplat` is NOT exported (the client's `serializeSplat` is hand-rolled).
- `readFile({ filename, inputFormat, options, params, fileSystem })` returns `DataTable[]` (mirror `src/io/read/loader.ts`).
- `FileSystem.createWriter(filename) => Writer | Promise<Writer>`; `Writer.write(Uint8Array)`, `Writer.close()`. `MemoryFileSystem` exposes `.results: Map<string, Uint8Array>`. `ZipFileSystem(writer)` zips entries.
- Read-side FS interface: `ReadFileSystem` with `createSource(filename) => ReadSource`; `ReadSource.read(start,end) => ReadStream` (mirror `BlobReadSource`/`BlobReadStream` in `src/io/read/file-systems.ts`, backed by a Node `Buffer`).
- The import loader applies `sortMortonOrder` AFTER `readFile`. The server export path must NOT reorder (SOG k-means seeding parity).

## File Structure

**Client (existing `src/`):**
- `src/splat-export-core.ts` — NEW. Environment-agnostic writer orchestration extracted from `splat-serialize.ts` (`buildStreamingLodTable`, `serializeStreamingViewer` body, SOG/viewer writer bodies, LOD constants, `createProgressRenderer`). Parameterized by `(createDevice, FileSystem, progressSink)`.
- `src/splat-serialize.ts` — MODIFY. Keeps `extractDataTable`, `serializePly`, `serializePlyCompressed`, `serializeSplat`, `serializeViewerSettings`, `createGpuDevice`; its `serializeSog`/`serializeViewer` become thin wrappers calling `splat-export-core` with the browser device/fs/progress. Exports unchanged.
- `src/export-server-client.ts` — NEW. `probeExportCapabilities()` (cached) and `runServerExport(plyGz, options, onProgress)` (POST → SSE → result).
- `src/file-handler.ts` — MODIFY. Probe at init; route `scene.write` through the server path when the toggle is on and the format is server-eligible.
- `src/ui/export-popup.ts` — MODIFY. Add "Export on server" row (default on when available); include `useServer` in `SceneExportOptions`.
- `static/locales/en.json` (+ sibling locales) — MODIFY. Add the row label string.

**Server (NEW `server/`):**
- `server/package.json`, `server/tsconfig.json`
- `server/src/index.ts` — Fastify bootstrap, routes, CORS.
- `server/src/gpu.ts` — cached `createDevice` probe (`{ gpu: boolean }`).
- `server/src/read-fs.ts` — `BufferReadFileSystem` (Node-buffer mirror of the browser blob read FS).
- `server/src/jobs.ts` — in-memory job map, TTL cleanup, concurrency-1 GPU queue.
- `server/src/run-export.ts` — per-job worker: gunzip → readFile → re-tag → dispatch writer → store result.
- `server/src/progress.ts` — SSE progress sink implementing the library `Renderer`.
- `server/spikes/roundtrip.mjs` — Phase 0 spike, DELETED before merge.
- `server/test/*.test.ts` — server tests.
- `server/README.md` — run + reverse-proxy docs.

**Shared types:** the wire `options` is the existing `SceneExportOptions` plus `fileType: FileType`. Both already live in `src/file-handler.ts`; the server re-declares a minimal matching type in `server/src/run-export.ts` (no cross-package import to avoid coupling the client build to the server).

---

## Task 0: Phase 0 — round-trip parity spike (throwaway)

Confirms the two correctness assumptions the whole design rests on before building. Produces no shipping code.

**Files:**
- Create: `server/spikes/roundtrip.mjs` (deleted at end of task)

- [ ] **Step 1: Install splat-transform at repo root is already present; write the spike**

Create `server/spikes/roundtrip.mjs`:

```js
// Throwaway spike: verify (1) float columns survive an uncompressed-PLY
// round-trip bit-exact, and (2) whether the Transform.PLY tag survives.
import { Column, DataTable, Transform, writePly, readFile, MemoryFileSystem } from '@playcanvas/splat-transform';

// minimal ReadFileSystem over a Buffer
class BufSource {
  constructor(buf) { this.size = buf.length; this.seekable = true; this._b = buf; }
  read(start = 0, end = this.size) {
    const b = this._b.subarray(start, end); let off = 0;
    return { bytesRead: 0, totalBytes: b.length,
      async pull(t) { const n = Math.min(t.length, b.length - off); t.set(b.subarray(off, off + n)); off += n; this.bytesRead += n; return n; },
      close() {} };
  }
  close() {}
}
class BufFS { constructor(name, buf){ this.name = name; this.buf = buf; } async createSource(){ return new BufSource(this.buf); } }

const N = 5;
const names = ['x','y','z','scale_0','f_dc_0','opacity','rot_0'];
const cols = names.map((n,i) => new Column(n, Float32Array.from({length:N}, (_,r)=> (i+1)*1.123 + r*0.001)));
const src = new DataTable(cols, Transform.PLY);

const memFs = new MemoryFileSystem();
await writePly({ filename: 'rt.ply', dataTable: src }, memFs);
const plyBytes = memFs.results.get('rt.ply');

const tables = await readFile({ filename: 'rt.ply', inputFormat: 'ply', options: { iterations:10, lodSelect:[0], unbundled:false, lodChunkCount:512, lodChunkExtent:16 }, params: [], fileSystem: new BufFS('rt.ply', Buffer.from(plyBytes)) });
const back = tables[0];

let exact = true;
for (const n of names) {
  const a = src.columns.find(c=>c.name===n).data, b = back.columns.find(c=>c.name===n)?.data;
  if (!b) { exact = false; break; }
  for (let r=0;r<N;r++) if (a[r] !== b[r]) { exact = false; break; }
}
console.log('float columns bit-exact:', exact);
console.log('src.transform:', src.transform, 'back.transform:', back.transform, 'tag survived:', back.transform === Transform.PLY);
```

- [ ] **Step 2: Run the spike**

Run: `node server/spikes/roundtrip.mjs`
Expected: `float columns bit-exact: true`. Record whether `tag survived` is true or false.

- [ ] **Step 3: Record the finding**

**RESULT (recorded during execution): float columns bit-exact = true; tag survived = true** (compared via `back.transform.equals(Transform.PLY)`). The server re-tags the readback table with `Transform.PLY` unconditionally anyway (Tasks 7 and 9), which is correct regardless. Spike also revealed: `writePly` does NOT take a DataTable — fixtures use `writeFile({outputFormat:'ply', dataTable, options:{}})`; and the library provides `MemoryReadFileSystem` (`.set`/`.createSource`), so the hand-rolled buffer FS (Task 5) is superseded.

- [ ] **Step 4: Delete the spike and commit the finding**

```bash
rm -rf server/spikes
git add docs/superpowers/plans/2026-05-30-server-side-export.md
git commit -m "chore: record PLY round-trip parity spike finding"
```

---

## Task 1: Extract `createProgressRenderer` + LOD helpers into `splat-export-core.ts`

First slice of the refactor: move the pure, device-free helpers. No behavior change.

**Files:**
- Create: `src/splat-export-core.ts`
- Modify: `src/splat-serialize.ts` (remove moved code, import it back)

- [ ] **Step 1: Create the new module with the moved helpers**

Create `src/splat-export-core.ts`. Move VERBATIM from `splat-serialize.ts`: `createProgressRenderer` (currently ~line 1242), the LOD constants `MAX_LOD_LEVELS`/`LOD_DECIMATION_FACTOR`/`MIN_LOD_SPLATS` (~1318), and `buildStreamingLodTable` (~1328). Add the imports they need:

```ts
import {
    Column,
    combine,
    DataTable,
    logger as splatTransformLogger,
    simplifyGaussians,
    type LogEvent,
    type Renderer
} from '@playcanvas/splat-transform';
import { Events } from './events';

// <-- paste createProgressRenderer, the LOD constants, and buildStreamingLodTable here, unchanged -->
// buildStreamingLodTable currently calls simplifyGaussians(lod0, target, createGpuDevice).
// Change its signature to accept the device creator as a parameter:
//   const buildStreamingLodTable = async (lod0: DataTable, createDevice: () => Promise<any>, onPhase?: (label: string) => void): Promise<DataTable>
// and replace the createGpuDevice reference with the passed-in createDevice.

export { createProgressRenderer, buildStreamingLodTable };
```

- [ ] **Step 2: Update `splat-serialize.ts` to import the moved code**

In `src/splat-serialize.ts`: delete the moved definitions; add `import { createProgressRenderer, buildStreamingLodTable } from './splat-export-core';`. Update the one caller `buildStreamingLodTable(dataTable, (label) => {...})` (~line 1400) to `buildStreamingLodTable(dataTable, createGpuDevice, (label) => {...})`.

- [ ] **Step 3: Lint and build**

Run: `npm run lint`
Expected: no errors.
Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/splat-export-core.ts src/splat-serialize.ts
git commit -m "refactor: extract progress renderer and LOD helpers to splat-export-core"
```

---

## Task 2: Move SOG/viewer writer orchestration into `splat-export-core.ts`

Move the device/fs-parameterized writer bodies so the server can call them.

**Files:**
- Modify: `src/splat-export-core.ts`, `src/splat-serialize.ts`

- [ ] **Step 1: Add parameterized orchestration functions to `splat-export-core.ts`**

Add these, porting the bodies from `serializeStreamingViewer`/`serializeViewer`/`serializeSog` but taking `createDevice`, `fs`, and `events` as params (replace every `createGpuDevice` with `createDevice`, every `fs.createWriter` stays, keep the `splatTransformLogger.setRenderer(createProgressRenderer(...))` and `unwindAll(true)` error handling exactly as today):

```ts
import { MemoryFileSystem, writeHtml, writeLod, writeSog, ZipFileSystem, type FileSystem } from '@playcanvas/splat-transform';

type DeviceCreator = () => Promise<any>;

const writeSogCore = async (dataTable: DataTable, iterations: number, createDevice: DeviceCreator, fs: FileSystem, events?: Events): Promise<void> => {
    splatTransformLogger.setRenderer(createProgressRenderer('Exporting SOG', events));
    try {
        await writeSog({ filename: 'output.sog', dataTable, bundle: true, iterations, createDevice }, fs);
    } catch (err) {
        splatTransformLogger.unwindAll(true);
        throw err;
    }
};

// viewerType: 'html' | 'package' | 'streaming'
const writeViewerCore = async (
    dataTable: DataTable,
    viewerSettingsJson: any,
    viewerType: 'html' | 'package' | 'streaming',
    createDevice: DeviceCreator,
    fs: FileSystem,
    events?: Events
): Promise<void> => {
    splatTransformLogger.setRenderer(createProgressRenderer('Exporting HTML', events));
    try {
        if (viewerType === 'html') {
            await writeHtml({ filename: 'output.html', dataTable, viewerSettingsJson, bundle: true, iterations: 10, createDevice }, fs);
        } else if (viewerType === 'streaming') {
            await writeStreamingViewerCore(dataTable, viewerSettingsJson, createDevice, fs, events);
        } else {
            const memFs = new MemoryFileSystem();
            await writeHtml({ filename: 'index.html', dataTable, viewerSettingsJson, bundle: false, iterations: 10, createDevice }, memFs);
            const zipWriter = await fs.createWriter('output.zip');
            const zipFs = new ZipFileSystem(zipWriter);
            try {
                for (const [filename, data] of memFs.results.entries()) {
                    const w = await zipFs.createWriter(filename); await w.write(data); await w.close();
                }
            } finally { await zipFs.close(); }
        }
    } catch (err) {
        splatTransformLogger.unwindAll(true);
        throw err;
    }
};
```

Also move `serializeStreamingViewer` here, renamed `writeStreamingViewerCore`, taking `(dataTable, viewerSettingsJson, createDevice, fs, events)` and using the passed `createDevice` in its `writeHtml`/`writeLod`/`buildStreamingLodTable` calls (the body is otherwise identical, including the index.sog deletion and the lod-meta repointing). Export `writeSogCore`, `writeViewerCore`.

- [ ] **Step 2: Reduce `splat-serialize.ts` `serializeSog`/`serializeViewer` to wrappers**

Replace their bodies:

```ts
const serializeSog = async (splats: Splat[], settings: SogSettings, fs: FileSystem): Promise<void> => {
    const { iterations = 10, events } = settings;
    const dataTable = extractDataTable(splats, settings);
    await writeSogCore(dataTable, iterations, createGpuDevice, fs, events);
};

const serializeViewer = async (splats: Splat[], serializeSettings: SerializeSettings, options: ViewerExportSettings, fs: FileSystem): Promise<void> => {
    const { experienceSettings, events } = options;
    const dataTable = extractDataTable(splats, serializeSettings);
    const viewerType = options.type === 'html' ? 'html' : (options.streaming ? 'streaming' : 'package');
    await writeViewerCore(dataTable, experienceSettings, viewerType, createGpuDevice, fs, events);
};
```

Add `import { writeSogCore, writeViewerCore } from './splat-export-core';` and remove now-unused imports (`writeHtml`, `writeLod`, `writeSog as writeSogInternal`, `ZipFileSystem`, `MemoryFileSystem` if no longer used elsewhere in the file — check `serializePlyCompressed`/`serializeSplat` first).

- [ ] **Step 3: Lint and build**

Run: `npm run lint` — Expected: clean (fix any unused-import errors).
Run: `npm run build` — Expected: succeeds.

- [ ] **Step 4: Manual smoke (no server yet)**

Run: `npm run develop`, open the app, import a small splat, export SOG and a streaming ZIP. Expected: both succeed exactly as before (this is the refactor-safety check).

- [ ] **Step 5: Commit**

```bash
git add src/splat-export-core.ts src/splat-serialize.ts
git commit -m "refactor: move SOG/viewer writer orchestration to splat-export-core"
```

---

## Task 3: Parity test for the extract → PLY → readback round-trip

Lock the spec's headline guarantee with an automated test. This repo has no test runner yet; add a minimal one scoped to the new code.

**Files:**
- Create: `test/parity.test.mjs`
- Modify: `package.json` (add a `test` script + `vitest` devDep)

- [ ] **Step 1: Add the test runner**

Run: `npm add -D vitest`
Then in `package.json` `scripts` add: `"test": "vitest run"`.

- [ ] **Step 2: Write the failing parity test**

Create `test/parity.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { Column, DataTable, Transform, writePly, readFile, MemoryFileSystem } from '@playcanvas/splat-transform';

class BufSource {
  constructor(buf){ this.size = buf.length; this.seekable = true; this._b = buf; }
  read(start = 0, end = this.size){ const b = this._b.subarray(start, end); let off = 0;
    return { bytesRead:0, totalBytes:b.length,
      async pull(t){ const n=Math.min(t.length,b.length-off); t.set(b.subarray(off,off+n)); off+=n; this.bytesRead+=n; return n; }, close(){} }; }
  close(){}
}
class BufFS { constructor(buf){ this._b = buf; } async createSource(){ return new BufSource(this._b); } }

describe('extract -> PLY -> readback parity', () => {
  it('preserves float columns bit-exact', async () => {
    const N = 8;
    const names = ['x','y','z','scale_0','scale_1','scale_2','f_dc_0','f_dc_1','f_dc_2','opacity','rot_0','rot_1','rot_2','rot_3'];
    const cols = names.map((n,i)=> new Column(n, Float32Array.from({length:N},(_,r)=> Math.fround((i+1)*0.731 + r*0.013))));
    const src = new DataTable(cols, Transform.PLY);
    const memFs = new MemoryFileSystem();
    await writePly({ filename:'p.ply', dataTable: src }, memFs);
    const tables = await readFile({ filename:'p.ply', inputFormat:'ply',
      options:{ iterations:10, lodSelect:[0], unbundled:false, lodChunkCount:512, lodChunkExtent:16 },
      params:[], fileSystem: new BufFS(Buffer.from(memFs.results.get('p.ply'))) });
    const back = tables[0];
    for (const n of names) {
      const a = src.columns.find(c=>c.name===n).data;
      const b = back.columns.find(c=>c.name===n).data;
      expect(Array.from(b)).toEqual(Array.from(a));
    }
  });
});
```

- [ ] **Step 3: Run it**

Run: `npm test`
Expected: PASS (this validates the assumption; if it FAILS on bit-exactness, stop — the transport premise is broken and the spec must be revisited).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json test/parity.test.mjs
git commit -m "test: add extract->PLY->readback float parity test"
```

---

## Task 4: Server package skeleton + capabilities endpoint

**Files:**
- Create: `server/package.json`, `server/tsconfig.json`, `server/src/index.ts`, `server/src/gpu.ts`, `server/README.md`

- [ ] **Step 1: Create `server/package.json`**

```json
{
  "name": "supersplat-export-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@fastify/cors": "10.0.1",
    "@fastify/multipart": "9.0.1",
    "@playcanvas/splat-transform": "2.4.0",
    "fastify": "5.1.0",
    "playcanvas": "2.18.2",
    "webgpu": "0.4.4"
  },
  "devDependencies": {
    "tsx": "4.19.2",
    "typescript": "6.0.3",
    "vitest": "2.1.8"
  }
}
```

(Confirm `webgpu` version actually installed by `@playcanvas/splat-transform` with `npm ls webgpu`; pin to match.)

- [ ] **Step 2: Create `server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `server/src/gpu.ts`**

```ts
import { createDevice } from '@playcanvas/splat-transform';

let probed: { gpu: boolean } | null = null;
let cachedDevice: any = null;

// Probe once at startup. createDevice uses the Dawn (webgpu) package.
export const probeGpu = async (): Promise<{ gpu: boolean }> => {
    if (probed) return probed;
    try {
        cachedDevice = await createDevice();
        probed = { gpu: !!cachedDevice };
    } catch {
        probed = { gpu: false };
    }
    return probed;
};

// Shared device creator handed to the writers. Reuses the probed device.
export const getDeviceCreator = () => async () => {
    if (cachedDevice) return cachedDevice;
    cachedDevice = await createDevice();
    return cachedDevice;
};
```

- [ ] **Step 4: Create `server/src/index.ts` with capabilities route**

```ts
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { probeGpu } from './gpu.js';

const PORT = Number(process.env.PORT ?? 3334);
const ALL_FORMATS = ['ply', 'compressedPly', 'splat', 'sog', 'htmlViewer', 'packageViewer'];
const GPU_FORMATS = new Set(['sog', 'htmlViewer', 'packageViewer']);

const start = async () => {
    const app = Fastify({ logger: true });
    await app.register(cors, { origin: true });

    const { gpu } = await probeGpu();

    app.get('/api/export/capabilities', async () => {
        // CPU formats always; GPU formats only when a device is available.
        const formats = ALL_FORMATS.filter(f => gpu || !GPU_FORMATS.has(f));
        return { enabled: true, gpu, formats };
    });

    await app.listen({ port: PORT, host: '0.0.0.0' });
};

start();
```

- [ ] **Step 5: Create `server/README.md`**

Document: install (`cd server && npm install`), run (`npm run dev` / `npm run build && npm start`), the GPU/Dawn requirement, `PORT` env var, and the reverse-proxy rule (route `/api/export*` to this server, serve `dist/` for everything else).

- [ ] **Step 6: Install and run**

Run: `npm install` inside `server/` (this is a different directory than the project root, so a path-targeted install is appropriate here).
Run: `npm run dev` (inside `server/`).
Then: `curl -s localhost:3334/api/export/capabilities`
Expected: JSON `{ "enabled": true, "gpu": <bool>, "formats": [...] }`. On a GPU host `gpu:true` and all 6 formats; otherwise `gpu:false` and only the 3 CPU formats.

- [ ] **Step 7: Commit**

```bash
git add server/package.json server/tsconfig.json server/src/gpu.ts server/src/index.ts server/README.md server/package-lock.json
git commit -m "feat(server): add export server skeleton with capabilities endpoint"
```

---

## Task 5: Server buffer read filesystem — SUPERSEDED (skip)

**SKIP THIS TASK.** Planning verified the library already exports `MemoryReadFileSystem` (`.set(name, Uint8Array)` + `.createSource(name)`), which round-trips a DataTable bit-exact. The hand-rolled `BufferReadFileSystem` is unnecessary (YAGNI). Task 7's worker uses `MemoryReadFileSystem` directly. Original task text retained below for reference only — do not implement.



**Files:**
- Create: `server/src/read-fs.ts`, `server/test/read-fs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/test/read-fs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { BufferReadFileSystem } from '../src/read-fs.js';

describe('BufferReadFileSystem', () => {
  it('reads the whole buffer in chunks', async () => {
    const data = Buffer.from(Uint8Array.from({ length: 1000 }, (_, i) => i % 256));
    const fs = new BufferReadFileSystem('x.ply', data);
    const src = await fs.createSource('x.ply');
    expect(src.size).toBe(1000);
    const stream = src.read(0, 1000);
    const out = new Uint8Array(1000);
    let off = 0, n = 0;
    const tmp = new Uint8Array(256);
    while ((n = await stream.pull(tmp)) > 0) { out.set(tmp.subarray(0, n), off); off += n; }
    expect(Array.from(out)).toEqual(Array.from(data));
  });
});
```

- [ ] **Step 2: Run it (fails)**

Run: `cd server && npx vitest run test/read-fs.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `server/src/read-fs.ts`**

Mirror `src/io/read/file-systems.ts` but over a Node `Buffer`:

```ts
import { BufferedReadStream, ReadStream, type ReadFileSystem, type ReadSource } from '@playcanvas/splat-transform';

const CHUNK = 4 * 1024 * 1024;

class BufferReadStream extends ReadStream {
    private buf: Buffer; private offset: number; private end: number;
    constructor(buf: Buffer, start: number, end: number) { super(end - start); this.buf = buf; this.offset = start; this.end = end; }
    async pull(target: Uint8Array): Promise<number> {
        const remaining = this.end - this.offset;
        if (remaining <= 0) return 0;
        const n = Math.min(target.length, remaining);
        target.set(this.buf.subarray(this.offset, this.offset + n));
        this.offset += n; this.bytesRead += n; return n;
    }
}

class BufferReadSource implements ReadSource {
    readonly size: number; readonly seekable = true;
    private buf: Buffer; private closed = false;
    constructor(buf: Buffer) { this.buf = buf; this.size = buf.length; }
    read(start = 0, end = this.size): ReadStream {
        if (this.closed) throw new Error('Source closed');
        const s = Math.max(0, Math.min(start, this.size));
        const e = Math.max(s, Math.min(end, this.size));
        return new BufferedReadStream(new BufferReadStream(this.buf, s, e), CHUNK);
    }
    close() { this.closed = true; }
}

export class BufferReadFileSystem implements ReadFileSystem {
    constructor(private filename: string, private buf: Buffer) {}
    async createSource(_filename: string): Promise<ReadSource> { return new BufferReadSource(this.buf); }
}
```

- [ ] **Step 4: Run it (passes)**

Run: `cd server && npx vitest run test/read-fs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/read-fs.ts server/test/read-fs.test.ts
git commit -m "feat(server): add buffer-backed read filesystem"
```

---

## Task 6: Server SSE progress sink

**Files:**
- Create: `server/src/progress.ts`, `server/test/progress.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/test/progress.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SseProgressSink } from '../src/progress.js';

describe('SseProgressSink', () => {
  it('collects messages pushed to it', () => {
    const events: any[] = [];
    const sink = new SseProgressSink((e) => events.push(e));
    sink.emit({ kind: 'progress', message: 'k-means', value: 0.5 });
    expect(events).toEqual([{ kind: 'progress', message: 'k-means', value: 0.5 }]);
  });
});
```

- [ ] **Step 2: Run it (fails)**

Run: `cd server && npx vitest run test/progress.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `server/src/progress.ts`**

A minimal sink the worker pushes structured progress into; the route serializes these to SSE. (The library's `logger.setRenderer` integration is wired in Task 7's worker; this sink is the transport-agnostic collector.)

```ts
export type ProgressEvent =
    | { kind: 'progress'; message: string; value?: number }
    | { kind: 'done' }
    | { kind: 'error'; message: string };

export class SseProgressSink {
    constructor(private onEvent: (e: ProgressEvent) => void) {}
    emit(e: ProgressEvent) { this.onEvent(e); }
}
```

- [ ] **Step 4: Run it (passes)**

Run: `cd server && npx vitest run test/progress.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/progress.ts server/test/progress.test.ts
git commit -m "feat(server): add SSE progress sink"
```

---

## Task 7: Server export worker (options → writer dispatch)

**Files:**
- Create: `server/src/run-export.ts`, `server/test/run-export.test.ts`

- [ ] **Step 1: Write the failing test (CPU formats only, no GPU needed)**

Create `server/test/run-export.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Column, DataTable, Transform, writePly, MemoryFileSystem } from '@playcanvas/splat-transform';
import { runExport } from '../src/run-export.js';

const makePlyGz = async () => {
  const N = 6;
  const names = ['x','y','z','scale_0','scale_1','scale_2','f_dc_0','f_dc_1','f_dc_2','opacity','rot_0','rot_1','rot_2','rot_3'];
  const cols = names.map((n,i)=> new Column(n, Float32Array.from({length:N},(_,r)=> (i+1)+r*0.01)));
  const memFs = new MemoryFileSystem();
  await writePly({ filename:'p.ply', dataTable: new DataTable(cols, Transform.PLY) }, memFs);
  return Buffer.from(gzipSync(Buffer.from(memFs.results.get('p.ply'))));
};

describe('runExport', () => {
  it('passes through uncompressed PLY unchanged', async () => {
    const plyGz = await makePlyGz();
    const res = await runExport({ plyGz, options: { fileType: 'ply', filename: 'out.ply' }, sink: { emit(){} }, getDeviceCreator: () => async () => { throw new Error('no gpu needed'); } });
    expect(Buffer.from(res.files[0].data)).toEqual(Buffer.from(gunzipSync(plyGz)));
    expect(res.files[0].name).toBe('out.ply');
  });

  it('produces a compressed PLY', async () => {
    const plyGz = await makePlyGz();
    const res = await runExport({ plyGz, options: { fileType: 'compressedPly', filename: 'out.compressed.ply' }, sink: { emit(){} }, getDeviceCreator: () => async () => { throw new Error('no gpu needed'); } });
    expect(res.files[0].data.length).toBeGreaterThan(0);
    expect(res.files[0].name).toBe('out.compressed.ply');
  });

  it('rejects splat (handled client-side)', async () => {
    const plyGz = await makePlyGz();
    await expect(runExport({ plyGz, options: { fileType: 'splat', filename: 'x.splat' }, sink: { emit(){} }, getDeviceCreator: () => async () => { throw new Error(); } }))
      .rejects.toThrow(/splat .* client/i);
  });
});
```

- [ ] **Step 2: Run it (fails)**

Run: `cd server && npx vitest run test/run-export.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `server/src/run-export.ts`**

```ts
import { gunzipSync } from 'node:zlib';
import { readFile, writeCompressedPly, MemoryFileSystem, ZipFileSystem, Transform } from '@playcanvas/splat-transform';
import { BufferReadFileSystem } from './read-fs.js';
import type { SseProgressSink } from './progress.js';

// matches the client's SceneExportOptions subset sent over the wire
export type ExportOptions = {
    fileType: 'ply' | 'compressedPly' | 'splat' | 'sog' | 'htmlViewer' | 'packageViewer';
    filename: string;
    serializeSettings?: { maxSHBands?: number };
    sogIterations?: number;
    viewerExportSettings?: { type: 'html' | 'zip'; streaming?: boolean; experienceSettings: any };
};

type RunArgs = {
    plyGz: Buffer;
    options: ExportOptions;
    sink: Pick<SseProgressSink, 'emit'>;
    getDeviceCreator: () => () => Promise<any>;
};

type RunResult = { files: { name: string; data: Uint8Array }[] };

const READ_OPTS = { iterations: 10, lodSelect: [0], unbundled: false, lodChunkCount: 512, lodChunkExtent: 16 };

export const runExport = async ({ plyGz, options, sink, getDeviceCreator }: RunArgs): Promise<RunResult> => {
    const ply = Buffer.from(gunzipSync(plyGz));

    // ply is a pure passthrough — no readback needed
    if (options.fileType === 'ply') {
        return { files: [{ name: options.filename, data: new Uint8Array(ply) }] };
    }
    if (options.fileType === 'splat') {
        throw new Error('splat export is handled client-side, not on the server');
    }

    // read back to a DataTable; do NOT morton-reorder (parity). Re-tag PLY space
    // (the client always sends prepared PLY-space data).
    const tables = await readFile({ filename: 'input.ply', inputFormat: 'ply', options: READ_OPTS, params: [], fileSystem: new BufferReadFileSystem('input.ply', ply) });
    const dataTable = tables[0];
    (dataTable as any).transform = Transform.PLY;

    const memFs = new MemoryFileSystem();

    if (options.fileType === 'compressedPly') {
        await writeCompressedPly({ filename: options.filename, dataTable }, memFs);
        return { files: [{ name: options.filename, data: memFs.results.get(options.filename)! }] };
    }

    // GPU formats: import the shared core lazily so CPU-only tests don't load it.
    const { writeSogCore, writeViewerCore } = await import('../../src/splat-export-core.js');
    const createDevice = getDeviceCreator();

    if (options.fileType === 'sog') {
        await writeSogCore(dataTable, options.sogIterations ?? 10, createDevice, memFs);
        // bundle:true writes a single .sog; return it
        const name = options.filename;
        const data = memFs.results.get('output.sog')!;
        return { files: [{ name, data }] };
    }

    // htmlViewer / packageViewer
    const vs = options.viewerExportSettings!;
    const viewerType = vs.type === 'html' ? 'html' : (vs.streaming ? 'streaming' : 'package');
    await writeViewerCore(dataTable, vs.experienceSettings, viewerType, createDevice, memFs);
    if (viewerType === 'html') {
        return { files: [{ name: options.filename, data: memFs.results.get('output.html')! }] };
    }
    return { files: [{ name: options.filename, data: memFs.results.get('output.zip')! }] };
};
```

NOTE on the `import('../../src/splat-export-core.js')` cross-package import: the shared core must be reachable from the server build. Resolve this in Task 8 Step 1 (server `tsconfig`/build references the client `src/` path, or the core is symlinked/aliased). If cross-import proves awkward, the fallback is to compile `src/splat-export-core.ts` to a small shared dist consumed by both. Decide and document in Task 8.

- [ ] **Step 4: Run it (passes)**

Run: `cd server && npx vitest run test/run-export.test.ts`
Expected: PASS (the three CPU/guard cases; GPU paths are covered in Task 8 conditionally).

- [ ] **Step 5: Commit**

```bash
git add server/src/run-export.ts server/test/run-export.test.ts
git commit -m "feat(server): export worker with ply/compressed/guard dispatch"
```

---

## Task 8: Wire the shared core into the server build + conditional GPU integration test

**Files:**
- Modify: `server/tsconfig.json`, `server/package.json`
- Create: `server/test/run-export.gpu.test.ts`

- [ ] **Step 1: Make `src/splat-export-core.ts` importable from the server**

Choose ONE and document it in `server/README.md`:
- (a) Add the repo root `src` to the server `tsconfig` `include` and import via relative path (simplest; the core has no DOM deps so it compiles under Node), OR
- (b) Add a path alias in `server/tsconfig.json`: `"paths": { "@core/*": ["../src/*"] }` and import `@core/splat-export-core.js`.

Verify the core truly has no browser-only imports (it imports only `@playcanvas/splat-transform` and `./events`). CONFIRMED during planning: `src/events.ts` imports only `EventHandler` from `playcanvas` — it is DOM-free, so it is safe to import into the server build. The core's `events` params are optional and never invoked server-side regardless.

- [ ] **Step 2: Build the server**

Run: `cd server && npm run build`
Expected: compiles, including the shared core, with no DOM-type errors.

- [ ] **Step 3: Write a GPU-gated integration test**

Create `server/test/run-export.gpu.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { gzipSync } from 'node:zlib';
import { Column, DataTable, Transform, writePly, MemoryFileSystem } from '@playcanvas/splat-transform';
import { probeGpu, getDeviceCreator } from '../src/gpu.js';
import { runExport } from '../src/run-export.js';

let hasGpu = false;
beforeAll(async () => { hasGpu = (await probeGpu()).gpu; });

const makePlyGz = async (N = 2048) => {
  const names = ['x','y','z','scale_0','scale_1','scale_2','f_dc_0','f_dc_1','f_dc_2','opacity','rot_0','rot_1','rot_2','rot_3'];
  const cols = names.map((n,i)=> new Column(n, Float32Array.from({length:N},(_,r)=> Math.sin(i+ r*0.001))));
  const memFs = new MemoryFileSystem();
  await writePly({ filename:'p.ply', dataTable: new DataTable(cols, Transform.PLY) }, memFs);
  return Buffer.from(gzipSync(Buffer.from(memFs.results.get('p.ply'))));
};

describe('runExport GPU formats', () => {
  it.runIf(hasGpu)('produces a SOG', async () => {
    const plyGz = await makePlyGz();
    const res = await runExport({ plyGz, options: { fileType:'sog', filename:'out.sog', sogIterations: 2 }, sink:{ emit(){} }, getDeviceCreator });
    expect(res.files[0].data.length).toBeGreaterThan(0);
  });
});
```

Note: `it.runIf(hasGpu)` is evaluated at collection time; if `hasGpu` resolves in `beforeAll` too late, instead guard inside the test body with `if (!hasGpu) return;`. Use whichever vitest version supports.

- [ ] **Step 4: Run the test**

Run: `cd server && npx vitest run test/run-export.gpu.test.ts`
Expected: PASS on a GPU host; SKIPPED/no-op on a non-GPU host.

- [ ] **Step 5: Commit**

```bash
git add server/tsconfig.json server/package.json server/test/run-export.gpu.test.ts server/README.md
git commit -m "feat(server): wire shared core into server build + GPU integration test"
```

---

## Task 9: Server job pipeline + routes (POST / SSE / result)

**Files:**
- Create: `server/src/jobs.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Implement `server/src/jobs.ts`**

```ts
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
};

const jobs = new Map<string, Job>();
const TTL_MS = 30 * 60 * 1000;
let seq = 0;
let counter = 0;

// concurrency-1 GPU queue
let chain: Promise<void> = Promise.resolve();

const push = (job: Job, e: ProgressEvent) => {
    job.buffered.push(e);
    job.listeners.forEach(l => l(e));
};

export const createJob = (plyGz: Buffer, options: ExportOptions): string => {
    const id = `job_${Date.now().toString(36)}_${seq++}`;
    const job: Job = { id, state: 'queued', listeners: [], buffered: [], createdAt: counter++ ? Date.now() : Date.now() };
    jobs.set(id, job);
    chain = chain.then(async () => {
        job.state = 'running';
        try {
            const res = await runExport({ plyGz, options, sink: { emit: (e) => push(job, e) }, getDeviceCreator });
            job.result = res.files; job.state = 'done'; push(job, { kind: 'done' });
        } catch (err: any) {
            job.error = err?.message ?? String(err); job.state = 'error'; push(job, { kind: 'error', message: job.error });
        }
    });
    return id;
};

export const getJob = (id: string) => jobs.get(id);

export const subscribe = (id: string, listener: (e: ProgressEvent) => void): (() => void) => {
    const job = jobs.get(id); if (!job) return () => {};
    job.buffered.forEach(listener);                 // replay
    if (job.state === 'done' || job.state === 'error') return () => {};
    job.listeners.push(listener);
    return () => { job.listeners = job.listeners.filter(l => l !== listener); };
};

// periodic TTL cleanup
setInterval(() => {
    const now = Date.now();
    for (const [id, j] of jobs) if ((j.state === 'done' || j.state === 'error') && now - j.createdAt > TTL_MS) jobs.delete(id);
}, 60 * 1000).unref();
```

- [ ] **Step 2: Add routes to `server/src/index.ts`**

Add `@fastify/multipart` registration and three routes:

```ts
import multipart from '@fastify/multipart';
import { createJob, getJob, subscribe } from './jobs.js';

await app.register(multipart, { limits: { fileSize: Number(process.env.MAX_UPLOAD ?? 1024 * 1024 * 1024) } });

app.post('/api/export', async (req, reply) => {
    let plyGz: Buffer | null = null;
    let options: any = null;
    for await (const part of req.parts()) {
        if (part.type === 'file' && part.fieldname === 'ply') plyGz = await part.toBuffer();
        else if (part.type === 'field' && part.fieldname === 'options') options = JSON.parse(part.value as string);
    }
    if (!plyGz || !options?.fileType || !options?.filename) return reply.code(400).send({ error: 'missing ply or options' });
    const id = createJob(plyGz, options);
    return reply.code(202).send({ jobId: id });
});

app.get('/api/export/:id/events', (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getJob(id)) return reply.code(404).send({ error: 'no such job' });
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const send = (e: any) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    const unsub = subscribe(id, (e) => { send(e); if (e.kind === 'done' || e.kind === 'error') { unsub(); reply.raw.end(); } });
    req.raw.on('close', unsub);
});

app.get('/api/export/:id/result', async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = getJob(id);
    if (!job || job.state !== 'done' || !job.result) return reply.code(404).send({ error: 'not ready' });
    const file = job.result[0];
    const isZip = file.name.endsWith('.zip');
    reply.header('Content-Type', isZip ? 'application/zip' : 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${file.name}"`);
    return reply.send(Buffer.from(file.data));
});
```

- [ ] **Step 3: Manual end-to-end with curl**

Run (server in `dev`): create a tiny gzipped PLY (reuse the Task 7 helper in a scratch script), then:
```bash
JOB=$(curl -s -F "ply=@/tmp/p.ply.gz;type=application/gzip" -F 'options={"fileType":"compressedPly","filename":"out.compressed.ply"}' localhost:3334/api/export | jq -r .jobId)
curl -s -N localhost:3334/api/export/$JOB/events &
curl -s localhost:3334/api/export/$JOB/result -o /tmp/out.compressed.ply
```
Expected: SSE prints a `done` event; `/tmp/out.compressed.ply` is a valid compressed PLY (import it into the app to confirm).

- [ ] **Step 4: Commit**

```bash
git add server/src/jobs.ts server/src/index.ts server/package.json server/package-lock.json
git commit -m "feat(server): job pipeline with POST/SSE/result routes"
```

---

## Task 10: Client export-server client

**Files:**
- Create: `src/export-server-client.ts`

- [ ] **Step 1: Implement the client**

```ts
type Capabilities = { enabled: boolean; gpu: boolean; formats: string[] };

let cached: Capabilities | null | undefined;

export const probeExportCapabilities = async (): Promise<Capabilities | null> => {
    if (cached !== undefined) return cached;
    try {
        const res = await fetch(`${location.origin}/api/export/capabilities`);
        cached = res.ok ? (await res.json() as Capabilities) : null;
    } catch {
        cached = null;
    }
    return cached;
};

export type ServerProgress = { message: string; value?: number };

// POST gzipped ply + options, follow SSE, then fetch the result as a Blob.
export const runServerExport = async (
    plyGz: Blob,
    options: object & { fileType: string; filename: string },
    onProgress: (p: ServerProgress) => void
): Promise<Blob> => {
    const form = new FormData();
    form.append('ply', plyGz, 'scene.ply.gz');
    form.append('options', JSON.stringify(options));
    const startRes = await fetch(`${location.origin}/api/export`, { method: 'POST', body: form });
    if (!startRes.ok) throw new Error(`server export failed to start (${startRes.status})`);
    const { jobId } = await startRes.json();

    await new Promise<void>((resolve, reject) => {
        const es = new EventSource(`${location.origin}/api/export/${jobId}/events`);
        es.onmessage = (ev) => {
            const e = JSON.parse(ev.data);
            if (e.kind === 'progress') onProgress({ message: e.message, value: e.value });
            else if (e.kind === 'done') { es.close(); resolve(); }
            else if (e.kind === 'error') { es.close(); reject(new Error(e.message)); }
        };
        es.onerror = () => { es.close(); reject(new Error('progress stream error')); };
    });

    const resultRes = await fetch(`${location.origin}/api/export/${jobId}/result`);
    if (!resultRes.ok) throw new Error(`server export result unavailable (${resultRes.status})`);
    return await resultRes.blob();
};
```

- [ ] **Step 2: Lint and build**

Run: `npm run lint` — Expected: clean.
Run: `npm run build` — Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/export-server-client.ts
git commit -m "feat: add client export-server transport (probe + POST/SSE/result)"
```

---

## Task 11: Modal toggle (default-on when available)

**Files:**
- Modify: `src/ui/export-popup.ts`, `static/locales/en.json` (+ sibling locale files)

- [ ] **Step 1: Add the localization key**

In `static/locales/en.json` add under the export popup keys: `"popup.export.use-server": "Export on server"`. Add the same key to every other `static/locales/*.json` (English value is acceptable as a placeholder for translation).

- [ ] **Step 2: Add the toggle row to the modal**

In `src/ui/export-popup.ts`:
- Import: `import { probeExportCapabilities } from '../export-server-client';`
- After the `streamingRow` block, add a `serverRow` following the same pattern (Label + BooleanInput toggle, default value true):

```ts
const serverLabel = new Label({ class: 'label', text: localize('popup.export.use-server') });
const serverToggle = new BooleanInput({ class: 'boolean', type: 'toggle', value: true });
const serverRow = new Container({ class: 'row' });
serverRow.append(serverLabel);
serverRow.append(serverToggle);
```
- Append `serverRow` to `content` and add it to the `allRows` array in `reset()`.
- Cache capabilities: add a module-level `let capabilities` and populate it once (call `probeExportCapabilities()` in the constructor, store the resolved value).
- In `reset()`, after computing `activeRows`, compute server-row visibility:

```ts
const fmtForType = { ply:'ply', splat:'splat', sog:'sog', viewer:'__viewer__', viewerSettings:null }[exportType];
const serverSupports = (() => {
    if (!capabilities?.enabled) return false;
    if (exportType === 'viewerSettings') return false;       // pure JSON, no server benefit
    if (exportType === 'viewer') return capabilities.formats.includes('htmlViewer') || capabilities.formats.includes('packageViewer');
    if (exportType === 'ply') return capabilities.formats.includes(compressBoolean.value ? 'compressedPly' : 'ply');
    return capabilities.formats.includes(fmtForType as string);
})();
serverRow.hidden = !serverSupports;
serverToggle.value = serverSupports;   // default on when shown
```
- In the assemble* functions, include `useServer: !serverRow.hidden && serverToggle.value` in the returned `SceneExportOptions`.

- [ ] **Step 3: Extend `SceneExportOptions`**

In `src/file-handler.ts` add `useServer?: boolean;` to the `SceneExportOptions` interface.

- [ ] **Step 4: Lint and build, then visual check**

Run: `npm run lint && npm run build` — Expected: clean.
Run: `npm run develop` with the server running. Expected: the "Export on server" row appears for PLY/SOG/viewer, defaults ON, and is hidden when the server is stopped (reload).

- [ ] **Step 5: Commit**

```bash
git add src/ui/export-popup.ts src/file-handler.ts static/locales
git commit -m "feat(export): add 'Export on server' modal toggle (default on)"
```

---

## Task 12: Route the export through the server in `file-handler.ts`

**Files:**
- Modify: `src/file-handler.ts`

- [ ] **Step 1: Add a server-export helper**

In `src/file-handler.ts`, import:
```ts
import { runServerExport } from './export-server-client';
import { serializePly } from './splat-serialize';
import { MemoryFileSystem } from '@playcanvas/splat-transform';   // NOT re-exported by ./io (confirmed); import direct
```

Add a helper that prepares the gzipped PLY from the current splats and runs the server export, saving via the existing stream/download path:

```ts
const writeViaServer = async (fileType: FileType, options: SceneExportOptions, stream?: FileSystemWritableFileStream) => {
    // ply/splat: no server benefit / not supported server-side -> fall back to local
    if (fileType === 'splat') return false;

    // Prepare uncompressed PLY in memory using the SAME extraction the browser uses.
    const memFs = new MemoryFileSystem();
    const splats = options.splatIdx === 'all' ? getSplats() : [getSplats()[options.splatIdx]];
    await serializePly(splats, options.serializeSettings, memFs as any, 'scene.ply');
    const plyBytes = memFs.results.get('scene.ply')!;

    // gzip
    const gz = await new Response(new Blob([plyBytes]).stream().pipeThrough(new CompressionStream('gzip'))).blob();

    const wire = { ...options, fileType };
    events.fire('startSpinner');
    try {
        const blob = await runServerExport(gz, wire as any, (p) => {
            // map to existing progress UI if available; otherwise spinner stays
            events.fire('progressUpdate', p);
        });
        // save
        if (stream) {
            const w = await stream; await w.write(await blob.arrayBuffer()); await w.close?.();
            // NOTE: stream here is already a writable; adapt to BrowserFileWriter usage as in scene.write
        } else {
            // download fallback
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = options.filename; a.click(); URL.revokeObjectURL(url);
        }
    } finally {
        events.fire('stopSpinner');
    }
    return true;
};
```

NOTE: align the save path with the existing `BrowserFileSystem`/stream handling already in `scene.write` (reuse rather than duplicate; if `scene.export` obtained a `FileSystemWritableFileStream`, write the blob to it and close). Confirm the exact `serializePly` signature (`serializePly(splats, settings, fs, filename?, progress?)`) and that passing a `MemoryFileSystem` works (it implements the same `FileSystem` interface as `BrowserFileSystem`).

- [ ] **Step 2: Branch in `scene.write`**

At the top of the `scene.write` handler, before building `BrowserFileSystem`:

```ts
if (options.useServer) {
    const handled = await writeViaServer(fileType, options, stream);
    if (handled) return;
    // not handled (e.g. splat) -> fall through to local path
}
```

- [ ] **Step 3: Lint and build**

Run: `npm run lint && npm run build` — Expected: clean.

- [ ] **Step 4: End-to-end manual test (server running)**

Run: `npm run develop` + server. Import a small splat. With the toggle ON, export SOG, compressed PLY, HTML viewer, and streaming ZIP. Expected: each downloads a valid file produced by the server; importing each back into the app matches a local export. Toggle OFF: local path still works. `.splat` with toggle on: silently uses local path.

- [ ] **Step 5: Commit**

```bash
git add src/file-handler.ts
git commit -m "feat(export): route export through server when toggle enabled"
```

---

## Task 13: Parity verification test (server vs browser, compressed PLY)

**Files:**
- Create: `server/test/parity-compressed.test.ts`

- [ ] **Step 1: Write the test**

Compares server `compressedPly` output against the library writer run directly on the same readback table (deterministic, no GPU):

```ts
import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { Column, DataTable, Transform, writePly, writeCompressedPly, readFile, MemoryFileSystem } from '@playcanvas/splat-transform';
import { BufferReadFileSystem } from '../src/read-fs.js';
import { runExport } from '../src/run-export.js';

const READ_OPTS = { iterations:10, lodSelect:[0], unbundled:false, lodChunkCount:512, lodChunkExtent:16 };

describe('server compressed PLY parity', () => {
  it('matches direct writeCompressedPly on the same readback table', async () => {
    const N = 1024;
    const names = ['x','y','z','scale_0','scale_1','scale_2','f_dc_0','f_dc_1','f_dc_2','opacity','rot_0','rot_1','rot_2','rot_3'];
    const cols = names.map((n,i)=> new Column(n, Float32Array.from({length:N},(_,r)=> Math.fround(Math.sin(i + r*0.01)))));
    const memFs = new MemoryFileSystem();
    await writePly({ filename:'p.ply', dataTable: new DataTable(cols, Transform.PLY) }, memFs);
    const ply = Buffer.from(memFs.results.get('p.ply'));
    const plyGz = Buffer.from(gzipSync(ply));

    const res = await runExport({ plyGz, options:{ fileType:'compressedPly', filename:'out.compressed.ply' }, sink:{ emit(){} }, getDeviceCreator: () => async () => { throw new Error(); } });

    const tables = await readFile({ filename:'input.ply', inputFormat:'ply', options: READ_OPTS, params:[], fileSystem: new BufferReadFileSystem('input.ply', ply) });
    (tables[0] as any).transform = Transform.PLY;
    const ref = new MemoryFileSystem();
    await writeCompressedPly({ filename:'out.compressed.ply', dataTable: tables[0] }, ref);

    expect(Buffer.from(res.files[0].data)).toEqual(Buffer.from(ref.results.get('out.compressed.ply')!));
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd server && npx vitest run test/parity-compressed.test.ts`
Expected: PASS (byte-identical — proves the server path adds no transformation beyond the writer).

- [ ] **Step 3: Commit**

```bash
git add server/test/parity-compressed.test.ts
git commit -m "test(server): compressed PLY server-vs-direct parity"
```

---

## Task 14: Full test pass + docs polish

**Files:**
- Modify: `server/README.md`, root `README.md` (if it documents export)

- [ ] **Step 1: Run all tests**

Run: `npm test` (root) and `cd server && npm test`.
Expected: all green; GPU-gated tests skip on non-GPU CI with a clear marker.

- [ ] **Step 2: Lint + build both**

Run: `npm run lint && npm run build` (root); `cd server && npm run build`.
Expected: clean.

- [ ] **Step 3: Finalize docs**

Ensure `server/README.md` documents: install/run, GPU/Dawn requirement, `PORT`/`MAX_UPLOAD` env vars, the reverse-proxy rule routing `/api/export*` to the server while serving `dist/` otherwise, and the parity guarantee (client extracts, server writes). Note Feature B (publish-to-DO) is a future extension of the same engine.

- [ ] **Step 4: Commit**

```bash
git add server/README.md README.md
git commit -m "docs: finalize server-side export docs"
```

---

## Risks & Mitigations

- **`Transform.PLY` tag lost in PLY round-trip** → flipped output. Mitigation: Task 0 verifies; Task 7/9 re-tag the readback table unconditionally (safe regardless).
- **Splat order changed on readback** → SOG k-means differs. Mitigation: server never morton-reorders; documented in Task 7.
- **Cross-package import of `splat-export-core`** → build friction. Mitigation: Task 8 Step 1 picks and documents the resolution (tsconfig include or path alias), with a compile-to-shared-dist fallback.
- **`./events` drags DOM into the server build.** RESOLVED in planning: `src/events.ts` only imports `EventHandler` from `playcanvas` (DOM-free); the core's `events` params are optional and unused server-side.
- **Large uploads (hundreds of MB).** Mitigation: gzip; `MAX_UPLOAD` limit with a 400 error; streaming multipart.
- **No GPU/Dawn on host.** Mitigation: `capabilities.gpu=false`; GPU-format toggle hidden; local export unaffected.
- **`webgpu`/Dawn native install friction.** Mitigation: documented; capability probe degrades gracefully.
- **Refactor regresses browser export.** Mitigation: Tasks 1-2 are pure extraction with stable exports; Task 2 Step 4 manual smoke + existing behavior preserved.

## Out of Scope

- Feature B: publish to a private DigitalOcean Space (separate spec); this engine/transport is built to extend to it by swapping the terminal sink for an S3 upload.
- Auth/multi-tenant, distributed queue, multi-GPU scaling.
- Reusing PlayCanvas `apiServer`.
