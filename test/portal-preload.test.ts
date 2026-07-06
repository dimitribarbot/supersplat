import { describe, it, expect } from 'vitest';

import { collectLodFileUrls, lodMinLevelForBudget, collectSogBlockFileUrls, buildPortalAdjacency, desiredResidentScenes, assignPinDepths, computeWarmSet, computeResidentCeiling, selectResidentScenes, sceneResidentToDepth, startSceneLodFloor, shouldSampleDeviceFinest } from '../src/portal-preload';

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
        [1000, 100, 10],   // scene 0 (start; pin-managed like the rest since the engine frees a disabled scene's blocks)
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

    it('degrades the active scene only as a last resort (hard budget cap)', () => {
        // budget below the active cost alone: neighbours first end at coarsest
        // (1110 + 20 + 10 = 1140 > 1000), THEN the active degrades until the
        // total fits (depth 1: 110 + 20 + 10 = 140 <= 1000). Never-OOM outranks
        // instant-return, so the ceiling is a hard cap even for the active scene.
        expect(assignPinDepths(1, [2, 3], counts, 0, 1000)).toEqual({ 1: 1, 2: 2, 3: 2 });
    });

    it('does not degrade the active scene while a neighbour can still degrade', () => {
        // active 1 (1110) + n2 (2220) = 3330 > 1200 -> n2 all the way to coarsest
        // (1110 + 20 = 1130 <= 1200); active untouched
        expect(assignPinDepths(1, [2], counts, 0, 1200)).toEqual({ 1: 0, 2: 2 });
    });

    it('stops at every scene\'s coarsest even when the budget is unreachable', () => {
        expect(assignPinDepths(1, [2], counts, 0, 1)).toEqual({ 1: 2, 2: 2 });
    });

    it('clamps deviceFinest to each scene\'s coarsest and treats null as coarsest', () => {
        expect(assignPinDepths(1, [2], counts, 5, 100000)).toEqual({ 1: 2, 2: 2 });
        expect(assignPinDepths(1, [2], counts, null, 100000)).toEqual({ 1: 2, 2: 2 });
    });

    it('manages scene 0 and de-duplicates the active out of the neighbour list', () => {
        expect(assignPinDepths(0, [1, 0, 1], counts, 0, 100000)).toEqual({ 0: 0, 1: 0 });
    });

    it('degrades scene 0 like any other non-active resident under pressure', () => {
        // active 1 (1110) + n0 (1110) + n2 (2220) = 4440 > 3000
        // -> degrade costliest (scene 2) to depth 1 (220): total 2440 <= 3000
        expect(assignPinDepths(1, [0, 2], counts, 0, 3000)).toEqual({ 0: 0, 1: 0, 2: 1 });
    });

    it('active scene 0 also degrades as a last resort under a hard cap', () => {
        // n1 at coarsest (10) is not enough: active 0 degrades 1110 -> 110 -> 10
        // until the total (20) fits the 100 cap
        expect(assignPinDepths(0, [1], counts, 0, 100)).toEqual({ 0: 2, 1: 2 });
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

describe('computeResidentCeiling', () => {
    // (override, splatBudget, mult, isMobile, totalCost, deviceMemoryGb)
    it('an explicit override always wins', () => {
        expect(computeResidentCeiling(70000000, 4000000, 12, false, 61300000, 8)).toBe(70000000);
        expect(computeResidentCeiling(1000, 4000000, 3, true, 61300000, 8)).toBe(1000);
    });

    it('returns 0 until the engine splat budget is known', () => {
        expect(computeResidentCeiling(0, 0, 12, false, 61300000, 8)).toBe(0);
        expect(computeResidentCeiling(0, -1, 12, false, 61300000, 8)).toBe(0);
    });

    it('mobile: a conservative multiple of the render budget (never project-sized)', () => {
        expect(computeResidentCeiling(0, 2000000, 3, true, 61300000, 8)).toBe(6000000);
    });

    it('desktop: holds the whole project when it fits the RAM-derived cap', () => {
        // real failing project: 4 pyramids totalling 61.3M; 8GB cap = 128M >= 61.3M
        // -> ceiling = the project total, so nothing ever degrades or evicts
        expect(computeResidentCeiling(0, 4000000, 12, false, 61300000, 8)).toBe(61300000);
    });

    it('desktop: caps an oversized project at the RAM-derived limit', () => {
        // 20 huge scenes -> 400M splats; 8GB cap = 128M
        expect(computeResidentCeiling(0, 4000000, 12, false, 400000000, 8)).toBe(128000000);
    });

    it('desktop: never drops below the render-budget floor', () => {
        // tiny project (total below mult x budget) -> keep the floor as headroom
        expect(computeResidentCeiling(0, 4000000, 12, false, 10000000, 8)).toBe(48000000);
        // tiny reported deviceMemory cannot push the ceiling under the floor
        expect(computeResidentCeiling(0, 4000000, 12, false, 61300000, 0.25)).toBe(48000000);
    });

    it('desktop: unknown deviceMemory assumes 8GB', () => {
        expect(computeResidentCeiling(0, 4000000, 12, false, 61300000, undefined as any)).toBe(61300000);
        expect(computeResidentCeiling(0, 4000000, 12, false, 400000000, null as any)).toBe(128000000);
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

describe('selectResidentScenes', () => {
    // linear chain 0-1-2-3-4 ; adjacency[s] = neighbours of s
    const chain = [[1], [0, 2], [1, 3], [2, 4], [3]];
    const cost = (n: number) => Array(n).fill(100);   // every scene costs 100

    it('keeps every reachable scene when the ceiling is ample', () => {
        // active 2, huge ceiling -> ALL scenes resident, including scene 0
        expect(selectResidentScenes(chain, 2, [], cost(5), 100000)).toEqual([0, 1, 2, 3, 4]);
    });

    it('admits only the guaranteed set when the ceiling is tight', () => {
        // active 2: guaranteed = scene 0 + active 2 + neighbours {1,3}, cost 400;
        // ceiling 450 -> scene 4 (dist 2) does not fit
        expect(selectResidentScenes(chain, 2, [], cost(5), 450)).toEqual([0, 1, 2, 3]);
    });

    it('admits the guaranteed set even when it exceeds the ceiling', () => {
        // ceiling smaller than the guaranteed cost -> still keep scene 0 + active + neighbours
        expect(selectResidentScenes(chain, 2, [], cost(5), 10)).toEqual([0, 1, 2, 3]);
    });

    it('prefers a recently-visited scene over an equally-distant unvisited one', () => {
        // active 0: guaranteed = {0, 1}, cost 200. ceiling 300 fits exactly ONE more
        // scene. recencyOrder [3] -> the farther scene 3 (dist 3) wins the slot over
        // the nearer BFS scene 2 (dist 2).
        expect(selectResidentScenes(chain, 0, [3], cost(5), 300)).toEqual([0, 1, 3]);
    });

    it('fills remaining budget by BFS proximity (nearer first)', () => {
        // active 0, no recency: guaranteed {0, 1} (cost 200); ceiling 350 fits exactly
        // one more -> nearest unvisited is 2 (dist 2); 3 (dist 3, cost 400) does not fit.
        expect(selectResidentScenes(chain, 0, [], cost(5), 350)).toEqual([0, 1, 2]);
    });

    it('always includes scene 0 and counts its cost against the ceiling', () => {
        // active 1: guaranteed = {0, 1, 2}, cost 300. ceiling 350: scene 3 (dist 2,
        // cost 100) does NOT fit -- proving scene 0's cost is accounted (were it
        // free, the running cost would be 200 and scene 3 would be admitted).
        expect(selectResidentScenes(chain, 1, [], cost(5), 350)).toEqual([0, 1, 2]);
    });

    it('treats a missing/zero cost as free (admitted)', () => {
        // costs only defined for some scenes; undefined -> free
        expect(selectResidentScenes(chain, 2, [], [0, 0, 0], 1)).toEqual([0, 1, 2, 3, 4]);
    });

    it('with an unknown ceiling (<= 0) keeps only the guaranteed set', () => {
        expect(selectResidentScenes(chain, 2, [4], cost(5), 0)).toEqual([0, 1, 2, 3]);
    });

    it('keeps a real 4-scene desktop project fully resident under the desktop ceiling', () => {
        // Maison_Bueil-scale scenes: LOD pyramid [5.82M, 2.91M, 1.45M, 0.73M] ->
        // resident cost 10 911 585 splats each at deviceFinest 0. Desktop ceiling
        // = 12 x 4M splat budget = 48M >= 4 x 10.9M -> nothing ever evicts.
        const pyramid = 5819512 + 2909756 + 1454878 + 727439;
        const chain4 = [[1], [0, 2], [1, 3], [2]];
        expect(selectResidentScenes(chain4, 0, [], [pyramid, pyramid, pyramid, pyramid], 48000000))
        .toEqual([0, 1, 2, 3]);
    });

    it('returns [] for an out-of-range active scene or missing adjacency', () => {
        expect(selectResidentScenes(chain, 9, [], cost(5), 100000)).toEqual([]);
        expect(selectResidentScenes(null as any, 0, [], [], 100000)).toEqual([]);
    });
});

describe('sceneResidentToDepth', () => {
    // files indexed 0..n; hasResource reports residency by file index
    const files = [
        { lodLevel: 0 }, { lodLevel: 0 },   // finest
        { lodLevel: 1 },                    // mid
        { lodLevel: 2 }, { lodLevel: 2 }    // coarsest
    ];
    const resident = (set: number[]) => (i: number) => set.includes(i);

    it('is true when every file at levels [min .. coarsest] is resident', () => {
        expect(sceneResidentToDepth(files, 3, 1, resident([2, 3, 4]))).toBe(true);
    });

    it('is false while a coarsest-level file is missing', () => {
        expect(sceneResidentToDepth(files, 3, 1, resident([2, 3]))).toBe(false);
    });

    it('is false while an intermediate level above min is missing, even with full coarse coverage', () => {
        // old coarse-only gate would return true here (3,4 resident) -> mixed quality on reveal
        expect(sceneResidentToDepth(files, 3, 1, resident([3, 4]))).toBe(false);
    });

    it('ignores files finer than min', () => {
        // level-0 files absent, min=1 -> still ready
        expect(sceneResidentToDepth(files, 3, 1, resident([2, 3, 4]))).toBe(true);
        // min=0 pulls the finest level into the gate
        expect(sceneResidentToDepth(files, 3, 0, resident([2, 3, 4]))).toBe(false);
        expect(sceneResidentToDepth(files, 3, 0, resident([0, 1, 2, 3, 4]))).toBe(true);
    });

    it('clamps an out-of-range min to the valid level span', () => {
        expect(sceneResidentToDepth(files, 3, -5, resident([0, 1, 2, 3, 4]))).toBe(true);
        expect(sceneResidentToDepth(files, 3, -5, resident([1, 2, 3, 4]))).toBe(false);
        expect(sceneResidentToDepth(files, 3, 99, resident([3, 4]))).toBe(true); // clamped to coarsest-only
    });

    it('skips null file entries', () => {
        const holey = [null, { lodLevel: 2 }] as any;
        expect(sceneResidentToDepth(holey, 3, 2, resident([1]))).toBe(true);
    });

    it('is false when no file sits at or coarser than min (empty gate set)', () => {
        expect(sceneResidentToDepth([{ lodLevel: 0 }], 3, 1, resident([0]))).toBe(false);
        expect(sceneResidentToDepth([], 3, 1, resident([]))).toBe(false);
    });
});

describe('startSceneLodFloor', () => {
    it('clamps when the assigned depth is coarser than the observed device finest', () => {
        // Field case (Redmi Note 9S): depths={"0":3}, deviceFinest=0 -> the
        // engine kept requesting level-0 blocks the device could not hold.
        expect(startSceneLodFloor(3, 0)).toBe(3);
        expect(startSceneLodFloor(2, 1)).toBe(2);
    });

    it('leaves the floor viewer-owned when the assigned depth equals the device finest (desktop)', () => {
        expect(startSceneLodFloor(0, 0)).toBeNull();
        expect(startSceneLodFloor(2, 2)).toBeNull();
    });

    it('leaves the floor viewer-owned when the assigned depth is finer than the device finest', () => {
        expect(startSceneLodFloor(1, 2)).toBeNull();
    });

    it('never clamps before deviceFinest has been observed', () => {
        // The clamp caps what updateDeviceFinest can observe; engaging on the
        // coarse fallback would freeze a degraded value permanently.
        expect(startSceneLodFloor(3, null)).toBeNull();
        expect(startSceneLodFloor(3, undefined)).toBeNull();
    });

    it('never clamps without an assigned depth', () => {
        expect(startSceneLodFloor(null, 0)).toBeNull();
        expect(startSceneLodFloor(undefined, 0)).toBeNull();
    });

    it('treats a negative observed finest as 0', () => {
        expect(startSceneLodFloor(1, -2)).toBe(1);
        expect(startSceneLodFloor(0, -2)).toBeNull();
    });
});

describe('shouldSampleDeviceFinest', () => {
    it('samples every frame during the initial settle window', () => {
        expect(shouldSampleDeviceFinest(0, null, 0, false)).toBe(true);
        expect(shouldSampleDeviceFinest(1, 3, 1, false)).toBe(true);
        expect(shouldSampleDeviceFinest(599, 2, 599, false)).toBe(true);
    });

    it('backs off to every 30th frame after the settle window', () => {
        expect(shouldSampleDeviceFinest(600, 2, 0, false)).toBe(true);   // 600 % 30 === 0
        expect(shouldSampleDeviceFinest(601, 2, 1, false)).toBe(false);
        expect(shouldSampleDeviceFinest(629, 2, 29, false)).toBe(false);
        expect(shouldSampleDeviceFinest(630, 2, 30, false)).toBe(true);
    });

    it('stops permanently once the finest possible level (0) is reached', () => {
        expect(shouldSampleDeviceFinest(10, 0, 0, false)).toBe(false);   // even inside the settle window
        expect(shouldSampleDeviceFinest(900, 0, 500, true)).toBe(false);
    });

    it('stops once stable for 600 frames AND the first pin cycle has consumed it', () => {
        expect(shouldSampleDeviceFinest(1200, 2, 600, true)).toBe(false);
        expect(shouldSampleDeviceFinest(1200, 2, 600, false)).toBe(true);  // pin not consumed -> keep sampling (1200 % 30 === 0)
        expect(shouldSampleDeviceFinest(1200, 2, 599, true)).toBe(true);   // not yet stable long enough
    });

    it('keeps sampling while deviceFinest is still unknown (null)', () => {
        expect(shouldSampleDeviceFinest(1200, null, 600, true)).toBe(true); // 1200 % 30 === 0
        expect(shouldSampleDeviceFinest(1201, null, 601, true)).toBe(false);
    });
});
