# Upstream Merge + splat-transform v3 (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the 45 pending upstream commits (fork base `v2.28.1` → upstream `2.32.2`) into `merge-latest-upstream-commits` as a preserved merge commit, upgrading `@playcanvas/splat-transform` `2.7.1`→`3.1.6`, `playcanvas` `2.20.5`→`2.21.0`, `typescript`→`6.0.3`, without breaking any custom feature.

**Architecture:** Real `git merge --no-commit upstream/main`, then resolve all 23 conflicts + the splat-transform v3 migration in the working tree, verify (lint/build/tests), then create the single merge commit. Upstream 2.32.2 already migrated its own code to 3.1.6, so shared/conflicted files take upstream's migrated version + re-applied fork customizations. Only fork-only code is hand-migrated.

**Tech Stack:** TypeScript, PlayCanvas engine, Rollup, Vitest, Fastify (server), `@playcanvas/splat-transform` 3.1.6.

## Git model (read first)

This lands as **one preserved merge commit**, so there are **no per-task commits**. Each task resolves part of the in-progress merge in the working tree and ends at a verification gate. The **final task** creates the merge commit. If you must checkpoint, use `git stash` — never intermediate commits on the merge. Do **not** push.

## Global Constraints

- Target deps (exact, from upstream `package.json`): `@playcanvas/splat-transform` **3.1.6**, `playcanvas` **2.21.0**, `typescript` **6.0.3**. Apply upstream's other dep bumps too.
- **Sync `server/package.json`** to splat-transform **3.1.6** / playcanvas **2.21.0** — the byte-parity guarantee requires server + browser to run the same writers.
- Never delete `package-lock.json` (prunes cross-platform binaries on Windows). Use targeted `npm install`.
- Prefer Bash (Git Bash). Run commands plainly — no `cd`/`git -C`/`npm --prefix` pointing at cwd (except `--prefix server`, which targets a subdir and is required).
- ESLint 10 crashes on `import/order` autofix — do **not** reorder imports; leave ordering as-is.
- Do **not** attempt to fix the pre-existing upstream SPZ browser-abort bug. Do not regress it.
- Single preserved merge commit; do not push. User runs all E2E.

## Verified v3 API facts (from inspecting the installed 3.1.6 tarball)

All symbols the fork imports **survive in 3.1.6** except `writeLod`. Specifics:

- `MemoryFileSystem` exposes `.results: Map<string, Uint8Array>`. **The fork already uses `.results`** everywhere — no `.files`→`.results` change needed (the `.files` hits in `file-handler.ts`/`doc.ts` are DOM `HTMLInputElement.files`, unrelated).
- `writeSog({ filename, dataTable, bundle, iterations, createDevice?, logging?, indices? }, fs)` — legacy DataTable adapter intact; fork's call matches.
- `writeHtml({ filename, dataTable, viewerSettingsJson?, bundle, iterations, createDevice? }, fs)` — intact; fork's call matches exactly.
- `writeVoxel({ filename, dataTable, voxelResolution?, opacityCutoff?, createDevice?, navExteriorRadius?, navCapsule?, navSeed?, floorFill?, floorFillDilation?, collisionMesh? }, fs)` — intact; fork's call matches.
- `writeCompressedPly({ filename, dataTable }, fs)` — intact (server).
- `writeSpz`, `processDataTable`, `DataTable`, `Column`, `ColumnType`, `combine`, `sortMortonOrder`, `Transform`, `Options`, `version`, `revision`, `WebPCodec`, `WorkerQueue`, `MemoryFileSystem`, `ZipFileSystem`, `ZipReadFileSystem`, `ReadFileSystem`, `UrlReadFileSystem`, `MemoryReadFileSystem`, `ReadStream`, `BufferedReadStream`, `getInputFormat`, `logger`, `TextRenderer`, `createChunkDataPool`, `materializeToDataTable`, `dataTableToChunkSource`, `selectLod`, `stackLods`, `bakeTransform`, `concatSource` — all exported.
- `logger` methods present: `setRenderer(r: Renderer)`, `setVerbosity`, `unwindAll(failed?)`, `group`, `bar`, `info/warn/error/debug`, `output`. Fork already calls `setRenderer`/`unwindAll` — logger usage is forward-compatible; only the `Renderer` interface shape (`handle(event: LogEvent): void`) must match `createProgressRenderer`'s return.
- **`writeLod` REMOVED** → `writeLodSource(options, fs)` where `options = { filename, mainSource: ChunkSource, envSource: ChunkSource | null, iterations, createDevice?, chunkCount, chunkExtent }`. It wants a **structural multi-LOD** `ChunkSource`, not a `lod`-tagged flat `DataTable`.
- `dataTableToChunkSource(dataTable, chunkSize?, indices?) => ChunkSource` (single-LOD).
- `stackLods(sources: ChunkSource[]) => ChunkSource` — asserts: every input single-LOD; inputs share chunk size + SH band count; **transforms must match** ("bake to a common space first"), else use `bakeTransform` per source.
- `readFile(opts) => Promise<ChunkSource[]>` (was `DataTable[]` in 2.7.1) → server must `materializeToDataTable(sources[0], pool)`.

