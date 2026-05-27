# Export Viewer Settings (.json) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Viewer Settings (.json)` entry in the export menu that exports only the `ExperienceSettings` JSON, with no splat data or HTML wrapper.

**Architecture:** Plug a new `'viewerSettings'` `ExportType`/`FileType` into the existing export flow (`scene.export` → `show.exportPopup` → `scene.write`). Reuse the existing export popup with only the rows that affect `ExperienceSettings` (animation, loop, background color, FOV, filename). A new `serializeViewerSettings` helper in `splat-serialize.ts` writes the JSON via the same `BrowserFileSystem` used by the other exporters, so save-file-picker and download-fallback both work for free.

**Tech Stack:** TypeScript, PCUI, PlayCanvas, `@playcanvas/splat-transform` (`FileSystem`/`Writer`), Rollup build, ESLint.

**Spec:** `docs/superpowers/specs/2026-05-27-export-viewer-settings-design.md`

**Project test posture:** This project has no test framework (only `npm run lint`). The plan therefore uses lint + manual browser verification instead of TDD. Where I'd normally write a failing test, I instead define the exact code change and a lint/manual check.

---

## File Structure

Files modified (no new files):

- `src/file-handler.ts` — extend `ExportType`, `FileType`, `filePickerTypes`; route the new export type through `scene.export` and `scene.write`.
- `src/splat-serialize.ts` — new exported helper `serializeViewerSettings`.
- `src/ui/menu.ts` — add the new menu entry below `Viewer App`.
- `src/ui/export-popup.ts` — show only the relevant rows for `viewerSettings`; build the options object for it.
- `static/locales/en.json` and the other 8 locale files — add `menu.file.export.viewerSettings`.

---

## Task 1: Add type plumbing in `src/file-handler.ts`

**Files:**
- Modify: `src/file-handler.ts:15`, `src/file-handler.ts:17`, `src/file-handler.ts:34-97`

- [ ] **Step 1: Extend `ExportType`**

Replace line 15:

```ts
type ExportType = 'ply' | 'splat' | 'sog' | 'viewer';
```

with:

```ts
type ExportType = 'ply' | 'splat' | 'sog' | 'viewer' | 'viewerSettings';
```

- [ ] **Step 2: Extend `FileType`**

Replace line 17:

```ts
type FileType = 'ply' | 'compressedPly' | 'splat' | 'sog' | 'htmlViewer' | 'packageViewer';
```

with:

```ts
type FileType = 'ply' | 'compressedPly' | 'splat' | 'sog' | 'htmlViewer' | 'packageViewer' | 'viewerSettings';
```

- [ ] **Step 3: Add the `filePickerTypes` entry**

Inside the `filePickerTypes` object literal in `src/file-handler.ts` (currently ends at line 97 with `}`), add a new entry — place it directly after the `'packageViewer'` entry (around line 96):

```ts
    'viewerSettings': {
        description: 'Viewer Settings JSON',
        accept: {
            'application/json': ['.json']
        }
    }
```

