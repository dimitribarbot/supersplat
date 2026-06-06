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
    return environment === 'indoor' ?
        { navExteriorRadius: 1.6, navSeed: seed } :
        { floorFill: true, floorFillDilation: 1.6 };
};

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

export {
    collisionSeedFromSettings,
    collisionVoxelOptions,
    seedToPlySpace,
    subsetRowsWithinRadius,
    voxelResolutionLadder,
    type CollisionEnvironment,
    type Vec3Like
};
