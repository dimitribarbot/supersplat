// Minimal subset of a streaming `lod-meta.json` that the preloader needs to
// find the files holding the coarsest LOD level. Mirrors the structure parsed
// by the engine's GSplatOctree: a `filenames` array plus a hierarchical `tree`
// whose leaf nodes carry a per-LOD `lods` map keyed by stringified level index
// ("0" = finest .. "lodLevels-1" = coarsest), each entry referencing a file by
// its index into `filenames`.
type PortalLodNode = {
    lods?: Record<string, { file: number }>;
    children?: PortalLodNode[];
};

type PortalLodMeta = {
    lodLevels?: number;
    filenames?: string[];
    tree?: PortalLodNode;
};

// Choose the finest (lowest-index) LOD level worth preloading for a given device
// splat budget. `counts[i]` is level i's whole-scene splat count, ordered finest
// (index 0, largest) to coarsest (last index, smallest) — matching the viewer's
// portalSceneLodCounts. We always preload the coarsest level, then include each
// next-finer level whose own count still fits the budget, stopping at the first
// level too big to ever be displayed in full. Returns the minimum level index to
// preload (inclusive); levels [minLevel .. counts.length-1] should be warmed.
// Returns the coarsest level when the budget is unknown (<= 0). `counts` must be
// non-empty (callers fall back to coarsest-only when it is absent). Pure and
// self-contained for stringification into the runtime.
const lodMinLevelForBudget = (counts: number[], budget: number): number => {
    const maxLevel = counts.length - 1;          // coarsest
    if (maxLevel < 0) {
        return 0;
    }
    if (!budget || budget <= 0) {
        return maxLevel;                         // unknown budget -> coarsest only
    }
    let minLevel = maxLevel;                      // always include the coarsest level
    for (let lv = maxLevel - 1; lv >= 0; lv--) {  // walk toward finer (counts increase)
        if (counts[lv] <= budget) {
            minLevel = lv;
        } else {
            break;                               // too big to fully display -> stop
        }
    }
    return minLevel;
};

// Collect the URLs of the per-block files making up LOD levels
// [minLevel .. lodLevels-1] of a streaming scene (level lodLevels-1 = coarsest,
// the level the viewer reveals first), resolved relative to the scene's
// `lod-meta.json` URL, de-duplicated in first-seen order. When `minLevel` is
// omitted only the coarsest level is collected. Pure and self-contained (no
// imports, no sibling-function calls) so it can be stringified verbatim into the
// exported viewer runtime via Function.toString() — see the note in portals.ts.
const collectLodFileUrls = (meta: PortalLodMeta, metaUrl: string, minLevel?: number): string[] => {
    if (!meta || !meta.tree || !meta.filenames || !meta.lodLevels) {
        return [];
    }
    const maxLevel = meta.lodLevels - 1;
    let lo = (typeof minLevel === 'number') ? minLevel : maxLevel;
    if (lo < 0) {
        lo = 0;
    }
    if (lo > maxLevel) {
        lo = maxLevel;
    }

    // Resolve a (possibly relative) filename against the meta's directory.
    // Absolute URLs (http(s):// or a leading '/') are returned unchanged.
    const resolve = (filename: string): string => {
        if (/^https?:\/\//i.test(filename) || filename.charAt(0) === '/') {
            return filename;
        }
        const slash = metaUrl.lastIndexOf('/');
        const dir = slash >= 0 ? metaUrl.slice(0, slash + 1) : '';
        return dir + filename;
    };

    // Iteratively walk the tree (avoids recursion depth limits). Every leaf
    // contributes the file index of each LOD level in [lo .. maxLevel].
    const indices = new Set<number>();
    const stack: PortalLodNode[] = [meta.tree];
    while (stack.length) {
        const node = stack.shift();
        if (!node) {
            continue;
        }
        if (node.lods) {
            for (let lv = lo; lv <= maxLevel; lv++) {
                const lod = node.lods[String(lv)];
                if (lod && typeof lod.file === 'number') {
                    indices.add(lod.file);
                }
            }
        }
        if (node.children) {
            for (let i = 0; i < node.children.length; i++) {
                stack.push(node.children[i]);
            }
        }
    }

    const urls: string[] = [];
    indices.forEach((idx) => {
        const fn = meta.filenames[idx];
        if (fn) {
            urls.push(resolve(fn));
        }
    });
    return urls;
};

