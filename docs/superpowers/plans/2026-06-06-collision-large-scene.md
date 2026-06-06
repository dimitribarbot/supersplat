# Collision on Large Scenes (Subset + Auto-Fit) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make collision ZIP export succeed on large scenes by voxelizing only a sphere around the start position and auto-coarsening the voxel size until it fits, with both radius and voxel size exposed (and localized) in the export dialog.

**Architecture:** A pure helper module gains region-subset + resolution-ladder functions. `writeCollisionVoxel` filters the DataTable to a radius around the (PLY-space) seed, then tries `writeVoxel` at increasing voxel sizes until the V8 `Set` (2²⁴ solid blocks) limit in `filterAndFillBlocks` is cleared. The dialog gains radius + voxel-size sliders threaded through `ViewerExportSettings`.

**Tech Stack:** TypeScript, `@playcanvas/splat-transform` (`writeVoxel`), PCUI (`SliderInput`), i18next, Vitest (root + server GPU).

**Spec:** `docs/superpowers/specs/2026-06-06-collision-large-scene-design.md` (read it first).

**Branch:** `feature/collision-detection-zip-export` (continues the collision feature; base `main` @ `1e8755b`).

**Root-cause recap:** `writeVoxel` → `filterAndFillBlocks` builds a JS `Set` of fully-solid 4×4×4 voxel blocks; V8 caps `Set` at 2²⁴ ≈ 16.7M, so a large scene at 0.05 m throws `RangeError: Set maximum size exceeded`. The GPU pass succeeds and is cleaned up *before* the throw, so retrying at a coarser voxel size is safe (no device corruption, no partial files).

**Repo conventions (IMPORTANT — the user is sensitive to permission prompts):**
- Run commands from the repo root WITHOUT a `cd`/`git -C`/`npm --prefix` that targets the *current* directory. Use absolute paths instead of `cd`-ing for reads/builds.
- Server tests: use the allowlisted bare form `cd server && npx vitest run <args>` (this drifts cwd to `server/`; do root commands before it). Do not wrap in `( … )` or append a pipe.
- After editing the shared core, rebuild it with `node scripts/build-shared.mjs` (or `node C:/Dev/playcanvas/supersplat/scripts/build-shared.mjs` from any cwd). The server loads `dist-shared/`; **restart the running server** to pick up changes.
- `eslint@10`'s `import/order` autofix CRASHES on this repo — keep new relative imports in alphabetical order to avoid triggering it. Match repo style: 4-space indent, single quotes, `operator-linebreak` puts `?`/`:` at line *end*.
- Locale files: every key exists in all 9 `static/locales/*.json`; English in non-en files only when no translation is provided (here we DO translate).

---

## File Structure

- **Modify** `src/collision-voxel-options.ts` — add `Vec3Like`-based `seedToPlySpace`, `subsetRowsWithinRadius`, `voxelResolutionLadder` (pure, no deps).
- **Modify** `test/collision-voxel-options.test.ts` — unit tests for the three new helpers.
- **Modify** `src/splat-serialize.ts` — widen `ViewerExportSettings.collision` to `{ environment, radius, voxelSize }`.
- **Modify** `src/splat-export-core.ts` — rewrite `writeCollisionVoxel` (subset + ladder); widen the `collision?` param type on `writeViewerCore`/`writeStreamingViewerCore`; pass the whole `collision` object at both call sites.
- **Modify** `server/src/run-export.ts` — widen the `collision` type.
- **Modify** `src/ui/export-popup.ts` — add radius + voxel-size sliders.
- **Modify** `static/locales/*.json` (all 9) — add `popup.export.collision-radius` and `popup.export.voxel-size`.
- **Modify** `server/test/collision.gpu.test.ts` — pass radius/voxelSize; add a subset-outlier assertion.

---

## Task 1: Pure helpers (TDD)

**Files:** Modify `src/collision-voxel-options.ts`; Modify `test/collision-voxel-options.test.ts`

