# Portal Viewer Crossing Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Series note:** This plan is #5 of a 6-plan series written 2026-07-02 against commit `916666a`. Plans 3, 5 (this one), and 6 of the series all modify `src/viewer-companion/portals.ts`; earlier plans (in particular plan #3, "portal viewer mobile memory": `docs/superpowers/plans/2026-07-02-portal-viewer-mobile-memory.md`) may have merged before this one executes. **Task 0 is a mandatory preflight: for each file:line citation and code anchor in this plan, grep to confirm the anchor still exists; if code has drifted, adapt the plan's snippets to the current code (this plan states the INTENT of every edit precisely for that purpose) rather than pasting blindly.**

**Goal:** Make portal crossings in the exported HTML viewer robust under slow loading: a crossing into a not-yet-loaded scene completes automatically once the scene loads (instead of being silently dropped forever), an abandoned mid-load overlay poll is cancelled (instead of falsely marking the abandoned scene ready), and the startup collision snapshot is keyed by the start scene index (instead of whatever scene happens to be active).

**Architecture:** All crossing/overlay lifecycle decisions move out of the injected IIFE template string into a new pure, stringifiable, unit-tested reducer `crossingReducer(state, event) -> { state, actions }` in `src/portal-crossing.ts` (same pattern as `src/portal-preload.ts`). The IIFE keeps its engine-coupled machinery (entity switch, collision swap, gsplat-count reveal poll) but becomes a dumb executor of the reducer's actions via a single `dispatch(event)` wiring function. The "retry a blocked crossing" mechanism is deliberately implicit: while blocked, `lastSafe` is frozen on the known side of the portal, so the crossing re-fires every frame and completes the frame the target's entity appears — no callbacks into any loading path needed.

**Tech Stack:** TypeScript (tsconfig: `strictNullChecks: false`, `noImplicitAny: true`), Vitest (Node env), Rollup + terser (release), `Function.prototype.toString()` stringification for viewer-companion helpers.

## Context

### Repo primer (read this first — you have zero other context)

SuperSplat (`C:\Dev\playcanvas\supersplat`) is a browser-based 3D Gaussian-splat editor built on the PlayCanvas engine + PCUI. This fork adds a **portals** feature: a project holds multiple scenes; the exported HTML viewer renders one scene at a time and swaps the active scene when the camera crosses a doorway (a portal rectangle with a scene index bound to each side).

The exported-viewer runtime lives in `src/viewer-companion/portals.ts` as:
- a hand-written IIFE **template string** (`companionRuntime`) injected into the exported HTML by `buildPortalsInjection(viewerSettingsJson)` (bottom of the file), plus
- **stringified pure helpers**: functions like `resolveActiveSplat` (from `src/portal-geom.ts`) and `buildPortalAdjacency` (from `src/portal-preload.ts`) are inlined into the IIFE via `Function.prototype.toString()`.

