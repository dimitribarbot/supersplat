# Design: Merge upstream v2.29.0→v2.32.2 + splat-transform v3 (Phase 1)

Date: 2026-07-24
Branch: `merge-latest-upstream-commits`
Status: approved (brainstorming) — pending implementation plan

## Goal

Merge the 45 pending upstream `playcanvas/supersplat` commits (current fork base
`v2.28.1` → upstream tip `2.32.2`) into the fork, landing as a **preserved merge
commit**. The merge pulls in a major dependency jump:

- `@playcanvas/splat-transform` `2.7.1` → **`3.1.6`** (breaking: DataTable-centric
  API → source/streaming API — see PR playcanvas/splat-transform#276)
- `playcanvas` `2.20.5` → **`2.21.0`**
- `typescript` `5.x` → **`6.0.3`**

**Non-negotiable:** do not break the fork's custom subsystems — off-limits zones,
portals (+ exported-viewer runtime), splat alignment, collision/voxel export, the
export server byte-parity guarantee, and the exported-viewer runtime fixes
(VR/AR floor grounding, off-limits R-reset, portal reset-scene).

## Phasing

- **Phase 1 (this spec):** merge all upstream diffs + the *smallest* set of
  splat-transform v3 changes needed to keep every custom feature compiling and
  behaving. Prefer v3's compatibility bridges (`writeFile`/`processDataTable`/
  `materializeToDataTable`/`dataTableToChunkSource`) and keep the fork's existing
  DataTable-based flow wherever v3 still exports the symbols it uses.
- **Phase 2 (deferred, separate spec):** full migration of the fork's serialize/
  export paths onto the source/streaming API (`ChunkSource`/`writeSource`/
  `processSource`), dropping the compat bridges. Not in scope here.

## Key leverage

Upstream 2.32.2 has **already migrated its own code to 3.1.6**. Their migrated
`src/splat-serialize.ts`, `src/io/read/loader.ts`, `src/io/read/file-systems.ts`,
and `src/publish.ts` are the authoritative reference for the new API and for every
shared/conflicted file. Fork-only files (below) have no upstream reference and are
migrated by mirroring upstream's patterns.

Confirmed still exported by 3.1.6 (upstream imports them): `MemoryFileSystem`,
`ZipFileSystem`, `ZipReadFileSystem`, `ReadFileSystem`, `UrlReadFileSystem`,
`ReadSource`, `ReadStream`, `BufferedReadStream`, `WebPCodec`, `WorkerQueue`,
`DataTable`, `Column`, `ColumnType`, `Transform`, `Options`, `version`,
`revision`, `readFile`, `getInputFormat`, `sortMortonOrder`, `createChunkDataPool`,
`materializeToDataTable`, `selectLod`, `writeSource`, `logger`, and the
`FileSystem`/`Writer`/`LogEvent`/`ChunkSource`/`ChunkData` types.

**Open items to resolve by inspecting the installed 3.1.6 package before coding**
the fork-only files (they use symbols upstream does not): whether `writeSpz`,
`writeSog`, `writeHtml`, `writeLod`, `writeVoxel`, `writeCompressedPly`,
`processDataTable`, `MemoryReadFileSystem`, and `MemoryFileSystem.files` survive
as-is or need the new `writeSource`(+format options)/`.results` equivalents.

## Conflict inventory (from trial merge — 23 files)

- **Config (3):** `.gitignore`, `package.json`, `package-lock.json`
- **Source (11):** `src/camera.ts`, `src/editor.ts`, `src/file-handler.ts`,
  `src/io/read/loader.ts`, `src/main.ts`, `src/render.ts`, `src/scene.ts`,
  `src/splat-serialize.ts`, `src/ui/bottom-toolbar.ts`, `src/ui/localization.ts`,
  `src/ui/scene-panel.ts`
- **SCSS (1):** `src/ui/scss/select-toolbar.scss`
- **Locales (9):** `de, en, es, fr, ja, ko, pt-BR, ru, zh-CN` (upstream #983
  reorganized locale structure; fork adds portals/off-limits/collision/alignment
  keys)

## Conflict resolution strategy, by class