---

### Task 0: Start the merge and land the dependency versions

**Files:**
- Modify: `package.json`, `package-lock.json`, `server/package.json`

**Interfaces:**
- Produces: an in-progress merge with correct dep versions installed; the `dist/`+`node_modules` toolchain on 3.1.6/2.21.0/6.0.3 for all later tasks.

- [ ] **Step 1: Start the real merge (expect conflicts)**

Run: `git merge --no-commit --no-ff upstream/main`
Expected: "Automatic merge failed; fix conflicts" and the 23-file conflict set (3 config, 11 source, 1 scss, 9 locale).

- [ ] **Step 2: Resolve `package.json`**

Take upstream's dependency block (splat-transform 3.1.6, playcanvas 2.21.0, typescript 6.0.3, and every other upstream bump) while keeping all fork-only entries: the `server` glue, any fork scripts, and fork-only deps. Diff the two sides:

Run: `git show :2:package.json > /tmp/pkg.ours; git show :3:package.json > /tmp/pkg.theirs; diff /tmp/pkg.ours /tmp/pkg.theirs`
Then hand-merge: upstream versions win for shared deps; fork-only lines are preserved. `git add package.json`.

- [ ] **Step 3: Sync `server/package.json`**

Set `@playcanvas/splat-transform` to `3.1.6` and `playcanvas` to `2.21.0` in `server/package.json` (byte-parity requirement). (`server/package.json` is fork-only, so it is not a merge conflict — edit it directly.)

- [ ] **Step 4: Regenerate lockfiles via targeted install (never delete the lock)**

Run: `git checkout --theirs package-lock.json 2>/dev/null; npm install`
Then: `npm install --prefix server`
Expected: installs complete; `package-lock.json` updated in place.

- [ ] **Step 5: Verify versions**

Run: `npm ls @playcanvas/splat-transform playcanvas typescript 2>/dev/null | grep -E "splat-transform|playcanvas@|typescript@"`
Expected: `@playcanvas/splat-transform@3.1.6`, `playcanvas@2.21.0`, `typescript@6.0.3`.
Run: `npm ls @playcanvas/splat-transform playcanvas --prefix server 2>/dev/null | grep -E "splat-transform|playcanvas@"`
Expected: `3.1.6` and `2.21.0`.
Then `git add package.json package-lock.json` (server files staged later at finalize).

---

### Task 1: Resolve config + non-code conflicts (.gitignore, scss, locales)

**Files:**
- Modify: `.gitignore`, `src/ui/scss/select-toolbar.scss`, `static/locales/{en,de,es,fr,ja,ko,pt-BR,ru,zh-CN}.json`

