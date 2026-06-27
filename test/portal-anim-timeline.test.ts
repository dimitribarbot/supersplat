import { describe, it, expect } from 'vitest';

import { buildPortalAnimTimeline, PortalAnimTrack } from '../src/portal-anim-timeline';
import { PortalRect } from '../src/portal-geom';

// Portal in the XY plane at the origin (identity rotation -> normal is local +Z).
// Local +Z side is "front" (scene 1), local -Z side is "back" (scene 0).
const portal: PortalRect = {
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    width: 10,
    height: 10,
    frontUid: 1,
    backUid: 0
};

// Linear-ish track (smoothness 0) so the path is a monotonic interpolation.
// keyframe 0 at z=-5 (back side), keyframe 1 at z=+5 (front side). times in frames.
const track = (overrides: Partial<PortalAnimTrack> = {}): PortalAnimTrack => ({
    duration: 1,
    frameRate: 30,
    smoothness: 0,
    keyframes: {
        times: [0, 30],
        values: {
            position: [0, 0, -5, 0, 0, 5],
            target: [0, 0, 0, 0, 0, 0],
            fov: [60, 60]
        }
    },
    ...overrides
});

describe('buildPortalAnimTimeline', () => {
    it('always starts at t=0 with the start scene', () => {
        const tl = buildPortalAnimTimeline(track(), [portal], 0);
        expect(tl[0]).toEqual({ t: 0, scene: 0 });
    });

    it('records a crossing into the far scene as the path passes through the portal', () => {
        const tl = buildPortalAnimTimeline(track(), [portal], 0);
        expect(tl).toHaveLength(2);
        expect(tl[1].scene).toBe(1);
        expect(tl[1].t).toBeGreaterThan(0);
        expect(tl[1].t).toBeLessThan(1);
    });

    it('returns only the start entry when the path never crosses a portal', () => {
        // Path stays entirely on the back side (z from -5 to -1): no crossing.
        const noCross = track({
            keyframes: { times: [0, 30], values: { position: [0, 0, -5, 0, 0, -1], target: [0, 0, 0, 0, 0, 0], fov: [60, 60] } }
        });
        const tl = buildPortalAnimTimeline(noCross, [portal], 0);
        expect(tl).toEqual([{ t: 0, scene: 0 }]);
    });

    it('records a round trip as two crossings (back -> front -> back)', () => {
        // z: -5 -> +5 -> -5 across three keyframes.
        const roundTrip = track({
            duration: 2,
            keyframes: {
                times: [0, 30, 60],
                values: { position: [0, 0, -5, 0, 0, 5, 0, 0, -5], target: [0, 0, 0, 0, 0, 0, 0, 0, 0], fov: [60, 60, 60] }
            }
        });
        const tl = buildPortalAnimTimeline(roundTrip, [portal], 0);
        expect(tl).toHaveLength(3);
        expect(tl.map(e => e.scene)).toEqual([0, 1, 0]);
        expect(tl[1].t).toBeLessThan(tl[2].t);
    });

    it('returns only the start entry for a degenerate track (fewer than 2 keyframes)', () => {
        const single = track({ keyframes: { times: [0], values: { position: [0, 0, -5], target: [0, 0, 0], fov: [60] } } });
        expect(buildPortalAnimTimeline(single, [portal], 0)).toEqual([{ t: 0, scene: 0 }]);
    });

    it('returns only the start entry when the track is null/undefined', () => {
        expect(buildPortalAnimTimeline(null, [portal], 3)).toEqual([{ t: 0, scene: 3 }]);
        expect(buildPortalAnimTimeline(undefined, [portal], 2)).toEqual([{ t: 0, scene: 2 }]);
    });

    it('returns only the start entry when there are no portals', () => {
        expect(buildPortalAnimTimeline(track(), [], 0)).toEqual([{ t: 0, scene: 0 }]);
    });

    it('returns only the start entry for a non-positive duration', () => {
        expect(buildPortalAnimTimeline(track({ duration: 0 }), [portal], 0)).toEqual([{ t: 0, scene: 0 }]);
        expect(buildPortalAnimTimeline(track({ duration: -1 }), [portal], 0)).toEqual([{ t: 0, scene: 0 }]);
    });
});
