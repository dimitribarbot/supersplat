import { describe, it, expect } from 'vitest';

import { tileGrid, tileGeometry, tileDelay, transitionReducer, normalizePortalTransition, TransitionState } from '../src/portal-transition';

describe('tileGrid', () => {
    it('produces roughly square 26px tiles at a desktop aspect', () => {
        const g = tileGrid(1600, 1000);
        expect(g.cols).toBe(43);
        expect(g.rows).toBe(27);
    });

    it('hits the 26px target exactly on a phone, where the cap does not bite', () => {
        const g = tileGrid(390, 844);
        expect(g.cols).toBe(15);
        expect(g.rows).toBe(32);
        expect(g.cols * g.rows).toBe(480);
    });

    it('keeps a small viewport on the 26px target', () => {
        const g = tileGrid(320, 640);
        expect(g.cols).toBe(12);
        expect(g.rows).toBe(24);
    });

    it('clamps a very narrow viewport to the minimum columns', () => {
        const g = tileGrid(80, 200);
        expect(g.cols).toBe(6);
        expect(g.rows).toBe(15);
    });

    it('caps the total tile count on a large display', () => {
        const g = tileGrid(2560, 1440);
        expect(g.cols * g.rows).toBeLessThanOrEqual(1200);
        expect(g.cols).toBe(46);
        expect(g.rows).toBe(25);
    });

    it('keeps tiles roughly square when the cap bites', () => {
        const g = tileGrid(1920, 1080);
        expect(g.cols * g.rows).toBeLessThanOrEqual(1200);
        const tileW = 1920 / g.cols;
        const tileH = 1080 / g.rows;
        expect(tileW / tileH).toBeGreaterThan(0.8);
        expect(tileW / tileH).toBeLessThan(1.25);
    });

    it('caps an extreme aspect ratio too', () => {
        const g = tileGrid(6000, 400);
        expect(g.cols * g.rows).toBeLessThanOrEqual(1200);
        expect(g.rows).toBeGreaterThanOrEqual(4);
    });

    it('still caps when an axis is pinned to its minimum', () => {
        // cols floors to 6 before the cap, so scaling it down and reclamping
        // would re-inflate the product past MAX_TILES
        const g = tileGrid(100, 5000);
        expect(g.cols).toBe(6);
        expect(g.rows).toBe(200);
        expect(g.cols * g.rows).toBeLessThanOrEqual(1200);
    });

    it('falls back to a valid grid for degenerate sizes', () => {
        const g = tileGrid(0, 0);
        expect(g.cols).toBeGreaterThanOrEqual(6);
        expect(g.rows).toBeGreaterThanOrEqual(4);
    });
});

describe('tileGeometry', () => {
    it('gives the centre tile a near-zero distance', () => {
        // 3x3 grid, index 4 is the exact centre
        const g = tileGeometry(3, 3, 4);
        expect(g.dist).toBeCloseTo(0, 5);
    });

    it('gives corner tiles the largest distance, capped at 1', () => {
        const g = tileGeometry(3, 3, 0);   // top-left
        expect(g.dist).toBeGreaterThan(0.6);
        expect(g.dist).toBeLessThanOrEqual(1);
    });

    it('points the unit vector outward from the centre', () => {
        const topLeft = tileGeometry(3, 3, 0);
        expect(topLeft.ux).toBeLessThan(0);
        expect(topLeft.uy).toBeLessThan(0);
        const bottomRight = tileGeometry(3, 3, 8);
        expect(bottomRight.ux).toBeGreaterThan(0);
        expect(bottomRight.uy).toBeGreaterThan(0);
    });

    it('returns a unit-length outward vector', () => {
        const g = tileGeometry(4, 4, 0);
        expect(Math.sqrt(g.ux * g.ux + g.uy * g.uy)).toBeCloseTo(1, 6);
    });
});

describe('tileDelay', () => {
    it('dismantles edges first: the centre waits the full sweep', () => {
        expect(tileDelay(0, 450, 'dismantle')).toBe(450);
        expect(tileDelay(1, 450, 'dismantle')).toBe(0);
    });

    it('reconstructs centre first: the corners wait the full sweep', () => {
        expect(tileDelay(0, 450, 'reconstruct')).toBe(0);
        expect(tileDelay(1, 450, 'reconstruct')).toBe(450);
    });

    it('is monotonic between the extremes', () => {
        expect(tileDelay(0.5, 450, 'dismantle')).toBeCloseTo(225, 6);
        expect(tileDelay(0.5, 450, 'reconstruct')).toBeCloseTo(225, 6);
    });
});

