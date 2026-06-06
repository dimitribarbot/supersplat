# Collision detection on ZIP export — Design

Date: 2026-06-06

## Summary

Add an optional **collision detection** step to the viewer **ZIP** export. When
enabled, the splat scene is voxelized with `writeVoxel` from
`@playcanvas/splat-transform`, producing a sparse voxel octree
(`index.voxel.json` + `index.voxel.bin`) that is bundled into the ZIP. The
bundled viewer's `collisionUrl` default is repointed to `./index.voxel.json`
so the exported viewer auto-loads the collision data.

The user chooses whether the scene is **Indoor** or **Outdoor**, which selects
the voxel-fill strategy (external-fill vs floor-fill). The feature works for
both streaming and non-streaming ZIP, and for both local and server export.

## Goals

- A "Collision detection" toggle in the export dialog, shown only for viewer
  export with type = ZIP.
- When enabled, an "Environment" select with **Indoor** / **Outdoor**.
- Bundle `index.voxel.json` + `index.voxel.bin` into the ZIP and make the
  exported viewer load them by default.
- Work whether or not streaming is selected, and whether or not server export
  is selected.

## Non-goals (out of scope)

- The publish-to-PlayCanvas flow (`src/ui/publish-settings-dialog.ts`).
- Generating the `.collision.glb` collision mesh (CLI `-K`).
- `--voxel-carve` (the user explicitly excluded carve for indoors for now).
- Exposing voxel resolution / opacity cutoff in the UI (library defaults used).
- A real mitigation for the known large-area voxelization limitation (only a
  clear error is surfaced; see Error handling).

## Background / current architecture

Export pipeline:

1. `src/ui/export-popup.ts` — `ExportPopup` builds a `SceneExportOptions`. For
   viewer export, `viewerExportSettings: { type, streaming?, experienceSettings }`.
2. `src/file-handler.ts` — the `scene.write` handler dispatches. With
   `useServer`, it uploads a gzipped PLY and the options object to the server
   (`runServerExport`); otherwise it runs locally via `serializeViewer`.
3. `src/splat-serialize.ts` — `serializeViewer` extracts a `DataTable` (tagged
   `Transform.PLY`) and calls `writeViewerCore`.
4. `src/splat-export-core.ts` — `writeViewerCore` handles `'html'`,
   `'package'` (non-streaming ZIP) and `'streaming'` (ZIP). ZIP output is
   assembled in a `MemoryFileSystem` and then written to a `ZipFileSystem`.
5. `server/src/run-export.ts` — reconstructs the `DataTable` from the uploaded
   PLY and calls the same `writeViewerCore`.

The whole `viewerExportSettings` object is serialized to JSON and forwarded to
the server as a FormData field (`src/export-server-client.ts`), so new fields
inside it cross the wire automatically.

### Voxel API mapping (verified against the library)

`writeVoxel(options, fs)` emits `<base>.voxel.json` + `<base>.voxel.bin`
(plus an optional `.collision.glb` when `collisionMesh` is set — not used here).
The CLI flags map to library options as follows (confirmed in the CLI source):

- `--voxel-external-fill` (indoor) → `navExteriorRadius: 1.6` (requires
  `navSeed`).
- `--voxel-floor-fill` (outdoor) → `floorFill: true, floorFillDilation: 1.6`.
- `--seed-pos x,y,z` → `navSeed: { x, y, z }` (defaults to `0,0,0`).
- Defaults: `voxelResolution: 0.05`, `opacityCutoff: 0.1`.

### Coordinate space for the seed (verified — no flip)

