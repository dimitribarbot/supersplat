import { describe, it, expect } from 'vitest';

import { segmentCrossesRect, resolveActiveSplat, PortalRect } from '../src/portal-geom';

const rect = (over: Partial<PortalRect> = {}): PortalRect => ({
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1], // identity: local frame == world, normal +Z
    width: 4,
    height: 4,
    frontUid: 10,
    backUid: 20,
    ...over
});

describe('segmentCrossesRect', () => {
    it('reports a front-side crossing through the rectangle', () => {
        const c = segmentCrossesRect([0, 0, -1], [0, 0, 1], rect());
        expect(c).toEqual({ side: 'front', t: 0.5 });
    });

    it('reports a back-side crossing when moving the other way', () => {
        const c = segmentCrossesRect([0, 0, 1], [0, 0, -1], rect());
        expect(c).toEqual({ side: 'back', t: 0.5 });
    });

    it('returns null when the hit point is outside the width/height extents', () => {
        expect(segmentCrossesRect([10, 0, -1], [10, 0, 1], rect())).toBeNull();
    });

    it('returns null when both endpoints are on the same side', () => {
        expect(segmentCrossesRect([0, 0, 1], [0, 0, 2], rect())).toBeNull();
    });

    it('handles a rotated portal (90 deg about Y, normal along world +X)', () => {
        const r = rect({ rotation: [0, 0.7071067811865476, 0, 0.7071067811865476] });
        const c = segmentCrossesRect([-1, 0, 0], [1, 0, 0], r);
        expect(c?.side).toBe('front');
        expect(c?.t).toBeCloseTo(0.5);
    });

    it('returns null when a rotated-portal crossing lands outside the extents', () => {
        const r = rect({ rotation: [0, 0.7071067811865476, 0, 0.7071067811865476] });
        expect(segmentCrossesRect([-1, 10, 0], [1, 10, 0], r)).toBeNull();
    });

    it('a crossing past the right edge counts only when right is infinite', () => {
        // pierce at ix = +10, well past hw = 2
        expect(segmentCrossesRect([10, 0, -1], [10, 0, 1], rect())).toBeNull();
        const r = rect({ infinite: { top: false, right: true, bottom: false, left: false } });
        expect(segmentCrossesRect([10, 0, -1], [10, 0, 1], r)).toEqual({ side: 'front', t: 0.5 });
    });

    it('right-infinite does not extend the opposite (left) edge', () => {
        const r = rect({ infinite: { top: false, right: true, bottom: false, left: false } });
        expect(segmentCrossesRect([-10, 0, -1], [-10, 0, 1], r)).toBeNull();
    });

    it('top and bottom infinite extend the vertical edges independently', () => {
        const top = rect({ infinite: { top: true, right: false, bottom: false, left: false } });
        expect(segmentCrossesRect([0, 10, -1], [0, 10, 1], top)).not.toBeNull();
        expect(segmentCrossesRect([0, -10, -1], [0, -10, 1], top)).toBeNull();
        const bottom = rect({ infinite: { top: false, right: false, bottom: true, left: false } });
        expect(segmentCrossesRect([0, -10, -1], [0, -10, 1], bottom)).not.toBeNull();
    });

    it('all-four infinite acts as the full splitting plane', () => {
        const all = rect({ infinite: { top: true, right: true, bottom: true, left: true } });
        expect(segmentCrossesRect([100, -100, -1], [100, -100, 1], all)).toEqual({ side: 'front', t: 0.5 });
    });
});

describe('resolveActiveSplat', () => {
    it('returns the current uid when nothing is crossed', () => {
        expect(resolveActiveSplat([0, 0, 1], [0, 0, 2], [rect()], 20)).toBe(20);
    });

    it('switches to the front scene after crossing onto the front side', () => {
        expect(resolveActiveSplat([0, 0, -1], [0, 0, 1], [rect()], 20)).toBe(10);
    });

    it('applies multiple crossings in order along the segment (last wins)', () => {
        const a = rect({ position: [0, 0, 0], frontUid: 10, backUid: 20 });
        const b = rect({ position: [0, 0, 5], frontUid: 30, backUid: 40 });
        // segment from z=-1 to z=6 crosses A (t~0.14) then B (t~0.86)
        expect(resolveActiveSplat([0, 0, -1], [0, 0, 6], [a, b], 20)).toBe(30);
    });
});