- [ ] **Step 1: Add failing tests.** Append to `test/collision-voxel-options.test.ts` (and add the imports `seedToPlySpace, subsetRowsWithinRadius, voxelResolutionLadder` to the existing import line from `../src/collision-voxel-options`):

```ts
describe('seedToPlySpace', () => {
    it('flips x and y, keeps z (PLY-space rotation)', () => {
        expect(seedToPlySpace({ x: 1, y: 2, z: 3 })).toEqual({ x: -1, y: -2, z: 3 });
    });
});

describe('subsetRowsWithinRadius', () => {
    it('keeps points within the radius and drops points outside', () => {
        const x = new Float32Array([0, 10, 0]);
        const y = new Float32Array([0, 0, 0]);
        const z = new Float32Array([0, 0, 3]);
        // seed at origin, radius 5: row0 (d=0) in, row1 (d=10) out, row2 (d=3) in
        expect(subsetRowsWithinRadius(x, y, z, { x: 0, y: 0, z: 0 }, 5)).toEqual([0, 2]);
    });

    it('includes points exactly on the boundary', () => {
        const x = new Float32Array([5]);
        const y = new Float32Array([0]);
        const z = new Float32Array([0]);
        expect(subsetRowsWithinRadius(x, y, z, { x: 0, y: 0, z: 0 }, 5)).toEqual([0]);
    });
});

describe('voxelResolutionLadder', () => {
    it('doubles from base up to the floor', () => {
        expect(voxelResolutionLadder(0.05)).toEqual([0.05, 0.1, 0.2, 0.4]);
    });
    it('returns just the base when base is already at/above the floor', () => {
        expect(voxelResolutionLadder(0.5)).toEqual([0.5]);
        expect(voxelResolutionLadder(0.4)).toEqual([0.4]);
    });
    it('caps the last rung at the floor', () => {
        expect(voxelResolutionLadder(0.2)).toEqual([0.2, 0.4]);
    });
});
```

- [ ] **Step 2: Run, expect FAIL.** `npx vitest run test/collision-voxel-options.test.ts` (unresolved imports).

- [ ] **Step 3: Implement.** In `src/collision-voxel-options.ts`, add before the `export {` line:

```ts
// Flip a world-space point into the PLY/DataTable space the columns use
// (extractDataTable stores positions as Rz(-180)·world). Used to filter the
// PLY-space position columns against the world-space start seed.
const seedToPlySpace = (seed: Vec3Like): Vec3Like => {
    return { x: -seed.x, y: -seed.y, z: seed.z };
};

// Row indices whose (x,y,z) lie within `radius` of `seedPly` (same space as the
// position columns). Distance is rotation-invariant, so `radius` is in scene
// units (~metres unless the splat was scaled in the editor).
const subsetRowsWithinRadius = (
    x: Float32Array,
    y: Float32Array,
    z: Float32Array,
    seedPly: Vec3Like,
    radius: number
): number[] => {
    const r2 = radius * radius;
    const indices: number[] = [];
    for (let i = 0; i < x.length; i++) {
        const dx = x[i] - seedPly.x;
        const dy = y[i] - seedPly.y;
        const dz = z[i] - seedPly.z;
        if (dx * dx + dy * dy + dz * dz <= r2) {
            indices.push(i);
        }
    }
    return indices;
};

// Voxel sizes to try, doubling from `base` up to (and including) `floor`.
// Each coarser rung cuts solid-block count ~8x, working around splat-transform's
// 2^24 Set limit in filterAndFillBlocks.
//   voxelResolutionLadder(0.05) -> [0.05, 0.1, 0.2, 0.4]
const voxelResolutionLadder = (base: number, floor = 0.4): number[] => {
    const ladder = [base];
    let v = base;
    while (v < floor) {
        v = Math.min(v * 2, floor);
        ladder.push(v);
    }
    return ladder;
};
```

Update the export line to include them:

```ts
export {
    collisionSeedFromSettings,
    collisionVoxelOptions,
    seedToPlySpace,
    subsetRowsWithinRadius,
    voxelResolutionLadder,
    type CollisionEnvironment,
    type Vec3Like
};
```