**CRITICAL stringification constraints** (violating these produces a runtime `ReferenceError` in RELEASE builds only, because terser mangles top-level names):
1. Any stringified helper must be fully self-contained — **no references to sibling functions, imports, or module-level variables**. The one allowed pattern is dependency injection: pass the sibling in as a parameter (see `resolveActiveSplat`'s `cross` param in `src/portal-geom.ts:80`).
2. Logic inside the IIFE template string is NOT unit-testable. Decision logic belongs in pure, exported, stringifiable helpers (pattern: `src/portal-geom.ts`, `src/portal-preload.ts`, `src/portal-anim-timeline.ts` — all pure + unit-tested); the template string stays thin wiring.
3. Any change to viewer-companion code MUST be E2E-verified with a **RELEASE build** (`npm run build`), not just debug.

Runtime shape today (all line refs against commit `916666a` — re-verify in Task 0):
- `switchTo(idx)` (`src/viewer-companion/portals.ts:110-118`) swaps the active scene: toggles entities, swaps collision, refines LOD, re-pins the adjacency frontier, and arms the streaming loading overlay (`beginLoading`) on a first visit. It **early-returns when `!entities[idx]`** (line 111).
- The per-frame `tick` (`:423-491`) does segment-vs-portal crossing math via `resolveActiveSplat` and maintains `lastSafe` (last camera position on the known side). In anim mode the active scene is instead a pure function of the cursor time (baked timeline).
- The streaming loading overlay is a poll inside `tick` (`:461-489`): while `pendingIndex !== null` it compares the **global** `app.renderer._gsplatCount` against a payload-baked per-scene `revealThreshold` (`portalSceneLodCounts`), with plateau + safety-cap fallbacks; on reveal `endLoading()` (`:210-214`) marks `readyScenes[pendingIndex] = true` and hides the backdrop.
- `preloadCollisions` (`:273-296`) fetches per-scene voxel collision data, first snapshotting the live (viewer-loaded) collision into `voxels[activeIndex]` (line 282).
- `readyScenes[idx]` is also set by `pinSceneToLevel`'s awaitResident loop (`:650`) and **cleared** by `unpinScene` on frontier reclaim (`:673`).

### The three defects being fixed (verified audit findings)

**Finding 1 [MED] — a free-nav crossing into a not-yet-loaded scene is silently dropped and never retried.**
`switchTo` early-returns when `!entities[idx]` (`:111`), and the crossing guard in `tick` requires `entities[next]` (`:448`) — but `lastSafe = cur` (`:452`) still advances past the portal plane. Failure mode: slow network + user walks through a doorway before the target scene's asset has loaded → the user is physically in scene B's space while scene A renders, **permanently**, until they walk back and re-cross. (Anim mode self-heals because the baked timeline re-asserts the scene every frame; free navigation does not.)

**Finding 2 [MED] — the loading-overlay poll is not cancelled when the user switches away mid-load.**
Crossing A→B arms the poll (`pendingIndex = B`). Crossing B→A before B reveals: `switchTo(A)` has no cancel path (`:110-118` — the guard `pendingIndex !== idx` only prevents re-arming for the same index), so the poll keeps running while scene A renders. A's fully-loaded gsplat count satisfies B's `revealThreshold` (or the plateau fallback fires) → `endLoading()` falsely marks `readyScenes[B] = true` (`:210-214`). Consequence: the next crossing into B shows **no overlay** over a cold, black/hazy scene. Worse, the frontier reclaim (`unpinScene`, `:673`) can later set `readyScenes[idx] = false`, which a still-stale poll re-sets to true.

**Finding 3 [LOW] — startup collision snapshot race.**
`preloadCollisions` snapshots the live (start-scene) collision into `voxels[activeIndex]` (`:282`). The viewer loads its collision asynchronously; if a crossing happened before that finished, `activeIndex` is some scene k ≠ start, so scene k permanently gets the start scene's voxels AND its real URL is never fetched (the `idx === activeIndex` skip at `:285`). Note the live collision at snapshot time is always the **start scene's** (a crossing before the voxels arrived left `swapCollision` a no-op), so the snapshot content is right — only the key is wrong.

### Chosen design and why

**One state machine, not two.** Findings 1 and 2 are the same lifecycle: "a crossing wants scene X active, X may need loading, an overlay may be up for X, and X may be abandoned for Y before it finishes." So both are fixed by a single pure reducer, `crossingReducer` in a new `src/portal-crossing.ts`.

**States** (the audit sketched `idle / pendingTarget / overlayArmed / revealing`; this design merges the last into an instantaneous transition):

| Mode | Meaning | Overlay | Reveal poll | `lastSafe` |
|---|---|---|---|---|
| `idle` | nothing pending | hidden | stopped | advances |
| `blocked` | crossing detected, target's **entity does not exist yet** (audit's `pendingTarget`) | shown (backdrop only) | stopped (nothing to poll — the entity isn't rendering) | **frozen** on the known side |
| `loading` | switch performed, streaming target not yet revealed (audit's `overlayArmed`) | shown via poll | running for `target` | advances |

`revealing` is not a state: the `revealed` event transitions `loading → idle` in one step (mark ready + hide).

**Events** (built by the wiring each frame; the reducer never touches engine state):
- `{ type: 'crossing', target, loaded, ready }` — a free-nav crossing, an anim-timeline assertion, or a camera-reset assertion wants `target` active. `loaded = !!entities[target]`; `ready` = no overlay needed (SOG scenes: always once loaded; streaming scenes: `!!readyScenes[target]`).
- `{ type: 'noCrossing' }` — a frame with no pending crossing. Only `blocked` reacts (the user retreated to the known side before the target loaded → stand down).
- `{ type: 'revealed', target }` — the wiring's gsplat-count poll met a reveal condition for `target`.

**Actions** (`{ switchTo: number|null, overlay: 'keep'|'show'|'poll'|'hide', markReady: number|null }`):
- `switchTo` — perform the entity/collision/pin switch now.
- `overlay: 'show'` — backdrop visible, poll stopped (blocked phase). `'poll'` — (re)arm the reveal poll for the new target. `'hide'` — backdrop hidden + poll stopped **without marking anything ready** (this is the finding-2 fix). `'keep'` — no change.
- `markReady` — record the scene as revealed (`readyScenes`).

**Why frozen-`lastSafe` retry instead of an explicit `pendingSwitch` + load-callback plumbing:** `resolveActiveSplat(lastSafe, cur, ...)` already runs every frame. If `lastSafe` is NOT advanced past the portal while blocked, the segment `lastSafe → cur` keeps crossing the portal, so the crossing re-fires into the reducer every frame (the reducer is **idempotent** for a repeated same-target blocked crossing — verified by a named unit test). The frame `entities[target]` appears, the same re-fire carries `loaded: true` and the switch completes — at most one frame of latency, with zero coupling to *how* the entity came to exist (the `loadFromUrl` callback today, or whatever on-demand/frontier loading plan #3 introduced). Retreat cancellation also falls out naturally: once the user walks back, the segment no longer crosses, the wiring emits `noCrossing`, and `blocked → idle` hides the overlay. Multi-portal segments stay correct too, because `resolveActiveSplat` applies all crossings along the (longer) frozen segment in order. This is the simplest correct design; an explicit pending-retry loop or per-mechanism callbacks would duplicate it with more moving parts.

**`lastSafe` semantics, decided precisely:** `lastSafe` advances to the current camera position every frame **except** when the reducer is in `blocked` mode after this frame's dispatch (free-nav branch only; in anim mode it always advances, preserving the existing "keep fresh in both modes" hand-off rule, `src/viewer-companion/portals.ts:433-441`). On camera reset it is still cleared to `null` (spawn discontinuity must not read as a crossing).

**Finding 3 fix intent (express relative to behavior, not exact strings):** the startup snapshot of the viewer-loaded collision must be keyed by the **start scene index** (`data.portalStart || 0` — verified: `buildPortalsInjection` bakes `portalStart` into the payload, `src/viewer-companion/portals.ts:761`), never by the current `activeIndex`; and no non-start scene may be skipped from fetching its real voxel URL merely because it is currently active. If plan #3 restructured `preloadCollisions` into frontier-managed fetching, apply that same intent to whatever code snapshots the live collision.

### Coordination with plan #3 (mobile memory)

Plan #3 (`docs/superpowers/plans/2026-07-02-portal-viewer-mobile-memory.md`) rewrites parts of this same file (SOG frontier-loading, pin-depth cap, collision-voxel frontier management, incremental warming) and is expected to have merged first. Consequences for this plan:
- SOG frontier-loading may mean extra-scene entities are created **on demand**, not all at startup — which makes finding 1 *more* likely and this fix *more* important. The design reads `!!entities[target]` live every frame, so it is agnostic to who creates the entity and when.
- If plan #3 renamed/moved the overlay poll variables (`pendingIndex`, `readyScenes`, `beginLoading`, …) or `switchTo`, keep this plan's reducer contract intact and adapt only the `dispatch` wiring names in Task 2.
- Rule to enforce during Task 2 regardless of drift: **every code path that changes `activeIndex` must go through `dispatch`** (i.e. through the reducer), so no path can leave a stale poll or a dropped crossing behind.

## Global Constraints

- Use Bash (Git Bash on Windows), never PowerShell. Run commands plainly from the repo root — no `cd`, `git -C`, or `npm --prefix` prefixes (they trigger permission prompts).
- ESLint is pinned to v10 and **crashes on `import/order` autofix** — never run `eslint --fix` for import ordering; match surrounding import order by hand.
- Never delete `package-lock.json`.
- `tsconfig`: `strictNullChecks: false`, `noImplicitAny: true`. Match surrounding code style; comments explain constraints, not narration.
- Don't touch code unrelated to the task.
- Stringified helpers must be fully self-contained (no sibling/import/module-variable references; dependency injection only). All string literals used inside a stringified function must be inline literals, never module-level constants.
- Any viewer-companion change must be E2E-verified with a RELEASE build (`npm run build`) — minification bugs only appear in release.
- Tests: `npm run test` (all), `npx vitest run test/portal-crossing.test.ts` (one file). Lint: `npm run lint`.
- Work on a feature branch; at the end, squash all commits into a single commit per project convention.

---

### Task 0: Preflight — branch + reconcile anchors against the current code

**Files:**
- Read: `src/viewer-companion/portals.ts`, `src/portal-geom.ts`, `src/portal-preload.ts`
- Read (if present): `docs/superpowers/plans/2026-07-02-portal-viewer-mobile-memory.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a confirmed (or adapted) anchor map used by Tasks 2–3.

- [ ] **Step 1: Create the feature branch**

```bash
git checkout main
git pull --ff-only || true
git checkout -b feature/portal-crossing-robustness
```

Expected: on branch `feature/portal-crossing-robustness`.

- [ ] **Step 2: Check whether plan #3 merged and read it if so**

```bash
git log --oneline -10
ls docs/superpowers/plans/ | grep 2026-07-02
```

If `2026-07-02-portal-viewer-mobile-memory.md` exists and/or a mobile-memory commit is in the log, read that plan's tasks touching `src/viewer-companion/portals.ts` so you know what moved.

- [ ] **Step 3: Verify every anchor this plan relies on**

Run each grep; record hit/miss. A miss means the code drifted — find the equivalent code by intent (right column) and adapt the snippets in Tasks 2–3 accordingly. Do NOT abort on a miss.

```bash
grep -n "function switchTo(idx)" src/viewer-companion/portals.ts
grep -n "beginLoading(idx); }" src/viewer-companion/portals.ts
grep -n "function endLoading()" src/viewer-companion/portals.ts
grep -n "pendingIndex" src/viewer-companion/portals.ts
grep -n "readyScenes" src/viewer-companion/portals.ts
grep -n "resolveActiveSplat(lastSafe, cur, rects, activeIndex, segmentCrossesRect)" src/viewer-companion/portals.ts
grep -n "lastSafe = cur" src/viewer-companion/portals.ts
grep -n "inputEvent" src/viewer-companion/portals.ts
grep -n "voxels\[activeIndex\] = snapshot(live)" src/viewer-companion/portals.ts
grep -n "idx === activeIndex || voxels\[idx\]" src/viewer-companion/portals.ts
grep -n "portalStart" src/viewer-companion/portals.ts
```

| Anchor (at `916666a`) | Intent if drifted |
|---|---|
| `switchTo(idx)` early-returns on `!entities[idx]` and ends with a conditional `beginLoading(idx)` (`:110-118`) | The scene-switch function must lose its overlay-arming side effect; overlay decisions move to the reducer. Keep the switch mechanics (enable entity, swap collision, refine, re-pin) whatever they now are. |
| free-nav branch: crossing guard requires `entities[next]`, then unconditional `lastSafe = cur` (`:447-452`) | Replace the guard with a `dispatch({type:'crossing', ...})` carrying `loaded`/`ready` booleans, and freeze `lastSafe` while the post-dispatch mode is `blocked`. |
| anim branch: `switchTo(sceneAtTime(...))` (`:443`) | Route through `dispatch` too (only when the wanted scene differs from `activeIndex`, plus a `noCrossing` to clear a stale `blocked`). |
| overlay poll gated on `pendingIndex !== null`, reveal calls `endLoading()`, catch calls `endLoading()` (`:461-489`) | Reveal must become a `dispatch({type:'revealed', target})`; cancellation paths must never mark the abandoned target ready. |
| reset handler: `if (name === 'reset') { switchTo(data.portalStart \|\| 0); lastSafe = null; }` (`:376-378`) | Reset must clear any pending crossing/overlay via the reducer and still null `lastSafe`. |
| `voxels[activeIndex] = snapshot(live)` + `idx === activeIndex \|\| voxels[idx]` skip (`:282`, `:285`) | Snapshot keyed by `data.portalStart \|\| 0`; skip a scene's URL fetch only when its voxels are already present, never because it is currently active. Plan #3 may have restructured this into frontier fetching — apply the same intent there. |
| `readyScenes[idx] = false` in `unpinScene` (`:673`) | Reclaim clears readiness; the stale-poll fix must ensure a cancelled poll cannot resurrect it. |

- [ ] **Step 4: Confirm the payload start-index field name**

```bash
grep -n "portalStart" src/viewer-companion/portals.ts src/portal-export.ts
```

Expected: the injection payload contains `portalStart` (at `916666a`: `src/viewer-companion/portals.ts:761`) and the runtime reads `data.portalStart || 0`. If the field was renamed, substitute the new name everywhere this plan says `data.portalStart || 0`.

- [ ] **Step 5: Baseline: tests + lint pass before any change**

```bash
npm run test
npm run lint
```

Expected: both pass (if they fail on a clean checkout, stop and report — do not build on a broken baseline).

No commit for this task (nothing changed).

---

### Task 1: Pure crossing reducer (`src/portal-crossing.ts`) — TDD

**Files:**
- Create: `src/portal-crossing.ts`
- Test: `test/portal-crossing.test.ts`

**Interfaces:**
- Consumes: nothing (pure, self-contained — stringification constraint).
- Produces (Task 2 relies on these exact names):
  - `crossingReducer(state: CrossingState, event: CrossingEvent): CrossingResult`
  - `CrossingState = { mode: 'idle'|'blocked'|'loading', target: number|null }`
  - `CrossingEvent = { type:'crossing', target:number, loaded:boolean, ready:boolean } | { type:'noCrossing' } | { type:'revealed', target:number }`
  - `CrossingActions = { switchTo: number|null, overlay: 'keep'|'show'|'poll'|'hide', markReady: number|null }`
  - `CrossingResult = { state: CrossingState, actions: CrossingActions }`

- [ ] **Step 1: Write the failing tests**

Create `test/portal-crossing.test.ts` with exactly:

```ts
import { describe, it, expect } from 'vitest';

import { crossingReducer, CrossingState } from '../src/portal-crossing';

const idle: CrossingState = { mode: 'idle', target: null };

describe('crossingReducer', () => {
    it('switches immediately on a crossing into a loaded, ready scene', () => {
        const r = crossingReducer(idle, { type: 'crossing', target: 2, loaded: true, ready: true });
        expect(r.state).toEqual({ mode: 'idle', target: null });
        expect(r.actions).toEqual({ switchTo: 2, overlay: 'keep', markReady: null });
    });

    it('switches and arms the reveal poll for a loaded but not-yet-ready streaming scene', () => {
        const r = crossingReducer(idle, { type: 'crossing', target: 1, loaded: true, ready: false });
        expect(r.state).toEqual({ mode: 'loading', target: 1 });
        expect(r.actions).toEqual({ switchTo: 1, overlay: 'poll', markReady: null });
    });

    it('drop-crossing-retry: blocks on an unloaded target, stays idempotent while re-fired, then completes the switch when the target loads', () => {
        // frame 1: crossing detected, scene 1 not loaded -> blocked + overlay shown
        let r = crossingReducer(idle, { type: 'crossing', target: 1, loaded: false, ready: false });
        expect(r.state).toEqual({ mode: 'blocked', target: 1 });
        expect(r.actions).toEqual({ switchTo: null, overlay: 'show', markReady: null });
        // frames 2..n: frozen lastSafe re-fires the same crossing -> pure no-op
        r = crossingReducer(r.state, { type: 'crossing', target: 1, loaded: false, ready: false });
        expect(r.state).toEqual({ mode: 'blocked', target: 1 });
        expect(r.actions).toEqual({ switchTo: null, overlay: 'keep', markReady: null });
        // frame n+1: entity appeared and the scene is ready (e.g. SOG) -> switch + hide
        r = crossingReducer(r.state, { type: 'crossing', target: 1, loaded: true, ready: true });
        expect(r.state).toEqual({ mode: 'idle', target: null });
        expect(r.actions).toEqual({ switchTo: 1, overlay: 'hide', markReady: null });
    });

    it('blocked target that loads but is not yet revealed switches and polls', () => {
        const blocked: CrossingState = { mode: 'blocked', target: 1 };
        const r = crossingReducer(blocked, { type: 'crossing', target: 1, loaded: true, ready: false });
        expect(r.state).toEqual({ mode: 'loading', target: 1 });
        expect(r.actions).toEqual({ switchTo: 1, overlay: 'poll', markReady: null });
    });

    it('cancels the blocked overlay when the user retreats to the known side', () => {
        const blocked: CrossingState = { mode: 'blocked', target: 1 };
        const r = crossingReducer(blocked, { type: 'noCrossing' });
        expect(r.state).toEqual({ mode: 'idle', target: null });
        expect(r.actions).toEqual({ switchTo: null, overlay: 'hide', markReady: null });
    });

    it('blocked retarget: a crossing into a different unloaded scene re-blocks on the new target', () => {
        const blocked: CrossingState = { mode: 'blocked', target: 1 };
        const r = crossingReducer(blocked, { type: 'crossing', target: 2, loaded: false, ready: false });
        expect(r.state).toEqual({ mode: 'blocked', target: 2 });
        expect(r.actions).toEqual({ switchTo: null, overlay: 'show', markReady: null });
    });

    it('A→B→A stale poll: switching back before reveal drops the poll without marking B ready, and a late reveal for B is ignored', () => {
        // cross into streaming scene B (=1): loading + poll armed
        let r = crossingReducer(idle, { type: 'crossing', target: 1, loaded: true, ready: false });
        expect(r.state).toEqual({ mode: 'loading', target: 1 });
        // cross back into A (=0, ready) before B reveals: switch + hide, NO markReady
        r = crossingReducer(r.state, { type: 'crossing', target: 0, loaded: true, ready: true });
        expect(r.state).toEqual({ mode: 'idle', target: null });
        expect(r.actions).toEqual({ switchTo: 0, overlay: 'hide', markReady: null });
        // a stale reveal for B (an un-cancelled poll, or reclaim racing) must be ignored
        r = crossingReducer(r.state, { type: 'revealed', target: 1 });
        expect(r.state).toEqual({ mode: 'idle', target: null });
        expect(r.actions).toEqual({ switchTo: null, overlay: 'keep', markReady: null });
    });

    it('reveal completes: marks the polled target ready and hides the overlay', () => {
        const loading: CrossingState = { mode: 'loading', target: 1 };
        const r = crossingReducer(loading, { type: 'revealed', target: 1 });
        expect(r.state).toEqual({ mode: 'idle', target: null });
        expect(r.actions).toEqual({ switchTo: null, overlay: 'hide', markReady: 1 });
    });

    it('noCrossing while loading keeps the poll running', () => {
        const loading: CrossingState = { mode: 'loading', target: 1 };
        const r = crossingReducer(loading, { type: 'noCrossing' });
        expect(r.state).toEqual({ mode: 'loading', target: 1 });
        expect(r.actions).toEqual({ switchTo: null, overlay: 'keep', markReady: null });
    });

    it('a crossing into another not-yet-ready scene mid-load restarts the poll for the new target', () => {
        const loading: CrossingState = { mode: 'loading', target: 1 };
        const r = crossingReducer(loading, { type: 'crossing', target: 2, loaded: true, ready: false });
        expect(r.state).toEqual({ mode: 'loading', target: 2 });
        expect(r.actions).toEqual({ switchTo: 2, overlay: 'poll', markReady: null });
    });

    it('a crossing into an unloaded scene mid-load drops the poll (no markReady) and blocks on the new target', () => {
        const loading: CrossingState = { mode: 'loading', target: 1 };
        const r = crossingReducer(loading, { type: 'crossing', target: 2, loaded: false, ready: false });
        expect(r.state).toEqual({ mode: 'blocked', target: 2 });
        expect(r.actions).toEqual({ switchTo: null, overlay: 'show', markReady: null });
    });

    it('repeated crossing events for the already-loading target are no-ops', () => {
        const loading: CrossingState = { mode: 'loading', target: 1 };
        const r = crossingReducer(loading, { type: 'crossing', target: 1, loaded: true, ready: false });
        expect(r.state).toEqual({ mode: 'loading', target: 1 });
        expect(r.actions).toEqual({ switchTo: null, overlay: 'keep', markReady: null });
    });

    it('stale revealed events are ignored in idle and blocked', () => {
        let r = crossingReducer(idle, { type: 'revealed', target: 1 });
        expect(r.state).toEqual(idle);
        expect(r.actions).toEqual({ switchTo: null, overlay: 'keep', markReady: null });
        r = crossingReducer({ mode: 'blocked', target: 2 }, { type: 'revealed', target: 2 });
        expect(r.state).toEqual({ mode: 'blocked', target: 2 });
        expect(r.actions).toEqual({ switchTo: null, overlay: 'keep', markReady: null });
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run test/portal-crossing.test.ts
```

Expected: FAIL — cannot resolve `../src/portal-crossing` (module does not exist).

- [ ] **Step 3: Write the implementation**

Create `src/portal-crossing.ts` with exactly:

```ts
// Crossing/overlay lifecycle state machine for the exported portal viewer.
//
// The exported-viewer runtime (viewer-companion/portals.ts) detects portal
// crossings each frame and must decide: switch scenes now, hold a crossing
// into a scene whose entity has not loaded yet, arm or drop the streaming
// loading-overlay reveal poll, and record reveal completion. Keeping those
// decisions in the injected IIFE made them untestable and produced two bugs
// (a dropped never-retried crossing; a stale poll falsely marking an
// abandoned scene ready), so they live here as a pure reducer instead. The
// IIFE stringifies this function in (Function.toString()) and just applies
// the returned actions.
//
// Modes:
//   idle    - nothing pending.
//   blocked - a crossing was detected but the target scene's entity does not
//             exist yet. The wiring shows the overlay backdrop and FREEZES
//             lastSafe on the known side of the portal, so the same crossing
//             re-fires every frame (this reducer is idempotent for it) and
//             the switch completes on the first frame the target is loaded -
//             no load-callback plumbing needed.
//   loading - the switch happened but the streaming target has not revealed
//             yet; the wiring runs its gsplat-count reveal poll for `target`.
//
// Overlay directives: 'keep' = leave backdrop/poll as they are; 'show' =
// backdrop visible, poll stopped (blocked phase); 'poll' = (re)arm the reveal
// poll for the new state.target; 'hide' = backdrop hidden + poll stopped
// WITHOUT marking anything ready (an abandoned target must not be marked
// ready - only an explicit markReady may do that).
//
// Pure and self-contained (no imports, no sibling-function or module-variable
// references; all literals inline) so it can be stringified verbatim into the
// exported viewer runtime - see the constraint note in viewer-companion/portals.ts.

type CrossingMode = 'idle' | 'blocked' | 'loading';

type CrossingState = {
    mode: CrossingMode,
    target: number | null   // blocked: scene awaited; loading: scene polled; idle: null
};

type CrossingEvent =
    // A crossing (or anim-timeline / camera-reset assertion) wants `target`
    // active. loaded = its entity exists; ready = no overlay needed (SOG
    // scenes once loaded; streaming scenes once revealed or pinned resident).
    { type: 'crossing', target: number, loaded: boolean, ready: boolean } |
    // A frame with no pending crossing (only blocked reacts: user retreated).
    { type: 'noCrossing' } |
    // The wiring's reveal poll decided `target` is visibly present.
    { type: 'revealed', target: number };

type OverlayDirective = 'keep' | 'show' | 'poll' | 'hide';

type CrossingActions = {
    switchTo: number | null,    // perform the scene switch (entities/collision/pins)
    overlay: OverlayDirective,
    markReady: number | null    // record this scene as revealed
};

type CrossingResult = { state: CrossingState, actions: CrossingActions };

const crossingReducer = (state: CrossingState, event: CrossingEvent): CrossingResult => {
    const none: CrossingActions = { switchTo: null, overlay: 'keep', markReady: null };
    if (event.type === 'crossing') {
        const u = event.target;
        if (!event.loaded) {
            // Target entity missing: hold the crossing as blocked. Idempotent
            // for the per-frame re-fire produced by the frozen lastSafe.
            if (state.mode === 'blocked' && state.target === u) {
                return { state: state, actions: none };
            }
            return {
                state: { mode: 'blocked', target: u },
                actions: { switchTo: null, overlay: 'show', markReady: null }
            };
        }
        if (event.ready) {
            // Loaded + ready: switch now. Any pending overlay/poll is dropped
            // WITHOUT marking its abandoned target ready (stale-poll fix).
            if (state.mode === 'loading' && state.target === u) {
                return { state: state, actions: none };   // already active + polling
            }
            return {
                state: { mode: 'idle', target: null },
                actions: { switchTo: u, overlay: state.mode === 'idle' ? 'keep' : 'hide', markReady: null }
            };
        }
        // Loaded but not yet revealed (streaming): switch and run the reveal poll.
        if (state.mode === 'loading' && state.target === u) {
            return { state: state, actions: none };       // poll already running
        }
        return {
            state: { mode: 'loading', target: u },
            actions: { switchTo: u, overlay: 'poll', markReady: null }
        };
    }
    if (event.type === 'noCrossing') {
        // Only blocked reacts: the user retreated to the known side before the
        // target loaded. loading keeps polling; idle is a no-op.
        if (state.mode === 'blocked') {
            return {
                state: { mode: 'idle', target: null },
                actions: { switchTo: null, overlay: 'hide', markReady: null }
            };
        }
        return { state: state, actions: none };
    }
    // 'revealed'
    if (state.mode === 'loading' && state.target === event.target) {
        return {
            state: { mode: 'idle', target: null },
            actions: { switchTo: null, overlay: 'hide', markReady: event.target }
        };
    }
    // Stale reveal (a poll result for an abandoned target) -> ignore.
    return { state: state, actions: none };
};

export { crossingReducer, CrossingState, CrossingEvent, CrossingActions, CrossingResult, CrossingMode, OverlayDirective };
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run test/portal-crossing.test.ts
```

Expected: PASS — 13 tests.

- [ ] **Step 5: Lint**

```bash
npm run lint
```

Expected: no errors. (If an import-order warning appears anywhere, fix it by hand — never with `--fix`.)

- [ ] **Step 6: Commit**

```bash
git add src/portal-crossing.ts test/portal-crossing.test.ts
git commit -m "feat(portals): pure crossing/overlay lifecycle reducer (portal-crossing)"
```

---

### Task 2: Wire the reducer into the exported-viewer runtime

**Files:**
- Modify: `src/viewer-companion/portals.ts` (line refs below are at `916666a`; adapt per Task 0)
- Test: `test/portals-injection.test.ts`

**Interfaces:**
- Consumes: `crossingReducer` and its `CrossingState`/`CrossingEvent`/`CrossingActions` shapes from Task 1 (stringified into the IIFE; also imported at module top for the `.toString()` call).
- Produces: IIFE-internal `dispatch(ev)`, `sceneReady(idx)`, `crossState` used by `tick`, the reset handler, and the overlay poll. No new module exports.

> All edits below are inside `src/viewer-companion/portals.ts`. Edits C–G are inside the `companionRuntime` **template string** — this code is untestable by unit tests (engine-coupled wiring); coverage comes from the reducer tests (Task 1), the injection contain-checks (this task), lint + release build, and Task 4's manual E2E. Keep the two-space indentation used inside the template string.

- [ ] **Step 1: Add failing injection tests**

In `test/portals-injection.test.ts`, append inside the existing `describe('buildPortalsInjection', ...)` block (after the `'includes the two-level coarse-LOD cache-warming routine in the runtime'` test):

```ts
    it('routes crossings through the pure crossing reducer', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/lod-meta.json'],
            portalStart: 0
        });
        // the reducer is stringified into the runtime and driven via dispatch
        expect(out).toContain('crossingReducer');
        expect(out).toContain('noCrossing');
        expect(out).toContain('revealed');
        // blocked crossings freeze lastSafe so the crossing re-fires until the target loads
        expect(out).toContain("mode !== 'blocked'");
        // switching away mid-load must never keep the old arming path
        expect(out).not.toContain('pendingIndex !== idx');
    });
```

- [ ] **Step 2: Run the injection tests to verify the new case fails**

```bash
npx vitest run test/portals-injection.test.ts
```

Expected: FAIL — the new test's `toContain('crossingReducer')` assertion fails; all pre-existing tests still pass.

- [ ] **Step 3: Edit A — import the reducer**

At the top of `src/viewer-companion/portals.ts`, change:

```ts
import { buildPortalAnimTimeline } from '../portal-anim-timeline';
import { segmentCrossesRect, resolveActiveSplat } from '../portal-geom';
```

to (alphabetical position, matching the surrounding order — do this by hand, never `eslint --fix`):

```ts
import { buildPortalAnimTimeline } from '../portal-anim-timeline';
import { crossingReducer } from '../portal-crossing';
import { segmentCrossesRect, resolveActiveSplat } from '../portal-geom';
```

- [ ] **Step 4: Edit B — stringify the reducer into the IIFE preamble**

In the `companionRuntime` template string, change:

```
  var segmentCrossesRect = ${segmentCrossesRect.toString()};
  var resolveActiveSplat = ${resolveActiveSplat.toString()};
```

to:

```
  var segmentCrossesRect = ${segmentCrossesRect.toString()};
  var resolveActiveSplat = ${resolveActiveSplat.toString()};
  var crossingReducer = ${crossingReducer.toString()};
```

Also update the stale runtime doc comment just above `companionRuntime` (lines 53–58): change the sentence

```
// crosses a portal, and swaps the walk/fly collision to match. The two pure
// crossing helpers are stringified in from portal-geom so the geometry is shared
// and unit-tested. Everything else is dep-internal (the live pc.AppBase and the
```

to:

```
// crosses a portal, and swaps the walk/fly collision to match. The pure crossing
// helpers (portal-geom) and the crossing/overlay lifecycle reducer
// (portal-crossing) are stringified in so they stay shared and unit-tested.
// Everything else is dep-internal (the live pc.AppBase and the
```

- [ ] **Step 5: Edit C — strip overlay arming from `switchTo`**

Inside the template string, replace (currently `:108-118`):

```
  // Switch to scene idx: enable it, swap collision, and arm the streaming
  // loading overlay on a first visit. No-op when already active or not loaded.
  function switchTo(idx) {
    if (idx === activeIndex || idx === null || !entities[idx]) return;
    activeIndex = idx;
    applyActive();
    swapCollision(idx);
    scheduleRefine(idx);
    pinWhenBudgetReady();
    if (streaming && !readyScenes[idx] && pendingIndex !== idx) { beginLoading(idx); }
  }
```

with:

```
  // Switch to scene idx: enable it, swap collision, refine + re-pin. Overlay
  // arming/cancelling is decided by crossingReducer (via dispatch), not here.
  // No-op when already active or not loaded (defensive: dispatch only emits
  // switchTo for scenes whose entity exists).
  function switchTo(idx) {
    if (idx === activeIndex || idx === null || !entities[idx]) return;
    activeIndex = idx;
    applyActive();
    swapCollision(idx);
    scheduleRefine(idx);
    pinWhenBudgetReady();
  }
```

Intent if drifted: whatever `switchTo` now does, remove only its overlay-arming/`beginLoading` side effect; keep every other switch mechanic.

- [ ] **Step 6: Edit D — replace `endLoading` with `sceneReady` + `dispatch`**

Inside the template string, replace (currently `:203-214`):

```
  // Arm the overlay for a first-time crossing into scene idx. showLoading is
  // deferred to the poll (SHOW_DELAY) so an already-resident scene never flashes.
  function beginLoading(idx) {
    pendingIndex = idx; pendingFrames = 0; overlayShown = false;
    peakCount = 0; plateauFrames = 0; crossedBelow = false;
    revealThreshold = lodThreshold(idx);
  }
  function endLoading() {
    if (pendingIndex !== null) { readyScenes[pendingIndex] = true; }
    hideLoading();
    pendingIndex = null; overlayShown = false;
  }
```

with:

```
  // Arm the overlay for a first-time crossing into scene idx. showLoading is
  // deferred to the poll (SHOW_DELAY) so an already-resident scene never flashes.
  function beginLoading(idx) {
    pendingIndex = idx; pendingFrames = 0; overlayShown = false;
    peakCount = 0; plateauFrames = 0; crossedBelow = false;
    revealThreshold = lodThreshold(idx);
  }
  // A scene is "ready" when a crossing into it needs no loading overlay: SOG
  // scenes are fully resident the moment their entity exists; streaming scenes
  // once revealed (markReady) or pinned resident (pinSceneToLevel).
  function sceneReady(idx) {
    if (!streaming) return true;
    return !!readyScenes[idx];
  }
  // Crossing/overlay lifecycle. ALL decisions (switch now, hold a crossing into
  // a not-yet-loaded scene, arm/drop the reveal poll, mark revealed) live in
  // the pure, unit-tested crossingReducer; this wiring just applies its actions.
  // 'hide' and 'show' deliberately clear pendingIndex WITHOUT touching
  // readyScenes: an abandoned poll must never mark its target ready (a stale
  // poll once did, and frontier reclaim could then be undone by it).
  var crossState = { mode: 'idle', target: null };
  function dispatch(ev) {
    var res = crossingReducer(crossState, ev);
    crossState = res.state;
    var a = res.actions;
    if (a.switchTo !== null) { switchTo(a.switchTo); }
    if (a.markReady !== null) { readyScenes[a.markReady] = true; }
    if (a.overlay === 'show') { pendingIndex = null; showLoading(); }
    else if (a.overlay === 'poll') { beginLoading(crossState.target); }
    else if (a.overlay === 'hide') { pendingIndex = null; hideLoading(); }
  }
```

Intent if drifted: `beginLoading` (or its plan-#3 equivalent) stays the only poll-armer; `endLoading` disappears entirely (its two former callers are rewired in Steps 7–8); `dispatch` is the single entry point that may change `activeIndex`.

- [ ] **Step 7: Edit E — route the `tick` crossing branches through `dispatch` and freeze `lastSafe` while blocked**

Inside the template string's `tick`, replace (currently `:442-452`):

```
        if (st && st.cameraMode === 'anim' && timeline) {
          switchTo(sceneAtTime(st.animationTime || 0));
        } else if (lastSafe) {
          // A crossing whose target scene has not finished loading (entities[next]
          // missing) is skipped; eager preload at startup makes this rare.
          var next = resolveActiveSplat(lastSafe, cur, rects, activeIndex, segmentCrossesRect);
          if (next !== activeIndex && next !== null && entities[next]) {
            switchTo(next);
          }
        }
        lastSafe = cur;
```

with:

```
        if (st && st.cameraMode === 'anim' && timeline) {
          var want = sceneAtTime(st.animationTime || 0);
          if (want !== activeIndex) {
            dispatch({ type: 'crossing', target: want, loaded: !!entities[want], ready: sceneReady(want) });
          } else if (crossState.mode === 'blocked') {
            dispatch({ type: 'noCrossing' });   // timeline moved back before the target loaded
          }
          lastSafe = cur;                       // anim mode: keep fresh for the mode hand-off
        } else if (lastSafe) {
          var next = resolveActiveSplat(lastSafe, cur, rects, activeIndex, segmentCrossesRect);
          if (next !== activeIndex && next !== null) {
            // Crossing detected. A target whose entity is missing is held as
            // 'blocked' (overlay up, lastSafe frozen below): the frozen segment
            // re-fires this crossing every frame (the reducer is idempotent for
            // it) and the switch completes the frame the entity appears.
            dispatch({ type: 'crossing', target: next, loaded: !!entities[next], ready: sceneReady(next) });
          } else if (crossState.mode === 'blocked') {
            dispatch({ type: 'noCrossing' });   // user retreated to the known side
          }
          // Freeze lastSafe while blocked so the pending crossing keeps firing;
          // advance it normally otherwise.
          if (crossState.mode !== 'blocked') { lastSafe = cur; }
        } else {
          lastSafe = cur;
        }
```

Intent if drifted: the free-nav branch emits `crossing`/`noCrossing` events instead of gating on `entities[next]`, and `lastSafe` advancement becomes conditional on the post-dispatch mode; the anim branch asserts the timeline scene through `dispatch` (plus `noCrossing` to clear a stale `blocked`) and always advances `lastSafe`.

- [ ] **Step 8: Edit F — poll completion dispatches `revealed`; the catch never resurrects readiness incorrectly**

Inside the template string's `tick` overlay block, replace (currently `:476-489`):

```
        var ready =
          (revealThreshold > 0 && crossedBelow && c >= revealThreshold) ||
          (peakCount > 0 && plateauFrames >= PLATEAU_FRAMES) ||
          (pendingFrames > LOADING_MAX_FRAMES);
        if (ready) {
          endLoading();
        } else if (!overlayShown && pendingFrames >= SHOW_DELAY) {
          showLoading();
          overlayShown = true;
        }
      }
    } catch (e) {
      endLoading();
    }
```

with:

```
        var ready =
          (revealThreshold > 0 && crossedBelow && c >= revealThreshold) ||
          (peakCount > 0 && plateauFrames >= PLATEAU_FRAMES) ||
          (pendingFrames > LOADING_MAX_FRAMES);
        if (ready) {
          dispatch({ type: 'revealed', target: pendingIndex });
        } else if (!overlayShown && pendingFrames >= SHOW_DELAY) {
          showLoading();
          overlayShown = true;
        }
      }
    } catch (e) {
      // Defensive: never leave the overlay stuck. Mirrors the old endLoading()
      // error path (mark the in-flight scene ready so we don't re-arm forever).
      if (crossState.mode === 'loading' && crossState.target !== null) { readyScenes[crossState.target] = true; }
      crossState = { mode: 'idle', target: null };
      pendingIndex = null;
      hideLoading();
    }
