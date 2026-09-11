# Upstream v3 Merge — Design / Spec

**Date:** 2026-09-10
**Fork base:** `ae9bd67` (v2.32.5 lineage, `main`)
**Upstream target:** `upstream/main` = `0487778` (one commit past tag `v3.1.1`)
**Merge base:** `e060989` (upstream `2.32.5`)
**Branch:** `feature/upstream-v3-merge` · **Backup tag:** `backup/pre-upstream-v3-merge`

---

## 1. What upstream changed

28 commits, 167 files, +12439/−6962. Four independent rewrites landed in one
release train, and the fork touches all four.

| Upstream change | Commit(s) | Fork impact |
| --- | --- | --- |
| **WebGPU editor** — GLSL render path deleted wholesale; WGSL + compute sort | `ed05bdf` | 3 fork-only shader files, zone-depth pass |
| **Streaming export** — `DataTable` export path replaced by a `ChunkSource` pipeline | `ed05bdf`, `db88029` | `splat-serialize.ts`, `splat-export-core.ts`, `io/read/loader.ts` |
| **Document format v1** — `.ssproj` stores one static resource per PLY + per-layer instance blobs | `ed05bdf` | `doc.ts` portal/annotation index mapping |
| **Folder-picker save/export** — `showSaveFilePicker` replaced by a directory handle + filename dialog + `WriteTarget` | `998c5c4`, `73a0760`, `fecbbc9` | `file-handler.ts`, `ui/export-popup.ts` |

Plus: service worker removed (`fb6b729`), panel UX refresh + colours moved into
the scene manager (`1fc79cc`), toolbar regrouped into press-and-hold popups
(`2466a4d`), 3D volume brush tool (`9818611`), grid rework (`678c06b`),
appearance/overlays popups (`3565a6a`), `centersLayer` added to the render
layer stack.

Dependencies: `playcanvas` 2.21.4 → 2.22.1, `@playcanvas/splat-transform`
3.3.3 → 3.4.2, plus routine bumps. Upstream dropped `@rollup/plugin-strip`,
`cors`, `tsx`, `vitest`, `mediabunny` from its tree — **the fork keeps all of
these** (`mediabunny` for video render, the rest for the server and tests).

## 2. Decisions taken (user, 2026-09-10)

1. **The editor becomes WebGPU-only.** `git grep webgl2 upstream/main -- src/`
   returns zero hits — upstream deleted the WebGL2 render path, not merely the
   default. Accepted: `main.ts` takes upstream's `deviceTypes: ['webgpu']`.
   The exported viewer's WebGPU→WebGL2 crash fallback is untouched (it lives in
   `src/viewer-companion/device-fallback.ts`, which upstream never sees).
2. **The service worker is removed.** `src/sw.ts` is deleted; the fork's GET
   guard goes with it. The trap it worked around (a `respondWith`-answered
   request suppressing `xhr.upload` progress) is retired by the same deletion.
3. **Merge target is `upstream/main` (`0487778`)**, one commit past `v3.1.1`,
   to pick up "Fix oversized gaussian footprints (#1042)".

## 3. Correction to the prior scoping memo

The 2026-08-27 scoping (memory: `upstream-3-0-0-alpha-merge-scoping`) measured
the alpha at `404c18f` and concluded *"only 16 fork-added lines touch removed
APIs"*. **That is no longer true.** Commits after the alpha — chiefly
`db88029` (splat-transform 3.4.2) and `998c5c4`/`73a0760` (save/export
rework) — added the streaming export rewrite and the folder-picker flow. The
real figures now:

- `splat-serialize.ts`: fork +867/−175 against a file upstream rewrote
  +363/−344. `splat.splatData` — the fork's data access route in ~24 places —
  **no longer exists** on v3's `Splat`.
- `ui/export-popup.ts`: 4 conflict hunks including the whole `onExport`
  resolution path and the row-visibility table.
- `io/read/loader.ts`: the fork's LCC-environment merge is written against
  `DataTable` + `combine()`; v3's loader returns a `ChunkSource`.
- `doc.ts`: 3 hunks, including a new v1/v0 branch the fork's `loadedSplats`
  index array must span.

