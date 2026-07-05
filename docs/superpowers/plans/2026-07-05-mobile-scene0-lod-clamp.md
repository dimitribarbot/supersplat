# Scene-0 LOD Floor Clamp (budget-degraded devices) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the exported portal viewer, clamp scene 0's gsplat `lodRangeMin` to its assigned pin depth when (and only when) the resident budget degraded that depth below the device's observed finest LOD level, killing the endless failed level-0 block loads on memory-pressured phones while keeping desktop bitwise-identical to stock.

**Architecture:** A new pure decision helper `startSceneLodFloor(assignedDepth, deviceFinest)` in `src/portal-preload.ts` (the established stringified-helper pattern) returns the floor to clamp to, or `null` for "leave viewer-owned". `pinDesired()` in `src/viewer-companion/portals.ts` feeds it scene 0's assigned depth in the exact spot where the old `idx !== 0` guard skipped the write; a tiny `applyStartFloor` applies/releases the clamp and records it in `startFloor` so a `performanceMode:changed` hook can re-assert it after the stock viewer's `applyPerfSettings` rewrites `lodRangeMin = 0`.

**Tech Stack:** TypeScript, Vitest, the viewer-companion stringified-runtime pattern (`Function.toString()` into a template literal).

**Spec:** `docs/superpowers/2026-07-05-mobile-scene0-lod-clamp-followup.md` (problem, field evidence, watch-outs).

## Global Constraints

- **Desktop must be a strict no-op.** When scene 0's assigned depth equals `deviceFinest` (typically 0), the companion must never write `comps[0].lodRangeMin` — stock start-scene behavior preserved bit-for-bit.
- **Never clamp before `deviceFinest` has been observed** (`deviceFinest === null` → no clamp): the clamp caps what `updateDeviceFinest` can ever observe, so it must only engage after the running-min settles. (`pinDesired` is already `pinReady`-gated, and the helper independently refuses `null` — belt and braces. This is deliberately STRICTER than the memo's `min > (deviceFinest ?? 0)` sketch, which contradicts the memo's own watch-out on the 30s timeout path where `deviceFinest` can still be null.)
- **No backslash escapes in stringified runtime code** (helper or portals.ts IIFE): template literals cook `\d` → `d` at build time (see memory: companion-template-no-backslash-escapes). String ops only.
- Pure helpers must be **self-contained** (no imports, no sibling-function calls) — they are stringified verbatim via `Function.toString()`.
- `sceneMinLevel[0]` stays **unset** (memo allowed either; audit result: `sceneRevealResident` resolves `pinDepth[0]` first, which is always assigned for scene 0, and `scheduleRefine` early-returns for idx 0 — so leaving it unset changes nothing and keeps state minimal).
- ESLint is pinned to v10 — do not reorder imports; match surrounding style.
- Use Bash (Git Bash), plain commands (no `cd`/`git -C`/`npm --prefix` at the cwd).
- Run `npm run lint` and `npx tsc --noEmit` as **separate** commands (chaining has hit the tool timeout).
- E2E on both the Redmi (churn gone, quality unchanged at pinned depth) and desktop (identical behavior) is **user-performed** after the release build.

---

### Task 1: Pure decision helper `startSceneLodFloor`

**Files:**
- Modify: `src/portal-preload.ts` (append helper before the `export` line at the bottom, add to the export list)
- Test: `test/portal-preload.test.ts` (new `describe` block appended)

**Interfaces:**
- Consumes: nothing (pure, self-contained).
- Produces: `startSceneLodFloor(assignedDepth: number | null | undefined, deviceFinest: number | null | undefined): number | null` — Task 2 imports it from `../portal-preload` and stringifies it into the runtime under the same name.

- [ ] **Step 1: Write the failing tests**

