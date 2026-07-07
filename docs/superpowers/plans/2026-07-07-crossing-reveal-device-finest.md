# Crossing Reveal Gate Targets Device-Finest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the exported portal viewer from revealing a crossed-into scene at its coarsest level (blurry, no overlay) because a stale coarse *neighbour* pin raised the reveal gate; target the finest level the device will actually load instead.

**Architecture:** Extract the reveal-gate math into a pure, unit-tested `computeRevealLevel` in `src/portal-preload.ts` (mirroring `pinBatchAllowed` / `startSceneLodFloor` / `parseBudgetParam`), then call it from the stringified companion runtime's `revealLevel`. The gate targets `deviceFinest` (clamped to the scene, floored at the near-coarse "acceptable" level) and only lets the *fresh* pin raise it for a genuinely-active, legitimately budget-degraded scene (Approach 2).

**Tech Stack:** TypeScript, Vitest (Node env), Rollup release build. The runtime in `portals.ts` is a template-literal IIFE with helpers inlined via `Function.toString()`.

## Global Constraints

- The runtime in `src/viewer-companion/portals.ts` is authored **inside a template literal** — **no backticks** and **no backslash escapes** in any added code or comment (a backtick closes the template string and breaks the build; `\d`-style escapes are cooked away at build time). String ops only.
- Pure helpers stringified into the runtime must be **self-contained**: no imports, no sibling-function calls, no closure references. `computeRevealLevel` uses only its arguments and `Math`.
- Do not reorder imports (ESLint v10 `import/order` autofix crashes) — add the new name to the existing import/export lists in place.
- Spec: `docs/superpowers/specs/2026-07-07-crossing-reveal-device-finest-design.md`.
- LOD level convention: **0 = finest**, higher = coarser. `REVEAL_MARGIN` is 2.

---

### Task 1: Pure `computeRevealLevel` helper + unit tests

**Files:**
- Modify: `src/portal-preload.ts` (add the `const` just before the `export { … }` at the file end; add its name to that export list)
- Test: `test/portal-preload.test.ts` (add a `describe` block; add `computeRevealLevel` to the import on line 3)

**Interfaces:**
- Produces: `computeRevealLevel(coarse: number, revealMargin: number, deviceFinest: number | null, isActive: boolean, pinReady: boolean, pinDepth: number | null): number` — returns the coarsest LOD level a crossing/reveal accepts as "showable".

- [ ] **Step 1: Write the failing tests**

Add `computeRevealLevel` to the import list on line 3 of `test/portal-preload.test.ts`, then append this block:

```ts
describe('computeRevealLevel', () => {
    // coarse=3, revealMargin=2 -> acceptable = max(3-2, 0) = 1
    it('capable device (deviceFinest 0): near-coarse acceptable, ignoring a stale coarse neighbour pin', () => {
        expect(computeRevealLevel(3, 2, 0, false, true, 3)).toBe(1);   // stale neighbour pin=3 must NOT raise
    });
    it('low-end device: clamps the target up to the finest the device loads', () => {
        expect(computeRevealLevel(3, 2, 2, false, true, 3)).toBe(2);   // max(acceptable 1, min(deviceFinest 2, coarse 3))
    });
    it('active + legitimately degraded: the fresh pin may raise the gate (no stuck overlay)', () => {
        expect(computeRevealLevel(3, 2, 0, true, true, 3)).toBe(3);    // isActive && pinReady && pin 3 > target 0
    });
    it('active but pin not coarser than the device target: pin does not lower the gate', () => {
        expect(computeRevealLevel(3, 2, 0, true, true, 0)).toBe(1);    // pin 0 !> target 0 -> acceptable 1
    });
    it('active but pinReady false: pin is not yet trustworthy, use the device target', () => {
        expect(computeRevealLevel(3, 2, 0, true, false, 3)).toBe(1);
    });
    it('deviceFinest unknown: falls back to the acceptable level, not the coarsest', () => {
        expect(computeRevealLevel(3, 2, null, false, true, 3)).toBe(1);
        expect(computeRevealLevel(3, 2, undefined as any, false, true, 3)).toBe(1);
    });
    it('scene with fewer levels than deviceFinest: target clamps to the scene coarsest', () => {
        // coarse=1 -> acceptable = max(1-2, 0) = 0; deviceFinest 2 clamps to 1
        expect(computeRevealLevel(1, 2, 2, false, true, null)).toBe(1);
    });
    it('null pin on a non-active scene: just the device target', () => {
        expect(computeRevealLevel(3, 2, 0, false, true, null)).toBe(1);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/portal-preload.test.ts -t "computeRevealLevel"`
Expected: FAIL — `computeRevealLevel is not a function` / import has no such export.

- [ ] **Step 3: Add the implementation**

In `src/portal-preload.ts`, add this `const` immediately before the final `export { … }` line:

```ts
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
    let target = (deviceFinest !== null && deviceFinest !== undefined)
        ? Math.min(deviceFinest, coarse)
        : acceptable;
    if (isActive && pinReady && pinDepth !== null && pinDepth !== undefined && pinDepth > target) {
        target = pinDepth;
    }
    return Math.max(acceptable, target);
};
```