```

Intent if drifted: the poll's success path must go through `dispatch({type:'revealed', ...})` (so a stale poll for an abandoned target is ignored by the reducer); the catch may reset state directly but must stay consistent (state idle, poll off, backdrop hidden).

- [ ] **Step 9: Edit G — reset handler routes through `dispatch`**

Inside the template string's `start()`, replace (currently `:376-378`):

```
      ev.on('inputEvent', function (name) {
        if (name === 'reset') { switchTo(data.portalStart || 0); lastSafe = null; }
      });
```

with:

```
      ev.on('inputEvent', function (name) {
        if (name === 'reset') {
          // Force the start scene AND clear any pending crossing/overlay: the
          // reducer switches (the start scene is always loaded + ready) and
          // drops a blocked/loading overlay without falsely marking its
          // abandoned target ready.
          var sIdx = data.portalStart || 0;
          dispatch({ type: 'crossing', target: sIdx, loaded: !!entities[sIdx], ready: sceneReady(sIdx) });
          lastSafe = null;
        }
      });
```

Intent if drifted: reset must (a) assert the start scene via the reducer, (b) clear `lastSafe`, (c) never leave a pending overlay/poll behind.

- [ ] **Step 10: Confirm no `endLoading`/direct-`switchTo` stragglers**

```bash
grep -n "endLoading" src/viewer-companion/portals.ts
grep -n "switchTo(" src/viewer-companion/portals.ts
```

Expected: `endLoading` — no hits. `switchTo(` — exactly two hits: the function definition and the single call inside `dispatch`. If plan #3 added other `switchTo(...)` call sites, convert each to a `dispatch({ type: 'crossing', target: X, loaded: !!entities[X], ready: sceneReady(X) })` (every path that changes `activeIndex` must go through the reducer).

- [ ] **Step 11: Run the tests to verify they pass**

```bash
npx vitest run test/portals-injection.test.ts
npx vitest run test/portal-crossing.test.ts
```

Expected: PASS — all injection tests including the new reducer-wiring case; all 13 reducer tests.

- [ ] **Step 12: Lint + release build (stringification/minification safety)**

```bash
npm run lint
npm run build
```

Expected: lint clean; release build completes into `dist/` with no errors.

- [ ] **Step 13: Commit**

```bash
git add src/viewer-companion/portals.ts test/portals-injection.test.ts
git commit -m "fix(portals): pending-crossing retry + mid-load overlay cancel via crossingReducer"
```

---

### Task 3: Key the startup collision snapshot by the start scene index

**Files:**
- Modify: `src/viewer-companion/portals.ts` (`preloadCollisions`, currently `:273-296`)
- Test: `test/portals-injection.test.ts`

**Interfaces:**
- Consumes: the payload field `data.portalStart` (verified baked by `buildPortalsInjection`; adapt the name per Task 0 Step 4 if renamed).
- Produces: nothing new (behavioral fix inside the IIFE).

- [ ] **Step 1: Add a failing injection test**

In `test/portals-injection.test.ts`, append inside `describe('buildPortalsInjection', ...)`:

```ts
    it('keys the startup collision snapshot by the start scene index, not activeIndex', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/lod-meta.json'],
            portalStart: 0,
            portalCollision: ['', 'scenes/1/collision.voxel.json']
        });
        expect(out).toContain('voxels[startIdx] = snapshot(live)');
        expect(out).not.toContain('voxels[activeIndex] = snapshot');
    });
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run test/portals-injection.test.ts
```

Expected: FAIL — `toContain('voxels[startIdx] = snapshot(live)')` fails.

- [ ] **Step 3: Fix `preloadCollisions`**

Inside the `companionRuntime` template string, replace (currently `:280-287`):

```
    // The viewer already loaded the start scene's collision - snapshot it so we
    // can restore it when walking back to the start scene.
    voxels[activeIndex] = snapshot(live);
    for (var i = 0; i < data.portalCollision.length; i++) {
      (function (idx) {
        if (idx === activeIndex || voxels[idx]) return;
        var url = data.portalCollision[idx];
```

with:

```
    // The viewer already loaded the START scene's collision - snapshot it keyed
    // by the start index (never activeIndex: the user may have crossed into
    // another scene before this ran; keying by activeIndex would both give that
    // scene the wrong voxels and skip fetching its real URL) so we can restore
    // it when walking back to the start scene.
    var startIdx = data.portalStart || 0;
    voxels[startIdx] = snapshot(live);
    for (var i = 0; i < data.portalCollision.length; i++) {
      (function (idx) {
        if (voxels[idx]) return;
        var url = data.portalCollision[idx];
```

Intent if drifted (plan #3 may have restructured collision fetching into frontier management): wherever the live viewer-loaded collision is snapshotted, key it by the start scene index (`data.portalStart || 0`), and never skip fetching a non-start scene's voxel URL merely because that scene is currently active. The existing late-apply (`if (idx === activeIndex) swapCollision(idx);` after a fetch resolves, currently `:292`) must stay: it is what corrects collision for a scene the user crossed into while its voxels were still downloading.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run test/portals-injection.test.ts
```

Expected: PASS — all injection tests including the new snapshot-key case.

- [ ] **Step 5: Lint + release build**

```bash
npm run lint
npm run build
```

Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/viewer-companion/portals.ts test/portals-injection.test.ts
git commit -m "fix(portals): key startup collision snapshot by start scene index"
```

---

### Task 4: Manual E2E verification (RELEASE build, throttled network)

**Files:** none modified. This is the mandatory release-build E2E for viewer-companion changes (minification bugs only appear in release; the wiring in Tasks 2–3 is engine-coupled and cannot be unit-tested).

- [ ] **Step 1: Produce a release build and start the editor**

```bash
npm run build
npx http-server dist -p 3333 -c-1
```

Open http://localhost:3333.

- [ ] **Step 2: Create and export a streaming multi-scene portal experience**

Using the release editor, create (or reuse an existing project for) a portal setup with at least 2 scenes joined by a portal doorway, with collision enabled, and export it as a **streaming** viewer (ZIP export, or the S3-publish custom viewer — same paths used for every prior portal E2E). Extract/serve the exported viewer:

```bash
npx http-server <exported-folder> -p 8080 -c-1
```

If any of this authoring flow is unclear, ask the user (Dimitri) to drive it — he has E2E'd this flow repeatedly; the scenarios below are what must be observed.

- [ ] **Step 3: Scenario 1 — dropped-crossing retry (finding 1)**

1. Open http://localhost:8080 with DevTools → Network. Set throttling to **Slow 3G**. Leave "Disable cache" OFF (scene warming relies on the HTTP cache). Hard-reload (Ctrl+Shift+R) to start cold.
2. As soon as the start scene reveals and movement is possible, **sprint straight through the doorway** into scene B — before B has loaded.
3. Expected: the loading overlay (dark backdrop + spinner + label) appears **immediately at the doorway**; when scene B's data arrives, the viewer **swaps to scene B automatically** (overlay hides) with the camera still where you walked to — you never have to walk back and re-cross. Collision matches scene B once its voxels arrive.
4. Regression this replaces: previously the viewer stayed on scene A **permanently** while you stood in B's space, with no overlay.

- [ ] **Step 4: Scenario 2 — A→B→A fast double-cross (finding 2)**

1. Still throttled: cross A→B so the overlay comes up, then **immediately walk back through the doorway into A** before the overlay reveals.
2. Expected: the overlay hides at once and scene A renders normally.
3. Wait a few seconds (long enough that the old stale poll would have fired), then cross into B again.
4. Expected: the overlay **shows again** and hides only when B is visibly present. Regression this replaces: the second crossing showed no overlay over a cold black/hazy scene B (B had been falsely marked ready by the stale poll).

- [ ] **Step 5: Scenario 3 — camera reset mid-load**

1. Still throttled: cross A→B so the overlay is up (or hold a blocked crossing), then press **R** (or use the reset menu).
2. Expected: the camera returns to its spawn pose, the **start scene** renders, and the overlay is hidden. No overlay reappears spuriously afterwards; a later deliberate crossing into B behaves per Scenario 2.

- [ ] **Step 6: Scenario 4 — no regressions at normal speed**

1. Set throttling back to "No throttling"; hard-reload.
2. Expected: crossings into pinned/adjacent scenes remain instant (no overlay flash); the anim-mode timeline (if an animation track exists in the export) still swaps scenes at the baked times; collision + the collision overlay toggle still track the active scene; a SOG (non-streaming) export still crosses with no overlay once its scenes load.
3. Console: no errors; a `portal tick error` warning must NOT appear.

- [ ] **Step 7: Record the outcome**

Note pass/issues for each scenario. Any failure: stop and debug with superpowers:systematic-debugging before proceeding — do not paper over.

---

### Task 5: Final verification + finish the branch

- [ ] **Step 1: Full test suite**

```bash
npm run test
```

Expected: PASS — all suites, including `test/portal-crossing.test.ts` (13 tests) and the extended `test/portals-injection.test.ts`.

- [ ] **Step 2: Lint**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 3: Release build sanity**

```bash
npm run build
```

Expected: clean build to `dist/`.

- [ ] **Step 4: Squash and finish per project convention**

Squash all commits on `feature/portal-crossing-robustness` into a single commit summarizing the change (pending-crossing retry via frozen lastSafe + crossingReducer, mid-load overlay cancellation without false-ready, start-index-keyed collision snapshot, plus tests and this plan doc), then finish the branch via the `superpowers:finishing-a-development-branch` skill (merge to local `main`, delete the branch; do not push unless asked).

---

## Self-Review

**1. Spec coverage:**
- Finding 1 (dropped crossing, never retried) → Task 1 (reducer `blocked` mode + idempotent re-fire, named test `drop-crossing-retry`) + Task 2 Edits C/E (no `entities[next]` gate; frozen `lastSafe`; overlay shown immediately; switch completes the frame the entity appears — covering both the SOG asset-load path and any plan-#3 streaming/pin-resident path, since readiness is re-read live per frame). ✓
- Finding 2 (stale poll falsely marks abandoned scene ready) → Task 1 (named test `A→B→A stale poll`, plus stale-`revealed` guard tests) + Task 2 Edits D/F ('hide' clears the poll without markReady; reveal routed through `dispatch`). Reclaim interplay (`readyScenes[idx]=false` at `:673`) stays correct because a cancelled poll no longer exists to re-set it. ✓
- Finding 3 (snapshot keyed by activeIndex) → Task 3 (keyed by `data.portalStart || 0`; skip only on `voxels[idx]`; intent stated for plan-#3 drift). Payload field name verified (`portalStart`). ✓
- One pure state machine for findings 1+2, `src/portal-preload.ts` pattern, full TDD list with the two named scenarios → Task 1. ✓
- `lastSafe` semantics decided + per-frame re-fire analysis + simplest-design justification → Context. ✓
- Manual E2E (release, Slow 3G, sprint-through, A→B→A, reset mid-load) → Task 4. ✓
- Task 0 preflight reconciliation vs plan #3 → Task 0 (+ intent lines on every edit). ✓

**2. Placeholder scan:** no TBD/TODO/"similar to"; every code step shows complete code; every command has an expected outcome.

**3. Type consistency:** `crossingReducer(state, event)` → `{ state: { mode, target }, actions: { switchTo, overlay, markReady } }` is identical across Task 1 (definition + tests) and Task 2 (`dispatch` wiring); event shapes `crossing/noCrossing/revealed` match everywhere; `sceneReady(idx)`/`dispatch(ev)`/`crossState` names consistent across Task 2 edits.

**4. Stringification audit:** `crossingReducer` is pure and self-contained (no imports, no sibling calls, no module-level constants — all mode/directive strings are inline literals; types erase at compile). The IIFE references it only via the injected `var crossingReducer = ${crossingReducer.toString()}` binding. `sceneReady`/`dispatch` live inside the IIFE template itself, so they may reference IIFE-locals freely. Release build + E2E gate remains Task 2 Step 12 / Task 4.