Append to `test/portal-preload.test.ts`, and add `startSceneLodFloor` to the existing import from `'../src/portal-preload'` (append at the end of the named-import list; do not reorder):

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/portal-preload.test.ts`
Expected: FAIL — `startSceneLodFloor` is not exported (`SyntaxError` / `startSceneLodFloor is not a function`).

- [ ] **Step 3: Write the implementation**

In `src/portal-preload.ts`, insert before the `export {` line:

```ts
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
```

Then append `startSceneLodFloor` to the `export {` list at the bottom of the file (after `sceneResidentToDepth`, before the type exports).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/portal-preload.test.ts`
Expected: PASS (all existing + 6 new).

- [ ] **Step 5: Commit**

```bash
git add src/portal-preload.ts test/portal-preload.test.ts
git commit -m "feat(portals): pure startSceneLodFloor decision helper"
```

---

### Task 2: Wire the clamp into the exported-viewer runtime

**Files:**
- Modify: `src/viewer-companion/portals.ts` (import at line 3; stringified-helper block ~line 74; state var ~line 94; new `applyStartFloor` before `pinDesired` ~line 1059; the `idx !== 0` guard inside `pinDesired` ~lines 1108–1113; `performanceMode:changed` hook in `start()`'s `if (ev && ev.on)` block ~line 516)
- Test: `test/portals-injection.test.ts` (new `it` block in the `buildPortalsInjection` describe)

**Interfaces:**
- Consumes: `startSceneLodFloor(assignedDepth, deviceFinest): number | null` from Task 1 (`import ... from '../portal-preload'`).
- Produces: nothing new outside `portals.ts` (runtime-internal `applyStartFloor(floor)` + `startFloor` state).

- [ ] **Step 1: Write the failing injection test**

Add to `test/portals-injection.test.ts`, inside `describe('buildPortalsInjection', ...)` after the `'arms the crossing overlay from a live residency probe...'` test:

```ts
    it('clamps scene 0\'s LOD floor to its pin depth only when budget-degraded', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/lod-meta.json'],
            portalStart: 0
        });
        // pure decision helper stringified in, applied via applyStartFloor
        expect(out).toContain('startSceneLodFloor');
        expect(out).toContain('applyStartFloor');
        // the clamp survives the viewer's applyPerfSettings re-run (which
        // reopens the start component's lodRangeMin to 0 on this event)
        expect(out).toContain("'performanceMode:changed'");
    });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/portals-injection.test.ts`
Expected: FAIL — `expected ... to contain 'startSceneLodFloor'`.

- [ ] **Step 3: Wire the runtime**

All edits in `src/viewer-companion/portals.ts`:

**(a)** Line 3 — append `startSceneLodFloor` to the existing named import (end of list, no reorder):

```ts
import { collectLodFileUrls, collectSogBlockFileUrls, buildPortalAdjacency, desiredResidentScenes, assignPinDepths, computeWarmSet, computeResidentCeiling, selectResidentScenes, sceneResidentToDepth, startSceneLodFloor } from '../portal-preload';
```

**(b)** In the stringified-helper block (after `var sceneResidentToDepth = ${sceneResidentToDepth.toString()};`, line 74):

```ts
  var startSceneLodFloor = ${startSceneLodFloor.toString()};
```

**(c)** State var — after the `var pinDepth = [];` declaration (line 94):

```js
  var startFloor = null;                    // active clamp on scene 0's lodRangeMin (null = floor viewer-owned; see applyStartFloor)
```

**(d)** New function immediately before `function pinDesired()` (after the `pinWhenBudgetReady` block):

```js
  // Scene 0's lodRange floor stays viewer-owned (applyPerfSettings opens it
  // to 0 once ready) EXCEPT when the budget degraded its assigned pin depth
  // below the device's observed finest: the engine then endlessly requests
  // finest-level blocks the device cannot hold (field case: ERR_FAILED-with-
  // 200 churn on scene-0 level-0 webps under mobile memory pressure) for
  // splats that can never be shown. Clamp the component floor to the pin
  // depth, exactly as pinDesired does for extra scenes; release it (restore
  // the viewer's 0) if a later reconcile lifts the degradation. A never-
  // clamped device (floor null throughout -- desktop) never writes the
  // component at all, so stock start-scene behavior is untouched.
  // sceneMinLevel[0] stays unset: the reveal gate resolves pinDepth[0]
  // first, which pinDesired always assigns for scene 0.
  function applyStartFloor(floor) {
    if (floor === null && startFloor === null) { return; }   // never clamped: strict no-op
    startFloor = floor;
    if (comps[0]) { comps[0].lodRangeMin = (floor !== null) ? floor : 0; }
  }
```

**(e)** In `pinDesired()`, replace the scene-0 guard (lines 1108–1113):

```js
      if (idx !== 0) {
        // Scene 0's lodRange floor stays viewer-owned (the engine's balancer
        // already drives the start scene); we only pin its blocks resident.
        sceneMinLevel[idx] = min;
        if (comps[idx]) { comps[idx].lodRangeMin = min; }
      }
```

with:

```js
      if (idx !== 0) {
        // Extra scenes: the component floor IS the pin depth.
        sceneMinLevel[idx] = min;
        if (comps[idx]) { comps[idx].lodRangeMin = min; }
      } else {
        // Scene 0's floor is viewer-owned unless the budget degraded its pin
        // depth below the device's observed finest (see applyStartFloor).
        // pinDesired only runs pinReady-gated, so deviceFinest has settled
        // by the time a clamp can engage.
        applyStartFloor(startSceneLodFloor(min, deviceFinest));
      }
```

**(f)** In `start()`'s `if (ev && ev.on)` block, after the `ev.on('inputEvent', ...)` handler (line 516):

```js
      // The viewer's applyPerfSettings re-runs on this event and reopens the
      // start component's lodRangeMin to 0, wiping the budget clamp. Re-assert
      // it a frame later (rAF: listener order between the viewer's handler and
      // this one is not guaranteed).
      ev.on('performanceMode:changed', function () {
        requestAnimationFrame(function () {
          if (startFloor !== null && comps[0]) { comps[0].lodRangeMin = startFloor; }
        });
      });
```

- [ ] **Step 4: Run the injection + preload + portals tests**

Run: `npx vitest run test/portals-injection.test.ts test/portal-preload.test.ts test/portals.test.ts`
Expected: PASS, including the smoke test `runtime script body constructs via new Function without throwing` (catches stringification syntax breakage).

- [ ] **Step 5: Commit**

```bash
git add src/viewer-companion/portals.ts test/portals-injection.test.ts
git commit -m "fix(portals): clamp scene 0 LOD floor to pin depth on budget-degraded devices"
```

---

### Task 3: Full verification, shared build, docs

**Files:**
- Modify: `docs/superpowers/2026-07-05-mobile-scene0-lod-clamp-followup.md` (status line only)
- Build artifact: `dist-shared/` (regenerated; portals.ts is baked into the export core the server imports)

**Interfaces:**
- Consumes: Tasks 1–2 committed.
- Produces: green suite + release build for the user's E2E.

- [ ] **Step 1: Full front-end test suite**

Run: `npm run test`
Expected: all tests pass (262+ before this feature; +7 new).

- [ ] **Step 2: Lint (separate command)**

Run: `npm run lint`
Expected: exit 0, no errors.

- [ ] **Step 3: Typecheck (separate command)**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Rebuild dist-shared and run server tests**

```bash
node scripts/build-shared.mjs
```

Then run the server suite (from repo root, plain command in the server dir per project conventions — open a shell in `server/` or run its script):

```bash
npm run test --prefix server
```

(If `--prefix` triggers a permission prompt per project memory, run it as the plan executor sees fit from `server/` directly.)
Expected: 47 server tests pass, including the byte-parity test.

- [ ] **Step 5: Release build for E2E**

Run: `npm run build`
Expected: clean production build in `dist/` (always E2E a RELEASE build — stringified-helper minification gotcha).

- [ ] **Step 6: Update the follow-up memo status**

In `docs/superpowers/2026-07-05-mobile-scene0-lod-clamp-followup.md`, change:

```
Status: PROPOSED (not started). Origin: streaming-blob fix E2E, 2026-07-05.
```

to:

```
Status: IMPLEMENTED 2026-07-05 (clamp in pinDesired via pure startSceneLodFloor
helper + performanceMode:changed re-assert; sceneMinLevel[0] left unset --
reveal gate audited: pinDepth[0] always wins). E2E pending (Redmi + desktop).
Origin: streaming-blob fix E2E, 2026-07-05.
```

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/2026-07-05-mobile-scene0-lod-clamp-followup.md
git commit -m "docs: mark scene-0 LOD clamp follow-up implemented"
```

- [ ] **Step 8: Hand off for user E2E**

Report to Dimitri: feature is code-complete on the branch; needs field E2E on the Redmi (expect: `[portals]` diag unchanged — e.g. `depths={"0":3,...} deviceFinest=0` — but NO more endless `GET .../0_8/{scales,sh0}.webp` retry cycles; visual quality unchanged at the pinned depth) and a desktop regression pass (behavior identical to before; the diag should show scene 0's depth == deviceFinest so the clamp never engages). Squash + FF-merge to local `main` only after user verification (superpowers:finishing-a-development-branch; do NOT push).

---

## Self-Review

- **Spec coverage:** clamp condition (`min > deviceFinest`, only after settle) → Task 1 helper + Task 2(e); `applyPerfSettings` overwrite survival → Task 2(f); desktop strict no-op → helper `null` path + `applyStartFloor` early-return + tests; `sceneMinLevel[0]`/reveal-gate audit → documented in Global Constraints and the `applyStartFloor` comment; E2E on both devices → Task 3 Step 8 (user-performed). No gaps.
- **Placeholder scan:** none — every step has literal code/commands.
- **Type consistency:** `startSceneLodFloor(assignedDepth, deviceFinest): number | null` is used with the same name/signature in Task 1 (export), Task 2(a) import, 2(b) stringification, 2(e) call site.
