# Active-Scene-First Pin Priority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the exported streaming portal viewer, stop neighbour-scene downloads from competing with the scene the user is looking at: hold all neighbour pin traffic while the start scene's progress bar is up, then let only coarser-than-active-pin-depth neighbour levels flow until the active scene is fully resident at its pin depth.

**Architecture:** Approach A from the spec (`docs/superpowers/specs/2026-07-06-active-scene-first-pins-design.md` — read it first): extend the existing yield pattern inside `pumpPins` in the viewer-companion runtime with two frame-cached gates (gate 1 "active revealed", gate 2 "active resident at pin depth"), decided by a new pure helper `pinBatchAllowed` in `src/portal-preload.ts` that is stringified into the runtime like `assignPinDepths`. Distance-2 cache warming moves behind gate 2. No engine, viewer, or export-format changes.

**Tech Stack:** TypeScript (editor source), ES5-style JS inside the companion template string, Vitest.

## Global Constraints

- Work in an isolated worktree/branch (suggested: `feature/active-scene-first-pins`) via superpowers:using-git-worktrees. **Subagent shells start in the MAIN checkout — every dispatched subagent must cd to the worktree and verify the branch first** (memory: `worktree-session-gotchas`).
- The companion runtime (`companionRuntime` in `src/viewer-companion/portals.ts`) is a **template literal**: code inside it must not contain backslash escapes (build cooks `\d` → `d`; memory: `companion-template-no-backslash-escapes`), must not contain `${` except the deliberate helper interpolations, and uses ES5 style (`var`, `function`, no arrows) at 2-space indent.
- Pure helpers destined for stringification must be self-contained: no imports, no sibling-function calls, no backslash escapes (see the comment convention on every helper in `src/portal-preload.ts`).
- Run Vitest **foreground with output redirected to a file**, never backgrounded or piped to grep (memory: `vitest-background-pipe-hang`): `npx vitest run <file> > /tmp/vitest.log 2>&1` then read the file.
- Do not reorder imports (ESLint 10 `import/order` crash note in CLAUDE.md). Append to existing import lists in place.
- LOD level numbering everywhere: **0 = finest, `lodLevels - 1` = coarsest**. "Pin depth" = minimum (finest) level kept resident.
- Any companion change requires a RELEASE-build E2E before the branch is finished (Task 4 — user-run).
- `npm run lint` and the full `npx vitest run` must pass before each commit.

---

### Task 1: Pure helper `pinBatchAllowed` (TDD)

