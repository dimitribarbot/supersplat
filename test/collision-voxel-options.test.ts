import { describe, it, expect } from 'vitest';
import { collisionSeedFromSettings, collisionVoxelOptions, seedToPlySpace, subsetRowsWithinRadius, voxelResolutionLadder } from '../src/collision-voxel-options';

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