Remember to add a trailing comma to the preceding entry (`packageViewer`) so the object literal stays valid.

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/file-handler.ts
git commit -m "feat(export): add viewerSettings ExportType/FileType plumbing"
```

---

## Task 2: Add `serializeViewerSettings` in `src/splat-serialize.ts`

**Files:**
- Modify: `src/splat-serialize.ts` — add new function near `serializeViewer` (around line 1325), and add to the export list at the bottom (around line 1378).

- [ ] **Step 1: Add the function**

Add the following definition immediately after `serializeViewer` ends (the line is `};` at approx. line 1325):

```ts
const serializeViewerSettings = async (
    experienceSettings: ExperienceSettings,
    fs: FileSystem,
    filename: string
): Promise<void> => {
    const writer = await fs.createWriter(filename);
    try {
        const json = JSON.stringify(experienceSettings, null, 4);
        await writer.write(new TextEncoder().encode(json));
    } finally {
        await writer.close();
    }
};
```

`FileSystem` is already imported at `src/splat-serialize.ts:10` (`type FileSystem` from `@playcanvas/splat-transform`). `ExperienceSettings` is defined at line 120 in the same file.

- [ ] **Step 2: Add it to the export list**

In the `export {` block at the bottom of `src/splat-serialize.ts` (around line 1360), add `serializeViewerSettings` next to the other `serialize*` exports. The block currently looks like:

```ts
export {
    serializePly,
    serializePlyCompressed,
    serializeSplat,
    serializeSog,
    serializeViewer,
    AnimTrack,
    CameraPose,
    Camera,
    Annotation,
    PostEffectSettings,
    defaultPostEffectSettings,
    ExperienceSettings,
    SerializeSettings,
    SogSettings,
    ViewerExportSettings
};
```

Make it:

```ts
export {
    serializePly,
    serializePlyCompressed,
    serializeSplat,
    serializeSog,
    serializeViewer,
    serializeViewerSettings,
    AnimTrack,
    CameraPose,
    Camera,
    Annotation,
    PostEffectSettings,
    defaultPostEffectSettings,
    ExperienceSettings,
    SerializeSettings,
    SogSettings,
    ViewerExportSettings
};
```

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/splat-serialize.ts
git commit -m "feat(serialize): add serializeViewerSettings helper"
```

---

## Task 3: Wire `viewerSettings` through `scene.export` and `scene.write`

**Files:**
- Modify: `src/file-handler.ts:9` (import), `src/file-handler.ts:488-522` (`scene.export`), `src/file-handler.ts:524-585` (`scene.write`)

- [ ] **Step 1: Import `serializeViewerSettings`**

Update the import at line 9. It currently is:

```ts
import { serializePly, serializePlyCompressed, SerializeSettings, serializeSog, serializeSplat, serializeViewer, SogSettings, ViewerExportSettings } from './splat-serialize';
```

Change to:

```ts
import { serializePly, serializePlyCompressed, SerializeSettings, serializeSog, serializeSplat, serializeViewer, serializeViewerSettings, SogSettings, ViewerExportSettings } from './splat-serialize';
```

- [ ] **Step 2: Extend the `fileType` derivation in `scene.export`**

Lines 501-504 currently:

```ts
const fileType: FileType =
    (exportType === 'viewer') ? (options.viewerExportSettings!.type === 'zip' ? 'packageViewer' : 'htmlViewer') :
        (exportType === 'ply') ? (options.compressedPly ? 'compressedPly' : 'ply') :
            (exportType === 'sog') ? 'sog' : 'splat';
```

Replace with:

```ts
const fileType: FileType =
    (exportType === 'viewer') ? (options.viewerExportSettings!.type === 'zip' ? 'packageViewer' : 'htmlViewer') :
        (exportType === 'viewerSettings') ? 'viewerSettings' :
            (exportType === 'ply') ? (options.compressedPly ? 'compressedPly' : 'ply') :
                (exportType === 'sog') ? 'sog' : 'splat';
```

- [ ] **Step 3: Update the `useSpinner` derivation in `scene.write`**

Line 526 currently:

```ts
const useSpinner = fileType !== 'sog' && fileType !== 'htmlViewer' && fileType !== 'packageViewer';
```

Replace with:

```ts
const useSpinner = fileType !== 'sog' && fileType !== 'htmlViewer' && fileType !== 'packageViewer' && fileType !== 'viewerSettings';
```

(Writing a small JSON file is instant — no spinner needed.)

- [ ] **Step 4: Add the `viewerSettings` case to the `scene.write` switch**

The switch starts at line 545. Add a new case immediately after the `case 'htmlViewer': case 'packageViewer':` block (after `break;` at line 571):

```ts
                case 'viewerSettings':
                    await serializeViewerSettings(viewerExportSettings!.experienceSettings, fs, filename);
                    break;
```

(Indentation should match the surrounding switch cases — 16 spaces of leading whitespace.)

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/file-handler.ts
git commit -m "feat(export): route viewerSettings through scene.export and scene.write"
```

---

## Task 4: Update export popup for `viewerSettings`

**Files:**
- Modify: `src/ui/export-popup.ts:326-378` (`reset`), `src/ui/export-popup.ts:380-525` (`show` body)

- [ ] **Step 1: Add `viewerSettings` to the `activeRows` map**

Lines 331-336 currently:

```ts
const activeRows = {
    ply: [compressRow, bandsRow, filenameRow],
    splat: [filenameRow],
    sog: [bandsRow, iterationsRow, filenameRow],
    viewer: [viewerTypeRow, animationRow, loopRow, colorRow, fovRow, bandsRow, filenameRow]
}[exportType];
```

Replace with:

```ts
const activeRows = {
    ply: [compressRow, bandsRow, filenameRow],
    splat: [filenameRow],
    sog: [bandsRow, iterationsRow, filenameRow],
    viewer: [viewerTypeRow, animationRow, loopRow, colorRow, fovRow, bandsRow, filenameRow],
    viewerSettings: [animationRow, loopRow, colorRow, fovRow, filenameRow]
}[exportType];
```

- [ ] **Step 2: Add the `.json` extension default**

Lines 352-365 currently:

```ts
switch (exportType) {
    case 'ply':
        updateExtension('.ply');
        break;
    case 'splat':
        updateExtension('.splat');
        break;
    case 'sog':
        updateExtension('.sog');
        break;
    case 'viewer':
        updateExtension(viewerTypeSelect.value === 'html' ? '.html' : '.zip');
        break;
}
```

Add a new case at the end before `}`:

```ts
    case 'viewerSettings':
        updateExtension('.json');
        break;
