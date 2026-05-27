# Design: Export Viewer Settings (.json)

Date: 2026-05-27

## Goal

Add a new entry in the export menu that exports only the `ExperienceSettings`
JSON file — the same `settings.json` that is currently embedded inside the
HTML viewer export — without any splat data (PLY/SOG) or HTML wrapper.

## Motivation

When iterating on a published viewer experience, the user often needs to
re-export only the viewer settings (background color, camera, animation, etc.)
without re-exporting the splat data, which is unchanged and can be large and
slow to serialize.

## User-facing behavior

1. Open the `File > Export` submenu.
2. A new entry `Viewer Settings (.json)` appears directly below `Viewer App`.
3. Selecting it opens the existing export popup, configured with only the
   fields that affect `ExperienceSettings`:
   - Animation toggle
   - Loop mode
   - Background color
   - FOV
   - Filename (when no save-file picker is available, e.g. Safari)
4. On confirm, a save-file picker prompts for a `.json` filename (default
   `<splatName>.json`).
5. The file written is the JSON-serialized `ExperienceSettings` object,
   byte-compatible with the `settings.json` embedded in the HTML viewer
   export.

## Architecture changes

### `src/file-handler.ts`

- Extend `ExportType` to `'ply' | 'splat' | 'sog' | 'viewer' | 'viewerSettings'`.
- Extend `FileType` to add `'viewerSettings'`.
- Add `filePickerTypes.viewerSettings`:

  ```ts
  'viewerSettings': {
      description: 'Viewer Settings JSON',
      accept: {
          'application/json': ['.json']
      }
  }
  ```

- In `scene.export`, extend the `fileType` derivation so that
  `exportType === 'viewerSettings'` maps to `fileType === 'viewerSettings'`.
- In `scene.write`, add a new `case 'viewerSettings'`:
  - Update the `useSpinner` derivation to also exclude `'viewerSettings'`
    (instant operation — no spinner needed).
  - Delegate to `serializeViewerSettings(experienceSettings, fs, filename)`.

### `src/splat-serialize.ts`

Add a new exported function:

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

Export it alongside the other `serialize*` functions.

### `src/ui/menu.ts`

Add a new entry to `exportMenuPanel`, directly below `Viewer App`, no extra
separator:

```ts
{
    text: localize('menu.file.export.viewerSettings', { ellipsis: true }),
    icon: createSvg(sceneExport),
    isEnabled: () => !events.invoke('scene.empty'),
    onSelect: () => events.invoke('scene.export', 'viewerSettings')
}
```

### `src/ui/export-popup.ts`

- Add `viewerSettings` to the `activeRows` map in `reset()`:

  ```ts
  viewerSettings: [animationRow, loopRow, colorRow, fovRow, filenameRow]
  ```

  (Omits `viewerTypeRow` — no html/zip distinction — and `bandsRow` —
  settings.json contains no splat data.)

- Add a case to the filename extension switch:

  ```ts
  case 'viewerSettings':
      updateExtension('.json');
      break;
  ```

- Add an `assembleViewerSettingsOptions` helper which builds the same
  `experienceSettings` object as `assembleViewerOptions` but returns:

  ```ts
  {
      filename: filenameEntry.value,
      splatIdx: 'all',
      serializeSettings: {},
      viewerExportSettings: {
          type: 'html',  // unused for viewerSettings but required by type
          experienceSettings
      }
  }
  ```

  Alternative implementation: factor the `experienceSettings` construction
  out of `assembleViewerOptions` into a shared local function and have both
  call it. Either approach is acceptable; choose the one with the smaller
  diff during implementation.

- Add a `case 'viewerSettings'` to the `onExport` switch calling the new
  helper.

### Localization (`static/locales/*.json`)

Add `"menu.file.export.viewerSettings"` to every locale file. English value:
`"Viewer Settings (.json)"`. For other locales, use translations matching the
local style of the existing `menu.file.export.viewer` entry.

Suggested values (subject to review):

| Locale | Value |
|--------|-------|
| en | `Viewer Settings (.json)` |
| fr | `Paramètres de visualisation (.json)` |
| de | `Viewer-Einstellungen (.json)` |
| es | `Configuración del visor (.json)` |
| pt-BR | `Configurações de Visualização (.json)` |
| ja | `ビューア設定 (.json)` |
| ko | `뷰어 설정 (.json)` |
| ru | `Настройки просмотра (.json)` |
| zh-CN | `查看器设置 (.json)` |

## Data flow

```
Menu click
  → events.invoke('scene.export', 'viewerSettings')      [file-handler.ts]
  → events.invoke('show.exportPopup', 'viewerSettings', …)  [export-popup.ts]
    ← user fills animation/loop/color/fov/filename
    ← returns SceneExportOptions with viewerExportSettings.experienceSettings
  → window.showSaveFilePicker (suggests <splatName>.json)
  → events.invoke('scene.write', 'viewerSettings', options, stream)
  → serializeViewerSettings(experienceSettings, fs, filename)
  → writes <splatName>.json
```

## Out of scope (YAGNI)

- No new dedicated popup; reuse the existing export popup and just hide rows.
- No reformatting or schema changes to `ExperienceSettings`; we export it
  exactly as it is embedded in HTML for drop-in compatibility.
- No import counterpart for `settings.json`. (Project files already cover
  loading/saving experience state via `.ssproj`.)
- No batch export combining `settings.json` with other formats — each export
  menu entry remains single-purpose.