**Interfaces:**
- Consumes: `en.json` as the canonical key layout (upstream #983 reorganized locale structure).
- Produces: all locales parse as valid JSON with fork keys present.

- [ ] **Step 1: `.gitignore` — union both sides**

Keep every line from both sides (upstream #985 added Claude workspace ignores; fork may have its own). `git add .gitignore`.

- [ ] **Step 2: `select-toolbar.scss` — union both rule sets**

Take upstream's changes and keep the fork's rules; no rule should be dropped. `git add src/ui/scss/select-toolbar.scss`.

- [ ] **Step 3: Resolve `en.json` — upstream structure + fork keys**

Take upstream's reorganized `en.json` as the base, then port every fork-added key (portals, off-limits zones, collision, alignment, export-progress `export.progress.*`) into the new structure/nesting. Fork keys are the ones absent from upstream `en.json`; find them via:

Run: `git show :1:static/locales/en.json > /tmp/en.base; git show :2:static/locales/en.json > /tmp/en.ours; git show :3:static/locales/en.json > /tmp/en.theirs`
Compare `en.ours` (fork) vs `en.theirs` (upstream) to enumerate fork-only keys, then place them under the new layout. `git add static/locales/en.json`.

- [ ] **Step 4: Resolve the other 8 locales — mirror en.json layout, machine-assist fork keys**

For each of `de,es,fr,ja,ko,pt-BR,ru,zh-CN`: adopt upstream's reorganized structure, then add the fork keys with machine-assisted translations (matching the established fork pattern — flagged for the user's review at finalize). Keep the fork's existing translated values where they already exist. `git add` each.

- [ ] **Step 5: Verify all locales parse**

Run: `for f in static/locales/*.json; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" && echo "OK $f" || echo "BAD $f"; done`
Expected: `OK` for all 9.
Run: `git diff --check`
Expected: no conflict/whitespace markers.

---

### Task 2: Resolve feature-merge source conflicts (no splat-transform API change)

**Files:**
- Modify: `src/camera.ts`, `src/scene.ts`, `src/render.ts`, `src/main.ts`, `src/editor.ts`, `src/file-handler.ts`, `src/ui/bottom-toolbar.ts`, `src/ui/scene-panel.ts`, `src/ui/localization.ts`

**Interfaces:**
- Produces: these files compile against upstream 2.21 APIs while retaining fork behavior. Consumed by the build in Task 6.

For every file below: **keep fork + upstream both** — resolve semantically, never by dropping one side. Specific guidance:

- [ ] **Step 1: `render.ts`** — keep upstream's added `WebPCodec` import and new render formats (PNG/JPEG/WebP/8K/360°) **and** the fork's off-limits/portals debug-hide gate (`scene.offLimitsLayer.enabled` around export). `git add`.

- [ ] **Step 2: `camera.ts`** — keep the fork's `offLimitsLayer.enabled` zoneDepth-pass gate **and** upstream's PlayCanvas 2.21 layer-clear API change (#993 "Use public layer clear API"). `git add`.

- [ ] **Step 3: `scene.ts`** — keep the fork's `offLimitsLayer`/portal render layers **and** upstream's layer/grid-plane changes. `git add`.

- [ ] **Step 4: `main.ts`** — keep the fork's `registerXxxEvents` wiring (portals, off-limits, collision, alignment) + `WorkerQueue` pool handling **and** upstream's new module wiring (Edit menu, Orient tool, Settings panel). `git add`.

- [ ] **Step 5: `editor.ts`** — keep the fork's `select.delete` guard extended to `portals`+`offLimitsZones` **and** upstream's Edit-menu / op-name changes. `git add`.

- [ ] **Step 6: `file-handler.ts`** — keep the fork's import paths + `memFs.results` usage **and** upstream's import changes (LCC2, streamed SOG import). `git add`.

- [ ] **Step 7: `bottom-toolbar.ts`, `scene-panel.ts`, `localization.ts`** — keep the fork's tool buttons + locale list (fork's active languages) **and** upstream's toolbar/scene-panel/localization reorg. `git add` each.

- [ ] **Step 8: Verify no markers remain in this set**

Run: `git diff --check src/camera.ts src/scene.ts src/render.ts src/main.ts src/editor.ts src/file-handler.ts src/ui/bottom-toolbar.ts src/ui/scene-panel.ts src/ui/localization.ts`
Expected: no output (no conflict markers).

---

### Task 3: Migrate browser read/serialize files to v3

**Files:**
- Modify: `src/io/read/loader.ts`, `src/io/read/file-systems.ts`, `src/splat-serialize.ts`, `src/publish.ts`

**Interfaces:**
- Consumes: `readFile => ChunkSource[]`, `materializeToDataTable(src, pool)`, `selectLod(src, level)`, `createChunkDataPool()`.
- Produces: `writeSplatFile`/serialize helpers in `splat-serialize.ts` unchanged in signature for `splat-export-core.ts` (Task 4) and `publish.ts`.

- [ ] **Step 1: `io/read/file-systems.ts` — take upstream's migrated version**

Run: `git checkout --theirs src/io/read/file-systems.ts && git add src/io/read/file-systems.ts`
(Upstream's imports: `BufferedReadStream, ReadFileSystem, ReadSource, ReadStream, UrlReadFileSystem` — all fork-compatible; this file has no fork customization.)

- [ ] **Step 2: `io/read/loader.ts` — upstream base + fork tweaks**

Take upstream's migrated version (uses `readFile`→`materializeToDataTable`+`selectLod`+`createChunkDataPool`, imports `Column, ColumnType, DataTable, Options, ChunkSource, ReadFileSystem, Transform, ZipReadFileSystem`). Re-apply any fork-specific loader tweak (compare `git show :2:src/io/read/loader.ts`). `git add`.

- [ ] **Step 3: `splat-serialize.ts` — upstream base + reapply fork**

The fork's version imports `Column, DataTable, logger, Transform, writeSpz` and calls `writeSogCore/writeViewerCore` from `splat-export-core`. Upstream's version migrated to `writeSource`/`ChunkSource`. **Do not adopt upstream's full source-API rewrite** (that's Phase 2). Instead: resolve the conflict keeping the fork's DataTable-based `serializePly*`/`writeSplatFile`/SOG-extraction logic, adopting only upstream's *non-splat-transform* changes (new settings fields, localization). Confirm the import block still resolves against 3.1.6 (all fork symbols survive). `git add`.

- [ ] **Step 4: `publish.ts` — new logger import**

`publish.ts` was auto-merged but uses `logger`. Confirm it imports `{ logger as splatTransformLogger, type FileSystem, type LogEvent, type Writer }` per upstream and that fork-specific publish logic (portal multi-scene via `portal-upload.ts`) is intact. Adjust the import if needed. `git add`.

- [ ] **Step 5: Typecheck this set**

Run: `npx tsc --noEmit 2>&1 | grep -E "io/read/loader|io/read/file-systems|splat-serialize|publish\.ts" | head`
Expected: no errors referencing these files (errors elsewhere are expected until Task 4/5). Note: full `tsc` may report `splat-export-core.ts`/`run-export.ts` errors — that is fine here.

---

### Task 4: Migrate `splat-export-core.ts` — `writeLod` → `writeLodSource`

**Files:**
- Modify: `src/splat-export-core.ts`

**Interfaces:**
- Consumes: `dataTableToChunkSource(table) => ChunkSource`, `stackLods(sources) => ChunkSource`, `writeLodSource({ filename, mainSource, envSource, iterations, createDevice?, chunkCount, chunkExtent }, fs)`. Optional `bakeTransform` fallback.
- Produces: `buildStreamingLodTable` now returns `{ mainSource: ChunkSource; levelCounts: number[] }` (was `{ table: DataTable; levelCounts }`). Both call sites updated. `writeSogCore`/`writeViewerCore`/`buildStreamingLodTable` exports unchanged in name.

- [ ] **Step 1: Update the import block**

In `src/splat-export-core.ts` imports from `@playcanvas/splat-transform`: **remove** `writeLod`; **add** `writeLodSource`, `dataTableToChunkSource`, `stackLods`. Keep `Column`, `DataTable`, `logger`, `writeHtml`, `writeSog`, `writeVoxel`, and everything else. (Do not reorder existing imports — ESLint constraint.)

- [ ] **Step 2: Reshape `buildStreamingLodTable` to emit a structural multi-LOD source**

Current (`splat-export-core.ts` ~376-427): builds `levels[] = [lod0, decimated1, ...]`, tags each with a `lod` Column, returns `{ table: combine(levels), levelCounts }`. Replace the tagging + `combine` tail (the loop at ~419-421 and the `return`) with:

```ts
    const levelCounts = levels.map(l => l.numRows);
    // v3 writeLodSource wants a STRUCTURAL multi-LOD source (LOD i = detail level i),
    // not a `lod`-tagged flat table. Each decimated level is one single-LOD source;
    // stack them. All levels descend from lod0's Transform.PLY, so they share a
    // coordinate space and stackLods' transform-match assertion holds.
    const mainSource = stackLods(levels.map(l => dataTableToChunkSource(l)));
    return { mainSource, levelCounts };
```

Update the function's return type to `Promise<{ mainSource: ChunkSource; levelCounts: number[] }>` and remove the now-unused `lod`-column tagging loop. Delete the `combine` import if it becomes unused (check other uses first with `grep -n "combine(" src/splat-export-core.ts`).

> If `stackLods` throws a transform-mismatch at runtime (E2E), bake each source to a common space first: `stackLods(levels.map(l => bakeTransform(dataTableToChunkSource(l))))`. Confirm `bakeTransform`'s signature from the installed `.d.ts` before using.

- [ ] **Step 3: Update call site #1 (package/portal-scene branch, ~533-548)**

Replace:
```ts
        const { table: lodTable, levelCounts: counts } = await buildStreamingLodTable(scene.dataTable, createDevice, (info) => { onPhase?.(info, false); });
        levelCounts = counts;
        onPhase?.(PHASES.packagingChunks(), true);
        await writeLod({ filename: '/lod-meta.json', dataTable: lodTable, envDataTable: null, iterations: 10, createDevice, chunkCount: 512, chunkExtent: 16 }, sub);
```
with:
```ts
        const { mainSource, levelCounts: counts } = await buildStreamingLodTable(scene.dataTable, createDevice, (info) => { onPhase?.(info, false); });
        levelCounts = counts;
        onPhase?.(PHASES.packagingChunks(), true);
        await writeLodSource({ filename: '/lod-meta.json', mainSource, envSource: null, iterations: 10, createDevice, chunkCount: 512, chunkExtent: 16 }, sub);
```

- [ ] **Step 4: Update call site #2 (primary streaming branch, ~632-655)**

Replace the `const { table: lodTable, levelCounts: primaryLodCounts } = await buildStreamingLodTable(dataTable, ...)` destructure to `const { mainSource, levelCounts: primaryLodCounts } = ...`, and the `writeLod({ filename: '/lod-meta.json', dataTable: lodTable, envDataTable: null, ... }, memFs)` call to `writeLodSource({ filename: '/lod-meta.json', mainSource, envSource: null, iterations: 10, createDevice, chunkCount: 512, chunkExtent: 16 }, memFs)`. Preserve the existing leading-`/` filename comment.

- [ ] **Step 5: Confirm no remaining `writeLod`/`lodTable` references**

Run: `grep -n "writeLod\b\|lodTable\|envDataTable\|\.table\b" src/splat-export-core.ts`
Expected: no `writeLod(`/`envDataTable`/`lodTable` left (only `writeLodSource`).

- [ ] **Step 6: Typecheck + front-end build**

Run: `npx tsc --noEmit 2>&1 | grep "splat-export-core" | head`
Expected: no errors in `splat-export-core.ts`.
Run: `npm run build 2>&1 | tail -20`
Expected: build succeeds (`dist/` written). `git add src/splat-export-core.ts`.

---

### Task 5: Migrate the export server + rebuild `dist-shared`

**Files:**
- Modify: `server/src/run-export.ts`
- Rebuild: `dist-shared/` via `scripts/build-shared.mjs`

**Interfaces:**
- Consumes: `readFile => Promise<ChunkSource[]>`, `createChunkDataPool()`, `materializeToDataTable(source, pool) => Promise<DataTable>`, `Transform.PLY`.
- Produces: server export producing byte-identical output to a local export (parity test).

- [ ] **Step 1: Migrate `readFile` → DataTable in `run-export.ts`**

Around `run-export.ts:55-95`, `readFile` now returns `ChunkSource[]`, not `DataTable[]`. Replace:
```ts
    const tables = await readFile({ /* ...existing opts... */ });
    const dataTable = tables[0];
    (dataTable as any).transform = Transform.PLY;
```
with:
```ts
    const sources = await readFile({ /* ...existing opts... */ });
    const pool = createChunkDataPool();
    const dataTable = await materializeToDataTable(sources[0], pool);
    (dataTable as any).transform = Transform.PLY;
```
Add `createChunkDataPool, materializeToDataTable` to the `@playcanvas/splat-transform` import in `run-export.ts` (keep `readFile, writeCompressedPly, MemoryFileSystem, MemoryReadFileSystem, Transform`). Verify the `ReadFileOptions` shape the fork passes still matches the 3.1.6 `.d.ts` (adjust field names if the reader options changed). `writeCompressedPly({ filename, dataTable }, memFs)` stays as-is.

- [ ] **Step 2: Rebuild `dist-shared` (server imports the migrated core from here)**

Run: `node scripts/build-shared.mjs && echo "dist-shared OK"`
Expected: `dist-shared/splat-export-core.js` + `events.js` regenerated with the Task 4 changes.

- [ ] **Step 3: Build + parity-test the server**

Run: `npm run build --prefix server 2>&1 | tail -15`
Expected: server TypeScript compiles.
Run: `npm run test --prefix server 2>&1 | tail -30`
Expected: all server tests pass, **including the byte-parity test**. If parity fails, the browser and server writers diverged — stop and diagnose (likely a dep-version mismatch or a writer-options drift), do not proceed.
`git add server/src/run-export.ts server/package.json` (and `server/package-lock.json`).

---

### Task 6: Re-verify `viewer-engine-patch.ts` against the 3.1.6 baked engine

**Files:**
- Modify: `src/viewer-engine-patch.ts`

**Interfaces:**
- Consumes: nothing new. `patchViewerEngine(source) => { source, patched }`, `VIEWER_ENGINE_PATCH_COUNT`.
- Produces: `PATCHES` array whose search strings all match the 3.1.6 baked viewer engine; obsolete engine-fix patches removed. Enforcement is `console.warn` (non-fatal), so this is about feature correctness, not build failure.

- [ ] **Step 1: Retire the two obsolete 2.20.2→2.20.5 gsplat-fix patches**

3.1.6 bakes playcanvas 2.21.0 (≥2.20.5), so the two streaming gsplat fixes described at `viewer-engine-patch.ts:4-5` are already present. Remove those two `PATCHES` entries (the ones whose comments reference the 2.20.5 gsplat streaming fixes). `VIEWER_ENGINE_PATCH_COUNT` auto-updates (`= PATCHES.length`).

- [ ] **Step 2: Re-verify each remaining feature patch's `search` against the real baked bundle**

The feature patches (VR/AR floor grounding via `findCylinderSpawn`/world-Y=0, off-limits R-reset spawn `reseat`) exact-string-match the baked engine source, which changed with 2.21.0. Produce a real baked viewer to diff against: run an HTML viewer export from the app (or the export server) with 3.1.6 installed, capture the pre-patch engine bundle, and for each patch check `out.includes(p.search)`. Where a search string drifted, re-derive `search`/`replace` from the new 2.21.0 engine source, keeping the replacement byte-consistent with the intended behavior. (This step needs a WebGPU device → it is validated during Step 3 / user E2E.)

- [ ] **Step 3: Update the patch-count comment and header**

Update the file header comment (`viewer-engine-patch.ts:4-5, 29-32`) to reference splat-transform 3.1.6 / engine 2.21.0 instead of 2.7.1 / 2.20.2, and note which patches remain (feature-only). `git add src/viewer-engine-patch.ts`.

- [ ] **Step 4: Build gate**

Run: `npm run build 2>&1 | tail -5`
Expected: build succeeds. Runtime correctness of the patches is confirmed by user E2E (Task 7).

---

### Task 7: Full verification, then finalize the merge commit

**Files:**
- Finalize: create the single merge commit.

- [ ] **Step 1: Lint**

Run: `npm run lint 2>&1 | tail -20`
Expected: exit 0 (the eslint.config.mjs SourceCode shim keeps `import/order` from crashing). Fix any new lint errors the merge introduced.

- [ ] **Step 2: Front-end build (release)**

Run: `npm run build 2>&1 | tail -20`
Expected: `dist/` written, no errors.

- [ ] **Step 3: Front-end tests**

Run: `npm run test 2>&1 | tee /tmp/fe-test.log | tail -20`
Expected: all tests pass (portals, alignment-solve, etc.). Redirect to a file — never background/pipe vitest (it hangs).

- [ ] **Step 4: Server build + parity test (re-confirm)**

Run: `npm run build --prefix server 2>&1 | tail -5 && npm run test --prefix server 2>&1 | tail -20`
Expected: pass, including byte-parity.

- [ ] **Step 5: Confirm no unresolved conflicts anywhere**

Run: `git diff --check && git status --short | grep -E "^(UU|AA|DD|U |.U)" || echo "no unmerged paths"`
Expected: `no unmerged paths` and no conflict markers.

- [ ] **Step 6: Stage everything and create the preserved merge commit**

Run: `git add -A`
Run:
```bash
git commit -m "$(cat <<'EOF'
Merge upstream playcanvas/supersplat v2.29.0->v2.32.2 (+splat-transform v3)

Upgrades @playcanvas/splat-transform 2.7.1->3.1.6, playcanvas 2.20.5->2.21.0,
typescript->6.0.3. Phase 1: compat-first v3 migration keeping all custom
features (portals, off-limits, collision, alignment, byte-parity server).
writeLod->writeLodSource via structural multi-LOD stackLods; server readFile
->materializeToDataTable; viewer-engine-patch retargeted to the 3.1.6 engine.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"`
Expected: a merge commit with two parents (`git log -1 --pretty=%P` shows two hashes). Do **not** push.

- [ ] **Step 7: Hand off for E2E**

Report the machine-assisted non-en locale keys for review, and give the user the E2E checklist: every export format (PLY, compressed PLY, `.splat`, SOG, SPZ, HTML viewer, package/zip viewer), portal walkthrough streaming export, collision export, S3 publish, and the exported-viewer runtime (VR/AR floor grounding, off-limits R-reset, portal reset-scene). Phase 2 (full source-API migration) is a separate plan.

---

## Self-Review

**Spec coverage:** deps jump (Task 0), server sync + parity (Task 0/5), conflict classes config/locale/scss (Task 1)/feature-source (Task 2)/v3-read-serialize (Task 3), writeLod migration (Task 4), server readFile migration (Task 5), viewer-engine-patch risk gate (Task 6), verification + single merge commit + E2E handoff (Task 7), Phase-2 deferral (Task 7). All spec sections map to a task.

**Placeholder scan:** No TBD/TODO. The one deliberately execution-time item (re-deriving drifted patch strings, Task 6 Step 2) requires a live WebGPU bake and is explicitly gated on E2E — it is a real instruction, not a placeholder.

**Type consistency:** `buildStreamingLodTable` returns `{ mainSource: ChunkSource; levelCounts }` consistently in Task 4 (definition + both call sites). `writeLodSource` options shape identical at both call sites. `materializeToDataTable(source, pool)` + `createChunkDataPool()` consistent between Task 3 (browser loader) and Task 5 (server). `MemoryFileSystem.results` used consistently (no `.files`).
