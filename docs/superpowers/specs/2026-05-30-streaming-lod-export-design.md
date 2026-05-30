# Streaming LOD Export (decimation-based)

Date: 2026-05-30
Status: Approved (pending implementation plan)

## 1. Summary & scope

Add a **Streaming** toggle to the Viewer export panel. When enabled, the ZIP
(package) viewer export decimates the fully-edited scene into multiple
level-of-detail (LOD) levels and writes a `lod-meta.json` streaming bundle plus
a viewer configured to load it. The embedded viewer runtime already routes
`lod-meta.json` to its octree/streaming parser, so it performs view-dependent,
progressive loading at runtime.

The feature works for **any scene**, regardless of source format. The original
request scoped this to LCC imports (to reuse the LCC's native lower LODs), but
during design we settled on regenerating LODs from the edited top LOD via
decimation. That decision makes the source format irrelevant: every edit is
honored because all LOD levels derive from the same edited data, and there is no
technical reason to gate on LCC.

### Design decisions (resolved during brainstorming)

- **LOD source: decimation from the edited top LOD.** Not the LCC's native lower
  LODs. SuperSplat edits are per-gaussian (deletions via a `state` flag,
  per-gaussian transforms via a transform palette); the LCC's lower LODs are
  independent decimated point sets with no gaussian-to-gaussian correspondence,
  so per-gaussian edits cannot be mapped onto them. Decimating the edited top
  LOD sidesteps this entirely and honors all edits. The native-LOD fast-path is
  explicitly out of scope (see section 9).
- **Quality expectation (unverified, expected minor):** `splat-transform`'s
  decimation (`simplifyGaussians`, progressive pairwise merging) is content-aware
  and starts from the densest/highest-quality representation in the scene, so the
  quality gap versus XGrids' native LODs is expected to be minor and
  scene-dependent. Revisit only if a real scene shows visible degradation.
- **ZIP only.** Streaming needs the external chunk files (`lod-meta.json` +
  per-LOD `.sog` chunks), so it cannot be a single self-contained `.html`. The
  toggle is shown only when the type selector is `zip`, and hidden for `html`.
- **Available for any scene** (no LCC gating).
- **Single toggle, automatic defaults.** No exposed controls for level
  count / ratios / chunk parameters in v1.
- **Default ON.** The streaming toggle defaults to `true` (only visible under
  ZIP).

## 2. UI changes (`src/ui/export-popup.ts`)

- Add a new row with a `BooleanInput` "Streaming" toggle and a `Label`, using the
  existing row/label/boolean class pattern.
- Add the row to the `viewer` entry of the `activeRows` map in `reset()`.
- The toggle row is shown **only when `viewerTypeSelect.value === 'zip'`** and
  hidden when `'html'`. Wire this into:
  - the existing `viewerTypeSelect.on('change')` handler (toggle row visibility
    alongside the existing extension update), and
  - `reset()` so the initial state is correct when the panel opens.
- Default value: `true`.
- The toggle value flows into the assembled viewer options as a new
  `streaming: boolean` on `ViewerExportSettings` (see section 5).
- The existing **SH bands** slider is unchanged and continues to apply: it feeds
  `extractDataTable`, so the top LOD is band-limited before decimation.

## 3. Data pipeline (`src/splat-serialize.ts`)

A new branch inside `serializeViewer` runs when `options.streaming` is set (only
reachable for `type === 'zip'`):

1. `extractDataTable(splats, serializeSettings)` -> edited top-LOD table `D0`
   (all edits baked, PLY space, SH band-limited per the slider).
2. Build coarser levels via `simplifyGaussians(D0, targetCount)`:
   - Heuristic default, encapsulated in one helper with named constants:
     start at `N0 = D0.numRows`, quarter the count per level (`N0/4`, `N0/16`,
     `N0/64`), stop when a level would fall below a minimum (`~64K` gaussians) or
     after a maximum number of levels (`4` total including `D0`).
   - Tag each level's rows with a `lod` column (`0` = finest = `D0`, increasing =
     coarser). This matches the convention `readLcc`/`writeLod` use.
3. `combine([D0, D1, ...])` -> a single table carrying the `lod` column.
4. `writeLod({ filename: 'lod-meta.json', dataTable: combined, envDataTable: null,
   iterations: 10, chunkCount: 512, chunkExtent: 16, createDevice: createGpuDevice
   })` into a `MemoryFileSystem`.

