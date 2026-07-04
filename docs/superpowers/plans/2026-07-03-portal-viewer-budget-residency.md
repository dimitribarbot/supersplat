# Portal Viewer Budget-Bounded Residency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep as many portal scenes resident as fit a device memory budget (frontier guaranteed, least-recently-visited evicted only under pressure) so the exported viewer never reloads scenes when it has the memory to keep them — eliminating the reload/`200` behavior for small projects on every device while staying bounded (no OOM) at any scale.

**Architecture:** One mode-agnostic pure helper `selectResidentScenes` (in `src/portal-preload.ts`, unit-tested, stringified into the injected runtime) decides *which* scenes stay resident by priority (guaranteed frontier → recently-visited → nearest-by-proximity) admitted until a `k × splatBudget` ceiling. The runtime in `src/viewer-companion/portals.ts` replaces its adjacency-only `desiredResidentScenes` calls with this, reuses the existing `assignPinDepths` for per-scene LOD depth, and applies residency per-format (streaming pins blocks at `deviceFinest`; SOG loads/unloads whole assets). The SOG export path bakes a one-element per-scene splat count so SOG participates in the same budget accounting.

**Tech Stack:** TypeScript, Vitest (Node env), PlayCanvas engine (exported-viewer runtime only), Rollup release build for E2E.

**Spec:** `docs/superpowers/specs/2026-07-03-portal-viewer-budget-residency-design.md`.

## Global Constraints

- Use Bash (Git Bash on Windows), never PowerShell. Run commands plainly from the repo root — no `cd`, `git -C`, or `npm --prefix` prefixes.
- ESLint is pinned to v10; never run `eslint --fix`. Match surrounding import order by hand. If `npm run lint` crashes on import/order, gate on `npx tsc --noEmit` and note it.
- Never delete `package-lock.json`.
- `tsconfig`: `strictNullChecks: false`, `noImplicitAny: true`. The IIFE template in `portals.ts` uses ES5 `var`/`function`; pure helpers in `portal-preload.ts` use `const` arrows.
- **Stringified helpers must be fully self-contained** — no references to sibling functions, imports, or module-level variables (terser mangles those in release builds and the stringified copy throws at runtime). Dependency-inject any sibling as a parameter.
- Any viewer-companion change MUST be E2E-verified with a **RELEASE build** (`npm run build`) — minification bugs only appear in release.
- Don't touch code unrelated to this task.
- This branch (`feat/portal-viewer-budget-residency`) is based on the Plan 3 branch (`feat/portal-viewer-mobile-memory`). All Plan 3 mechanisms (`assignPinDepths`, `pinSceneToLevel`, `unpinScene`, `loadScene`, `unloadScene`, `deviceFinest`, `getSplatBudget`, `warmFrontier`, `reconcileCollisions`) already exist.

---

### Task 0: Preflight — anchor verification + green suite

**Files:** read-only verification (branch already created).

- [ ] **Step 1: Confirm the branch**

```bash
git branch --show-current
```

Expected: `feat/portal-viewer-budget-residency`. If not, `git checkout feat/portal-viewer-budget-residency` (it was branched from `feat/portal-viewer-mobile-memory`).

- [ ] **Step 2: Verify every anchor this plan relies on**

```bash
grep -n "const desiredResidentScenes" src/portal-preload.ts                         # :205
grep -n "const assignPinDepths" src/portal-preload.ts                               # :242
grep -n "^export {" src/portal-preload.ts                                           # export list :352
grep -n "var desiredResidentScenes = " src/viewer-companion/portals.ts              # helper injection :69
grep -n "function pinDesired" src/viewer-companion/portals.ts                       # :717
grep -n "function reconcileFrontier" src/viewer-companion/portals.ts                # :855
grep -n "function switchTo" src/viewer-companion/portals.ts                         # :120
grep -n "desiredResidentScenes(adjacency, activeIndex)" src/viewer-companion/portals.ts   # call sites (initCollisions, sceneWanted, reconcileFrontier)
grep -n "function getSplatBudget" src/viewer-companion/portals.ts                   # :544
grep -n "settingsWithLods = { ...viewerSettingsJson, portalSceneLodCounts" src/splat-export-core.ts   # streaming bake :610
grep -n "injectPortals(injectOffLimitsZones(injectAnnotationLinks(new TextDecoder().decode(rawIndex)" src/splat-export-core.ts   # SOG/package bake site :721
```

