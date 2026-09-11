# Upstream v3 Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge `upstream/main` (`0487778`, one commit past `v3.1.1`) into this fork and port the fork's custom subsystems onto upstream v3's WebGPU render path, streaming export pipeline, document format v1, and folder-picker save flow.

**Architecture:** The merge is already materialised on branch `feature/upstream-v3-merge` with 23 conflicted files. Resolution proceeds config-first (to get a typecheckable tree), then four independent subsystem ports, then the WebGPU shader port, then an audit of the files that auto-merged silently. The export path is **bridged, not rewritten**: `@playcanvas/splat-transform@3.4.2` still ships a `DataTable` compat layer, so `splat-export-core.ts` and the server's byte-parity guarantee survive untouched behind a new async `extractDataTable`.

**Tech Stack:** TypeScript, PlayCanvas 2.22.1 (WebGPU/WGSL), PCUI 6.1.4, `@playcanvas/splat-transform` 3.4.2, Rollup, Vitest, Fastify (export server).

**Spec:** `docs/superpowers/specs/2026-09-10-upstream-v3-merge-design.md`

## Global Constraints

- Branch: `feature/upstream-v3-merge`. Backup tag: `backup/pre-upstream-v3-merge` (= `ae9bd67`).
- **The merge has already been committed, with conflict markers still in it.** Commit `b81dbde` is the merge commit; `MERGE_HEAD` is cleared, so ordinary `git commit` works from here on. It deliberately carries unresolved conflict markers in the files owned by Tasks 2-7, because `git commit` refuses while `MERGE_HEAD` exists with unmerged index entries — one commit had to land before the resolution work could be split into reviewable pieces. The branch is squashed into a single commit at Task 12, so no marker-bearing commit ever reaches `main`.
- **Consequence for every task: you will see conflict markers in files you do not own. Leave them completely alone.** Fix markers only in the files your own task names. Touching another task's file means two tasks editing it and a lost edit. As of `b81dbde` the still-marked files are `src/doc.ts` (Task 5), `src/file-handler.ts` and `src/ui/export-popup.ts` (Task 6), `src/io/read/loader.ts` (Task 4), `src/splat-serialize.ts` (Task 3), `src/camera.ts`'s second hunk (Task 7), and the nine `static/locales/*.json` (Task 2).
- Because of the above, **the whole tree does not typecheck until Task 7 lands**, and `npm run test` / `npm run lint` may report pre-existing failures in files you do not own. Report those; do not fix them. Task 10 is the whole-tree gate.
- **`npx tsc -p tsconfig.json --noEmit` is a FALSE CLEAN while any conflict marker remains, and every "tsc clean" gate written into Tasks 3-7 is untrustworthy.** Markers are syntax errors: tsc emits TS1185 and never proceeds to semantic analysis, so it happily reports zero errors for a file containing undefined identifiers. This was found the hard way in Task 3 — plain tsc reported clean for `splat-serialize.ts` while that file still had an undefined `SingleSplat` and 24 reads of the removed `splat.splatData`.

  **Use the real gate instead**, which compiles through the TypeScript compiler API with conflict-marker lines stripped **in memory only** (nothing on disk is touched):

  ```bash
  # per-file gate — the form a task should use; exits non-zero if the file has diagnostics
  node .superpowers/sdd/2026-09-10-upstream-v3-merge/real-typecheck.mjs src/io/read/loader.ts

  # whole-tree overview, error count per file
  node .superpowers/sdd/2026-09-10-upstream-v3-merge/real-typecheck.mjs
  ```

  Wherever a task step says `npx tsc -p tsconfig.json --noEmit 2>&1 | grep ... <file>`, run the real gate on that file instead. Keep the step's pass condition (zero diagnostics for your file).

  **Expect cascade diagnostics you do not own.** Stripping markers keeps *both* sides, so a still-conflicted file reports duplicate identifiers, and files importing from it report `TS2459: declares 'X' locally, but it is not exported`. As of Task 3 these cascades exist and are NOT defects: `src/io/read/index.ts` (4), `src/main.ts` (1), `src/ui/editor.ts` (1) — all downstream of `loader.ts`, `doc.ts` and `export-popup.ts` still being conflicted; and `Property 'order'/'parent' does not exist on type 'ChunkSource'` in `src/splat-serialize.ts` and `src/editor-splat-resource.ts`, because `PermutedChunkSource` re-exported through the conflicted `loader.ts` degrades to the bare `ChunkSource` type. The proof they are cascades: `src/editor-splat-resource.ts` is upstream-owned and untouched by this fork, and shows the identical pair. They all clear when Task 4 resolves `loader.ts`.

  Once the last marker is gone, plain `npx tsc --noEmit` is trustworthy again and Task 10 uses it.
- Merge base is `e060989`. Compute fork ownership against the **merge base**, never against upstream HEAD: `comm -23 <(git ls-files src/|sort) <(git ls-tree -r --name-only e060989 src/|sort)`.
- Editor is **WebGPU-only** (`deviceTypes: ['webgpu']`). Decided; not open for re-litigation.
- Service worker is **removed** (`src/sw.ts` deleted). Decided.
- Dependency floors from upstream: `playcanvas` **2.22.1**, `@playcanvas/splat-transform` **3.4.2**, `@typescript-eslint/*` **8.70.0**, `eslint` **10.10.0**, `autoprefixer` **10.5.5**, `globals` **17.12.0**, `i18next` **26.4.2**, `i18next-http-backend` **4.0.2**, `postcss` **8.5.28**, `rollup` **4.63.1**, `sass` **1.104.0**, plus new `@webgpu/types` **0.1.72**.
- Fork-only dependencies that upstream dropped and we **keep**: `@rollup/plugin-strip` 3.0.4, `cors` 2.8.6, `mediabunny` 1.55.2, `tsx` 4.22.4, `vitest` 4.1.8. Also keep the `"test": "vitest run"` script and `serve dist -C -l 3333`.
- **Never `rm package-lock.json`** — on Windows that prunes cross-platform binaries. Use targeted `npm install <pkg>@<version>`.
- **Never re-run `import/order` autofix.** ESLint 10 crashes on it in this repo. Leave import ordering exactly as the merge produced it.
- Rollup reports TypeScript errors as *warnings*; its exit code lies. Always gate on `grep -c "plugin typescript"` == 0 over captured build output.
- Vitest hangs when backgrounded or piped. Run it in the foreground and redirect to a file; never pipe it to `grep`.
- Do not run `cd`, `git -C`, or `npm --prefix` pointing at the current working directory — it triggers permission prompts. For `server/` work, `cd server` once is fine.
- Do not touch `src/viewer-companion/**` (playcanvas-free, upstream never sees it), `server/**`, `scripts/**`, or `test/**` except where a task says so explicitly.
- Companion HTML templates in `src/viewer-companion/` and the injectors take **no backslash escapes and no backticks** — string ops only.

---

### Task 1: Config, trivial conflicts, and a typecheckable tree

Resolves the 8 mechanical conflicts and installs the new dependency set, so later tasks see real type errors instead of merge markers.

**Files:**
- Modify: `package.json` (1 hunk, line ~31)
- Modify: `package-lock.json` (2 hunks)
- Modify: `README.md` (1 hunk, line ~45)
- Modify: `src/main.ts` (1 hunk, line ~278)
- Modify: `src/scene.ts` (1 hunk, line ~343)
- Modify: `src/camera.ts` (hunk 1 only, line ~359)
- Modify: `src/ui/editor.ts` (1 hunk, line ~175)
- Modify: `src/ui/bottom-toolbar.ts` (2 hunks, lines ~6 and ~474)
- Delete: `src/sw.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a working tree whose only remaining conflict markers are in `src/doc.ts`, `src/file-handler.ts`, `src/io/read/loader.ts`, `src/splat-serialize.ts`, `src/ui/export-popup.ts`, `src/camera.ts` (hunk 2) and the 9 locale files. `npm ci`-equivalent deps installed at the versions in Global Constraints.

- [ ] **Step 1: Resolve `package.json`**

The conflict is purely an ordering artefact — upstream inserted `@playcanvas/splat-transform` before `@playcanvas/pcui`, ours sits after it. Delete the conflict block and bump our existing entry in place. Replace:

```
<<<<<<< HEAD
=======
        "@playcanvas/splat-transform": "3.4.2",
>>>>>>> upstream/main
        "@playcanvas/pcui": "6.1.4",
        "@playcanvas/splat-transform": "3.3.3",
```

with:

```
        "@playcanvas/pcui": "6.1.4",
        "@playcanvas/splat-transform": "3.4.2",
```

Then apply the remaining version floors by hand in the same `devDependencies` block (upstream's side of the auto-merge did not win these because our side changed them too):

```
        "@typescript-eslint/eslint-plugin": "8.70.0",
        "@typescript-eslint/parser": "8.70.0",
        "@webgpu/types": "0.1.72",
        "autoprefixer": "10.5.5",
        "eslint": "10.10.0",
        "globals": "17.12.0",
        "i18next": "26.4.2",
        "i18next-http-backend": "4.0.2",
        "playcanvas": "2.22.1",
        "postcss": "8.5.28",
        "rollup": "4.63.1",
        "sass": "1.104.0",
```

Keep `"version": "3.1.1"` (upstream's), keep `"serve": "serve dist -C -l 3333"`, keep `"test": "vitest run"`, and keep `@rollup/plugin-strip`, `cors`, `mediabunny`, `tsx`, `vitest`.

- [ ] **Step 2: Verify `package.json` parses and has no markers**

Run:
```bash
node -e "const p=require('./package.json');console.log(p.version, p.devDependencies['@playcanvas/splat-transform'], p.devDependencies.playcanvas, p.scripts.test)"
grep -c '^<<<<<<<\|^=======\|^>>>>>>>' package.json
```
Expected: `3.1.1 3.4.2 2.22.1 vitest run` and a count of `0`.

- [ ] **Step 3: Resolve `package-lock.json` by regenerating it in place**

Do **not** hand-merge the lockfile and do **not** delete it. Take our side wholesale, then let npm reconcile:

```bash
git checkout --ours package-lock.json
npm install --package-lock-only
```

- [ ] **Step 4: Install and confirm the resolved versions**

Run:
```bash
npm install
node -e "for (const p of ['playcanvas','@playcanvas/splat-transform','@webgpu/types']) console.log(p, require(p+'/package.json').version)"
```
Expected: `playcanvas 2.22.1`, `@playcanvas/splat-transform 3.4.2`, `@webgpu/types 0.1.72`.

- [ ] **Step 5: Resolve `README.md`**

Upstream changed the dev-server port to 3000 and dropped the service-worker instructions. Our fork serves on **3333** (see the `serve` script we kept) and the SW note is now obsolete. Replace the whole conflict block with just:

```
5. Navigate to `http://localhost:3333`
```

- [ ] **Step 6: Resolve `src/main.ts` — keep both tool registrations and upstream's new constructor args**

Upstream added an `editorUI.annotationContainer.dom` argument to `MeasureTool` and `OrientTool`. Our fork registers five more tools plus the alignment panel and annotation overlay. Take upstream's two lines verbatim and keep all of ours. Replace the conflict block with:

```typescript
    toolManager.register('measure', new MeasureTool(events, scene, editorUI.canvasContainer, editorUI.annotationContainer.dom));
    toolManager.register('orient', new OrientTool(events, scene, editorUI.toolsContainer.dom, editorUI.canvasContainer, editorUI.annotationContainer.dom));
    toolManager.register('annotation', new AnnotationTool(events, scene, editorUI.canvasContainer));
    toolManager.register('offLimitsZones', new OffLimitsZoneTool(events, scene, editorUI.canvasContainer));
    toolManager.register('portals', new PortalTool(events, scene, editorUI.canvasContainer));

    const alignmentManager = new AlignmentManager(events, scene);
    toolManager.register('align', new AlignmentTool(events, scene, alignmentManager, editorUI.canvasContainer));

    const alignmentPanel = new AlignmentPanel(events, scene, alignmentManager);
    editorUI.canvasContainer.append(alignmentPanel);

    /* eslint-disable no-new */
    new AnnotationOverlay(events, scene, editorUI.canvasContainer);
    /* eslint-enable no-new */
