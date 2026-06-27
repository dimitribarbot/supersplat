import { describe, it, expect } from 'vitest';

import { buildPortalBundle, resolveCollisionSeed, resolvePortalExtras, EYE_HEIGHT, SIDE_NUDGE, collisionSeedTuple } from '../src/portal-export';

const portal = (front: number | null, back: number | null) => ({
    position: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0, 1] as [number, number, number, number],
    width: 2, height: 2, frontUid: front, backUid: back
});

describe('buildPortalBundle', () => {
    it('maps uids to bundle indices with start = index 0', () => {
        const b = buildPortalBundle({
            portals: [portal(10, 20)],
            startUid: 10,
            availableUids: [10, 20],
            streaming: false,
            collision: false
        });
        expect(b).not.toBeNull();
        expect(b!.portalStart).toBe(0);
        expect(b!.sceneUids[0]).toBe(10);        // start first
        expect(b!.sceneUids).toContain(20);
        expect(b!.portals[0].front).toBe(0);     // uid 10 -> index 0
        expect(b!.portals[0].back).toBe(b!.sceneUids.indexOf(20));
    });

    it('primary scene URL is empty; extra scenes follow scenes/N convention (SOG)', () => {
        const b = buildPortalBundle({ portals: [portal(10, 20)], startUid: 10, availableUids: [10, 20], streaming: false, collision: false })!;
        expect(b.portalScenes[0]).toBe('');
        const idx20 = b.sceneUids.indexOf(20);
        expect(b.portalScenes[idx20]).toBe(`scenes/${idx20}/scene.sog`);
    });

    it('streaming uses lod-meta.json per extra scene', () => {
        const b = buildPortalBundle({ portals: [portal(10, 20)], startUid: 10, availableUids: [10, 20], streaming: true, collision: false })!;
        const idx20 = b.sceneUids.indexOf(20);
        expect(b.portalScenes[idx20]).toBe(`scenes/${idx20}/lod-meta.json`);
    });

    it('collision URLs: primary = index.voxel.json, extras = scenes/N/scene.voxel.json', () => {
        const b = buildPortalBundle({ portals: [portal(10, 20)], startUid: 10, availableUids: [10, 20], streaming: false, collision: true })!;
        const idx20 = b.sceneUids.indexOf(20);
        expect(b.portalCollision[0]).toBe('index.voxel.json');
        expect(b.portalCollision[idx20]).toBe(`scenes/${idx20}/scene.voxel.json`);
    });

    it('collision array is empty when collision is off', () => {
        const b = buildPortalBundle({ portals: [portal(10, 20)], startUid: 10, availableUids: [10, 20], streaming: false, collision: false })!;
        expect(b.portalCollision).toEqual([]);
    });

    it('null start falls back to the first referenced scene as index 0', () => {
        const b = buildPortalBundle({ portals: [portal(10, 20)], startUid: null, availableUids: [10, 20], streaming: false, collision: false })!;
        expect(b.portalStart).toBe(0);
        expect(b.sceneUids[0]).toBe(10);
    });

    it('drops references to uids that no longer exist', () => {
        const b = buildPortalBundle({ portals: [portal(10, 99)], startUid: 10, availableUids: [10, 20], streaming: false, collision: false });
        // uid 99 is gone -> that side becomes null; only scene 10 remains resolvable -> < 2 scenes -> null
        expect(b).toBeNull();
    });

    it('returns null when fewer than 2 resolvable scenes', () => {
        const b = buildPortalBundle({ portals: [portal(10, null)], startUid: 10, availableUids: [10], streaming: false, collision: false });
        expect(b).toBeNull();
    });

    it('dedupes a scene referenced by multiple portals', () => {
        const b = buildPortalBundle({
            portals: [portal(10, 20), portal(20, 30)],
            startUid: 10,
            availableUids: [10, 20, 30],
            streaming: false, collision: false
        })!;
        expect(b.sceneUids.filter(u => u === 20).length).toBe(1);
        expect(b.sceneUids.length).toBe(3);
    });

    it('carries the infinite-edges flags onto the rewritten portals', () => {
        const inf = { top: false, right: true, bottom: false, left: false };
        const b = buildPortalBundle({
            portals: [{ ...portal(10, 20), infinite: inf }],
            startUid: 10, availableUids: [10, 20], streaming: false, collision: false
        })!;
        expect(b.portals[0].infinite).toEqual(inf);
    });
});

const portalAt = (pos: [number, number, number], front: number | null, back: number | null, h = 2) => ({
    position: pos as [number, number, number],
    rotation: [0, 0, 0, 1] as [number, number, number, number],  // identity: up=+Y, normal=+Z
    width: 2, height: h, frontUid: front, backUid: back
});

