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

Status (2026-07-06): IMPLEMENTED — spec `docs/superpowers/specs/2026-07-06-active-scene-first-pins-design.md`,
plan `docs/superpowers/plans/2026-07-06-active-scene-first-pins.md`. Combined policy: strict hold while the
start scene's bar is up (residency-probed startRevealed latch), then coarser-than-active-pin-depth neighbour
levels flow while equal-or-finer wait for the active scene (pinBatchAllowed gate in pumpPins); distance-2
warming waits for the same gate.

Slow-network `deviceFinest` fix (2026-07-06, E2E-verified during the above): the feature was ineffective on a
throttled network because `deviceFinest` (which drives every scene's pin depth) froze at coarsest. Two coupled
causes, both fixed: (a) `shouldSampleDeviceFinest` permanently stopped after ~10s of stability even while the
start scene's render floor was still finer than the observed finest, so late-arriving finer residency went
unobserved — now it keeps sampling (throttled, up to a 3600-frame no-improvement backstop) while
`floorBelowFinest`, and stops early only when the floor is clamped up (low-end/churn, preserving plan #6
steady-state-zero); (b) on Slow-3G the viewer opens scene 0's LOD floor to 0 only minutes in (firstFrame never
fires), long after sampling stopped — `sampleDeviceFinest` now re-arms (`dfStable = 0`) on the
`floorBelowFinest` false→true edge and re-pins (`pinDesired`) on each finer ratchet so neighbours upgrade
without a crossing. Diagnosed via a temporary `df-probe` log (removed). Note: when the device is capable
(`deviceFinest` reaches 0) a neighbour's whole coarser-than-finest pyramid is its instant-crossing floor and
flows alongside the active scene by design — only the neighbour's finest (= active pin depth) is held.

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

CLOSED — NO ACTION (2026-07-07, measured on desktop Fast-4G, 2 scenes, cross A→B before A's LODs
finish). Diagnosis fully root-caused; branch `feat/avoid-lod-duplicate-downloads` deleted (it was
empty). Findings:
- The duplicates are the ENGINE's own unified-GSplat LOD (initiator stack = `loadTextures` /
  `_processQueue` / `_onAssetLoadSuccess` / `_loadImageBitmap`), NOT the portal pin machinery. The
  `[portals]` diag proved scene 0's pin depth never changes across the crossing (`depths={"0":2,...}`
  before AND after) — no unpin/re-pin coarsen. The duplicated blocks are levels 0/1, which are
  BELOW the pin floor, i.e. engine-owned render LOD, not our pins.
- Mechanism: the engine render budget (`app.scene.gsplat.splatBudget`) is smaller than scene 0's
  finest working set, so during the initial-load window the engine LOD load→evict→reloads blocks
  as the camera moves. Self-terminating once pinning holds the finest level resident; after full
  load, crossings are instant (all levels `n/n`, `ready=true`).
- The alarming "start scene stays low quality forever" symptom was a CACHE-OFF artifact only. With
  DevTools "Disable cache" UNCHECKED (and a caching server), `deviceFinest` ratchets 1→0, scene 0
  reaches full quality, and the duplicates return as cheap 304/disk hits. Do NOT measure the
  EXPORTED viewer with cache off — it turns every benign reload into a full ~9s Fast-4G refetch and
  prevents residency from ever converging.
- `firstFrame never fires` under throttling is a SEPARATE, already-understood issue (engine bug
  #8998, patched at export time by `src/viewer-engine-patch.ts`; runtime watchdog is the backstop).
  Investigating it gives NO benefit for duplicates/quality because the watchdog's fallback
  splatBudget (desktop 4M / mobile 2M) already EQUALS the viewer's default budget — firstFrame
  firing would not raise it. Confirmed: viewer applies `?budget=<n>` as `splatBudget = budget()*1e6`
  only inside `applyPerfSettings` (ready/firstFrame-gated).

SPIN-OFF (IMPLEMENTED on branch `fix/watchdog-honor-budget-param`, 2026-07-07): the watchdog
fallback at `portals.ts:874` hardcoded the default budget and thus IGNORED an explicit `?budget=<n>`
when firstFrame never fires — exactly the slow-network case where a user might raise it. Fix: new
pure `parseBudgetParam(search)` in `portal-preload.ts` (Number*1e6, viewer-matched semantics,
string-only/no-regex, unit-tested), stringified into the companion, read once into `budgetOverride`,
and used ahead of the hardcoded 2M/4M default in the watchdog (`budgetOverride || (IS_MOBILE?2:4)*1e6`;
log tags `(from ?budget)`). No-param default unchanged (mobile-OOM guard preserved). Spec:
`docs/superpowers/specs/2026-07-07-watchdog-honor-budget-param-design.md`. Narrow trigger (`?budget=`
AND firstFrame-never-fires) and transient if firstFrame later fires, but correct. Remaining: manual
release-build E2E of the stuck-firstFrame slow-network path (watchdog log shows the override value).

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

CLOSED — NO ACTION (2026-07-07). Already handled; the user's actual need (release the mouse while the
overlay is up, e.g. to click into another app on a second screen) works in both walk and fly. Two
things cover it, both already in place:
- The backdrop is `pointer-events: none` (`portals.ts` `.ss-portal-loading-backdrop`, added with the
  loading overlay / crossing-robustness work), so the dark backdrop never intercepts the cursor —
  pointer events pass through to the canvas. The "backdrop covers the canvas / mouse control lost"
  symptom above was stale (pre-dated that CSS).