// Minimal subset of a streaming SOG block `meta.json` (the file each coarse
// entry of `collectCoarseFileUrls` points at). Each block bundles its gaussian
// data as webp textures listed under the means/scales/quats/sh0/shN keys, each
// of which carries a `files` array of webp filenames relative to the block dir.
// Mirrors the keys the engine's SOG parser reads.
type PortalSogBlockMeta = {
    means?: { files?: string[] };
    scales?: { files?: string[] };
    quats?: { files?: string[] };
    sh0?: { files?: string[] };
    shN?: { files?: string[] };
};

// Collect the URLs of the webp texture files referenced by one streaming SOG
// block `meta.json`, resolved relative to that block meta's URL, de-duplicated
// in first-seen order. This is the heavy gaussian data a coarse block holds; a
// plain fetch of the block `meta.json` alone would not pull it. Pure and
// self-contained (no imports, no sibling-function calls) so it can be
// stringified verbatim into the exported viewer runtime via Function.toString().
const collectSogBlockFileUrls = (blockMeta: PortalSogBlockMeta, blockMetaUrl: string): string[] => {
    if (!blockMeta) {
        return [];
    }

    // Resolve a (possibly relative) filename against the block meta's directory.
    // Absolute URLs (http(s):// or a leading '/') are returned unchanged.
    const resolve = (filename: string): string => {
        if (/^https?:\/\//i.test(filename) || filename.charAt(0) === '/') {
            return filename;
        }
        const slash = blockMetaUrl.lastIndexOf('/');
        const dir = slash >= 0 ? blockMetaUrl.slice(0, slash + 1) : '';
        return dir + filename;
    };

    const keys = ['means', 'scales', 'quats', 'sh0', 'shN'];
    const seen: Record<string, boolean> = {};
    const urls: string[] = [];
    for (let i = 0; i < keys.length; i++) {
        const section = (blockMeta as any)[keys[i]];
        const files = section && section.files;
        if (files) {
            for (let j = 0; j < files.length; j++) {
                const fn = files[j];
                if (fn && !seen[fn]) {
                    seen[fn] = true;
                    urls.push(resolve(fn));
                }
            }
        }
    }
    return urls;
};

// Build per-scene portal adjacency. portals[i].front/back are scene indices
// (the export rewrites editor scene-uids to indices). adjacency[s] is the sorted,
// de-duplicated list of scenes sharing at least one portal with s. Portals whose
// endpoints are out of [0, sceneCount) or identical are ignored. Pure and
// self-contained (no imports, no sibling-function calls) so it can be stringified
// verbatim into the exported viewer runtime via Function.toString().
const buildPortalAdjacency = (portals: { front: number; back: number }[], sceneCount: number): number[][] => {
    const sets: Record<number, Record<number, boolean>> = {};
    for (let s = 0; s < sceneCount; s++) {
        sets[s] = {};
    }
    for (let i = 0; i < (portals || []).length; i++) {
        const a = portals[i].front;
        const b = portals[i].back;
        if (typeof a !== 'number' || typeof b !== 'number') {
            continue;
        }
        if (a < 0 || b < 0 || a >= sceneCount || b >= sceneCount || a === b) {
            continue;
        }
        sets[a][b] = true;
        sets[b][a] = true;
    }
    const adjacency: number[][] = [];
    for (let s = 0; s < sceneCount; s++) {
        const neighbours: number[] = [];
        for (const k in sets[s]) {
            neighbours.push(Number(k));
        }
        neighbours.sort((x, y) => x - y);
        adjacency.push(neighbours);
    }
    return adjacency;
};

