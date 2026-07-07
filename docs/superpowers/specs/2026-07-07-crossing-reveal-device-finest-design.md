# Crossing reveal gate targets device-finest, not the stale pin (design)

Date: 2026-07-07
Status: design approved, awaiting spec review
Scope: exported streaming portal viewer runtime (`src/viewer-companion/portals.ts`) + pure helper in
`src/portal-preload.ts`. Any change to the stringified runtime needs a RELEASE-build E2E.

## Problem

Crossing into a portal scene whose finer LOD levels are not yet downloaded reveals it **at the
coarsest level with no loading overlay** — a blurry pop that then refines in view. Field-observed on
desktop under a forced-tight `?residentBudget=11000000` (which mirrors a genuinely memory-tight
mobile device), diag:

```
crossing -> 1 ... ready=true shown=false gate=3 pinDepth=3 lodRangeMin=3 | L0:0/9 L1:0/5 L2:0/3 L3:2/2
...
ceiling=11000000 ... depths={"0":3,"1":0} deviceFinest=0 active=1
```

Scene 1 had only its coarsest level resident (`L3:2/2`), yet `ready=true` (`gate=3`) so it revealed
blurry. A frame later `pinDesired` reassigned it to the fine active depth (`depths…"1":0`) and it
began streaming `L0–L2`.

### Root cause

`revealLevel(idx)` (`portals.ts:309-322`) lets `pinDepth[idx]` **raise** the reveal gate above the
near-coarse "acceptable" level (`coarsest − REVEAL_MARGIN`):

```js
var pin = pinDepth[idx];
return (pin != null && pin > acceptable) ? pin : acceptable;
```

At a crossing *dispatch*, `pinDepth[idx]` is still the scene's stale **neighbour** pin depth (coarse,
assigned while it was preloaded as a neighbour under the tight budget). The gate therefore accepts the
coarsest level as "ready", `sceneReady` returns true, and the crossing reveals with no overlay — even
though the scene is about to be re-pinned to the fine active depth and stream finer levels.

The `pin`-raise existed for a real reason (comment at `portals.ts:313-321`): a **legitimately
budget-degraded** scene never loads finer than its coarse pin, so revealing at `acceptable` would
stick the overlay forever waiting for blocks that never arrive. The fix must keep that protection
while ignoring a *stale neighbour* pin.

## Change

Reveal target becomes **the finest level this device will actually load for the scene**, floored at
the near-coarse `acceptable` level, and raised to the pin **only when the scene is genuinely the
active scene and its (fresh) pin is a legitimate hard-budget degrade** — never a stale neighbour pin.

### Pure, testable helper (`src/portal-preload.ts`)

Following the existing convention (`pinBatchAllowed`, `startSceneLodFloor`, `parseBudgetParam` — pure,
exported, unit-tested, then stringified into the runtime via `Function.toString()`):