- Mouse release itself is the BROWSER's native pointer-lock exit: walk/fly engage pointer lock, and
  Escape makes the browser release it and show the cursor, independent of our overlay. The stock
  viewer's own `window` keydown also maps Escape→`inputEvent 'exitWalk'` (walk→pre-walk mode); the
  first Escape under pointer lock is swallowed (`recentlyExitedCapture`) and just frees the cursor,
  which is exactly the desired behavior here.
- Only genuine gap found, deliberately NOT fixed (irrelevant to the goal, and stock viewer omits it
  by design): in FLY mode Escape frees the cursor but does not switch `cameraMode` back to orbit
  (stock only does that for walk; you leave fly with the `1` key).

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

RESOLVED (2026-07-07, branch `fix/active-scene-coarsen-partial-unpin`). Confirmed REAL but narrow
(mobile-only, tight budget) and self-healing. Root cause is more specific than the note above: the
transient blob does NOT come from floor timing — it comes from `unpinScene` FREEING blocks. On an
active-scene coarsen, the full `unpinScene(idx)` does `decRefCount(_, 0)` on every pinned block; the
coarse `[min..coarsest]` blocks that cover NEAR regions are held only by our pin (the render
instance holds refs only to the finer level it is drawing there, per the `unpinScene` comment), so
they free immediately, and the raised floor (min) then selects them — missing — as a coarse blob
until the async re-pin refetches them. The memo's suggested fix (scheduleRefine-style hold) does NOT
address this: `pumpFloor` only descends (opens straight to min on a coarsen) and never stops the
free.

Fix: a new `unpinSceneFinerThan(idx, min)` sheds ONLY the levels finer than the new floor
(`lodLevel < min`) and keeps the coarse pins ref-held throughout; `pinDesired` routes the
`idx === active` coarsen through it (hidden scenes still take the full `unpinScene` + re-pin — nothing
on screen to blob). Same memory saving (the finer levels are exactly what the coarsen drops), coarse
blocks never lose a ref → no blob. Because coherence is preserved, `readyScenes`/`shown` are left
untouched (a crossing back needs no overlay) — so the memo's "clearing shown[active] is deliberate"
concern evaporates rather than needing a comment. The single-pass-finestFullLevel micro-opt was NOT
done (out of scope for the blob fix; unchanged hot path).
Verified: lint clean, release build bakes the helper in, full suite 340/340. Runtime blob-elimination
under the edge condition is release-build-E2E-pending (the trigger needs a specific mobile
budget/scene combo; not cheaply reproducible).

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

RESOLVED (2026-07-07, branch `hotfix/wrong-reset-in-exported-viewer`, user-verified E2E). The
POSE behavior is by design and was KEPT: the stock viewer's reset branches on cameraMode — orbit/anim
do `controllers.orbit.goto(resetCamera)` (initial camera, start scene), while walk/fly do
`controllers.{walk,fly}.resetToSpawn()`, whose spawn is the pose captured when that mode was ENTERED
(i.e. the walkthrough pose where autoplay was exited by starting to walk). The ONLY bug was the
SCENE: the companion forced `portalStart` on every reset, so a walk/fly reset restored a pose that
may live in a non-start scene while showing scene 0.

Fix (companion only, `src/viewer-companion/portals.ts`): record `spawnScene = activeIndex` on each
walk/fly `cameraMode:changed` entry (that IS the scene the spawn pose belongs to, since both are
captured at the same instant), and on reset dispatch to `spawnScene` when cameraMode is walk/fly,
else `portalStart`. NOTE: the animation cursor time (`sceneAtTime(animationTime)`) was tried first
and is NOT usable — animationTime freezes when anim mode is left, so after an intervening orbit reset
(R during the walkthrough, then switch to walk) it points at a scene the spawn pose no longer lives
in (the exact 4-scene repro that killed the timeline approach). Gotcha: the companion body is a
TEMPLATE LITERAL (`${...}` interpolation) — no backticks allowed even inside `//` comments. R during
the walkthrough (cameraMode anim/orbit) is unchanged: still returns to the start scene's initial pose.

This closes the last open item in this memo (all five #1–#5 now resolved or NO-ACTION).
