# Portal Viewer — Budget-Bounded Scene Residency (Design Spec)

**Date:** 2026-07-03
**Status:** approved design, pending implementation plan
**Builds on:** Plan 3 (`feat/portal-viewer-mobile-memory`, user-E2E-verified) — this feature is based on that branch.

## Problem

Plan 3 bounded the exported portal viewer's memory by keeping only the **adjacency frontier** resident (active scene + its immediate portal neighbours) and evicting everything else — SOG scenes are fully unloaded, streaming scenes' blocks are reclaimed (`decRefCount`). Re-entering an evicted scene reloads it.

Observed during E2E (both modes, **including desktop**):

- Scenes reload from the network on re-entry even when the device has ample memory to keep them resident. The eviction is driven purely by graph adjacency and ignores available memory budget, so a desktop with GBs free still evicts and re-fetches.
- The reloads are full `200` responses, not cache hits — for **both** large SOG files **and** small streaming webp blocks. The cause of the small-webp re-fetch (i.e. why the HTTP cache is not serving them) is **not yet diagnosed** and is explicitly deferred (see Non-Goals / Phase 2). It is not assumed to be file size.

## Requirements (user priorities, in order)

1. **Never OOM on any device** (hard ceiling).
2. **No loading when crossing** — crossings appear instant at the device's finest achievable detail.
3. **Memory well handled, especially on mobile.**

Scale: ideally unbounded / author's choice; **≤5 scenes in practice today**. SOG is offered on desktop only; mobile uses streaming only.

"Full detail instantly" (req 2) means **resident at `deviceFinest`** — the finest LOD level *this device* actually renders (0 on desktop; 1 or 2 on a low-budget phone, where LOD 0 never loads within budget). This is already an observed quantity in the Plan 3 runtime.

## Approach: budget-bounded residency + LRU (chosen)

Replace "resident = active + neighbours" with **"resident = as many scenes as fit a device memory budget; the adjacency frontier is guaranteed; least-recently-visited scenes are evicted only when the budget is exceeded."**

Consequences:

- **≤5 scenes:** the budget is not exceeded, so **nothing is ever evicted** → zero reloads on desktop and mobile, and the `200`-refetch question is moot (nothing is re-fetched). This fully resolves the reported behavior for today's projects with no service worker and no cache layer.
- **Large projects:** LRU eviction bounds memory (req 1 & 3). Only far, long-unvisited scenes reload; making those reloads fast (from disk, not network) is deferred to Phase 2.

The policy is **mode-agnostic** (unifying SOG and streaming as the user requested): one selection algorithm decides which scenes are resident, from per-scene cost + recency + budget. Only the low-level *apply* differs, because the formats force it:

- **Streaming:** keep the scene resident by pinning its blocks at `deviceFinest` (`incRefCount`, via the existing `pinSceneToLevel`); evict by reclaiming (`decRefCount`, via `unpinScene`).
- **SOG (desktop only):** keep resident = keep the asset loaded; evict = full unload (existing `loadScene` / `unloadScene`).

Rejected alternatives: **keep-N-recent** (count-based; N is a crude memory proxy, weaker req-1 guarantee) and **keep-all-always** (simplest but OOMs on large projects, fails req 1 at scale).

## Architecture

### New pure helper: `selectResidentScenes` (`src/portal-preload.ts`)

Mode-agnostic, pure, self-contained (stringifiable into the injected runtime, unit-tested like `assignPinDepths` / `computeWarmSet`).

```
selectResidentScenes(
  adjacency:      number[][],              // portal graph (scene index -> neighbours)
  activeIdx:      number,
  recencyOrder:   number[],                // scene indices, most-recently-visited first
  sceneCosts:     number[],                // per-scene resident cost in splats (streaming: count at deviceFinest; SOG: full count)
  ceiling:        number                   // max total resident splats (budget)
): { resident: number[], depths: Record<number, number> }
```

Algorithm — admit scenes into the resident set in strict **priority order** until the running cost would exceed `ceiling`:

1. **Guaranteed set** (always admitted, even past the ceiling): scene 0 (the viewer's own start scene) + the active scene + the active scene's immediate portal neighbours. Correctness: an immediate crossing must land on a resident scene; the active scene is bounded by the engine's own balancer regardless.
2. **Recently-visited** scenes, in `recencyOrder` (most-recent first) — so a scene you just left stays resident if it fits.
3. **Remaining scenes by proximity** to the active scene (BFS graph distance, then index order as a tiebreak) — so with budget headroom, *nearer* not-yet-visited scenes are preloaded before farther ones.

Admit a candidate only if its cost still fits `ceiling - sum(admitted costs)`. This makes ample budget (the ≤5-scene case) admit **every** scene at startup → all resident → no loading ever; a tight budget keeps the frontier + nearest/most-recent and evicts the rest.

**Depths:** reuse `assignPinDepths` semantics — resident streaming scenes are held at `deviceFinest`, degraded toward coarser only if the guaranteed set alone would exceed the ceiling (the degradation `assignPinDepths` already implements). SOG scenes have a single depth (full).

Determinism: no `Date.now()`/random; recency is supplied by the caller.

### Runtime wiring (`src/viewer-companion/portals.ts`)

- **Recency tracking:** maintain a most-recently-visited order of scene indices, updated on each `switchTo`. Small (≤ scene count).
- **Budget ceiling:** `ceiling = k × getSplatBudget()` where `k` is a conservative multiple, overridable via a URL param (e.g. `?residentBudget=`) for on-device tuning — mirroring Plan 3's `?budget=` testing lever. Errs toward eviction (req 1). `getSplatBudget` and `deviceFinest` already exist.
- **Per-scene cost:** streaming = whole-scene count at `deviceFinest` from the baked `portalSceneLodCounts`. To make SOG participate in the *same* budget accounting (true unification, and so a large desktop SOG project is bounded too), the export bakes a **single per-scene total splat count for SOG** as a one-element `portalSceneLodCounts[i] = [totalCount]` (a small addition in `src/splat-export-core.ts`; today SOG bakes `[]`). `selectResidentScenes` then treats SOG as a one-LOD scene — no special case. If a count is genuinely absent (older exports), that scene is treated as guaranteed/uncapped.
- **Reconcile:** on startup and each crossing, call `selectResidentScenes`, then apply — pin/keep the resident set, evict the rest — reusing Plan 3's `pinSceneToLevel`/`unpinScene` (streaming) and `loadScene`/`unloadScene` (SOG). Collision-voxel and cache-warming frontiers stay as Plan 3 defined them (unchanged), keyed off the same reconcile.

Relationship to Plan 3's helpers: `selectResidentScenes` becomes the single source of "which scenes are resident and at what depth," replacing Plan 3's `desiredResidentScenes` (which returned only active + neighbours) in the reconcile path. It **reuses `assignPinDepths` internally** for the depth-degradation step on the admitted set (so the budget-degradation logic is not duplicated). `pinDesired`/`reconcileFrontier` keep their structure — pin/keep the resident set, evict the rest — they just consult `selectResidentScenes` for the set.

## Non-goals (Phase 2, deferred)

- **Disk cache / service worker.** Making forced reloads (large projects, tight budgets) load from disk instead of network. This is only needed once eviction actually happens, which does not occur for ≤5 scenes. Phase 2 must **first diagnose** why re-fetches bypass the HTTP cache (engine re-request behavior? cache pressure? `npx serve` per-type headers? — test on a **real host**, not `npx serve`) before assuming a service worker is required.
- Changing the export format, collision, warming policy, or the anim-timeline path.

## Testing

- **Unit (Node/Vitest):** `selectResidentScenes` in `test/portal-preload.test.ts` — guaranteed-set inclusion, recency-then-proximity fill order, ceiling respected, degradation under a tight ceiling, scene-0 always resident, ≤5-scenes-all-fit case (ample budget admits every scene), and determinism. Plus a `src/splat-export-core.ts` test that SOG exports now bake a one-element per-scene count.
- **Injection smoke + substring assertions** (`test/portals-injection.test.ts`): helper stringified in; runtime references present; template still constructs via `new Function`.
- **`npx tsc --noEmit`**, `npm run lint`.
- **E2E (RELEASE build, both variants):** ≤5-scene project — walk the full chain twice on desktop and confirm **no `200` reloads** in the Network tab (nothing evicts); memory stays bounded. Tune `k` (the ceiling multiple) on a **real phone** so a larger project bounds memory without OOM.

## Risks / open points

- **Req 1 is best-effort:** the web exposes no reliable VRAM API, so the ceiling is a conservative heuristic (`k × splatBudget`) tuned on real devices, not a guarantee. The design errs toward evicting sooner. This is the residual risk.
- **`k` needs real-device tuning;** the URL-param override exists precisely for that.
- **Dependency:** builds on the unmerged Plan 3 branch. If Plan 3 merges to `main` first, this rebases cleanly.

## Addendum (2026-07-03, post-E2E round 1)

Desktop E2E on a real 4-scene streaming project (Maison_Bueil) failed: visible re-streaming on every crossing and on re-entry. Two corrections to this design:

1. **The "≤5 scenes always fit" premise was wrong at real scene sizes.** A scene's resident cost at `deviceFinest = 0` is its whole LOD pyramid — measured 10.9M splats for one scene (`[5.82M, 2.91M, 1.45M, 0.73M]`) — while the desktop ceiling was only `3 × 4M = 12M`. The multiplier is now **platform-split: 12 on desktop** (48M — several full pyramids fit; desktops have the memory), **3 on mobile** (unchanged; never-OOM outranks instant crossings there). `?residentBudget=` override unchanged.
2. **Scene 0 is NOT inherently resident.** The engine frees a disabled scene's blocks (`GSplatOctreeInstance.destroy()` decRefCounts placements with cooldown 0), so crossing away from the start scene freed all of it and returning re-streamed it. Scene 0 is now managed like every other scene: always **guaranteed** (never evicted — it is the reset target), its cost counted against the ceiling, its blocks pinned (`comps[0]`/`octrees[0]` captured; its `lodRangeMin` stays viewer-owned).

Also verified during diagnosis: the HTTP disk cache works on the test host (bulk of re-fetches served `(disk cache)` in 1–8 ms); the visible loading was engine re-decode/upload after needless eviction, not network. Phase 2 (service worker) remains deferred and is now only relevant to genuinely-evicting large projects.

## Addendum 2 (2026-07-03, post-E2E round 2)

Round 2 failed on the same project with bigger real numbers (finest counts 5.8M/5.4M/12.8M/8.7M → pyramid costs ~61.3M total vs the fixed 12×4M = 48M desktop ceiling). Conclusion: **a fixed render-budget multiple can never anticipate project size.** The desktop ceiling is now **project-aware** (`computeResidentCeiling`): `max(mult × splatBudget, min(Σ scene pyramid costs, deviceMemory GB × 16M splats/GB))` — any project that fits the RAM-derived cap (128M splats on a typical 8GB-reporting desktop) is held fully resident and never degrades or evicts; only genuinely oversized projects LRU-evict. Mobile is unchanged (`3 × splatBudget`). `?residentBudget=` still overrides everything; note its unit is resident splats across ALL pinned LOD levels (~1.9× the finest-level total). `pinDesired` now logs a deduped `[portals] ceiling/costs/resident/depths` line so field E2Es are diagnosable from the console.