Then add `computeRevealLevel` to the `export { … }` list on the same line as the other pure helpers (next to `parseBudgetParam`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/portal-preload.test.ts -t "computeRevealLevel"`
Expected: PASS (8 tests).

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: exits 0, no output.

- [ ] **Step 6: Commit**

```bash
git add src/portal-preload.ts test/portal-preload.test.ts
git commit -m "feat(portals): pure computeRevealLevel reveal-gate helper"
```

---

### Task 2: Wire `computeRevealLevel` into the runtime `revealLevel`

**Files:**
- Modify: `src/viewer-companion/portals.ts` (import on line 4; stringified-helper block ~line 81; `revealLevel` at lines 309–322)

**Interfaces:**
- Consumes: `computeRevealLevel` from Task 1 (imported from `../portal-preload`, stringified into the runtime).

- [ ] **Step 1: Import the helper**

In `src/viewer-companion/portals.ts` line 4, add `computeRevealLevel` to the existing `import { … } from '../portal-preload';` list (in place — do not reorder).

- [ ] **Step 2: Stringify it into the runtime**

After the `var parseBudgetParam = ${parseBudgetParam.toString()};` line (currently line 81), add:

```js
  var computeRevealLevel = ${computeRevealLevel.toString()};
```

- [ ] **Step 3: Rewrite `revealLevel` to delegate**

Replace the body of `revealLevel` (the block currently at lines 309–322 — from `function revealLevel(idx) {` through its closing `}`) with:

```js
  function revealLevel(idx) {
    var oc = octrees[idx];
    var coarse = (oc && oc.lodLevels) ? oc.lodLevels - 1 : 0;
    // Target the finest level this DEVICE loads for the scene, not a stale coarse
    // NEIGHBOUR pin: a scene crossed into is re-pinned to the active (fine) depth,
    // so its pre-crossing coarse pin must not raise the gate and reveal it at the
    // coarsest with no overlay. computeRevealLevel keeps the original stuck-overlay
    // guard for a genuinely-active, legitimately budget-degraded scene.
    return computeRevealLevel(coarse, REVEAL_MARGIN, deviceFinest, idx === activeIndex, pinReady, pinDepth[idx]);
  }
```

Keep the existing explanatory comment block that precedes `function revealLevel` (lines 299–308) — it still describes the intent. If any sentence there now contradicts the new body (it references raising the gate via the pin), trim it to match; do not add backticks.

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: exits 0, no output.

- [ ] **Step 5: Release build (verifies the template string still compiles)**

Run: `npm run build`
Expected: `created dist in …` with no parse error for `portals.ts` (a stray backtick would fail here).

- [ ] **Step 6: Verify the helper baked into the bundle**

Run: `grep -c "computeRevealLevel" dist/index.js`
Expected: a count `>= 2` (the stringified definition + the call site).

- [ ] **Step 7: Full unit suite (no regressions)**

Run: `npm run test > "$TEMP/ss-reveal-test.txt" 2>&1; echo "exit=$?"; tail -3 "$TEMP/ss-reveal-test.txt"`
Expected: `exit=0` and `Tests  <N> passed` (N = previous total + 8).

- [ ] **Step 8: Commit**

```bash
git add src/viewer-companion/portals.ts
git commit -m "fix(portals): reveal gate targets device-finest, not a stale neighbour pin"
```

---

## Manual verification (user-run release E2E)

Not an automated task — the reveal behavior only manifests in the running exported viewer. Serve a caching server with DevTools "Disable cache" **unchecked** (a cache-off run turns every benign reload into a full refetch and hides the signal):

1. Export a multi-scene streaming project; open with `?residentBudget=11000000` (forces coarse neighbour pins, mirroring a memory-tight phone). Cross into a scene before its finer LODs load: it should now show the **loading overlay**, then reveal at the near-coarse level (not the coarsest), refining in view. Confirm via the `[portals] crossing -> N` and `[portals] reveal N … gateDepth=…` logs that `gateDepth` is the near-coarse level, not the coarsest.
2. Reload with **no** `?residentBudget`: crossings into fully-preloaded neighbours stay **instant and sharp** — no new overlay.
3. Confirm the overlay never sticks: it drops within a second or two of the scene reaching the device target (or immediately for an already-resident scene).

---

## Self-Review

**Spec coverage:** `computeRevealLevel` signature + formula (Task 1) ✓; runtime wiring across all three callers via the shared `revealLevel` (Task 2) ✓; every behavior-table row is a unit test (Task 1 Step 1) ✓; blast-radius callers (crossing gate, start-reveal latch, diagnostic log) all route through the one rewritten `revealLevel` ✓; release-build E2E (manual section) ✓. No spec requirement is left without a task.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output.

**Type consistency:** `computeRevealLevel(coarse, revealMargin, deviceFinest, isActive, pinReady, pinDepth)` — identical signature and argument order in the definition (Task 1 Step 3), the tests (Task 1 Step 1), and the call site (Task 2 Step 3).