const idle: TransitionState = { phase: 'idle', target: null };

describe('transitionReducer', () => {
    it('starts a dismantle from idle', () => {
        const r = transitionReducer(idle, { type: 'crossing', target: 2 });
        expect(r.state).toEqual({ phase: 'dismantling', target: 2 });
        expect(r.actions).toEqual({ cover: 'dismantle', dispatchTarget: null });
    });

    it('ignores a crossing while a transition is already running', () => {
        const busy: TransitionState = { phase: 'dismantling', target: 2 };
        const r = transitionReducer(busy, { type: 'crossing', target: 3 });
        expect(r.state).toEqual(busy);
        expect(r.actions).toEqual({ cover: 'none', dispatchTarget: null });
    });

    it('commits the switch when the cover completes on a live target', () => {
        const r = transitionReducer({ phase: 'dismantling', target: 2 }, { type: 'covered', target: 2 });
        expect(r.state).toEqual({ phase: 'covered', target: 2 });
        expect(r.actions).toEqual({ cover: 'none', dispatchTarget: 2 });
    });

    it('cancels straight into a reconstruct when the user walked back', () => {
        const r = transitionReducer({ phase: 'dismantling', target: 2 }, { type: 'covered', target: null });
        expect(r.state).toEqual({ phase: 'reconstructing', target: null });
        expect(r.actions).toEqual({ cover: 'reconstruct', dispatchTarget: null });
    });

    it('reconstructs once the destination scene is on screen', () => {
        const r = transitionReducer({ phase: 'covered', target: 2 }, { type: 'sceneShown' });
        expect(r.state).toEqual({ phase: 'reconstructing', target: 2 });
        expect(r.actions).toEqual({ cover: 'reconstruct', dispatchTarget: null });
    });

    it('ignores sceneShown outside the covered phase', () => {
        const r = transitionReducer({ phase: 'reconstructing', target: 2 }, { type: 'sceneShown' });
        expect(r.state).toEqual({ phase: 'reconstructing', target: 2 });
        expect(r.actions).toEqual({ cover: 'none', dispatchTarget: null });
    });

    it('returns to idle when the reconstruct finishes', () => {
        const r = transitionReducer({ phase: 'reconstructing', target: 2 }, { type: 'done' });
        expect(r.state).toEqual({ phase: 'idle', target: null });
        expect(r.actions).toEqual({ cover: 'none', dispatchTarget: null });
    });

    it('ignores done outside the reconstructing phase', () => {
        const r = transitionReducer({ phase: 'covered', target: 2 }, { type: 'done' });
        expect(r.state).toEqual({ phase: 'covered', target: 2 });
    });

    it('aborts to idle and clears the cover from any phase', () => {
        (['dismantling', 'covered', 'reconstructing'] as const).forEach((phase) => {
            const r = transitionReducer({ phase, target: 2 }, { type: 'abort' });
            expect(r.state).toEqual({ phase: 'idle', target: null });
            expect(r.actions).toEqual({ cover: 'clear', dispatchTarget: null });
        });
    });
});

describe('normalizePortalTransition', () => {
    it('maps the legacy boolean onto the enum', () => {
        expect(normalizePortalTransition(false)).toBe('none');
        // legacy true meant "enabled", which now resolves to the default cover
        expect(normalizePortalTransition(true)).toBe('defocus');
    });

    it('treats an absent value as the default cover, defocus', () => {
        expect(normalizePortalTransition(undefined)).toBe('defocus');
        expect(normalizePortalTransition(null)).toBe('defocus');
    });

    it('only an explicit "tiles" selects the tile cover', () => {
        expect(normalizePortalTransition('tiles')).toBe('tiles');
    });

    it('passes the three enum values through', () => {
        expect(normalizePortalTransition('none')).toBe('none');
        expect(normalizePortalTransition('tiles')).toBe('tiles');
        expect(normalizePortalTransition('defocus')).toBe('defocus');
    });

    it('falls back to the default cover for an unrecognised value', () => {
        expect(normalizePortalTransition('shards')).toBe('defocus');
        expect(normalizePortalTransition(7)).toBe('defocus');
    });
});