Every grep must hit. If an anchor moved, read the surrounding code and adapt the snippets rather than pasting blindly.

- [ ] **Step 3: Confirm the suite is green**

```bash
npm run test
```

Expected: all pass (portal-preload, portals-injection, portal-export, portal-geom, etc.).

---

### Task 1: `selectResidentScenes` pure helper + unit tests

**Files:**
- Modify: `src/portal-preload.ts` (append helper before the export line `:352`; extend the export list)
- Test: `test/portal-preload.test.ts` (append; add `selectResidentScenes` to the import at `:3`)

**Interfaces:**
- Produces: `selectResidentScenes(adjacency: number[][], activeIdx: number, recencyOrder: number[], sceneCosts: number[], ceiling: number): number[]` — the sorted, de-duplicated set of **extra** scene indices (≥ 1) to keep resident. Scene 0 (the viewer's own start scene) is never returned. Pure, self-contained, stringified into the runtime in Task 2.
- Consumes: nothing from other tasks.

Semantics: admit scenes in priority order until the running summed cost would exceed `ceiling`: (1) **guaranteed** — active + its immediate portal neighbours, admitted even past the ceiling; (2) **recently-visited** from `recencyOrder` (most-recent first); (3) **remaining by BFS distance** from active (nearer first, index tiebreak). `sceneCosts[i]` is scene i's resident cost in splats; a missing/≤0 cost is treated as free (admitted). When `ceiling <= 0` (budget unknown) only the guaranteed set is admitted (conservative).

- [ ] **Step 1: Add `selectResidentScenes` to the test import** — in `test/portal-preload.test.ts`, change the import line (`:3`):

```ts
import { collectLodFileUrls, lodMinLevelForBudget, collectSogBlockFileUrls, buildPortalAdjacency, desiredResidentScenes, assignPinDepths, computeWarmSet, selectResidentScenes } from '../src/portal-preload';
```

- [ ] **Step 2: Write the failing tests** — append to `test/portal-preload.test.ts`:

```ts
describe('selectResidentScenes', () => {
    // linear chain 0-1-2-3-4 ; adjacency[s] = neighbours of s
    const chain = [[1], [0, 2], [1, 3], [2, 4], [3]];
    const cost = (n: number) => Array(n).fill(100);   // every scene costs 100

    it('keeps every reachable scene when the ceiling is ample', () => {
        // active 2, huge ceiling -> all extra scenes 1..4 resident (scene 0 excluded)
        expect(selectResidentScenes(chain, 2, [], cost(5), 100000)).toEqual([1, 2, 3, 4]);
    });

    it('admits only the guaranteed frontier when the ceiling is tight', () => {
        // active 2: guaranteed = 2 + neighbours {1,3}; ceiling below a 4th scene's cost
        // guaranteed cost = 300 (scenes 1,2,3); ceiling 350 -> scene 4 (dist 2) does not fit
        expect(selectResidentScenes(chain, 2, [], cost(5), 350)).toEqual([1, 2, 3]);
    });

    it('admits the guaranteed set even when it exceeds the ceiling', () => {
        // ceiling smaller than the guaranteed cost -> still keep active + neighbours
        expect(selectResidentScenes(chain, 2, [], cost(5), 10)).toEqual([1, 2, 3]);
    });

    it('prefers a recently-visited scene over an equally-distant unvisited one', () => {
        // active 0: guaranteed output = {1} (scene 0 never admitted), cost 100.
        // ceiling 200 fits exactly ONE more scene. recencyOrder [3] -> the farther
        // scene 3 (dist 3) wins the slot over the nearer BFS scene 2 (dist 2).
        expect(selectResidentScenes(chain, 0, [3], cost(5), 200)).toEqual([1, 3]);
    });

    it('fills remaining budget by BFS proximity (nearer first)', () => {
        // active 0, no recency: guaranteed {1} (cost 100); ceiling 250 fits exactly
        // one more -> nearest unvisited is 2 (dist 2); 3 (dist 3, cost 300) does not fit.
        expect(selectResidentScenes(chain, 0, [], cost(5), 250)).toEqual([1, 2]);
    });

    it('never returns scene 0', () => {
        expect(selectResidentScenes(chain, 1, [0], cost(5), 100000)).not.toContain(0);
    });

    it('treats a missing/zero cost as free (admitted)', () => {
        // costs only defined for some scenes; undefined -> free
        expect(selectResidentScenes(chain, 2, [], [0, 0, 0], 1)).toEqual([1, 2, 3, 4]);
    });

    it('with an unknown ceiling (<= 0) keeps only the guaranteed frontier', () => {
        expect(selectResidentScenes(chain, 2, [4], cost(5), 0)).toEqual([1, 2, 3]);
    });

    it('returns [] for an out-of-range active scene or missing adjacency', () => {
        expect(selectResidentScenes(chain, 9, [], cost(5), 100000)).toEqual([]);
        expect(selectResidentScenes(null as any, 0, [], [], 100000)).toEqual([]);
    });
});
```

- [ ] **Step 3: Run to verify failure**

```bash
npx vitest run test/portal-preload.test.ts
```

Expected: `selectResidentScenes is not a function` (the new block fails).

- [ ] **Step 4: Implement the helper** — in `src/portal-preload.ts`, insert **before** the `export {` line (`:352`):

```ts
// Choose which EXTRA scenes (index >= 1) to keep resident, in priority order,
// until the summed per-scene cost would exceed `ceiling`:
//   1. guaranteed: the active scene + its immediate portal neighbours (admitted
//      even past the ceiling -- an immediate crossing must land on a resident scene);
//   2. recently-visited scenes, most-recent first (recencyOrder);
//   3. remaining scenes by BFS graph distance from active (nearer first, then index).
// A candidate after the guaranteed set is admitted only if its cost still fits.
// sceneCosts[i] is scene i's resident cost in splats (streaming: whole-scene count
// at deviceFinest; SOG: full count). A missing / <= 0 cost is treated as free.
// When ceiling <= 0 (budget not yet known) only the guaranteed set is admitted.
// Scene 0 (the viewer's own always-resident start scene) is never returned.
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
        if (i < 1 || admitted[i]) {
            return;
        }
        const c = costOf(i);
        if (!forced && (ceiling <= 0 || cost + c > ceiling)) {
            return;
        }
        admitted[i] = true;
        cost += c;
    };
    // 1. guaranteed: active + immediate neighbours
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
```

Change the export line (`:352`) to add `selectResidentScenes`:

```ts
export { collectLodFileUrls, lodMinLevelForBudget, collectSogBlockFileUrls, buildPortalAdjacency, desiredResidentScenes, assignPinDepths, computeWarmSet, selectResidentScenes, PortalLodMeta, PortalLodNode, PortalSogBlockMeta };
```

- [ ] **Step 5: Run tests to verify pass**

```bash
npx vitest run test/portal-preload.test.ts
```

Expected: all pass (existing + 9 new).

- [ ] **Step 6: Commit**

```bash
git add src/portal-preload.ts test/portal-preload.test.ts
git commit -m "feat(portals): selectResidentScenes budget-priority resident-set helper"
```

---

### Task 2: Runtime wiring — budget-bounded residency

**Files:**
- Modify: `src/viewer-companion/portals.ts` — import (`:3`); helper injection block (after `:69`); new state + helpers; replace `desiredResidentScenes(...)` call sites; `pinDesired` (`:717`); `switchTo` (`:120`) + `start()` recency hook.
- Test: `test/portals-injection.test.ts` (substring assertions; smoke test guards syntax)

**Interfaces:**
- Consumes: `selectResidentScenes` (Task 1); existing `assignPinDepths`, `getSplatBudget`, `deviceFinest`, `adjacency`, `data.portalSceneLodCounts`, `data.portalScenes`.
- Produces: runtime `residentScenes()`, `sceneCosts()`, `getResidentCeiling()`, `noteVisit()`, `recency`.

This is IIFE template wiring — not unit-testable. Coverage = the injection smoke test (construction) + substring assertions + `tsc` + Task 4's release E2E.

- [ ] **Step 1: Write the failing substring assertions** — append a test inside the `describe('buildPortalsInjection', ...)` block in `test/portals-injection.test.ts`:

```ts
    it('drives residency from a device budget (selectResidentScenes wired in)', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/lod-meta.json'],
            portalStart: 0
        });
        expect(out).toContain('selectResidentScenes');
        expect(out).toContain('getResidentCeiling');
        expect(out).toContain('residentScenes');
        // still budget-capped for per-scene depth, still pins/reclaims
        expect(out).toContain('assignPinDepths');
        expect(out).toContain('pinSceneToLevel');
    });
```

Run `npx vitest run test/portals-injection.test.ts` — expected: this test fails.

- [ ] **Step 2: Import the helper** — in `src/viewer-companion/portals.ts` (`:3`), add `selectResidentScenes`:

```ts
import { collectLodFileUrls, collectSogBlockFileUrls, buildPortalAdjacency, desiredResidentScenes, assignPinDepths, computeWarmSet, selectResidentScenes } from '../portal-preload';
```

(Keep `desiredResidentScenes` in the import — it is still stringified in the injection block even though the runtime stops calling it directly; leaving it avoids touching the unrelated injection line. If lint flags it as unused, remove it from the import AND delete its `var desiredResidentScenes = ...` injection line together.)

- [ ] **Step 3: Inject the helper into the runtime** — after the line `var desiredResidentScenes = ${desiredResidentScenes.toString()};` (`:69`) add:

```
  var selectResidentScenes = ${selectResidentScenes.toString()};
```

- [ ] **Step 4: Add runtime state + helpers** — find the state var block (near `var pinDepth = [];`, `:87`) and add after it:

```
  var recency = [];                         // scene indices, most-recently-active first (LRU)
  var RESIDENT_BUDGET_MULT = 3;             // resident ceiling = MULT x the engine splat budget (device-adaptive proxy; no web VRAM API). Tune on-device.
  var residentBudgetOverride = (function () {
    // ?residentBudget=<n> overrides the ceiling for on-device tuning.
    try {
      var m = /[?&]residentBudget=(\d+)/.exec(location.search || '');
      return m ? parseInt(m[1], 10) : 0;
    } catch (e) { return 0; }
  })();
```

Then add these functions near `getSplatBudget` (`:544`):

```
  // Total resident splats we allow across all kept scenes. A conservative
  // multiple of the engine's render budget (device-adaptive; errs toward
  // evicting since the web exposes no VRAM API). 0 until the budget is known.
  function getResidentCeiling() {
    if (residentBudgetOverride > 0) { return residentBudgetOverride; }
    var b = getSplatBudget();
    return b > 0 ? b * RESIDENT_BUDGET_MULT : 0;
  }
  // Per-scene resident cost in splats: streaming = whole-scene count at the
  // device-finest level [deviceFinest..coarsest]; SOG = its single baked count.
  // 0 (free) when no count is baked (older SOG exports).
  function sceneCost(idx) {
    var counts = (data.portalSceneLodCounts || [])[idx];
    if (!counts || !counts.length) { return 0; }
    var coarse = counts.length - 1;
    var lv = (deviceFinest !== null) ? Math.min(Math.max(deviceFinest, 0), coarse) : coarse;
    var sum = 0;
    for (var i = lv; i < counts.length; i++) { sum += (counts[i] || 0); }
    return sum;
  }
  function sceneCosts() {
    var arr = [];
    for (var i = 0; i < data.portalScenes.length; i++) { arr[i] = sceneCost(i); }
    return arr;
  }
  // The budget-bounded resident set for the LIVE activeIndex (replaces Plan 3's
  // adjacency-only desiredResidentScenes across the reconcile paths).
  function residentScenes() {
    return selectResidentScenes(adjacency, activeIndex, recency, sceneCosts(), getResidentCeiling());
  }
  // Track most-recently-active order for LRU eviction under a tight budget.
  function noteVisit(idx) {
    var i = recency.indexOf(idx);
    if (i >= 0) { recency.splice(i, 1); }
    recency.unshift(idx);
  }
```

- [ ] **Step 5: Replace the `desiredResidentScenes` call sites** — every runtime call `desiredResidentScenes(adjacency, activeIndex)` becomes `residentScenes()`. There are three (in `initCollisions`, `sceneWanted`, `reconcileFrontier`). Apply each:

In `reconcileFrontier` (`:857`):

```js
    var want = residentScenes();
```

In `sceneWanted` (the line `var want = desiredResidentScenes(adjacency, activeIndex);`):

```js
    var want = residentScenes();
```

In `initCollisions` (`:335`, currently `reconcileCollisions(adjacency ? desiredResidentScenes(adjacency, activeIndex) : []);`):

```js
    reconcileCollisions(adjacency ? residentScenes() : []);
```

- [ ] **Step 6: Update `pinDesired`** (`:717`) — replace the frontier + depth computation. Change the two lines:

```js
    var want = desiredResidentScenes(adjacency, active);
```

to:

```js
    var want = residentScenes();
```

and the `assignPinDepths(...)` call:

```js
    var depths = assignPinDepths(
      active,
      adjacency[active] || [],
      data.portalSceneLodCounts || [],
      deviceFinest,
      getSplatBudget()
    );
```

to (feed the FULL resident set as candidates, and cap to the RESIDENT ceiling so scenes stay at `deviceFinest` while they fit — `assignPinDepths` already skips the active idx and dedups):

```js
    var depths = assignPinDepths(
      active,
      want,
      data.portalSceneLodCounts || [],
      deviceFinest,
      getResidentCeiling()
    );
```

(The rest of `pinDesired` — the `wantSet` pin loop, the reclaim loop, and the trailing `warmFrontier(want)` — is unchanged; `want` is now the budget-bounded set, so warming naturally targets distance-2 from it.)

- [ ] **Step 7: Record visits for LRU** — in `switchTo` (`:120`), after `activeIndex = idx;`, add:

```js
    noteVisit(idx);
```

And in `start()`, right where the initial `applyActive();` runs before the first `reconcileFrontier()` (search for the `applyActive();` immediately preceding `reconcileFrontier();` in `start`), add a seed visit just before it:

```js
    noteVisit(activeIndex);
```

- [ ] **Step 8: Verify**

```bash
npx vitest run test/portals-injection.test.ts test/portal-preload.test.ts
npx tsc --noEmit
```

Expected: all pass (smoke test still constructs; the Step 1 substring test passes), tsc clean.

- [ ] **Step 9: Commit**

```bash
git add src/viewer-companion/portals.ts test/portals-injection.test.ts
git commit -m "feat(portals): budget-bounded residency replaces adjacency-only frontier"
```

---

### Task 3: Bake a per-scene splat count for SOG exports

**Files:**
- Modify: `src/splat-export-core.ts` — the Package (ZIP) branch (`:721`) so SOG exports bake `portalSceneLodCounts` (one element per scene) into the portal payload, unifying budget accounting with streaming.
- Test: `test/portal-preload.test.ts` already covers single-element counts via `selectResidentScenes`/`sceneCost` semantics; the export bake itself is verified by Task 4 E2E (the export pipeline needs a GPU device and is not unit-tested here).

**Interfaces:**
- Consumes: nothing new. Produces: SOG payload now carries `portalSceneLodCounts = [[primaryCount], [extraCount], ...]`; the runtime `sceneCost` (Task 2) already reads it.

Context: the streaming path already bakes `portalSceneLodCounts` (`:610`). The Package path (`:721`) calls `injectPortals(..., viewerSettingsJson)` with no counts, so SOG scenes were previously treated as "free/uncapped." `DataTable.numRows` is a scene's splat count.

- [ ] **Step 1: Build and pass the SOG counts** — in `src/splat-export-core.ts`, in the Package branch, replace the injection line (`:721`):

```js
            const injected = injectPortals(injectOffLimitsZones(injectAnnotationLinks(new TextDecoder().decode(rawIndex), viewerSettingsJson), viewerSettingsJson), viewerSettingsJson);
```

with (bake a one-element per-scene count only when there are portal scenes; otherwise leave settings untouched):

```js
            const sogSettings = hasPortalScenes
                ? { ...viewerSettingsJson, portalSceneLodCounts: [[dataTable.numRows], ...(extraScenes!.map(s => [s.dataTable.numRows]))] }
                : viewerSettingsJson;
            const injected = injectPortals(injectOffLimitsZones(injectAnnotationLinks(new TextDecoder().decode(rawIndex), sogSettings), sogSettings), sogSettings);
```

(`hasPortalScenes` and `extraScenes` are already in scope in this branch — see `:670` and `:730`.)

- [ ] **Step 2: Typecheck + full test run**

```bash
npx tsc --noEmit
npm run test
```

Expected: tsc clean, all tests pass (no runtime test change — the count shape is exercised by Task 1's single-element cases and validated end-to-end in Task 4).

- [ ] **Step 3: Commit**

```bash
git add src/splat-export-core.ts
git commit -m "feat(portals): bake per-scene splat count for SOG exports (unified residency budget)"
```

---

### Task 4: Manual E2E verification (RELEASE build, both variants)

**Files:** none (verification only). All observations use a **release build** — minification bugs in the stringified helpers only appear there.

- [ ] **Step 1: Release build + serve the editor**

```bash
npm run build
npx serve dist -l 3000
```

Open `http://localhost:3000`.

- [ ] **Step 2: Author a 4-scene chained project.** Import four `.ply` splats; place three portals chaining them A↔B, B↔C, C↔D; set A as start; enable collision. (4 scenes exercise a non-frontier scene that would previously evict.)

- [ ] **Step 3: Export BOTH variants**, unzip, serve:
  - Streaming: → `npx serve <stream-folder> -l 3002`
  - Package (SOG): → `npx serve <sog-folder> -l 3001`

- [ ] **Step 4: Streaming — no-reload check (the core fix).** Open `http://localhost:3002`, DevTools Network tab (Disable cache OFF), hard-reload. Walk A→B→C→D and back D→C→B→A. Expected: after the initial startup loads settle, **crossing back does NOT trigger new `200` block fetches** — every scene stayed resident (4 scenes fit the desktop budget). Compare to Plan 3 where crossing back re-fetched. Memory (Performance monitor) stays flat while walking the chain repeatedly.

- [ ] **Step 5: Streaming — tight-budget eviction check.** Reload with `?residentBudget=200000` (or a value below the sum of all scenes at `deviceFinest`). Expected: only the frontier + nearest scenes stay resident; walking far and back re-pins evicted scenes (block `200`s reappear) — proving LRU eviction engages under a tight ceiling while crossings remain instant at the frontier. Memory stays bounded.

- [ ] **Step 6: Package (SOG) — no-reload check.** Open `http://localhost:3001`, Network tab, hard-reload. Expected: all four `scene.sog` load once at startup (budget ample on desktop) and **do not re-fetch** on re-crossing. With `?residentBudget=<small>`, confirm SOG scenes now evict + reload under the tight ceiling (proves the baked SOG count is honored — previously SOG was uncapped).

- [ ] **Step 7: Collision + reset regression.** With collision on, walk into walls in B and C (blocked = correct voxel swap). Press `R` — returns to start scene A.

- [ ] **Step 8: Real-device ceiling tuning (needs the user + a phone).** Serve on the LAN (`npx serve <stream-folder> -l 3002 --cors`, browse from the phone). Confirm: no OOM / tab reload over a 5-minute walkthrough of the 4-scene streaming export; crossings instant at the phone's `deviceFinest`. If memory pressure appears, lower `RESIDENT_BUDGET_MULT` (Task 2 Step 4) and rebuild; if crossings reload unnecessarily with headroom to spare, raise it. Record the value that holds no-OOM with the fewest reloads.

If any step fails: STOP, capture console + network evidence, and debug with `superpowers:systematic-debugging` before proceeding.

---

### Task 5: Final verification + squash

- [ ] **Step 1: Full gates**

```bash
npm run lint
npm run test
npx tsc --noEmit
```

Expected: lint clean (if `npm run lint` crashes on the known ESLint 10 import/order issue, do NOT `--fix`; gate on `npx tsc --noEmit` and note the crash), all tests pass.

- [ ] **Step 2: Squash + hand off.** Squash all commits on `feat/portal-viewer-budget-residency` into one summarizing the change (budget-bounded scene residency: `selectResidentScenes` priority admission, runtime recency + `k × splatBudget` ceiling + `?residentBudget=` override, SOG per-scene count bake), then hand off with `superpowers:finishing-a-development-branch`. Do NOT push unless the user asks. Note the tuned `RESIDENT_BUDGET_MULT` from Task 4 Step 8 in the commit message.