```

- [ ] **Step 3: Add the `assembleViewerSettingsOptions` helper**

Inside `this.show = ...` (after `assembleViewerOptions` ends at line 498, before the `return new Promise<...>(...)` at line 500), add:

```ts
            const assembleViewerSettingsOptions = (): SceneExportOptions => {
                const viewerOptions = assembleViewerOptions();
                return {
                    filename: viewerOptions.filename,
                    splatIdx: 'all',
                    serializeSettings: {},
                    viewerExportSettings: viewerOptions.viewerExportSettings
                };
            };
```

This reuses the camera/animation/background/FOV assembly already in `assembleViewerOptions` and just drops the SH-bands `serializeSettings` (since no splat data is written).

- [ ] **Step 4: Add the `viewerSettings` case to the `onExport` switch**

Lines 506-519 currently:

```ts
switch (exportType) {
    case 'ply':
        resolve(assemblePlyOptions());
        break;
    case 'splat':
        resolve(assembleSplatOptions());
        break;
    case 'sog':
        resolve(assembleSogOptions());
        break;
    case 'viewer':
        resolve(assembleViewerOptions());
        break;
}
```

Add a new case before the closing `}`:

```ts
    case 'viewerSettings':
        resolve(assembleViewerSettingsOptions());
        break;
```

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/ui/export-popup.ts
git commit -m "feat(export): show viewerSettings options in export popup"
```

---

## Task 5: Add the menu entry in `src/ui/menu.ts`

**Files:**
- Modify: `src/ui/menu.ts:124-146`

- [ ] **Step 1: Insert the new entry after `Viewer App`**

Lines 141-146 currently:

```ts
        }, {
            text: localize('menu.file.export.viewer', { ellipsis: true }),
            icon: createSvg(sceneExport),
            isEnabled: () => !events.invoke('scene.empty'),
            onSelect: () => events.invoke('scene.export', 'viewer')
        }]);
```

Replace with:

```ts
        }, {
            text: localize('menu.file.export.viewer', { ellipsis: true }),
            icon: createSvg(sceneExport),
            isEnabled: () => !events.invoke('scene.empty'),
            onSelect: () => events.invoke('scene.export', 'viewer')
        }, {
            text: localize('menu.file.export.viewerSettings', { ellipsis: true }),
            icon: createSvg(sceneExport),
            isEnabled: () => !events.invoke('scene.empty'),
            onSelect: () => events.invoke('scene.export', 'viewerSettings')
        }]);
```

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/ui/menu.ts
git commit -m "feat(menu): add Viewer Settings (.json) export entry"
```

---

## Task 6: Add localization keys

**Files:**
- Modify: `static/locales/en.json`, `static/locales/fr.json`, `static/locales/de.json`, `static/locales/es.json`, `static/locales/pt-BR.json`, `static/locales/ja.json`, `static/locales/ko.json`, `static/locales/ru.json`, `static/locales/zh-CN.json`

In each file, the existing block looks like:

```json
"menu.file.export": "<value>",
"menu.file.export.ply": "PLY (.ply)",
"menu.file.export.splat": "Splat (.splat)",
"menu.file.export.sog": "SOG (.sog)",
"menu.file.export.viewer": "<value>",
```

Insert a new entry `"menu.file.export.viewerSettings": "<value>"` immediately after the `menu.file.export.viewer` line. Preserve existing surrounding commas and indentation. Use these values:

| File | Value |
|------|-------|
| `static/locales/en.json` | `"Viewer Settings (.json)"` |
| `static/locales/fr.json` | `"Paramètres de visualisation (.json)"` |
| `static/locales/de.json` | `"Viewer-Einstellungen (.json)"` |
| `static/locales/es.json` | `"Configuración del visor (.json)"` |
| `static/locales/pt-BR.json` | `"Configurações de Visualização (.json)"` |
| `static/locales/ja.json` | `"ビューア設定 (.json)"` |
| `static/locales/ko.json` | `"뷰어 설정 (.json)"` |
| `static/locales/ru.json` | `"Настройки просмотра (.json)"` |
| `static/locales/zh-CN.json` | `"查看器设置 (.json)"` |

- [ ] **Step 1: Edit `en.json`**

In `static/locales/en.json`, after the line:

```json
    "menu.file.export.viewer": "Viewer App",
```

Add:

```json
    "menu.file.export.viewerSettings": "Viewer Settings (.json)",
```

- [ ] **Step 2: Edit `fr.json`**

After the existing `menu.file.export.viewer` line, add:

```json
    "menu.file.export.viewerSettings": "Paramètres de visualisation (.json)",
```

- [ ] **Step 3: Edit `de.json`**

After the existing `menu.file.export.viewer` line, add:

```json
    "menu.file.export.viewerSettings": "Viewer-Einstellungen (.json)",
```

- [ ] **Step 4: Edit `es.json`**

After the existing `menu.file.export.viewer` line, add:

```json
    "menu.file.export.viewerSettings": "Configuración del visor (.json)",
```

- [ ] **Step 5: Edit `pt-BR.json`**

After the existing `menu.file.export.viewer` line, add:

```json
    "menu.file.export.viewerSettings": "Configurações de Visualização (.json)",
```

- [ ] **Step 6: Edit `ja.json`**

After the existing `menu.file.export.viewer` line, add:

```json
    "menu.file.export.viewerSettings": "ビューア設定 (.json)",
```

- [ ] **Step 7: Edit `ko.json`**

After the existing `menu.file.export.viewer` line, add:

```json
    "menu.file.export.viewerSettings": "뷰어 설정 (.json)",
```

- [ ] **Step 8: Edit `ru.json`**

After the existing `menu.file.export.viewer` line, add:

```json
    "menu.file.export.viewerSettings": "Настройки просмотра (.json)",
```

- [ ] **Step 9: Edit `zh-CN.json`**

After the existing `menu.file.export.viewer` line, add:

```json
    "menu.file.export.viewerSettings": "查看器设置 (.json)",
