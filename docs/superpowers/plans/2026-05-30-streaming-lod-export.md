# Streaming LOD Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Streaming" toggle to the Viewer ZIP export that decimates the edited scene into multiple LOD levels and packages a streaming `lod-meta.json` viewer.

**Architecture:** When the viewer export type is ZIP and streaming is enabled, `serializeViewer` decimates the fully-edited top-LOD `DataTable` (from the existing `extractDataTable`) into independent coarser LOD levels via `simplifyGaussians`, tags each with a `lod` column, `combine()`s them, and feeds the result to `writeLod` to produce the streaming bundle. The viewer shell is obtained by running `writeHtml` (unbundled) into a `MemoryFileSystem` and repointing its content fetch from the throwaway SOG to `lod-meta.json`, then everything is zipped. Decimation from the edited top LOD means every edit (deletions, transforms, grade, SH bands) is honored automatically.

**Tech Stack:** TypeScript, `@playcanvas/splat-transform` 2.4.0 (`simplifyGaussians`, `combine`, `writeLod`, `writeHtml`, `MemoryFileSystem`, `ZipFileSystem`), `@playcanvas/pcui` (`BooleanInput`), rollup build, eslint.

**Reference spec:** `docs/superpowers/specs/2026-05-30-streaming-lod-export-design.md`

---

## Important context for the implementer

- **No automated test harness exists** in this repo. The verification gate for code tasks is:
  - `npm run lint` (eslint over `src`) — must pass with no new errors.
  - `npm run build` (rollup + typescript) — must compile with no type errors.
  - Final manual browser verification (Task 6).
- **Do not run `cd` before commands.** The working directory is already the project root; run `npm`/`git` directly.
- `@playcanvas/splat-transform` is at **2.4.0**. Confirmed API facts this plan relies on:
  - `simplifyGaussians(dataTable, targetCount, createDevice?) => Promise<DataTable>` (async; pass `createGpuDevice` for GPU path). Returns a new table; `clone` preserves the source `Transform`.
  - `combine(dataTables: DataTable[]) => DataTable` concatenates rows; columns matched by name. All inputs here share `Transform.PLY`, so no space conversion occurs.
  - `writeLod({ filename, dataTable, envDataTable, iterations, createDevice, chunkCount, chunkExtent }, fs)` requires a `lod` column (throws `Missing lod assignment` otherwise), writes `lod-meta.json` plus chunk subfolders, and skips env when `envDataTable` is null.
  - Unbundled `writeHtml` (`bundle: false`) writes `index.html`, `index.css`, `index.js`, `settings.json`, and `index.sog`, with the HTML containing the literal `fetch("index.sog")`.
- **Branch:** work continues on `feature/streaming-lod-export` (already created; the spec is committed there).

## File structure

- **Modify** `src/splat-serialize.ts`
  - Add `streaming?: boolean` to `ViewerExportSettings`.
  - Add `writeLod`, `combine`, `simplifyGaussians` to the `@playcanvas/splat-transform` import.
  - Add `buildStreamingLodTable` and `serializeStreamingViewer` helpers.
  - Branch `serializeViewer` to the streaming path when ZIP + streaming.
- **Modify** `src/ui/export-popup.ts`
  - Add the "Streaming" toggle row, its visibility wiring (viewer + ZIP only), and emit `streaming` in the assembled viewer options.
- **Modify** `static/locales/*.json` (9 files)
  - Add `popup.export.streaming` label.

---

## Task 1: Add `streaming` option type and splat-transform imports

**Files:**
- Modify: `src/splat-serialize.ts:1-14` (import block)
- Modify: `src/splat-serialize.ts:136-140` (`ViewerExportSettings` type)

- [ ] **Step 1: Add the new imports**

Replace the import block at `src/splat-serialize.ts:1-14`:

```ts
import {
    Column,
    combine,
    DataTable,
    logger as splatTransformLogger,
    MemoryFileSystem,
    simplifyGaussians,
    Transform,
    writeHtml,
    writeLod,
    writeSog as writeSogInternal,
    ZipFileSystem,
    type FileSystem,
    type LogEvent,
    type Renderer,
    type Writer
} from '@playcanvas/splat-transform';
```

- [ ] **Step 2: Add the `streaming` field to `ViewerExportSettings`**

Replace `src/splat-serialize.ts:136-140`:

```ts
type ViewerExportSettings = {
    type: 'html' | 'zip';
    streaming?: boolean;
    experienceSettings: ExperienceSettings;
    events?: Events;
};
```