```

Note `editorUI.annotationContainer` is an upstream name for the measure/orient label host — it is **not** our annotation feature's container. Do not rename it.

- [ ] **Step 7: Confirm `deviceTypes` took upstream's WebGPU line**

Run:
```bash
grep -n "deviceTypes" src/main.ts
```
Expected: `deviceTypes: ['webgpu'],` — this auto-merged to upstream's side. If it still reads `['webgl2']`, change it to `['webgpu']`.

- [ ] **Step 8: Resolve `src/scene.ts` — both layers**

Both sides append a layer to the same list. Keep both, ours first (it must sit where the fork's zone pass expects it). Replace the conflict block with:

```typescript
        layers.push(this.offLimitsLayer);
        layers.push(this.centersLayer);
```

- [ ] **Step 9: Resolve `src/camera.ts` hunk 1 — both layer ids**

Same shape. Replace the conflict block at ~line 359 with:

```typescript
            scene.offLimitsLayer.id,
            scene.centersLayer.id,
```

Leave the second `camera.ts` conflict (the zone/gizmo pass, ~line 623) alone — Task 7 owns it.

- [ ] **Step 10: Resolve `src/ui/editor.ts` — both additions**

Ours declares the video-render freeze flag; upstream appends three option popups. Independent. Replace the conflict block with:

```typescript
        // Set while a video render is showing a still of the view (see
        // view.freeze below). Camera-driven overlays hold their positions rather
        // than tracking the animating render camera.
        let viewFrozen = false;

        // the option popups come after the toolbars so their select dropdowns,
        // which can extend past the panel bounds, paint above them
        canvasContainer.append(settingsPanel);
        canvasContainer.append(appearancePanel);
        canvasContainer.append(overlaysPanel);
```

Ordering matters here: overlays stack by DOM order in this editor (there is no `z-index` anywhere), so the popups must stay appended after the toolbars, exactly as upstream wrote them.

- [ ] **Step 11: Resolve `src/ui/bottom-toolbar.ts` hunk 1 — keep both imports**

Replace the conflict block at ~line 6 with:

```typescript
import { MenuPanel } from './menu-panel';
import alignSvg from './svg/align.svg';
import annotationsSvg from './svg/annotations.svg';
```

- [ ] **Step 12: Resolve `src/ui/bottom-toolbar.ts` hunk 2 — keep our active-class lines**

Upstream deleted the per-button `active` toggling because `2466a4d` moved the selection tools into press-and-hold `MenuPanel` popups. Our five buttons (`align`, `annotation`, `offLimits`, `portals`, `eyedropper`) are **not** in those popups, so their toggling must survive. Replace the conflict block at ~line 474 with our side only:

```typescript
            align.class[toolName === 'align' ? 'add' : 'remove']('active');
            annotation.class[toolName === 'annotation' ? 'add' : 'remove']('active');
            offLimits.class[toolName === 'offLimitsZones' ? 'add' : 'remove']('active');
            portals.class[toolName === 'portals' ? 'add' : 'remove']('active');
```

Drop the `eyedropper` line — upstream moved the eyedropper into a selection-tool popup, so the `eyedropper` local no longer exists. Confirm with `grep -n "eyedropper" src/ui/bottom-toolbar.ts`; if the identifier is still declared in the merged file, keep its line too.

- [ ] **Step 13: Accept the service worker deletion**

Run:
```bash
git rm src/sw.ts
grep -rn "sw.ts\|serviceWorker\|service-worker" rollup.config.mjs src/index.html src/index.ts 2>/dev/null
```
Expected: `rollup.config.mjs` has no `sw` output (upstream removed it and we never touched that file, so it auto-merged), and `src/index.html` contains upstream's `unregister` call rather than a `register` call. If a `register` call survives, remove it.

- [ ] **Step 14: Confirm the remaining conflict set is exactly the expected six + nine**

Run:
```bash
git status --porcelain | awk '/^(UU|UD|DU|AA|AU|UA|DD)/{print $2}' | sort
```
Expected exactly:
```
src/doc.ts
src/file-handler.ts
src/io/read/loader.ts
src/splat-serialize.ts
src/ui/export-popup.ts
static/locales/de.json
static/locales/en.json
static/locales/es.json
static/locales/fr.json
static/locales/ja.json
static/locales/ko.json
static/locales/pt-BR.json
static/locales/ru.json
static/locales/zh-CN.json
```
`src/camera.ts` should also still be listed until Task 7 resolves its second hunk — that is expected. Everything else from Step 14's list being absent means Steps 1-13 landed.

- [ ] **Step 15: Commit the mechanical resolutions**

```bash
git add package.json package-lock.json README.md src/main.ts src/scene.ts src/ui/editor.ts src/ui/bottom-toolbar.ts
git commit -m "merge(wip): resolve config and trivial conflicts, drop service worker" --no-verify
```

`--no-verify` because the tree still has conflict markers in six files and any pre-commit lint would fail on them. This is a work-in-progress commit on a branch that will be squashed at the end.

---

### Task 2: Locale conflicts across nine files

Nine locale JSONs, 15 conflict hunks each in `en.json`, 13 in the others. Upstream added keys for the new toolbar popups, appearance/overlays panels, folder picker and shortcuts popup; removed the service-worker and LOD-upload strings. Ours added the annotation, portal, off-limits, alignment, collision and server-export strings.

**Files:**
- Modify: `static/locales/en.json`, `de.json`, `es.json`, `fr.json`, `ja.json`, `ko.json`, `pt-BR.json`, `ru.json`, `zh-CN.json`

**Interfaces:**
- Consumes: nothing.
- Produces: nine parseable JSON files whose key sets are identical, verified by `npm run lint:locales`.

- [ ] **Step 1: Resolve `en.json` first, union-style**

Every hunk here is "upstream added keys / we added keys" in the same alphabetical neighbourhood. For each of the 15 hunks, keep **both** sides' keys, sorted the way the surrounding file is sorted. The one class of hunk that is not a union: keys upstream **deleted**. Take the deletion for these two, both now dead:

- `popup.lod-upload-note` — 0 source references (already noted as dead in project memory); upstream removed it and `asset-loader.ts` no longer reads it.
- any `sw.*` / service-worker key — the worker is gone.

Do **not** delete a key merely because upstream did, without first checking it has no reference in our tree:
```bash
grep -rn "'<key>'\|\"<key>\"" src/ | head
```

- [ ] **Step 2: Verify `en.json` parses**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('static/locales/en.json','utf8'));console.log('ok')"
```
Expected: `ok`.

- [ ] **Step 3: Resolve the eight remaining locales the same way**

Apply the identical union decision per file. Upstream's new keys arrive already translated in all nine locales (upstream ships translations), and ours are already translated from the `ae9bd67` annotation-translations work — so this is mechanical, not a translation task. Where upstream added a key that has no translation in a given locale, take upstream's value verbatim rather than inventing one.

**Do not edit these files with a script that writes bare `\n`.** Scripted locale edits in this repo have previously injected bare LF into CRLF files and corrupted them. Edit them as text, preserving each file's existing line endings.

- [ ] **Step 4: Verify all nine parse and agree on keys**

Run:
```bash
for f in static/locales/*.json; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" || echo "BAD $f"; done
npm run lint:locales
```
Expected: no `BAD` lines, and `lint:locales` reports no missing or extra keys.

- [ ] **Step 5: Commit**

```bash
git add static/locales
git commit -m "merge(wip): union-resolve locale keys across nine locales" --no-verify
```

---

### Task 3: Bridge the export path onto v3's ChunkSource pipeline

The largest port. `splat-serialize.ts` is fork +867/−175 against a file upstream rewrote +363/−344, and `splat.splatData` — our data access route in ~24 places — no longer exists.

**Files:**
- Modify: `src/splat-serialize.ts` (4 conflict hunks, then a body rewrite)
- Read only, do not modify: `src/splat-export-core.ts`, `server/src/run-export.ts`

**Interfaces:**
- Consumes: upstream's `createExportSource(splats, settings): Promise<{ source: ChunkSource, pool: ChunkDataPool } | null>`, `writeSplatFile(splats, settings, outputFormat, filename, options, fs): Promise<void>`, `SuperSplatChunkSource`, `filteredIndices(splat, settings)`, all already present in the merged file's upstream side.
- Produces: `extractDataTable(splats: Splat[], settings: SerializeSettings): Promise<DataTable>` — **now async**. Consumed by `serializeViewer`, `serializeViewerSettings`, `serializeSog`, and via `splat-export-core.ts`'s `loadDataTable: () => Promise<DataTable>` thunk (which was already Promise-typed, so it needs no change).

- [ ] **Step 1: Resolve hunk 1 (~line 26) — keep both type imports**

Ours extends upstream's `ExperienceSettings` with post-effect and camera-pose fields. Replace the conflict block with:

```typescript
    type CameraPose,
    type ExperienceSettings as BaseExperienceSettings,
    type PostEffectSettings
```

Then confirm our local `type ExperienceSettings = BaseExperienceSettings & {...}` alias survived the merge further down the file:
```bash
grep -n "BaseExperienceSettings" src/splat-serialize.ts
```
Expected: two hits — the import and the alias. If upstream's `type ExperienceSettings` import won somewhere else in the file, our alias will collide; the alias is the one to keep.

- [ ] **Step 2: Resolve hunk 2 (~line 48) — keep all three imports**

Replace the conflict block with:

```typescript
import { groupInstancesByChunk } from './gaussian-instances';
import { PermutedChunkSource, ProgressWriter } from './io';
```

`ProgressWriter` is ours (it drives the export progress bar); `PermutedChunkSource` and `groupInstancesByChunk` are upstream's, needed by `writeResourceFile` and `SuperSplatChunkSource`. Verify `ProgressWriter` is still exported from `./io`:
```bash
grep -rn "ProgressWriter" src/io/index.ts src/io/write/*.ts | head
```

- [ ] **Step 3: Resolve hunk 3 (~line 65) — take upstream's comment**

Upstream's wording is now the accurate one (`keepStateData` is accepted but never exported by the streaming writers). Replace the conflict block with upstream's side:

```typescript
    // the following options are used when serializing for document save.
    // keepWorldTransform flows through the streaming source; keepStateData
    // is accepted for compatibility but the streaming writers never export state.
```

- [ ] **Step 4: Resolve hunk 4 (~line 114) — take upstream's side, deleting our DataTable machinery**

This hunk spans ~140 lines of ours: `generatedByString`, `GaussianFilter`, `countGaussians`, `getVertexProperties`, `getCommonPropNames`, `getCommonProps`, `shNames`, `calcSHBands`, `DataType`, `DataTypeSize`, and the `v`/`q` scratch statics. Upstream's side is two lines.

Take **upstream's side**, then re-add only `generatedByString`, which our viewer export still stamps into the HTML. Replace the whole conflict block with:

```typescript
const shBandCoeffs = [0, 3, 8, 15];

const generatedByString = `Generated by SuperSplat ${version}`;

```

Everything else in that block is superseded: upstream's `filteredIndices` implements the same selected/minOpacity/removeInvalid filter, and `SuperSplatChunkSource` carries the SH-band and column derivation.

- [ ] **Step 5: Verify the conflict markers are gone and see the real damage**

Run:
```bash
grep -c '^<<<<<<<\|^=======\|^>>>>>>>' src/splat-serialize.ts
npx tsc -p tsconfig.json --noEmit 2>&1 | grep "splat-serialize" | head -40
```
Expected: marker count `0`, and a list of errors concentrated in the functions listed in Step 6. Capture this list — it is the work queue for the rest of this task.

- [ ] **Step 6: Delete our superseded serializers**

Our hand-rolled `serializePly`, `serializePlyCompressed`, `serializeSplat`, `CompressedIndex`, `Chunk` and `sortSplats` are all built on `splat.splatData` and are replaced by upstream's single `writeSplatFile`. Delete them, and delete any now-unused imports they leave behind (`Vec3`, `Quat`, `GSplatData`, `State`, `sigmoid` may all go — let `tsc` and `npm run lint` tell you which).

Then find the callers:
```bash
grep -rn "serializePly\|serializePlyCompressed\|serializeSplat\b" src/ | grep -v splat-serialize.ts
```

**This task edits `src/splat-serialize.ts` only.** Callers in `src/file-handler.ts` and `src/ui/export-popup.ts` belong to Task 6, which reconciles both files against upstream's `WriteTarget` rework and has the context to route each call correctly. **Do not edit those two files** — list every call site you found in your report instead, with the format each one needs, and Task 6 will fix them. Callers in any other file are yours to fix here.

Each call site becomes `writeSplatFile(splats, settings, '<outputFormat>', filename, options, fs)`. The `outputFormat` values are splat-transform's own `OutputFormat` union, verified against `node_modules/@playcanvas/splat-transform/dist/lib/write.d.ts`:

| Our old serializer | `outputFormat` to pass |
| --- | --- |
| `serializePly` | `'ply'` |
| `serializePlyCompressed` | `'compressed-ply'` |
| `serializeSplat` | `'splat'` |

`'compressed-ply'` is a distinct format value, **not** an `Options` flag — `ply`, `sog` and `compressed-ply` are the three formats with a streaming writer that consume a `ChunkSource` directly. Note also that upstream's existing calls use `'sog-bundle'` (single `.sog` file) and `'html-bundle'` / `'html'`; do not assume a bare `'sog'` where a bundle is meant. Cross-check every value you pass against that `OutputFormat` union rather than inferring it from our old function names.

Because of this split, the whole tree will not typecheck until Task 6 lands. That is expected — six files still carry conflict markers at this point anyway. Step 10's gate is `splat-serialize.ts` alone.

- [ ] **Step 7: Rewrite `extractDataTable` as an async bridge**

This is the keystone. Our `extractDataTable` walked `splat.splatData` column by column; replace its body with upstream's source pipeline plus splat-transform's compat materializer. The new implementation, replacing the existing one at ~line 1494:

```typescript
/**
 * Extract Splat data into a DataTable for use with splat-transform's
 * DataTable-only writers and with splat-export-core.
 *
 * v3 removed `splat.splatData`, so this is now a bridge rather than a walk:
 * upstream's SuperSplatChunkSource applies the export filter and presents the
 * gaussians as a ChunkSource, and splat-transform's compat layer materializes
 * that into the columnar DataTable our export core and the export server both
 * still speak. Keeping the DataTable contract is what preserves byte parity
 * with the server -- both sides run the same writers over the same table.
 *
 * Async because building the source reads GPU-resident instance data back.
 */
const extractDataTable = async (splats: Splat[], settings: SerializeSettings): Promise<DataTable> => {
    const built = await createExportSource(splats, settings);
    if (!built) {
        // no gaussians passed the filter -- hand back an empty table rather than
        // null so callers keep their existing non-null contract
        return new DataTable([], Transform.PLY);
    }
    const { source, pool } = built;
    try {
        return await materializeToDataTable(source, pool);
    } finally {
        await source.close();
        pool.destroy();
    }
};
```

Add `materializeToDataTable` to the `@playcanvas/splat-transform` import list at the top of the file (`DataTable` and `Transform` are already imported).

- [ ] **Step 8: Await every `extractDataTable` call**

Find them:
```bash
grep -rn "extractDataTable" src/ | grep -v "^src/splat-serialize.ts:.*const extractDataTable"
```
There are five call sites in `splat-serialize.ts` (in `serializeViewer`, `serializeViewerSettings`, `serializeSog` and the per-scene portal thunk) plus the comment reference in `collision-voxel-options.ts`. Each becomes `await extractDataTable(...)`; all five are already inside `async` functions, so no signature changes ripple outward.

The one that needs care is the portal per-scene thunk, which previously exploited synchrony:

```typescript
            // extractDataTable is synchronous; wrap rather than `async` so the
            // thunk still matches loadDataTable's Promise contract without
            loadDataTable: () => Promise.resolve(extractDataTable([entry.splat], serializeSettings))
```

becomes simply:

```typescript
            loadDataTable: () => extractDataTable([entry.splat], serializeSettings)
```

The comment above it is now wrong — delete those three comment lines. This keeps `splat-export-core.ts`'s lazy per-scene extraction intact (one `DataTable` resident at a time), which is what holds portal viewer export at ~1× memory instead of ~4.7 GB.

- [ ] **Step 9: Fix the remaining `splat.splatData` readers**

From the Step 5 error list, the sites outside `extractDataTable` that read `splat.splatData` are in our collision/portal seeding and SH-band counting paths. Two replacement patterns:

- **Counting gaussians that pass the filter** — was `for (i) if (filter.test(i))`. Use upstream's `filteredIndices`:
  ```typescript
  const indices = await filteredIndices(splat, settings);
  const count = indices.length;
  ```
- **SH band count** — was `calcSHBands(getVertexProperties(s.splatData))`. Read it off the source metadata instead:
  ```typescript
  const built = await createExportSource([splat], settings);
  const bands = built?.source.meta.shBands ?? 0;
  ```
  Prefer hoisting one `createExportSource` per export and reading `meta.shBands` from it, rather than building a source per splat just to count bands.

- [ ] **Step 10: Typecheck `splat-serialize.ts` clean**

Run:
```bash
npx tsc -p tsconfig.json --noEmit 2>&1 | grep -c "splat-serialize"
```
Expected: `0`.

- [ ] **Step 11: Confirm `splat-export-core.ts` was not modified**

Run:
```bash
git diff --stat HEAD -- src/splat-export-core.ts
```
Expected: **empty output**. If this file changed, the bridge is in the wrong place — the whole point is that the export core and therefore the server's byte-parity guarantee stay untouched. Revert it and move the change into `splat-serialize.ts`.

- [ ] **Step 12: Commit**

```bash
git add src/splat-serialize.ts
git commit -m "merge(wip): bridge export path onto v3 ChunkSource via DataTable compat layer" --no-verify
```

---

### Task 4: Restore the LCC environment merge in the streaming loader

v3's `loadSplatSource` returns a `ChunkSource`; our LCC skybox restore was written against `DataTable` + `combine()`, which is no longer reachable without materializing the whole scene — forfeiting v3's streaming memory win on exactly the largest files.

**Do not hand-write a source combinator.** `@playcanvas/splat-transform@3.4.2` publicly exports `concatSource(allSources: ChunkSource[], pool: ChunkDataPool): ChunkSource` from its `ops` module — a lazy end-to-end concatenation that block-copies contiguous spans rather than gathering per row, with peak extra memory of one source chunk-set. It is exactly this job.

Its precondition is the whole difficulty: *"Every source must agree on layout (chunk size, SH bands, available layers, extra columns) and on the pending coordinate-space **transform** — concatenating data in mismatched spaces is silently wrong, so a transform mismatch throws."* Our environment table does **not** agree out of the box: upstream's chunked LCC reader maps the LCC normals (`nx`/`ny`/`nz`) to `other`-layer extra columns, and the environment has no normals — the old `combine()` zero-filled them for us. `concatSource` will throw instead.

`src/io/read/lcc-environment.ts` is still required — splat-transform's own `readLccEnvironmentSource` exists but is marked `@ignore` and is **not** in the package's public export list, so we cannot call it.

**Files:**
- Modify: `src/io/read/loader.ts` (2 conflict hunks)
- Modify: `src/io/read/lcc-environment.ts` (align its output table with the scene source)
- Create: `test/lcc-environment-concat.test.ts`

**Interfaces:**
- Consumes: `concatSource`, `dataTableToChunkSource`, `createChunkDataPool`, `materializeToDataTable`, `Transform` from `@playcanvas/splat-transform`; `readLccEnvironment(fileSystem, filename): Promise<DataTable | null>` from `./lcc-environment`; upstream's local `mortonOrderSource` and `PermutedChunkSource` in `loader.ts`.
- Produces: no new exported symbol. `loadSplatSource` keeps its `{ source: ChunkSource, transform: Transform }` return shape; the environment is folded into `source`.

- [ ] **Step 1: Establish which composition order works, with a test**

