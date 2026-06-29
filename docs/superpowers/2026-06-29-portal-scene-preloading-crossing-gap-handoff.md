# Portal Scene Preloading — on-crossing gap: session hand-off

> **Status:** IN PROGRESS, not done. Cache-warming + coarse-pin work mechanically and are committed, but the **visual loading gap on portal crossing is NOT solved.** This memo lets a fresh session continue. Read it fully before touching code.
> **Branch:** `feat/portal-scene-preloading` (NOT merged, NOT pushed). Tip commit `d514c0a`.
> **Spec:** `docs/superpowers/specs/2026-06-29-portal-scene-preloading-design.md` · **Plan:** `docs/superpowers/plans/2026-06-29-portal-scene-preloading.md`
> **Touches:** `src/portal-preload.ts` (pure helpers), `src/viewer-companion/portals.ts` (injected runtime), + their tests. No editor / server / export-format changes.

## Goal (unchanged)

Exported **streaming** portal viewer: when you cross a portal into another scene, there should be **no loading delay / no black-or-spinner gap** — the destination should appear immediately (coarse is fine) and refine in. Always-on for streaming portal exports. User is **memory-conscious** (low-end devices) and wants **no overlay**.

## The confirmed root cause (this is the crux)

On crossing, the companion enables the destination scene's gsplat. The camera is **right at the doorway = close to the geometry**, so the engine's per-node LOD wants **fine** levels for near nodes. The engine's underfill fallback (`GSplatOctreeInstance.selectDesiredLodIndex`, `playcanvas.dbg.mjs` ~L132534) only drops **1–2 levels** (`lodUnderfillLimit`) from the optimal — it does **NOT** fall all the way back to the coarsest. So:

- We pin the **coarsest** level resident (works — see below), but the engine **won't display it up close**; near nodes render **nothing** until their fine LODs stream + decode.
- That empty near-geometry is the "black/partial gap" the user sees. It is the **engine's** gap, not our overlay.

**Diagnostic proof (engine v2.19.2, WebGPU), from temporary probes:**
```
[pin] scene 1 pinnedBlocks=2
[pin] scene 1 RESIDENT at frame 8 -> ready (no overlay)
[cross] to 1 ready=true streaming=true pendingIndex=null
```
`ready=true` ⇒ our spinner overlay IS correctly suppressed. The remaining gap is purely the engine streaming the destination's near-camera fine detail.

**Why the INITIAL scene has no such gap (key insight → the fix):** the viewer reveals the start scene with its LOD range clamped to the coarsest level first — `gsplatComponent.lodRangeMax = gsplatComponent.lodRangeMin = lodLevels - 1` (`../supersplat-viewer/src/viewer.ts` ~L427–437) — so it shows coarsest **everywhere** (no black), then `applyPerfSettings` opens the range (`lodRangeMin=0, lodRangeMax=1000`) to refine. Portal scenes get **no such clamp**, so on enable the engine immediately wants fine LODs → gap.

## NEXT STEPS (prioritized) — start here next session

### 1. (TOP, most promising) Clamp the destination's LOD range to coarsest on crossing, then open it
Mirror the viewer's gapless initial reveal. On enabling/crossing into a scene, set its gsplat component
`lodRangeMin = lodRangeMax = lodLevels - 1` (coarsest). Because we already **pin the coarsest resident** (decode-free), the engine then displays coarsest **everywhere instantly — no black** — and after a few frames open `lodRangeMax` (e.g. to a high value) so it refines to full detail. This directly implements the user's idea ("display a coarser LOD rather than a black/partial gap") and explains the initial-scene behavior.
- API: per-component `gsplatComponent.lodRangeMin/lodRangeMax` (engine setters `playcanvas.dbg.mjs` L56648–56676; viewer usage `viewer.ts` L419–420, L434–435).
- The companion creates extra-scene components in `start()`'s `loadFromUrl` callback (`portals.ts`) — set the clamp there (and/or in `switchTo`/`applyActive` on enable). Open the range a few frames after enable (mirror `applyPerfSettings`).
- Likely lets us **drop the whole on-crossing overlay + readyScenes-skip machinery** (the gap is gone, not just covered). Keep pinning coarsest (makes the clamped reveal decode-free).
- Watch: `lodRange` per-component vs the global `app.scene.gsplat` range the viewer's `applyPerfSettings` sets — make sure opening one scene's range doesn't fight the global. Verify whether clamping is per-placement (it is, via the component) and that the global budget still applies.

### 2. (Secondary) Preload/pin the LODs the destination needs *from the portal viewpoint*, at startup
The user's other idea: load the fine near-doorway detail up front. We DO know the crossing viewpoint — the **portal position is baked** (`data.portals[i].position`). At startup, evaluate which LODs the destination scene needs when viewed from (near) the portal and pin those resident. More targeted than "all fine levels," bounded-ish memory. Heavier than #1; pursue only if #1's coarse-then-refine isn't acceptable. Engine LOD eval: `evaluateNodeLods` (~L132649) is distance-driven; you'd approximate the per-node optimal LOD for the portal camera pos.

## What is committed and works (current branch state @ d514c0a)