**The mitigating discovery:** `@playcanvas/splat-transform@3.4.2` still ships a
compat layer (`dist/lib/compat/data-table.d.ts`) exporting `DataTable`,
`materializeToDataTable`, `dataTableToChunkSource`, `combine`,
`processDataTable`, `createChunkDataPool`, `selectLod` and `sortMortonOrder`.
The fork's `splat-export-core.ts` (shared verbatim with the export server) and
`io/read/lcc-environment.ts` therefore need **no rewrite** — only a bridge at
their edges. This is what makes the port tractable.

## 4. Target architecture

### 4.1 Export: bridge, don't rewrite

The fork's `extractDataTable(splats, settings)` is the single choke point where
editor `Splat` objects became a `DataTable`. It used `splat.splatData`, which is
gone. Replace its *body* with upstream's source pipeline plus the compat
materializer, keeping its signature asynchronous:

```
extractDataTable(splats, settings)          -- old, sync, splat.splatData
  ↓
extractDataTableAsync(splats, settings)     -- new, async
  = createExportSource(splats, settings)    -- upstream: SuperSplatChunkSource
  → materializeToDataTable(source, pool)    -- splat-transform compat layer
```

`splat-export-core.ts` keeps its `DataTable` contract untouched, so the
**byte-parity guarantee with the export server survives by construction** — the
server runs the same writers over the same `DataTable`. Every caller of
`extractDataTable` in the fork (`serializeViewer`, `serializeViewerSettings`,
the SOG path, `collision-size-report`) is already inside an `async` function.

The fork's `GaussianFilter` / `countGaussians` / `getCommonProps` /
`getVertexProperties` / `calcSHBands` / `DataTypeSize` machinery is **deleted**
in favour of upstream's `filteredIndices` + `SuperSplatChunkSource`, which
apply the same selected/minOpacity/removeInvalid filter semantics. The fork's
hand-rolled `serializePly` / `serializePlyCompressed` / `serializeSplat` are
likewise dropped for upstream's `writeSplatFile`.

### 4.2 LCC environment: concatenate sources with the library's own combinator

v3's `loadSplatSource` returns a `ChunkSource`; the fork needs to append the LCC
skybox chunk that upstream's streaming LCC reader excludes. `combine()` on
`DataTable`s is no longer reachable without materializing the whole scene, which
would forfeit v3's streaming memory win on exactly the largest files.

**No fork-owned combinator is needed.** `@playcanvas/splat-transform@3.4.2`
publicly exports `concatSource(allSources: ChunkSource[], pool: ChunkDataPool)`
from its `ops` module — a lazy end-to-end concatenation that block-copies
contiguous spans (one `set()` per layer, not a per-row gather), with peak extra
memory of one source chunk-set. The environment side is
`dataTableToChunkSource` over the existing `readLccEnvironment()` `DataTable`.

`lcc-environment.ts` remains necessary: splat-transform's own
`readLccEnvironmentSource` exists but is marked `@ignore` and is absent from the
package's public export list. It does need one change, though.
`concatSource` requires both sources to agree on chunk size, SH bands, available
layers, **extra columns** and pending transform, and throws otherwise. Upstream's
chunked LCC reader maps the LCC normals (`nx`/`ny`/`nz`) to `other`-layer extras
and the environment has none — the old `combine()` zero-filled absent columns,
and nothing does that now. So `readLccEnvironment` takes the scene's extra-column
names and zero-fills any it lacks.

Composition order against `mortonOrderSource` is decided by test, not by
reading: `PermutedChunkSource.read` converts *every* request, chunk requests
included, into a gather on its parent, and `concatSource`'s documentation
describes only chunk-range stitching. If the concat serves gathers, it goes
inside the morton wrap (reproducing the pre-v3 `combine`-then-`sortMortonOrder`
order); if not, it goes outside, leaving the skybox an unsorted tail — which
costs nothing measurable, morton order being a render-locality optimisation.

### 4.3 Zone depth: per-splat prepare

`camera.ts:renderZoneDepth()` renders every splat into `zoneDepthTarget` in one
`RenderPassPicker`. v3 requires `scene.projectedSplatRenderer.preparePick(splat,
2, true)` / `finishPick()` **per splat** (see `picker.ts:prepareDepth`). Rewire
to loop the splats into the same render target, clearing only before the first,
and toggling `entity.enabled` so each pass draws exactly one splat. The depth
encoding is unchanged — v3's `projected-splat-shader.ts` PICK_PASS `pickMode 1`
still emits `vec4f(depth*alpha, 0, 0, alpha)` — so the fork's occlusion decode
`d.r / (1 - d.a)` maps across 1:1.

