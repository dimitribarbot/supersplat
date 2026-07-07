# Off-limits wall clamp corrupted the walk/fly reset spawn

**Status:** DONE, user-verified E2E (multi-scene + single-scene).

## Symptom

In an exported viewer, after being blocked by an off-limits zone in walk/fly mode,
pressing **R** (reset) returned the camera to the off-limits wall instead of the
walk-entry pose. In a portal (multi-scene) export it also landed in the *wrong*
scene (the walkthrough's scene, not the wall's), and my first fix attempt added a
visible offset (sometimes clipping inside a wall) and a lag on R.

## Root cause

The off-limits companion (`src/viewer-companion/off-limits-zones.ts`) clamps the
walk camera each blocked frame by setting a safe pose and re-seating the active
controller. It used `cameraManager.snap()`. In the bundled viewer, `snap()` calls
the active controller's `onEnter()`, and the walk/fly `onEnter()` re-captures the
**reset spawn** (`_storeSpawn`) at the current position. So being blocked
overwrote the reset spawn to the wall-clamp position; `resetToSpawn` (R) then
returned there.

The scene stayed on the walkthrough scene because the portals companion tracks
the walk-entry scene via `cameraMode:changed`, which `snap()`'s internal
`onEnter` does not fire — hence the position/scene mismatch.

## Why the fix lives in an engine patch

The clean fix is "re-seat the controller position without re-storing the spawn",
but the walk controller and its `_spawn` are closure-private in the bundled
viewer — unreachable from an injected companion. `snap()` is the only reposition
primitive exposed on `cameraManager`, and it always re-grounds + re-stores the
spawn.

An earlier companion-only attempt (record the entry pose, override the camera on
`reset`) regressed: `snap()`-based restore re-grounds against whatever scene's
collision is active at reset time (you'd just walked to another scene → offset /
wall-clip), and the override visibly fought the viewer's own reset transition
(the lag). Reverted.

## The fix

Add a spawn-preserving reposition to the viewer at **export time**, using the
existing `patchViewerEngine` mechanism (`src/viewer-engine-patch.ts`):

- New patch inserts a `reseat()` method next to `snap()`. It is identical to
  `snap()` except it calls the controller's `goto()` (re-seats position/angles
  only — no grounding, no `_storeSpawn`) instead of `onEnter()`. Falls back to
  `onEnter()` for any controller without `goto()`, matching `snap()`'s prior
  behaviour in those modes.
- The off-limits companion prefers `cm.reseat()` and falls back to `cm.snap()`
  when the patch did not apply (older/newer bundle) — so an un-patched bundle
  degrades to the old (buggy but functional) behaviour rather than crashing.

The reset spawn is now never corrupted, so the viewer's **native**
`resetToSpawn` runs untouched: correct scene, correct pose, its own smooth
transition — no override, no offset, no lag. Fixes single-scene off-limits
exports too.

## Notes / gotchas

- The `snap` block in the viewer bundle is 4-space indented (viewer app code),
  unlike the tab-indented engine classes the other patches target. Both live in
  the same exported `index.js`, which `patchViewerEngine` processes.
- Export-time string patches silently no-op on a miss. The patch search string
  was verified to occur **exactly once** in the real splat-transform 2.7.1
  bundle; a miss makes the export warn and the companion fall back to `snap()`.
- `VIEWER_ENGINE_PATCH_COUNT` is now 10 (was 9). Both the browser export path and
  the server path (via `dist-shared`) apply the patch.

## Tests

- `test/viewer-engine-patch.test.ts` — `reseat()` inserted + idempotent; count 10.
- `test/off-limits-zones-injection.test.ts` — companion prefers `cm.reseat()`.
