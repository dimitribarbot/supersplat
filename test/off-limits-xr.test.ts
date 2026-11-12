import { describe, it, expect } from 'vitest';

import { xrRigAfterBlock } from '../src/viewer-companion/off-limits-collision';

type V = [number, number, number];

describe('xrRigAfterBlock', () => {
    it('pushes a walk or grab-move back horizontally, keeping the floor height', () => {
        // the head walked 0.1 m through the wall; it is put back where it was safe
        const safe: V = [0, 1.6, 1];
        const head: V = [0, 1.62, 0.9];
        const rig: V = [5, 0, 5];
        expect(xrRigAfterBlock(safe, head, rig, rig)).toEqual([5, 0, 5.1]);
    });

    it('undoes a teleport across the wall, height included', () => {
        const prevRig: V = [0, 0, 2];
        const rig: V = [0, 0.5, -3]; // the teleport moved the rig past the wall, onto a step
        expect(xrRigAfterBlock([0, 1.6, 2], [0, 2.1, -3], prevRig, rig)).toEqual([0, 0, 2]);
    });

    it('treats a small rig move (grab-move this frame) as a walk', () => {
        const prevRig: V = [0, 0, 1];
        const rig: V = [0, 0, 0.95];
        const out = xrRigAfterBlock([0, 1.6, 1], [0, 1.6, 0.9], prevRig, rig);
        expect(out[0]).toBeCloseTo(0);
        expect(out[1]).toBe(0);
        expect(out[2]).toBeCloseTo(1.05);
    });

    it('is injectable verbatim: no backslash escapes for the companion templates to eat', () => {
        expect(xrRigAfterBlock.toString()).not.toContain(String.fromCharCode(92));
    });
});
