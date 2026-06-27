import { describe, it, expect } from 'vitest';

import { segmentBlockedByWall, type Wall } from '../src/viewer-companion/off-limits-collision';

const wall = (over: Partial<Wall> = {}): Wall => ({
    position: over.position ?? [0, 0, 0],
    rotation: over.rotation ?? [0, 0, 0, 1],
    width: over.width ?? 2,
    height: over.height ?? 2,
    ...over
});

describe('segmentBlockedByWall', () => {
    it('blocks a segment crossing an axis-aligned wall within extents', () => {
        const safe = segmentBlockedByWall([0, 0, -1], [0, 0, 1], wall());
        expect(safe).toEqual([0, 0, -1]); // clamp back to the last safe (prev) position
    });

    it('does not block when the crossing point is outside the width', () => {
        expect(segmentBlockedByWall([5, 0, -1], [5, 0, 1], wall())).toBeNull();
    });

    it('does not block when the crossing point is outside the height', () => {
        expect(segmentBlockedByWall([0, 5, -1], [0, 5, 1], wall())).toBeNull();
    });

    it('blocks past the right edge when the right edge is infinite', () => {
        // crossing at x = 5 is outside the default half-width (1) -> normally null,
        // but with right:infinite the wall extends, so it blocks.
        const w = wall({ infinite: { top: false, right: true, bottom: false, left: false } });
        expect(segmentBlockedByWall([5, 0, -1], [5, 0, 1], w)).toEqual([5, 0, -1]);
    });

    it('still does not block past the left edge when only the right edge is infinite', () => {
        const w = wall({ infinite: { top: false, right: true, bottom: false, left: false } });
        expect(segmentBlockedByWall([-5, 0, -1], [-5, 0, 1], w)).toBeNull();
    });

    it('blocks past the top edge when the top edge is infinite', () => {
        const w = wall({ infinite: { top: true, right: false, bottom: false, left: false } });
        expect(segmentBlockedByWall([0, 5, -1], [0, 5, 1], w)).toEqual([0, 5, -1]);
    });

    it('no flags behaves exactly like the original bounds check', () => {
        const w = wall({ infinite: { top: false, right: false, bottom: false, left: false } });
        expect(segmentBlockedByWall([5, 0, -1], [5, 0, 1], w)).toBeNull();
        expect(segmentBlockedByWall([0, 0, -1], [0, 0, 1], w)).toEqual([0, 0, -1]);
    });

    it('does not block when both endpoints are on the same side', () => {
        expect(segmentBlockedByWall([0, 0, 1], [0, 0, 2], wall())).toBeNull();
        expect(segmentBlockedByWall([0, 0, -2], [0, 0, -1], wall())).toBeNull();
    });

    it('handles a wall rotated 90deg about Y (normal pointing along world X)', () => {
        const q: [number, number, number, number] = [0, 0.7071067811865476, 0, 0.7071067811865476];
        const w = wall({ rotation: q });
        const safe = segmentBlockedByWall([-1, 0, 0], [1, 0, 0], w);
        expect(safe).not.toBeNull();
        expect(safe![0]).toBeCloseTo(-1, 6);
        expect(segmentBlockedByWall([0, 0, -1], [0, 0, 1], w)).toBeNull();
    });

    it('respects a non-origin wall center', () => {
        const w = wall({ position: [10, 0, 0] });
        expect(segmentBlockedByWall([10, 0, -1], [10, 0, 1], w)).toEqual([10, 0, -1]);
        expect(segmentBlockedByWall([0, 0, -1], [0, 0, 1], w)).toBeNull();
    });
});