`mortonOrderSource(source)` wraps its argument in `PermutedChunkSource`, whose `read` converts **every** request — chunk requests included — into a `{indices, indexOffset, count}` gather on its parent (read it in the merged `src/io/read/loader.ts`). `concatSource`'s documentation describes only chunk-range stitching, so whether it implements the gather arm is unknown and cannot be assumed: splat-transform's `ChunkSource` contract says every source must serve both selections, but a combinator that throws would fail at load on every `.lcc` file.

Settle it mechanically rather than by reading. Create `test/lcc-environment-concat.test.ts`:

```typescript
import {
    Column,
    DataTable,
    concatSource,
    createChunkDataPool,
    dataTableToChunkSource,
    materializeToDataTable
} from '@playcanvas/splat-transform';
import { describe, expect, it } from 'vitest';

const CHUNK = 256;

// a minimal table of `xs.length` gaussians, x taken from `xs`
const makeTable = (xs: number[]) => {
    const n = xs.length;
    const col = (name: string, fill: number) => new Column(name, new Float32Array(n).fill(fill));
    return new DataTable([
        new Column('x', new Float32Array(xs)),
        col('y', 0), col('z', 0),
        col('scale_0', -3), col('scale_1', -3), col('scale_2', -3),
        col('rot_0', 1), col('rot_1', 0), col('rot_2', 0), col('rot_3', 0),
        col('f_dc_0', 0), col('f_dc_1', 0), col('f_dc_2', 0),
        col('opacity', 4)
    ]);
};

const xsOf = async (source: ReturnType<typeof concatSource>) => {
    const pool = createChunkDataPool({ chunkSize: source.meta.chunkSize });
    try {
        const table = await materializeToDataTable(source, pool);
        return Array.from(table.getColumnByName('x').data as Float32Array);
    } finally {
        pool.destroy();
    }
};

describe('concatSource over a scene plus an environment table', () => {
    it('presents scene rows then environment rows, in order', async () => {
        const pool = createChunkDataPool({ chunkSize: CHUNK });
        const scene = dataTableToChunkSource(makeTable([1, 2, 3]), CHUNK);
        const env = dataTableToChunkSource(makeTable([4, 5]), CHUNK);
        const combined = concatSource([scene, env], pool);
        expect(combined.meta.numGaussians).toBe(5);
        expect(await xsOf(combined)).toEqual([1, 2, 3, 4, 5]);
        pool.destroy();
    });

    it('throws when the two sources disagree on extra columns', () => {
        const pool = createChunkDataPool({ chunkSize: CHUNK });
        const withNormals = makeTable([1, 2, 3]);
        withNormals.columns.push(new Column('nx', new Float32Array(3)));
        const scene = dataTableToChunkSource(withNormals, CHUNK);
        const env = dataTableToChunkSource(makeTable([4, 5]), CHUNK);
        expect(() => concatSource([scene, env], pool)).toThrow();
        pool.destroy();
    });

    it('survives being wrapped in a gather-issuing permutation', async () => {
        const pool = createChunkDataPool({ chunkSize: CHUNK });
        const scene = dataTableToChunkSource(makeTable([1, 2, 3]), CHUNK);
        const env = dataTableToChunkSource(makeTable([4, 5]), CHUNK);
        const combined = concatSource([scene, env], pool);
        const order = new Uint32Array([4, 0, 3, 1, 2]);
        const gathered = await materializeToDataTable(
            { meta: { ...combined.meta, numGaussians: order.length, numLods: 1, lodCounts: [order.length], numChunks: [1] },
              read: (r: any) => combined.read('indices' in r ? r : { ...r, indices: order, indexOffset: 0, count: order.length }),
              close: () => combined.close() } as any,
            createChunkDataPool({ chunkSize: CHUNK })
        );
        expect(Array.from(gathered.getColumnByName('x').data as Float32Array).slice(0, 5)).toEqual([5, 1, 4, 2, 3]);
        pool.destroy();
    });
});
```

The exact `Column` / `DataTable` constructor and accessor names above were written from `src/io/read/lcc-environment.ts`'s existing usage, **not** verified against 3.4.2's type definitions. **Adjust the mechanics to the real API** — read `node_modules/@playcanvas/splat-transform/dist/lib/data-table/*.d.ts` and `dist/lib/ops/concat-source.d.ts`. What must not change is what the three tests assert: order preservation, the extra-column mismatch throwing, and whether a gather survives the concat.

- [ ] **Step 2: Run the test and read the third case's verdict**

Run:
```bash
npx vitest run test/lcc-environment-concat.test.ts > /tmp/concat.log 2>&1; tail -40 /tmp/concat.log
```

The first two tests must pass. **The third test decides Step 5's composition order:**
- **Third test passes** — `concatSource` serves gathers. Compose `mortonOrderSource(concatSource([scene, env], pool))`, i.e. concat **before** morton ordering. This reproduces the pre-v3 behaviour exactly, where `combine()` ran before `sortMortonOrder`, so the skybox was reordered along with the scene.
- **Third test fails** — `concatSource` is chunk-read-only. Compose `concatSource([mortonOrderSource(scene), env], pool)`, i.e. concat **after** morton ordering, leaving the environment as an unsorted tail. Change the third test to assert the throw (`expect(...).rejects.toThrow()`) so it documents the limitation instead of asserting a capability that does not exist, and add a comment in `loader.ts` saying why the order is what it is.

Either way the environment renders; morton order is a render-locality optimisation, and the environment chunk is small. Record which branch you took in your report — it is the one piece of this task a reviewer cannot infer from the diff.

Redirect Vitest to a file. It hangs in this repo when its output is piped.

- [ ] **Step 3: Align the environment table with the scene source's columns**

Test 2 in Step 1 proves the failure mode: the scene source carries the LCC normals as `other`-layer extras and the environment has none, so `concatSource` throws. The old `combine()` zero-filled absent columns; nothing does that now, so `lcc-environment.ts` must emit them.

In `src/io/read/lcc-environment.ts`, at the point where `deserializeEnvironment` builds its `columns` array (~line 179, `return new DataTable(columns);`), append zero-filled `nx`, `ny`, `nz` columns whenever the caller says the scene has them. Thread a parameter through `readLccEnvironment` rather than hard-coding it — LCC2 environments may differ from LCC v1:

```typescript
// concatSource requires both sources to agree on their extra columns, and the
// scene source carries the LCC normals as `other`-layer extras. The environment
// has no normals -- the pre-v3 combine() zero-filled them for us, so do it here.
for (const name of extraColumns) {
    if (!columns.some(c => c.name === name)) {
        columns.push(new Column(name, new Float32Array(numRows)));
    }
}
```

Read `extraColumns` off the scene source in `loader.ts` as `source.meta.extraColumns.map(c => c.name)` and pass it in. Do **not** change `readLccEnvironment`'s `Promise<DataTable | null>` return type.

- [ ] **Step 4: Resolve `loader.ts` hunk 1 — merge the import lists**

Take upstream's list and add what the environment path needs. Read upstream's exact list first:
```bash
git show upstream/main:src/io/read/loader.ts | sed -n '5,21p'
```
Then resolve the conflict block at ~line 6 to that list plus `concatSource` and `dataTableToChunkSource`, keeping the file's existing alphabetical-within-group ordering. Drop `DataTable`, `combine`, `Column`, `ColumnType`, `selectLod` if the new body does not use them — `tsc` and `npm run lint` will tell you which are unused. Do not reorder the import groups themselves.

- [ ] **Step 5: Resolve `loader.ts` hunk 2 — take upstream's body, re-inserting the environment concat**

Upstream's side is the new `try { ... } catch` around morton ordering; ours is the old `DataTable` path plus `validateGSplatData`, all superseded. Take **upstream's side**, then insert the environment concat at the position Step 2 determined. Written for the concat-before-morton branch:

```typescript
    try {
        validateSplatSource(source);

        // Restore the LCC/LCC2 environment (skybox) splats. v3's streaming LCC
        // readers exclude the environment chunk (splat-transform's own
        // readLccEnvironmentSource is not publicly exported), so we decode it
        // ourselves and concatenate it on. Best-effort: readLccEnvironment
        // returns null when there is no skybox or it can't be decoded.
        if (lowerFilename.endsWith('.lcc') || lowerFilename.endsWith('.lcc2')) {
            const envTable = await readLccEnvironment(
                fileSystem, filename, source.meta.extraColumns.map(c => c.name)
            );
            if (envTable) {
                const pool = createChunkDataPool({ chunkSize: source.meta.chunkSize });
                const envSource = dataTableToChunkSource(envTable, source.meta.chunkSize);
                source = concatSource([source, envSource], pool);
            }
        }

        const isCompressedPly = lowerFilename.endsWith('.compressed.ply');
        if (inputFormat !== 'sog' && !isCompressedPly && !skipReorder) {
            source = await mortonOrderSource(source);
        }

        return { source, transform: source.meta.transform };
    } catch (err) {
        await source.close();
        throw err;
    }
```

For the concat-after-morton branch, move the `if (lowerFilename.endsWith('.lcc')...)` block to sit **after** the morton-order block, and replace its `concatSource([source, envSource], pool)` with the same call — `source` is by then the permuted source.

Two things to get right in either branch:
- `concatSource` needs a pool whose `chunkSize` **matches the sources'**. Build it from `source.meta.chunkSize`, and pass that same value as `dataTableToChunkSource`'s second argument so the env source agrees.
- That pool must outlive the returned source, because `concatSource` reads through it lazily. Do **not** `pool.destroy()` inside this function. Note in your report that the pool is intentionally leaked for the source's lifetime, and whether `loadSplatSource`'s callers have a teardown hook that could own it.

Add the local imports at the top of the file, in the local-import group after the splat-transform group, matching the file's existing grouping:

```typescript
import { readLccEnvironment } from './lcc-environment';
```

- [ ] **Step 6: Confirm `lcc-environment.ts` compiles against 3.4.2**

Run:
```bash
npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E "lcc-environment|io/read/loader"
```
Expected: no output. The file uses `DataTable`, `Column`, `ColumnType`, `materializeToDataTable` and `createChunkDataPool`, all of which 3.4.2 still exports. If it reports errors, fix them inside `lcc-environment.ts`; do not change its return type.

- [ ] **Step 7: Run the full front-end suite once**

Run:
```bash
npm run test > /tmp/vitest.log 2>&1; tail -30 /tmp/vitest.log
```
Expected: your new tests pass and nothing previously passing broke. Some suites may already be failing from the in-progress merge (six files still carry conflict markers) — note any pre-existing failure in your report rather than trying to fix it, but a failure in a file you touched is yours.

- [ ] **Step 8: Commit**

```bash
git add src/io/read/loader.ts src/io/read/lcc-environment.ts test/lcc-environment-concat.test.ts
git commit -m "merge(wip): restore LCC skybox via splat-transform concatSource" --no-verify
```

---
### Task 5: Span the v1 and v0 document branches with the splat index map