Mechanically correct, but doesn't close the gap (#1 above is the missing piece):
- **Budget cache-warming** (`warmExtraScenes` in `portals.ts`): two-level plain-`fetch` of each extra streaming scene's blocks — `lod-meta.json → coarse block meta.json → webps` — for LOD levels coarsest..budget (`lodMinLevelForBudget` over baked `portalSceneLodCounts`, vs `app.scene.gsplat.splatBudget`). **Browser-cache only, zero resident memory.** Removes the *network* wait (helps cold deployments). Pure helpers `collectLodFileUrls`, `collectSogBlockFileUrls`, `lodMinLevelForBudget` in `src/portal-preload.ts` (unit-tested, 31 tests).
- **Pin coarsest resident** (`pinSceneCoarse`): per extra scene, `octree.incRefCount(i)` + **re-poll** `octree.ensureFileResource(i)` every frame until `octree.getFileResource(i)` is truthy, then `readyScenes[idx]=true`. Bounded memory (coarsest only).
- **Overlay-skip:** `readyScenes[idx]=true` makes `switchTo` skip `beginLoading` → no spinner. (But reveals the black gap → why #1 is needed.)
- Defaults changed: `REVEAL_LOD = 0` (was 1). `SHOW_DELAY` left at 0 — **user tunes `SHOW_DELAY`/`REVEAL_LOD` by hand in the exported `index.html`** (they're literal text in the injected script; the template-string contents are NOT minified by terser).

## Critical engine facts (verified in `../supersplat-viewer/node_modules/playcanvas/build/playcanvas.dbg.mjs`)

- A streaming `lod-meta.json` `filenames` are per-block **`meta.json`** paths (e.g. `3_0/meta.json`); each block bundles its data as webp textures (`means_l/u`, `quats`, `scales`, `sh0`, `shN`) listed under those keys in the block meta (`SogBundleParser` ~L146776). A plain `fetch` of the block meta does **not** pull the webps — must go two levels (what `warmExtraScenes` does).
- LOD index: **0 = finest, `lodLevels-1` = coarsest** (matches `portalSceneLodCounts` ordering). Coarsest blocks were `3_x` in the test export (`lodLevels=4`).
- `octree.ensureFileResource(i)` only **starts** the load; it registers the finished resource into `fileResources` on a **later** call (normally the render instance polls each frame). A **disabled** scene has no instance → you must **re-call ensureFileResource yourself each frame** until `getFileResource(i)` is truthy. (This was the bug fixed in `d514c0a`.) `getResource` = `asset?.resource` (`GSplatAssetLoader.getResource` ~L147112).
- Cooldown ticks only advance for octrees that have a **render instance** (`GSplatManager` ~L136453). A disabled scene's loaded blocks are **never aged out** → engine-side loading effectively pins resident (this is why "cache-only via the engine" is NOT memory-free; we used plain `fetch` for the memory-free part and `incRefCount` only for the deliberate coarse pin).
- Reaching the octree: `asset.resource` is a `GSplatOctreeResource`; `.octree` is the `GSplatOctree` with `.files[i] = {url, lodLevel}`, `.lodLevels`, `incRefCount`, `ensureFileResource`, `getFileResource`. `getOctree(asset)` in `portals.ts` tolerates both shapes.
- Each `GSplatOctreeResource` has its **own** `GSplatAssetLoader` (separate per scene), so preloading an extra scene doesn't contend with the start scene's loader.

## Diagnostic probes (currently REVERTED out of the committed source)

To re-diagnose, re-add (they were minimal/non-spammy — transitions + once/sec):
- In `pinSceneCoarse`: log `pinnedBlocks`, on resident `RESIDENT at frame N`, periodic `waiting frame N resident=x/y`, on timeout `TIMEOUT`.
- In `switchTo` (before the `beginLoading` line): `console.log('[cross] to '+idx+' ready='+!!readyScenes[idx]+' streaming='+streaming+' pendingIndex='+pendingIndex)`.
- **Always re-export + hard-reload** to test; the companion is injected into the exported viewer at export time. Test a **release** build (terser).

## Things already ruled out (don't repeat)

- Cache-warming any depth: removes network only; can't remove decode/GPU/work-buffer build, and **doesn't address the underfill gap**. Confirmed with all-`304` runs still showing the gap.
- `SHOW_DELAY` alone: only delays *when* the spinner shows; doesn't shorten the underlying load; ≥8 still showed it.
- `REVEAL_LOD=0` + `SHOW_DELAY=8`: still showed it (the reveal heuristic + the underfill gap).
- Pinning coarsest alone: resident (confirmed) but **not displayed up close** → gap remains. Needs #1 (LOD-range clamp) to actually show the resident coarse.

## User preferences observed (carry forward)

- Memory-conscious (low-end devices) → prefer bounded/zero resident memory; avoid pinning whole fine levels.
- Wants **no overlay** on crossing; coarse-then-refine is acceptable, black/partial is not.
- Tunes `SHOW_DELAY`/`REVEAL_LOD` himself in the exported `index.html`.
- Prefers Bash; `npm run lint` CRASHES repo-wide (ESLint 10 import/order) → gate on `./node_modules/.bin/tsc --noEmit` + targeted `npx vitest run`, not lint. RELEASE-build E2E is the real test (terser).
