import { describe, it, expect } from 'vitest';

import { collectLodFileUrls, lodMinLevelForBudget, collectSogBlockFileUrls, buildPortalAdjacency, desiredResidentScenes, assignPinDepths, computeWarmSet } from '../src/portal-preload';

describe('collectLodFileUrls', () => {
    it('returns the coarsest-level files resolved against the meta directory (no minLevel)', () => {
        const meta = {
            lodLevels: 3,
            filenames: ['d0.bin', 'd1.bin', 'd2.bin'],
            tree: { lods: { '0': { file: 0 }, '1': { file: 1 }, '2': { file: 2 } } }
        };
        expect(collectLodFileUrls(meta, 'scenes/1/lod-meta.json')).toEqual(['scenes/1/d2.bin']);
    });

    it('collects the level range [minLevel .. coarsest] in level order per leaf', () => {
        const meta = {
            lodLevels: 3,
            filenames: ['d0.bin', 'd1.bin', 'd2.bin'],
            tree: { lods: { '0': { file: 0 }, '1': { file: 1 }, '2': { file: 2 } } }
        };
        // minLevel 1 -> levels 1 and 2 (coarsest), finest (0) excluded
        expect(collectLodFileUrls(meta, 'scenes/1/lod-meta.json', 1)).toEqual(['scenes/1/d1.bin', 'scenes/1/d2.bin']);
        // minLevel 0 -> all levels
        expect(collectLodFileUrls(meta, 'scenes/1/lod-meta.json', 0)).toEqual(['scenes/1/d0.bin', 'scenes/1/d1.bin', 'scenes/1/d2.bin']);
    });

    it('clamps an out-of-range minLevel to the valid level span', () => {
        const meta = {
            lodLevels: 2,
            filenames: ['a.bin', 'b.bin'],
            tree: { lods: { '0': { file: 0 }, '1': { file: 1 } } }
        };
        expect(collectLodFileUrls(meta, 'm.json', -5)).toEqual(['a.bin', 'b.bin']); // clamped to 0 -> all
        expect(collectLodFileUrls(meta, 'm.json', 9)).toEqual(['b.bin']);            // clamped to coarsest
    });

    it('walks branch nodes and de-duplicates shared coarse files', () => {
        const meta = {
            lodLevels: 2,
            filenames: ['fine.bin', 'coarse.bin'],
            tree: {
                children: [
                    { lods: { '0': { file: 0 }, '1': { file: 1 } } },
                    { lods: { '1': { file: 1 } } },                  // shares coarse file 1
                    { children: [{ lods: { '0': { file: 0 } } }] }   // no coarse level -> ignored
                ]
            }
        };
        expect(collectLodFileUrls(meta, 'scenes/2/lod-meta.json')).toEqual(['scenes/2/coarse.bin']);
    });

    it('ignores finer levels by default (only collects lodLevels-1)', () => {
        const meta = {
            lodLevels: 2,
            filenames: ['a.bin', 'b.bin'],
            tree: { lods: { '0': { file: 0 } } }                     // only finest present
        };
        expect(collectLodFileUrls(meta, 'scenes/1/lod-meta.json')).toEqual([]);
    });

    it('leaves absolute and root-relative URLs unchanged', () => {
        const meta = {
            lodLevels: 1,
            filenames: ['https://cdn.example.com/x.bin', '/abs/y.bin'],
            tree: { children: [{ lods: { '0': { file: 0 } } }, { lods: { '0': { file: 1 } } }] }
        };
        expect(collectLodFileUrls(meta, 'scenes/1/lod-meta.json'))
            .toEqual(['https://cdn.example.com/x.bin', '/abs/y.bin']);
    });

    it('handles a meta URL with no directory', () => {
        const meta = { lodLevels: 1, filenames: ['c.bin'], tree: { lods: { '0': { file: 0 } } } };
        expect(collectLodFileUrls(meta, 'lod-meta.json')).toEqual(['c.bin']);
    });

    it('returns [] defensively for empty/malformed metas', () => {
        expect(collectLodFileUrls({} as any, 'scenes/1/lod-meta.json')).toEqual([]);
        expect(collectLodFileUrls({ lodLevels: 2, filenames: [] } as any, 'm.json')).toEqual([]);
        expect(collectLodFileUrls({ lodLevels: 2, filenames: ['a'], tree: {} } as any, 'm.json')).toEqual([]);
    });
});