- [ ] **Step 4: Run, expect PASS.** `npx vitest run test/collision-voxel-options.test.ts`. If the `voxelResolutionLadder(0.05)` equality is float-flaky, switch that assertion to compare each element with `toBeCloseTo` — but `0.05*2`,`0.1*2`,`0.2*2` are exact-enough doubles, so `toEqual` should pass.

- [ ] **Step 5: Commit.** `git add src/collision-voxel-options.ts test/collision-voxel-options.test.ts && git commit -m "feat: region-subset and voxel-resolution-ladder helpers"`

---

## Task 2: Widen the collision option type

**Files:** Modify `src/splat-serialize.ts`

- [ ] **Step 1.** Change the `ViewerExportSettings` collision field from:

```ts
    collision?: { environment: 'indoor' | 'outdoor' };   // undefined = disabled
```

to:

```ts
    collision?: { environment: 'indoor' | 'outdoor'; radius: number; voxelSize: number };   // undefined = disabled
```

- [ ] **Step 2: Commit.** `git add src/splat-serialize.ts && git commit -m "feat: add radius/voxelSize to collision export settings"`

(Cross-file typecheck is deferred to Task 7; `writeViewerCore` only reads these via the object, so the existing 9-arg call still compiles.)

---

## Task 3: Rewrite writeCollisionVoxel (subset + auto-fit)

**Files:** Modify `src/splat-export-core.ts`

- [ ] **Step 1: Add helper imports.** Update the existing import from `./collision-voxel-options` to:

```ts
import { collisionSeedFromSettings, collisionVoxelOptions, seedToPlySpace, subsetRowsWithinRadius, voxelResolutionLadder, type CollisionEnvironment } from './collision-voxel-options';
```

- [ ] **Step 2: Replace `writeCollisionVoxel`.** Replace the ENTIRE current function (the one with the `try/catch` that logs the underlying error) with:

```ts
// Coarsest voxel size the auto-fit ladder will try before giving up.
const COLLISION_VOXEL_FLOOR = 0.4;

// Voxelize a sphere of `radius` around the start seed into memFs as
// index.voxel.json + index.voxel.bin. Auto-coarsens the voxel size (ladder up to
// COLLISION_VOXEL_FLOOR) to work around splat-transform's 2^24 solid-block Set
// limit in filterAndFillBlocks. Must run before the streaming LOD build consumes
// the table. writeVoxel does not mutate its input; failures throw before any
// output file is written and after the GPU pass is cleaned up, so retrying is
// safe. Throws a clear, actionable error if even the floor resolution fails.
const writeCollisionVoxel = async (
    memFs: MemoryFileSystem,
    dataTable: DataTable,
    viewerSettingsJson: any,
    createDevice: DeviceCreator,
    collision: { environment: CollisionEnvironment; radius?: number; voxelSize?: number }
): Promise<void> => {
    const radius = collision.radius ?? 50;
    const baseVoxelSize = collision.voxelSize ?? 0.05;
    const seed = collisionSeedFromSettings(viewerSettingsJson);
    const seedPly = seedToPlySpace(seed);

    const x = dataTable.getColumnByName('x')?.data as Float32Array;
    const y = dataTable.getColumnByName('y')?.data as Float32Array;
    const z = dataTable.getColumnByName('z')?.data as Float32Array;
    if (!x || !y || !z) {
        throw new Error('Collision generation failed: data table is missing position columns');
    }

    const indices = subsetRowsWithinRadius(x, y, z, seedPly, radius);
    if (indices.length === 0) {
        throw new Error(`Collision generation failed - no splats within ${radius} m of the start position.`);
    }
    const subset = indices.length === dataTable.numRows ? dataTable : dataTable.clone({ rows: indices });

    const ladder = voxelResolutionLadder(baseVoxelSize, COLLISION_VOXEL_FLOOR);
    for (let i = 0; i < ladder.length; i++) {
        const voxelResolution = ladder[i];
        try {
            await writeVoxel({
                filename: 'index.voxel.json',
                dataTable: subset,
                voxelResolution,
                opacityCutoff: 0.1,
                createDevice,
                ...collisionVoxelOptions(collision.environment, seed)
            }, memFs);
            return;
        } catch (err) {
            if (i < ladder.length - 1) {
                console.warn(`Collision voxelization failed at ${voxelResolution} m voxels (${(err as Error)?.message ?? err}); retrying at ${ladder[i + 1]} m.`);
                continue;
            }
            // Final rung: log the exact underlying error for diagnosis, then
            // surface an actionable summary.
            console.error('Collision voxelization failed (underlying error):', err);
            if ((err as any)?.cause !== undefined) {
                console.error('  cause:', (err as any).cause);
            }
            throw new Error(`Collision generation failed - the region is still too large to voxelize at ${voxelResolution} m voxels. Reduce the collision radius or increase the voxel size. (${(err as Error)?.message ?? err})`);
        }
    }
};
```

