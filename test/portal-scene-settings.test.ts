import { describe, it, expect } from 'vitest';

import { portalSceneSettings } from '../src/splat-serialize';

// shBands is an exact, zero-padded count (upstream v3.6.0), but each portal
// scene is written on its own, so its count is capped at the scene's own bands.
const scene = (...bands: number[]) => bands.map(shBands => ({ resource: { shBands } })) as any;

describe('portalSceneSettings', () => {
    it('caps the chosen band count at the scene\'s own bands', () => {
        expect(portalSceneSettings({ shBands: 3 }, scene(0)).shBands).toBe(0);
        expect(portalSceneSettings({ shBands: 3 }, scene(1)).shBands).toBe(1);
    });

    it('keeps a lower chosen count', () => {
        expect(portalSceneSettings({ shBands: 1 }, scene(3)).shBands).toBe(1);
    });

    it('defaults to the scene\'s bands when none is chosen', () => {
        expect(portalSceneSettings({}, scene(2)).shBands).toBe(2);
    });

    it('keeps the other settings', () => {
        expect(portalSceneSettings({ shBands: 3, minOpacity: 0.5, removeInvalid: true }, scene(2))).toEqual({ shBands: 2, minOpacity: 0.5, removeInvalid: true });
    });
});