// Extra scenes (index >= 1) that should be kept resident given the active scene:
// the active scene plus its portal neighbours, excluding scene 0 (the viewer's
// always-resident start scene, which is not pin-managed). Sorted, de-duplicated.
// Pure and self-contained (stringified into the runtime).
const desiredResidentScenes = (adjacency: number[][], active: number): number[] => {
    if (!adjacency || active < 0 || active >= adjacency.length) {
        return [];
    }
    const want: Record<number, boolean> = {};
    if (active >= 1) {
        want[active] = true;
    }
    const neighbours = adjacency[active] || [];
    for (let i = 0; i < neighbours.length; i++) {
        if (neighbours[i] >= 1) {
            want[neighbours[i]] = true;
        }
    }
    const out: number[] = [];
    for (const k in want) {
        out.push(Number(k));
    }
    out.sort((x, y) => x - y);
    return out;
};

// Assign a pin depth (minimum LOD level to keep resident) to each frontier scene
// so the TOTAL pinned splat count stays within the device budget.
// sceneLodCounts[s][lv] is scene s's whole-scene splat count at level lv
// (0 = finest .. last = coarsest); pinning scene s at depth d keeps levels
// [d .. coarsest] resident, costing sum(counts[s][d..]) splats. The active scene
// starts at the base depth (deviceFinest clamped to its own coarsest);
// neighbours degrade one level at a time -- costliest first, ties to the
// earliest neighbour -- until the total fits or all sit at their coarsest.
// If the total STILL exceeds the budget, the active scene itself degrades as a
// last resort (never-OOM outranks instant-return): the budget is a hard cap,
// bottoming out only when every scene sits at its coarsest.
// deviceFinest null (not yet observed) -> each scene's coarsest. budget <= 0
// (unknown) -> neighbours at coarsest, active at base. Missing/empty counts ->
// base depth, cost 0 (unmeasurable; the runtime clamps to the real octree span).
// Scene 0 (the start scene) is managed like any other scene: the engine frees a
// disabled scene's blocks (instance destroy decRefCounts them), so scene 0 is
// NOT inherently resident and must be pinned and budgeted too. Pure and
// self-contained (no imports, no sibling-function calls) so it can be
// stringified verbatim into the exported viewer runtime via Function.toString().
const assignPinDepths = (
    activeIdx: number,
    neighborIdxs: number[],
    sceneLodCounts: number[][],
    deviceFinest: number | null,
    budget: number
): Record<number, number> => {
    const coarsest = (s: number): number => {
        const c = sceneLodCounts && sceneLodCounts[s];
        return (c && c.length) ? c.length - 1 : 0;
    };
    const baseDepth = (s: number): number => {
        const max = coarsest(s);
        if (deviceFinest === null || deviceFinest === undefined) {
            return max;
        }
        return Math.min(Math.max(deviceFinest, 0), max);
    };
    const cost = (s: number, d: number): number => {
        const c = sceneLodCounts && sceneLodCounts[s];
        if (!c || !c.length) {
            return 0;
        }
        let sum = 0;
        for (let lv = d; lv < c.length; lv++) {
            sum += (c[lv] || 0);
        }
        return sum;
    };
    const hasBudget = typeof budget === 'number' && budget > 0;
    const depths: Record<number, number> = {};
    const neighbours: number[] = [];
    if (activeIdx >= 0) {
        depths[activeIdx] = baseDepth(activeIdx);
    }
    for (let i = 0; i < (neighborIdxs || []).length; i++) {
        const n = neighborIdxs[i];
        if (n >= 0 && n !== activeIdx && depths[n] === undefined) {
            depths[n] = hasBudget ? baseDepth(n) : coarsest(n);
            neighbours.push(n);
        }
    }
    if (!hasBudget) {
        return depths;
    }
    const total = (): number => {
        let t = 0;
        for (const k in depths) {
            const s = Number(k);
            t += cost(s, depths[s]);
        }
        return t;
    };
    while (total() > budget) {
        let pick = -1;
        let pickCost = -1;
        for (let i = 0; i < neighbours.length; i++) {
            const n = neighbours[i];
            if (depths[n] >= coarsest(n)) {
                continue;                    // already at its coarsest
            }
            const c = cost(n, depths[n]);
            if (c > pickCost) {
                pickCost = c;
                pick = n;
            }
        }
        if (pick < 0) {
            break;                           // no neighbour left to degrade
        }
        depths[pick] += 1;
    }
    // Last resort: every neighbour sits at its coarsest but the total still
    // exceeds the budget -> degrade the active scene too (hard cap).
    if (activeIdx >= 0 && depths[activeIdx] !== undefined) {
        while (depths[activeIdx] < coarsest(activeIdx) && total() > budget) {
            depths[activeIdx] += 1;
        }
    }
    return depths;
};

