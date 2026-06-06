# S3 Publish (DigitalOcean Space)

Date: 2026-06-06
Status: Draft (pending user review)

## 1. Summary & scope

Add the ability to **publish a 3DGS viewer experience to an S3-compatible object
store** (DigitalOcean Spaces in the target deployment), **only when the export
server reports S3 is configured** ("server mode"). The published output is the
**viewer package (ZIP) export — unpacked** into a folder on the Space, so it
includes everything the ZIP export produces: the streaming-LOD bundle, collision
voxel data, annotations, animation, etc. The published folder is directly
browsable/streamable from the Space (optionally via CDN).

This is "Feature B" foreshadowed by the server-side export spec
(`2026-05-30-server-side-export-design.md`, section 9): it reuses that feature's
upload + job + SSE engine and the shared export orchestration. The only new piece
is the **terminal sink** — unpack the produced ZIP and upload each file to the
Space — plus a publish dialog and the env-driven S3 configuration.

### In scope
- Publish the **viewer package** export only, with its **full option set**
  (streaming, collision + environment/radius/voxel, animation/loop, background
  color, fov, SH bands).
- A publish dialog adding **Subfolder** (optional), **Name** (required), and a
  **Public/Private** checkbox to those viewer options.
- Upload unpacked files to `<bucket>/<subfolder>/<name>/…`.
- Overwrite detection with a confirmation prompt.
- S3 configuration via a server env file (`server/.env.local`, git-ignored).

### Out of scope
- Publishing other formats (PLY/compressed PLY/`.splat`/SOG/HTML viewer).
- Any change to the existing **superspl.at** publish flow (it remains the
  behaviour in client mode and when the server has no S3 configured).
- Auth/multi-tenant, lifecycle/expiry of published folders, delete-from-UI.

## 2. Decisions (resolved during brainstorming)

- **Output layout:** run the viewer package (ZIP) export exactly as today, then
  **unpack** it and upload each file individually. Streaming requires
  per-file URLs, so a single `.zip` object is rejected.