```ts
// Reveal gate: the coarsest LOD level a crossing/reveal will accept as "showable".
//   acceptable = near-coarse floor (coarsest - revealMargin)
//   target     = finest level THIS device loads for the scene (deviceFinest clamped to the
//                scene's coarsest); the near-coarse acceptable until deviceFinest is known
//                -- deliberately NOT the current pinDepth, which for a scene being crossed
//                into is the stale coarse NEIGHBOUR depth and would reveal it at the coarsest.
//   guard      : only a genuinely-active, legitimately-degraded scene (hard-budget last resort,
//                pin coarser than the device target) may raise the gate to its fresh pin, so the
//                overlay does not stick waiting for levels it will never load.
export const computeRevealLevel = (
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

### Runtime `revealLevel` (`src/viewer-companion/portals.ts`)

Add `var computeRevealLevel = ${computeRevealLevel.toString()};` alongside the other stringified
helpers, add `computeRevealLevel` to the `portal-preload` import, and rewrite the function:

```js
function revealLevel(idx) {
  var oc = octrees[idx];
  var coarse = (oc && oc.lodLevels) ? oc.lodLevels - 1 : 0;
  return computeRevealLevel(coarse, REVEAL_MARGIN, deviceFinest, idx === activeIndex, pinReady, pinDepth[idx]);
}
```

`REVEAL_MARGIN` (currently 2) and all other behavior are unchanged.

## Behavior

| Situation | `deviceFinest` | `isActive` at gate | Old gate | New gate |
|---|---|---|---|---|
| Cross into coarse-preloaded scene (the bug) | 0 | false (dispatch) | coarsest (stale pin) → no overlay | `acceptable` (`L1`) → overlay until decent, refine `L0` in view |
| Capable device, neighbour preloaded fully | 0 | false | fine | fine — resident already, instant reveal (unchanged) |
| Low-end device | `L2` | — | (pin-dependent) | `L2` (= device target) |
| Active scene last-resort degraded (`pin` > deviceFinest) | 0 | true (post-crossing poll) | `pin` | `pin` — preserved by the guard, no stuck overlay |
| Before `deviceFinest` settles | null | — | `acceptable` | `acceptable` (unchanged) |
| Scene with fewer levels than `deviceFinest` | e.g. 2, scene coarse 1 | — | — | `min(2,1)=1` = that scene's coarsest (reveals fully) |

Why the guard is correct at both moments: at a crossing **dispatch** the destination is not yet
`activeIndex`, so its stale neighbour pin cannot raise the gate → the gate demands the device target
→ `ready=false`. `crossingReducer` maps `loaded && !ready` to `{ switchTo: target, overlay: 'poll' }`
(`portal-crossing.ts:93-96`), so the scene **still switches** (becomes active, `pinDesired` runs) and
the overlay covers it — it is not marked `shown` until the reveal (`dispatch` only sets `shown` for
the non-poll switch, `portals.ts:479`). One frame later `activeIndex` is the destination and
`pinDesired` has assigned its real active depth; the per-frame reveal **poll** re-evaluates
`revealLevel`, and only then (if the scene is genuinely degraded) does the guard let the fresh pin
raise the gate — so a legitimately-degraded active scene reveals promptly at its true coarse depth
instead of sticking behind the overlay.

## Blast radius

`revealLevel` has four call sites, all of which want the corrected value:
- `sceneRevealResident` → `sceneReady` — the **crossing** reveal gate (the fix).
- `sceneRevealResident(startSceneIdx)` — the **start-reveal** `startRevealed` latch. The start scene
  is always `isActive`, so a legit start-scene degrade is still honored via the guard; otherwise it
  reveals at the device target as before.
- The `crossing …` diagnostic `console.info` (`portals.ts:465`) and the `reveal …` diagnostic
  `console.info` (`portals.ts:986`) — both log the (now more accurate) gate depth only.

## Testing

- **Unit** (`test/portals.test.ts`): `computeRevealLevel` across every row of the behavior table —
  stale-neighbour-pin ignored (`isActive=false`, coarse pin does NOT raise), low-end clamp
  (`deviceFinest` floors the target), legit-degrade guard raises (`isActive && pinReady && pin >
  target`), `deviceFinest`-null → `acceptable`, and a scene with fewer levels than `deviceFinest`.
- **Release-build E2E** (`npm run build`, caching server, DevTools "Disable cache" UNCHECKED):
  1. Repro walk with `?residentBudget=11000000`: crossing into a coarse-preloaded scene now shows the
     loading overlay, then reveals at the near-coarse level (not the coarsest), and refines in view.
  2. No-param (realistic budget) crossings stay instant and sharp (no new overlay).
  3. Confirm the overlay does not stick: it always drops within a couple of seconds of the scene
     reaching the device target (or immediately, for an already-resident scene).

## Out of scope

- Follow-up #4 (active-scene coarsen partial unpin) — parked on branch
  `fix/active-scene-coarsen-partial-unpin` (`cccb5f8`), unaffected by this change.
- The `REVEAL_MARGIN` value itself (kept at 2).