// Total resident-splat ceiling for the viewer. Priority:
//   1. an explicit override (?residentBudget=) always wins;
//   2. 0 (defer) until the engine splat budget is known;
//   3. mobile: a conservative multiple of the render budget -- never-OOM
//      outranks instant crossings on phones;
//   4. desktop: hold the WHOLE project resident (totalCost = sum of every
//      scene's pyramid cost at deviceFinest) when it fits a RAM-derived cap,
//      so any project that fits memory never degrades or evicts. A fixed
//      multiple of the RENDER budget cannot anticipate project size (a single
//      scene's resident pyramid can exceed several render budgets), which is
//      why totalCost drives the ceiling. The cap scales with
//      navigator.deviceMemory (GB, Chrome-only, quantized <= 8; assume 8 when
//      absent) at 16M resident splats per GB (~20-25 bytes of GPU textures
//      per splat -> 8GB caps at 128M splats ~= 2.5-3GB). Never below the
//      render-budget floor (mult x budget) so small projects keep headroom.
// Pure and self-contained (no imports, no sibling-function calls) so it can be
// stringified verbatim into the exported viewer runtime via Function.toString().
const computeResidentCeiling = (
    override: number,
    splatBudget: number,
    mult: number,
    isMobile: boolean,
    totalCost: number,
    deviceMemoryGb: number
): number => {
    if (override > 0) {
        return override;
    }
    if (!splatBudget || splatBudget <= 0) {
        return 0;
    }
    const floor = splatBudget * mult;
    if (isMobile) {
        return floor;
    }
    const gb = (typeof deviceMemoryGb === 'number' && deviceMemoryGb > 0) ? deviceMemoryGb : 8;
    const cap = gb * 16000000;
    const want = Math.min((typeof totalCost === 'number' && totalCost > 0) ? totalCost : 0, cap);
    return Math.max(floor, want);
};

// Scenes at graph distance 2 from the active scene: neighbours of the pinned
// frontier ({active} ∪ pinnedSet) that are not themselves in it. These are the
// ones worth HTTP-cache warming -- distance <= 1 is pinned resident (instant
// crossing) and a distance-2 scene becomes pinned after ONE more crossing, so a
// warm cache makes that future pin fetch fast. Scene 0 (the viewer's own
// always-resident start scene) is excluded. Sorted, de-duplicated. Pure and
// self-contained (no imports, no sibling-function calls) so it can be
// stringified verbatim into the exported viewer runtime via Function.toString().
const computeWarmSet = (activeIdx: number, adjacency: number[][], pinnedSet: number[]): number[] => {
    if (!adjacency || activeIdx < 0 || activeIdx >= adjacency.length) {
        return [];
    }
    const inFrontier: Record<number, boolean> = {};
    inFrontier[activeIdx] = true;
    for (let i = 0; i < (pinnedSet || []).length; i++) {
        inFrontier[pinnedSet[i]] = true;
    }
    const warm: Record<number, boolean> = {};
    for (const k in inFrontier) {
        const neighbours = adjacency[Number(k)] || [];
        for (let i = 0; i < neighbours.length; i++) {
            const n = neighbours[i];
            if (n >= 1 && !inFrontier[n]) {
                warm[n] = true;
            }
        }
    }
    const out: number[] = [];
    for (const k in warm) {
        out.push(Number(k));
    }
    out.sort((x, y) => x - y);
    return out;
};

