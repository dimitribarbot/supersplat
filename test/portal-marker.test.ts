import { describe, it, expect } from 'vitest';

import {
    MARKER_SIZE,
    MARKER_TOOLTIPS,
    markerHitTest,
    markerInteractive,
    markerScale,
    markerVisible,
    portalsForScene,
    resolveMarkerTooltip
} from '../src/portal-marker';

describe('portalsForScene', () => {
    const portals = [
        { front: 0, back: 1 },
        { front: 1, back: 2 },
        { front: 3, back: null }
    ];

    it('matches a portal on its front side', () => {
        expect(portalsForScene(portals, 0)).toEqual([0]);
    });

    it('matches a portal on its back side', () => {
        expect(portalsForScene(portals, 2)).toEqual([1]);
    });

    it('returns every portal touching the scene', () => {
        expect(portalsForScene(portals, 1)).toEqual([0, 1]);
    });

    it('ignores a null side rather than matching it', () => {
        expect(portalsForScene(portals, null as any)).toEqual([]);
    });

    it('returns nothing for a scene no portal touches', () => {
        expect(portalsForScene(portals, 9)).toEqual([]);
    });

    it('tolerates an empty or missing list', () => {
        expect(portalsForScene([], 0)).toEqual([]);
        expect(portalsForScene(null as any, 0)).toEqual([]);
    });
});

describe('markerScale', () => {
    it('reproduces the viewer hotspot formula', () => {
        // (48 / 1000) * (2 * 10 / 2) = 0.48
        expect(markerScale(48, 1000, 2, 10)).toBeCloseTo(0.48, 10);
    });

    it('grows linearly with view depth so screen size stays constant', () => {
        expect(markerScale(48, 1000, 2, 20)).toBeCloseTo(markerScale(48, 1000, 2, 10) * 2, 10);
    });

    it('shrinks as the canvas gets taller', () => {
        expect(markerScale(48, 2000, 2, 10)).toBeCloseTo(markerScale(48, 1000, 2, 10) / 2, 10);
    });

    it('returns 0 for a degenerate canvas or projection', () => {
        expect(markerScale(48, 0, 2, 10)).toBe(0);
        expect(markerScale(48, 1000, 0, 10)).toBe(0);
    });
});

describe('markerVisible', () => {
    const base = { noui: false, cameraMode: 'orbit', transitionActive: false };

    it('is visible in the default state', () => {
        expect(markerVisible(base)).toBe(true);
    });

    it('stays visible in walk and fly, unlike annotations', () => {
        expect(markerVisible({ ...base, cameraMode: 'walk' })).toBe(true);
        expect(markerVisible({ ...base, cameraMode: 'fly' })).toBe(true);
    });

    it('is hidden under noui', () => {
        expect(markerVisible({ ...base, noui: true })).toBe(false);
    });

    it('is hidden during animation playback', () => {
        expect(markerVisible({ ...base, cameraMode: 'anim' })).toBe(false);
    });

    it('is hidden while a portal transition is running', () => {
        expect(markerVisible({ ...base, transitionActive: true })).toBe(false);
    });

    it('is hidden when several suppressors apply at once', () => {
        expect(markerVisible({ noui: true, cameraMode: 'anim', transitionActive: true })).toBe(false);
    });

    it('is visible when given no state at all', () => {
        expect(markerVisible(null as any)).toBe(true);
    });
});

describe('markerInteractive', () => {
    it('goes non-interactive in walk with gaming controls (mobile tap = jump, desktop = pointer lock)', () => {
        expect(markerInteractive({ cameraMode: 'walk', gamingControls: true })).toBe(false);
    });

    it('goes non-interactive in fly with gaming controls', () => {
        expect(markerInteractive({ cameraMode: 'fly', gamingControls: true })).toBe(false);
    });

    it('stays interactive in walk without gaming controls', () => {
        expect(markerInteractive({ cameraMode: 'walk', gamingControls: false })).toBe(true);
    });

    it('stays interactive in fly without gaming controls', () => {
        expect(markerInteractive({ cameraMode: 'fly', gamingControls: false })).toBe(true);
    });

    it('stays interactive in orbit, which never locks the pointer', () => {
        // gamingControls can be latched on from a previous walk session; orbit
        // still takes ordinary positional clicks, so the icons must respond.
        expect(markerInteractive({ cameraMode: 'orbit', gamingControls: true })).toBe(true);
    });

    it('stays interactive during anim playback', () => {
        // markerVisible already suppresses the icons entirely there; this
        // predicate must not double-suppress and mask that.
        expect(markerInteractive({ cameraMode: 'anim', gamingControls: true })).toBe(true);
    });

    it('defaults to interactive when the viewer state is unavailable', () => {
        expect(markerInteractive(null as any)).toBe(true);
    });
});