- [ ] **Step 3: Verify it compiles and lints**

Run: `npm run lint`
Expected: passes (no errors in `src/splat-serialize.ts`).

Run: `npm run build`
Expected: build succeeds, no TypeScript errors. (Unused-import warnings for `combine`/`writeLod`/`simplifyGaussians` are acceptable here because Task 2 uses them; if eslint fails the build on unused imports, proceed directly to Task 2 and run lint/build at the end of Task 2 instead. Note which happened.)

- [ ] **Step 4: Commit**

```bash
git add src/splat-serialize.ts
git commit -m "feat(export): add streaming flag and LOD imports for streaming viewer"
```

---

## Task 2: Add the streaming LOD pipeline helpers

**Files:**
- Modify: `src/splat-serialize.ts` (insert helpers immediately before `const serializeViewer = ...` at line ~1270)

- [ ] **Step 1: Insert the helper functions**

Insert the following immediately before the `const serializeViewer = async (...)` declaration (currently line ~1270). It must appear after `createGpuDevice` (line ~1122) and `extractDataTable` (line ~1164), both of which it uses:

```ts
// Streaming LOD export tuning. LOD 0 is the full-resolution, fully-edited
// scene. Each subsequent level decimates the FULL scene (not the previous
// level) down to a quarter of the running target, so every level is an
// independent representation of the whole scene at lower density. Levels stop
// once the next would fall below MIN_LOD_SPLATS or once MAX_LOD_LEVELS exist.
const MAX_LOD_LEVELS = 4;
const LOD_DECIMATION_FACTOR = 4;
const MIN_LOD_SPLATS = 64 * 1024;

// Build a single DataTable carrying a per-gaussian `lod` column (0 = finest),
// suitable for writeLod. Decimation runs against the untagged lod0 so the
// merge math never sees the synthetic `lod` column; lod0 is tagged last.
const buildStreamingLodTable = async (lod0: DataTable): Promise<DataTable> => {
    const levels: DataTable[] = [];

    let target = lod0.numRows;
    for (let level = 1; level < MAX_LOD_LEVELS; ++level) {
        target = Math.floor(target / LOD_DECIMATION_FACTOR);
        if (target < MIN_LOD_SPLATS) {
            break;
        }
        const simplified = await simplifyGaussians(lod0, target, createGpuDevice);
        simplified.addColumn(new Column('lod', new Float32Array(simplified.numRows).fill(level)));
        levels.push(simplified);
    }

    lod0.addColumn(new Column('lod', new Float32Array(lod0.numRows).fill(0)));
    levels.unshift(lod0);

    // All levels share lod0's Transform.PLY (clone preserves it), so combine
    // concatenates rows without any coordinate-space conversion.
    return combine(levels);
};

// Produce a streaming viewer ZIP: a viewer shell (from unbundled writeHtml)
// repointed at lod-meta.json, plus the writeLod streaming bundle.
const serializeStreamingViewer = async (
    dataTable: DataTable,
    viewerSettingsJson: ExperienceSettings,
    fs: FileSystem
): Promise<void> => {
    const memFs = new MemoryFileSystem();

    // A 1-row placeholder keeps writeHtml's throwaway content SOG cheap to
    // produce (we only want its index.html/css/js/settings.json shell).
    const placeholder = dataTable.clone({ rows: [0] });
    await writeHtml({
        filename: 'index.html',
        dataTable: placeholder,
        viewerSettingsJson,
        bundle: false,
        iterations: 10,
        createDevice: createGpuDevice
    }, memFs);

    // Streaming bundle: lod-meta.json + per-LOD SOG chunk folders.
    const lodTable = await buildStreamingLodTable(dataTable);
    await writeLod({
        filename: 'lod-meta.json',
        dataTable: lodTable,
        envDataTable: null,
        iterations: 10,
        createDevice: createGpuDevice,
        chunkCount: 512,
        chunkExtent: 16
    }, memFs);

    // Drop the throwaway content SOG and repoint the viewer at the LOD bundle.
    memFs.results.delete('index.sog');
    const html = new TextDecoder().decode(memFs.results.get('index.html'));
    const repointed = html.replace('fetch("index.sog")', 'fetch("./lod-meta.json")');
    if (repointed === html) {
        throw new Error('Streaming export failed: could not repoint viewer content to lod-meta.json (writeHtml output format changed)');
    }
    memFs.results.set('index.html', new TextEncoder().encode(repointed));

    // ZIP every emitted file. Keys are normalised to relative paths so the
    // viewer's relative chunk references resolve from the archive root
    // regardless of how writeLod composed its output paths.
    const zipWriter = await fs.createWriter('output.zip');
    const zipFs = new ZipFileSystem(zipWriter);
    try {
        for (const [filename, data] of memFs.results.entries()) {
            const entry = filename.replace(/^\/+/, '');
            const writer = await zipFs.createWriter(entry);
            await writer.write(data);
            await writer.close();
        }
    } finally {
        await zipFs.close();
    }
};
```