// Choose which scenes to keep resident, in priority order, until the summed
// per-scene cost would exceed `ceiling`:
//   1. guaranteed: scene 0 (the reset/spawn target) + the active scene + its
//      immediate portal neighbours (admitted even past the ceiling -- an
//      immediate crossing must land on a resident scene);
//   2. recently-visited scenes, most-recent first (recencyOrder);
//   3. remaining scenes by BFS graph distance from active (nearer first, then index).
// A candidate after the guaranteed set is admitted only if its cost still fits.
// sceneCosts[i] is scene i's resident cost in splats (streaming: whole-scene count
// at deviceFinest; SOG: full count). A missing / <= 0 cost is treated as free.
// When ceiling <= 0 (budget not yet known) only the guaranteed set is admitted.
// Scene 0 is included and its cost counted: the engine frees a disabled scene's
// blocks, so the start scene is NOT inherently resident -- it must be pinned and
// budgeted like the rest (it is guaranteed, so it is never evicted).
// Sorted, de-duplicated. Pure and self-contained (no imports, no sibling calls)
// so it can be stringified verbatim into the exported viewer runtime.
const selectResidentScenes = (
    adjacency: number[][],
    activeIdx: number,
    recencyOrder: number[],
    sceneCosts: number[],
    ceiling: number
): number[] => {
    if (!adjacency || activeIdx < 0 || activeIdx >= adjacency.length) {
        return [];
    }
    const admitted: Record<number, boolean> = {};
    let cost = 0;
    const costOf = (i: number): number => {
        const c = sceneCosts && sceneCosts[i];
        return (typeof c === 'number' && c > 0) ? c : 0;
    };
    const admit = (i: number, forced: boolean): void => {
        if (i < 0 || admitted[i]) {
            return;
        }
        const c = costOf(i);
        if (!forced && (ceiling <= 0 || cost + c > ceiling)) {
            return;
        }
        admitted[i] = true;
        cost += c;
    };
    // 1. guaranteed: scene 0 (reset target) + active + immediate neighbours
    admit(0, true);
    admit(activeIdx, true);
    const neighbours = adjacency[activeIdx] || [];
    for (let i = 0; i < neighbours.length; i++) {
        admit(neighbours[i], true);
    }
    // 2. recently-visited (most-recent first)
    for (let i = 0; i < (recencyOrder || []).length; i++) {
        admit(recencyOrder[i], false);
    }
    // 3. remaining by BFS distance from active (nearer first, index tiebreak)
    const seen: Record<number, boolean> = {};
    seen[activeIdx] = true;
    let frontier: number[] = [activeIdx];
    while (frontier.length) {
        const next: number[] = [];
        for (let f = 0; f < frontier.length; f++) {
            const nb = (adjacency[frontier[f]] || []).slice().sort((a, b) => a - b);
            for (let j = 0; j < nb.length; j++) {
                const n = nb[j];
                if (!seen[n]) {
                    seen[n] = true;
                    admit(n, false);
                    next.push(n);
                }
            }
        }
        frontier = next;
    }
    const out: number[] = [];
    for (const k in admitted) {
        out.push(Number(k));
    }
    out.sort((x, y) => x - y);
    return out;
};

// True when EVERY octree file at LOD levels [minLevel .. coarsest] has a
// resident (decoded) resource -- the crossed-into scene is showable at its
// pin/reveal depth everywhere, with nothing left for the engine to refine on
// this device (revealing earlier shows mixed-quality regions). minLevel is
// clamped to the octree's real level span. False when no file sits in the
// gated range (unknown/drifted octree shape -- the caller's frame cap then
// bounds the overlay). Pure and self-contained (no imports, no sibling calls)
// so it can be stringified verbatim into the exported viewer runtime.
const sceneResidentToDepth = (
    files: ({ lodLevel: number } | null)[],
    lodLevels: number,
    minLevel: number,
    hasResource: (fileIndex: number) => boolean
): boolean => {
    if (!files || !lodLevels) {
        return false;
    }
    const min = Math.min(Math.max(minLevel, 0), lodLevels - 1);
    let seen = false;
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (f && f.lodLevel >= min) {
            seen = true;
            if (!hasResource(i)) {
                return false;
            }
        }
    }
    return seen;
};

