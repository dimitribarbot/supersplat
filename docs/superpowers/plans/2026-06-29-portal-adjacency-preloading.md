# Portal Adjacency Pre-loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a portal crossing in the exported streaming viewer show device-appropriate quality *instantly* (no black, no extreme-blur gap) by keeping each scene's portal-adjacent neighbours resident at the device LOD depth, and reclaiming memory from scenes that are no longer adjacent.

**Architecture:** The injected companion (`src/viewer-companion/portals.ts`) already creates one disabled gsplat per extra scene and swaps the visible scene on crossing. This plan replaces the "pin coarsest only" preload with an **adjacency-driven resident set**: pin every scene reachable by one portal from the active scene down to the device-budget LOD level (`lodMinLevelForBudget`), reveal a crossed-into scene clamped to that level (decode-free, already resident → instant), and `decRefCount(i, 0)` to evict scenes that fall out of the adjacency frontier. The graph/decision logic is extracted into pure, unit-tested helpers in `src/portal-preload.ts`; only the engine glue lives in the (non-unit-testable) injected runtime string.

**Tech Stack:** TypeScript, PlayCanvas engine v2.19.2 (WebGPU), Vitest (Node env), Rollup. The companion is stringified into the exported HTML via `Function.toString()`, so its body is plain ES5-ish JS inside a template literal (terser does **not** minify the template contents).

## Global Constraints

- **No lint gate.** `npm run lint` crashes repo-wide (ESLint 10 import/order). Gate on `./node_modules/.bin/tsc --noEmit` + targeted `npx vitest run` instead. Leave import ordering untouched.
- **Bash (Git Bash), no `cd`/`git -C`/`npm --prefix`** pointing at the cwd (permission prompts). Run commands plainly from repo root.
- **Runtime string is not unit-testable.** Logic inside the `companionRuntime` template literal cannot be imported. Put every testable decision in pure helpers in `src/portal-preload.ts`; the runtime only calls engine APIs + those helpers. Runtime integration is verified by a RELEASE build + a manual E2E with temporary `[prof]` probes (the established pattern for this companion).
- **Engine LOD ordering:** level `0` = finest, `lodLevels-1` = coarsest. `portalSceneLodCounts[scene][0]` = finest count … `[last]` = coarsest. `octree.files[i].lodLevel` uses the same 0=finest ordering. These indices are directly comparable.
- **Memory model:** pinned (`incRefCount`) blocks never age out; a disabled scene has no render instance so its cooldown never ticks (`GSplatManager` L136452-136463). Reclaim is therefore explicit: `octree.decRefCount(i, 0)` → immediate `unloadResource(i)` when our pin was the last ref (engine src L133331-133345). Refcounting protects an active scene: its render instance holds its own ref, so `decRefCount(i,0)` only frees blocks nothing else needs.
- **Scene 0 is viewer-owned and always resident.** Pin/reclaim management applies only to extra scenes (index ≥ 1). Do not touch scene 0's component LOD range or evict its blocks (the viewer's `applyPerfSettings` owns it).

---

## Design decisions baked into this plan (review before executing)