describe('lodMinLevelForBudget', () => {
    // counts ordered finest (index 0, largest) -> coarsest (last, smallest)
    const counts = [1000000, 250000, 60000, 16000];   // levels 0..3, level 3 = coarsest

    it('returns the coarsest level when the budget is unknown', () => {
        expect(lodMinLevelForBudget(counts, 0)).toBe(3);
        expect(lodMinLevelForBudget(counts, -1)).toBe(3);
    });

    it('includes each next-finer level whose own count fits the budget', () => {
        expect(lodMinLevelForBudget(counts, 16000)).toBe(3);   // only coarsest fits
        expect(lodMinLevelForBudget(counts, 60000)).toBe(2);   // levels 2,3 fit
        expect(lodMinLevelForBudget(counts, 250000)).toBe(1);  // levels 1,2,3 fit
        expect(lodMinLevelForBudget(counts, 2000000)).toBe(0); // all levels fit
    });

    it('stops at the first level too big to display in full (non-contiguous gaps ignored)', () => {
        // budget between level 2 and level 1 counts -> stop after level 2
        expect(lodMinLevelForBudget(counts, 100000)).toBe(2);
    });

    it('always includes the coarsest level even if it exceeds the budget', () => {
        expect(lodMinLevelForBudget(counts, 1)).toBe(3);
    });

    it('handles a single-level scene', () => {
        expect(lodMinLevelForBudget([42], 1000)).toBe(0);
        expect(lodMinLevelForBudget([42], 0)).toBe(0);
    });
});

describe('collectSogBlockFileUrls', () => {
    it('collects all webp files across sections, resolved against the block dir', () => {
        const meta = {
            means: { files: ['means_l.webp', 'means_u.webp'] },
            scales: { files: ['scales.webp'] },
            quats: { files: ['quats.webp'] },
            sh0: { files: ['sh0.webp'] }
        };
        expect(collectSogBlockFileUrls(meta, 'scenes/1/3_0/meta.json')).toEqual([
            'scenes/1/3_0/means_l.webp',
            'scenes/1/3_0/means_u.webp',
            'scenes/1/3_0/scales.webp',
            'scenes/1/3_0/quats.webp',
            'scenes/1/3_0/sh0.webp'
        ]);
    });

    it('includes shN files when present', () => {
        const meta = {
            means: { files: ['means_l.webp', 'means_u.webp'] },
            sh0: { files: ['sh0.webp'] },
            shN: { files: ['shN_centroids.webp', 'shN_labels.webp'] }
        };
        expect(collectSogBlockFileUrls(meta, 'scenes/2/0_0/meta.json')).toEqual([
            'scenes/2/0_0/means_l.webp',
            'scenes/2/0_0/means_u.webp',
            'scenes/2/0_0/sh0.webp',
            'scenes/2/0_0/shN_centroids.webp',
            'scenes/2/0_0/shN_labels.webp'
        ]);
    });

    it('de-duplicates a filename referenced more than once', () => {
        const meta = {
            means: { files: ['x.webp'] },
            scales: { files: ['x.webp'] }
        };
        expect(collectSogBlockFileUrls(meta, '3_0/meta.json')).toEqual(['3_0/x.webp']);
    });

    it('leaves absolute and root-relative URLs unchanged', () => {
        const meta = {
            means: { files: ['https://cdn.example.com/means_l.webp', '/abs/means_u.webp'] }
        };
        expect(collectSogBlockFileUrls(meta, 'scenes/1/3_0/meta.json')).toEqual([
            'https://cdn.example.com/means_l.webp',
            '/abs/means_u.webp'
        ]);
    });

    it('handles a block meta URL with no directory', () => {
        const meta = { sh0: { files: ['sh0.webp'] } };
        expect(collectSogBlockFileUrls(meta, 'meta.json')).toEqual(['sh0.webp']);
    });

    it('returns [] defensively for empty/malformed block metas', () => {
        expect(collectSogBlockFileUrls(null as any, 'scenes/1/3_0/meta.json')).toEqual([]);
        expect(collectSogBlockFileUrls({} as any, 'scenes/1/3_0/meta.json')).toEqual([]);
        expect(collectSogBlockFileUrls({ means: {} } as any, 'm.json')).toEqual([]);
    });
});

describe('buildPortalAdjacency', () => {
    it('links the front/back scenes of each portal, both directions', () => {
        const portals = [{ front: 0, back: 1 }, { front: 1, back: 2 }];
        expect(buildPortalAdjacency(portals, 3)).toEqual([[1], [0, 2], [1]]);
    });

    it('de-duplicates multiple portals between the same pair and sorts', () => {
        const portals = [{ front: 2, back: 0 }, { front: 0, back: 2 }, { front: 0, back: 1 }];
        expect(buildPortalAdjacency(portals, 3)).toEqual([[1, 2], [0], [0]]);
    });

    it('ignores out-of-range and self-referential portals', () => {
        const portals = [{ front: 0, back: 5 }, { front: 1, back: 1 }, { front: 0, back: 1 }];
        expect(buildPortalAdjacency(portals, 2)).toEqual([[1], [0]]);
    });

    it('returns empty adjacency lists when there are no portals', () => {
        expect(buildPortalAdjacency([], 3)).toEqual([[], [], []]);
    });
});