Our portal and annotation features persist splat references **by document index**, using a `loadedSplats: Splat[]` array built during load. v3's reader now has two branches (`document.version >= 1` and the v0 legacy path) and the array must be populated in both, in document order.

**Files:**
- Modify: `src/doc.ts` (3 conflict hunks)

**Interfaces:**
- Consumes: upstream's `GaussianInstances.fromRecords`, `restorePalettes`, `EditorSplatResource`, `document.resources`, `document.version`, `layerInfo`, `groups`.
- Produces: nothing new — restores the existing event contracts `docDeserialize.annotations`, `docDeserialize.offLimitsZones`, `docDeserialize.portals`, `docSerialize.portalsIndex`, all keyed on `{ indexToUid: number[] }`.

- [ ] **Step 1: Resolve hunk 1 (~line 146) — declare the array above upstream's branch**

Replace the conflict block with our declaration followed by upstream's v1 branch opening:

```typescript
            // run through each splat and load it, collecting the created
            // elements in document order: loadedSplats[i] is the element built
            // from document splat index i, so the array maps document splat
            // index -> live session uid. Portal and annotation references are
            // persisted by index, so this must be filled on BOTH the v1 and v0
            // paths below.
            const loadedSplats: Splat[] = [];

            if ((document.version ?? 0) >= 1) {
                // v1: the static tier is stored once per resource, and each layer
                // brings its own instance list and palettes. Layers sharing a
                // resource share it here too, so a duplicated layer costs nothing
                // beyond its list.
                const assets: { asset: Asset, rotation: Quat }[] = [];
                for (const resource of document.resources) {
                    const loaded = await scene.assetLoader.loadAsset(resource.filename, zipFs, false, true);
                    documentResources.add(loaded.asset.resource as EditorSplatResource);
                    assets.push(loaded);
                }
```

- [ ] **Step 2: Resolve hunk 2 (~line 177) — push into the array on both branches**

Take upstream's whole v1/v0 body and add one `loadedSplats.push(splat);` line at the end of each branch's loop, after `splat.docDeserialize(splatSettings)`:

```typescript
                    const instances = GaussianInstances.fromRecords(
                        scene.app.graphicsDevice, numRows, records.sourceRow, records.flags, records.palette
                    );
                    const splat = new Splat(asset, rotation, instances);
                    restorePalettes(records, splat.transformPalette, splat.colorPalette);

                    await scene.add(splat);
                    splat.docDeserialize(splatSettings);

                    loadedSplats.push(splat);
                }
            } else {
                // v0: one baked PLY per layer, no instance list
                for (let i = 0; i < document.splats.length; ++i) {
                    const filename = `splat_${i}.ply`;
                    const splatSettings = document.splats[i];

                    // load splat directly from the zip filesystem (streams on-demand)
                    // skipReorder=true because ssproj PLY files are already in morton order
                    const splat = await scene.assetLoader.load(filename, zipFs, false, true);
                    documentResources.add(splat.resource);

                    await scene.add(splat);

                    splat.docDeserialize(splatSettings);

                    loadedSplats.push(splat);
                }
            }
```

The v1 loop iterates `document.splats` in the same order as v0 (each entry names its `resource` and `instances` blob), so `loadedSplats` is index-aligned on both paths. Confirm this by reading the merged v1 loop header — if it iterates `document.resources` instead, restructure it to iterate `document.splats` and look the asset up by `splatSettings.resource`.

- [ ] **Step 3: Verify our post-load restore block survived**

Our annotation/off-limits/portal deserialize block and the selection-restore fallback sit after the loop and should have auto-merged. Check:
```bash
grep -n "docDeserialize.annotations\|docDeserialize.offLimitsZones\|docDeserialize.portals\|annotations.imageRefs\|loadedSplats.find" src/doc.ts
```
Expected: all five present, all after the branch closes. `indexToUid: loadedSplats.map(s => s.uid)` must appear twice (annotations and portals).

- [ ] **Step 4: Resolve hunk 3 (~line 377) — union the serialized document fields**

Both sides add fields to the same object literal. Keep ours and add upstream's `resources` and its extended `splats` mapping. Replace the conflict block with:

```typescript
                annotations: events.invoke('docSerialize.annotations', uidToIndex),
                offLimitsZones: events.invoke('docSerialize.offLimitsZones'),
                offLimitsMessage: events.invoke('offLimitsZones.message'),
                portals: events.invoke('docSerialize.portals', uidToIndex),
                portalsStartSplat: events.invoke('portals.startSplat'),
                portalsStartSplatIndex: portalsIndex.startSplatIndex,
                portalsEntrypoints: events.invoke('portals.exportEntrypoints'),
                portalsEntrypointsByIndex: portalsIndex.entrypointsByIndex,
                resources: groups.map((group, i) => ({
                    filename: `resource_${i}.ply`,
                    numRows: group.rows.length
                })),
                splats: splats.map((splat, i) => ({
                    ...splat.docSerialize(),
                    resource: layerInfo.get(splat).resource,
                    instances: `instances_${i}.bin`
                }))
            };
```

Our `serializeSettings` object that followed (`keepStateData`, `keepWorldTransform`, `keepColorTint`) is superseded — upstream's writer path (`writeResourceFile`) takes no settings. Delete it, then check for orphaned references:
```bash
grep -n "serializeSettings\|keepColorTint" src/doc.ts
```
Expected: no hits inside the save function.

- [ ] **Step 5: Verify `uidToIndex` is still computed before it is used**

Run:
```bash
grep -n "uidToIndex\|portalsIndex" src/doc.ts
```
Expected: `const uidToIndex = ...` and `const portalsIndex = ...` both appear **above** the object literal from Step 4. If upstream's rework moved the literal earlier, move our two `const` lines up with it.

- [ ] **Step 6: Typecheck `doc.ts` clean**

Run:
```bash
npx tsc -p tsconfig.json --noEmit 2>&1 | grep "doc.ts" | head -20
```
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/doc.ts
git commit -m "merge(wip): keep document splat index map across v1 and v0 load paths" --no-verify
```

---

### Task 6: Re-graft the fork's save/export flow onto the folder-picker dialog

Upstream replaced `showSaveFilePicker` with a directory handle plus an in-app filename dialog and a `WriteTarget`, and added `ssproj` as an export type. Our fork adds seven dialog rows (streaming, collision, environment, per-scene collision, radius, voxel size, server) and two export types (`viewerSettings`, plus the portal bundle path).

**Files:**
- Modify: `src/file-handler.ts` (1 conflict hunk, then body reconciliation)
- Modify: `src/ui/export-popup.ts` (4 conflict hunks)

**Interfaces:**
- Consumes: upstream's `WriteTarget`, `pickWriteTarget`, `sourcesOf`, `BlobReadSource`, `ExportSettings`, `loadExportSettings`, `saveExportSettings`, `FileDialogType`, and the `scene.pickWriteTarget` event.
- Produces: `ExportType` extended with upstream's `'ssproj'` alongside our `'viewerSettings'`; `SceneExportOptions` gaining upstream's optional `fileTarget?: WriteTarget`.

- [ ] **Step 1: Resolve `file-handler.ts` hunk 1 — union the imports**

Replace the conflict block at line 4 with both sides' imports, alphabetised within the existing group the way the surrounding lines already are:

```typescript
import type { Pose } from './camera-poses';
import { collisionRows, collisionSceneIndex } from './collision-size-report';
import { CreateDropHandler } from './drop-handler';
import { ElementType } from './element';
import { Events } from './events';
import { runServerExport } from './export-server-client';
import { ExportSettings, loadExportSettings, saveExportSettings } from './export-settings';
import { BlobReadSource, BrowserFileSystem, MappedReadFileSystem, pickWriteTarget, sourcesOf, WriteTarget } from './io';
import { collisionSeedTuple, resolvePortalExtras } from './portal-export';
import { buildPortalUpload } from './portal-upload';
import { firstWalkthroughPose } from './poster-pose';
```

- [ ] **Step 2: See what the auto-merge broke in `file-handler.ts`**

Run:
```bash
npx tsc -p tsconfig.json --noEmit 2>&1 | grep "file-handler" | head -30
```
Capture this list. Upstream changed the save/export functions to take a `WriteTarget` instead of a `FileSystemFileHandle`, so our added export branches (server export, portal bundle, viewer settings, collision report) will be calling the old shape.

- [ ] **Step 3: Route our export branches through `WriteTarget`**

For each error from Step 2 where our branch passed a file handle or called `fs.createWriter(filename)` directly, take the `fileTarget` off the options and use it. The upstream pattern to follow is in the merged `file-handler.ts` — read the `ply`/`sog` branch and mirror it. Concretely, a branch that read:

```typescript
    const fs = new BrowserFileSystem(handle);
```

becomes:

```typescript
    const fs = new BrowserFileSystem(options.fileTarget);
