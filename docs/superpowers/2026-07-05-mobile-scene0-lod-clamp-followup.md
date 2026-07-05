# Follow-up: clamp scene 0's LOD floor to its pin depth on budget-degraded devices

Status: PROPOSED (not started). Origin: streaming-blob fix E2E, 2026-07-05.
Prerequisite reading: `docs/superpowers/2026-07-04-streaming-blob-session-memo.md`
(the whole mobile diagnosis lives there).

## Problem

In the exported portal viewer, scene 0 (the start scene) is the only scene
whose gsplat component LOD floor is viewer-owned: the stock viewer's
`applyPerfSettings` opens it to `lodRangeMin = 0` once ready, and the
companion deliberately never touches it (`pinDesired` skips the
`sceneMinLevel`/`lodRangeMin` write for idx 0 — see the `idx !== 0` guard).

On a budget-degraded device (mobile ceiling), the pin machinery keeps scene
0 resident at a coarser assigned depth (field: Redmi Note 9S, `depths=
{"0":3,...}`), but the engine's per-view refine still *requests* finest
(level-0) blocks for near nodes because the floor says 0. On the Redmi
those are the biggest webps in the export and their loads repeatedly die
client-side under memory pressure (`XHR Error 0` / `net::ERR_FAILED` with
`200 (OK)` — NOT CORS; page and assets are same-origin on the CDN). The
#8998 `_failed` bookkeeping eventually parks them, but each cycle wastes
mobile bandwidth/battery, and the splats those files carry can never be
shown on that device anyway.

## Proposal

When the assigned pin depth for scene 0 is coarser than `deviceFinest`
(i.e. the budget degraded it — the signal that the device cannot hold
finer), clamp `comps[0].lodRangeMin` to `pinDepth[0]`, exactly as the
companion already does for extra scenes. Desktop (pin depth ==
deviceFinest, typically 0) must be a strict no-op so stock start-scene
behavior is preserved where it works.

Sketch (all in `src/viewer-companion/portals.ts` `pinDesired`): drop the
`idx !== 0` guard *conditionally* — apply the floor to scene 0 only when
`min > (deviceFinest ?? 0)`. Leave `sceneMinLevel[0]` unset or set it —
either way re-audit `sceneRevealResident`'s depth resolution
(`pinDepth → sceneMinLevel → deviceMinLevel`, added in `9aad52d`) so the
reveal gate stays consistent.

## Why it was NOT done in the streaming-blob branch

It changes stock viewer behavior for the start scene (today the engine may
show finer-than-pin detail for near nodes on devices that CAN decode it —
e.g. mid-range phones between "desktop" and "Redmi"). That trade
(uniform-but-capped quality + zero failed-load churn vs. occasional finer
near-detail) is a product decision, not a bug fix; Dimitri asked for it to
be memo'd rather than slipped in.

## Watch out for

- `applyPerfSettings` re-runs on `performanceMode:changed` and overwrites
  `lodRangeMin` on the START component — the clamp must survive that
  (re-apply after, or hook the same event).
- Don't clamp before `deviceFinest` has settled (`pinReady`), or the clamp
  freezes on the coarse fallback.
- The reveal gate (`sceneRevealResident`) and `updateDeviceFinest` (which
  OBSERVES scene 0's resident levels to learn `deviceFinest`) both read
  scene 0's octree: clamping the floor also caps what `updateDeviceFinest`
  can ever observe — make sure the clamp only engages AFTER deviceFinest
  settles, or the running-min learns a degraded value permanently.
- E2E on BOTH the Redmi (churn gone, quality unchanged at pinned depth)
  and desktop (bitwise-identical behavior: floor stays viewer-owned).

## Evidence links

- Field log (2026-07-05 session): `[portals] ceiling=3000000
  costs=[10911585,10192576,24907588,16844883] resident=[0,1,2]
  depths={"0":3,"1":3,"2":4} deviceFinest=0 active=0` + endless
  `GET .../0_8/{scales,sh0}.webp - Error 0. Retrying` cycles.
- Related fixes shipped in the streaming-blob branch: `76b9b54` (overlay
  armed from live residency), `9aad52d` (reveal depth = assigned pin
  depth; scene 0 has no `sceneMinLevel`).