**Files:**
- Modify: `src/portal-preload.ts` (add helper + export, near `startSceneLodFloor` ~line 531)
- Test: `test/portal-preload.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: nothing (pure, self-contained).
- Produces: `pinBatchAllowed(batchLevel: number, sceneIdx: number, activeIdx: number, activePinDepth: number | null | undefined, deviceFinest: number | null | undefined, sceneCoarsest: number, revealed: boolean, activeAtDepth: boolean): boolean` — exported from `src/portal-preload.ts`; Task 2 imports and stringifies it.

- [ ] **Step 1: Write the failing tests**

Append to `test/portal-preload.test.ts` (the import on line 3 gains `pinBatchAllowed`):

```ts
describe('pinBatchAllowed', () => {
    // Levels: 0 = finest .. coarsest. The probed scene's coarsest level is 3.
    it('always allows the active scene, even before reveal', () => {
        expect(pinBatchAllowed(0, 2, 2, 0, 0, 3, false, false)).toBe(true);
    });
    it('holds every non-active batch until the active scene is revealed', () => {
        expect(pinBatchAllowed(3, 1, 0, 0, 0, 3, false, false)).toBe(false); // even the coarsest
        expect(pinBatchAllowed(0, 1, 0, 0, 0, 3, false, false)).toBe(false);
    });
    it('allows everything once the active scene is resident at its pin depth', () => {
        expect(pinBatchAllowed(0, 1, 0, 0, 0, 3, true, true)).toBe(true);
        expect(pinBatchAllowed(3, 1, 0, 0, 0, 3, true, true)).toBe(true);
    });
    it('after reveal, allows only batches strictly coarser than the active pin depth', () => {
        expect(pinBatchAllowed(2, 1, 0, 1, 0, 3, true, false)).toBe(true);   // coarser -> flows
        expect(pinBatchAllowed(1, 1, 0, 1, 0, 3, true, false)).toBe(false);  // equal -> held
        expect(pinBatchAllowed(0, 1, 0, 1, 0, 3, true, false)).toBe(false);  // finer -> held
    });
    it('holds neighbour L0 while a desktop active scene (pin depth 0) is filling', () => {
        expect(pinBatchAllowed(1, 1, 0, 0, 0, 3, true, false)).toBe(true);
        expect(pinBatchAllowed(0, 1, 0, 0, 0, 3, true, false)).toBe(false);
    });
    it('falls back to deviceFinest when the active pin depth is unassigned', () => {
        expect(pinBatchAllowed(2, 1, 0, null, 1, 3, true, false)).toBe(true);   // 2 > 1
        expect(pinBatchAllowed(1, 1, 0, null, 1, 3, true, false)).toBe(false);  // 1 === 1
    });
    it('allows only the coarsest level when both thresholds are unknown', () => {
        expect(pinBatchAllowed(3, 1, 0, null, null, 3, true, false)).toBe(true);
        expect(pinBatchAllowed(2, 1, 0, null, null, 3, true, false)).toBe(false);
    });
    it('treats undefined thresholds like null', () => {
        expect(pinBatchAllowed(3, 1, 0, undefined, undefined, 3, true, false)).toBe(true);
        expect(pinBatchAllowed(2, 1, 0, undefined, undefined, 3, true, false)).toBe(false);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/portal-preload.test.ts > /tmp/vitest.log 2>&1` then read `/tmp/vitest.log`.
Expected: FAIL — `pinBatchAllowed` is not exported (`SyntaxError`/`does not provide an export named 'pinBatchAllowed'`).

- [ ] **Step 3: Write the implementation**

In `src/portal-preload.ts`, insert after the `startSceneLodFloor` helper (before `shouldSampleDeviceFinest`):

```ts
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
```

Add `pinBatchAllowed` to the export list on the last line of the file (keep the existing order, append before the type exports):

```ts
export { collectLodFileUrls, lodMinLevelForBudget, collectSogBlockFileUrls, buildPortalAdjacency, desiredResidentScenes, assignPinDepths, computeWarmSet, computeResidentCeiling, selectResidentScenes, sceneResidentToDepth, startSceneLodFloor, shouldSampleDeviceFinest, pinBatchAllowed, PortalLodMeta, PortalLodNode, PortalSogBlockMeta };
```

And add `pinBatchAllowed` to the test file's import on line 3 of `test/portal-preload.test.ts`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/portal-preload.test.ts > /tmp/vitest.log 2>&1` then read `/tmp/vitest.log`.
Expected: PASS (all `describe` blocks, including the new one).

- [ ] **Step 5: Lint and commit**

Run: `npm run lint` — expected exit 0.

```bash
git add src/portal-preload.ts test/portal-preload.test.ts
git commit -m "feat(portals): pure pinBatchAllowed helper for active-scene-first pin priority"
```

---

### Task 2: Wire the gates into the companion runtime

**Files:**
- Modify: `src/viewer-companion/portals.ts` (import ~line 4, stringify block ~line 79, `pinSceneToLevel` ~line 1208, new gate block before `pumpPins` ~line 1213, `pumpPins` batch loop ~line 1244, `pinDesired` warm call ~line 1441)
- Test: `test/portals-injection.test.ts` (one new assertion)

**Interfaces:**
- Consumes: `pinBatchAllowed` from Task 1 (exact signature above). Existing runtime state it reads (all already defined in the IIFE): `activeIndex`, `pinDepth[]`, `pinnedScenes{}`, `pinBatches[]`, `octrees[]`, `shown{}`, `deviceFinest`, `dfFrame`, `streaming`, `pinReady`, `LOADING_MAX_FRAMES`, `data.portalStart`, and functions `sceneRevealResident(idx)`, `warmFrontier(want)`, `residentScenes()`.
- Produces: runtime behavior only (no new exports). Batch records in `pinBatches` gain a `level` field; a `refreshGates()` function and `gateRevealed`/`gateActiveDone` vars exist inside the runtime.

- [ ] **Step 1: Write the failing test**

In `test/portals-injection.test.ts`, inside the existing `it('emits the payload global and a runtime script when portals exist', ...)` test, add after the `expect(out).toContain('portalSceneLodCounts');` line:

```ts
        expect(out).toContain('pinBatchAllowed'); // active-scene-first gate helper baked into the runtime
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/portals-injection.test.ts > /tmp/vitest.log 2>&1` then read `/tmp/vitest.log`.
Expected: FAIL on the new assertion (`pinBatchAllowed` not in the emitted runtime).

- [ ] **Step 3: Import and stringify the helper**

In `src/viewer-companion/portals.ts` line 4, append `pinBatchAllowed` to the existing named import (same line, no reordering):

```ts
import { collectLodFileUrls, collectSogBlockFileUrls, buildPortalAdjacency, desiredResidentScenes, assignPinDepths, computeWarmSet, computeResidentCeiling, selectResidentScenes, sceneResidentToDepth, startSceneLodFloor, shouldSampleDeviceFinest, pinBatchAllowed } from '../portal-preload';
```

Inside `companionRuntime`, after the line `var startSceneLodFloor = ${startSceneLodFloor.toString()};` (~line 79), add:

```js
  var pinBatchAllowed = ${pinBatchAllowed.toString()};
```

(This line is INSIDE the template literal, so the `${...}` interpolation is deliberate — it must interpolate, exactly like the surrounding helper lines.)

- [ ] **Step 4: Record each batch's level**

In `pinSceneToLevel` (~line 1208), change the batch push to include the level (the only caller, `pinDesired`'s level-major loop, always passes `minLevel === maxLevel`):

```js
    if (!pinBatches[idx]) { pinBatches[idx] = []; }
    pinBatches[idx].push({ remaining: batch, markReady: !!markReady, done: false, level: minLevel });
    pumpPins(idx);
```

- [ ] **Step 5: Add the gate state and `refreshGates()`**

Insert between the end of `pinSceneToLevel` (the line `pumpPins(idx); }` closing it, ~line 1211) and the comment block above `function pumpPins(idx)`:

```js
  // --- active-scene-first pin priority gates -----------------------------
  // Gate 1 (gateRevealed): the active scene has been revealed to the user.
  // For crossed-into scenes this is shown[active] (crossing reducer). For the
  // START scene, shown[] is pre-latched true at init and the viewer's own
  // progress bar is not observable (viewerReady deliberately latches early
  // under throttling), so a one-shot startRevealed latch probes residency at
  // revealLevel(startSceneIdx) -- the same condition that drops a crossing
  // overlay -- throttled (the probe is O(files)), with an anti-stick frame
  // cap so neighbours are never held forever.
  // Gate 2 (gateActiveDone): every pin batch of the active scene is done (it
  // is resident at its pin depth). While its pins are not queued yet (e.g.
  // firstFrame has not fired so pinDesired skips scene 0), the same anti-
  // stick cap bounds the hold. There is deliberately NO cap on a queued-and-
  // loading active scene: on a slow network it may legitimately take minutes,
  // and that is exactly when neighbours' fine levels must wait.
  // Gates recompute at most once per frame (dfFrame-stamped) and ONLY while a
  // pump asks, so gate work stops with the pumps -- steady-state per-frame
  // cost stays zero. The closed->open transition of gate 2 fires the deferred
  // distance-2 warming (warmedScenes dedups against pinDesired's own call).
  var startSceneIdx = data.portalStart || 0;
  var startRevealed = false;      // one-shot: start scene revealed at startup
  var startRevealFrames = 0;      // frames observed while unlatched (cap clock)
  var gateRevealed = false;       // gate 1, valid for gateFrame
  var gateActiveDone = false;     // gate 2, valid for gateFrame
  var gateStuckFrames = 0;        // frames with active pins not queued (cap clock)
  var gateFrame = -1;             // dfFrame the gates were last computed for
  var REVEAL_PROBE_EVERY = 15;    // start-reveal probe cadence while unlatched
  function refreshGates() {
    if (gateFrame === dfFrame) { return; }
    gateFrame = dfFrame;
    if (!startRevealed) {
      if (!streaming || !octrees[startSceneIdx]) {
        startRevealed = true;     // SOG start (no octree to probe): the viewer's own bar handles it
      } else {
        startRevealFrames++;
        if (startRevealFrames > LOADING_MAX_FRAMES) {
          startRevealed = true;
          console.info('[portals] start-reveal gate opened via cap');
        } else if (startRevealFrames % REVEAL_PROBE_EVERY === 0 && sceneRevealResident(startSceneIdx)) {
          startRevealed = true;
          console.info('[portals] start-reveal gate opened via residency');
        }
      }
    }
    gateRevealed = (activeIndex !== startSceneIdx || startRevealed) && !!shown[activeIndex];
    var wasDone = gateActiveDone;
    var batches = pinBatches[activeIndex] || [];
    if (!octrees[activeIndex]) {
      gateActiveDone = true;      // SOG active: no batches to wait for
      gateStuckFrames = 0;
    } else if (pinnedScenes[activeIndex] && batches.length) {
      gateStuckFrames = 0;
      var done = true;
      for (var i = 0; i < batches.length; i++) { if (!batches[i].done) { done = false; break; } }
      gateActiveDone = done;
    } else {
      gateStuckFrames++;
      gateActiveDone = gateStuckFrames > LOADING_MAX_FRAMES;
    }
    if (!wasDone && gateActiveDone && pinReady) { warmFrontier(residentScenes()); }
  }
```

- [ ] **Step 6: Gate the pump**

In `pumpPins`'s batch loop (~line 1244), insert the gate check right after the `if (bt.done) { continue; }` line:

```js
      for (var b = 0; b < batches.length; b++) {
        var bt = batches[b];
        if (bt.done) { continue; }
        // Active-scene-first priority: a non-active batch may be held until
        // the active scene is revealed / resident at its pin depth. Strict
        // batch order means holding this batch holds everything finer too;
        // spin (rAF below) exactly like the crossing yield above.
        if (idx !== activeIndex) {
          refreshGates();
          if (!pinBatchAllowed(bt.level, idx, activeIndex, pinDepth[activeIndex], deviceFinest,
            (octree.lodLevels ? octree.lodLevels - 1 : 0), gateRevealed, gateActiveDone)) {
            allDone = false;
            break;
          }
        }
        var j = 0;
```

And change the `allDone` exit (~line 1265) so the ACTIVE scene's pump completion recomputes the gates even when no other pump is running that frame (this is what fires the deferred warming when neighbours finished before the active scene):

```js
      if (allDone) {
        if (idx === activeIndex) { gateFrame = -1; refreshGates(); }   // catch the gate-2 transition (fires deferred warming) even if no held pump remains
        pinPumping[idx] = false;
        return;
      }
```

- [ ] **Step 7: Defer distance-2 warming behind gate 2**

In `pinDesired` (~line 1441), replace:

```js
    // Warm here (not in reconcileFrontier): pinDesired runs once deviceFinest
    // has settled, so streaming scenes warm at the depth a future pin will fetch.
    warmFrontier(want);
```

with:

```js
    // Warm here (not in reconcileFrontier): pinDesired runs once deviceFinest
    // has settled, so streaming scenes warm at the depth a future pin will
    // fetch. Deferred behind gate 2 (active scene resident at its pin depth):
    // distance-2 warming is the lowest-value traffic and must never compete
    // with the scene on screen. When gate 2 is still closed here, refreshGates
    // fires the warming on its closed->open transition instead.
    refreshGates();
    if (gateActiveDone) { warmFrontier(want); }
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run > /tmp/vitest-all.log 2>&1` then read `/tmp/vitest-all.log`.
Expected: full suite PASS, including the new `portals-injection` assertion from Step 1.

- [ ] **Step 9: Lint and commit**

Run: `npm run lint` — expected exit 0.

```bash
git add src/viewer-companion/portals.ts test/portals-injection.test.ts
git commit -m "feat(portals): active-scene-first pin priority gates in the viewer runtime"
```

---

### Task 3: Docs + full gates

**Files:**
- Modify: `docs/superpowers/2026-07-06-portal-viewer-streaming-followups.md` (item 1)

**Interfaces:**
- Consumes: nothing new.
- Produces: memo updated so future sessions see item 1 as implemented.

- [ ] **Step 1: Mark follow-ups memo item 1 implemented**

In `docs/superpowers/2026-07-06-portal-viewer-streaming-followups.md`, append to section "## 1. Active-scene-first pin priority" (after the existing "Watch out" paragraph):

```markdown
Status (2026-07-06): IMPLEMENTED — spec `docs/superpowers/specs/2026-07-06-active-scene-first-pins-design.md`,
plan `docs/superpowers/plans/2026-07-06-active-scene-first-pins.md`. Combined policy: strict hold while the
start scene's bar is up (residency-probed startRevealed latch), then coarser-than-active-pin-depth neighbour
levels flow while equal-or-finer wait for the active scene (pinBatchAllowed gate in pumpPins); distance-2
warming waits for the same gate.
```

- [ ] **Step 2: Full verification**

Run each, reading output files afterwards:

```bash
npm run lint
npx vitest run > /tmp/vitest-all.log 2>&1
npm run build > /tmp/build.log 2>&1
```

Expected: lint exit 0; all tests pass; release build completes without errors.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/2026-07-06-portal-viewer-streaming-followups.md
git commit -m "docs(portals): mark follow-ups item 1 (active-scene-first pins) implemented"
```

---

### Task 4: RELEASE-build E2E (user-run — STOP and hand over)

No code. Prepare the build, then present this checklist to Dimitri and STOP until he reports results (memory: `never-auto-answer-after-timeout` — wait for the real answer).

- [ ] **Step 1: Prepare the release build**

`npm run build` (already done in Task 3; rebuild if anything changed). Serve the editor: `npx http-server dist -p 3000`. If exporting through the **export server** instead, also rebuild `dist-shared` (`node scripts/build-shared.mjs`) and restart the 3334 server, then grep the exported HTML for `pinBatchAllowed` to confirm the new runtime was baked (memory: `worktree-session-gotchas`).

- [ ] **Step 2: User E2E checklist (Slow-3G startup ordering)**

1. In the release editor, open a multi-scene portal project and export the **streaming** HTML viewer.
2. Serve the exported folder with caching enabled: `npx http-server <folder> -p 8080` (**no `-c-1`** — follow-ups memo item 2).
3. DevTools → Network (cache ENABLED), throttle Slow 3G, clear site data, reload (cold start).
4. Expect in the waterfall: **no neighbour-scene block requests before the start scene's progress bar drops**; console logs `[portals] start-reveal gate opened via residency` around the bar dropping.
5. After the bar drops: only neighbour block files at levels **coarser** than the start scene's pin depth until the start scene finishes its fine levels; then neighbour fine levels; **distance-2 warming requests last**.
6. Normal-speed pass (no throttle): after idling ~30s in the start scene, cross a portal — still instant (no overlay); cross into a far scene quickly after load — overlay behavior unchanged; R-reset returns to the start scene as before.

- [ ] **Step 3: Finish the branch**

After user verification, use superpowers:finishing-a-development-branch — squash the feature into a single commit (including docs) per the user's standing preference, merge to `main`, remove the worktree.