- [ ] **Step 2: Verify it compiles and lints**

Run: `npm run lint`
Expected: passes (no unused-symbol errors now that the imports are used).

Run: `npm run build`
Expected: build succeeds, no type errors. `serializeStreamingViewer` is unused until Task 3; if eslint flags it as unused, continue to Task 3 and re-run lint/build there. Note which happened.

- [ ] **Step 3: Commit**

```bash
git add src/splat-serialize.ts
git commit -m "feat(export): add decimation-based streaming LOD bundle helpers"
```

---

## Task 3: Branch `serializeViewer` to the streaming path

**Files:**
- Modify: `src/splat-serialize.ts:1283-1320` (the `try { ... }` body inside `serializeViewer`)

- [ ] **Step 1: Add the streaming branch**

In `serializeViewer`, the body currently reads (around lines 1283-1320):

```ts
    try {
        if (options.type === 'html') {
            // Bundled HTML - writeHtml handles everything
            await writeHtml({
                filename: 'output.html',
                dataTable,
                viewerSettingsJson: experienceSettings,
                bundle: true,
                iterations: 10,
                createDevice: createGpuDevice
            }, fs);
        } else {
            // Package - use unbundled mode into a MemoryFileSystem, then ZIP
            const memFs = new MemoryFileSystem();
            await writeHtml({
```

Insert a streaming branch between the `html` branch and the existing `else` (the existing `else` becomes `else` for non-streaming ZIP). The result:

```ts
    try {
        if (options.type === 'html') {
            // Bundled HTML - writeHtml handles everything
            await writeHtml({
                filename: 'output.html',
                dataTable,
                viewerSettingsJson: experienceSettings,
                bundle: true,
                iterations: 10,
                createDevice: createGpuDevice
            }, fs);
        } else if (options.streaming) {
            // Streaming ZIP - decimate into LOD levels and write a lod-meta.json bundle
            await serializeStreamingViewer(dataTable, experienceSettings, fs);
        } else {
            // Package - use unbundled mode into a MemoryFileSystem, then ZIP
            const memFs = new MemoryFileSystem();
            await writeHtml({
```

Leave the remainder of the existing `else` block (the unbundled writeHtml + ZIP loop) unchanged.

- [ ] **Step 2: Verify it compiles and lints**

Run: `npm run lint`
Expected: passes.

Run: `npm run build`
Expected: build succeeds, no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/splat-serialize.ts
git commit -m "feat(export): route streaming ZIP viewer export to LOD bundle path"
```

---

## Task 4: Add the Streaming toggle to the export panel

**Files:**
- Modify: `src/ui/export-popup.ts`

- [ ] **Step 1: Create the streaming row**

In `src/ui/export-popup.ts`, after the `iterationsRow` block (ends ~line 233, just before the `// filename` block at ~line 235), insert:

```ts
        // viewer: streaming (zip only)

        const streamingRow = new Container({
            class: 'row'
        });

        const streamingLabel = new Label({
            class: 'label',
            text: localize('popup.export.streaming')
        });

        const streamingToggle = new BooleanInput({
            class: 'boolean',
            type: 'toggle',
            value: true
        });

        streamingRow.append(streamingLabel);
        streamingRow.append(streamingToggle);
```

- [ ] **Step 2: Append the row to the content container**

In the content-append sequence (currently lines ~255-263), add `streamingRow` right after `iterationsRow`:

```ts
        content.append(viewerTypeRow);
        content.append(animationRow);
        content.append(loopRow);
        content.append(colorRow);
        content.append(fovRow);
        content.append(compressRow);
        content.append(bandsRow);
        content.append(iterationsRow);
        content.append(streamingRow);
        content.append(filenameRow);
```

- [ ] **Step 3: Track the current export type and add a visibility helper**

The streaming row must be visible only for the `viewer` export type AND when the type selector is `zip`. Add a closure variable and a helper.

Just before the `const reset = (...)` declaration (currently ~line 326), add:

