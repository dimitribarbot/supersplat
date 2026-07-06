# Portal viewer streaming follow-ups (from crossing-robustness E2E, 2026-07-06)

Findings from the plan-#5 (crossing robustness) Slow-3G E2E session that are OUT of that branch's
scope. Each is a candidate for its own small branch. Context: exported streaming viewer runtime =
`src/viewer-companion/portals.ts` (IIFE template string + stringified pure helpers; any change
needs a RELEASE-build E2E).

## 1. Active-scene-first pin priority

Observed: scene B (neighbour) block files download interleaved with — and sometimes before — the
active scene A's fine levels at startup. This is the deliberate plan-#3 design (`pinDesired` pins
LEVEL-MAJOR across scenes: every resident scene's coarse levels before any scene's fine levels, and
desktop preloads neighbours' full pyramids for instant crossings), but on slow networks it delays
the scene the user is actually looking at.

Idea: keep level-major ordering for the coarse levels (cheap, whole-scene coverage for everyone),
but once levels coarser than the ACTIVE scene's pin depth are resident, finish the active scene's
remaining levels before feeding any neighbour's finer levels. `pumpPins` already yields to
`pendingIndex`/active during a crossing; this extends the same priority to steady-state pinning.
Watch out: don't starve neighbour coarse pins (they're the instant-crossing floor), and re-evaluate
on every `reconcileFrontier` (active scene changes).

## 2. Re-download churn: measure with real cache headers first

Observed: ~350 MB transferred for a 245 MB project during one session, with visible duplicate
requests. The test server was `http-server -c-1`, which sends no-cache headers — but the residency
design explicitly RELIES on the browser HTTP cache (unpin→re-pin reloads, warming, engine cooldown
eviction refetches are all documented as "cheap: HTTP cache"). With `-c-1` every one of those is a
full network refetch, so most of the overhead is a test-harness artifact.

Protocol for a real measurement: serve with caching enabled (`npx http-server <folder> -p 8080` —
default max-age 3600), hard-reload once to start cold, replay the same walk, compare transferred
bytes vs. resource bytes in DevTools. If genuine churn remains (unpin on role-change coarsening,
engine cooldown eviction of the ACTIVE scene under budget), profile which path refetches and
consider widening the pin retention or engine cooldown before touching the network layer.
E2E instructions for future viewer branches should stop recommending `-c-1` for the EXPORTED
viewer (it's fine for the editor build, which has the service worker).

Addendum (2026-07-06, round-7 root cause): the dominant duplicate-download source was scene 0
being freed on every crossing away — firstFrame never fires when the viewer's ready gate sticks
under throttling, viewerReady stayed false, and pinDesired skipped scene 0's pins indefinitely.
Fixed on the crossing-robustness branch (watchdog now latches viewerReady once a budget is in
place). Residual churn to measure after that fix: engine cooldown eviction + unpin/re-pin role
changes only.

## 3. Escape key while the loading overlay is up

Observed: while the crossing overlay backdrop is displayed, mouse control is lost (the backdrop
covers the canvas) and there is no way to leave walk/fly mode. Requested: Escape exits walk/fly
mode (and/or restores control) while the overlay is shown.

Notes for implementation: the overlay is `ss-portal-loading-backdrop` (mounted on document.body by
the companion runtime). Options: (a) keydown listener in the companion that fires the viewer's
mode-switch event (find the inputController / cameraMode event the viewer exposes on
`viewer.global.events`); (b) `pointer-events: none` on the backdrop so the canvas keeps receiving
input (cheapest, but the user is interacting blind under a dark backdrop); (c) both. Decide with
the user which interaction model they want before building.

## 4. Active-scene budget-coarsening can transiently violate the floor invariant

When assignPinDepths degrades the ACTIVE scene as a last resort (hard budget cap /
performance-mode drop), pinDesired's coarsen path unpins the active scene and sets its floor to
the new coarser canonical level, which may not be fully resident until the re-pin completes —
a transient blob/hole window for the on-screen scene (pre-existing plan-#3 behavior, edge-only).
Route the `idx === activeIndex` coarsen through the scheduleRefine-style hold (recompute
finestFullLevel, hold, pumpFloor). Also worth a comment there: that path clears shown[active]
while the scene is on screen, which is deliberate (residency just degraded; the next crossing
should re-probe). While there, consider a single-pass finestFullLevel (per-level counts like
residencySummary) — the current form is O(files x levels) per rAF during a descent.

## 5. R-reset after exiting walkthrough autoplay returns to the walkthrough pose (from plan-#6 E2E)

Observed (2026-07-06, plan-#6 frame-cost E2E; reproduced on a PRE-branch export, so pre-existing
on main — NOT a perf-branch regression): the viewer starts with the walkthrough (animation) in
autoplay; starting to walk exits the walkthrough into free navigation. Pressing R then returns the
camera to where the user was IN the walkthrough (sometimes a different orbit position), not to the
scene's initial position. Pressing R while the walkthrough is still running works as expected
(back to the scene initial position).

Not yet root-caused. The companion's own reset handling is scene-selection only (the
`inputEvent`/`reset` listener switches back to the start scene and clears `lastSafe`); the camera
POSE on reset is owned by the stock supersplat-viewer, so the suspect is the viewer's reset
semantics interacting with cameraMode: reset in anim mode restarts the path (correct), while reset
in free-nav after an anim→fnav hand-off appears to restore an anim-derived pose (the cursor's
last pose, or an orbit pose captured at the hand-off) instead of the initial camera. Investigate
in the viewer state handling (`getState().cameraMode`, animationTime, and whatever pose the reset
event restores), not in the companion. The "sometimes another orbit position" variant suggests the
restored pose depends on which controller (anim/orbit/fly) was active when the pose snapshot was
taken. Decide desired behavior with the user first: R always returns to the scene's initial spawn
pose, regardless of how the walkthrough was exited, is the stated expectation.