Notes:
- Total exported gaussians are roughly `1.33 * N0` (`1 + 1/4 + 1/16 + 1/64`),
  which is the expected streaming trade-off: more total data, but only the
  needed subset is loaded at runtime.
- `writeLod` throws if the `lod` column is missing and consumes/mutates its input
  tables (it converts them to PLY space in place).

## 4. Viewer shell assembly (the novel part)

`splat-transform` exposes no "viewer that references `lod-meta.json`" function,
and its HTML template strings are internal. We assemble the streaming viewer by
post-processing `writeHtml`'s unbundled output:

1. Call `writeHtml({ filename: 'index.html', bundle: false, dataTable:
   <1-splat placeholder>, viewerSettingsJson: experienceSettings, iterations: 10,
   createDevice })` into the memory FS. This yields `index.html`, `index.css`,
   `index.js`, `settings.json`, and a throwaway `index.sog`. The 1-splat
   placeholder avoids compressing the whole scene into a SOG that is immediately
   discarded.
2. Discard the placeholder `index.sog`. Rewrite `index.html`'s literal
   `fetch("index.sog")` -> `fetch("./lod-meta.json")`. (The unbundled
   `writeHtml` emits exactly that literal because we control the output filename;
   the viewer runtime routes `lod-meta.json` to its octree parser.)
3. Add the `writeLod` outputs (`lod-meta.json` + chunk `.sog` files) to the set.
4. ZIP everything via the existing `ZipFileSystem` packaging loop already used by
   the non-streaming ZIP path.

Robustness:
- Assert the `fetch("index.sog")` -> `fetch("./lod-meta.json")` replacement
  actually changed the HTML; throw a clear error if it did not (guards against a
  future `splat-transform` template change silently producing a broken viewer).
- The streaming viewer must be served over HTTP, same as today's unbundled
  viewer; `file://` cannot fetch the chunk files. This is unchanged behavior for
  package exports.

## 5. Plumbing

- `ViewerExportSettings` (in `src/splat-serialize.ts`) gains
  `streaming?: boolean`.
- `export-popup.ts` sets `streaming` when assembling viewer options.
- `file-handler.ts` already forwards `viewerExportSettings` through `scene.write`
  to `serializeViewer` unchanged, so no change is required there beyond what the
  type already carries.
- Localization: add the "Streaming" toggle label key to every
  `static/locales/*.json` file (en, fr, de, es, ja, ko, pt-BR, ru, zh-CN).

## 6. Environment handling

In SuperSplat the LCC environment is merged into the single splat's data at load
time (`combine(tables)` in `src/io/read/loader.ts`); there is no separate
environment splat entity. Therefore streaming needs no special environment
handling: the environment is part of the top LOD and is decimated with the rest
of the scene. `writeLod`'s `envDataTable` stays `null`.

## 7. Edge cases / risks

- **Tiny scenes:** when `N0` is already small, the heuristic produces fewer (or
  zero) extra levels; the bundle is still valid as a single-LOD `lod-meta.json`.
- **Template-string dependency:** the `fetch("index.sog")` rewrite depends on
  `writeHtml`'s current unbundled output. Mitigated by the assertion in
  section 4.
- **Scope isolation:** streaming applies only to viewer ZIP export; single-HTML
  viewer export and all non-viewer exports are untouched.

## 8. Testing

- Manual: import a scene, make edits (delete floaters, transform), export ZIP
  with streaming on, serve over HTTP, confirm the viewer streams LODs and that
  edits are reflected.
- Verify the SH bands slider reduces all LOD chunks (band-limited before
  decimation).
- Verify non-streaming ZIP export and single-HTML export are unchanged.
- Verify the placeholder `index.sog` is absent from the output ZIP and the
  viewer loads `lod-meta.json`.

## 9. Out of scope (future)

- Native LCC LOD fast-path for cleanly-edited LCC scenes (global transform /
  color grade only). Would require retaining LCC files on the splat, a second
  transform/grade-baking pipeline (including re-implementing color grade on raw
  tables), and "clean edit" detection.
- Advanced parameter controls (level count, decimation ratios, chunk
  count/extent).
- Treating the environment as an always-resident skybox layer
  (`writeLod` `envDataTable`).
- A cleaner long-term fix: a `splat-transform` API that emits a viewer wired to
  LOD content directly, removing the `writeHtml` post-processing.
