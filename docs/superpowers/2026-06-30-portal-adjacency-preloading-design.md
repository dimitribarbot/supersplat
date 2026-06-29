# Portal adjacency pre-loading — design & outcome

> **Status:** Implemented and user-verified (E2E) for the 2-scene streaming case on `feat/portal-scene-preloading`. Reclaim (3+ scenes) is code-reviewed but not yet E2E-exercised. Supersedes the earlier cache-warming sub-project for the on-crossing gap.
>
> **Touches:** `src/viewer-companion/portals.ts` (injected runtime) + `src/portal-preload.ts` (pure helpers) + their tests. No editor / server / export-format changes.

## Goal

Exported **streaming** portal viewer: crossing a portal into another scene should appear **immediately** — no black, no spinner, no visible loading/refine gap — and the cost should be **bounded** and **device-appropriate** (low-end devices must not over-spend memory).

## The problem, and why earlier attempts fell short

On crossing, the companion enables the destination scene's gsplat. The camera is right at the doorway, so the engine's per-node LOD wants **fine** levels for the near-camera nodes, and a freshly-enabled scene has streamed nothing (a *disabled* scene has no render instance, so it loads nothing on its own). The near geometry therefore renders black/coarse until its fine LODs stream + decode — the gap.

Things that did **not** close it, and why:
- **Cache-warming** the destination's blocks into the browser cache (zero resident memory) removed only the *network* wait; decode + GPU activation remained.
- **Pinning only the coarsest level resident** + revealing clamped to coarsest: the coarsest LOD is extremely sparse (e.g. ~0.2% of the scene), so it shows but looks like nothing, then the engine cold-streams the finer levels → a ~700ms refine climb.
- **Pinning to the budget-fit whole level** (`lodMinLevelForBudget`): this is *coarser* than the level the engine actually renders near the portal. The engine renders a **per-node mix** (near nodes fine, far nodes coarse, summing to ~budget); the whole-level metric won't pin the near-node fine blocks, so revealing there still leaves the engine wanting finer → the climb returns.

## Key engine facts (verified in `playcanvas.dbg.mjs`, engine v2.19.2)

- **LOD ordering:** level `0` = finest, `lodLevels-1` = coarsest. `octree.files[i].lodLevel` and `portalSceneLodCounts[scene][i]` share this ordering.
- **Per-node LOD pick** (`GSplatOctreeInstance.evaluateNodeLods`, ~L132683): each node's optimal level is the FOV-adjusted closest-point distance from the camera to the node AABB, bucketed by `lodBaseDistance · lodMultiplier^i`, then clamped to `[lodRangeMin, lodRangeMax]`. A global **budget balancer** (`GSplatBudgetBalancer`) then coarsens the optimal pick to fit `splatBudget` — so on a tight budget the device renders *coarser* near-node detail than the raw distance pick.
- **Pin / reclaim:** `octree.incRefCount(i)` + re-polled `ensureFileResource(i)` makes a block resident (a disabled scene has no instance to poll it, so we re-poll ourselves). `octree.decRefCount(i, 0)` immediately unloads when our pin was the last ref. The per-frame cooldown unloader (`GSplatManager`, ~L136452) only ticks octrees that have a render instance, so a disabled scene never ages out on its own — explicit `decRefCount(i,0)` is the only way to reclaim it.
- **A scene's working set does NOT linger after you leave:** `GSplatOctreeInstance.destroy()` (~L132438) `decRefCount(i,0)`s all its blocks. Our pin (a separate ref) is the only thing that keeps a hidden scene resident.

## The solution

Two ideas combined:

### 1. Adjacency-driven resident frontier

Keep resident only the scenes reachable in one portal hop from the active scene. Build a portal adjacency graph once (`buildPortalAdjacency`, from each portal's `front`/`back` scene indices). On startup and on every crossing, reconcile (`pinDesired`):

- **pin** every extra scene in `desiredResidentScenes(adjacency, active)` = `({active} ∪ neighbours) ∩ {scene ≥ 1}` that is loaded and not already pinned, and
- **reclaim** (`unpinScene` → `decRefCount(i,0)`) every currently-pinned scene that left the frontier and is not the active scene.

Peak resident ≈ active + direct neighbours + scene 0 — bounded by **graph degree**, not total scene count. Scene 0 (the viewer's own start scene) is always resident and never pin-managed. The pure graph helpers live in `src/portal-preload.ts` and are unit-tested; only the engine glue is in the runtime.

### 2. Device-observed pin depth (the crux)

Pin each frontier scene down to **the finest LOD level this device actually renders**, and reveal clamped there (`lodRangeMin = thatLevel`, `lodRangeMax = 1000`). Because that level matches the engine's per-node optimal for this device, there is **nothing finer left to stage → the crossing is immediate**; and because we pin no finer than the device shows, the resident set is **bounded and device-adaptive** (low-end pins shallower automatically).

We don't *compute* that level (the budget balancer makes the whole-level math wrong) — we **observe** it: the start scene is already being rendered by the engine on this device, so the **finest (lowest) `lodLevel` currently resident in the start scene's octree** is the finest level the device renders. `updateDeviceFinest()` scans the start octree each frame and keeps a running-min `deviceFinest`; `deviceMinLevel()` returns it (coarsest fallback until known). `pinWhenBudgetReady()` defers the first pin until the splat budget is applied **and** `deviceFinest` has settled, because the depth depends on both.

**Validation (desktop, 2 scenes):**
- Default budget → `deviceFinest = 0` → pins all 19 blocks → crossing flat at full detail (immediate).
- `?budget=1` (weak-device sim) → `deviceFinest = 2` → pins **5 blocks** → crossing immediate within a coarse view. Same immediacy, ~¼ the resident blocks. Device-adaptive bounding confirmed.

This makes the **doorway-set** (per-node pinning for the exact portal viewpoint) unnecessary in practice: pinning whole levels `[deviceFinest..coarsest]` is already small on weak devices, and the per-node refinement would only save a block or two.

## Known limitations / future work

- **Running-min lag (tiny):** if `deviceFinest` deepens *after* a scene was pinned (e.g. the user later moves very close to near geometry, loading a finer block in the start scene), the already-pinned scene keeps its coarser floor, so a crossing then shows a small, usually-imperceptible refine. Re-pinning a scene deeper when `deviceFinest` deepens would remove it; deliberately not done (complexity for no visible gain).
- **Reclaim not E2E-verified:** with 2 scenes nothing leaves the frontier, so the `decRefCount(i,0)` reclaim path is code-reviewed but hasn't run live. Verify on a 3+ scene export that the global splat count drops after a `RECLAIM`. Watch the active→hidden transition: the just-destroyed instance must release its refs before our `decRefCount` frees a block; if a stale ref lingers, fall back to a direct `octree.unloadResource(i)` for a non-adjacent hidden scene.
- **Doorway-set (optional):** pinning the exact per-node working set for the baked portal viewpoint (replicating `evaluateNodeLods` for the portal pose) would be the maximally-bounded form. Engine-driving it isn't clean (the instance carries heavy state and frees its blocks on destroy), so it would mean replicating the distance-band math. Given device-finest pinning is already bounded, this is a low-priority refinement, not a requirement.
- **`SHOW_DELAY` / `REVEAL_LOD`** in the runtime remain hand-tunable in the exported `index.html` (the template-string text is not minified by terser); they only affect the streaming overlay fallback, which now rarely shows.