```ts
        let currentExportType: ExportType;

        const updateStreamingVisibility = () => {
            streamingRow.hidden = currentExportType !== 'viewer' || viewerTypeSelect.value !== 'zip';
        };
```

- [ ] **Step 4: Wire visibility into the type-select change handler**

The existing handler (currently ~lines 318-320) is:

```ts
        viewerTypeSelect.on('change', () => {
            updateExtension(viewerTypeSelect.value === 'html' ? '.html' : '.zip');
        });
```

Replace it with:

```ts
        viewerTypeSelect.on('change', () => {
            updateExtension(viewerTypeSelect.value === 'html' ? '.html' : '.zip');
            updateStreamingVisibility();
        });
```

- [ ] **Step 5: Include `streamingRow` in `reset()` row management and default it on**

In `reset()` (currently ~lines 326-382):

1. Set `currentExportType` at the top of `reset`. Change the signature body start from:

```ts
        const reset = (exportType: ExportType, splatNames: string[], hasPoses: boolean) => {
            const allRows = [
                viewerTypeRow, animationRow, loopRow, colorRow, fovRow, compressRow, bandsRow, iterationsRow, filenameRow
            ];

            const activeRows = {
                ply: [compressRow, bandsRow, filenameRow],
                splat: [filenameRow],
                sog: [bandsRow, iterationsRow, filenameRow],
                viewer: [viewerTypeRow, animationRow, loopRow, colorRow, fovRow, bandsRow, filenameRow],
                viewerSettings: [animationRow, loopRow, colorRow, fovRow, filenameRow]
            }[exportType];
```

to:

```ts
        const reset = (exportType: ExportType, splatNames: string[], hasPoses: boolean) => {
            currentExportType = exportType;

            const allRows = [
                viewerTypeRow, animationRow, loopRow, colorRow, fovRow, compressRow, bandsRow, iterationsRow, streamingRow, filenameRow
            ];

            const activeRows = {
                ply: [compressRow, bandsRow, filenameRow],
                splat: [filenameRow],
                sog: [bandsRow, iterationsRow, filenameRow],
                viewer: [viewerTypeRow, animationRow, loopRow, colorRow, fovRow, bandsRow, streamingRow, filenameRow],
                viewerSettings: [animationRow, loopRow, colorRow, fovRow, filenameRow]
            }[exportType];
```

2. Default the toggle on and apply the zip-only visibility. After the existing `iterationsSlider.value = 10;` line (the `// sog` reset, ~line 349), add:

```ts
            // streaming (viewer zip only)
            streamingToggle.value = true;
            updateStreamingVisibility();
```

- [ ] **Step 6: Emit `streaming` in the assembled viewer options**

In `assembleViewerOptions` (currently ~lines 491-502), the returned `viewerExportSettings` is:

```ts
                    viewerExportSettings: {
                        type: viewerTypeSelect.value,
                        experienceSettings
                    }
```

Replace with:

```ts
                    viewerExportSettings: {
                        type: viewerTypeSelect.value,
                        streaming: streamingToggle.value,
                        experienceSettings
                    }
```

(No change needed in `assembleViewerSettingsOptions`; it reuses this object and `serializeViewerSettings` ignores `streaming`.)

- [ ] **Step 7: Verify it compiles and lints**

Run: `npm run lint`
Expected: passes.

Run: `npm run build`
Expected: build succeeds, no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/ui/export-popup.ts
git commit -m "feat(export): add Streaming toggle to viewer export panel (zip only)"
```

---

## Task 5: Add localization for the Streaming label

**Files:**
- Modify: `static/locales/en.json`, `fr.json`, `de.json`, `es.json`, `ja.json`, `ko.json`, `pt-BR.json`, `ru.json`, `zh-CN.json`

- [ ] **Step 1: Add the `popup.export.streaming` key to each locale**

In each file, add a `"popup.export.streaming"` entry next to the other `popup.export.*` keys (e.g. directly after `"popup.export.compress-ply"`). Match each file's existing JSON style (trailing commas, indentation). Use these values:

- `en.json`: `"popup.export.streaming": "Streaming"`
- `fr.json`: `"popup.export.streaming": "Streaming"`
- `de.json`: `"popup.export.streaming": "Streaming"`
- `es.json`: `"popup.export.streaming": "Streaming"`
- `pt-BR.json`: `"popup.export.streaming": "Streaming"`
- `ja.json`: `"popup.export.streaming": "ストリーミング"`
- `ko.json`: `"popup.export.streaming": "스트리밍"`
- `ru.json`: `"popup.export.streaming": "Потоковая передача"`
- `zh-CN.json`: `"popup.export.streaming": "流式传输"`

- [ ] **Step 2: Verify JSON validity**

Run: `node -e "['en','fr','de','es','ja','ko','pt-BR','ru','zh-CN'].forEach(l=>{const j=require('C:/Dev/playcanvas/supersplat/static/locales/'+l+'.json'); if(!j['popup.export.streaming']) throw new Error('missing in '+l); console.log(l, j['popup.export.streaming']);})"`
Expected: prints all 9 locales with their streaming label; no error.

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add static/locales/en.json static/locales/fr.json static/locales/de.json static/locales/es.json static/locales/ja.json static/locales/ko.json static/locales/pt-BR.json static/locales/ru.json static/locales/zh-CN.json
git commit -m "feat(export): localize Streaming toggle label"
```