- [ ] **Step 3: Widen the `collision?` param type on both core functions.** In `writeStreamingViewerCore` and `writeViewerCore`, change the parameter `collision?: { environment: CollisionEnvironment }` to:

```ts
    collision?: { environment: CollisionEnvironment; radius: number; voxelSize: number }
```

- [ ] **Step 4: Pass the whole `collision` object at both call sites.** In `writeStreamingViewerCore` change `await writeCollisionVoxel(memFs, dataTable, viewerSettingsJson, createDevice, collision.environment);` to `await writeCollisionVoxel(memFs, dataTable, viewerSettingsJson, createDevice, collision);`. Do the same in the package branch of `writeViewerCore`.

- [ ] **Step 5: Build + commit.** `node scripts/build-shared.mjs` (expect clean), then `git add src/splat-export-core.ts && git commit -m "feat: region-subset + auto-coarsen voxel size for collision export"`

---

## Task 4: Server type

**Files:** Modify `server/src/run-export.ts`

- [ ] **Step 1.** Change `collision?: { environment: 'indoor' | 'outdoor' }` to `collision?: { environment: 'indoor' | 'outdoor'; radius: number; voxelSize: number }` in the `viewerExportSettings` type. (The two `writeViewerCore` calls already pass `options.viewerExportSettings!.collision` wholesale — no call-site change.)

- [ ] **Step 2: Typecheck + commit.** `npx tsc --noEmit -p server/tsconfig.json` (expect clean), then `git add server/src/run-export.ts && git commit -m "feat: forward radius/voxelSize in server collision type"`

---

## Task 5: Export dialog controls

**Files:** Modify `src/ui/export-popup.ts`

- [ ] **Step 1: Add the two rows.** After the `environmentRow.append(environmentSelect);` block, insert:

```ts
        // viewer: collision radius (shown only when collision is enabled)

        const radiusRow = new Container({
            class: 'row'
        });

        const radiusLabel = new Label({
            class: 'label',
            text: localize('popup.export.collision-radius')
        });

        const radiusSlider = new SliderInput({
            class: 'slider',
            min: 5,
            max: 500,
            precision: 0,
            value: 50
        });

        radiusRow.append(radiusLabel);
        radiusRow.append(radiusSlider);

        // viewer: collision voxel size (shown only when collision is enabled)

        const voxelSizeRow = new Container({
            class: 'row'
        });

        const voxelSizeLabel = new Label({
            class: 'label',
            text: localize('popup.export.voxel-size')
        });

        const voxelSizeSlider = new SliderInput({
            class: 'slider',
            min: 0.02,
            max: 0.5,
            precision: 2,
            value: 0.05
        });

        voxelSizeRow.append(voxelSizeLabel);
        voxelSizeRow.append(voxelSizeSlider);
```

- [ ] **Step 2: Append to content.** Change the `content.append(environmentRow);` line so the new rows follow it:

```ts
        content.append(environmentRow);
        content.append(radiusRow);
        content.append(voxelSizeRow);
        content.append(serverRow);
```

(Find the existing `content.append(environmentRow);` immediately before `content.append(serverRow);` and insert the two new appends between them.)

- [ ] **Step 3: Visibility.** In `updateCollisionVisibility`, set the new rows to follow the same gate as `environmentRow`:

```ts
        const updateCollisionVisibility = () => {
            const isZipViewer = currentExportType === 'viewer' && viewerTypeSelect.value === 'zip';
            collisionRow.hidden = !isZipViewer;
            const showSub = !isZipViewer || !collisionToggle.value;
            environmentRow.hidden = showSub;
            radiusRow.hidden = showSub;
            voxelSizeRow.hidden = showSub;
        };
```

- [ ] **Step 4: reset() row lists + defaults.** Add `radiusRow, voxelSizeRow` to BOTH the `allRows` array and the `viewer` entry of `activeRows` (place them next to `environmentRow`). Then, where `reset()` sets collision defaults, add:

```ts
            // collision detection (viewer zip only)
            collisionToggle.value = false;
            environmentSelect.value = 'indoor';
            radiusSlider.value = 50;
            voxelSizeSlider.value = 0.05;
            updateCollisionVisibility();
```

- [ ] **Step 5: Assemble.** Change the `collision:` line in `assembleViewerOptions` to:

```ts
                        collision: (viewerTypeSelect.value === 'zip' && collisionToggle.value) ? { environment: environmentSelect.value as 'indoor' | 'outdoor', radius: radiusSlider.value, voxelSize: voxelSizeSlider.value } : undefined,
```

- [ ] **Step 6: Typecheck + commit.** `npx tsc --noEmit` (expect clean), then `git add src/ui/export-popup.ts && git commit -m "feat: collision radius and voxel size controls in export dialog"`

---

## Task 6: Localization

**Files:** Modify all 9 `static/locales/*.json`

- [ ] **Step 1.** In each file, after the `"annotation.open-link"` line (added previously) insert the two keys. English (`en.json`):

```json
    "popup.export.collision-radius": "Collision radius (m)",
    "popup.export.voxel-size": "Voxel size (m)",
```

Translations (insert the matching pair in each file):

- **de**: `"Kollisionsradius (m)"`, `"Voxelgröße (m)"`
- **es**: `"Radio de colisión (m)"`, `"Tamaño de vóxel (m)"`
- **fr**: `"Rayon de collision (m)"`, `"Taille de voxel (m)"`
- **ja**: `"衝突半径 (m)"`, `"ボクセルサイズ (m)"`
- **ko**: `"충돌 반경 (m)"`, `"복셀 크기 (m)"`
- **pt-BR**: `"Raio de colisão (m)"`, `"Tamanho do voxel (m)"`
- **ru**: `"Радиус столкновений (м)"`, `"Размер вокселя (м)"`
- **zh-CN**: `"碰撞半径 (m)"`, `"体素大小 (m)"`

Each pair as:
```json
    "popup.export.collision-radius": "<radius translation>",
    "popup.export.voxel-size": "<voxel-size translation>",
```

- [ ] **Step 2: Validate.** `node -e "for (const f of ['de','en','es','fr','ja','ko','pt-BR','ru','zh-CN']) { JSON.parse(require('fs').readFileSync('static/locales/'+f+'.json','utf8')); } console.log('ok')"`

- [ ] **Step 3: Commit.** `git add static/locales/ && git commit -m "feat: localize collision radius and voxel size labels"`

---

## Task 7: GPU test update + subset assertion

**Files:** Modify `server/test/collision.gpu.test.ts`

> Run `node scripts/build-shared.mjs` first so the server test exercises the rewritten core.

- [ ] **Step 1: Pass radius/voxelSize in existing cases.** In the two `runExport` calls that set `collision`, change `collision: { environment: 'indoor' }` to `collision: { environment: 'indoor', radius: 50, voxelSize: 0.05 }`. (The 2048-splat scene spans ~[-1,1], so radius 50 keeps everything.)

- [ ] **Step 2: Add a subset test.** Add a new `describe` block that builds a scene with a near-origin cluster plus far outliers, exports with a small radius, and asserts the voxel metadata excludes the outliers. Use the existing `makePlyGz` pattern but with controlled positions, e.g.:

```ts
const makeClusterPlusOutliersPlyGz = async (): Promise<Buffer> => {
    const near = 256, far = 64, n = near + far;
    const col = (fn: (r: number) => number) => new Column('', new Float32Array(0)); // placeholder, see below
    const data: Record<string, Float32Array> = {};
    for (const name of NAMES) data[name] = new Float32Array(n);
    for (let r = 0; r < n; r++) {
        const outlier = r >= near;
        // near cluster within ~1 m of origin; outliers ~200 m away on +x
        data.x[r] = outlier ? 200 + Math.sin(r) : Math.sin(r) * 0.5;
        data.y[r] = Math.cos(r) * 0.5;
        data.z[r] = Math.sin(r * 1.3) * 0.5;
        data.scale_0[r] = data.scale_1[r] = data.scale_2[r] = -3; // small
        data.opacity[r] = 6; // high (sigmoid ~1)
        data.rot_0[r] = 1;
        // f_dc_* default 0 is fine
    }
    const cols = NAMES.map(name => new Column(name, data[name]));
    const memFs = new MemoryFileSystem();
    await writeFile({ filename: 'p.ply', outputFormat: 'ply', dataTable: new DataTable(cols, Transform.PLY), options: {} }, memFs);
    return Buffer.from(gzipSync(Buffer.from(memFs.results.get('p.ply')!)));
};
```

Then, in a GPU-guarded test, export with `collision: { environment: 'outdoor', radius: 10, voxelSize: 0.05 }`, read `index.voxel.json` from the ZIP via `zipReadEntry`, `JSON.parse` it, and assert `sceneBounds.max[0]` is well under the outlier distance (e.g. `< 50`) — proving the subset excluded the +200 m outliers. (Use `environment: 'outdoor'` to avoid external-fill's enclosed-volume requirement.) Remove the unused `col` placeholder; it's only shown to illustrate the column construction — build columns directly from `data` as in the final line.

- [ ] **Step 3: Run.** `cd server && npx vitest run collision.gpu.test.ts` (GPU present → assertions run; absent → self-skips).

- [ ] **Step 4: Commit.** From the `server/` cwd: `git add test/collision.gpu.test.ts && git commit -m "test: collision radius subset + auto-fit GPU coverage"`

---

## Task 8: Full verification

- [ ] `node scripts/build-shared.mjs` — clean.
- [ ] `npm run build` — clean (browser typecheck of UI + serialize).
- [ ] `npm run lint` — clean (watch the import/order ordering note).
- [ ] `npx vitest run test/collision-voxel-options.test.ts` — pass.
- [ ] `cd server && npx vitest run` — pass (the 3 `tsx` worker/route failures only occur under the *root* runner; from `server/` all pass).
- [ ] **Manual:** restart the export server, load the large scene, enable Collision Detection (ZIP), pick environment + a radius (e.g. 50) + voxel size (e.g. 0.05), export on server. Confirm it completes and the ZIP contains `index.voxel.json` + `index.voxel.bin`. If it still errors, read the server console — the message now states the floor voxel size and remedies.

---

## After implementation

This completes the collision feature work on `feature/collision-detection-zip-export`. Then run **superpowers:finishing-a-development-branch**: per the user's standing rule, **squash all feature commits into a single commit** summarizing the change (including docs), then present merge/PR options.

## Self-review notes

- **Spec coverage:** subset (Task 3) ✔; auto-fit ladder (Tasks 1,3) ✔; radius+voxel UI (Task 5) ✔; localization (Task 6) ✔; types/server (Tasks 2,4) ✔; clear errors + diagnostic log (Task 3) ✔; tests (Tasks 1,7) ✔; tiling deferred ✔.
- **Type consistency:** `collision` shape `{ environment, radius, voxelSize }` is identical across `ViewerExportSettings`, core params, server type, and the assembled UI object. `writeCollisionVoxel` accepts `radius?`/`voxelSize?` and defaults them, which is compatible with the required-field callers.
- **Coordinate handling:** `navSeed` world (no flip) for `writeVoxel`; `seedToPlySpace` flip only for filtering the PLY columns.