```

- [ ] **Step 10: Validate all JSON files parse**

Run:

```bash
node -e "['en','fr','de','es','pt-BR','ja','ko','ru','zh-CN'].forEach(l => { JSON.parse(require('fs').readFileSync('static/locales/'+l+'.json','utf8')); console.log(l+' OK'); })"
```

Expected output: nine lines, one per locale, each ending in `OK`.

- [ ] **Step 11: Commit**

```bash
git add static/locales/*.json
git commit -m "i18n: add menu.file.export.viewerSettings entries"
```

---

## Task 7: Manual UI verification

**Files:** none modified. This task verifies the feature end-to-end in the browser. No commit.

- [ ] **Step 1: Build / start dev server**

Run: `npm run develop`
Expected: rollup watcher starts and a local server serves `dist` on `http://localhost:3000` (no compile errors).

- [ ] **Step 2: Load a small splat**

Open `http://localhost:3000`. Drag any small `.ply`, `.splat`, or `.sog` file onto the canvas. Expected: the splat renders.

- [ ] **Step 3: Open the export submenu**

Click `Scene > Export`. Expected: menu shows in this order — `PLY (.ply)`, `Splat (.splat)`, `SOG (.sog)`, separator, `Viewer App…`, `Viewer Settings (.json)…`.

- [ ] **Step 4: Open the popup**

Click `Viewer Settings (.json)…`. Expected: the export popup opens showing only these rows: Animation, Loop mode (disabled if no camera poses), Background color, FOV. The filename row appears too in browsers without `showSaveFilePicker` (e.g. Safari).

- [ ] **Step 5: Confirm rows omitted**

In the popup, verify these rows are NOT visible: viewer Type (html/zip), Compress PLY, SH bands, SOG iterations. (Bands and type are irrelevant to settings.json.)

- [ ] **Step 6: Export with default settings**

Click `Export`. Expected: the OS save-file dialog appears (in Chrome/Edge) with a `.json` default name (`<splatName>.json`). Accept and save.

- [ ] **Step 7: Inspect the saved file**

Open the saved file in a text editor. Expected: valid JSON beginning with `{`, containing at minimum the keys `version`, `tonemapping`, `highPrecisionRendering`, `background`, `postEffectSettings`, `animTracks`, `cameras`, `annotations`, `startMode`.

- [ ] **Step 8: Cross-check against HTML export**

In the same session, also export `Viewer App` as HTML (bundled). Open the resulting `.html` in a text editor and locate the `viewerSettingsJson` blob. Compare with the standalone `settings.json` from step 7 — fields used in both should match (when the same options were chosen). Minor field ordering differences are acceptable; values must agree.

- [ ] **Step 9: Edge — empty scene**

Reload the page (do not import any splat). Click `Scene > Export`. Expected: `Viewer Settings (.json)…` is greyed out (it shares the `!events.invoke('scene.empty')` guard with the other export entries).

- [ ] **Step 10: Edge — Safari fallback path (optional, if Safari available)**

In Safari (which lacks `showSaveFilePicker`), repeat steps 2-6. Expected: the popup shows the Filename row; on confirm, the browser triggers a download via the `BrowserDownloadWriter` fallback in `src/io/write/browser-file-system.ts`.

- [ ] **Step 11: Localization spot-check**

In the dev server URL, append `?lang=fr` (or whichever locale the project uses to switch language — check `src/ui/localization` for the mechanism if needed). Expected: the new menu entry shows the French label `Paramètres de visualisation (.json)`. If unable to switch language easily, skip and rely on the JSON-parse check from Task 6 Step 10.

If any step fails, do NOT mark the task complete — open a bug against the appropriate task above, fix, re-run from Step 1.

---

## Done When

- All 6 implementation tasks are committed.
- Manual verification (Task 7) passes steps 1-9 (10 and 11 are optional).
- `npm run lint` reports no new errors.
