# Server-side Export (download)

Date: 2026-05-30
Status: Approved (pending implementation plan)

## 1. Summary & scope

Add an **"Export on server"** option to the export modal. When enabled, instead
of running the export in the browser, the client ships the prepared scene data to
a new self-hosted Node server that runs the same `@playcanvas/splat-transform`
writers on the **host GPU** and returns the resulting file for download.

The motivation: SuperSplat currently exports entirely in the browser to use end
users' GPUs (SOG compression, streaming-LOD decimation, and the viewer's content
SOG are all WebGPU jobs). On a deployment that has a GPU-equipped server, doing
that work server-side is preferable - faster, not bound by the end user's
hardware, and not blocking the browser tab on multi-minute jobs.

**This spec covers Feature A only: server-side export-download.** A second
feature - **publish to a private DigitalOcean Space** (S3-compatible) instead of
PlayCanvas - is a known upcoming requirement. It shares this feature's server,
GPU engine, and transport; only the terminal sink differs (upload to a Space vs.
return the file). It is explicitly out of scope here but the architecture is
designed to accommodate it (see section 9). Feature B gets its own spec.

### Scope: all export formats

The server-side option applies to **every** current export type: PLY,
compressed PLY, `.splat`, SOG, HTML viewer, and ZIP viewer (including streaming
LOD). The user chose uniform coverage over a GPU-only subset.

For reference, the GPU-bound formats (the ones that benefit most) are SOG, HTML
viewer, and ZIP viewer; PLY/compressed-PLY/`.splat` are pure CPU/JS. Server-side
export of the CPU formats still offloads memory/CPU for very large scenes and
keeps the UX uniform.

### Design decisions (resolved during brainstorming)

- **Independent server, no auth (this feature).** A new Node server in this repo,
  not coupled to the existing `apiServer`/login model (which is PlayCanvas's
  proprietary publish-and-host backend, reached via `GET ${origin}/api/id` and
  used only by `publish.ts`). Feature A ships no auth; a bearer token can be
  layered later (Feature B will need credentials server-side regardless).
- **Same origin + capability probe.** The endpoint lives at
  `${origin}/api/export` (mirroring how `/api/id` is same-origin behind the
  deployment's reverse proxy). At startup the client probes
  `GET ${origin}/api/export/capabilities`; the modal toggle appears only when the
  server is present and reports the chosen format as supported, and it defaults to
  **on** in that case. Self-hosters who run app+server together get the feature
  with zero URL configuration; if no server is present, the modal is unchanged.
- **Synchronous job + SSE progress.** `POST /api/export` starts a job and returns
  a `jobId`; the client subscribes to `GET /api/export/:jobId/events`
  (Server-Sent Events) for progress, then `GET /api/export/:jobId/result` to
  download. SSE carries the same `splat-transform` progress events the browser
  shows today, so multi-minute streaming-LOD exports get real feedback and reuse
  the existing progress UI.
- **Client owns extraction; server owns writers.** The quality-critical
  preparation pipeline (`extractDataTable`: gaussian filtering, SH-band
  truncation, `Transform.PLY` tagging) stays in the browser. The server runs only
  the format writers/orchestration on the already-prepared data. This guarantees
  output parity (see section 4) and avoids duplicating SuperSplat-specific logic.
- **Transport: prepared data as uncompressed float32 PLY, gzipped.** Lossless and
  bit-exact for the data the writers consume (see section 4).
- **Shared orchestration extracted, not duplicated.** The streaming-LOD
  orchestration in `splat-serialize.ts` already injects its GPU device via a
  `createDevice` callback and operates on a `DataTable`; the environment-agnostic
  parts are extracted into a module both the browser and server import.

## 2. Architecture & components

### Repo structure

- **`server/`** - new Node (ESM) package with its own `package.json`. Runtime
  deps: Fastify (chosen for native streaming/SSE ergonomics; existing `cors` dep
  is reused), `@playcanvas/splat-transform`,
  `webgpu` (Dawn bindings), `playcanvas`. Served at the same origin as the static
  app behind the deployment's reverse proxy (the proxy routes `/api/export*` to
  this server and everything else to the static `dist`).
- **`src/` (client)** - export modal gains the toggle and capability probe; the
  export flow gains a server-routed path alongside the existing local path.
- **Shared module** - environment-agnostic writer orchestration imported by both
  `src/splat-serialize.ts` (browser) and the server.

### Server GPU device