### 4.4 Shaders: GLSL → WGSL, three files only

Exactly three fork-only files carry editor-side GLSL. Every other GLSL file in
`src/` is upstream-owned and arrives already converted (or deleted).

| File | Port |
| --- | --- |
| `src/shaders/off-limits-zone-shader.ts` | 53 lines GLSL → WGSL |
| `src/off-limits-zone-shape.ts` | `vertexGLSL`/`fragmentGLSL` → `vertexWGSL`/`fragmentWGSL` |
| `src/portal-shape.ts` | same |

`src/viewer-companion/portal-markers.ts` also holds GLSL but runs in the
exported viewer on its own device — **do not touch it.**

**Both prop names exist on `ShaderMaterial`'s type.** A GLSL shader left on a
WebGPU device compiles nothing and fails silently at runtime with green tests
and a clean typecheck. `npm run lint`, `npm run test` and `npx tsc --noEmit`
cannot detect this class of error; only looking at the editor can.

### 4.5 Layers: `offLimitsLayer` and `centersLayer` coexist

Upstream added a `centersLayer` at the same two places the fork inserted
`offLimitsLayer` (`scene.ts` layer push, `camera.ts` layer id list). Both sides
are additive — take both, fork's zone pass keeps its own `addLayer` calls.

### 4.6 Document format: index mapping spans both branches

v3's `doc.ts` reader branches on `document.version >= 1`. The fork's
`loadedSplats: Splat[]` array — which maps document splat index → live session
uid, and which the portal and annotation features persist against — must be
populated in **both** the v1 resource/instances branch and the v0 legacy
branch, in document order. On the writer side the fork's `uidToIndex` /
`portalsIndex` block merges with upstream's new `resources` / `instances`
fields; both are kept.

## 5. Non-goals

- Porting `src/viewer-companion/**` — it is playcanvas-free and upstream never
  touches it.
- Porting `server/**`, `scripts/**`, `test/**` — untouched by upstream, and the
  `DataTable` bridge keeps their contract stable.
- Restoring the service worker or a WebGL2 editor fallback (decided in §2).
- Reordering imports. ESLint 10 crashes on `import/order` autofix in this repo.

## 6. Verification gates

| Gate | Command | Detects |
| --- | --- | --- |
| Typecheck | `npx tsc -p tsconfig.json --noEmit` | API drift, merge markers |
| Lint | `npm run lint` | style, unused imports |
| Locale keys | `npm run lint:locales` | key drift across 9 locales |
| Front-end tests | `npm run test` | viewer anchors, portals, alignment, annotation links |
| Server tests | `server/`: `npm run test` | **byte-parity guarantee** |
| Rollup | `npm run build`, then `grep -c "plugin typescript"` == 0 | TS errors (Rollup reports them as *warnings* — exit code lies) |
| Manual E2E | `npm run develop`, WebGPU browser | **the only gate that sees a GLSL-on-WebGPU shader failure** |

E2E must be run against a **release** build for anything export-related, and
the exported viewer must never be measured with the browser cache disabled.

## 7. Audit results — files that auto-merged with no conflict marker

Seven files were changed by both sides and merged clean, so neither git nor
`tsc` could speak to whether the fork's hunks still *behave*. Each was read
against `git diff e060989 ae9bd67` (fork delta) and `git diff e060989
upstream/main` (upstream delta). Verdicts:

| File | Verdict |
| --- | --- |
| `src/editor.ts` | **Clean.** All three fork hunks survive and still run. |
| `src/render.ts` | **Defect found and fixed** — stale framebuffer read + stale Y-flip in the fork-only `render.poster`. |
| `src/asset-loader.ts` | **Clean.** LOD-note removal survived upstream's rewrite; the locale key is gone everywhere. |
| `src/ui/scene-panel.ts` | **Clean.** Fork row is a header sibling, not a panel row; upstream's `ColorPanel` cannot paint over it. |
| `src/ui/scss/style.scss` | **Clean.** `@use` graph intact, `mode-toggle.scss` fully de-referenced, no duplicated selectors. |
| `src/ui/scss/panel.scss` | **Clean.** Fork's `&.disabled` still last in `.panel-header-button`, so it outranks `&:hover`. |
| `src/ui/scss/settings-dialog.scss` | **Clean.** No `#content` overflow here, so upstream's `overflow: visible` takes effect; `.ext-hint` still has a consumer. |
| `src/ui/scss/export-popup.scss` | **Defect found and fixed** — the fork's `#content` scroll container clipped upstream's new filename hint out of existence. |

