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

export { collectLodFileUrls, lodMinLevelForBudget, collectSogBlockFileUrls, buildPortalAdjacency, desiredResidentScenes, PortalLodMeta, PortalLodNode, PortalSogBlockMeta };