Replicate `splat-transform`'s CLI `node-device` pattern: the `webgpu` package's
headless `globals`/`create` plus a `WebgpuGraphicsDevice`. The browser's
`createGpuDevice` (`splat-serialize.ts:1126`) needs a canvas; the server uses the
headless path instead. This is the exact device-creation pattern the
`splat-transform` CLI already uses for its own SOG/LOD commands, so it is proven
in Node.

If no GPU/Dawn device is available, the server reports `gpu:false` in
capabilities and the client keeps the toggle hidden (or disabled). CPU-only
formats may still be offered if a host wants them; GPU formats are gated on
`gpu:true`.

### Shared orchestration module

The streaming-LOD logic (`buildStreamingLodTable`, the LOD packaging in
`exportStreamingViewer`, SOG orchestration) currently lives in
`src/splat-serialize.ts`. It already:
- takes a `createDevice` callback (no hardcoded canvas/DOM dependency in the
  orchestration itself), and
- operates on a `DataTable` rather than on `Splat` objects directly.

We extract the DOM/canvas-free orchestration into a shared module parameterized
by `(createDevice, FileSystem, progressSink)`. The browser wrapper supplies its
canvas-based device + `BrowserFileSystem` + events-based progress; the server
supplies its headless device + a memory/temp `FileSystem` + an SSE progress sink.

**Tradeoff acknowledged:** this is a non-trivial refactor of a recently-added,
complex file (`splat-serialize.ts`). The alternative - a second copy on the
server - was rejected because the streaming-LOD code is intricate and would
drift. Extraction is the deliberate choice; the refactor must preserve existing
browser behavior (covered by tests, section 7).

## 3. Data path & transport

1. **Client prepares data.** The client runs the existing `extractDataTable`
   (filtering, SH bands, `Transform.PLY`) and serializes the result to an
   **in-memory uncompressed PLY** via the existing `serializePly` +
   `MemoryFileSystem`. The PLY is gzipped for upload.
2. **Client starts job.** `POST ${origin}/api/export` as multipart:
   - `ply` part: the gzipped uncompressed PLY (the prepared float32 data).
   - `options` part: JSON = the existing `SceneExportOptions` plus the target
     `fileType` and any viewer/SOG settings (iterations, streaming flag,
     `experienceSettings`, etc.).
   Server validates, enqueues, returns `202 { jobId }`.
3. **Progress via SSE.** Client opens `GET ${origin}/api/export/:jobId/events`
   (`text/event-stream`). The server bridges `splat-transform` progress (the same
   events `createProgressRenderer` consumes today) into SSE messages, ending in a
   `done` or `error` event. The browser `EventSource` API is GET-only, hence the
   separate GET endpoint keyed by `jobId`.
4. **Download result.** On `done`, client `GET ${origin}/api/export/:jobId/result`
   and streams the file into the existing save flow: `showSaveFilePicker` +
   `BrowserFileSystem` where available, download fallback (Safari) otherwise.

### Transport size

Uncompressed PLY with full SH for multi-million-splat scenes can be hundreds of
MB. Gzip mitigates (PLY float data compresses moderately). The server enforces a
configurable max-upload limit and returns a clear error above it. This is an
accepted cost of the "prepare client-side, write server-side" split; the
alternative (shipping a SuperSplat-proprietary intermediate) buys nothing since
the writers consume PLY-equivalent data anyway.

## 4. Quality / parity guarantee

Output must match the browser export. Verified against the code:

- **No transport precision loss.** `extractDataTable` builds all gaussian
  attributes as `Float32Array` columns (`splat-serialize.ts:1207`). Uncompressed
  PLY stores float32. A `DataTable -> uncompressed PLY -> DataTable` round-trip is
  therefore bit-exact - no quantization.
- **Quality-critical prep stays client-side.** `extractDataTable` performs three
  SuperSplat-specific steps the raw `splat-transform` writers do not:
  1. `GaussianFilter` filtering (e.g. SOG sets `minOpacity=1/255`,
     `removeInvalid=true` in `file-handler.ts`, dropping degenerate/transparent
     gaussians before compression),
  2. SH-band truncation to `maxSHBands`,
  3. `Transform.PLY` tagging (compensates the 180 deg Z flip
     `SingleSplat.read` pre-applies; prevents a double flip in the writers).
  By running `extractDataTable` in the browser and shipping its already-prepared
  output, the server feeds the writers exactly what the browser feeds them.
- **Per-format outcome:**
  - PLY, `.splat`: byte-identical.
  - SOG, compressed PLY, viewer: same algorithm, same parameters, same input ->
    equivalent quality.