### `src/editor.ts` (fork +32/−11 vs upstream +687/−243)

1. **Axis-view walkthrough branch** (`editor.ts:359-383`). `Camera.controlMode`
   still exists (`camera.ts:93`) and `setAzimElevKeepPosition` still exists
   (`camera.ts:268`). The orbit branch still sets `ortho = true` *after*
   `setAzimElev`, which ends in `this.ortho = false` (`camera.ts:298`) — order
   preserved, so ortho still wins. Nothing in upstream's rework forces orbit
   mode on an axis align: the two new `camera.setControlMode` firings are
   `editor.ts:287` (`camera.focus`) and `controllers.ts:332`/`:366`
   (double-click focus, fly-key press) — all user-initiated, none on the
   `camera.align` path (fired only from `ui/view-cube.ts:86-101`).
2. **Delete-key tool guard** (`editor.ts:888-892`). All five names still match
   live `toolManager.register` calls: `measure`/`orient`/`annotation`
   (`main.ts:278-280`), `offLimitsZones` (`main.ts:281`), `portals`
   (`main.ts:282`). `tool.active` is still registered at
   `tools/tool-manager.ts:29`, and `polygonSelection.removeLastPoint` at
   `tools/polygon-selection.ts:133`.
3. **Export-in-progress guard** (`editor.ts:901`). `scene.exporting` is still a
   registered function (`file-handler.ts:1089`).

Both guards sit **before** the delete: the only two `RemoveInstancesOp`
constructions in the tree are `editor.ts:905` (inside `select.delete`, after
all three guards) and `editor.ts:929` (`edit.separate`). Upstream renamed
`DeleteSelectionOp` to `RemoveInstancesOp` and re-keyed history pruning from
`scene.elementRemoved` to `scene.elementDestroyed`; neither moves the guards.
No dead imports (every named import is referenced at least twice).

### `src/render.ts` (fork +150/−0 vs upstream +21/−47) — DEFECT

The fork's 150 lines are the `render.poster` orchestration (the video-render
walkthrough/Solo/selection restore lives in the fork-only
`src/video-render-state.ts`, not here). Upstream's −47 removed the vertical
Y-flip from all three of its own readback paths and added `immediate: true` to
every `colorBuffer.read`, because in v3 rows come back top-down and a deferred
read maps the staging buffer before the copy has run, returning zeros.

`render.poster` is a pure fork-side addition, so it merged with no marker and
kept **both** obsolete behaviours: a non-`immediate` read and its own Y-flip.
The exported viewer's load-time poster would therefore have been a
zero-filled (black) image, and upside-down had the read worked. Fixed by
adding `immediate: true` and deleting the flip loop, matching the three
sibling paths.

Frame counting is correct and unaffected: `postRender()` (`render.ts:100`)
awaits the scene's `postrender` event, which `scene.ts:632` fires from the
engine's `postrender` — itself fired inside `AppBase.render()`, which runs only
when `autoRender || renderNextFrame`. The video path drives it explicitly
(`scene.lockedRender = true; await postRender()`), and the frame *count* comes
from the timeline (`totalFrames = Math.floor(duration * frameRate) + 1`).
Nothing hangs off `frameend`, which would have fired every rAF tick.

Two checked-and-accepted divergences, deliberately not changed:

- `render.poster`'s inline `sortVisibleSplats` is now a guaranteed no-op —
  nothing calls `addComponent('gsplat')` anywhere in `src/`, so
  `splat.entity?.gsplat?.instance` is always undefined and the guard resolves.
  Behaviourally identical to upstream's neutered `sortSplatsAndWait`
  (`render.ts:68`).
- `render.poster` does not set `centersLayer.enabled = false` the way
  upstream's three paths now do. Harmless: `SplatCenters.enabled`
  (`splat-centers.ts:172`) already gates on `camera.renderOverlays`, which the
  poster sets to `false`.

### `src/asset-loader.ts` (fork +1/−7 vs upstream +18/−13)

