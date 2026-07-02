# Portal Viewer Mobile Memory Bounding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound the exported portal viewer's memory on mobile by frontier-managing SOG scene assets and collision voxels, capping total pinned streaming splats to the device budget, and replacing startup warm-everything with incremental distance-2 cache warming.

**Architecture:** All decision logic lands as pure, unit-tested, stringifiable helpers in `src/portal-preload.ts` (`assignPinDepths`, `computeWarmSet`); the injected IIFE runtime in `src/viewer-companion/portals.ts` gains only thin wiring (`reconcileFrontier`, `loadScene`/`unloadScene`, `reconcileCollisions`, `warmFrontier`) that calls them. A new injection smoke test guards the whole template against syntax breakage.

**Tech Stack:** TypeScript, Vitest (Node env), PlayCanvas engine v2.19.x (exported-viewer runtime only — no editor changes), Rollup release build for E2E.

> **Series note:** This plan is one of a 6-plan series written 2026-07-02 against commit `916666a`. Plans 3, 5, and 6 of the series all modify `src/viewer-companion/portals.ts`; earlier plans in the series may have merged before this one executes. **Task 0 (preflight) is mandatory:** for each file:line citation and code anchor in this plan, grep to confirm the anchor still exists; if code has drifted, adapt the plan's snippets to the current code rather than pasting blindly.

## Context

### What this repo is

SuperSplat (`C:\Dev\playcanvas\supersplat`) is a browser-based 3D Gaussian-splat editor built on the PlayCanvas engine. This fork adds a **portals** feature: a project holds multiple scenes; the exported HTML viewer renders one scene at a time and swaps when the camera crosses a doorway (portal rectangle). Exports come in two flavours:

- **SOG (Package/ZIP)** — each extra scene is one fully-decoded bundle file `scenes/<N>/scene.sog`. Loading the asset loads the *entire* scene's splat data.
- **Streaming (LOD)** — each extra scene is `scenes/<N>/lod-meta.json` plus per-block folders. The asset itself is only the small octree meta; splat blocks stream on demand. LOD level `0` = finest, `lodLevels-1` = coarsest. Per-scene per-level whole-scene splat counts are baked into the export payload as `portalSceneLodCounts` (`src/splat-export-core.ts:509`) — **streaming exports only**; SOG exports carry no counts (the payload default `[]` at `src/viewer-companion/portals.ts:764` applies).

The viewer runtime is injected at export time by `buildPortalsInjection` (`src/viewer-companion/portals.ts`): a hand-written IIFE template string (`companionRuntime`) plus pure helpers inlined via `Function.prototype.toString()`. **CRITICAL stringification constraints:**