- **One honest nuance.** SOG k-means depends slightly on input order (seeding).
  The server must preserve the prepared splat order (i.e. not re-apply the morton
  reorder that the *import* loader adds in `io/read/loader.ts`). Same order ->
  equivalent, possibly identical; different order -> numerically different but not
  lower quality at equal iteration count.

This guarantee is enforced by tests (section 7).

## 5. Server job model

- In-memory map `jobId -> { state, progress, resultPath, error, createdAt }`.
- **GPU work queue, concurrency 1** - a single shared `WebgpuGraphicsDevice`
  means GPU stages must serialize. Jobs queue; the SSE stream reports queued
  position if waiting.
- Result written to a temp file; streamed on `/result`; **TTL cleanup** removes
  finished jobs and temp files after a configurable window.
- No Redis/external queue (YAGNI for a single-GPU self-hosted server).
- Endpoints:
  - `GET  /api/export/capabilities` -> `{ enabled, gpu, formats[] }`
  - `POST /api/export` -> `202 { jobId }`
  - `GET  /api/export/:jobId/events` -> SSE progress, terminates `done`/`error`
  - `GET  /api/export/:jobId/result` -> file stream (correct content-type per
    format)

## 6. Client integration (modal)

- **Startup probe.** Call `GET ${origin}/api/export/capabilities` once; cache the
  result. Failure/absence => feature off, modal unchanged.
- **Toggle row.** Add an "Export on server" boolean row to `export-popup.ts`,
  shown only when the server is present and the currently-selected export type is
  in `capabilities.formats`. Hidden/disabled otherwise (GPU formats hidden when
  `gpu:false`).
- **Default on when available.** When the server is present and supports the
  selected format, the toggle defaults to **on** - server-side export is the
  preferred path on a GPU-equipped deployment. The user can still flip it off per
  export to run locally. When no server is present, the row is hidden and export
  is local as today.
- **Routing.** In `file-handler.ts` `scene.export`/`scene.write`, when the toggle
  is on, route through the job/SSE path; when off (or no server), the existing
  local writers run unchanged.
- **Progress mapping.** SSE progress events map into the existing SOG/viewer
  progress UI (the same UI `createProgressRenderer` drives today), so the user
  experience is consistent between local and server export.

## 7. Testing (TDD)

- **Parity (the headline guarantee):**
  - `Splat -> extractDataTable -> uncompressed PLY -> readback` equals direct
    `Splat -> extractDataTable` column-for-column (float32 exact).
  - Fixture SOG / compressed-PLY: server output vs. browser output within
    tolerance (and order-preservation asserted).
- **Server unit:** options -> writer mapping; capability reporting with/without
  GPU.
- **Server integration:** pipe a tiny PLY through each writer (PLY, compressed
  PLY, splat, SOG, html, zip/streaming) and assert valid output. GPU-dependent
  cases gated/conditional (CI often lacks a GPU; rely on Dawn software fallback or
  skip with a clear marker).
- **Client:** capability-probe gating of the toggle; server-routing of export;
  SSE -> progress mapping; save flow (picker + Safari fallback).
- **Refactor safety:** existing browser export tests must still pass after the
  shared-module extraction (no behavior change to local export).

## 8. Error handling, security, deployment

- **No GPU on host:** `capabilities.gpu = false`; GPU-format toggle hidden;
  client export unaffected.
- **Job/SSE failure:** surface via the existing error popup; offer retry
  client-side (local export remains available as fallback).
- **Limits/validation:** enforce configurable max-upload size; validate the
  `options` payload; CORS (reuse `cors`); TTL + temp-file cleanup to bound disk.
- **Auth:** none in Feature A (independent self-hosted control). Document that the
  endpoint should sit behind the deployment's own access controls if exposed.
- **Deployment doc:** how to run `server/` (Node + GPU/Dawn requirement) and the
  reverse-proxy rule routing `/api/export*` to it while serving `dist` otherwise.

## 9. Out of scope (and forward-compatibility)

- **Feature B - publish to a private DigitalOcean Space (S3-compatible).** Reuses
  this feature's upload + job + SSE engine and the shared orchestration module.
  The only difference is the terminal sink: instead of writing a temp file and
  returning it, the server uploads the writer output to the Space via an
  S3-compatible client (credentials server-side via env) and returns the Space
  URL. New endpoint + UI, no engine rework. Separate spec.
- **Auth/multi-tenant, distributed job queue, multi-GPU scaling** - not needed
  for a single-GPU self-hosted server; revisit only if a real deployment demands
  it.
- **Reusing PlayCanvas `apiServer`** - explicitly rejected (proprietary,
  login-bound, publish-and-host only).