Upstream replaced `loadGSplatData` with `loadSplatSource`/`EditorSplatResource`
and split `load` into `load` + `loadAsset`. The fork's hunk — dropping the
`warning: { text: i18n.t('popup.lod-upload-note'), link: ... }` argument from
the `showPopup` call — landed inside the moved `pickLod` closure and survived
(`asset-loader.ts:49-58` has no `warning` key). Grepping `lod-upload-note`
over the whole repo (excluding `node_modules`, `dist`, `.git`) returns only
planning/spec prose: zero hits in `src/` and zero in all nine
`static/locales/*.json`.

### `src/ui/scene-panel.ts` (fork +68/−6 vs upstream +3/−5)

The fork's `walkthroughToggle` is still constructed (`scene-panel.ts:57-60`)
and appended (`:137`). Merged panel-level `append` order (`:178-182`):
`sceneHeader`, `splatListContainer`, `transformHeader`, `Transform`,
`ColorPanel`. Upstream's `1fc79cc` swapped its 20px spacer `Element` for
`ColorPanel` in the **last** slot; the fork added no panel-level row, only a
button inside `sceneHeader` (order within the header: icon, label, solo,
**walkthrough**, import, new). Since overlay stacking here is pure DOM order
with no `z-index`, `ColorPanel` — a later sibling — could only paint over an
*earlier* panel row, and `sceneHeader` is first in a vertical flex column, so
no overlap is possible.

Upstream also dropped the now-unused `Element` import; the merged import list
(`:1`) is `{ Container, Label }` with no dead entry. All fork wiring resolves:
`portals.count`, `portals.changed`, `scene.clear`, `scene.solo` (consumed at
`ui/splat-list.ts:241`) and `portals.walkthrough` all have live handlers,
`src/ui/svg/portal-small.svg` exists, and `tooltip.scene.walkthrough` is
present in all nine locales.

Note (not a defect, not changed): the comment at `:103` still points at
`src/render-walkthrough.ts`; that file is now `src/video-render-state.ts`.

### The four SCSS files

No duplicated selector in any of the four (checked at every nesting depth, not
just top level). `sass --load-path=node_modules/@playcanvas/pcui/dist` compiles
`style.scss` with exit 0.

- **`style.scss`** (fork +29 / upstream +75/−1). Disjoint: the fork added five
  `@use` lines plus `.view-cover`; upstream added `#startup-error`,
  `#perf-overlay`, `#annotation-container` and removed `@use
  'mode-toggle.scss'`. The `@use` graph is intact — every target resolves
  (`pcui-theme-grey.scss` via the PCUI include path), no `.scss` in the
  directory is orphaned, and `mode-toggle.scss` is gone from both the
  directory and the `@use` list. Upstream's new `#annotation-container`
  (absent at the merge base) is the only definition of that id and does not
  collide with the fork's fork-only `annotation-overlay.scss`, whose SVG
  mounts directly under `#canvas-container` (`annotation-overlay.ts:36`,
  inserted right after the canvas) rather than inside it.
- **`panel.scss`** (fork +5 / upstream +4/−2). The fork's `&.disabled`
  (`:61-64`, driving `walkthroughToggle`) is still the **last** block in
  `.panel-header-button`, after `&:hover` (`:55`); identical specificity, so
  source order decides and `.disabled` wins — plus its `pointer-events: none`
  makes `:hover` unreachable anyway. Upstream's change of `& > .panel-header`
  to `& .panel-header` plus a fixed `height: 32px` is safe for the fork: every
  fork `.panel-header` is a direct child of its `.panel`
  (`ui/alignment-panel.ts:36`, `ui/scene-panel.ts:35`/`:162`), and the fork's
  16px header SVGs fit the 28px inner box.
- **`settings-dialog.scss`** (fork +9 / upstream +5/−1). Disjoint. Upstream
  changed `#dialog` from `overflow: hidden` to `overflow: visible` (so select
  dropdowns can escape) and this file sets **no** `overflow` on `#content`, so
  that change takes effect. The fork's `.ext-hint` still has a consumer
  (`ui/render-s3-rows.ts:67`).