---

## Task 6: Manual end-to-end verification

**Files:** none (manual verification)

This repo has no automated tests, so verify behavior in the running app.

- [ ] **Step 1: Start the dev server**

Run: `npm run develop`
Expected: rollup watches and `serve` hosts the app (default at `http://localhost:3333/`). Open it in a browser.

- [ ] **Step 2: Verify the toggle visibility rules**

- Import any splat scene (PLY/SOG/LCC). Choose Export > Viewer.
- With type = HTML: the Streaming row is hidden.
- Switch type to ZIP Package: the Streaming row appears, defaulted ON.
- Switch back to HTML: the Streaming row hides again.
Expected: all three behaviors hold.

- [ ] **Step 2b (optional debug): inspect the emitted ZIP entry keys**

If the streaming viewer fails to load chunks (Step 4), temporarily add `console.log([...memFs.results.keys()])` before the ZIP loop in `serializeStreamingViewer` and re-export to confirm `lod-meta.json` and the `<n>_<i>/meta.json` chunk folders are present and relative. Remove the log afterward.

- [ ] **Step 3: Export a streaming ZIP**

- Make a visible edit first (e.g. delete some floaters / transform the scene).
- Export > Viewer > ZIP Package, Streaming ON, export.
Expected: progress UI runs (decimation + LOD writing), a `.zip` is produced. Unzip it and confirm it contains `index.html`, `index.css`, `index.js`, `settings.json`, `lod-meta.json`, and `<n>_<i>/` chunk folders, and that there is NO `index.sog`.

- [ ] **Step 4: Serve and load the streaming viewer**

Serve the unzipped folder over HTTP (e.g. `npx serve <folder>`), open it, and confirm:
- The scene renders and streams (LODs load as you move the camera).
- Your edit from Step 3 is reflected (deleted gaussians stay gone, transform applied).
Expected: viewer loads `lod-meta.json` and renders the edited scene. (Note: opening `index.html` via `file://` will not fetch chunks — must be served over HTTP.)

- [ ] **Step 5: Verify non-streaming paths are unchanged**

- Export > Viewer > ZIP Package with Streaming OFF: confirm it produces the original single-SOG unbundled viewer ZIP (contains `index.sog`, no `lod-meta.json`).
- Export > Viewer > HTML: confirm a single self-contained `.html` still works.
Expected: both unchanged from before.

- [ ] **Step 6: Verify SH bands interaction**

- Export streaming ZIP with the SH Bands slider lowered (e.g. 0). Confirm the bundle is smaller / lighting reflects reduced bands.
Expected: the bands setting applies to all LOD chunks (it is baked into LOD0 before decimation).

---

## Self-review notes (already applied)

- **Spec coverage:** UI toggle (Task 4), zip-only visibility (Task 4 Steps 3-5), any-scene availability / no LCC gating (no gating code added anywhere), default ON (Task 4 Steps 1 & 5), decimation pipeline (Task 2), `writeLod` bundle (Task 2), viewer-shell repoint (Task 2), env left null (Task 2), SH bands via existing `extractDataTable` (verified Task 6 Step 6), localization (Task 5). All spec sections map to a task.
- **Type consistency:** `streaming?: boolean` defined in Task 1 is read in Task 3 (`options.streaming`) and written in Task 4 (`streaming: streamingToggle.value`). Helper names `buildStreamingLodTable` / `serializeStreamingViewer` defined in Task 2 are called in Task 2/Task 3 exactly as named. `updateStreamingVisibility` / `currentExportType` / `streamingRow` / `streamingToggle` defined and used consistently in Task 4.
- **No placeholders:** every code step contains the full code to insert.