```

Our **server export** and **S3 publish** paths do not write through the local filesystem at all — they stream to an HTTP endpoint. Those branches must **not** acquire a `WriteTarget`; confirm they take the `directory === undefined` path in the dialog (Task 6 Step 6) so no folder is requested for them.

- [ ] **Step 4: Extend `ExportType` with upstream's `ssproj`**

Find the declaration:
```bash
grep -n "type ExportType" -A 3 src/file-handler.ts
```
It must list upstream's `'ssproj'` and our `'viewerSettings'` alongside `'ply' | 'splat' | 'sog' | 'spz' | 'viewer'`. Add whichever the merge dropped.

- [ ] **Step 5: Resolve `export-popup.ts` hunk 1 — union the imports**

Replace the conflict block at line 8 with:

```typescript
import { probeExportCapabilities } from '../export-server-client';
import { ExportSettings } from '../export-settings';
import { ExportType, SceneExportOptions } from '../file-handler';
import type { BlobReadSource, WriteTarget } from '../io';
import { buildPortalBundle } from '../portal-export';
```

- [ ] **Step 6: Resolve `export-popup.ts` hunk 2 — merge the row-visibility table**

Upstream renamed the parameter type to `FileDialogType`, dropped `currentExportType`, and added an `ssproj` entry; ours adds seven rows and the `viewerSettings` type. Keep both. Replace the conflict block with:

```typescript
        const reset = (exportType: FileDialogType, splatNames: string[], hasPoses: boolean) => {
            currentExportType = exportType;

            const allRows = [
                viewerTypeRow, animationRow, loopRow, colorRow, fovRow, compressRow, bandsRow, iterationsRow, streamingRow, collisionRow, environmentRow, perSceneCollision, radiusRow, voxelSizeRow, serverRow, spzVersionRow, filenameRow
            ];

            const activeRows: Container[] = {
                ply: [compressRow, bandsRow, serverRow, filenameRow],
                splat: [filenameRow],
                ssproj: [filenameRow],
                sog: [bandsRow, iterationsRow, serverRow, filenameRow],
                spz: [bandsRow, spzVersionRow, filenameRow],
                viewer: [viewerTypeRow, animationRow, loopRow, colorRow, fovRow, bandsRow, streamingRow, collisionRow, environmentRow, perSceneCollision, radiusRow, voxelSizeRow, serverRow, filenameRow],
                viewerSettings: [animationRow, loopRow, colorRow, fovRow, filenameRow]
```

`currentExportType` is ours and is read by the server-capability probe — keep the assignment. `FileDialogType` must include `'viewerSettings'`; find its declaration (`grep -rn "type FileDialogType" src/`) and add it if the merge dropped it.

- [ ] **Step 7: Resolve `export-popup.ts` hunk 3 — keep both extension cases**

Ours sets `.json` for `viewerSettings` via `updateExtension`; upstream's `ssproj` case sets `filenameExtension` and re-reads the value. Check which helper survived the merge (`grep -n "updateExtension\|filenameExtension" src/ui/export-popup.ts | head`), then write both cases in that file's surviving idiom. If `updateExtension` survived:

```typescript
                case 'viewerSettings':
                    updateExtension('.json');
                    break;
                case 'ssproj':
                    updateExtension('.ssproj');
```

If it did not:

```typescript
                case 'viewerSettings':
                    filenameExtension = '.json';
                    filenameEntry.value = getFilename();
                    break;
                case 'ssproj':
                    filenameExtension = '.ssproj';
                    filenameEntry.value = getFilename();
```

- [ ] **Step 8: Resolve `export-popup.ts` hunk 4 — take upstream's `onExport`, extended with our two types**

This is the important one. Upstream's `onExport` became `async` and gained the submit guard, the `WriteTarget` acquisition, the overwrite check and the error path — all of which we want. Take upstream's side wholesale and add our two export types to its options map. Replace the conflict block with upstream's body, changing only the options-assembly line:

```typescript
                        const options = exportType === 'ssproj' ? { filename: getFilename() } : {
                            ply: assemblePlyOptions,
                            splat: assembleSplatOptions,
                            sog: assembleSogOptions,
                            spz: assembleSpzOptions,
                            viewer: assembleViewerOptions,
                            viewerSettings: assembleViewerSettingsOptions
                        }[exportType]();
```

Then guard the folder request for the paths that never touch the local filesystem. Immediately before `let fileTarget: WriteTarget;`, the merged code has `if (directory) {`. Our server-export and S3-publish flows must skip it — extend that condition:

```typescript
                        let fileTarget: WriteTarget;
                        // Server export and S3 publish stream to an HTTP endpoint and
                        // never write a local file, so they must not request a folder.
                        if (directory && !usingServerExport()) {
```

Use whatever the merged file's existing accessor for the server toggle is — find it with `grep -n "serverRow\|serverToggle\|exportOnServer" src/ui/export-popup.ts | head` and read the actual identifier rather than assuming `usingServerExport`.

- [ ] **Step 9: Typecheck both files clean**

Run:
```bash
npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E "file-handler|export-popup" | head -30
```
Expected: no output.

- [ ] **Step 10: Commit**

```bash
git add src/file-handler.ts src/ui/export-popup.ts
git commit -m "merge(wip): re-graft fork export rows and types onto folder-picker dialog" --no-verify
```

---

### Task 7: Rewire the zone depth pass to v3's per-splat pick API

`renderZoneDepth()` renders every splat into `zoneDepthTarget` in one `RenderPassPicker`. v3 needs `projectedSplatRenderer.preparePick(splat, 2, true)` / `finishPick()` **per splat**.

**Files:**
- Modify: `src/camera.ts` (hunk 2 at ~line 623, and `renderZoneDepth` at ~line 718)

**Interfaces:**
- Consumes: `scene.projectedSplatRenderer.preparePick(splat, pickOpIndex, depth)` / `.finishPick()`, `scene.getElementsByType(ElementType.splat)`.
- Produces: a `zoneDepthTex` device-scope texture with the same encoding as before (`vec4f(depth*alpha, 0, 0, alpha)`, decoded as `d.r / (1 - d.a)`), plus a new `zoneCameraParams` device-scope `vec4f` — see Task 8 for why.

- [ ] **Step 1: Resolve `camera.ts` hunk 2 — keep our zone pass and take upstream's comment**

Both sides configure passes in the same block. Ours adds the zone pass; upstream rewrote the gizmo-pass comment to mention the new centers layer. Keep both. Replace the conflict block with:

```typescript
            // configure zone pass - off-limits walls, drawn into the main target
            // AFTER the splats (so it blends over splat color) with NO clears
            // (so the shared depth/color from earlier passes is preserved).
            this.zonePass.init(this.mainTarget);
            this.zonePass.addLayer(this.camera, scene.offLimitsLayer, false, false);
            this.zonePass.addLayer(this.camera, scene.offLimitsLayer, true, false);

            // configure gizmo pass. the centers and gizmo layers each clear depth
            // before their opaque step, after the depth-independent tool overlay,
            // so centers depth-test against each other alone and the gizmos then
            // start from a clean buffer again
```

- [ ] **Step 2: Rewrite `renderZoneDepth` to loop per splat**

Replace the existing body (~line 718) with:

```typescript
    renderZoneDepth() {
        const { scene } = this;
        const { app, splatLayer } = scene;
        const device = scene.graphicsDevice;

        if (!this.zoneDepthPass) {
            this.zoneDepthPass = new RenderPassPicker(device, app.renderer);
            this.zoneDepthBlend = new BlendState(
                true,
                BLENDEQUATION_ADD, BLENDMODE_ONE, BLENDMODE_ONE_MINUS_SRC_ALPHA,
                BLENDEQUATION_ADD, BLENDMODE_ZERO, BLENDMODE_ONE_MINUS_SRC_ALPHA
            );
        }

        const splats = scene.getElementsByType(ElementType.splat) as Splat[];
        if (splats.length === 0) {
            return;
        }

        device.scope.resolve('pickOp').setValue(2);   // 'set' - don't skip visible splats
        device.scope.resolve('pickMode').setValue(1); // depth estimation

        this.zoneDepthPass.blendState = this.zoneDepthBlend;
        this.zoneDepthPass.init(this.zoneDepthTarget);

        // v3's projected splat renderer prepares the pick material one splat at a
        // time (see picker.ts:prepareDepth), so the single all-splats pass this
        // used to be becomes a loop. Each iteration enables exactly one splat and
        // renders into the SAME target; only the first iteration clears, so the
        // accumulated depth/transmittance across every splat is preserved -- which
        // is what the zone shader's occlusion test reads.
        const enabled = splats.map(s => s.entity.enabled);
        try {
            for (let i = 0; i < splats.length; ++i) {
                const splat = splats[i];
                if (!enabled[i]) {
                    continue;
                }

                splats.forEach((s, j) => {
                    s.entity.enabled = j === i;
                });

                if (i === 0) {
                    this.zoneDepthPass.setClearColor(new Color(0, 0, 0, 1)); // depth 0, transmittance 1 (nothing)
                } else {
                    this.zoneDepthPass.setClearColor(undefined);
                }

                scene.projectedSplatRenderer.preparePick(splat, 2, true);
                try {
                    this.zoneDepthPass.update(this.camera, app.scene, [splatLayer], new Map(), false);
                    this.zoneDepthPass.render();
                } finally {
                    scene.projectedSplatRenderer.finishPick();
                }
            }
        } finally {
            splats.forEach((s, i) => {
                s.entity.enabled = enabled[i];
            });
        }
    }
```

`setClearColor(undefined)` is how `RenderPassPicker` is told not to clear; verify against the engine's `RenderPass` API in `node_modules/playcanvas/build/playcanvas.d.ts` (`grep -n "setClearColor" node_modules/playcanvas/build/playcanvas.d.ts`) and use whatever that signature actually accepts for "no clear" — it may be `this.zoneDepthPass.colorOps.clear = false` instead. Getting this wrong means only the last splat contributes depth, which shows up as walls that stop occluding behind every splat but one.

- [ ] **Step 3: Publish `zoneCameraParams` alongside `zoneDepthTex`**

v3 sets `cameraParams` as a **material parameter** on the projected splat material, not a device-scope uniform, so the zone shader can no longer read the engine's old global `camera_params`. Publish our own with the identical layout. In `onPreRender`, replace:

```typescript
            this.renderZoneDepth();
            this.scene.graphicsDevice.scope.resolve('zoneDepthTex').setValue(this.zoneDepthBuffer);
```

with:

```typescript
            this.renderZoneDepth();
            const device = this.scene.graphicsDevice;
            device.scope.resolve('zoneDepthTex').setValue(this.zoneDepthBuffer);
            // The zone shader needs the same near/far/projection the splat depth
            // pass encoded with. v3 sets `cameraParams` as a material parameter on
            // the projected splat material rather than a device-scope uniform, so
            // it is not visible to our zone material -- publish our own copy with
            // the identical layout (see projected-splat-renderer.ts).
            const c = this.camera;
            device.scope.resolve('zoneCameraParams').setValue([1 / c.farClip, c.farClip, c.nearClip, c.projection]);
```

- [ ] **Step 4: Typecheck `camera.ts` clean**

Run:
```bash
npx tsc -p tsconfig.json --noEmit 2>&1 | grep "camera.ts" | head -20
grep -c '^<<<<<<<\|^=======\|^>>>>>>>' src/camera.ts
```
Expected: no type errors, marker count `0`.

- [ ] **Step 5: Commit**

```bash
git add src/camera.ts
git commit -m "merge(wip): rewire zone depth pass to v3 per-splat pick API" --no-verify
```

---

### Task 8: Port the three fork-only shaders to WGSL

**This task's correctness cannot be verified by any automated gate.** `vertexGLSL` and `vertexWGSL` both exist on `ShaderMaterial`'s type, so a GLSL shader left on a WebGPU device typechecks, lints, and passes every test while rendering nothing. Only looking at the editor proves it.

**Files:**
- Modify: `src/shaders/off-limits-zone-shader.ts`
- Modify: `src/off-limits-zone-shape.ts`
- Modify: `src/portal-shape.ts`
- Do **not** modify: `src/viewer-companion/portal-markers.ts` (runs in the exported viewer on its own device)

**Interfaces:**
- Consumes: `zoneDepthTex` and `zoneCameraParams` device-scope uniforms from Task 7.
- Produces: `vertexShader` / `fragmentShader` WGSL sources from `./shaders/off-limits-zone-shader`, consumed identically by both shape files.

- [ ] **Step 1: Rewrite `src/shaders/off-limits-zone-shader.ts` in WGSL**

Both shape files import this one module, so this single port serves both. Replace the whole file with:

```typescript
const vertexShader = /* wgsl */`
attribute vertex_position: vec3f;
attribute vertex_color: vec4f;

uniform matrix_model: mat4x4f;
uniform matrix_view: mat4x4f;
uniform matrix_viewProjection: mat4x4f;

varying vColor: vec4f;
varying vViewZ: f32;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let worldPos = uniform.matrix_model * vec4f(input.vertex_position, 1.0);
    output.position = uniform.matrix_viewProjection * worldPos;
    output.vColor = input.vertex_color;
    output.vViewZ = (uniform.matrix_view * worldPos).z;
    return output;
}
`;

const fragmentShader = /* wgsl */`
var zoneDepthTex: texture_2d<f32>;

// [1/farClip, farClip, nearClip, projection] -- published by camera.ts as its own
// device-scope uniform. v3 sets the engine's `cameraParams` as a material
// parameter on the projected splat material, so it is not visible here.
uniform zoneCameraParams: vec4f;

varying vColor: vec4f;
varying vViewZ: f32;

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;

    let texel = vec2i(pcPosition.xy);
    let d = textureLoad(zoneDepthTex, texel, 0);
    let transmittance = d.a;

    // Wall's normalized linear depth, using the SAME formula as the splat
    // depth-estimation shader so the two are directly comparable:
    //   normalizedDepth = (linearDepth - nearClip) / (farClip - nearClip)
    // with linearDepth = -view.z.
    let wallNorm = (-input.vViewZ - uniform.zoneCameraParams.z) / (uniform.zoneCameraParams.y - uniform.zoneCameraParams.z);

    // Only occlude where splats actually exist in front (transmittance low
    // enough to be a real surface). Where there is no splat, always show.
    if (transmittance < 0.99) {
        let splatNorm = d.r / (1.0 - transmittance);
        if (wallNorm > splatNorm) {
            discard; // wall is behind the splat surface -> occluded
        }
    }

    output.color = input.vColor; // smooth alpha blend over composited splats behind
    return output;
}
`;

export { vertexShader, fragmentShader };
```

Three substantive changes beyond syntax, each deliberate:
- `gl_FragCoord.xy / textureSize(...)` + `texture2D` becomes `textureLoad(zoneDepthTex, vec2i(pcPosition.xy), 0)`. The depth target is the same size as the framebuffer, so the old normalize-then-sample round trip was an identity — an integer texel fetch is both exact and avoids needing a sampler binding. `pcPosition` is PlayCanvas's WGSL fragment-position builtin; it is used the same way in upstream's `tool-overlay-shader.ts` `writeDepth`.
- `camera_params` becomes our own `zoneCameraParams` (Task 7 Step 3).
- `vertex_color` must be declared `vec4f` as an attribute and forwarded through `varying`; WGSL has no implicit varyings.

- [ ] **Step 2: Switch `portal-shape.ts` to the WGSL props**

In `src/portal-shape.ts` at ~line 56, change:

```typescript
        this.material = new ShaderMaterial({
            uniqueName: 'portalMaterial',
            vertexGLSL: vertexShader,
            fragmentGLSL: fragmentShader
        });
```

to:

```typescript
        this.material = new ShaderMaterial({
            uniqueName: 'portalMaterial',
            vertexWGSL: vertexShader,
            fragmentWGSL: fragmentShader
        });
```

- [ ] **Step 3: Switch `off-limits-zone-shape.ts` to the WGSL props**

Find its `ShaderMaterial` construction:
```bash
grep -n "vertexGLSL\|fragmentGLSL" src/off-limits-zone-shape.ts
```
Apply the same `GLSL` → `WGSL` rename to both props, leaving `uniqueName` and everything else untouched.

- [ ] **Step 4: Prove no editor-side GLSL remains**

Run:
```bash
grep -rn "vertexGLSL\|fragmentGLSL" src/ | grep -v viewer-companion
grep -rn "/\* glsl \*/" src/ | grep -v viewer-companion
```
Expected: **no output from either**. Any hit is a shader that will silently render nothing on the WebGPU device. `src/viewer-companion/portal-markers.ts` keeping its GLSL is correct and expected — that is why it is excluded.

- [ ] **Step 5: Commit**

```bash
git add src/shaders/off-limits-zone-shader.ts src/off-limits-zone-shape.ts src/portal-shape.ts
git commit -m "merge(wip): port off-limits/portal zone shaders to WGSL" --no-verify
```

---

### Task 9: Audit the files that auto-merged with no conflict marker

Seven files were changed by both sides and merged clean. This is where silent breakage hides — a fork hunk landing in code upstream restructured around it. `tsc` passing on these files proves nothing about whether they still *behave*.

**Files:**
- Audit: `src/editor.ts` (fork +32/−11 vs upstream **+687/−243** — highest risk)
- Audit: `src/render.ts` (fork +150/−0 vs upstream +21/−47)
- Audit: `src/asset-loader.ts` (fork +1/−7 vs upstream +18/−13)
- Audit: `src/ui/scene-panel.ts` (fork +68/−6 vs upstream +3/−5)
- Audit: `src/ui/scss/style.scss`, `panel.scss`, `settings-dialog.scss`, `export-popup.scss`

**Interfaces:**
- Consumes: nothing.
- Produces: a written verdict per file. No code changes unless an audit finds a defect.

- [ ] **Step 1: Audit `src/editor.ts` — our three hunks against upstream's rewrite**

Our three changes were: the axis-view walkthrough branch, the delete-key tool guard list, and the export-in-progress delete guard. For each, confirm the API it calls still exists:

```bash
grep -n "setAzimElevKeepPosition\|controlMode" src/editor.ts src/camera.ts
grep -n "scene.exporting" src/editor.ts src/file-handler.ts
grep -n "activeTool === 'portals'\|activeTool === 'offLimitsZones'" src/editor.ts
```

Expected: `setAzimElevKeepPosition` and `controlMode` both resolve on `Camera`; `scene.exporting` is still a registered function; the tool guard still names all five tools. Upstream's `9a3030f` reworked tool framing and `5e2d623` changed stale-selection handling after deletes — read the merged delete handler end to end and confirm our two guards still sit **before** the delete executes, not after.

- [ ] **Step 2: Audit `src/render.ts` — our 150 added lines against upstream's −47**

Our additions are the video-render orchestration (forced walkthrough, ordered Solo/selection/visibility restore, unconditional camera restore, frozen-still view cover). Upstream removed 47 lines here. Confirm nothing our code calls was among them:

```bash
npx tsc -p tsconfig.json --noEmit 2>&1 | grep "render.ts"
grep -n "view.freeze\|viewFrozen\|solo\|autoRender" src/render.ts | head -20
```

Expected: no type errors. Then check the one behavioural trap: `frameend` fires every rAF tick even when `autoRender` is false. If upstream's changes moved our frame counting onto a different event, the video render will produce the wrong frame count.

- [ ] **Step 3: Audit `src/asset-loader.ts` — our LOD-note removal**

Our change removed the `popup.lod-upload-note` warning; upstream also reworked this file. Confirm the key is gone from the code and that Task 2 removed it from all nine locales:

```bash
grep -rn "lod-upload-note" src/ static/locales/
```
Expected: no output.

- [ ] **Step 4: Audit `src/ui/scene-panel.ts` — our 68 added lines against the panel refresh**

Upstream's `1fc79cc` moved the colour controls into the scene manager, which is exactly where our custom panel rows hang. Confirm our rows are still constructed and appended:

```bash
grep -n "offLimits\|portal\|annotation\|align" src/ui/scene-panel.ts | head -20
```
Then read the merged `append` sequence — overlays in this editor stack by DOM order with no `z-index` anywhere, so a row appended before upstream's new colour section will paint under it.

- [ ] **Step 5: Audit the four SCSS files**

Upstream added +75 lines to `style.scss` and +73 to `export-popup.scss`; we added +29 and +78. Check for duplicated or contradictory rules on the same selectors:

```bash
for f in src/ui/scss/style.scss src/ui/scss/panel.scss src/ui/scss/settings-dialog.scss src/ui/scss/export-popup.scss; do echo "== $f"; grep -n "^\s*#[a-zA-Z-]*\s*{\|^\s*\.[a-zA-Z-]*\s*{" "$f" | awk -F: '{print $2}' | sort | uniq -d; done
```
Any duplicated selector printed here needs reading. The recurring trap in this repo, hit three times: an **id-scoped `display` rule beats `.pcui-hidden`**, so a panel PCUI thinks it hid stays visible. If a merged id selector now sets `display`, either qualify it `:not(.pcui-hidden)` or drive `style.display` from the TypeScript instead.

- [ ] **Step 5b: Delete the dead service-worker test**

`test/sw-fetch.test.ts` is dead: it was written to cover the fork's `respondWith` GET guard in `src/sw.ts`, and that file was deleted in Task 1. Verified fork-only — present at `ae9bd67`, absent from the merge base `e060989` and absent upstream. It imports nothing from `src/`, so it fails on its own mocked expectations rather than a missing module, which is why the merge did not flag it. It is the **only** failing test file in the suite (5 failures), and Task 10's `npm run test` gate cannot go green until it is gone.

```bash
git rm test/sw-fetch.test.ts
npm run test > /tmp/t.log 2>&1; tail -20 /tmp/t.log
```

Expected: the suite is now fully green.

- [ ] **Step 5c: Add a mechanical guard against editor-side GLSL**

Create `test/no-editor-glsl.test.ts`. The failure mode Task 8 exists to prevent — a GLSL shader left on a WebGPU device — is invisible to the typecheck, to lint, and to every other test: `vertexGLSL` and `vertexWGSL` both exist on `ShaderMaterial`'s type, so the wrong one compiles clean and renders nothing. This is the only cheap mechanical guard for it, and it will fail loudly if a future upstream merge reintroduces a GLSL prop.

```typescript
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

// `src/viewer-companion/` is DELIBERATELY excluded and must stay excluded.
// Its shaders run in the exported HTML viewer, on that page's own WebGL2
// device -- not in the editor. Their GLSL is correct, and "fixing" this
// exclusion would break every export.
const EXCLUDED = ['viewer-companion'];

const walk = (dir: string, acc: string[] = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!EXCLUDED.includes(entry.name)) walk(p, acc);
        } else if (entry.name.endsWith('.ts')) {
            acc.push(p);
        }
    }
    return acc;
};

describe('the editor is WebGPU-only, so no editor-side shader may be GLSL', () => {
    const files = walk('src');

    it('finds source files to check', () => {
        expect(files.length).toBeGreaterThan(100);
    });

    it('declares no vertexGLSL or fragmentGLSL outside viewer-companion', () => {
        const offenders = files.filter(f => /\b(vertex|fragment)GLSL\b/.test(fs.readFileSync(f, 'utf8')));
        expect(offenders).toEqual([]);
    });

    it('tags no shader source as glsl outside viewer-companion', () => {
        const offenders = files.filter(f => /\/\*\s*glsl\s*\*\//.test(fs.readFileSync(f, 'utf8')));
        expect(offenders).toEqual([]);
    });
});
```

Run it and confirm all three pass:
```bash
npx vitest run test/no-editor-glsl.test.ts > /tmp/glsl.log 2>&1; tail -20 /tmp/glsl.log
```

The first case is a guard against the guard: if `walk` ever silently returns nothing, the other two would pass vacuously.

- [ ] **Step 6: Record the verdicts**

Append an `## Audit results` section to `docs/superpowers/specs/2026-09-10-upstream-v3-merge-design.md` with one line per file: clean, or what was found and fixed. This is the record that the silent-merge risk was actually examined rather than assumed away.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "merge(wip): audit silently auto-merged files" --no-verify
```

---

### Task 10: Sync the server, run every automated gate

The export server must run the identical writer versions as the front end or the byte-parity guarantee is void.

**Files:**
- Modify: `server/package.json`, `server/package-lock.json`
- Verify only: `dist-shared/`, `test/**`, `server/test/**`

**Interfaces:**
- Consumes: everything from Tasks 1-9.
- Produces: a tree that passes typecheck, lint, locale lint, both test suites, and a release build with zero TypeScript plugin warnings.

- [ ] **Step 1: Sync the server's writer dependencies to the root's**

Read the root versions and match them:

```bash
node -e "const r=require('./package.json').devDependencies;console.log(r['@playcanvas/splat-transform'], r.playcanvas)"
node -e "const s=require('./server/package.json');console.log(JSON.stringify({...s.dependencies,...s.devDependencies},null,1))"
```

Then, from `server/`, install the matching versions with targeted installs — never by deleting a lockfile:

```bash
cd server
npm install @playcanvas/splat-transform@3.4.2 playcanvas@2.22.1
```

- [ ] **Step 2: Rebuild the shared export core and confirm it loads under Node**

```bash
npm run build:shared 2>&1 | tail -5 || node scripts/build-shared.mjs
node -e "import('./dist-shared/splat-export-core.js').then(m=>console.log('shared ok:', Object.keys(m).length, 'exports'))"
```
Expected: a non-zero export count. `dist-shared` is ESM with `.js` appended to relative imports; if the import fails on a bare specifier, `scripts/build-shared.mjs` needs the new module in its input set.

- [ ] **Step 3: Typecheck the whole tree**

```bash
npx tsc -p tsconfig.json --noEmit 2>&1 | tee /tmp/tsc.log | tail -20
grep -c "error TS" /tmp/tsc.log
```
Expected: `0`. Any `TS1185` is a leftover conflict marker.

- [ ] **Step 4: Lint**

```bash
npm run lint 2>&1 | tail -30
```
Expected: clean. **Do not run `--fix` on import ordering** — ESLint 10 crashes on `import/order` autofix in this repo. Fix any ordering complaint by hand or leave it; leaving it is preferred over a crash.

- [ ] **Step 5: Locale lint**

```bash
npm run lint:locales
```
Expected: clean.

- [ ] **Step 6: Front-end tests**

```bash
npm run test > /tmp/vitest.log 2>&1; tail -40 /tmp/vitest.log
```
Expected: all pass, including `test/viewer-html-anchors.test.ts`. That test is the guard against upstream drift in the exported viewer's HTML seams — upstream's `splat-transform` 3.4.2 may have moved the `sse-bootstrap` JSON seam again. If it fails, the injector anchors in the companion code need re-pointing; a soft-failing injector dies silently in production, so this test failing is a **blocker**, not a warning.

Redirect to a file; never pipe Vitest.

- [ ] **Step 7: Server tests — the byte-parity gate**

```bash
cd server
npm run test > /tmp/servertest.log 2>&1; tail -40 /tmp/servertest.log
```
Expected: all pass, including the byte-parity test. A parity failure means the front end and server are no longer running identical writers — re-check Step 1.

- [ ] **Step 8: Release build, gated on the warning count not the exit code**

```bash
npm run build > /tmp/build.log 2>&1; echo "exit=$?"; grep -c "plugin typescript" /tmp/build.log
```
Expected: a count of `0`. Rollup reports TypeScript errors as *warnings*, so its exit code can be 0 with a broken build — the count is the real gate.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "merge(wip): sync server deps to 3.4.2/2.22.1, all automated gates green" --no-verify
```

---

### Task 11: Manual E2E in a WebGPU browser

The only gate that can see a GLSL-on-WebGPU shader failure, a broken zone-depth loop, or a mis-grafted export dialog. Everything above can be green with all three broken.

**Files:** none — this is verification.

**Interfaces:**
- Consumes: the release build from Task 10.
- Produces: a pass/fail record per checklist item, appended to the design doc.

- [ ] **Step 1: Start a release build and confirm the device is WebGPU**

```bash
npm run build && npm run serve
```
Open `http://localhost:3333` in a WebGPU-capable browser. In the console confirm the device type is `webgpu`. Export-related checks must run against a **release** build, not `npm run develop`.

- [ ] **Step 2: Off-limits zones and portals render and occlude**

Load a splat, create an off-limits zone and a portal. Confirm: the walls are visible; they are **occluded** where splats sit in front of them and visible where nothing does; occlusion updates as the camera moves.

Invisible walls mean the WGSL port failed (Task 8). Walls that never occlude, or occlude against only one splat in a multi-splat scene, mean the zone-depth loop failed (Task 7 Step 2 — the clear-suppression call).

- [ ] **Step 2b: The additional zone/portal checks the Task 8 review asked for**

Three device-only cases beyond Step 2, each cheap:

- **Two zones (or two portals) in the same scene, one selected and one not.** Each shape constructs its own `ShaderMaterial` but they share a `uniqueName`, so they share a cached program while holding separate per-instance vertex colours. This is the cheapest check that per-mesh `vertex_color` is not being aliased — the selected one should be visibly brighter (alpha 110 → 190).
- **Resize the window** with a zone visible. `zoneDepthTarget` is resized in the same block as the other targets, so the size invariant that `textureLoad` depends on should hold — but a resize exercises the recreated binding, and it takes two seconds.
- **Expected-and-not-a-bug:** a zone or portal added to a scene with **no splat loaded** will be invisible. `renderZoneDepth()` returns early with no splats, but the (never-cleared, zero-initialised) depth texture is still published — and zeros decode to "discard everywhere". This is pre-existing, the GLSL sampled the same zero texture, and it is **not** a WGSL-port defect. Load a splat before adding a zone, or expect the wall to appear only once one is loaded.

- [ ] **Step 3: Save and reload a multi-scene portal document**

Save a `.ssproj` with two or more splats, at least one portal, at least one annotation, and one splat hidden. Reload it. Confirm: portal splat references resolve to the right scenes; annotations attach to the right scenes; annotation images survive; a sensible splat is selected after load.

Wrong-scene portal references mean the document index map broke (Task 5). Also load a **pre-v3 `.ssproj`** to confirm the v0 branch still populates the index map.

- [ ] **Step 4: Export every format through the new folder dialog**

For each of `ply`, `compressed ply`, `splat`, `sog`, `spz`, `viewer`, `viewer settings`, `ssproj`: confirm the correct rows show, the folder picker and filename dialog behave, the overwrite path warns, and the file lands. Then repeat `ply` and `sog` with **Export on server** enabled and confirm no folder is requested (Task 6 Step 8).

- [ ] **Step 4b: Check the SH column count on the bridged export paths**

Task 3's review found a real output-content change that no test covers. The old column walk emitted `[0,3,8,15][maxSHBands] * 3` `f_rest_*` columns **unconditionally**, zero-filling them when the source had fewer bands. The bridged path emits `SH_REST_COUNTS[min(maxSHBands ?? 3, max(s.resource.shBands))]` — so for a scene whose real SH band count is *below* the requested `maxSHBands`, viewer/SOG/SPZ output now carries **fewer SH textures instead of bands of zeros**.

The direction is a fix — it makes viewer/SOG/SPZ agree with what upstream's PLY path already produces from the same `SuperSplatChunkSource` — but it changes bytes on three live export paths.

Export **two** scenes through the viewer and SOG paths: one with **no** SH data and one **with** SH data, at a `maxSHBands` setting above the scene's actual band count. Confirm both load and render correctly in the exported viewer, and note the SH texture set each produces. A no-SH scene should no longer ship zero-filled SH textures at all.

- [ ] **Step 4c: The two checks the Task 9 audit could not make itself**

Both are for defects the audit found and fixed, neither of which any test can cover:

- **The filename validation hint.** In the export dialog, type a filename that fails validation (an empty name, or one containing `/`). The hint must be **visible and readable**. Upstream positions it 24px outside `#content`, which this fork's scroll container clips on both axes — so before the fix there was no feedback at all on an invalid filename. Check it in the tallest dialog too (a portal viewer export with collision rows shown), since that is why the scroll container exists.
- **The viewer load poster.** Do a **ZIP** viewer export and open it. The loading poster must be a correct, right-way-up image of the scene. Before the fix its read-back returned zeros and it carried an obsolete manual Y-flip, so it would have been a **black, upside-down** image.

- [ ] **Step 5: Verify an exported portal viewer**

Export a portal viewer bundle and open it. Confirm: the loading bar paints at 0% immediately and never regresses; scenes swap at portal crossings; the walkthrough collision works; the transition effect plays. Do **not** measure it with the browser cache disabled — that produces duplicate downloads that are a benign engine artefact and not a bug.

- [ ] **Step 6: Verify an image and a video render**

Render one image and one short video. Confirm the video render leaves the editor as it found it: the previous tool, Solo state, selection, per-splat visibility and camera all restored.

- [ ] **Step 7: Record results and report to the user**

Append an `## E2E results` section to the design doc with one line per step. Then **stop and report to the user** — do not squash or merge to `main` without their sign-off.

---

### Task 12: Squash and merge

Only after the user signs off on Task 11.

- [ ] **Step 1: Confirm the gates are still green on the final tree**

```bash
npx tsc -p tsconfig.json --noEmit 2>&1 | grep -c "error TS"
npm run lint 2>&1 | tail -5
npm run test > /tmp/vitest.log 2>&1; tail -10 /tmp/vitest.log
```

- [ ] **Step 2: Squash the branch into one commit**

Per this repo's convention, a finished feature branch becomes a single commit summarising all changes including documentation.

```bash
git switch main
git merge --squash feature/upstream-v3-merge
git commit
```

Write a message covering: the upstream range merged, the WebGPU-only and service-worker decisions, the four subsystem ports, and the plan/spec docs added. End it with the attribution lines this session was given.

- [ ] **Step 3: Push and clean up**

```bash
git push origin main
git branch -D feature/upstream-v3-merge
git tag -d backup/pre-upstream-v3-merge
```

Delete the backup tag only once the push has been confirmed with `git ls-remote origin main`.