- **`export-popup.scss`** (fork +78/−1 / upstream +73/−3) — **DEFECT.** Same
  upstream `overflow: hidden` to `visible` change on `#dialog`, plus a new
  `#export-filename-message` hint positioned at `left: calc(100% + 24px)` —
  i.e. 24px to the *right* of the full-width filename field, outside
  `#content`. The fork's hunk gives `#content` `max-height: calc(100vh -
  200px)` plus `overflow-y: auto` so the taller portal/collision dialog fits
  the viewport, and a scroll container clips on both axes (CSS forces
  `overflow-x: visible` to `auto` when the other axis scrolls). The hint — a
  child of `.filename-field`, which is inside `#content` via `filenameRow`
  (`ui/export-popup.ts:456-464`) — was therefore clipped away entirely, and
  filename validation errors would never have been visible.

  **Fixed by taking the hint out of absolute positioning and docking it in
  flow under the field**, nested inside the existing `.filename-field` block
  so it wins on specificity rather than on source order (4 IDs + 3 classes vs
  upstream's 3 IDs), with the filename row allowed to grow
  (`.row:has(.filename-field) { height: auto; min-height: 24px }`) and
  upstream's not-hovered `visibility: hidden` overridden so a box that now
  reserves its own space is never blank. Absolute positioning could not be
  rescued: in the `splat` and `ssproj` variants every row after the filename
  row is hidden (`ui/export-popup.ts:736-737`, `:744-746`), so the filename
  row is the last in-flow row and `#content` — which has no fixed height —
  does not grow to contain an absolutely positioned descendant. In flow,
  `#content`'s own height includes the hint, so it is fully visible in every
  variant, at every viewport width, for any message length (`error.message` at
  `ui/export-popup.ts:1057` is unbounded). Cost: the dialog reflows when a
  filename message appears, instead of the hint floating beside the dialog.

  The fork's `.export-warning:not(.pcui-hidden)` guard against the recurring
  "id-scoped `display` beats `.pcui-hidden`" trap survived intact (`:220`);
  no merged id selector introduced an unguarded `display`.

  **Known, accepted consequence of the same root cause:** PCUI renders a
  select's option list as a DOM child of the select
  (`SelectInput/index.mjs:256`), so `#content`'s scroll container also clips
  dropdown lists, neutralising upstream's `overflow: visible` improvement
  inside this dialog. That is not a regression against the fork's pre-merge
  behaviour (`#dialog` used to be `overflow: hidden`), and undoing it would
  need a layout decision about how the fork's tall export dialog should
  scroll. Left for the user.

### Test-suite changes

- Deleted `test/sw-fetch.test.ts`. Fork-only (present at `ae9bd67`, absent
  from both `e060989` and `upstream/main`), written against the `src/sw.ts`
  removed in Task 1, and the only failing file in the suite — 5 failures, all
  `Cannot find module '/src/sw'`.
- Added `test/no-editor-glsl.test.ts`: a mechanical guard covering **all three**
  routes by which a GLSL shader can reach the editor's WebGPU device, none of
  which the typecheck, the lint or any other test can see:
  1. `vertexGLSL`/`fragmentGLSL` on `ShaderMaterial` — both the GLSL and WGSL
     props exist on the type, so the wrong one compiles clean and renders
     nothing; plus `/* glsl */`-tagged sources.
  2. `shaderLanguage: SHADERLANGUAGE_GLSL` on a raw `Shader`/`Compute`. All 15
     of the editor's `shaderLanguage:` sites (`data-processor/*`,
     `projected-splat-renderer.ts`) pass `SHADERLANGUAGE_WGSL`, and
     `SHADERLANGUAGE_GLSL` appears nowhere in `src/`, so **no exception is
     needed** and the assertion is flat.
  3. `shaderChunks.glsl.add(...)` chunk overrides — `shaderChunks.glsl` and
     `shaderChunks.wgsl` are separate registries and neither errors when the
     device cannot use it, so a GLSL-only override silently does nothing.

  The `viewer-companion` exclusion is deliberate and carries a comment saying
  so. It is **load-bearing, not prophylactic**:
  `src/viewer-companion/portal-markers.ts:72` holds `MARKER_CLAMP_GLSL` (a
  `gl_Position` snippet) and registers it at `:185` via
  `shaderChunks.glsl.add`, next to a WGSL twin — so route 3 would fail on
  correct code without the exclusion. Those shaders run in the exported HTML
  viewer on that page's own WebGL2 device; removing the exclusion would break
  every export.

Suite after both changes: **72 files / 1105 tests, all passing**;
`npx tsc -p tsconfig.json --noEmit` exit 0; `npm run lint` exit 0.