`extractDataTable` stores positions as `Rz(-180) · world` and tags the table
`Transform.PLY`. `writeVoxel` computes
`delta = computeWriteTransform(table.transform, Transform.IDENTITY)` which equals
`IDENTITY⁻¹ · PLY = PLY`, then applies `delta` to the columns before
voxelizing. Because a 180° rotation about Z is its own inverse, applying the PLY
transform to `Rz(-180) · world` round-trips the geometry back to plain **world
(PlayCanvas) space**. The voxel grid (and the metadata's "PlayCanvas coordinate
space" sceneBounds) is therefore in world space, and `navSeed` is consumed in
that same space.

**Conclusion:** the seed is passed as the camera world position **directly, with
no coordinate flip**. The seed = `experienceSettings.cameras[0].initial.position`
(the current viewport start pose). Fallback to `(0,0,0)` when there is no
captured camera pose.

> Caveat (documented, not solved): for indoor external-fill the library skips
> the fill when the seed is reachable from outside the volume. The user must
> position the viewport inside the enclosed space before exporting.

### Viewer collision hook (verified)

The viewer emitted by `writeHtml` already contains, in `index.html`:

```js
const collisionUrl = url.searchParams.get('collision') ?? url.searchParams.get('voxel');
```

and runtime logic that loads a `.voxel.json` collision file when `collisionUrl`
is set. When collision is enabled we repoint this to default to the bundled
file:

```js
const collisionUrl = url.searchParams.get('collision') ?? url.searchParams.get('voxel') ?? './index.voxel.json';
```

This is a guarded string replacement (throw if the source string is not found,
mirroring the existing content-URL repoints in `writeStreamingViewerCore`). It
is applied **only when collision is enabled**, so a normal export never points
the viewer at a non-existent file.

## Detailed design

### 1. Types (`src/splat-serialize.ts`)

Extend `ViewerExportSettings`:

```ts
type ViewerExportSettings = {
    type: 'html' | 'zip';
    streaming?: boolean;
    experienceSettings: ExperienceSettings;
    collision?: { environment: 'indoor' | 'outdoor' };   // undefined = disabled
    events?: Events;
};
```

`serializeViewer` forwards `options.collision` into `writeViewerCore`.

### 2. Core export (`src/splat-export-core.ts`)

Add a pure helper (unit-testable, no GPU):

```ts
type CollisionEnvironment = 'indoor' | 'outdoor';

// Map the chosen environment + seed to the writeVoxel option subset.
const collisionVoxelOptions = (environment: CollisionEnvironment, seed: { x: number; y: number; z: number }) => {
    return environment === 'indoor'
        ? { navExteriorRadius: 1.6, navSeed: seed }
        : { floorFill: true, floorFillDilation: 1.6 };
};
```

`writeViewerCore` and `writeStreamingViewerCore` gain a
`collision?: { environment: CollisionEnvironment }` parameter. When present and
`viewerType !== 'html'` (i.e. a ZIP path):

1. Derive the seed from `viewerSettingsJson.cameras?.[0]?.initial?.position`
   (an `[x, y, z]` array) → `{ x, y, z }`, defaulting to `{ x: 0, y: 0, z: 0 }`.
2. `await writeVoxel({ filename: 'index.voxel.json', dataTable, voxelResolution: 0.05, opacityCutoff: 0.1, createDevice, ...collisionVoxelOptions(environment, seed) }, memFs)`
   into the **same `MemoryFileSystem`** used for the rest of the ZIP, so
   `index.voxel.json` + `index.voxel.bin` are zipped alongside the viewer.
3. Repoint the `collisionUrl` line in `index.html` (guarded replace).

Ordering: voxelization runs **before** the `ZipFileSystem` output is written,
so a failure aborts before any output ZIP exists.

The `'html'` (single-file) branch ignores `collision` entirely.

### 3. UI (`src/ui/export-popup.ts`)

- Add a **collision row** (`BooleanInput` toggle, label
  `popup.export.collision`) and an **environment row** (`SelectInput` with
  `indoor` / `outdoor`, label `popup.export.environment`), defaulting to
  **Indoor**.
- Visibility: both rows shown only when `currentExportType === 'viewer'` and
  `viewerTypeSelect.value === 'zip'` (mirrors `updateStreamingVisibility`). The
  environment row is additionally hidden when the collision toggle is off.
- Add both rows to the `allRows` list and to the `viewer` entry of
  `activeRows`. Reset the toggle to off and environment to `indoor` in `reset`.
- React to `viewerTypeSelect` change and collision toggle change to update
  visibility.
- In `assembleViewerOptions`, add to `viewerExportSettings`:
  `collision: collisionToggle.value ? { environment: environmentSelect.value } : undefined`.

### 4. Localization (`static/locales/*.json`)

New keys (English text in `en.json`; the other eight locales get the same
English values, relying on i18next fallback — matching how some existing keys
are handled):

- `popup.export.collision` → "Collision Detection"
- `popup.export.environment` → "Environment"
- `popup.export.environment.indoor` → "Indoor"
- `popup.export.environment.outdoor` → "Outdoor"

### 5. Server (`server/src/run-export.ts`)

- Extend the `viewerExportSettings` type to include
  `collision?: { environment: 'indoor' | 'outdoor' }`.
- Pass `options.viewerExportSettings.collision` into `writeViewerCore` for both
  the `htmlViewer` (no-op, html ignores it) and `packageViewer` calls.

No changes to `src/export-server-client.ts` or the server route are required
(the options object is forwarded as JSON in full).

## Error handling

Voxelization is GPU-based and can fail on very large scenes. `writeVoxel` is
awaited before the output ZIP is produced; on failure we throw a clear,
actionable error (e.g. *"Collision generation failed — the scene may be too
large for voxelization. Try exporting without collision detection."*). The
existing export `try/catch` (browser `file-handler.ts`, server `run-export.ts`)
surfaces it. Because the failure occurs before the ZIP writer is opened, no
partial/corrupt output is written. A real large-area solution is deferred.

## Testing

- **Unit (no GPU):** `collisionVoxelOptions('indoor', seed)` returns
  `{ navExteriorRadius: 1.6, navSeed: seed }`; `collisionVoxelOptions('outdoor', seed)`
  returns `{ floorFill: true, floorFillDilation: 1.6 }`.
- **GPU integration** (alongside existing `server/test/*.gpu.test.ts`):
  - Exporting a small scene as ZIP with `collision: { environment: 'indoor' }`
    produces `index.voxel.json` and `index.voxel.bin` entries, and the
    `index.html` `collisionUrl` defaults to `./index.voxel.json`.
  - Exporting the same scene without `collision` produces neither file and
    leaves `collisionUrl` unchanged.
```