- **Scope:** viewer package only, full option set ("everything as in the ZIP
  export").
- **Menu:** the existing **Publish…** menu item opens the **S3 dialog when the
  server reports S3 configured**; otherwise it opens the existing superspl.at
  flow, unchanged. In client mode (static server on :3333, no `/api/export`) the
  superspl.at flow runs as today.
- **Overwrite:** detect existing objects under the target prefix and **confirm
  before overwriting**. Upload overwrites object-by-object (no pre-delete).
- **Access:** a **Public/Private checkbox**. Public → upload objects with
  `public-read` ACL and return the public URL. Private → no ACL set; return the
  bucket prefix only (no public link).
- **Env loading:** `dotenv`.

## 3. Architecture overview

```
Browser (client mode :3333)            Browser (server mode :3334)
  Publish… → superspl.at flow            Publish… → S3 publish dialog
  (unchanged)                              │ serialize PLY (browser extraction)
                                           │ gzip
                                           ▼
                                   POST /api/publish  (gz PLY + options + dest)
                                           │
                                   server: createJob(..., publish)
                                           │ GPU worker → output.zip  (UNCHANGED)
                                           │ host: unzip + upload each file to S3
                                           ▼
                                   SSE progress  →  done { url?, prefix }
```

The **GPU worker and shared export core are untouched.** They still produce a
single `output.zip`. The new publish logic lives entirely on the server host
(after the worker returns) and in new client UI/orchestration modules.

### Why unzip-on-host (chosen)
The shared core (`src/splat-export-core.ts`) only ever emits `output.zip`
(`:388`, `:454`) and is shared with the browser ZIP export and locked by parity
tests. Rather than refactor it to emit unpacked files (modifying browser-shared,
parity-tested code), the host **unzips the produced `output.zip` in memory and
uploads each entry**. This keeps the published content byte-identical to the ZIP
export, leaves the worker and core untouched, and confines all publish code to
the server. Cost is one in-memory zip→unzip round trip (negligible).

## 4. Server changes (`server/`)

### 4.1 New dependencies
- `@aws-sdk/client-s3` — S3-compatible client; DigitalOcean Spaces is supported
  via a custom `endpoint` (+ `forcePathStyle` when needed).
- `fflate` — small, synchronous in-memory unzip of the produced `output.zip`.
- `dotenv` — load `server/.env.local` at startup.

Install with targeted `npm install <pkg>` inside `server/` (do **not** regenerate
the lockfile — see project memory on cross-platform binaries).

### 4.2 Configuration & env (`src/s3.ts`, new)
Reads from `process.env` (lazily, after dotenv loads):

| Var | Required | Meaning |
|-----|----------|---------|
| `S3_ENDPOINT` | yes | Origin endpoint for uploads, e.g. `https://fra1.digitaloceanspaces.com` |
| `S3_REGION` | yes | e.g. `fra1` |
| `S3_BUCKET` | yes | Space name |
| `S3_ACCESS_KEY_ID` | yes | Spaces access key |
| `S3_SECRET_ACCESS_KEY` | yes | Spaces secret |
| `S3_PUBLIC_BASE_URL` | no | Base for returned public links — **set to the DigitalOcean CDN endpoint**, e.g. `https://<space>.<region>.cdn.digitaloceanspaces.com`. Fallback if unset: `${S3_ENDPOINT}/${S3_BUCKET}` (origin, path-style). |
| `S3_FORCE_PATH_STYLE` | no | `true`/`false`; default `false`. |

`isConfigured()` = the five required vars are all present and non-empty.

Module surface:
- `isConfigured(): boolean`
- `listPrefix(prefix): Promise<{ count: number }>` — `ListObjectsV2` with
  `MaxKeys: 1` for the overwrite check.
- `publishZip(zipBytes, { prefix, public }, onProgress): Promise<{ url?: string; prefix: string }>`
  — `fflate.unzipSync` the bytes, then for each entry `PutObject` to
  `${prefix}/${entry}` with the right `ContentType` and, when `public`,
  `ACL: 'public-read'`. Emits progress per file. Returns the public URL
  (`${publicBase}/${prefix}/index.html`) only when `public`.

**Content-Type map:** `.html→text/html`, `.js→text/javascript`,
`.css→text/css`, `.json→application/json`, `.wasm→application/wasm`,
`.webp→image/webp`, `.png→image/png`, `.bin/.sog/(default)→application/octet-stream`.

### 4.3 Endpoints (`src/index.ts`)
- Load `dotenv` at the top (before reading env), e.g. `dotenv.config({ path: '.env.local' })`. Tests importing `buildApp` must remain unaffected.
- Extend `GET /api/export/capabilities` response with **`publish: isConfigured()`**.
- `GET /api/publish/exists?subfolder=&name=` → `{ exists: boolean, count: number }`
  (404/400 on bad input; 503 when `!isConfigured()`).
- `POST /api/publish` — multipart: `ply` (gzipped) + `options` JSON. `options`
  carries the viewer export settings **plus** `{ subfolder?, name, public,
  overwrite }`. Validation:
  - `name`: `^[A-Za-z0-9._-]+$`, no `..`.
  - `subfolder` (optional): segments matching the same charset, joined by `/`,
    no `..`, no leading/trailing slash.
  - `503` when `!isConfigured()`.
  - If `!overwrite` and `listPrefix` count > 0 → `409 { error, count }`.
  - Builds an `ExportOptions` with `fileType: 'packageViewer'` from the viewer
    settings, calls `createJob(plyGz, exportOptions, publishDest)`, returns
    `{ jobId }`.
- SSE progress: reuse the existing job machinery. Mount the **same events
  handler** used by `/api/export/:id/events` at `/api/publish/:id/events`
  (extract the handler to avoid duplication). The terminal `done` event carries
  `{ kind: 'done', url?, prefix }`. **No `/result` blob endpoint needed** for
  publish — the result is the URL in the `done` event.

### 4.4 Job layer (`src/jobs.ts`)
- `createJob(plyGz, options, publish?)` gains an optional `publish` destination
  `{ prefix, public }`, where `prefix` is `name` when no subfolder is given, or
  `${subfolder}/${name}` when one is.
- After `runExportViaWorker` resolves with `output.zip`, if `publish` is set the
  job calls `s3.publishZip(zipBytes, publish, onProgress)` **in the main
  process**, stores `job.publishResult`, and the `done` event includes
  `{ url?, prefix }`.
- The GPU worker (`export-worker.ts`, `run-export.ts`, `run-export-worker-host.ts`)
  is **unchanged**.

### 4.5 Docs & ignore
- `server/.env.local.example` documenting all vars.
- `server/README.md`: replace the "Future work" note with a Publish section.
- Root `.gitignore`: add `.env.local` and `*.env.local`.

## 5. Client changes (`src/`)

### 5.1 `export-server-client.ts`
- Add `publish: boolean` to the `Capabilities` type.
- `checkPublishExists(subfolder, name): Promise<{ exists: boolean; count: number }>`.
- `runServerPublish(plyGz, options, onProgress): Promise<{ url?: string; prefix: string }>`
  — POST `/api/publish`, follow `/api/publish/:id/events`, resolve with the
  `done` event's `{ url?, prefix }`. On `409` from POST, throw a typed
  "exists" error so the caller can prompt to overwrite.

### 5.2 `ui/s3-publish-dialog.ts` (new)
A dialog mirroring the export popup's viewer-ZIP rows (streaming, collision +
environment/radius/voxel, animation/loop, background, fov, SH bands), **plus**:
- **Subfolder** text input (optional).
- **Name** text input (required; defaults to the first splat name).
- **Public** boolean toggle (default off).

