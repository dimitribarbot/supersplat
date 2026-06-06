# Collision Detection on ZIP Export — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional "Collision detection" choice to viewer ZIP export that voxelizes the scene (indoor=external-fill, outdoor=floor-fill), bundles `index.voxel.json`/`index.voxel.bin` into the ZIP, and makes the exported viewer auto-load them.

**Architecture:** A small dependency-free helper module maps the UI choice + start-camera seed to `writeVoxel` options. The shared export core (`splat-export-core.ts`, used by both the browser and the server's `dist-shared`) voxelizes into the same in-memory ZIP filesystem and repoints the viewer's `collisionUrl`. The export dialog gains a toggle + environment select; the option rides through the existing `viewerExportSettings` object (which already crosses the wire to the server).

**Tech Stack:** TypeScript, `@playcanvas/splat-transform` (`writeVoxel`), PCUI (`BooleanInput`/`SelectInput`), i18next locales, Vitest (root + server, incl. GPU tests).

**Spec:** `docs/superpowers/specs/2026-06-06-collision-detection-zip-export-design.md`

**Branch:** `feature/collision-detection-zip-export` (already created; the design spec is committed there).

**Conventions for this repo (important):**
- Run all commands from the repo root **without** a `cd` prefix and without `git -C`/`npm --prefix` pointing at the repo root (these trigger permission prompts). The working directory is already the repo root.
- Server tests live in `server/` and use a separate Vitest config; run them with `npm --prefix server test` (the `server/` subdir is not the cwd, so this is fine).
- `eslint@10`'s `import/order` autofix is known to crash on this repo — if `npm run lint` reports `import/order` issues, leave them as-is.

---

## File Structure

- **Create** `src/collision-voxel-options.ts` — pure, dependency-free helpers: `collisionSeedFromSettings` (derive seed from viewer settings) and `collisionVoxelOptions` (map environment+seed → `writeVoxel` option subset). Importable by both the browser build and the server `dist-shared` build.
- **Create** `test/collision-voxel-options.test.ts` — unit tests for the helper (no GPU, node).
- **Modify** `src/splat-serialize.ts` — extend `ViewerExportSettings` with `collision?`; forward it in `serializeViewer`.
- **Modify** `src/splat-export-core.ts` — import `writeVoxel` + helpers; add `writeCollisionVoxel` and `repointCollisionUrl`; thread a `collision?` param through `writeViewerCore` and `writeStreamingViewerCore`.
- **Modify** `src/ui/export-popup.ts` — add collision toggle + environment select rows, visibility wiring, and assemble the option.
- **Modify** `static/locales/*.json` (all 9) — add the four new UI string keys.
- **Modify** `server/src/run-export.ts` — add `collision?` to the options type; forward it into `writeViewerCore`.
- **Create** `server/test/collision.gpu.test.ts` — GPU integration test of the end-to-end ZIP output.

---

## Task 1: Pure collision-options helper (TDD)

**Files:**
- Create: `src/collision-voxel-options.ts`
- Test: `test/collision-voxel-options.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/collision-voxel-options.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { collisionSeedFromSettings, collisionVoxelOptions } from '../src/collision-voxel-options';

describe('collisionVoxelOptions', () => {
    it('indoor maps to external fill with the seed', () => {
        const seed = { x: 1, y: 2, z: 3 };
        expect(collisionVoxelOptions('indoor', seed)).toEqual({ navExteriorRadius: 1.6, navSeed: seed });
    });

    it('outdoor maps to floor fill and ignores the seed', () => {
        expect(collisionVoxelOptions('outdoor', { x: 1, y: 2, z: 3 })).toEqual({ floorFill: true, floorFillDilation: 1.6 });
    });
});

describe('collisionSeedFromSettings', () => {
    it('reads the start camera position', () => {
        const settings = { cameras: [{ initial: { position: [4, 5, 6] } }] };
        expect(collisionSeedFromSettings(settings)).toEqual({ x: 4, y: 5, z: 6 });
    });

    it('defaults to the origin when there is no camera', () => {
        expect(collisionSeedFromSettings({ cameras: [] })).toEqual({ x: 0, y: 0, z: 0 });
        expect(collisionSeedFromSettings({})).toEqual({ x: 0, y: 0, z: 0 });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/collision-voxel-options.test.ts`
Expected: FAIL — cannot resolve `../src/collision-voxel-options`.

- [ ] **Step 3: Write the implementation**

Create `src/collision-voxel-options.ts`:

```ts
// Pure, dependency-free helpers that map the export dialog's collision choice to
// the @playcanvas/splat-transform writeVoxel option subset, and derive the
// voxel-fill seed from the exported viewer settings.
//
// Deliberately free of playcanvas / splat-transform imports so it can be
// unit-tested in isolation and bundled cleanly into both the browser build and
// the server's dist-shared export core.

type CollisionEnvironment = 'indoor' | 'outdoor';

type Vec3Like = { x: number; y: number; z: number };

// The seed (CLI --seed-pos / writeVoxel navSeed) is the exported experience's
// start camera position. writeVoxel consumes navSeed in PlayCanvas world space
// (it re-applies the table's PLY transform before voxelizing, round-tripping the
// geometry back to world space), so the camera world position is used directly
// with no coordinate flip. Falls back to the origin when there is no camera.
const collisionSeedFromSettings = (viewerSettingsJson: any): Vec3Like => {
    const p = viewerSettingsJson?.cameras?.[0]?.initial?.position;
    if (Array.isArray(p) && p.length >= 3) {
        return { x: p[0], y: p[1], z: p[2] };
    }
    return { x: 0, y: 0, z: 0 };
};

// Map the chosen environment + seed to the writeVoxel option subset.
//   indoor  -> external boundary flood fill (CLI --voxel-external-fill 1.6),
//              which uses the seed to verify the volume is enclosed.
//   outdoor -> per-column floor fill (CLI --voxel-floor-fill 1.6); no seed used.
// Carve (--voxel-carve) is deliberately not used.
const collisionVoxelOptions = (environment: CollisionEnvironment, seed: Vec3Like) => {
    return environment === 'indoor'
        ? { navExteriorRadius: 1.6, navSeed: seed }
        : { floorFill: true, floorFillDilation: 1.6 };
};

export { collisionSeedFromSettings, collisionVoxelOptions, type CollisionEnvironment, type Vec3Like };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/collision-voxel-options.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/collision-voxel-options.ts test/collision-voxel-options.test.ts
git commit -m "feat: collision voxel-option + seed helpers"
```

---

## Task 2: Thread `collision` through the serialize types

**Files:**
- Modify: `src/splat-serialize.ts` (the `ViewerExportSettings` type ~line 130, and `serializeViewer` ~line 1220)

- [ ] **Step 1: Extend `ViewerExportSettings`**

In `src/splat-serialize.ts`, change the `ViewerExportSettings` type from:

```ts
type ViewerExportSettings = {
    type: 'html' | 'zip';
    streaming?: boolean;
    experienceSettings: ExperienceSettings;
    events?: Events;
};
```

to:

```ts
type ViewerExportSettings = {
    type: 'html' | 'zip';
    streaming?: boolean;
    experienceSettings: ExperienceSettings;
    collision?: { environment: 'indoor' | 'outdoor' };   // undefined = disabled
    events?: Events;
};
```

- [ ] **Step 2: Forward `collision` in `serializeViewer`**

In `src/splat-serialize.ts`, change `serializeViewer` from:

```ts
const serializeViewer = async (splats: Splat[], serializeSettings: SerializeSettings, options: ViewerExportSettings, fs: FileSystem): Promise<void> => {
    const { experienceSettings, events } = options;
    const dataTable = extractDataTable(splats, serializeSettings);
    const viewerType = options.type === 'html' ? 'html' : (options.streaming ? 'streaming' : 'package');
    await writeViewerCore(dataTable, experienceSettings, viewerType, createGpuDevice, fs, events);
};
```

to:

```ts
const serializeViewer = async (splats: Splat[], serializeSettings: SerializeSettings, options: ViewerExportSettings, fs: FileSystem): Promise<void> => {
    const { experienceSettings, events, collision } = options;
    const dataTable = extractDataTable(splats, serializeSettings);
    const viewerType = options.type === 'html' ? 'html' : (options.streaming ? 'streaming' : 'package');
    await writeViewerCore(dataTable, experienceSettings, viewerType, createGpuDevice, fs, events, undefined, undefined, collision);
};
```

(The two `undefined` args are the existing optional `onLog` and `shouldCancel` params; `collision` is the new final param added in Task 3.)

- [ ] **Step 3: Commit**

```bash
git add src/splat-serialize.ts
git commit -m "feat: add collision field to ViewerExportSettings"
```

> Note: this references the `writeViewerCore` signature added in Task 3. If executing strictly in order, the type-check in Task 8 is where signature mismatches surface; the call site is written here to match Task 3's final signature.

---

## Task 3: Voxelize + repoint in the export core

**Files:**
- Modify: `src/splat-export-core.ts` (imports ~line 1; `writeStreamingViewerCore` ~line 206; `writeViewerCore` ~line 318)

- [ ] **Step 1: Add imports**

In `src/splat-export-core.ts`, add `writeVoxel` to the `@playcanvas/splat-transform` import list (alphabetically near `writeSog`):

```ts
    writeHtml,
    writeLod,
    writeSog,
    writeVoxel,
    ZipFileSystem,
```

Then add, after the existing `import { buildAnnotationLinksInjection } from './viewer-companion/annotation-links';` line:

```ts
import { collisionSeedFromSettings, collisionVoxelOptions, type CollisionEnvironment } from './collision-voxel-options';
```

- [ ] **Step 2: Add the two collision helpers**

In `src/splat-export-core.ts`, immediately above `const writeStreamingViewerCore = async (` insert:

```ts
// Voxelize the (full-resolution) scene into memFs as index.voxel.json +
// index.voxel.bin for the viewer's collision system. Must run before any step
// that consumes/mutates the DataTable (e.g. streaming LOD building). writeVoxel
// does not mutate the table (its column transform is out-of-place). On failure
// (e.g. GPU OOM on a very large scene) it throws a clear, actionable error so
// the caller aborts before writing any output ZIP.
const writeCollisionVoxel = async (
    memFs: MemoryFileSystem,
    dataTable: DataTable,
    viewerSettingsJson: any,
    createDevice: DeviceCreator,
    environment: CollisionEnvironment
): Promise<void> => {
    const seed = collisionSeedFromSettings(viewerSettingsJson);
    try {
        await writeVoxel({
            filename: 'index.voxel.json',
            dataTable,
            voxelResolution: 0.05,
            opacityCutoff: 0.1,
            createDevice,
            ...collisionVoxelOptions(environment, seed)
        }, memFs);
    } catch (err) {
        throw new Error(`Collision generation failed - the scene may be too large for voxelization. Try exporting without collision detection. (${(err as Error)?.message ?? err})`);
    }
};

// Repoint the viewer's default collisionUrl at the bundled voxel file so the
// exported viewer auto-loads collision without a ?voxel= query param. Guarded
// like the other index.html repoints: throw if the source string is missing
// (writeHtml output format changed).
const repointCollisionUrl = (memFs: MemoryFileSystem): void => {
    const rawHtml = memFs.results.get('index.html');
    if (!rawHtml) {
        throw new Error('Collision export failed: writeHtml did not produce index.html');
    }
    const html = new TextDecoder().decode(rawHtml);
    const search = "url.searchParams.get('collision') ?? url.searchParams.get('voxel')";
    const repointed = html.replace(search, `${search} ?? './index.voxel.json'`);
    if (repointed === html) {
        throw new Error('Collision export failed: could not repoint viewer collisionUrl (writeHtml output format changed)');
    }
    memFs.results.set('index.html', new TextEncoder().encode(repointed));
};
```

- [ ] **Step 3: Add the `collision` param to `writeStreamingViewerCore`**

In `src/splat-export-core.ts`, change the `writeStreamingViewerCore` signature from:

```ts
const writeStreamingViewerCore = async (
    dataTable: DataTable,
    viewerSettingsJson: any,
    createDevice: DeviceCreator,
    fs: FileSystem,
    events?: Events,
    onLog?: (level: string, text: string) => void,
    shouldCancel?: () => boolean
): Promise<void> => {
```

to:

```ts
const writeStreamingViewerCore = async (
    dataTable: DataTable,
    viewerSettingsJson: any,
    createDevice: DeviceCreator,
    fs: FileSystem,
    events?: Events,
    onLog?: (level: string, text: string) => void,
    shouldCancel?: () => boolean,
    collision?: { environment: CollisionEnvironment }
): Promise<void> => {
```

- [ ] **Step 4: Voxelize before the LOD build (streaming)**

In `writeStreamingViewerCore`, find the placeholder `writeHtml` call that ends with:

```ts
        bundle: false,
        iterations: 10,
        createDevice
    }, memFs);
```

Immediately after that closing `}, memFs);` (and before the `// Streaming bundle:` comment / `buildStreamingLodTable` call), insert:

```ts
    // Voxelize the full-resolution table now, before buildStreamingLodTable
    // consumes/mutates it.
    if (collision) {
        phase = 'Generating collision data';
        await writeCollisionVoxel(memFs, dataTable, viewerSettingsJson, createDevice, collision.environment);
    }
```

- [ ] **Step 5: Repoint collisionUrl after the viewer HTML is finalized (streaming)**

In `writeStreamingViewerCore`, find:

```ts
    const withLinks = injectAnnotationLinks(repointed, viewerSettingsJson);
    memFs.results.set('index.html', new TextEncoder().encode(withLinks));
```

Immediately after those two lines insert:

```ts
    if (collision) {
        repointCollisionUrl(memFs);
    }
```

- [ ] **Step 6: Add the `collision` param to `writeViewerCore` and pass it to streaming**

In `src/splat-export-core.ts`, change the `writeViewerCore` signature from:

```ts
const writeViewerCore = async (
    dataTable: DataTable,
    viewerSettingsJson: any,
    viewerType: 'html' | 'package' | 'streaming',
    createDevice: DeviceCreator,
    fs: FileSystem,
    events?: Events,
    onLog?: (level: string, text: string) => void,
    shouldCancel?: () => boolean
): Promise<void> => {
```

to:

```ts
const writeViewerCore = async (
    dataTable: DataTable,
    viewerSettingsJson: any,
    viewerType: 'html' | 'package' | 'streaming',
    createDevice: DeviceCreator,
    fs: FileSystem,
    events?: Events,
    onLog?: (level: string, text: string) => void,
    shouldCancel?: () => boolean,
    collision?: { environment: CollisionEnvironment }
): Promise<void> => {
```

Then, in the same function, change the streaming delegation from:

```ts
        } else if (viewerType === 'streaming') {
            await writeStreamingViewerCore(dataTable, viewerSettingsJson, createDevice, fs, events, onLog, shouldCancel);
```

to:

```ts
        } else if (viewerType === 'streaming') {
            await writeStreamingViewerCore(dataTable, viewerSettingsJson, createDevice, fs, events, onLog, shouldCancel, collision);
```

- [ ] **Step 7: Voxelize + repoint in the package (non-streaming) branch**

In `writeViewerCore`, the `else` (package) branch currently reads:

```ts
        } else {
            const memFs = new MemoryFileSystem();
            await writeHtml({ filename: 'index.html', dataTable, viewerSettingsJson, bundle: false, iterations: 10, createDevice }, memFs);
            const rawIndex = memFs.results.get('index.html');
            if (!rawIndex) {
                throw new Error('Package export failed: writeHtml did not produce index.html');
            }
            const injected = injectAnnotationLinks(new TextDecoder().decode(rawIndex), viewerSettingsJson);
            memFs.results.set('index.html', new TextEncoder().encode(injected));
            const zipWriter = await fs.createWriter('output.zip');
```

Change it to (insert the voxelize call after `writeHtml`, and the repoint after the injected `index.html` is set):

```ts
        } else {
            const memFs = new MemoryFileSystem();
            await writeHtml({ filename: 'index.html', dataTable, viewerSettingsJson, bundle: false, iterations: 10, createDevice }, memFs);
            if (collision) {
                await writeCollisionVoxel(memFs, dataTable, viewerSettingsJson, createDevice, collision.environment);
            }
            const rawIndex = memFs.results.get('index.html');
            if (!rawIndex) {
                throw new Error('Package export failed: writeHtml did not produce index.html');
            }
            const injected = injectAnnotationLinks(new TextDecoder().decode(rawIndex), viewerSettingsJson);
            memFs.results.set('index.html', new TextEncoder().encode(injected));
            if (collision) {
                repointCollisionUrl(memFs);
            }
            const zipWriter = await fs.createWriter('output.zip');
```

(The `'html'` single-file branch is intentionally left unchanged — collision is ZIP-only.)

- [ ] **Step 8: Commit**

```bash
git add src/splat-export-core.ts
git commit -m "feat: voxelize scene and repoint viewer collisionUrl on ZIP export"
```

---

## Task 4: Forward `collision` on the server

**Files:**
- Modify: `server/src/run-export.ts` (the `ExportOptions` type ~line 13; the `htmlViewer`/`packageViewer` calls ~line 165 and ~line 173)

- [ ] **Step 1: Extend the options type**

In `server/src/run-export.ts`, change:

```ts
    viewerExportSettings?: { type: 'html' | 'zip'; streaming?: boolean; experienceSettings: any };
```

to:

```ts
    viewerExportSettings?: { type: 'html' | 'zip'; streaming?: boolean; experienceSettings: any; collision?: { environment: 'indoor' | 'outdoor' } };
```

- [ ] **Step 2: Pass `collision` into both viewer calls**

In `server/src/run-export.ts`, change the `htmlViewer` call from:

```ts
        await writeViewerCore(dataTable, options.viewerExportSettings!.experienceSettings, 'html', createDevice, memFs, events, onLog, isCancelled);
```

to:

```ts
        await writeViewerCore(dataTable, options.viewerExportSettings!.experienceSettings, 'html', createDevice, memFs, events, onLog, isCancelled, options.viewerExportSettings!.collision);
```

And change the `packageViewer` call from:

```ts
    await writeViewerCore(dataTable, options.viewerExportSettings!.experienceSettings, viewerType, createDevice, memFs, events, onLog, isCancelled);
```

to:

```ts
    await writeViewerCore(dataTable, options.viewerExportSettings!.experienceSettings, viewerType, createDevice, memFs, events, onLog, isCancelled, options.viewerExportSettings!.collision);
```

- [ ] **Step 3: Commit**

```bash
git add server/src/run-export.ts
git commit -m "feat: forward collision option through server export"
```

---

## Task 5: Export dialog UI

**Files:**
- Modify: `src/ui/export-popup.ts`

- [ ] **Step 1: Add the collision + environment rows**

In `src/ui/export-popup.ts`, find the end of the streaming row block:

```ts
        streamingRow.append(streamingLabel);
        streamingRow.append(streamingToggle);
```

Immediately after it, insert:

```ts
        // viewer: collision detection (zip only)

        const collisionRow = new Container({
            class: 'row'
        });

        const collisionLabel = new Label({
            class: 'label',
            text: localize('popup.export.collision')
        });

        const collisionToggle = new BooleanInput({
            class: 'boolean',
            type: 'toggle',
            value: false
        });

        collisionRow.append(collisionLabel);
        collisionRow.append(collisionToggle);

        // viewer: collision environment (shown only when collision is enabled)

        const environmentRow = new Container({
            class: 'row'
        });

        const environmentLabel = new Label({
            class: 'label',
            text: localize('popup.export.environment')
        });

        const environmentSelect = new SelectInput({
            class: 'select',
            defaultValue: 'indoor',
            options: [
                { v: 'indoor', t: localize('popup.export.environment.indoor') },
                { v: 'outdoor', t: localize('popup.export.environment.outdoor') }
            ]
        });

        environmentRow.append(environmentLabel);
        environmentRow.append(environmentSelect);
```

- [ ] **Step 2: Append the rows to the content (after streaming, before server)**

In `src/ui/export-popup.ts`, find:

```ts
        content.append(streamingRow);
        content.append(serverRow);
```

Change it to:

```ts
        content.append(streamingRow);
        content.append(collisionRow);
        content.append(environmentRow);
        content.append(serverRow);
```

- [ ] **Step 3: Add the visibility helper and wire change events**

In `src/ui/export-popup.ts`, find:

```ts
        const updateStreamingVisibility = () => {
            streamingRow.hidden = currentExportType !== 'viewer' || viewerTypeSelect.value !== 'zip';
        };
```

Immediately after it, insert:

```ts
        const updateCollisionVisibility = () => {
            const isZipViewer = currentExportType === 'viewer' && viewerTypeSelect.value === 'zip';
            collisionRow.hidden = !isZipViewer;
            environmentRow.hidden = !isZipViewer || !collisionToggle.value;
        };
```

Then find:

```ts
        viewerTypeSelect.on('change', () => {
            updateExtension(viewerTypeSelect.value === 'html' ? '.html' : '.zip');
            updateStreamingVisibility();
        });
```

Change it to:

```ts
        viewerTypeSelect.on('change', () => {
            updateExtension(viewerTypeSelect.value === 'html' ? '.html' : '.zip');
            updateStreamingVisibility();
            updateCollisionVisibility();
        });

        collisionToggle.on('change', () => {
            updateCollisionVisibility();
        });
```

- [ ] **Step 4: Include the rows in `reset()` row lists and defaults**

In `src/ui/export-popup.ts`, in `reset(...)`, change:

```ts
            const allRows = [
                viewerTypeRow, animationRow, loopRow, colorRow, fovRow, compressRow, bandsRow, iterationsRow, streamingRow, serverRow, filenameRow
            ];

            const activeRows = {
                ply: [compressRow, bandsRow, serverRow, filenameRow],
                splat: [filenameRow],
                sog: [bandsRow, iterationsRow, serverRow, filenameRow],
                viewer: [viewerTypeRow, animationRow, loopRow, colorRow, fovRow, bandsRow, streamingRow, serverRow, filenameRow],
                viewerSettings: [animationRow, loopRow, colorRow, fovRow, filenameRow]
            }[exportType];
```

to:

```ts
            const allRows = [
                viewerTypeRow, animationRow, loopRow, colorRow, fovRow, compressRow, bandsRow, iterationsRow, streamingRow, collisionRow, environmentRow, serverRow, filenameRow
            ];

            const activeRows = {
                ply: [compressRow, bandsRow, serverRow, filenameRow],
                splat: [filenameRow],
                sog: [bandsRow, iterationsRow, serverRow, filenameRow],
                viewer: [viewerTypeRow, animationRow, loopRow, colorRow, fovRow, bandsRow, streamingRow, collisionRow, environmentRow, serverRow, filenameRow],
                viewerSettings: [animationRow, loopRow, colorRow, fovRow, filenameRow]
            }[exportType];
```

Then find:

```ts
            // streaming (viewer zip only)
            streamingToggle.value = true;
            updateStreamingVisibility();
```

Change it to:

```ts
            // streaming (viewer zip only)
            streamingToggle.value = true;
            updateStreamingVisibility();

            // collision detection (viewer zip only)
            collisionToggle.value = false;
            environmentSelect.value = 'indoor';
            updateCollisionVisibility();
```

- [ ] **Step 5: Assemble the option**

In `src/ui/export-popup.ts`, in `assembleViewerOptions`, change:

```ts
                    viewerExportSettings: {
                        type: viewerTypeSelect.value,
                        streaming: streamingToggle.value,
                        experienceSettings
                    },
```

to:

```ts
                    viewerExportSettings: {
                        type: viewerTypeSelect.value,
                        streaming: streamingToggle.value,
                        collision: collisionToggle.value ? { environment: environmentSelect.value as 'indoor' | 'outdoor' } : undefined,
                        experienceSettings
                    },
```

- [ ] **Step 6: Commit**

```bash
git add src/ui/export-popup.ts
git commit -m "feat: add collision detection controls to export dialog"
```

---

## Task 6: Localization keys

**Files:**
- Modify: `static/locales/en.json`, `static/locales/de.json`, `static/locales/es.json`, `static/locales/fr.json`, `static/locales/ja.json`, `static/locales/ko.json`, `static/locales/pt-BR.json`, `static/locales/ru.json`, `static/locales/zh-CN.json`

- [ ] **Step 1: Add the four keys to every locale file**

In each of the nine files above, find the line:

```json
    "popup.export.streaming": "<existing localized value>",
```

Immediately after it, insert these four lines verbatim (English values everywhere; translators can replace later — this matches the repo convention that every key exists in every locale file):

```json
    "popup.export.collision": "Collision Detection",
    "popup.export.environment": "Environment",
    "popup.export.environment.indoor": "Indoor",
    "popup.export.environment.outdoor": "Outdoor",
```

(The `"popup.export.streaming"` entry is always followed by more keys, so the inserted block's trailing comma is valid in every file. Verify each file remains valid JSON.)

- [ ] **Step 2: Validate JSON**

Run: `node -e "for (const f of ['de','en','es','fr','ja','ko','pt-BR','ru','zh-CN']) { JSON.parse(require('fs').readFileSync('static/locales/'+f+'.json','utf8')); console.log(f,'ok'); }"`
Expected: nine `ok` lines, no parse error.

- [ ] **Step 3: Commit**

```bash
git add static/locales/
git commit -m "feat: add collision detection localization keys"
```

---

## Task 7: GPU integration test (server, end-to-end ZIP)

**Files:**
- Create: `server/test/collision.gpu.test.ts`

> This test exercises the server `runExport` path, which dynamically imports the compiled `dist-shared` core. It therefore requires `dist-shared` to be rebuilt from the Task 3 changes first. It self-skips when no GPU is available.

- [ ] **Step 1: Rebuild the shared core**

Run: `node scripts/build-shared.mjs`
Expected: ends with `build-shared: dist-shared ready (ESM)` and no TypeScript errors.

- [ ] **Step 2: Write the test**

Create `server/test/collision.gpu.test.ts`:

```ts
import { Column, DataTable, Transform, writeFile, MemoryFileSystem } from '@playcanvas/splat-transform';
import { gzipSync, inflateRawSync } from 'node:zlib';
import { describe, it, expect, beforeAll } from 'vitest';
import { probeGpu, createGpuSession } from '../src/gpu.js';
import { runExport, type RunResult } from '../src/run-export.js';

const NAMES = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

const makePlyGz = async (n = 2048): Promise<Buffer> => {
    const cols = NAMES.map((name, i) => new Column(name, Float32Array.from({ length: n }, (_, r) => Math.fround(Math.sin((i + 1) + r * 0.001)))));
    const memFs = new MemoryFileSystem();
    await writeFile({ filename: 'p.ply', outputFormat: 'ply', dataTable: new DataTable(cols, Transform.PLY), options: {} }, memFs);
    return Buffer.from(gzipSync(Buffer.from(memFs.results.get('p.ply')!)));
};

const zipEntryNames = (buf: Buffer): string[] => {
    let eocd = buf.length - 22;
    while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
    if (eocd < 0) throw new Error('zip: end-of-central-directory not found');
    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('zip: bad central directory header');
        const fnLen = buf.readUInt16LE(off + 28);
        const exLen = buf.readUInt16LE(off + 30);
        const cmLen = buf.readUInt16LE(off + 32);
        names.push(buf.toString('utf8', off + 46, off + 46 + fnLen));
        off += 46 + fnLen + exLen + cmLen;
    }
    return names;
};

const zipReadEntry = (buf: Buffer, want: string): Buffer => {
    let eocd = buf.length - 22;
    while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
    if (eocd < 0) throw new Error('zip: end-of-central-directory not found');
    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    for (let i = 0; i < count; i++) {
        const method = buf.readUInt16LE(off + 10);
        const compSize = buf.readUInt32LE(off + 20);
        const fnLen = buf.readUInt16LE(off + 28);
        const exLen = buf.readUInt16LE(off + 30);
        const cmLen = buf.readUInt16LE(off + 32);
        const lho = buf.readUInt32LE(off + 42);
        const name = buf.toString('utf8', off + 46, off + 46 + fnLen);
        if (name === want) {
            const lfnLen = buf.readUInt16LE(lho + 26);
            const lexLen = buf.readUInt16LE(lho + 28);
            const dataStart = lho + 30 + lfnLen + lexLen;
            const comp = buf.subarray(dataStart, dataStart + compSize);
            return method === 0 ? Buffer.from(comp) : inflateRawSync(comp);
        }
        off += 46 + fnLen + exLen + cmLen;
    }
    throw new Error(`zip: entry not found: ${want}`);
};

const experienceSettings = {
    version: 2,
    tonemapping: 'none',
    highPrecisionRendering: false,
    background: { color: [0, 0, 0] },
    postEffectSettings: {},
    animTracks: [],
    cameras: [{ initial: { position: [0, 0, 0], target: [0, 0, -1], fov: 60 } }],
    annotations: [],
    startMode: 'default'
};

describe('runExport packageViewer with collision (GPU)', () => {
    let gpu = false;
    let withCollision: RunResult | undefined;
    let without: RunResult | undefined;

    beforeAll(async () => {
        gpu = (await probeGpu()).gpu;
        if (!gpu) return;
        const plyGz = await makePlyGz(2048);
        const session = createGpuSession();
        try {
            withCollision = await runExport({
                plyGz,
                options: {
                    fileType: 'packageViewer',
                    filename: 'out.zip',
                    viewerExportSettings: { type: 'zip', streaming: false, experienceSettings, collision: { environment: 'indoor' } }
                },
                sink: { emit: () => {} },
                getDeviceCreator: session.getDeviceCreator
            });
            without = await runExport({
                plyGz,
                options: {
                    fileType: 'packageViewer',
                    filename: 'out.zip',
                    viewerExportSettings: { type: 'zip', streaming: false, experienceSettings }
                },
                sink: { emit: () => {} },
                getDeviceCreator: session.getDeviceCreator
            });
        } finally {
            await session.dispose();
        }
    }, 300000);

    it('includes index.voxel.json and index.voxel.bin when collision is enabled', () => {
        if (!gpu) { console.warn('No GPU available; skipping collision GPU test'); return; }
        const names = zipEntryNames(Buffer.from(withCollision!.files[0].data));
        expect(names).toContain('index.voxel.json');
        expect(names).toContain('index.voxel.bin');
    });

    it('repoints the viewer collisionUrl to the bundled voxel file', () => {
        if (!gpu) return;
        const html = zipReadEntry(Buffer.from(withCollision!.files[0].data), 'index.html').toString('utf8');
        expect(html).toContain("?? './index.voxel.json'");
    });

    it('omits voxel files and leaves collisionUrl unchanged when collision is disabled', () => {
        if (!gpu) return;
        const names = zipEntryNames(Buffer.from(without!.files[0].data));
        expect(names).not.toContain('index.voxel.json');
        expect(names).not.toContain('index.voxel.bin');
        const html = zipReadEntry(Buffer.from(without!.files[0].data), 'index.html').toString('utf8');
        expect(html).not.toContain("?? './index.voxel.json'");
    });
});
```

- [ ] **Step 3: Run the test**

Run: `npm --prefix server test -- collision.gpu`
Expected: PASS on a GPU machine. If no GPU is present, the suite logs "No GPU available; skipping collision GPU test" and the assertions are skipped (the suite still reports success).

> If "repoints the viewer collisionUrl" fails because the source string was not found, the `repointCollisionUrl` guard threw — inspect `index.html` from the produced ZIP to find the exact emitted `collisionUrl` declaration and update the `search` constant in `src/splat-export-core.ts` (Task 3, Step 2) accordingly, then rebuild `dist-shared` and re-run.

- [ ] **Step 4: Commit**

```bash
git add server/test/collision.gpu.test.ts
git commit -m "test: GPU integration test for collision on ZIP export"
```

---

## Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Rebuild the shared core (type-checks the export-core path)**

Run: `node scripts/build-shared.mjs`
Expected: `build-shared: dist-shared ready (ESM)` with no TypeScript errors.

- [ ] **Step 2: Build the browser bundle (type-checks UI + serialize)**

Run: `npm run build`
Expected: build completes with no TypeScript errors.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no new errors from the changed files. (If `import/order` autofix issues appear, leave them — this repo's pinned `eslint@10` is known to crash on that rule's autofix.)

- [ ] **Step 4: Root unit tests**

Run: `npm test`
Expected: PASS, including `test/collision-voxel-options.test.ts` (4 tests) and the existing parity test.

- [ ] **Step 5: Server tests**

Run: `npm --prefix server test`
Expected: PASS. GPU suites (including `collision.gpu`) run if a GPU is available, otherwise self-skip.

- [ ] **Step 6: Manual smoke (optional, requires the app + a loaded scene)**

Run the app, load a scene, position the viewport, open Export → set type to **ZIP Package**, enable **Collision Detection**, choose **Indoor**/**Outdoor**, export. Confirm the ZIP contains `index.voxel.json` + `index.voxel.bin`, and that `index.html` contains `?? './index.voxel.json'`. Repeat with **Streaming** on, and with **Export on server** on, to confirm all combinations.

---

## Self-Review notes

- **Spec coverage:** UI toggle+select (Task 5) ✔; ZIP-only (Tasks 3/5, html branch untouched) ✔; indoor→external-fill / outdoor→floor-fill, no carve (Task 1) ✔; seed from start camera, no flip (Task 1 + design) ✔; files bundled + collisionUrl repoint (Task 3) ✔; streaming & non-streaming (Task 3 both paths) ✔; local & server (Tasks 2 & 4) ✔; defaults 0.05/0.1, collisionMesh off (Task 3) ✔; large-scene clear error, no partial output (Task 3 `writeCollisionVoxel` throws before ZIP writer opens) ✔; localization (Task 6) ✔; tests unit+GPU (Tasks 1 & 7) ✔.
- **Type consistency:** `writeViewerCore(..., shouldCancel?, collision?)` final-param order is used identically by `serializeViewer` (Task 2), the streaming delegation (Task 3 Step 6), and both server calls (Task 4). `collision` shape `{ environment: 'indoor' | 'outdoor' }` is identical across `ViewerExportSettings`, the core params, and the server type. Helper names `collisionSeedFromSettings` / `collisionVoxelOptions` match between Task 1 and Task 3.
- **Out of scope (unchanged):** publish flow, `.collision.glb`, carve, voxel-param UI, real large-area mitigation.