1. **Config**
   - `package.json`: take upstream dep versions (splat-transform 3.1.6,
     playcanvas 2.21.0, typescript 6.0.3, and upstream's other bumps), keep all
     fork-only deps, scripts, and the `server` glue.
   - `package-lock.json`: regenerate via targeted `npm install` — never delete the
     lockfile (prunes cross-platform binaries on Windows).
   - `.gitignore`: union both sides (upstream #985 added Claude workspace ignores).
   - **Then sync `server/package.json`** to splat-transform 3.1.6 / playcanvas
     2.21.0 and `npm install --prefix server` — the byte-parity guarantee requires
     server and browser to run the same splat-transform writers.

2. **Locales** — rebase fork keys onto upstream's reorganized structure. `en.json`
   is the source of truth for key names/nesting; port fork keys into the new
   layout. Non-en translations machine-assisted and flagged for user review
   (matches the established fork pattern).

3. **SCSS** — union both rule sets.

4. **Source, v3-touching (`splat-serialize.ts`, `loader.ts`)** — take upstream's
   v3-migrated version as the base, then re-apply the fork's customizations
   (portals, collision voxel, SOG/SPZ paths, progress localization).

5. **Source, feature conflicts (`camera.ts`, `scene.ts`, `render.ts`, `main.ts`,
   `editor.ts`, `file-handler.ts`, `bottom-toolbar.ts`, `scene-panel.ts`,
   `localization.ts`)** — keep fork + upstream both; resolve semantically
   (e.g. `render.ts` gains upstream's `WebPCodec`/new render formats while keeping
   the fork's zones/portals debug-hide gate; `camera.ts` keeps the fork's
   `offLimitsLayer.enabled` zoneDepth gate alongside upstream's 2.21 layer changes).

## splat-transform v3 compat pass — fork-only files (no upstream reference)

Adapt minimally, mirroring upstream's migrated patterns, after inspecting 3.1.6:

- `src/splat-export-core.ts` — portal/collision export core: `writeSog`,
  `writeHtml`, `writeLod`, `writeVoxel`, `DataTable`, `Column`, `logger`,
  `processDataTable`.
- `src/portal-upload.ts`, `src/s3-publish.ts`, `src/editor.ts`,
  `src/file-handler.ts` — `MemoryFileSystem.files` → `.results` if renamed.
- `server/src/run-export.ts` — `readFile`, `writeCompressedPly`,
  `MemoryReadFileSystem`, `Transform`.
- Logger API delta if present (`setLogger`/`setQuiet` → `setRenderer(new
  TextRenderer())`/`setVerbosity`).

## Risk gate: `viewer-engine-patch.ts`

The exported viewer applies string-match patches to splat-transform's **baked
engine**, pinned to 2.7.1's engine (**2.20.2**). A patch-count shortfall only
**`console.warn`s** (non-fatal — `splat-export-core.ts:39-40, 800-801`), so the
export never hard-fails. The real risk is silent feature regression: beyond the
two obsolete 2.20.2→2.20.5 gsplat fixes, `viewer-engine-patch.ts` also carries the
fork's **feature** patches (VR/AR floor grounding, off-limits R-reset spawn) that
exact-string-match the baked engine source. 3.1.6 bakes a newer engine
(playcanvas 2.21.0), so those match strings may drift.

Action: retire the two obsolete engine-fix patches; re-verify/re-derive each
feature patch's search string against the 3.1.6 baked engine so VR/AR grounding
and off-limits reset keep working. **This branch requires user E2E on the exported
viewer** — automated tests can't cover it.

## Verification

Run by me (evidence before any "done" claim):
- `npm run lint`
- `npm run build` (release)
- `npm run test` (front-end Vitest)
- `npm run build && npm run test` in `server/` (includes the **byte-parity** test)
- `dist-shared` rebuild sanity (`scripts/build-shared.mjs`)

Run by the user (E2E — out of my reach):
- Every export format: PLY, compressed PLY, `.splat`, SOG, SPZ, HTML viewer,
  package (zip) viewer.
- Portal walkthrough export + streaming viewer; collision export; S3 publish.
- Exported-viewer runtime: VR/AR floor grounding, off-limits R-reset, portal
  reset-scene.

## Explicitly out of scope

- Phase 2 full source-API migration.
- Fixing the pre-existing upstream **SPZ browser-abort** bug (WASM OOM at
  `saveSpzToBuffer`) — do not regress it, do not attempt a fix.
- Any refactor unrelated to making the merge compile and the features work.

## Landing

Single preserved merge commit on `merge-latest-upstream-commits`; do not push.
User does E2E, then decides on merge-to-main/push.