Returns the assembled viewer `ExperienceSettings`/`viewerExportSettings` (same
shape `assembleViewerOptions` builds in `export-popup.ts`) plus
`{ subfolder, name, public }`, or `null` on cancel.

### 5.3 `s3-publish.ts` (new) — `scene.publishS3`
Orchestration mirroring `writeViaServer` in `file-handler.ts`:
1. Serialize the PLY browser-side (same extraction path), gzip it.
2. `checkPublishExists` → if non-empty, confirm overwrite (cancel aborts).
3. `runServerPublish` with `progressStart/progressUpdate/progressEnd`.
4. Success popup: show the public URL (copyable / link) when public, else the
   bucket prefix. Errors surfaced via the standard error popup.

### 5.4 `ui/editor.ts`
In `show.publishSettingsDialog`, probe capabilities first:
- `capabilities?.publish` → open the S3 dialog and invoke `scene.publishS3`.
- else → existing superspl.at flow (login check + `PublishSettingsDialog`),
  unchanged.

### 5.5 Wiring & i18n
- Register the new module in `src/index.ts`.
- Add localization keys (`popup.publish.s3.*`) to all `static/locales/*.json`
  (English authored; others can mirror English initially).

## 6. Data flow (S3 publish, happy path)

1. User: **Publish…** → (server has S3) S3 dialog → fills options → **Publish**.
2. Client serializes + gzips PLY; `checkPublishExists`; (confirm if needed).
3. `POST /api/publish` → `{ jobId }`.
4. Server job: GPU worker → `output.zip` → host unzips → uploads each file to
   `<bucket>/<prefix>/…` (ACL per `public`), emitting per-file progress over SSE.
5. `done { url?, prefix }` → client shows success with the CDN link (if public).

## 7. Error handling
- `503` if publish requested but S3 not configured (defensive; UI hides it).
- `409` on existing prefix without `overwrite` → client prompts, retries with
  `overwrite: true`.
- Validation errors (`400`) on bad `name`/`subfolder`.
- Upload failure mid-way → job emits `error`; partial objects may remain (no
  rollback in v1; documented). Client shows the error popup.
- Worker/export failure → same `error` path as existing server export.

## 8. Testing
- **`server/test/s3.test.ts`** (new, mocked S3 client): unzip→upload mapping,
  key/prefix construction, content-types, `public-read` ACL toggle, public-URL
  construction (CDN base vs fallback), `listPrefix` exists check.
- **`server/test/publish-routes.test.ts`** (new): capabilities gating
  (`publish` flag), `/api/publish` validation (`name`/`subfolder`, `503`, `409`),
  `/api/publish/exists`. Reuse the existing in-memory job harness; mock `s3.ts`.
- Client logic kept thin; no new heavy client tests beyond existing patterns.
- Existing parity/export tests must remain green (worker/core untouched).

## 9. Open questions / assumptions
- Assumes the Space + CDN already exist and credentials have write access.
- `S3_PUBLIC_BASE_URL` is the documented CDN pointer; without it, links use the
  origin path-style URL (works but not CDN-accelerated).
- No deletion/lifecycle management of published folders in v1.
