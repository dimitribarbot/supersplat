# Collision on large scenes (subset + auto-fit) — Design

Date: 2026-06-06

## Problem

Enabling collision detection on a large 3DGS scene fails immediately with:

```
RangeError: Set maximum size exceeded
    at Set.add
    at filterAndFillBlocks (@playcanvas/splat-transform/dist/index.mjs)
    at writeVoxel
```

`filterAndFillBlocks` (a CPU post-processing step in `writeVoxel`, run after the
GPU voxelization completes and after `gpuVoxelization.destroy()`) builds a JS
`Set` of fully-solid 4×4×4 voxel blocks. V8 caps a `Set` at 2²⁴ ≈ 16.7M
entries, so a scene producing more than ~16.7M solid blocks at the default
0.05 m voxel size throws.

Key facts that shape the fix:

- The **GPU voxelization succeeds**; the limit is purely the **number of
  occupied blocks**, which is geometry-dependent.
- Solid-block count scales ~with covered volume and ~`1/voxelSize³`, so
  coarsening is a strong lever (0.05→0.1 m ≈ ÷8; 0.05→0.2 m ≈ ÷64), as is
  restricting the region.
- The failure is a **synchronous `RangeError` thrown after GPU cleanup**, so
  catching it and retrying at a coarser voxel size is safe — no GPU device
  corruption, no partial output files (`writeVoxel` writes its files only on
  success).
- Because the solid-block count cannot be predicted without voxelizing, a
  retry-and-coarsen ladder is the correct approach (not an up-front formula).

(The 2²⁴ `Set` cap is a splat-transform limitation worth reporting upstream;
this design works around it.)

## Goals

- Make collision export succeed on large scenes by (a) voxelizing only a
  spherical region around the start position and (b) auto-coarsening the voxel
  size until the solid-block count fits, failing with a clear message only if a
  sane floor is still exceeded.
- Expose **Collision radius (m)** and **Voxel size (m)** controls in the export
  dialog (localized).
- Keep the diagnostic logging of the exact underlying voxelization error.

## Non-goals (deferred)

- Tiling the scene + merging voxel octrees ("ultimate" full-coverage solution):
  splat-transform exposes no octree-merge API and the viewer loads a single
  voxel file. Out of scope.

## Coordinate handling

`extractDataTable` stores positions in PLY space (`Rz(-180)·world`) and tags the
table `Transform.PLY`. The start-camera seed (`cameras[0].initial.position`) is
in world space.

- **`navSeed`** passed to `writeVoxel` stays in **world space** (unchanged —
  `writeVoxel` re-applies the PLY transform internally).
- **Region filtering** runs against the PLY-space columns, so the seed is
  flipped into PLY space: `(x,y,z) → (-x,-y,z)`. Euclidean distance is
  rotation-invariant, so the radius is in scene units (≈ metres unless the splat
  itself was scaled in the editor — documented caveat).

## Architecture / components

### 1. Pure helpers (`src/collision-voxel-options.ts`, unit-tested)

```ts
// Flip a world-space point into the PLY/DataTable space the columns use.
const seedToPlySpace = (seed: Vec3Like): Vec3Like => ({ x: -seed.x, y: -seed.y, z: seed.z });

// Row indices whose (x,y,z) lie within `radius` of `seedPly` (PLY space).
const subsetRowsWithinRadius = (
    x: Float32Array, y: Float32Array, z: Float32Array,
    seedPly: Vec3Like, radius: number
): number[] => { /* push i where dx²+dy²+dz² <= radius² */ };

// Voxel sizes to try, doubling from `base` up to (and including) `floor`.
//   voxelResolutionLadder(0.05) -> [0.05, 0.1, 0.2, 0.4]
//   voxelResolutionLadder(0.5)  -> [0.5]   (already >= floor)
const voxelResolutionLadder = (base: number, floor = 0.4): number[] => { ... };
```

### 2. Export core (`src/splat-export-core.ts`)

`writeCollisionVoxel` is rewritten to take the full `collision` option
`{ environment, radius, voxelSize }` (with defaults `radius = 50`,
`voxelSize = 0.05` applied defensively) and:

1. Derive `seed` (world) via `collisionSeedFromSettings`; `seedPly` via
   `seedToPlySpace`.
2. Read `x/y/z` columns; `indices = subsetRowsWithinRadius(...)`. If empty →
   throw `Collision generation failed - no splats within <radius> m of the start position.`