1. Stringified helpers must be fully self-contained — no references to sibling functions, imports, or module-level variables (terser mangles those names in release builds and the stringified copy throws ReferenceError at runtime). The only allowed pattern is dependency injection: pass the sibling in as a parameter (see `resolveActiveSplat`'s `cross` param in `src/portal-geom.ts`).
2. Logic inside the IIFE template string is NOT unit-testable. Decision logic goes into pure exported helpers (`src/portal-preload.ts`, unit-tested in `test/portal-preload.test.ts`); the template stays thin wiring, covered by substring assertions + the new smoke test.
3. Any viewer-companion change MUST be E2E-verified with a **RELEASE build** (`npm run build`) — minification bugs only appear in release.

### How the runtime works today (verified at `916666a`)

All references are `src/viewer-companion/portals.ts` unless noted.

- **Eager scene loading:** `start()` (~:381–414) loads *every* extra scene's gsplat asset at startup via `app.assets.loadFromUrl(url, 'gsplat', cb)` (~:388), creating a disabled `Entity` per scene. `switchTo(idx)` (~:110) enables exactly one (`applyActive`, ~:337).
- **Eager collision loading:** `preloadCollisions()` (~:273–296) snapshots the live `VoxelCollision`'s fields for the start scene, then fetches every other scene's voxel JSON+bin into `voxels[]` (~:230) forever. `swapCollision(idx)` (~:297) mutates the ONE shared `VoxelCollision` instance in place (never constructs a new one — this preserves legacy subclass behavior). The collision debug overlay is rebuilt per scene (`refreshOverlay`, ~:317).
- **Streaming pin frontier:** `buildPortalAdjacency` + `desiredResidentScenes` (pure, `src/portal-preload.ts:172–225`) define the frontier = active scene + its portal neighbours (excluding scene 0, the viewer's own always-resident start scene). `pinDesired()` (~:703) pins each frontier scene's octree blocks of levels `[deviceFinest .. coarsest]` resident via `octree.incRefCount(i)` + re-polled `ensureFileResource(i)` (`pinSceneToLevel`, ~:624), and reclaims scenes leaving the frontier via `octree.decRefCount(i, 0)` (`unpinScene`, ~:662). `deviceFinest` = running-min resident `lodLevel` observed on the start scene's octree (`updateDeviceFinest`, ~:593–602) — the finest level THIS device actually renders. `pinWhenBudgetReady()` (~:684) defers the first reconcile until `app.scene.gsplat.splatBudget` (read by `getSplatBudget`, ~:528–532) is applied and `deviceFinest` has settled. SOG scenes are a pin no-op (`pinSceneToLevel` bails when there is no octree, ~:627).
- **Startup cache warming:** `warmExtraScenes()` (~:533–576) fetch-and-discards EVERY extra streaming scene's block files down to `lodMinLevelForBudget(counts, budget)` depth (`src/portal-preload.ts:28–45`), falling back to a desktop-ish budget of `2000000` (~:549).
- **Loading overlay:** first crossing into a streaming scene arms a backdrop+spinner (`beginLoading`, ~:205) that reveals via a payload-baked splat-count threshold, a plateau detector on the global `app.renderer._gsplatCount`, or a ~10 s frame cap (tick poll ~:460–486). Today SOG exports never show it (gate `if (streaming && ...)` in `switchTo`, ~:117).

Design intent docs: `docs/superpowers/2026-06-30-portal-adjacency-preloading-design.md`, `docs/superpowers/2026-06-29-portal-scene-preloading-crossing-gap-handoff.md`.

### The defects being fixed (audit findings + user-approved designs)

1. **[HIGH][memory] SOG scenes are all fully resident forever.** The frontier only manages streaming octree blocks; SOG scenes are eagerly loaded at startup (~:381–414) and merely `enabled=false`-hidden (comment ~:88–91; pin no-op ~:627). A 5-scene SOG export on a phone allocates 5 full splat datasets → OOM. **Design:** frontier-manage SOG scene assets on ALL devices — load a SOG scene's asset when it enters the adjacency frontier (active + portal neighbours), fully release it when it leaves (entity destroy → `app.assets.remove(asset)` → `asset.unload()` — sequence verified against the engine source, see below). The loading overlay covers the reload gap on fast double-crossings (this drops the old "SOG never overlays" invariant — deliberately).
2. **[HIGH][memory] Pinned residency is unbounded.** `pinDesired` pins active + every neighbour at `deviceFinest` with no cap vs the engine budget; pinned blocks of disabled scenes bypass the budget balancer. **Design:** cap total pinned splats to ~1× `splatBudget` using the baked `portalSceneLodCounts`: the active scene keeps `deviceFinest`; neighbours degrade to coarser depths (level+1, +2, …; costliest neighbour first) until the sum fits — never coarser than each scene's coarsest level. New pure helper `assignPinDepths(...)` in `src/portal-preload.ts`, dependency-injected into the IIFE. (Streaming exports only in practice: SOG exports have no counts and no octrees to pin.)
3. **[MED][memory] All scenes' collision voxels retained forever.** **Design:** frontier-manage them — fetch a scene's voxel field-set when it enters the frontier, drop it (the `nodes`/`leafData` fields are `Uint32Array`s; dropping the reference lets GC reclaim them) when it leaves. The active scene's data is always retained while active, and the start-scene *snapshot* (captured from the live instance at startup, the only restore source when walking back) is retained for the whole session. The in-place `VoxelCollision` mutation swap is preserved untouched.
4. **[MED][memory/bandwidth] `warmExtraScenes` warms EVERY scene at a budget-derived depth** — with the desktop fallback budget (2,000,000) that resolves to level 0 = every file of every scene downloaded and discarded at startup. **Design (user decision):** replace with INCREMENTAL warming — when the frontier shifts (startup + each crossing), cache-warm only the scenes newly at graph distance 2 from the active scene (neighbours of pinned scenes that are not themselves pinned) at `deviceFinest` depth (SOG: the single `.sog` file). Distance ≤ 1 = pinned resident (instant crossing); distance 2 = HTTP-cache warm so the next crossing's pin fetch is fast. Track a per-session warmed-set (never re-warm). New pure helper `computeWarmSet(...)`.
5. **[safety net] Injection smoke test:** `buildPortalsInjection` output's `<script>` bodies must construct via `new Function(...)` without throwing (catches syntax-level breakage in the stringified helpers/template), and the `window.__supersplatPortals` payload must round-trip through `JSON.parse`.

### Intentional behavior change (document, don't "fix")

Scenes ≥ 3 portal hops away from the camera are neither resident nor cache-warmed until you approach; the first crossing into them after a fast sprint may briefly show the loading overlay. This is the accepted trade for bounded memory.

### Engine facts this plan relies on (verified in `node_modules/playcanvas/build/playcanvas.dbg.mjs`)

- **Asset release sequence for a loaded gsplat scene:** (a) `entity.destroy()` — the gsplat component's `onRemove()` calls `destroyInstance()`, which removes and destroys its `GSplatPlacement`; the unified manager then releases the resource's usage refs. (b) `app.assets.remove(asset)` — deregisters the asset AND deletes the registry's internal `url → asset` map entry, so a later `loadFromUrl` of the same URL creates a *fresh* `Asset` (`loadFromUrlAndFilename` first checks `getByUrl(url)` — without the remove it would return the unloaded stale asset). (c) `asset.unload()` — sets `resources = []`, `loaded = false`, clears the resource-loader cache for the URL, and calls `resource.destroy()`. `GSplatResourceBase.destroy()` is safe to call while the sorter still holds refs: it defers via `GSplatResourceCleanup.queueDestroy` and the actual GPU free happens in `GSplatResourceCleanup.process` (called by `GSplatDirector.update()` each rendered frame) once `refCount === 0` — hence nudge `app.renderNextFrame = true` after unloading.
- **Streaming block pin/reclaim:** `octree.incRefCount(i)` + re-polled `ensureFileResource(i)` makes a block resident; `octree.decRefCount(i, 0)` immediately unloads when the pin was the last ref; a disabled scene's octree is never cooldown-ticked, so explicit decRef is the only reclaim path. `octree.files[i].lodLevel` and `octree.lodLevels` describe the level layout; `pinSceneToLevel` is additive (skips already-pinned file indices), so re-pinning a scene at a *finer* level only adds the finer blocks.
- `GSplatOctreeInstance.destroy()` decRefs all its own blocks — an active scene's instance holds its own refs, so our unpin never frees blocks it is still rendering.

## Global Constraints

- Use Bash (Git Bash on Windows), never PowerShell. Run commands plainly from the repo root — no `cd`, `git -C`, or `npm --prefix` prefixes (they trigger permission prompts).
- ESLint is pinned to v10 and **crashes on `import/order` autofix** — never run `eslint --fix`; match surrounding import order by hand. If a plain `npm run lint` crashes with the known import/order issue, gate on `npx tsc --noEmit` instead and note it.
- Never delete `package-lock.json`.
- `tsconfig`: `strictNullChecks: false`, `noImplicitAny: true`. Match surrounding code style (the IIFE template uses ES5 `var`/`function`; pure helpers use `const` arrows). Comments explain constraints, not narration.
- Stringified helpers: fully self-contained, dependency-injection only. Never reference a sibling/module symbol from inside a helper that gets `Function.toString()`-ed.
- Don't touch code unrelated to this task.
- Tests: `npm run test` (all), `npx vitest run test/portal-preload.test.ts` / `npx vitest run test/portals-injection.test.ts` (targeted). Typecheck: `npx tsc --noEmit`.
- Work on a feature branch (`feat/portal-viewer-mobile-memory`). When complete and verified, squash all commits into a single commit summarizing the change (the executor's finishing skill handles this).
- E2E must use a RELEASE build (`npm run build`), never debug.

---

### Task 0: Preflight — branch + anchor verification

**Files:**
- Read-only verification; creates the feature branch.

- [ ] **Step 1: Create the feature branch**

```bash
git checkout main
git checkout -b feat/portal-viewer-mobile-memory
```

- [ ] **Step 2: Verify every code anchor this plan relies on**

Run each grep; every one must return a hit. If any anchor is missing or has moved, read the surrounding code and adapt the corresponding snippet in this plan to the current source instead of pasting blindly (plans 5 and 6 of this series also touch `src/viewer-companion/portals.ts` and may have landed first).

```bash
grep -n "app.assets.loadFromUrl(url, 'gsplat'" src/viewer-companion/portals.ts     # eager scene load (~:388)
grep -n "function preloadCollisions" src/viewer-companion/portals.ts               # eager voxel fetch (~:273)
grep -n "function pinDesired" src/viewer-companion/portals.ts                      # frontier pin reconcile (~:703)
grep -n "function updateDeviceFinest" src/viewer-companion/portals.ts              # device-observed finest (~:593)
grep -n "function warmExtraScenes" src/viewer-companion/portals.ts                 # startup warm-everything (~:533)
grep -n "runWarm(budget || 2000000)" src/viewer-companion/portals.ts               # desktop fallback budget (~:549)
grep -n "function getSplatBudget" src/viewer-companion/portals.ts                  # splatBudget read (~:528)
grep -n "function pinSceneToLevel" src/viewer-companion/portals.ts                 # additive block pinning (~:624)
grep -n "function unpinScene" src/viewer-companion/portals.ts                      # block reclaim (~:662)
grep -n "function switchTo" src/viewer-companion/portals.ts                        # crossing entry point (~:110)
grep -n "const lodMinLevelForBudget" src/portal-preload.ts                         # budget-depth helper (:28)
grep -n "const desiredResidentScenes" src/portal-preload.ts                        # frontier set helper (:205)
grep -n "portalSceneLodCounts: \[primaryLodCounts" src/splat-export-core.ts        # counts baked at export (:509)
grep -n "includes the two-level coarse-LOD cache-warming routine" test/portals-injection.test.ts
```

- [ ] **Step 3: Confirm the suite is green before starting**

```bash
npm run test
```

Expected: all existing tests pass (portal-preload, portals-injection, portal-geom, portal-anim-timeline, portals, etc.).

---

### Task 1: Injection smoke test

**Files:**
- Modify (append): `test/portals-injection.test.ts`

**Interfaces:**
- Consumes: `buildPortalsInjection(viewerSettingsJson)` from `src/viewer-companion/portals.ts` (existing).
- Produces: a `describe('buildPortalsInjection smoke', ...)` block that every later task re-runs; the shared `extractScripts` helper.

This test guards everything after it: any stringified-helper or template syntax breakage makes `new Function` throw. Note it catches *syntax*-level breakage only (reference errors to mangled identifiers are a release-runtime phenomenon — that is what Task 6's release E2E is for); the substring assertions added in later tasks catch missing wiring.

- [ ] **Step 1: Write the test** — append to the end of `test/portals-injection.test.ts`:

```ts
describe('buildPortalsInjection smoke', () => {
    // Representative 3-scene streaming payload: chained portals 0-1-2, collision
    // on, per-level counts present (finest -> coarsest).
    const payload = {
        portals: [
            { position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 },
            { position: [5, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 1, back: 2 }
        ],
        portalScenes: ['', 'scenes/1/lod-meta.json', 'scenes/2/lod-meta.json'],
        portalStart: 0,
        portalCollision: ['index.voxel.json', 'scenes/1/scene.voxel.json', 'scenes/2/scene.voxel.json'],
        portalEnvironments: ['indoor', 'indoor', 'indoor'],
        portalSceneLodCounts: [[1000000, 250000, 62500], [800000, 200000, 50000], [600000, 150000, 37500]]
    };

    const extractScripts = (html: string): string[] => {
        const out: string[] = [];
        const re = /<script>([\s\S]*?)<\/script>/g;
        let m;
        while ((m = re.exec(html)) !== null) {
            out.push(m[1]);
        }
        return out;
    };

    it('emits exactly two scripts: payload global then runtime', () => {
        const scripts = extractScripts(buildPortalsInjection(payload));
        expect(scripts.length).toBe(2);
        expect(scripts[0]).toContain('window.__supersplatPortals');
        expect(scripts[1]).toContain('function');
    });

    it('runtime script body constructs via new Function without throwing', () => {
        const scripts = extractScripts(buildPortalsInjection(payload));
        // Construction (not execution) catches syntax-level breakage in the
        // stringified helpers and the IIFE template.
        expect(() => new Function(scripts[1])).not.toThrow();
    });

    it('payload global round-trips through JSON.parse', () => {
        const scripts = extractScripts(buildPortalsInjection(payload));
        const m = scripts[0].match(/^window\.__supersplatPortals = ([\s\S]*);$/);
        expect(m).not.toBeNull();
        const parsed = JSON.parse(m![1]);
        expect(parsed.portalScenes).toEqual(payload.portalScenes);
        expect(parsed.portalSceneLodCounts).toEqual(payload.portalSceneLodCounts);
        expect(parsed.portalCollision).toEqual(payload.portalCollision);
        expect(parsed.portalStart).toBe(0);
        expect(Array.isArray(parsed.portalAnimTimeline)).toBe(true);
        expect(parsed.loadingDefaults.en).toBeTruthy();
    });
});
```

- [ ] **Step 2: Run the test — it must PASS immediately** (the current template is valid; this task adds the guard, not a fix):

```bash
npx vitest run test/portals-injection.test.ts
```

Expected: all tests pass, including the 3 new smoke tests. If `new Function` throws here, the template is already broken by a prior series plan — stop and fix that first.

- [ ] **Step 3: Commit**

```bash
git add test/portals-injection.test.ts
git commit -m "test(portals): injection smoke test (new Function + payload round-trip)"
```

---

### Task 2: Pin-depth cap — `assignPinDepths` helper + runtime wiring

**Files:**
- Modify: `src/portal-preload.ts` (append helper before the export line :227; extend the export list)
- Modify: `src/viewer-companion/portals.ts` (import :3; helper injection block ~:63–70; state vars ~:85; `pinDesired` ~:703–725)
- Test: `test/portal-preload.test.ts` (append), `test/portals-injection.test.ts` (extend substring assertions)

**Interfaces:**
- Produces: `assignPinDepths(activeIdx: number, neighborIdxs: number[], sceneLodCounts: number[][], deviceFinest: number | null, budget: number): Record<number, number>` — map of extra-scene index (≥ 1) → pin depth (minimum LOD level to pin; levels `[depth .. coarsest]` get pinned). Exported from `src/portal-preload.ts`, stringified into the runtime.
- Consumes: nothing from earlier tasks (guarded by Task 1's smoke test).

Semantics (agreed design): pinning scene `s` at depth `d` keeps levels `[d .. counts[s].length-1]` resident, costing `sum(counts[s][d..])` splats. Active scene keeps the base depth (deviceFinest clamped to its coarsest) and is never degraded. Neighbours start at base depth and degrade one level at a time — costliest current neighbour first, ties broken by earliest position in `neighborIdxs` (which is sorted, so lowest index) — until the total fits `budget` or all neighbours sit at their coarsest. Deliberate edge policies: `deviceFinest === null` (not yet observed) → each scene's coarsest; `budget <= 0` (unknown) → neighbours at coarsest, active at base (conservative — this changes the rare budget-timeout case, which previously pinned everything at deviceFinest); missing/empty counts for a scene → base depth, cost 0 (unmeasurable; the runtime clamps to the real octree span anyway).

- [ ] **Step 1: Write the failing tests** — append to `test/portal-preload.test.ts` (add `assignPinDepths` to the import at :3):

```ts
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
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run test/portal-preload.test.ts
```

Expected failure: `assignPinDepths` is not exported (`SyntaxError`/`TypeError: assignPinDepths is not a function`).

- [ ] **Step 3: Implement the helper** — in `src/portal-preload.ts`, insert before the `export {` line (:227), and add `assignPinDepths` to the export list:

```ts
// Assign a pin depth (minimum LOD level to keep resident) to each frontier scene
// so the TOTAL pinned splat count stays within the device budget.
// sceneLodCounts[s][lv] is scene s's whole-scene splat count at level lv
// (0 = finest .. last = coarsest); pinning scene s at depth d keeps levels
// [d .. coarsest] resident, costing sum(counts[s][d..]) splats. The active scene
// keeps the base depth (deviceFinest clamped to its own coarsest) and is never
// degraded; neighbours degrade one level at a time -- costliest first, ties to
// the earliest neighbour -- until the total fits or all sit at their coarsest.
// deviceFinest null (not yet observed) -> each scene's coarsest. budget <= 0
// (unknown) -> neighbours at coarsest, active at base. Missing/empty counts ->
// base depth, cost 0 (unmeasurable; the runtime clamps to the real octree span).
// Only extra scenes (index >= 1) are returned: scene 0 is the viewer's own
// always-resident start scene, never pin-managed. Pure and self-contained (no
// imports, no sibling-function calls) so it can be stringified verbatim into the
// exported viewer runtime via Function.toString().
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
    if (activeIdx >= 1) {
        depths[activeIdx] = baseDepth(activeIdx);
    }
    for (let i = 0; i < (neighborIdxs || []).length; i++) {
        const n = neighborIdxs[i];
        if (n >= 1 && n !== activeIdx && depths[n] === undefined) {
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
            break;                           // nothing left to degrade
        }
        depths[pick] += 1;
    }
    return depths;
};
```

Export line becomes:

```ts
export { collectLodFileUrls, lodMinLevelForBudget, collectSogBlockFileUrls, buildPortalAdjacency, desiredResidentScenes, assignPinDepths, PortalLodMeta, PortalLodNode, PortalSogBlockMeta };
```

- [ ] **Step 4: Run tests to verify pass**

```bash
npx vitest run test/portal-preload.test.ts
```

Expected: all pass (existing + 8 new).

- [ ] **Step 5: Add the failing wiring assertion** — in `test/portals-injection.test.ts`, inside the existing test `'includes the two-level coarse-LOD cache-warming routine in the runtime'` (~:98–116), add after the `updateDeviceFinest` assertion:

```ts
        // pinned residency is capped: per-scene depths assigned against the budget
        expect(out).toContain('assignPinDepths');
```

Run `npx vitest run test/portals-injection.test.ts` — expected: that one test fails (`assignPinDepths` not in output).

- [ ] **Step 6: Wire into the runtime** — in `src/viewer-companion/portals.ts`:

(a) Import (:3) — add `assignPinDepths`:

```ts
import { collectLodFileUrls, lodMinLevelForBudget, collectSogBlockFileUrls, buildPortalAdjacency, desiredResidentScenes, assignPinDepths } from '../portal-preload';
```

(b) Helper injection block — after the line `var desiredResidentScenes = ${desiredResidentScenes.toString()};` (~:70) add:

```
  var assignPinDepths = ${assignPinDepths.toString()};
```

(c) State — after `var pinnedScenes = {};` (~:85) add:

```
  var pinDepth = [];                        // scene index -> currently applied pin depth (min pinned level)
```

(d) Replace the whole `pinDesired` function (~:697–725, keep its leading comment block about reading LIVE activeIndex) with:

```js
  function pinDesired() {
    if (!adjacency) { return; }
    var active = activeIndex;
    var want = desiredResidentScenes(adjacency, active);
    // Budget-capped per-scene depths: active keeps deviceFinest, neighbours
    // degrade toward coarser until the summed pinned splat count fits ~1x the
    // engine budget (pinned blocks of disabled scenes bypass the budget
    // balancer, so we must cap them ourselves).
    var depths = assignPinDepths(
      active,
      adjacency[active] || [],
      data.portalSceneLodCounts || [],
      deviceFinest,
      getSplatBudget()
    );
    var wantSet = {};
    for (var i = 0; i < want.length; i++) {
      var idx = want[i];
      wantSet[idx] = true;
      if (!entities[idx] || !octrees[idx]) { continue; }
      // Clamp the assigned depth to the loaded octree's real level span (the
      // payload counts can disagree with the octree; the octree is ground truth).
      var coarse = octrees[idx].lodLevels ? octrees[idx].lodLevels - 1 : 0;
      var min = (depths[idx] != null) ? Math.min(Math.max(depths[idx], 0), coarse) : deviceMinLevel(idx);
      if (pinnedScenes[idx] && min === pinDepth[idx]) { continue; }
      if (pinnedScenes[idx] && min > pinDepth[idx]) {
        // Role changed toward neighbour on a tight budget -> coarsen. Full
        // unpin + re-pin: pinSceneToLevel is additive so it cannot shed levels.
        // An ACTIVE scene's own instance holds refs, so unpin never frees what
        // is being rendered; a hidden scene reloads its coarse levels from the
        // HTTP cache (cheap: coarse levels are small).
        unpinScene(idx);
      }
      sceneMinLevel[idx] = min;
      if (comps[idx]) { comps[idx].lodRangeMin = min; }
      pinSceneToLevel(getAsset(idx), idx, min);   // additive when deepening; fresh pin otherwise
      pinnedScenes[idx] = true;
      pinDepth[idx] = min;
    }
    for (var k in pinnedScenes) {
      var s = Number(k);
      if (pinnedScenes[s] && !wantSet[s] && s !== active) {
        unpinScene(s);
        pinnedScenes[s] = false;
        pinDepth[s] = null;
      }
    }
  }
```

- [ ] **Step 7: Verify**

```bash
npx vitest run test/portals-injection.test.ts test/portal-preload.test.ts
npx tsc --noEmit
```

Expected: all tests pass (smoke test still constructs), tsc clean.

- [ ] **Step 8: Commit**

```bash
git add src/portal-preload.ts src/viewer-companion/portals.ts test/portal-preload.test.ts test/portals-injection.test.ts
git commit -m "feat(portals): cap total pinned splats to the device budget via assignPinDepths"
```

---

### Task 3: SOG scene frontier management (load on entry, unload on exit)

**Files:**
- Modify: `src/viewer-companion/portals.ts` — state vars (~:76–92), `switchTo` (~:110–118), tick crossing guard (~:447–450), `start()` scene loop + tail (~:381–419), new `loadScene`/`sceneWanted`/`unloadScene`/`reconcileFrontier` functions (place after `pinDesired`)
- Test: `test/portals-injection.test.ts` (substring assertions; the smoke test guards syntax)

**Interfaces:**
- Consumes: `pinDepth` (Task 2), `desiredResidentScenes` (existing).
- Produces: `reconcileFrontier()` (Task 4 inserts `reconcileCollisions(want)` into it; Task 5's warming hangs off `pinDesired`), `loadScene(idx)`, `unloadScene(idx)`, `sceneWanted(idx)`, `sceneLoading[]`, `liveApp`/`startEntityRef`/`EntityCtor`.

This is IIFE template wiring — not unit-testable. Coverage = smoke test (construction) + substring assertions + `tsc` + Task 6's release E2E. Behavior notes baked into the design:

- Streaming scenes stay eagerly loaded at startup (their asset is only the small `lod-meta.json`; block memory is pin-managed). Only SOG scenes (URL without `lod-meta.json`) are frontier-managed.
- `switchTo` no longer requires the target entity to exist: crossing (or timeline-scrubbing) into a not-yet-loaded SOG scene sets it active, shows the loading overlay, and the load callback enables it on arrival. This drops the old "SOG never overlays" invariant deliberately (finding 1's accepted trade). The free-nav tick keeps a conservative guard (`entities[next] || sceneLoading[next]`) so a failed-load scene doesn't strand the user; the timeline path (`sceneAtTime`) is authoritative and re-asserts every frame, so `switchTo`'s own tolerance covers scrub-jumps.
- A load completing after its scene left the frontier (fast multi-crossing) is discarded immediately (SOG only), so no hidden full dataset lingers.

- [ ] **Step 1: Write the failing substring assertions** — in `test/portals-injection.test.ts`, append a new test inside the `describe('buildPortalsInjection', ...)` block:

```ts
    it('frontier-manages SOG scenes: load on entry, full unload on exit', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/scene.sog'],
            portalStart: 0
        });
        expect(out).toContain('reconcileFrontier');
        expect(out).toContain('unloadScene');
        expect(out).toContain('assets.remove');   // asset deregistered so a re-load creates a fresh Asset
        expect(out).toContain('.unload()');       // resource destroyed (engine defers until sorter releases)
        expect(out).toContain('sceneLoading');
    });
```

Run `npx vitest run test/portals-injection.test.ts` — expected: this new test fails (none of the identifiers exist yet).

- [ ] **Step 2: Add the state vars** — in `src/viewer-companion/portals.ts`, after `var pinReady = false; ...` (~:86) and before `var activeIndex = ...`, add:

```
  var sceneLoading = [];                    // scene index -> gsplat asset load in flight
  var liveApp = null;                       // pc.AppBase, captured once start() finds it
  var startEntityRef = null;                // the viewer's own start-scene entity (transform template for extra scenes)
  var EntityCtor = null;                    // pc.Entity constructor (reached via the start entity)
```

Also update the stale comment at ~:88–91 (`// Streaming vs SOG: only streaming scenes stream progressively ...`) to:

```
  // Streaming vs SOG: streaming scenes stream progressively via the pin
  // machinery; SOG scenes are frontier-managed whole assets (loaded when they
  // enter the adjacency frontier, fully unloaded when they leave), so a fast
  // crossing into a still-loading SOG scene shows the loading overlay too.
```

- [ ] **Step 3: Replace `switchTo`** (~:110–118) with:

```js
  // Switch to scene idx: enable it, swap collision, reconcile the frontier and
  // arm the loading overlay when the destination is not ready (still streaming,
  // or a SOG scene whose asset has not finished loading). Tolerates a target
  // whose entity does not exist yet: activeIndex flips immediately (the frontier
  // reconcile loads it) and the load callback enables it on arrival.
  function switchTo(idx) {
    if (idx === activeIndex || idx === null || idx === undefined) return;
    if (idx < 0 || idx >= data.portalScenes.length) return;
    activeIndex = idx;
    applyActive();
    swapCollision(idx);
    scheduleRefine(idx);
    reconcileFrontier();
    if (!readyScenes[idx] && pendingIndex !== idx) { beginLoading(idx); }
  }
```

(Note: the `streaming &&` gate is gone — loaded SOG scenes set `readyScenes[idx] = true` in the load callback below, so a normal SOG crossing still shows no overlay.)

- [ ] **Step 4: Relax the free-nav crossing guard** — in `tick()` (~:445–450), replace:

```js
          // A crossing whose target scene has not finished loading (entities[next]
          // missing) is skipped; eager preload at startup makes this rare.
          var next = resolveActiveSplat(lastSafe, cur, rects, activeIndex, segmentCrossesRect);
          if (next !== activeIndex && next !== null && entities[next]) {
```

with:

```js
          // A crossing whose target has neither loaded nor started loading is
          // skipped (defensive: frontier preloading starts every reachable
          // neighbour's load, so this only bites after a load failure).
          var next = resolveActiveSplat(lastSafe, cur, rects, activeIndex, segmentCrossesRect);
          if (next !== activeIndex && next !== null && (entities[next] || sceneLoading[next])) {
```

- [ ] **Step 5: Extract `loadScene` and add the frontier functions** — insert after the closing brace of `pinDesired` (end of the function added in Task 2), before the `warmExtraScenes();` call at the bottom:

```js
  // Load scene idx's gsplat asset and create its (disabled unless active)
  // entity. Extracted from start() so the frontier reconcile can (re)load SOG
  // scenes on demand. No-op until start() has captured the live handles.
  function loadScene(idx) {
    if (entities[idx] || sceneLoading[idx] || !liveApp) { return; }
    var url = data.portalScenes[idx];
    if (!url) { return; }
    var isStreamingScene = url.indexOf('lod-meta.json') !== -1;
    sceneLoading[idx] = true;
    // loadFromUrl builds + loads the gsplat Asset internally (the start entity's
    // gsplat.asset is a numeric id, so the Asset class is not reachable that
    // way). Works for both SOG and streaming (lod-meta.json).
    liveApp.assets.loadFromUrl(url, 'gsplat', function (err, asset) {
      sceneLoading[idx] = false;
      if (err || !asset) { console.warn('portal scene ' + idx + ' failed to load:', err); return; }
      // A SOG frontier may have moved on while the asset was in flight (fast
      // multi-crossing): discard instead of keeping a hidden full copy.
      // Streaming assets are always kept (only the small octree meta).
      if (!isStreamingScene && !sceneWanted(idx)) {
        try { liveApp.assets.remove(asset); asset.unload(); } catch (discardErr) { console.warn('portal scene ' + idx + ' discard failed:', discardErr); }
        return;
      }
      var e = new EntityCtor('portalScene' + idx);
      var comp = e.addComponent('gsplat', { unified: true, asset: asset });
      // The start gsplat is parented directly to app.root in exported viewers,
      // so copying its LOCAL transform places extra scenes in the same shared
      // world frame the export already baked them into.
      e.setLocalPosition(startEntityRef.getLocalPosition());
      e.setLocalRotation(startEntityRef.getLocalRotation());
      e.setLocalScale(startEntityRef.getLocalScale());
      liveApp.root.addChild(e);
      e.enabled = (idx === activeIndex);
      entities[idx] = e;
      comps[idx] = comp;
      assets[idx] = asset;
      octrees[idx] = getOctree(asset);
      sceneMinLevel[idx] = deviceMinLevel(idx);
      if (comp && octrees[idx]) {
        comp.lodRangeMin = sceneMinLevel[idx];
        comp.lodRangeMax = 1000;
      }
      if (!octrees[idx]) { readyScenes[idx] = true; }   // SOG: fully resident once loaded
      if (idx === activeIndex) scheduleRefine(idx);
      pinWhenBudgetReady();               // reconcile pins (incl. this just-loaded scene) once budget/deviceFinest settle
      liveApp.renderNextFrame = true;
    });
  }

  // Live frontier membership: the active scene or one of its portal neighbours.
  function sceneWanted(idx) {
    if (idx === activeIndex) { return true; }
    if (!adjacency) { return true; }                    // before start() settles, keep everything
    var want = desiredResidentScenes(adjacency, activeIndex);
    for (var i = 0; i < want.length; i++) { if (want[i] === idx) { return true; } }
    return false;
  }

  // Fully release a hidden SOG scene that left the frontier. Order matters:
  // destroy the entity first (the gsplat component's onRemove destroys its
  // placement, letting the unified manager release its resource refs), then
  // deregister the asset (assets.remove deletes the registry's url->asset map
  // entry, so a later loadFromUrl of the same URL creates a fresh Asset) and
  // unload it (destroys the GSplatResource -- the engine defers the actual GPU
  // free until the sorter's refCount hits 0 and GSplatDirector.update processes
  // the cleanup queue, hence the renderNextFrame nudge). Streaming scenes are
  // never asset-unloaded here: their asset is only the small octree meta and
  // their block memory is governed by the pin/unpin machinery.
  function unloadScene(idx) {
    if (idx === 0 || idx === activeIndex || !entities[idx]) { return; }
    var e = entities[idx];
    var a = assets[idx];
    entities[idx] = null; comps[idx] = null; octrees[idx] = null; assets[idx] = null;
    sceneMinLevel[idx] = null; readyScenes[idx] = false;
    pinDepth[idx] = null;
    pinGen[idx] = (pinGen[idx] || 0) + 1;   // invalidate any in-flight awaitResident
    try { e.destroy(); } catch (err) { console.warn('portal scene ' + idx + ' entity destroy failed:', err); }
    if (a && liveApp) {
      try { liveApp.assets.remove(a); a.unload(); } catch (err) { console.warn('portal scene ' + idx + ' unload failed:', err); }
    }
    if (liveApp) { liveApp.renderNextFrame = true; }
  }

  // Reconcile the frontier to the LIVE activeIndex: SOG scene assets (load
  // wanted, unload unwanted) and streaming block pins (via pinWhenBudgetReady ->
  // pinDesired). Called at startup and on every crossing; idempotent, so stale
  // or duplicate calls are harmless.
  function reconcileFrontier() {
    if (!adjacency || !liveApp) { return; }
    var want = desiredResidentScenes(adjacency, activeIndex);
    var wantSet = {};
    for (var i = 0; i < want.length; i++) { wantSet[want[i]] = true; }
    for (var idx = 1; idx < data.portalScenes.length; idx++) {
      var u = data.portalScenes[idx];
      if (!u || u.indexOf('lod-meta.json') !== -1) { continue; }   // streaming: pin-managed, asset stays
      if (wantSet[idx]) { loadScene(idx); } else { unloadScene(idx); }
    }
    pinWhenBudgetReady();
  }
```

- [ ] **Step 6: Rewrite the `start()` scene loop and tail** — replace the block from `for (var i = 1; i < data.portalScenes.length; i++) {` (~:381) through `requestAnimationFrame(tick);` (~:419) with:

```js
    liveApp = app;
    startEntityRef = startEntity;
    EntityCtor = Entity;
    // Streaming scenes load eagerly: the asset is only the small lod-meta.json
    // (a disabled scene streams no blocks on its own). SOG scenes are frontier-
    // managed by reconcileFrontier: the asset IS the full splat data, so only
    // the active scene's portal neighbours are kept loaded.
    for (var i = 1; i < data.portalScenes.length; i++) {
      var u = data.portalScenes[i];
      if (u && u.indexOf('lod-meta.json') !== -1) { loadScene(i); }
    }

    applyActive();
    reconcileFrontier();
    preloadCollisions();
    requestAnimationFrame(tick);
```

(The old loop body — `loadFromUrl` callback creating the entity — moved verbatim-ish into `loadScene`; verify nothing else from it was dropped. `pinWhenBudgetReady()` at the old ~:417 is now called by `reconcileFrontier`.)

- [ ] **Step 7: Verify**

```bash
npx vitest run test/portals-injection.test.ts test/portal-preload.test.ts
npx tsc --noEmit
```

Expected: all pass (the Step 1 test now passes; the smoke test still constructs), tsc clean.

- [ ] **Step 8: Commit**

```bash
git add src/viewer-companion/portals.ts test/portals-injection.test.ts
git commit -m "feat(portals): frontier-manage SOG scene assets (load on entry, unload on exit)"
```

---

### Task 4: Collision voxel frontier management

**Files:**
- Modify: `src/viewer-companion/portals.ts` — voxel state (~:230), `swapCollision` (~:297–305), replace `preloadCollisions` (~:273–296) with `initCollisions`/`loadVoxel`/`reconcileCollisions`, insert `reconcileCollisions(want)` into `reconcileFrontier` (Task 3), swap the `start()` call
- Test: `test/portals-injection.test.ts` (substring assertions)

**Interfaces:**
- Consumes: `reconcileFrontier`/`sceneWanted` (Task 3), `parseVoxel`/`snapshot`/`applyVoxel`/`liveCollision` (existing).
- Produces: `reconcileCollisions(want: number[])`, `loadVoxel(idx)`, `initCollisions()`, `snapshotIdx`, `snapshotTaken`, `voxelLoading[]`.

Design notes:
- The retained voxel set = {start-scene snapshot} ∪ {active} ∪ {active's neighbours}. Scene 0 is a valid *collision* frontier member even though it is never pin-managed (crossing back into it must swap to its field-set) — its data is the session-long snapshot, so nothing is fetched for it.
- **Snapshot race guard (new, required):** today the pristine-start-snapshot is safe by construction (nothing can call `applyVoxel` before `preloadCollisions` both snapshots and fetches). With frontier-driven fetching, a voxel can arrive and be applied *before* the live-instance poll captures the snapshot, corrupting the restore source. Fix: `swapCollision` refuses to overwrite until `snapshotTaken`, and `initCollisions` re-applies the active scene's voxel right after snapshotting.
- Dropped field-sets are plain object references to `Uint32Array`s (`nodes`/`leafData`); setting `voxels[idx] = undefined` releases them to GC.
- The in-place `VoxelCollision` mutation (`applyVoxel` on the ONE shared instance) is preserved exactly.

- [ ] **Step 1: Write the failing substring assertions** — append to the `describe('buildPortalsInjection', ...)` block in `test/portals-injection.test.ts`:

```ts
    it('frontier-manages collision voxels and guards the start snapshot', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/scene.sog'],
            portalStart: 0,
            portalCollision: ['index.voxel.json', 'scenes/1/scene.voxel.json']
        });
        expect(out).toContain('reconcileCollisions');
        expect(out).toContain('snapshotTaken');
        expect(out).not.toContain('preloadCollisions');
    });
```

Run `npx vitest run test/portals-injection.test.ts` — expected: this test fails.

- [ ] **Step 2: Add voxel frontier state** — after `var voxels = [];` (~:230) add:

```
  var voxelLoading = [];                   // scene index -> voxel fetch in flight
  var snapshotIdx = data.portalStart || 0; // scene whose field-set is the live-instance snapshot; retained all session (it is the restore source for walking back to the start and was captured, not fetched)
  var snapshotTaken = false;               // set once initCollisions captures the pristine start snapshot
```

- [ ] **Step 3: Guard `swapCollision`** — replace the function (~:297–305) with:

```js
  function swapCollision(idx) {
    var live = liveCollision();
    // Never overwrite the shared instance before the pristine start snapshot is
    // captured: the snapshot is the only restore source for the start scene.
    // initCollisions re-applies the active voxel right after snapshotting, so a
    // crossing during the startup poll still ends up in sync.
    if (!snapshotTaken || !live || !voxels[idx]) return;
    applyVoxel(live, voxels[idx]);
    // Live-update the overlay only if it is currently shown; otherwise it is
    // refreshed lazily when the user enables it (see the listener in start()).
    if (overlayEnabled()) refreshOverlay();
  }
```

- [ ] **Step 4: Replace `preloadCollisions`** (~:273–296, the whole function) with:

```js
  // Ensure scene idx's collision field-set is loaded (fetch once; concurrent
  // calls guarded). On completion: discard if the scene left the frontier while
  // fetching, and apply immediately if the user already crossed into it.
  function loadVoxel(idx) {
    if (!data.portalCollision || voxels[idx] || voxelLoading[idx]) return;
    var url = data.portalCollision[idx];
    if (!url) return;
    voxelLoading[idx] = true;
    parseVoxel(url).then(function (f) {
      voxelLoading[idx] = false;
      if (idx !== snapshotIdx && idx !== activeIndex && !sceneWanted(idx)) { return; }
      voxels[idx] = f;
      if (idx === activeIndex) swapCollision(idx);
    }).catch(function (err) {
      voxelLoading[idx] = false;
      console.warn('portal collision ' + idx + ' failed:', err);
    });
  }

  // Frontier-manage the collision field-sets: fetch voxels for the active scene
  // + its portal neighbours (scene 0 included -- crossing back into it must swap
  // to its data, which is the retained snapshot), drop the rest so their
  // Uint32Arrays can be GC'd. The start snapshot (snapshotIdx) is never dropped.
  function reconcileCollisions(want) {
    if (!data.portalCollision || data.portalCollision.length === 0) return;
    var keep = {};
    keep[snapshotIdx] = true;
    keep[activeIndex] = true;
    for (var i = 0; i < want.length; i++) { keep[want[i]] = true; }
    var neigh = (adjacency && adjacency[activeIndex]) || [];
    for (var n = 0; n < neigh.length; n++) { keep[neigh[n]] = true; }
    for (var idx = 0; idx < data.portalCollision.length; idx++) {
      if (keep[idx]) { loadVoxel(idx); } else if (voxels[idx]) { voxels[idx] = undefined; }
    }
  }

  // Startup: wait for the viewer's own (asynchronously loaded) collision
  // instance, snapshot the pristine start-scene field-set, then bring the
  // frontier in. Collision-on exports always bundle + load the instance.
  function initCollisions() {
    if (!data.portalCollision || data.portalCollision.length === 0) return;
    var live = liveCollision();
    if (!live) { requestAnimationFrame(initCollisions); return; }
    voxels[snapshotIdx] = snapshot(live);
    snapshotTaken = true;
    // If the user already crossed while we were waiting for the live instance,
    // bring collision in sync with the visuals now.
    if (activeIndex !== snapshotIdx && voxels[activeIndex]) { swapCollision(activeIndex); }
    reconcileCollisions(adjacency ? desiredResidentScenes(adjacency, activeIndex) : []);
  }
```

- [ ] **Step 5: Wire into the frontier** — two one-line edits:

(a) In `reconcileFrontier` (Task 3), insert before `pinWhenBudgetReady();`:

```js
    reconcileCollisions(want);
```

(b) In `start()`'s tail (Task 3, Step 6), replace `preloadCollisions();` with `initCollisions();`.

- [ ] **Step 6: Verify**

```bash
npx vitest run test/portals-injection.test.ts test/portal-preload.test.ts
npx tsc --noEmit
```

Expected: all pass, tsc clean.

- [ ] **Step 7: Commit**

```bash
git add src/viewer-companion/portals.ts test/portals-injection.test.ts
git commit -m "feat(portals): frontier-manage collision voxels; guard the start snapshot"
```

---

### Task 5: Incremental distance-2 warming — `computeWarmSet` + replace `warmExtraScenes`

**Files:**
- Modify: `src/portal-preload.ts` (append helper; extend export list)
- Modify: `src/viewer-companion/portals.ts` — import :3, helper injection block, delete `warmExtraScenes` (~:533–576 pre-drift) + its call (`warmExtraScenes();` just before `requestAnimationFrame(start);`), add `warmScene`/`warmFrontier`, call `warmFrontier(want)` at the end of `pinDesired`, small `pinWhenBudgetReady` SOG shortcut
- Test: `test/portal-preload.test.ts` (append), `test/portals-injection.test.ts` (rewrite the warming-assertion test)

**Interfaces:**
- Consumes: `pinDesired`'s `want` (Task 2), `fetchJson`/`warmUrls`/`collectLodFileUrls`/`collectSogBlockFileUrls`/`deviceFinest` (existing).
- Produces: `computeWarmSet(activeIdx: number, adjacency: number[][], pinnedSet: number[]): number[]` (pure, exported, stringified), runtime `warmFrontier(want)`/`warmScene(idx)`/`warmedScenes`.

Design notes:
- Warm set = neighbours of the pinned frontier (`{active} ∪ pinnedSet`) that are not themselves in it — i.e. graph distance exactly 2 from the active scene. Scene 0 (always resident) is excluded.
- Warming happens at the end of `pinDesired` (not `reconcileFrontier`) so streaming exports warm at the settled `deviceFinest` depth — warming earlier would warm at coarsest and the per-session warmed-set would then block a deeper re-warm. Each scene warms at most once per session.
- Streaming: warm `lod-meta.json → block meta.json (levels [deviceFinest..coarsest]) → webps`. SOG: warm the single `scenes/N/scene.sog` file.
- `lodMinLevelForBudget` loses its only runtime consumer: remove it from the injection block and the portals.ts import. Keep the helper + its unit tests in `src/portal-preload.ts` (exported API; other series plans may still reference it — removing it there is out of scope).
- `pinWhenBudgetReady` shortcut: for SOG exports `deviceFinest` never settles (no start octree), so the first-reconcile poll used to time out at ~600 frames (~10 s). Skip the deviceFinest requirement when the export is not streaming so SOG warming/pin-reconcile starts after ~1 s.

- [ ] **Step 1: Write the failing helper tests** — append to `test/portal-preload.test.ts` (add `computeWarmSet` to the import):

```ts
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
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run test/portal-preload.test.ts
```

Expected failure: `computeWarmSet is not a function`.

- [ ] **Step 3: Implement the helper** — in `src/portal-preload.ts`, insert after `assignPinDepths` (before the export line), and add `computeWarmSet` to the export list:

```ts
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
```

Export line becomes:

```ts
export { collectLodFileUrls, lodMinLevelForBudget, collectSogBlockFileUrls, buildPortalAdjacency, desiredResidentScenes, assignPinDepths, computeWarmSet, PortalLodMeta, PortalLodNode, PortalSogBlockMeta };
```

- [ ] **Step 4: Run tests to verify pass**

```bash
npx vitest run test/portal-preload.test.ts
```

Expected: all pass.

- [ ] **Step 5: Rewrite the injection wiring test (failing first)** — in `test/portals-injection.test.ts`, replace the test `'includes the two-level coarse-LOD cache-warming routine in the runtime'` (body and name) with:

```ts
    it('includes incremental distance-2 warming and budget-capped pinning in the runtime', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/lod-meta.json'],
            portalStart: 0
        });
        // frontier-shift warming replaces the startup warm-everything pass
        expect(out).toContain('warmFrontier');
        expect(out).toContain('computeWarmSet');
        expect(out).not.toContain('warmExtraScenes');
        // both warm stages' helpers are stringified in: lod-meta -> block-metas -> webps
        expect(out).toContain('collectLodFileUrls');
        expect(out).toContain('collectSogBlockFileUrls');
        // adjacent scenes are pinned resident at budget-capped, device-observed depths
        // and reclaimed when they leave the portal-adjacency frontier
        expect(out).toContain('assignPinDepths');
        expect(out).toContain('pinSceneToLevel');
        expect(out).toContain('incRefCount');
        expect(out).toContain('buildPortalAdjacency');
        expect(out).toContain('updateDeviceFinest');
    });
```

Run `npx vitest run test/portals-injection.test.ts` — expected: this test fails (`warmFrontier` missing, `warmExtraScenes` still present).

- [ ] **Step 6: Rewire the runtime** — in `src/viewer-companion/portals.ts`:

(a) Import (:3) — drop `lodMinLevelForBudget`, add `computeWarmSet`:

```ts
import { collectLodFileUrls, collectSogBlockFileUrls, buildPortalAdjacency, desiredResidentScenes, assignPinDepths, computeWarmSet } from '../portal-preload';
```

(b) Helper injection block — delete the line `var lodMinLevelForBudget = ${lodMinLevelForBudget.toString()};` and add after the `assignPinDepths` line:

```
  var computeWarmSet = ${computeWarmSet.toString()};
```

(c) Delete the whole `warmExtraScenes` function (the block starting at the comment `// --- preload (cache-warming) of extra streaming scenes ----------------` DOWN TO but NOT including `// Reach the streaming octree from a loaded gsplat asset` — **keep `fetchJson`, `warmUrls`, and `getSplatBudget`**, which sit inside that region: only remove the `function warmExtraScenes() { ... }` body and its section comment, replacing the section comment with the one in (d) below). Also delete the `warmExtraScenes();` call near the bottom (just before `requestAnimationFrame(start);`).

(d) Add the new warming wiring where `warmExtraScenes` was:

```js
  // --- incremental cache-warming of distance-2 scenes --------------------
  // When the frontier shifts (startup + each crossing), warm the HTTP cache for
  // scenes at graph distance 2 (neighbours of the pinned frontier that are not
  // themselves pinned): distance <= 1 is pinned resident, distance 2 becomes
  // pinned after one more crossing, so a warm cache makes that future pin fetch
  // fast. Streaming scenes warm their block files down to the device-observed
  // finest level (exactly what a future pin would fetch); SOG scenes warm the
  // single .sog bundle. Plain fetch only (nothing resident). Each scene warms at
  // most once per session. Failures are non-fatal (the loading overlay covers a
  // cold crossing). Scenes >= 3 hops away are neither resident nor warmed --
  // the accepted trade for bounded memory.
  var warmedScenes = {};
  function warmScene(idx) {
    var u = data.portalScenes[idx];
    if (!u) return;
    if (u.indexOf('lod-meta.json') === -1) { warmUrls([u]); return; }   // SOG: one bundle file
    fetchJson(u).then(function (meta) {
      var coarse = (meta && meta.lodLevels) ? meta.lodLevels - 1 : 0;
      var min = (deviceFinest !== null) ? Math.min(deviceFinest, coarse) : coarse;
      return collectLodFileUrls(meta, u, min);
    }).then(function (blockUrls) {
      return Promise.all(blockUrls.map(function (burl) {
        return fetchJson(burl)
          .then(function (bmeta) { return collectSogBlockFileUrls(bmeta, burl); })
          .catch(function (err) { console.warn('portal warm block-meta failed (' + burl + '):', err); return []; });
      }));
    }).then(function (perBlock) {
      var webpUrls = [];
      perBlock.forEach(function (arr) { for (var k = 0; k < arr.length; k++) { webpUrls.push(arr[k]); } });
      warmUrls(webpUrls);
    }).catch(function (err) { console.warn('portal warm lod-meta failed (' + u + '):', err); });
  }
  function warmFrontier(want) {
    if (!adjacency) return;
    var warmSet = computeWarmSet(activeIndex, adjacency, want);
    for (var i = 0; i < warmSet.length; i++) {
      var idx = warmSet[i];
      if (!warmedScenes[idx]) { warmedScenes[idx] = true; warmScene(idx); }
    }
  }
```

(e) At the end of `pinDesired` (after the reclaim `for (var k in pinnedScenes)` loop, inside the function), add:

```js
    // Warm here (not in reconcileFrontier): pinDesired runs once deviceFinest
    // has settled, so streaming scenes warm at the depth a future pin will fetch.
    warmFrontier(want);
```

(f) `pinWhenBudgetReady` SOG shortcut — in the poll condition (~:691), replace:

```js
      if ((getSplatBudget() && deviceFinest !== null && stableFor > 60) || waited++ > 600) {
```

with:

```js
      // SOG exports have no start octree to observe, so deviceFinest never
      // settles -- don't hold the first reconcile (and warming) ~10s for it.
      if ((getSplatBudget() && (!streaming || deviceFinest !== null) && stableFor > 60) || waited++ > 600) {
```

- [ ] **Step 7: Verify**

```bash
npx vitest run test/portals-injection.test.ts test/portal-preload.test.ts
npx tsc --noEmit
npm run test
```

Expected: everything passes (smoke test still constructs — this catches a dangling `lodMinLevelForBudget` reference if the deletion missed one), tsc clean.

- [ ] **Step 8: Commit**

```bash
git add src/portal-preload.ts src/viewer-companion/portals.ts test/portal-preload.test.ts test/portals-injection.test.ts
git commit -m "feat(portals): incremental distance-2 cache warming replaces startup warm-everything"
```

---

### Task 6: Manual E2E verification (RELEASE build, both export variants)

**Files:** none (verification only). All observations below use a release build — minification bugs in the stringified helpers only appear there.

**Setup — do all of this first:**

- [ ] **Step 1: Release build + serve the editor**

```bash
npm run build
npx serve dist -l 3000
```

Open `http://localhost:3000`.

- [ ] **Step 2: Author a 4-scene chained project** (4 scenes are needed to observe unload + crossing-warm; 3 is the bare minimum but cannot exercise either). Import four `.ply` splats. With the Portal tool, place three portals chaining them linearly: scene A ↔ B, B ↔ C, C ↔ D (each portal's front/back pointing at the right pair). Set A as the start scene. Enable collision in the export popup.

- [ ] **Step 3: Export BOTH variants** from the export popup, unzip each, and serve:
  - **SOG variant:** Package (ZIP) format → unzip → `npx serve <sog-folder> -l 3001`
  - **Streaming variant:** Streaming format → unzip → `npx serve <stream-folder> -l 3002`

**SOG variant (`http://localhost:3001`):**

- [ ] **Step 4: Startup network check.** DevTools → Network tab (keep "Disable cache" OFF), hard-reload. Expected: the start scene's own content loads; `scenes/1/scene.sog` (frontier neighbour B) loads; `scenes/2/scene.sog` (distance-2 C) loads as a *warm* fetch shortly after; `scenes/3/scene.sog` (D, 3 hops) is **NOT** fetched. Collision: `index.voxel.json/.bin` + `scenes/1/scene.voxel.*` fetched; `scenes/3/scene.voxel.*` NOT fetched.
- [ ] **Step 5: Walkthrough A→B→C→D and back.** Cross each portal walking. Expected: crossings into B and C are instant (preloaded); crossing A→B fires `scenes/3/scene.sog` warming in the Network tab (D newly at distance 2). On reaching C, scene A's extra... A is scene 0 (never unloaded), but on reaching D, scene B (`scenes/1`) leaves the frontier — verify no re-render of B and see Step 6 for memory. Walking back D→C→B→A: crossing into B re-fetches `scenes/1/scene.sog` — it must come from disk cache (fast) and, if you sprint through two portals quickly, the loading overlay (dark backdrop + spinner) may appear briefly and then reveal — this is the documented accepted behavior.
- [ ] **Step 6: Memory drop check.** DevTools → ⋮ → More tools → Performance monitor (watch "JS heap size"), plus browser Task Manager (Shift+Esc, enable the "GPU memory" column). Stand in C, note values; cross into D (B unloads). Expected within a few seconds (the engine defers the GPU free to the next rendered frames — wiggle the camera): JS heap and GPU memory drop by roughly one scene's worth. In the Memory tab you can click the GC (trash) icon to force-collect before comparing heap numbers.
- [ ] **Step 7: Collision + reset regression.** With collision on, walk into a wall in B and C (blocked = voxel swapped correctly). Enable the collision debug overlay (if exposed) after crossing — it must show the ACTIVE scene's voxels. Press `R` — camera returns to the start scene A and the viewer shows A (reset listener regression check).

**Streaming variant (`http://localhost:3002`):**

- [ ] **Step 8: Startup network check.** Hard-reload with the Network tab open. Expected: all `lod-meta.json` files fetch (small — deliberate); the start scene's blocks stream; scene B's blocks (webps) load down to the device-finest level (pin); scene C's webps appear as warm fetches after the pins settle (~1–2 s); scene D's block data does NOT load at startup. Compare with the pre-change behavior where **every** file of **every** scene downloaded at startup — that must be gone.
- [ ] **Step 9: Walkthrough + pin-cap check.** Cross A→B→C→D and back — each crossing should reveal instantly (no black, no spinner) at device-appropriate quality. Then reload with `?budget=1` appended to the URL (weak-device simulation, from the adjacency design doc's validation): startup pins far fewer blocks (Network tab), crossings remain instant within a coarser view — this validates `assignPinDepths` degrading neighbours on a tight budget.
- [ ] **Step 10: Reclaim check.** In C, note the resident block fetches; cross into D — scene B is unpinned (`decRefCount(i,0)`). Verify in the Performance monitor / Task Manager that memory steps down, and that walking back into B re-pins (block re-fetches served from disk cache, crossing near-instant).
- [ ] **Step 11: Anim-timeline spot check** (if the project has an authored camera track): play the animation — scenes swap per the baked timeline; scrub the cursor far ahead — a jump into a not-yet-loaded scene may show the overlay briefly, then reveal (new, accepted).

**Mobile pass:**

- [ ] **Step 12: DevTools mobile emulation (desktop machine).** Device toolbar → a phone profile + Network throttling "Fast 3G". Repeat the SOG walkthrough: overlay appears on cold/fast crossings and always resolves (never sticks past ~10 s); warming traffic is visible but paced (4-way concurrency cap).
- [ ] **Step 13: REAL PHONE (requires the user — cannot be verified in DevTools).** Serve the exports on the LAN (`npx serve <folder> -l 3001 --cors`, browse to `http://<pc-ip>:3001` from the phone). The following observations REQUIRE the real device:
  - **No OOM / tab reload** on the 4-scene SOG export while walking the full chain twice (the original failure mode).
  - **Device-adaptive pin depth** on the streaming export: the phone's real `splatBudget` yields a coarser `deviceFinest`, so pins are shallower — crossings must still be instant at the phone's quality level.
  - **GPU memory pressure**: no progressive slowdown/eviction over a 5-minute walkthrough.

If any step fails: STOP, capture the console + network evidence, and debug before proceeding (use `superpowers:systematic-debugging`). Do not mark this task complete on partial passes.

---

### Task 7: Final verification + squash

- [ ] **Step 1: Full gates**

```bash
npm run lint
npm run test
npx tsc --noEmit
```

Expected: lint clean (if `npm run lint` crashes with the known ESLint 10 import/order issue, do NOT attempt `--fix`; gate on `npx tsc --noEmit` and note the crash), all tests pass.

- [ ] **Step 2: Squash per project convention** — squash all commits on `feat/portal-viewer-mobile-memory` into a single commit summarizing the change (bounded portal-viewer memory: SOG frontier load/unload, budget-capped pin depths, collision-voxel frontier, incremental distance-2 warming, injection smoke test), then hand off with `superpowers:finishing-a-development-branch`. Do NOT push unless the user asks.