// Scene 0 (the start scene)'s lodRange floor is viewer-owned: the stock
// viewer's applyPerfSettings opens it to lodRangeMin = 0 once ready, so the
// engine's per-view refine may show finer-than-pin near detail on devices
// that can decode it. EXCEPT when the resident budget has degraded scene 0's
// assigned pin depth below the device's OBSERVED finest level: the engine
// then endlessly requests finest-level blocks the device cannot hold (field
// case: net::ERR_FAILED-with-200 churn on scene-0 level-0 webps under mobile
// memory pressure) for splats that can never be shown on that device.
// Returns the lodRangeMin floor to clamp the start component to, or null to
// leave the floor viewer-owned. deviceFinest null/undefined (not yet
// observed -- SOG export, or the settle timeout) -> never clamp: the clamp
// caps what updateDeviceFinest can ever observe, so it must only engage
// after the running-min has settled. Pure and self-contained (no imports,
// no sibling-function calls, no backslash escapes) so it can be stringified
// verbatim into the exported viewer runtime via Function.toString().
const startSceneLodFloor = (
    assignedDepth: number | null | undefined,
    deviceFinest: number | null | undefined
): number | null => {
    if (deviceFinest === null || deviceFinest === undefined) {
        return null;
    }
    if (typeof assignedDepth !== 'number') {
        return null;
    }
    return (assignedDepth > Math.max(deviceFinest, 0)) ? assignedDepth : null;
};

// Decide whether a pin pump may fetch one LOD-level batch right now, under the
// active-scene-first priority policy (levels: 0 = finest .. coarsest):
//   - the active scene's own batches always flow;
//   - while the active scene is not revealed (startup: the viewer's progress
//     bar is up and the user cannot move), every non-active batch holds;
//   - once revealed, non-active batches STRICTLY COARSER than the active
//     scene's pin depth flow (the cheap instant-crossing floor), while batches
//     at or finer than that depth hold until the active scene is fully
//     resident at its pin depth (activeAtDepth);
//   - once the active scene is at depth, everything flows (today's behavior).
// activePinDepth null/undefined (active not yet reconciled) falls back to
// deviceFinest (what the reconcile will assign it); when that too is unknown,
// only the probed scene's coarsest level flows (sceneCoarsest). Pure and
// self-contained (no imports, no sibling-function calls, no backslash escapes)
// so it can be stringified verbatim into the exported viewer runtime via
// Function.toString().
const pinBatchAllowed = (
    batchLevel: number,
    sceneIdx: number,
    activeIdx: number,
    activePinDepth: number | null | undefined,
    deviceFinest: number | null | undefined,
    sceneCoarsest: number,
    revealed: boolean,
    activeAtDepth: boolean
): boolean => {
    if (sceneIdx === activeIdx) {
        return true;
    }
    if (!revealed) {
        return false;
    }
    if (activeAtDepth) {
        return true;
    }
    const threshold = (typeof activePinDepth === 'number') ? activePinDepth :
        ((typeof deviceFinest === 'number') ? deviceFinest : null);
    if (threshold === null) {
        return batchLevel >= sceneCoarsest;
    }
    return batchLevel > threshold;
};

// Sampling cadence for the runtime's deviceFinest observation (the running-min
// finest LOD level the engine has made resident for the start scene). Scanning
// the octree is O(files) per call, so unconditional per-frame sampling is a
// steady battery/CPU drain on mobile. Cadence: sample every frame for an
// initial 600-frame settle window (~10s at 60fps, matching the runtime's other
// settle caps) while the start scene streams its near detail in; then back off
// to every 30th frame (~0.5s -- a late ratchet is still caught quickly at 1/30
// the cost); stop permanently once finest reaches 0 (the engine's finest level:
// a running-min cannot improve) or once it has been stable for 600 consecutive
// frames AND the first pin cycle has consumed it (pinConsumed).
// EXCEPTION (floorBelowFinest): on a SLOW network the start scene's coarsest
// level goes resident within the ~10s window but its finer levels arrive much
// later, so "stable for 600 frames" wrongly reads as "the device has maxed out"
// and freezes deviceFinest at a coarse level -- capping every neighbour scene at
// coarsest forever (field case: deviceFinest stuck at 3 while the start scene
// visibly sharpened to finest and vram climbed 63->500MB). While the start
// scene's render floor is still FINER than the observed finest, the engine is
// allowed to -- and still will -- make finer levels resident, so keep observing
// (that path resets stableFrames on every improvement); only a long stall with
// no improvement at all (the 3600-frame backstop) finally stops it, so a
// genuinely capped device (floor clamped up to finest, or churning) is never
// sampled forever and plan #6's steady-state-zero holds there. Pure and
// self-contained (no imports, no sibling-function calls) so it can be
// stringified verbatim into the exported viewer runtime via Function.toString().
const shouldSampleDeviceFinest = (frame: number, finest: number | null, stableFrames: number, pinConsumed: boolean, floorBelowFinest?: boolean): boolean => {
    if (finest !== null && finest <= 0) {
        return false;                    // already at the finest possible level: nothing left to ratchet
    }
    const stableCap = floorBelowFinest ? 3600 : 600;   // slow-net: wait for a late ratchet; else settle at ~10s
    if (pinConsumed && finest !== null && stableFrames >= stableCap) {
        return false;                    // settled and the first pin cycle used it (no finer coming)
    }
    if (frame < 600) {
        return true;                     // initial settle window: sample every frame
    }
    return frame % 30 === 0;             // steady state: back off
};

