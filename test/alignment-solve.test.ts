import { describe, it, expect } from 'vitest';

import { largestEigenVector4, solveAlignmentRaw } from '../src/alignment-solve';

// helper: build a symmetric 4x4 from a diagonal
const diag = (a: number, b: number, c: number, d: number) => [
    [a, 0, 0, 0],
    [0, b, 0, 0],
    [0, 0, c, 0],
    [0, 0, 0, d]
];

describe('largestEigenVector4', () => {
    it('finds a dominant eigenvector orthogonal to the [1,0,0,0] start (power-iteration blind spot)', () => {
        // largest eigenvalue 5 belongs to index 2 -> eigenvector e2 = [0,0,1,0].
        // Power iteration seeded at [1,0,0,0] can never reach it; a robust solver must.
        const q = largestEigenVector4(diag(1, 1, 5, 1));
        expect(Math.abs(q[2])).toBeCloseTo(1, 6);
        expect(Math.abs(q[0])).toBeCloseTo(0, 6);
        expect(Math.abs(q[1])).toBeCloseTo(0, 6);
        expect(Math.abs(q[3])).toBeCloseTo(0, 6);
    });

    it('still finds the dominant eigenvector when it is aligned with the start vector', () => {
        const q = largestEigenVector4(diag(7, 1, 1, 1));
        expect(Math.abs(q[0])).toBeCloseTo(1, 6);
    });
});

// four non-coplanar source points
const SOURCE = [
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 1, y: 1, z: 1 }
];

// rotate a point 180 deg about Y -> (-x, y, -z), then translate
const rot180Y = (p: { x: number; y: number; z: number }, t: number[]) => ({
    x: -p.x + t[0],
    y: p.y + t[1],
    z: -p.z + t[2]
});

describe('solveAlignmentRaw', () => {
    it('recovers a 180-degree-about-Y rigid transform (RMS ~ 0)', () => {
        const t = [10, 5, -3];
        const target = SOURCE.map(p => rot180Y(p, t));
        const result = solveAlignmentRaw(SOURCE, target, 'rigid');
        expect(result).not.toBeNull();
        expect(result!.rms).toBeCloseTo(0, 4);
        // 180 about Y -> quaternion (x,y,z,w) = (0, +/-1, 0, 0)
        expect(Math.abs(result!.rotation[1])).toBeCloseTo(1, 4);
        expect(result!.scale).toBeCloseTo(1, 6);
    });

    it('does not collapse the scene in similarity mode for a 180-degree rotation', () => {
        const t = [10, 5, -3];
        const target = SOURCE.map(p => rot180Y(p, t));
        const result = solveAlignmentRaw(SOURCE, target, 'similarity');
        expect(result).not.toBeNull();
        // congruent clouds -> scale must stay ~1, never clamp toward 0 (the collapse bug)
        expect(result!.scale).toBeCloseTo(1, 4);
        expect(result!.rms).toBeCloseTo(0, 4);
    });

    it('still recovers a small rotation (no regression)', () => {
        // ~30 deg about Y
        const a = Math.PI / 6;
        const c = Math.cos(a), s = Math.sin(a);
        const target = SOURCE.map(p => ({
            x: c * p.x + s * p.z,
            y: p.y,
            z: -s * p.x + c * p.z
        }));
        const result = solveAlignmentRaw(SOURCE, target, 'rigid');
        expect(result).not.toBeNull();
        expect(result!.rms).toBeCloseTo(0, 4);
    });
});