describe('desiredResidentScenes', () => {
    const adjacency = [[1], [0, 2], [1, 3], [2]];

    it('includes the active extra scene and its neighbours, excluding scene 0', () => {
        // active = 1: {1} ∪ {0,2} = {0,1,2} → drop 0 → [1, 2]
        expect(desiredResidentScenes(adjacency, 1)).toEqual([1, 2]);
    });

    it('at the start scene returns only its extra neighbours', () => {
        // active = 0: {0} ∪ {1} = {0,1} → drop 0 → [1]
        expect(desiredResidentScenes(adjacency, 0)).toEqual([1]);
    });

    it('sorts and de-duplicates', () => {
        // active = 2: {2} ∪ {1,3} → [1, 2, 3]
        expect(desiredResidentScenes(adjacency, 2)).toEqual([1, 2, 3]);
    });

    it('returns empty for an out-of-range active scene', () => {
        expect(desiredResidentScenes(adjacency, 9)).toEqual([]);
    });
});

describe('assignPinDepths', () => {
    // counts finest -> coarsest; pin cost at depth d = sum of counts[d..]
    const counts = [
        [1000, 100, 10],   // scene 0 (start, never pin-managed)
        [1000, 100, 10],   // scene 1: cost 1110 / 110 / 10 at depths 0/1/2
        [2000, 200, 20],   // scene 2: cost 2220 / 220 / 20
        [1000, 100, 10]    // scene 3: cost 1110 / 110 / 10
    ];

    it('keeps everything at deviceFinest when the total fits the budget', () => {
        // active 1 (1110) + neighbour 2 (2220) = 3330 <= 4000
        expect(assignPinDepths(1, [2], counts, 0, 4000)).toEqual({ 1: 0, 2: 0 });
    });

    it('degrades the costliest neighbour first, one level at a time', () => {
        // active 1 (1110) + n2 (2220) + n3 (1110) = 4440 > 3000
        // -> degrade scene 2 to depth 1 (220): total 2440 <= 3000
        expect(assignPinDepths(1, [2, 3], counts, 0, 3000)).toEqual({ 1: 0, 2: 1, 3: 0 });
    });

    it('never degrades the active scene, even when the budget cannot be met', () => {
        // budget below the active cost alone: neighbours end at coarsest, active untouched
        expect(assignPinDepths(1, [2, 3], counts, 0, 1000)).toEqual({ 1: 0, 2: 2, 3: 2 });
    });

    it('stops degrading at each scene\'s coarsest level', () => {
        const d = assignPinDepths(1, [2], counts, 0, 1);
        expect(d[2]).toBe(2);
        expect(d[1]).toBe(0);
    });

    it('clamps deviceFinest to each scene\'s coarsest and treats null as coarsest', () => {
        expect(assignPinDepths(1, [2], counts, 5, 100000)).toEqual({ 1: 2, 2: 2 });
        expect(assignPinDepths(1, [2], counts, null, 100000)).toEqual({ 1: 2, 2: 2 });
    });

    it('excludes scene 0 and de-duplicates the active out of the neighbour list', () => {
        expect(assignPinDepths(0, [1, 0, 1], counts, 0, 100000)).toEqual({ 1: 0 });
    });

    it('unknown budget (<= 0): neighbours at coarsest, active at base depth', () => {
        expect(assignPinDepths(1, [2], counts, 0, 0)).toEqual({ 1: 0, 2: 2 });
        expect(assignPinDepths(1, [2], counts, 0, -1)).toEqual({ 1: 0, 2: 2 });
    });

    it('scenes with missing counts get the base depth and zero cost', () => {
        // empty counts -> coarsest = 0 -> base depth 0; cost 0 so budget never trips
        expect(assignPinDepths(1, [2], [[], [], []], 1, 10)).toEqual({ 1: 0, 2: 0 });
    });
});

describe('computeWarmSet', () => {
    // linear chain 0-1-2-3-4
    const chain = [[1], [0, 2], [1, 3], [2, 4], [3]];

    it('returns the scenes at graph distance 2 from the active scene', () => {
        // active 0, pinned {1}: neighbours of {0,1} = {0,1,2} minus frontier -> [2]
        expect(computeWarmSet(0, chain, [1])).toEqual([2]);
        // active 1, pinned {1,2}: neighbours of {1,2} ∪ {1} = {0,1,2,3} minus frontier, minus 0 -> [3]
        expect(computeWarmSet(1, chain, [1, 2])).toEqual([3]);
    });

    it('excludes scene 0 even when it sits at distance 2', () => {
        // active 2, pinned {1,2,3}: 0 is a neighbour of 1 but is always resident
        const warm = computeWarmSet(2, chain, [1, 2, 3]);
        expect(warm).toEqual([4]);
        expect(warm).not.toContain(0);
    });

    it('returns empty when everything reachable is already pinned', () => {
        expect(computeWarmSet(1, [[1], [0]], [1])).toEqual([]);
    });

    it('handles a hub topology (multiple distance-2 scenes, sorted)', () => {
        // scene 1 connects to 2, 3, 4; active 2, pinned {1,2}
        const star = [[], [2, 3, 4], [1], [1], [1]];
        expect(computeWarmSet(2, star, [1, 2])).toEqual([3, 4]);
    });

    it('returns empty for an out-of-range active scene or missing adjacency', () => {
        expect(computeWarmSet(9, chain, [])).toEqual([]);
        expect(computeWarmSet(0, null as any, [])).toEqual([]);
    });
});