// Reveal gate: the coarsest LOD level a crossing/reveal accepts as "showable".
//   acceptable = near-coarse floor (coarsest - revealMargin)
//   target     = finest level THIS device loads for the scene (deviceFinest clamped
//                to the scene coarsest); the near-coarse acceptable until deviceFinest
//                is known. Deliberately NOT the current pinDepth -- for a scene being
//                crossed into, pinDepth is the stale coarse NEIGHBOUR depth and would
//                reveal it at the coarsest with no overlay.
//   guard      : only a genuinely-active, legitimately-degraded scene (hard-budget
//                last resort, pin coarser than the device target) may raise the gate to
//                its fresh pin, so the overlay does not stick waiting for levels it will
//                never load.
// Pure and self-contained (only args + Math) so it stringifies verbatim into the
// exported viewer runtime via Function.toString().
const computeRevealLevel = (
    coarse: number,
    revealMargin: number,
    deviceFinest: number | null,
    isActive: boolean,
    pinReady: boolean,
    pinDepth: number | null
): number => {
    const acceptable = Math.max(coarse - revealMargin, 0);
    let target = (deviceFinest !== null && deviceFinest !== undefined) ?
        Math.min(deviceFinest, coarse) :
        acceptable;
    if (isActive && pinReady && pinDepth !== null && pinDepth !== undefined && pinDepth > target) {
        target = pinDepth;
    }
    return Math.max(acceptable, target);
};

// Parse the stock viewer's ?budget=<n> URL override into a splat count, matching
// the viewer's own semantics (splatBudget = Number(param) * 1_000_000, used only
// when > 0). Returns 0 when the param is absent or invalid so callers fall back
// to their own default. The exported viewer applies ?budget= only inside
// applyPerfSettings (ready/firstFrame-gated), so the ready-gate watchdog reads it
// directly to honor the override when firstFrame never fires. String ops only, no
// regex: this is stringified into the companion template literal where regex
// character-class escapes lose their backslash at build time (see the
// ?residentBudget reader that once shipped dead). Pure and self-contained so it
// can be stringified verbatim via Function.toString().
const parseBudgetParam = (search: string): number => {
    try {
        const q = search || '';
        const key = 'budget=';
        let k = q.indexOf(key);
        while (k > 0 && q.charAt(k - 1) !== '?' && q.charAt(k - 1) !== '&') {
            k = q.indexOf(key, k + 1);
        }
        if (k <= 0) {
            return 0;
        }
        let end = q.indexOf('&', k);
        if (end < 0) {
            end = q.length;
        }
        const v = Number(q.substring(k + key.length, end));
        return (isFinite(v) && v > 0) ? v * 1000000 : 0;
    } catch (e) {
        return 0;
    }
};

export { collectLodFileUrls, lodMinLevelForBudget, collectSogBlockFileUrls, buildPortalAdjacency, desiredResidentScenes, assignPinDepths, computeWarmSet, computeResidentCeiling, selectResidentScenes, sceneResidentToDepth, startSceneLodFloor, shouldSampleDeviceFinest, pinBatchAllowed, computeRevealLevel, parseBudgetParam, PortalLodMeta, PortalLodNode, PortalSogBlockMeta };
