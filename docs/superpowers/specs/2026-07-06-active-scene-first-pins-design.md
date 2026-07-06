# Active-scene-first pin priority — design spec (2026-07-06)

Implements follow-up item #1 of `docs/superpowers/2026-07-06-portal-viewer-streaming-followups.md`.
Approved by Dimitri 2026-07-06. **Hand-off note:** this spec is written to be implemented in a
separate session (different model). It is self-contained; read it together with the follow-ups memo
and the code pointers below before writing the plan.

## Problem

In the exported streaming portal viewer, neighbour scenes' block files download interleaved with —
and sometimes before — the active scene's fine LOD levels at startup. This is the deliberate
level-major pin design (`pinDesired` pins every resident scene's coarse levels before any scene's
fine levels, and desktop preloads neighbours' full pyramids), but on slow networks it delays the
scene the user is actually looking at.

## Decision: where this lives

**Entirely in our viewer-companion runtime** (`src/viewer-companion/portals.ts` + pure helpers in
`src/portal-preload.ts`). Not upstream:

- The stock playcanvas supersplat-viewer has no concept of multiple scenes; there is nothing to
  hook a scene-priority policy into.
- The engine's per-scene block loader is a 2-concurrent FIFO with no prioritisation; changing it
  would be an engine fork far heavier than needed.
- The interleaving is produced by our own code: `pinDesired` queues batches level-major across
  scenes, then every scene's `pumpPins` runs concurrently (`PIN_WAVE = 4` in flight per scene).
- The precedent exists: `pumpPins` already yields non-destination pumps while a crossing is
  loading (the `pendingIndex` check). This design extends that same yield pattern.

## Agreed policy

Levels are numbered 0 = finest, N-1 = coarsest. "Pin depth" = a scene's target min level from
`assignPinDepths` (`pinDepth[idx]` once applied).

1. **Startup window** (initial scene behind the viewer's progress bar — the user cannot move):
   non-active pin pumps hold **entirely**, and distance-2 cache warming holds. Costs nothing in
   crossing risk; this is exactly the window where neighbour traffic hurts most on slow networks.
2. **After the active scene is revealed:** neighbour batches **strictly coarser** than the active
   scene's pin depth flow level-major as today (they are the tiny instant-crossing floor). Batches
   at a level `<= pinDepth[active]` (equal or finer) hold until the active scene is **fully
   resident at its pin depth**.
3. **After the active scene is at depth:** behaviour is exactly today's (all pumps flow), and
   distance-2 warming fires.
4. All state is read live each pump tick, so a crossing or budget reconcile re-prioritises
   automatically. The existing `pendingIndex` crossing yield is unchanged and continues to outrank
   everything (during a crossing overlay the user CAN move — blind under the backdrop — but the
   destination scene still gets all bandwidth, which is the pre-existing behaviour).

## The two gates

### Gate 1 — "active scene revealed"

- **Crossed-into scenes:** `shown[active]` (already maintained by the crossing reducer). While it
  is false a crossing overlay is up, and the existing `pendingIndex` yield already produces the
  same hold — gate 1 adds no new restriction there; it must simply be consistent with it.
- **Start scene at startup — the only place gate 1 adds behaviour.** `shown[0]` and
  `readyScenes[0]` are pre-latched `true` at init (`portals.ts` ~lines 266-269, "never overlay the
  start scene"), and the viewer's own progress bar is not observable by the companion
  (`viewerReady` deliberately latches early under throttling — plan-#5 watchdog). So add a
  one-shot latch `startRevealed`:
  - Set by probing residency at `revealLevel(0)` using the existing `sceneResidentToDepth` helper
    (the same condition that drops a crossing overlay) — this approximates the moment the viewer's
    bar drops and the user can move.
  - Probe only while unlatched, throttled to ~every 15 frames (the probe is O(files); plan #6's
    steady-state-zero property must be preserved — this cost is startup-transient only).
  - Anti-stick frame cap ~3600 frames (~60s, mirroring `LOADING_MAX_FRAMES`): the latch sets even
    if the probe never passes. Neighbours must never be held forever.

### Gate 2 — "active scene resident at its pin depth"

- Do **not** use `readyScenes[active]` (pre-latched for scene 0). Instead track "all of
  `pinBatches[active]` are done", maintained event-style by the active scene's own pump (it
  already detects batch completion) and re-derived on reconcile/active change.
- Scene 0's pin batches poll `getFileResource`, so files fetched by the engine's own streaming
  count toward completion — no double download.
- If the active scene's pins are not queued yet (e.g. the 30s `viewerReady` fallback fired but
  scene 0 still waits for `firstFrame`, so `pinDesired` skipped it), gate 2 stays closed; the same
  anti-stick cap bounds this.
- SOG active scene (no octree, no batches): both gates count as open once its asset is loaded.
- Budget coarsening that unpins + re-queues the active scene's batches closes gate 2 again
  (correct: the active scene refills first).

## Mechanics

- `pinSceneToLevel` records `level` on each batch object it pushes to `pinBatches[idx]` (it is
  already called one-level-per-batch from `pinDesired`'s level-major loop, so
  `level = minLevel = maxLevel`).
- `pumpPins`, for `idx !== activeIndex`, adds yield checks beside the existing `pendingIndex`
  yield (~line 1238):
  - gate 1 closed → yield the whole pump (rAF spin, same as the crossing yield);
  - gate 1 open, gate 2 closed → process batches in order but stop (spin) at the first batch with
    `level <= pinDepth[active]`; strictly-coarser batches proceed.
  - Held pumps spin transiently and stop once loading completes — steady-state per-frame cost
    stays zero.
- The allow/hold decision is a **pure helper** in `src/portal-preload.ts`:
  `pinBatchAllowed(batchLevel, sceneIdx, activeIdx, activePinDepth, revealed, activeAtDepth)` →
  boolean. Imported by the editor code and **stringified into the companion template** exactly
  like `assignPinDepths` (`portals.ts` ~line 76). Unit-testable in Vitest.
- `warmFrontier` moves behind gate 2: fire when the active scene reaches depth, and still from
  `pinDesired` when gate 2 is already open at reconcile time. `warmedScenes` once-per-session
  dedup unchanged.
- Boundary choice (deliberate): a neighbour batch at a level **equal** to `pinDepth[active]` is
  held while gate 2 is closed. On desktop all pin depths are often 0; allowing equality would let
  neighbour L0 compete with active L0, defeating the feature.
- Null threshold: while `pinDepth[active]` is `null` (active scene not yet reconciled — e.g. the
  30s fallback queued neighbour pins but scene 0 still waits for `firstFrame`), use `deviceFinest`
  as the threshold (that is what `pinDesired` will assign the active scene); if that is also
  `null`, hold everything except each neighbour's coarsest level. Gate 2 is closed in this state
  regardless, and the anti-stick cap bounds it.

## Edge cases

- **Crossing mid-hold:** `activeIndex` / `pinDepth[active]` are read live each tick; the
  `pendingIndex` yield outranks everything during the crossing itself. If the user crosses another
  portal while an overlay is up, the crossing reducer retargets `pendingIndex` and the yield
  follows — existing behaviour, untouched.
- **Device loss:** pumps already exit on `deviceDead`; gates re-derive on the post-restore
  reconcile.
- **Neighbour coarse starvation:** impossible after reveal by construction (coarse flows); before
  reveal the user cannot move, and the anti-stick cap bounds pathological cases.
- **`reconcileFrontier` re-runs** (every crossing): `pinDesired` is idempotent-ish and unchanged
  in structure; only the pump-side gating and the warming call site change.

## Constraints for the implementing session (read before coding)

- Companion code is an IIFE **template string** with stringified pure helpers: no backslash
  escapes in the stringified/template code (build cooks `\d` → `d` — see memory
  `companion-template-no-backslash-escapes`), keep ES5-ish style (`var`, no arrow functions) to
  match the surrounding runtime.
- Any companion change needs a **RELEASE-build E2E** (stringified-helper minification gotcha).
- Run Vitest gates foreground with output redirected to a file (memory
  `vitest-background-pipe-hang`).
- Don't reorder imports (ESLint 10 `import/order` note in CLAUDE.md).
- Subagent/worktree gotchas: `worktree-session-gotchas` memory (shells start in the main
  checkout).

## Testing

- **Unit (Vitest, `test/`):** truth table for `pinBatchAllowed` — active scene always allowed;
  startup hold-all while `revealed` false; post-reveal coarser-than-depth allowed / equal-or-finer
  held; gate-2-open passthrough. Plus any small pure extraction made for the gate latches.
- **E2E (release build, exported streaming multi-scene project):**
  - Serve with a **caching** server (`npx http-server <folder> -p 8080`; **no `-c-1`** — memo
    item 2), DevTools Slow-3G, cold start.
  - Waterfall assertions: no neighbour-scene block requests before scene 0's reveal; after reveal
    only neighbour levels strictly coarser than scene 0's pin depth until scene 0 completes its
    pin depth; distance-2 warming requests come last.
  - Normal-speed pass: crossings are still instant once idle (preload floor intact), crossing
    overlay behaviour unchanged.

## Out of scope

Follow-ups memo items 2-5 (cache-churn measurement, Escape-during-overlay, active-scene coarsen
floor transient, R-reset-after-walkthrough pose). No network-layer changes, no engine changes, no
supersplat-viewer changes.