3. `subset = indices.length === dataTable.numRows ? dataTable : dataTable.clone({ rows: indices })`.
4. For each `v` in `voxelResolutionLadder(voxelSize)`: try
   `writeVoxel({ filename: 'index.voxel.json', dataTable: subset, voxelResolution: v, opacityCutoff: 0.1, createDevice, ...collisionVoxelOptions(environment, seed) }, memFs)`.
   - On success: return.
   - On failure that is **not** the last rung: `console.warn` the message and
     retry at the next (coarser) `v`.
   - On failure at the **last** rung: `console.error` the full underlying error
     (kept from the diagnostic change) and throw
     `Collision generation failed - the region is still too large to voxelize at <v> m voxels. Reduce the collision radius or increase the voxel size. (<underlying message>)`.

The existing call sites (`writeViewerCore` package branch, `writeStreamingViewerCore`)
pass the whole `collision` object to `writeCollisionVoxel` (instead of just
`environment`). Voxelize-before-LOD ordering and the collisionUrl repoint are
unchanged.

### 3. Types & wiring

- `ViewerExportSettings.collision` (`src/splat-serialize.ts`) and the server
  `viewerExportSettings.collision` type (`server/src/run-export.ts`) become
  `{ environment: 'indoor' | 'outdoor'; radius: number; voxelSize: number }`.
- `serializeViewer` already forwards `collision`; the server already forwards it
  wholesale. `writeViewerCore`/`writeStreamingViewerCore` thread the object
  through unchanged in shape.

### 4. UI (`src/ui/export-popup.ts`)

Two new rows, shown only when collision is enabled and type = ZIP (same
visibility predicate as the environment row):

- **Collision radius (m)** — `SliderInput` min 5, max 500, precision 0,
  default 50. Label `popup.export.collision-radius`.
- **Voxel size (m)** — `SliderInput` min 0.02, max 0.5, precision 2,
  default 0.05. Label `popup.export.voxel-size`.

`assembleViewerOptions` emits
`collision: (viewerTypeSelect.value === 'zip' && collisionToggle.value) ? { environment, radius, voxelSize } : undefined`.
`reset()` restores defaults (50 / 0.05) and the rows are added to `allRows` and
the `viewer` entry of `activeRows`; visibility is folded into
`updateCollisionVisibility` (radius/voxel rows follow the same gate as the
environment row).

### 5. Localization (`static/locales/*.json`)

New keys `popup.export.collision-radius` and `popup.export.voxel-size`, added to
all 9 files, with English in `en.json` and translations in the other 8 (matching
the prior localization pass).

## Error handling

- No splats within the radius → clear, actionable error (above).
- All ladder rungs exceed the limit → clear, actionable error naming the floor
  voxel size and the two remedies (reduce radius / increase voxel size).
- The exact underlying error is logged via `console.error` (server console /
  browser devtools) before the final throw.
- Failures occur before any output ZIP is written, so no partial/corrupt output.

## Testing

- **Unit (`test/collision-voxel-options.test.ts`)**:
  - `seedToPlySpace({x,y,z})` → `{-x,-y,z}`.
  - `subsetRowsWithinRadius` keeps points inside the radius, drops points
    outside (including a boundary case).
  - `voxelResolutionLadder(0.05)` → `[0.05,0.1,0.2,0.4]`; `voxelResolutionLadder(0.5)`
    → `[0.5]`; `voxelResolutionLadder(0.2)` → `[0.2,0.4]`.
- **GPU integration (`server/test/collision.gpu.test.ts`)**:
  - Update existing cases to pass `radius`/`voxelSize` (e.g. 50 / 0.05).
  - Add a case: a scene with a cluster near the origin plus far outliers
    (> radius away); export with a small radius; parse `index.voxel.json` and
    assert its `sceneBounds` lie within ~radius of the origin (outliers
    excluded), proving the subset is applied end-to-end.
  - (The coarsen ladder is covered by its unit test; forcing the 2²⁴ Set limit
    in a test is impractical.)

## Defaults / constants

- Default radius 50 m, default voxel size 0.05 m, coarsen floor 0.4 m.
- `voxelResolution`/`opacityCutoff` defaults unchanged (0.05 base / 0.1).
- `collisionMesh` still off; carve still unused.