describe('resolveCollisionSeed', () => {
    it('start scene (index 0) uses the start seed and is not estimated', () => {
        const r = resolveCollisionSeed({ sceneIndex: 0, sceneUid: 10, portals: [], authored: {}, startSeed: [1, 2, 3] });
        expect(r).toEqual({ seed: [1, 2, 3], estimated: false });
    });

    it('authored entrypoint wins and is not estimated', () => {
        const r = resolveCollisionSeed({ sceneIndex: 1, sceneUid: 20, portals: [portalAt([0, 0, 0], 10, 20)], authored: { '20': [5, 6, 7] }, startSeed: [0, 0, 0] });
        expect(r).toEqual({ seed: [5, 6, 7], estimated: false });
    });

    it('portal-derived fallback: floor (bottom edge) + eye height, nudged to the scene side, marked estimated', () => {
        // identity rotation, portal center at y=10, height 2 -> bottom edge y=9; +eye -> 9+1.6.
        // scene 20 is the BACK side -> nudge -Z by SIDE_NUDGE.
        const r = resolveCollisionSeed({ sceneIndex: 1, sceneUid: 20, portals: [portalAt([0, 10, 0], 10, 20)], authored: {}, startSeed: [0, 0, 0] });
        expect(r.estimated).toBe(true);
        expect(r.seed[0]).toBeCloseTo(0, 6);
        expect(r.seed[1]).toBeCloseTo(9 + EYE_HEIGHT, 6);
        expect(r.seed[2]).toBeCloseTo(-SIDE_NUDGE, 6);
    });

    it('front-side scene nudges +Z', () => {
        const r = resolveCollisionSeed({ sceneIndex: 1, sceneUid: 10, portals: [portalAt([0, 10, 0], 10, 20)], authored: {}, startSeed: [0, 0, 0] });
        expect(r.seed[2]).toBeCloseTo(SIDE_NUDGE, 6);
    });

    it('height-stable: a 6m-tall portal still seeds ~eye height above the bottom edge', () => {
        const r = resolveCollisionSeed({ sceneIndex: 1, sceneUid: 10, portals: [portalAt([0, 10, 0], 10, 20, 6)], authored: {}, startSeed: [0, 0, 0] });
        expect(r.seed[1]).toBeCloseTo(10 - 3 + EYE_HEIGHT, 6);  // bottom edge = 10 - 6/2 = 7
    });
});

const ep = (front: number | null, back: number | null) => ({
    position: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0, 1] as [number, number, number, number],
    width: 2, height: 2, frontUid: front, backUid: back
});

describe('resolvePortalExtras', () => {
    it('returns null when there is no valid bundle (<2 scenes)', () => {
        const r = resolvePortalExtras({
            portals: [ep(10, null)], startUid: 10, availableUids: [10],
            streaming: false, collision: false, authored: {}, startSeed: [0, 0, 0], environments: []
        });
        expect(r).toBeNull();
    });

    it('excludes the primary (index 0); covers indices 1..N in bundle order', () => {
        const r = resolvePortalExtras({
            portals: [ep(10, 20)], startUid: 10, availableUids: [10, 20],
            streaming: false, collision: true, authored: { '20': [5, 6, 7] },
            startSeed: [1, 1, 1], environments: ['indoor', 'outdoor']
        })!;
        expect(r.bundle.sceneUids[0]).toBe(10);
        expect(r.extras).toHaveLength(1);
        const e = r.extras[0];
        expect(e.index).toBe(1);
        expect(e.uid).toBe(20);
        expect(e.environment).toBe('outdoor');                  // environments[1]
        expect(e.collisionUrl).toBe('scenes/1/scene.voxel.json'); // bundle.portalCollision[1]
        expect(e.seed).toEqual([5, 6, 7]);                      // authored entrypoint wins
        expect(e.estimated).toBe(false);
    });

    it('collisionUrl is null for every extra when collision is off', () => {
        const r = resolvePortalExtras({
            portals: [ep(10, 20)], startUid: 10, availableUids: [10, 20],
            streaming: false, collision: false, authored: {}, startSeed: [0, 0, 0], environments: ['indoor', 'indoor']
        })!;
        expect(r.extras[0].collisionUrl).toBeNull();
    });

    it('streaming bundle yields lod-meta scene URLs (sanity: bundle reflects streaming flag)', () => {
        const r = resolvePortalExtras({
            portals: [ep(10, 20)], startUid: 10, availableUids: [10, 20],
            streaming: true, collision: false, authored: {}, startSeed: [0, 0, 0], environments: ['indoor', 'indoor']
        })!;
        expect(r.bundle.portalScenes[1]).toBe('scenes/1/lod-meta.json');
    });

    it('missing environment defaults to indoor', () => {
        const r = resolvePortalExtras({
            portals: [ep(10, 20)], startUid: 10, availableUids: [10, 20],
            streaming: false, collision: false, authored: {}, startSeed: [0, 0, 0], environments: []
        })!;
        expect(r.extras[0].environment).toBe('indoor');
    });
});

describe('collisionSeedTuple', () => {
    it('returns the first camera initial position', () => {
        expect(collisionSeedTuple({ cameras: [{ initial: { position: [1, 2, 3] } }] })).toEqual([1, 2, 3]);
    });

    it('falls back to origin when no camera/position present', () => {
        expect(collisionSeedTuple({})).toEqual([0, 0, 0]);
        expect(collisionSeedTuple({ cameras: [] })).toEqual([0, 0, 0]);
        expect(collisionSeedTuple({ cameras: [{}] })).toEqual([0, 0, 0]);
    });
});
