# Server-side Export — Resume Handoff

> Read this first when resuming. It captures exactly where the work stands, how to
> continue, and the hard-won facts/process rules that must not be relearned.

**Branch:** `feature/server-side-export`  •  **HEAD when written:** `dcc5451`  •  **Date:** 2026-05-30

## Source-of-truth documents (read in this order)
1. Spec: `docs/superpowers/specs/2026-05-30-server-side-export-design.md` (approved)
2. Plan: `docs/superpowers/plans/2026-05-30-server-side-export.md` (the task list; note Task 5 is SUPERSEDED/skipped, and the plan's "verified facts" were corrected mid-flight — see "Corrections to the plan" below)
3. This file

## The feature in one paragraph
Add an "Export on server" option to the export modal. The browser keeps the
quality-critical preparation (`extractDataTable`: gaussian filtering, SH-band
truncation, `Transform.PLY` tagging) and serializes to an in-memory uncompressed
float32 PLY, gzips it, and POSTs it to a new self-hosted Node+Fastify server. The
server reads it back into a DataTable and runs the same `@playcanvas/splat-transform`
writers on the host GPU, streaming progress over SSE and the result back for
download. Output parity is guaranteed because client and server feed the writers
the identical float32 data. A later Feature B (publish to a private DigitalOcean
Space) reuses the same engine with a different terminal sink — out of scope here.

## Execution method (MANDATORY — these were violated repeatedly; do not repeat)
- Using **superpowers:subagent-driven-development**: one implementer subagent per
  task, then spec review, then code-quality review, then mark complete.
- **NEVER dispatch implementers (or any tool calls) in parallel.** Batching tool
  calls in one message caused cascade cancellations every time. Send ONE tool call
  per message and read its result before the next.
- **Never use `node -e "..."`** for inspection — each invocation is a unique
  string that can't be allowlisted, so it spams the user with permission prompts.
  Use the Read tool for files, Grep for searching. Only run `node`/`npm`/`npx`
  for real builds, tests, installs (these match allowlisted patterns).
- Subagents must be told: cwd is already the repo root; run git/npm plainly (no
  `cd <root>`, no `git -C`, no `npm --prefix`). For server-subdir commands they
  must use a **subshell** so the shell stays at root: `( cd server && npm run build )`.
  (The PreToolUse hook that enforced the no-cd rule was REMOVED at the user's
  request on 2026-05-30 — it's now a soft convention again.)
- Don't commit until tests are green. `.claude/` is untracked — never stage it.
  `server/dist`, `server/node_modules`, repo-root `dist-shared/` are gitignored.

## DONE and verified (commits, newest first)
- `dcc5451` fix(server): unguessable job ids + sanitized/validated export filenames
  (resolved 2 HIGH automated-security-review findings: CSPRNG `randomBytes(16)` job
  ids → no IDOR; filename intake validation `^[A-Za-z0-9._-]+$` + no `..`, plus
  Content-Disposition CR/LF/quote sanitization → no header injection)
- `30997a2` feat(server): job pipeline with POST/SSE/result routes
- `8315040` feat(server): compile shared export core to dist-shared + wire into server + GPU SOG integration test
- `7a5fe0a` feat(server): export worker (ply passthrough / compressedPly / splat client-guard / sog / viewer dispatch)
- `6d61a5e` feat(server): SSE progress sink
- `032cfb3` fix(server): harden device init + server startup (race-free device promise, start().catch)
- `2f10aa5` feat(server): export server skeleton + capabilities endpoint
- `68b3481` refactor: move SOG/viewer writer orchestration to splat-export-core
- `012995c` test: extract→PLY→readback float parity test
- (earlier) refactor extracting `createProgressRenderer`/`buildStreamingLodTable` to `splat-export-core.ts`

**Verification status:** server build clean; **8/8 server tests pass** including a
REAL GPU SOG export on the RTX 4090 (`output.sog` ~18.6KB) and the full HTTP
round-trip (POST 202 → SSE `done` → result bytes); client `npm run build` + the
client parity test pass.

## Tasks REMAINING (do these, in order)
**Task 10 — Client transport** `src/export-server-client.ts` (NEW)
- `probeExportCapabilities()` (cached): `GET ${location.origin}/api/export/capabilities`
  → `{ enabled, gpu, formats }` or null on failure.
- `runServerExport(plyGz: Blob, options, onProgress)`: POST multipart (`ply` file +
  `options` JSON) → `{ jobId }`; subscribe `EventSource(${origin}/api/export/${jobId}/events)`,
  map `progress` events to `onProgress`, resolve on `done`, reject on `error`;
  then `GET ${origin}/api/export/${jobId}/result` → return Blob.
- Plain client module (no server imports). Verify with `npm run build`.

**Task 11 — Modal toggle (default ON when available)** `src/ui/export-popup.ts` + `static/locales/*.json`
- Add an "Export on server" boolean row, shown only when capabilities present AND the
  selected export type is supported (GPU formats require `gpu:true`); default the
  toggle to **on** when shown. Add `useServer?: boolean` to `SceneExportOptions`
  (defined in `src/file-handler.ts`). Add localization key `popup.export.use-server`
  to `static/locales/en.json` (+ siblings; English value acceptable as placeholder).
- See plan Task 11 for the exact `serverSupports` gating snippet.

**Task 12 — Route through server** `src/file-handler.ts`
- In `scene.write`, when `options.useServer` and the format is server-eligible:
  run the existing `extractDataTable`+`serializePly` into a `MemoryFileSystem`
  (import `MemoryFileSystem` from `@playcanvas/splat-transform` — it is NOT
  re-exported by `src/io`), gzip via `CompressionStream('gzip')`, call
  `runServerExport`, save the returned blob through the existing
  `showSaveFilePicker`/`BrowserFileSystem` path (download fallback for Safari).
  `ply` and `splat` fall back to the local path even when the toggle is on
  (ply = trivial; splat is the server's client-guard). Map progress to the
  existing spinner/progress UI.

**Task 13 — Server parity test** `server/test/parity-compressed.test.ts` (NEW)
- Assert `runExport({fileType:'compressedPly'})` is byte-identical to a direct
  `writeCompressedPly` on the same readback DataTable (deterministic, no GPU).
  Pattern is in plan Task 13.

**Task 14 — Final pass**
- All tests (root `npm test` + `( cd server && npx vitest run )`), `npm run build`
  both, finalize `server/README.md`.
- **Decide the share strategy** (deferred by the user): keep `dist-shared/` (current,
  pragmatic) vs. promote the shared orchestration to an npm workspace package.
  Evaluate now that everything works end-to-end.
- Final whole-branch code review, then **superpowers:finishing-a-development-branch**.
- **User's global rule:** when the branch is finished, SQUASH all feature commits
  into a single commit summarizing all changes incl. docs.

## Corrections to the plan's "verified facts" (the plan text is partly stale — trust THIS)
- `writePly` from `@playcanvas/splat-transform` does NOT accept a DataTable (it takes
  internal `PlyData`). To write a DataTable to PLY in **tests/fixtures**, use
  `writeFile({ filename, outputFormat: 'ply', dataTable, options: {} }, memFs)`.
  (Production transport uses the browser's own hand-rolled `serializePly`.)
- To read PLY bytes back to a DataTable, use the library's `MemoryReadFileSystem`
  (`.set(name, bytes)` + `.createSource(name)`) then `readFile({...})`. The
  hand-rolled buffer FS (plan Task 5) is UNNECESSARY — Task 5 is SKIPPED.
- `Transform.PLY` survives a PLY round-trip; compare with `back.transform.equals(Transform.PLY)`,
  NOT `===`. The server re-tags the readback table with `Transform.PLY` anyway
  (`run-export.ts`) — correct regardless.
- The float round-trip is bit-exact (parity premise holds — proven by Task 3 test).

## Key architecture facts (so you don't re-derive them)
- **Device creation is hand-rolled in `server/src/gpu.ts`**, NOT imported from the
  library: `@playcanvas/splat-transform` does NOT export `createDevice` (it lives
  only in its CLI bundle). `gpu.ts` mirrors the library's CLI: install the `webgpu`
  (Dawn) globals, stand up a `window`/`document` shim (PlayCanvas reads
  `window.navigator.gpu`/`matchMedia`/`location` during init — assign onto a
  created `window`, NOT `globalThis.navigator` which is a read-only getter on Node),
  build `new WebgpuGraphicsDevice(canvas, { antialias:false })`, set
  `window.navigator.gpu = create([])`, `await device.createDevice()`. A single
  in-flight device promise is shared (no init race).
- **Shared code sharing is via `dist-shared/`** (current strategy, revisit in Task 14):
  `tsconfig.shared.json` + `scripts/build-shared.mjs` compile `src/events.ts` +
  `src/splat-export-core.ts` to **ESM** at repo-root `dist-shared/` (CJS was tried
  and abandoned: installed `playcanvas` is not `require()`-able). The script writes
  `dist-shared/package.json {"type":"module"}`. Server scripts run `build:shared`
  before build/dev/test (`pretest` too).
- **`run-export.ts` loads the shared core via an absolute `file://` URL** resolved
  from `import.meta.url` (`pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '../../dist-shared/splat-export-core.js'))`).
  A bare relative specifier fails under vitest (resolves vs CWD). This works
  identically in vitest and production (both `server/src` and `server/dist` are two
  levels below repo root). Only reached for GPU formats; CPU paths never load it.
- **Server endpoints:** `GET /api/export/capabilities`; `POST /api/export` (multipart
  `ply` + `options`, 202 `{jobId}`); `GET /api/export/:id/events` (SSE — note it
  uses `reply.hijack()` then raw writes, and `subscribe()` replays buffered events
  synchronously so the events handler assigns `let unsub` before subscribing to
  avoid a TDZ hang); `GET /api/export/:id/result` (streams the file).
- **Job model** (`server/src/jobs.ts`): in-memory map, **concurrency-1** GPU queue
  via a promise chain (single shared device), TTL cleanup (`finishedAt` + `unref`).
- **`src/splat-export-core.ts` exports:** `createProgressRenderer`,
  `buildStreamingLodTable`, `writeSogCore`, `writeViewerCore`. Imports ONLY from
  `@playcanvas/splat-transform` and `./events` (DOM-free). `serializeSog`/
  `serializeViewer` in `splat-serialize.ts` are now thin wrappers passing the
  browser's `createGpuDevice`.
- **Server must not morton-reorder** the readback table (the import loader does, but
  export must not — SOG k-means seeding parity).

## How to verify the server quickly
- `( cd server && npm run build )` → zero TS errors.
- `( cd server && npx vitest run )` → all tests pass; the GPU SOG test must RUN
  (not skip) on the 4090.
- Live: `( cd server && node dist/index.js )` then
  `curl -s localhost:3334/api/export/capabilities` →
  `{"enabled":true,"gpu":true,"formats":["ply","compressedPly","splat","sog","htmlViewer","packageViewer"]}`.
  Stop the server afterward.

## Open items / notes
- Share strategy decision pending (Task 14): `dist-shared/` vs npm workspace.
- `@fastify/multipart@^10` is installed (compatible with fastify v5).
- Auth is intentionally absent (Feature A is self-hosted/independent); document
  that the endpoint should sit behind the deployment's own access controls.
- The build script logs a harmless Node `DEP0190` deprecation warning.