1. **Reveal = uniform device-depth floor, fully instant, no further streaming.** On crossing into scene X we set `lodRangeMin = deviceLevel(X)`, `lodRangeMax = 1000`. Because levels `[deviceLevel..coarsest]` are pinned resident, the engine selects per-node among them with **zero cold streaming** → instant. We do **not** re-open `lodRangeMin` to 0. Trade-off: an extra scene's near-camera detail is capped at the device-budget level, so it can look marginally less crisp up-close than the start scene (which the viewer runs at `lodRangeMin = 0` within `splatBudget`). This is a subtle quality difference, **not** a black/extreme-blur gap. *Optional follow-up if parity is wanted:* after `OPEN_DELAY` frames set `lodRangeMin = 0` to let near nodes refine within budget (a small, bounded cold stream). Left out of v1 for simplicity (YAGNI).
2. **Adjacency frontier = active scene + its one-portal neighbours.** Pinned set = `({active} ∪ neighbours(active)) ∩ {scene ≥ 1}`. Peak resident ≈ scene0(viewer) + active + Σ neighbours(device depth). Bounded by graph degree, not total scene count.
3. **Cache-warming (`warmExtraScenes`) stays.** It is browser-cache-only (zero resident memory) and still helps a *non-adjacent* scene's eventual pin load from disk instead of the network. Unchanged.
4. **Scene 0 stays resident even when far from it.** Reclaiming the viewer-owned start scene is out of scope (risk of fighting the viewer's instance). One scene's fixed overhead. Noted as future work.

---

## File Structure

- `src/portal-preload.ts` — **modify.** Add two pure helpers: `buildPortalAdjacency`, `desiredResidentScenes`. Keep existing `lodMinLevelForBudget` / `collect*` exports. Stringifiable (no imports, no sibling calls) so they can be injected into the runtime.
- `test/portal-preload.test.ts` — **modify.** Add unit tests for the two new helpers.
- `src/viewer-companion/portals.ts` — **modify.** (a) import + stringify the two new helpers into the runtime; (b) replace `pinSceneCoarse` with `pinSceneToLevel` (pin `lodLevel ≥ minLevel`); (c) add `unpinScene` (reclaim via `decRefCount(i,0)`); (d) reveal-clamp at `deviceLevel`; (e) maintain the adjacency-driven `pinnedScenes` lifecycle in `start()` + `switchTo`; (f) remove the temporary `[prof]` probes at the end.

No editor / server / export-format changes. The payload already carries `portals` (with `front`/`back` scene indices), `portalScenes`, `portalSceneLodCounts`.

---

### Task 1: Pure adjacency helpers (`buildPortalAdjacency`, `desiredResidentScenes`)

**Files:**
- Modify: `src/portal-preload.ts` (add two helpers + exports)
- Test: `test/portal-preload.test.ts` (add a describe block)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `buildPortalAdjacency(portals: { front: number; back: number }[], sceneCount: number): number[][]` — `adjacency[s]` = sorted, de-duplicated list of scenes sharing a portal with `s`. Ignores portals whose `front`/`back` is out of `[0, sceneCount)` or where `front === back`.
  - `desiredResidentScenes(adjacency: number[][], active: number): number[]` — sorted, de-duplicated list of **extra** scene indices (`≥ 1`) in `{active} ∪ adjacency[active]`. Excludes scene 0. Empty array if `active` is out of range.

- [ ] **Step 1: Write the failing tests**

Add to `test/portal-preload.test.ts`:

```ts
import { buildPortalAdjacency, desiredResidentScenes } from '../src/portal-preload';

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/portal-preload.test.ts`
Expected: FAIL — `buildPortalAdjacency is not a function` / `desiredResidentScenes is not a function`.

- [ ] **Step 3: Implement the helpers**

Add to `src/portal-preload.ts` (before the final `export {`):

```ts
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
```

Update the final export line to include them:

```ts
export { collectLodFileUrls, lodMinLevelForBudget, collectSogBlockFileUrls, buildPortalAdjacency, desiredResidentScenes, PortalLodMeta, PortalLodNode, PortalSogBlockMeta };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/portal-preload.test.ts`
Expected: PASS (existing tests + the new ones).

- [ ] **Step 5: Typecheck**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/portal-preload.ts test/portal-preload.test.ts
git commit -m "feat(portals): pure portal-adjacency + desired-resident helpers"
```

---

### Task 2: Device-depth pin + reveal-clamp in the runtime

Replace "pin coarsest only" with "pin down to the device-budget level", and reveal a crossed-into scene clamped to that level. This is engine glue inside the `companionRuntime` template literal in `src/viewer-companion/portals.ts` — verified by build + probe E2E, not unit tests.

**Files:**
- Modify: `src/viewer-companion/portals.ts`

**Interfaces:**
- Consumes (Task 1): `buildPortalAdjacency`, `desiredResidentScenes` (imported + stringified; wired in Task 4). `lodMinLevelForBudget` (already imported/stringified).
- Produces (for Tasks 3-4):
  - `sceneMinLevel[idx]` — number, the pinned device-depth level for scene `idx` (its `lodRangeMin` on reveal). `undefined` for SOG / not-yet-loaded.
  - `pinnedFiles[idx]` — number[], the octree file indices we `incRefCount`-ed for scene `idx` (so Task 3 can `decRefCount` exactly those).
  - `octrees[idx]` — the scene's `GSplatOctree` (or null for SOG).
  - `pinSceneToLevel(asset, idx, minLevel)` — pins files with `lodLevel >= minLevel`, records `pinnedFiles[idx]`, re-polls `ensureFileResource` until resident, then `readyScenes[idx] = true`.
  - `deviceMinLevel(idx)` — number; `lodMinLevelForBudget(counts, budget)` for scene `idx`, or `coarsest` when counts/budget unknown.

- [ ] **Step 1: Add the import** (top of `src/viewer-companion/portals.ts`)

```ts
import { collectLodFileUrls, lodMinLevelForBudget, collectSogBlockFileUrls, buildPortalAdjacency, desiredResidentScenes } from '../portal-preload';
```

- [ ] **Step 2: Stringify the two new helpers into the runtime**

In the `companionRuntime` template, next to the existing `lodMinLevelForBudget` stringify line, add:

```js
  var buildPortalAdjacency = ${buildPortalAdjacency.toString()};
  var desiredResidentScenes = ${desiredResidentScenes.toString()};
```

- [ ] **Step 3: Add per-scene state arrays**

Next to `var comps = [];` / `var coarseLevel = [];`, add:

```js
  var octrees = [];                         // scene index -> GSplatOctree (or null for SOG)
  var pinnedFiles = [];                     // scene index -> [octree file indices we incRefCount-ed]
  var sceneMinLevel = [];                   // scene index -> device-depth level (its reveal lodRangeMin)
```

- [ ] **Step 4: Add `deviceMinLevel` + replace `pinSceneCoarse` with `pinSceneToLevel`**

Replace the entire `pinSceneCoarse` function with:

```js
  // Device-budget LOD depth for an extra scene: the finest level whose count
  // fits the live splat budget (lodMinLevelForBudget), or the coarsest when the
  // counts/budget are unknown. This is both how deep we pin and the lodRangeMin
  // we reveal at.
  function deviceMinLevel(idx) {
    var octree = octrees[idx];
    var coarse = (octree && octree.lodLevels) ? octree.lodLevels - 1 : 0;
    var counts = (data.portalSceneLodCounts || [])[idx];
    var budget = getSplatBudget();
    if (!counts || !counts.length || !budget) { return coarse; }
    return lodMinLevelForBudget(counts, budget);
  }

  // Pin LOD levels [minLevel .. coarsest] of an extra streaming scene RESIDENT
  // (decoded, in GPU) via the engine's octree loader, so a crossing into it shows
  // device-appropriate quality with no cold streaming. incRefCount first so the
  // files never enter the unload cooldown, then re-poll ensureFileResource each
  // frame until they are resident (a disabled scene has no render instance to poll
  // it). Records the pinned file indices for later reclaim. SOG scenes (no octree)
  // are a no-op. Idempotent-ish: skips files already pinned for this scene.
  function pinSceneToLevel(asset, idx, minLevel) {
    var octree = getOctree(asset);
    octrees[idx] = octree || null;
    if (!octree || !octree.lodLevels || !octree.files ||
        !octree.incRefCount || !octree.ensureFileResource || !octree.getFileResource) { return; }
    if (!pinnedFiles[idx]) { pinnedFiles[idx] = []; }
    var already = {};
    for (var p = 0; p < pinnedFiles[idx].length; p++) { already[pinnedFiles[idx][p]] = true; }
    var added = [];
    for (var i = 0; i < octree.files.length; i++) {
      var f = octree.files[i];
      if (f && f.lodLevel >= minLevel && !already[i]) {
        try { octree.incRefCount(i); pinnedFiles[idx].push(i); added.push(i); }
        catch (e) { console.warn('portal pin block ' + i + ' (scene ' + idx + ') failed:', e); }
      }
    }
    if (added.length === 0 && pinnedFiles[idx].length === 0) { return; }
    var frames = 0;
    (function awaitResident() {
      var allResident = true;
      for (var j = 0; j < pinnedFiles[idx].length; j++) {
        octree.ensureFileResource(pinnedFiles[idx][j]);
        if (!octree.getFileResource(pinnedFiles[idx][j])) { allResident = false; }
      }
      if (allResident) { readyScenes[idx] = true; return; }
      if (frames++ < 600) { requestAnimationFrame(awaitResident); }
    })();
  }
```

- [ ] **Step 5: Reveal-clamp at the device level (update `scheduleRefine` + the creation-time clamp)**

In `scheduleRefine`, replace the body that clamps to `coarseLevel[idx]` and re-opens, with a clamp to the device level and **no** re-open:

```js
  function scheduleRefine(idx) {
    if (idx === 0) return;                                   // start scene is the viewer's own
    var comp = comps[idx];
    if (!comp) return;
    var min = (sceneMinLevel[idx] != null) ? sceneMinLevel[idx] : deviceMinLevel(idx);
    sceneMinLevel[idx] = min;
    comp.lodRangeMin = min;                                  // floor at device-depth (all pinned resident -> instant)
    comp.lodRangeMax = 1000;                                 // allow coarser for far nodes (also pinned)
    var app = getApp(window.__supersplatViewer);
    if (app) app.renderNextFrame = true;
  }
```

(Delete `OPEN_DELAY`, `refineSeq`, and the `openSoon` IIFE — the device-depth reveal is already its final state, so there is nothing to open. Delete the `coarseLevel` array and its creation-time assignment.)

In the scene-creation callback (`loadFromUrl`), replace the coarsest-clamp + `pinSceneCoarse` block with device-depth pin + clamp:

```js
          e.enabled = (idx === activeIndex);
          entities[idx] = e;
          comps[idx] = comp;
          octrees[idx] = getOctree(asset);
          // Pinning + reveal happen here only if this scene is in the initial
          // resident set; Task 4's pinDesired() drives that. Always record the
          // device level so a later pin/reveal has it.
          sceneMinLevel[idx] = deviceMinLevel(idx);
          if (comp && octrees[idx]) {
            comp.lodRangeMin = sceneMinLevel[idx];
            comp.lodRangeMax = 1000;
          }
          if (idx === activeIndex) scheduleRefine(idx);
```

(The actual `pinSceneToLevel` call moves to Task 4's `pinDesired`. Leaving a freshly created non-resident scene un-pinned is correct — it gets pinned when it enters the adjacency frontier.)

- [ ] **Step 6: Typecheck + build**

Run: `./node_modules/.bin/tsc --noEmit && npm run build`
Expected: tsc exit 0; build "created dist".

- [ ] **Step 7: Commit**

```bash
git add src/viewer-companion/portals.ts
git commit -m "feat(portals): pin extra scenes to device LOD depth, reveal clamped there"
```

---

### Task 3: Reclaim helper (`unpinScene`)

Free a non-adjacent scene's pinned blocks via the engine's explicit immediate-unload path. Engine glue; probe-verified.

**Files:**
- Modify: `src/viewer-companion/portals.ts`

**Interfaces:**
- Consumes (Task 2): `octrees[idx]`, `pinnedFiles[idx]`, `readyScenes`, `sceneMinLevel`.
- Produces (Task 4): `unpinScene(idx)` — `decRefCount(i, 0)` each file in `pinnedFiles[idx]`, clears `pinnedFiles[idx]`, and resets `readyScenes[idx]` so a future crossing re-arms loading.

- [ ] **Step 1: Add `unpinScene`** (next to `pinSceneToLevel`)

```js
  // Reclaim an extra scene's pinned blocks. decRefCount(i, 0) routes to the
  // octree's immediate unloadResource when our pin was the last ref (a disabled
  // scene has no render instance, so nothing else holds these). An ACTIVE scene's
  // instance holds its own ref, so this never frees blocks it is still rendering
  // (count stays > 0). Clears our bookkeeping and marks the scene not-ready so a
  // later crossing into it re-pins/loads. Engine cooldown never ticks a disabled
  // octree, so this explicit call is the only way to free a hidden scene's memory.
  function unpinScene(idx) {
    var octree = octrees[idx];
    var files = pinnedFiles[idx];
    if (octree && octree.decRefCount && files) {
      for (var i = 0; i < files.length; i++) {
        try { octree.decRefCount(files[i], 0); }
        catch (e) { console.warn('portal unpin block ' + files[i] + ' (scene ' + idx + ') failed:', e); }
      }
    }
    pinnedFiles[idx] = [];
    readyScenes[idx] = false;
  }
```

- [ ] **Step 2: Typecheck + build**

Run: `./node_modules/.bin/tsc --noEmit && npm run build`
Expected: tsc exit 0; build "created dist".

- [ ] **Step 3: Commit**

```bash
git add src/viewer-companion/portals.ts
git commit -m "feat(portals): add unpinScene reclaim via decRefCount immediate-unload"
```

---

### Task 4: Adjacency lifecycle (pin frontier on startup + each crossing)

Maintain the resident frontier: on startup pin the start scene's neighbours; on every crossing pin newly-adjacent scenes and reclaim ones that left the frontier. Engine glue; probe-verified.

**Files:**
- Modify: `src/viewer-companion/portals.ts`

**Interfaces:**
- Consumes: `buildPortalAdjacency`, `desiredResidentScenes` (Task 1/2), `pinSceneToLevel` (Task 2), `unpinScene` (Task 3), `entities`, `sceneMinLevel`.
- Produces: `adjacency` (built once in `start()`), `pinnedScenes` (Record<number,bool>), `pinDesired(active)`.

- [ ] **Step 1: Add adjacency state + `pinDesired`** (near the other top-level state, after `octrees`/`pinnedFiles`)

```js
  var adjacency = null;                     // built in start() from data.portals
  var pinnedScenes = {};                    // scene index -> true when currently pinned
```

Add `pinDesired` (place it after `unpinScene`):

```js
  // Reconcile the resident frontier to the active scene: pin every extra scene in
  // {active} ∪ neighbours(active) that is loaded and not already pinned; reclaim
  // every currently-pinned scene that is no longer wanted (and is not the active
  // scene). Called on startup and after each crossing. A scene whose entity has
  // not loaded yet is skipped now and picked up when its loadFromUrl callback runs
  // (which also calls pinDesired(activeIndex)).
  function pinDesired(active) {
    if (!adjacency) { return; }
    var want = desiredResidentScenes(adjacency, active);
    var wantSet = {};
    for (var i = 0; i < want.length; i++) {
      var idx = want[i];
      wantSet[idx] = true;
      if (!pinnedScenes[idx] && entities[idx] && octrees[idx]) {
        var min = deviceMinLevel(idx);
        sceneMinLevel[idx] = min;
        pinSceneToLevel(getAsset(idx), idx, min);
        pinnedScenes[idx] = true;
      }
    }
    for (var k in pinnedScenes) {
      var s = Number(k);
      if (pinnedScenes[s] && !wantSet[s] && s !== active) {
        unpinScene(s);
        pinnedScenes[s] = false;
      }
    }
  }
```

`pinSceneToLevel` needs the scene's `asset`; expose it. The asset is available in the `loadFromUrl` callback — stash it. Add an `assets[]` array next to `octrees`/`pinnedFiles`:

```js
  var assets = [];                          // scene index -> loaded gsplat Asset
```

and a tiny accessor used by `pinDesired`:

```js
  function getAsset(idx) { return assets[idx] || null; }
```

- [ ] **Step 2: Stash the asset + drive `pinDesired` from the creation callback**

In the `loadFromUrl` success callback, where Task 2 set `octrees[idx] = getOctree(asset);`, also stash the asset and reconcile the frontier (so a scene that loads *after* a crossing still gets pinned if it is now adjacent):

```js
          assets[idx] = asset;
          octrees[idx] = getOctree(asset);
          sceneMinLevel[idx] = deviceMinLevel(idx);
          if (comp && octrees[idx]) {
            comp.lodRangeMin = sceneMinLevel[idx];
            comp.lodRangeMax = 1000;
          }
          if (idx === activeIndex) scheduleRefine(idx);
          pinDesired(activeIndex);            // pin this scene if it is now in the frontier
```

- [ ] **Step 3: Build adjacency + pin the initial frontier in `start()`**

In `start()`, after `entities[0] = startEntity;` (and before the extra-scene load loop), build the graph:

```js
    adjacency = buildPortalAdjacency(
      (data.portals || []).map(function (p) { return { front: p.front, back: p.back }; }),
      data.portalScenes.length
    );
```

After the extra-scene load loop, where `applyActive();` is called, reconcile once (extra scenes may still be loading; their callbacks will re-reconcile):

```js
    applyActive();
    pinDesired(activeIndex);
    preloadCollisions();
```

- [ ] **Step 4: Reconcile on every crossing**

In `switchTo`, after `scheduleRefine(idx);`, add the frontier reconcile:

```js
    scheduleRefine(idx);
    pinDesired(idx);
```

- [ ] **Step 5: Typecheck + build + confirm helpers baked in**

Run: `./node_modules/.bin/tsc --noEmit && npm run build && grep -o "buildPortalAdjacency\|pinDesired\|unpinScene" dist/index.js | sort -u`
Expected: tsc exit 0; build "created dist"; grep prints all three names.

- [ ] **Step 6: Commit**

```bash
git add src/viewer-companion/portals.ts
git commit -m "feat(portals): adjacency-driven resident frontier (pin neighbours, reclaim the rest)"
```

---

### Task 5: Probe-verified E2E, strip probes, finalize

The runtime cannot be unit-tested, so confirm behaviour on a RELEASE export with the temporary probes, then remove them.

**Files:**
- Modify: `src/viewer-companion/portals.ts` (remove `[prof]` probes added during diagnosis)

- [ ] **Step 1: Temporarily extend the probes for this feature**

Keep the existing `[prof]` probes; add to `pinDesired` (first line of the pin branch and the reclaim branch) so the E2E shows the frontier moving and memory being reclaimed:

```js
        console.log('[prof] PIN scene ' + idx + ' minLevel=' + min);
```
```js
        console.log('[prof] RECLAIM scene ' + s + ' (count after next frame)');
```

Build: `npm run build`.

- [ ] **Step 2: Manual E2E (user)**

RELEASE export a **multi-scene streaming** portal (3+ scenes if available), hard-reload (Ctrl+Shift+R), open the console, then cross several portals back and forth. Confirm from the `[prof]` log + the viewport:
  - Crossing into a scene shows **device-quality instantly** — no black, no extreme blur (`[prof] cross … lodRange=<min>..1000`, count starts near the device-depth count, not 7k).
  - `[prof] PIN scene N` fires for newly-adjacent scenes *before* you reach them.
  - `[prof] RECLAIM scene M` fires for scenes that left the frontier, and the global count **drops** by ~that scene's resident splats a frame or two later (proves memory is actually freed, not just ref-decremented).
  - Crossing back is still instant for scenes still in the frontier.

- [ ] **Step 3: If reclaim does NOT drop the count** (risk: an active→hidden scene's instance ref lingers)

Investigate per systematic-debugging: log `octree.fileRefCounts[i]` for a reclaimed scene's pinned files right after `unpinScene`. If counts are > 0, the just-disabled scene's render instance has not released its refs yet. Fix options (smallest first): defer `unpinScene` by one rAF after disable; or, if a stale instance ref persists, call `octree.unloadResource(i)` directly for the reclaimed scene (safe — no instance needs a non-adjacent hidden scene). Re-test.

- [ ] **Step 4: Remove all `[prof]` probes**

Delete: the `nowMs` + `profileCrossing` block; the `profileCrossing(idx)` call in `switchTo`; the `[prof] open` log; the `[prof] pin … RESIDENT` log; the startup baseline IIFE in `start()`; the two `[prof] PIN`/`[prof] RECLAIM` logs from Step 1.

Run: `grep -c "\[prof\]" dist/index.js` after a rebuild — but first rebuild: `npm run build`.

- [ ] **Step 5: Final verify (no probes, clean build)**

Run: `./node_modules/.bin/tsc --noEmit && npx vitest run test/portal-preload.test.ts test/portals.test.ts && npm run build && grep -c "\[prof\]" dist/index.js`
Expected: tsc exit 0; tests pass; build "created dist"; grep prints `0`.

- [ ] **Step 6: Commit + finish the branch**

```bash
git add src/viewer-companion/portals.ts
git commit -m "chore(portals): remove diagnostic probes"
```

Then use `superpowers:finishing-a-development-branch` to squash the branch into a single commit (including the docs) and merge per the user's convention.

---

## Self-Review

**Spec coverage:**
- Instant device-quality reveal → Task 2 (reveal-clamp at `deviceLevel`, pinned resident).
- Adjacency frontier pin → Tasks 1 + 4.
- Memory reclaim of non-adjacent scenes → Task 3 + Task 4 reconcile + Task 5 verification.
- Bounded memory regardless of scene count → frontier = degree-bounded (Task 4); scene 0 always-resident overhead noted.
- Device-budget depth (low-end pins less) → `deviceMinLevel` via `lodMinLevelForBudget` (Task 2).

**Placeholder scan:** No TBD/TODO; every code step shows full code. Step 3 of Task 5 is a *conditional debugging branch*, not a placeholder — it carries concrete instrumentation + fix options.

**Type consistency:** `pinSceneToLevel(asset, idx, minLevel)`, `unpinScene(idx)`, `pinDesired(active)`, `deviceMinLevel(idx)`, `getAsset(idx)` used consistently across Tasks 2-4. State arrays (`octrees`, `pinnedFiles`, `sceneMinLevel`, `assets`, `pinnedScenes`, `adjacency`) declared in Task 2/4 before use. `buildPortalAdjacency`/`desiredResidentScenes` signatures match Task 1 definitions and their runtime stringification.

**Known risks (carried into execution):**
1. Active→hidden instance-ref lingering on reclaim → Task 5 Step 3 has the diagnostic + fix.
2. Uniform device-floor vs start-scene near-detail parity → documented design decision #1; optional `lodRangeMin=0` follow-up if the user wants parity after seeing it.
3. Scene 0 never reclaimed → documented design decision #4 (fixed one-scene overhead).