describe('markerHitTest', () => {
    // A face-on marker: both half-axes are 24px and perpendicular, so the
    // ellipse is the circle of radius 24 the old implementation used.
    const facing = { sx: 100, sy: 100, ux: 24, uy: 0, vx: 0, vy: 24, onScreen: true };
    // The same marker seen at a steep angle: full width, squashed to 6px
    // vertically. This is the case a scaled circle gets wrong in both
    // directions at once.
    const edgeOn = { sx: 100, sy: 100, ux: 24, uy: 0, vx: 0, vy: 6, onScreen: true };

    it('hits dead-centre', () => {
        expect(markerHitTest([facing], 100, 100)).toBe(0);
    });

    it('hits exactly on the ellipse boundary', () => {
        expect(markerHitTest([facing], 124, 100)).toBe(0);
    });

    it('misses just outside the boundary', () => {
        expect(markerHitTest([facing], 125, 100)).toBe(-1);
    });

    it('keeps the full major axis clickable when foreshortened', () => {
        // 20px along the uncompressed axis is well inside
        expect(markerHitTest([edgeOn], 120, 100)).toBe(0);
    });

    it('rejects the minor axis at a distance the major axis accepts', () => {
        // 12px vertically is outside a 6px half-axis, though the old circular
        // test (radius 24) would have accepted it
        expect(markerHitTest([edgeOn], 100, 112)).toBe(-1);
        expect(markerHitTest([edgeOn], 100, 105)).toBe(0);
    });

    it('handles a rotated ellipse, not just an axis-aligned one', () => {
        // major axis vertical, minor axis horizontal
        const tilted = { sx: 100, sy: 100, ux: 0, uy: 24, vx: 6, vy: 0, onScreen: true };
        expect(markerHitTest([tilted], 100, 120)).toBe(0);
        expect(markerHitTest([tilted], 108, 100)).toBe(-1);
    });

    it('never matches a degenerate (edge-on) marker', () => {
        // both half-axes collinear => zero determinant => no ellipse at all
        const degenerate = { sx: 100, sy: 100, ux: 24, uy: 0, vx: 12, vy: 0, onScreen: true };
        expect(markerHitTest([degenerate], 100, 100)).toBe(-1);
        expect(markerHitTest([degenerate], 110, 100)).toBe(-1);
    });

    it('never matches a marker with onScreen false', () => {
        expect(markerHitTest([{ ...facing, onScreen: false }], 100, 100)).toBe(-1);
    });

    it('returns -1 for an empty or absent list', () => {
        expect(markerHitTest([], 100, 100)).toBe(-1);
        expect(markerHitTest(null as any, 100, 100)).toBe(-1);
    });

    it('picks the nearest of two overlapping markers', () => {
        const markers = [facing, { ...facing, sx: 110 }];
        expect(markerHitTest(markers, 108, 100)).toBe(1);
        expect(markerHitTest(markers, 102, 100)).toBe(0);
    });

    it('handles a non-orthogonal basis, which is the normal projected case', () => {
        // A perspective projection of a tilted quad almost never yields
        // perpendicular screen axes. With u and v skewed, an off-diagonal sign
        // error in the inverse still passes every orthogonal fixture above.
        const oblique = { sx: 100, sy: 100, ux: 24, uy: 0, vx: 12, vy: 12, onScreen: true };
        expect(markerHitTest([oblique], 112, 112)).toBe(0);   // exactly v: d = 1
        expect(markerHitTest([oblique], 136, 112)).toBe(-1);  // u + v: d = 2
    });
});

describe('resolveMarkerTooltip', () => {
    it('resolves an exact locale', () => {
        expect(resolveMarkerTooltip(MARKER_TOOLTIPS, 'fr')).toBe(MARKER_TOOLTIPS.fr);
    });

    it('falls back from a region subtag to the base language', () => {
        expect(resolveMarkerTooltip(MARKER_TOOLTIPS, 'fr-CA')).toBe(MARKER_TOOLTIPS.fr);
    });

    it('is case insensitive', () => {
        expect(resolveMarkerTooltip(MARKER_TOOLTIPS, 'PT-BR')).toBe(MARKER_TOOLTIPS.pt);
    });

    it('falls back to English for an unknown language', () => {
        expect(resolveMarkerTooltip(MARKER_TOOLTIPS, 'xx')).toBe(MARKER_TOOLTIPS.en);
    });

    it('falls back to English for a null or empty language', () => {
        expect(resolveMarkerTooltip(MARKER_TOOLTIPS, null as any)).toBe(MARKER_TOOLTIPS.en);
        expect(resolveMarkerTooltip(MARKER_TOOLTIPS, '')).toBe(MARKER_TOOLTIPS.en);
    });

    it('provides a non-empty string for all nine languages', () => {
        const langs = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh'];
        expect(Object.keys(MARKER_TOOLTIPS).sort()).toEqual(langs.sort());
        Object.values(MARKER_TOOLTIPS).forEach(v => expect(v.length).toBeGreaterThan(0));
    });
});

describe('module contract', () => {
    it('exposes the agreed marker size', () => {
        expect(MARKER_SIZE).toBe(48);
    });

    it('keeps every stringified helper self-contained', () => {
        // These six are injected into the companion runtime via toString(),
        // so their bodies must not reference module-scope bindings.
        [portalsForScene, markerInteractive, markerScale, markerVisible, markerHitTest, resolveMarkerTooltip].forEach((fn) => {
            expect(fn.toString()).not.toContain('MARKER_TOOLTIPS');
            expect(fn.toString()).not.toContain('MARKER_SIZE');
        });
    });
});
