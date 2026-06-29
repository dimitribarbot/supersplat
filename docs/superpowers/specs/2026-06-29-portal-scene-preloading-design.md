# Portal Viewer — Preload Extra Scenes During the Initial Loading Bar: Design Spec

> **Status:** Approved design, ready for implementation planning.
> **Parent:** `docs/superpowers/specs/2026-06-26-portal-viewer-streaming-loading-overlay-design.md` (the on-crossing loading overlay this builds on) and `docs/superpowers/specs/2026-06-20-portals-sub-project-2-exported-viewer-design.md` (the exported-viewer walkthrough).
> **Supersedes:** the "Preloading inactive scenes — Out of scope for now" deferral in §3 of the streaming-loading-overlay spec.
> **Touches:** `src/viewer-companion/portals.ts` only (plus unit tests for any new pure helper). No editor, export-bundle-format, server, or `portal-export.ts` changes.

## 1. Goal

In the **exported standalone viewer**, when a **streaming** portal export is opened, the user sees the initial loading bar while the start scene downloads. Today, the extra portal scenes stream nothing until the camera first crosses into them, so the **first** crossing into each scene pays a network download (currently masked by the on-crossing loading overlay).

This feature **warms every extra scene's coarse data during the initial loading bar**, in parallel with the start scene, so that crossing a portal has no perceptible loading delay — it behaves like a "subsequent crossing" does today. **Always-on** for streaming portal exports; no user-facing toggle.

## 2. Why crossings are slow the first time, and what makes repeats fast (confirmed)

Two engine mechanisms, both verified against the bundled PlayCanvas debug build (`../supersplat-viewer/node_modules/playcanvas/build/playcanvas.dbg.mjs`):

1. **Disabled streaming scenes stream nothing.** The unified gsplat manager only registers an octree instance for a placement that is in a **camera-rendered layer** (`GSplatManager.reconcile`, ~`135659`; the system loop iterates `camera.layers`, ~`137152`). The companion holds inactive scenes `e.enabled = false`, so they are not placements, have no octree instance, and never stream. LOD is camera-distance driven (`GSplatOctreeInstance.evaluateNodeLods`, ~`132649`).
2. **Hiding a scene does not free its files immediately.** When a scene is disabled, its octree instance is destroyed and its LOD files are released via `octree.decRefCount(fileIndex, cooldownTicks)` using the **normal cooldown** (`this.scene.gsplat.cooldownTicks`, default **100** ticks ≈ 1.6 s at 60 fps; `rebuildWorkBuffer`, ~`135882`). The immediate-unload (`cooldown 0`) path is reserved for device-loss only. Re-enabling within the window calls `incRefCount`, which cancels the cooldown (~`133322`).

Consequently:
- **Quick there-and-back crossings (< ~1.6 s)** are truly instant — files are still resident (cooldown cache).
- **Longer-gap crossings feel fast** because the files were already **downloaded once** and re-fetch from the **browser HTTP disk cache** (fast) + a GPU rebuild, which the on-crossing overlay covers. Only the **first** crossing pays the actual network download.

So "the cache" that makes repeats fast is, for longer gaps, primarily **the first download having already happened**. Warming that download at startup reproduces the fast behaviour for the first crossing too.

## 3. Approach decision: cache-warming (locked)

Chosen mechanism: **cache-warming** — download each extra scene's coarse-LOD files at startup so they are already in the browser cache when a crossing triggers normal streaming.

| | Cache-warming (**chosen**) | Pin-in-RAM (future fallback, see Appendix A) |
|---|---|---|
| Crossing speed | "subsequent-crossing" speed (disk fetch + parse + GPU build; overlay-covered) | truly instant from RAM (GPU rebuild only) |
| Extra memory | **none** (files sit on disk until needed) | coarse data of each extra held resident |
| Robustness | relies on browser caching the files | deterministic — data provably in memory |
| Complexity / engine coupling | **low** — plain `fetch()` + JSON parse | higher — internal octree APIs |

Rationale: it is the simplest mechanism, uses no extra memory, touches no engine internals, and directly reproduces the repeat-crossing speed the user already finds acceptable. Pin-in-RAM is documented in **Appendix A** as the deterministic upgrade path if cache-warming proves insufficient in some deployment.

### Scope decisions (locked)

| Decision | Choice |
|---|---|
| Where | **Exported viewer only**, `src/viewer-companion/portals.ts`. No editor / export-format / server changes. |
| Preload depth | **Coarse only** — warm just the coarsest LOD level's files (`lodLevels-1`). Finer detail still streams on approach (in-place refinement, as with any streaming scene). |
| On/off | **Always-on** for streaming portal exports. No toggle, no new payload flag. |
| Streaming vs SOG | **Streaming-only.** SOG scenes are already fully resident the moment their entity exists, so no warming is needed (and the existing companion already loads them via `loadFromUrl`). Gate on scene URLs containing `lod-meta.json` (same detection the overlay uses). |
| Memory | **No `cooldownTicks` change.** Cache-warming leaves files on disk; nothing is pinned in RAM. The global `cooldownTicks` stays at its default 100. |
| Fallback | The **existing on-crossing loading overlay is retained unchanged** as the guaranteed correctness net (covers a cold/uncached file, a too-fast crossing, or warming not yet complete). |

## 4. Architecture

All changes live inside the existing companion IIFE in `src/viewer-companion/portals.ts` and its build-time `buildPortalsInjection`. No payload/bundle/format changes are required — the warming routine derives everything it needs from data already in the payload (`portalScenes` URLs) and from each scene's own `lod-meta.json` fetched at runtime.

Flow:

1. **Start early.** As soon as `window.__supersplatViewer.global.app` exists (available right after the synchronous `Viewer` constructor returns, before the start scene finishes streaming), kick off warming so it runs in parallel with the start scene's download.
2. **Discover coarse files** for each streaming extra scene (see §5.1).
3. **Warm** each coarse file URL via background `fetch()` (see §5.2).
4. **Fold into the single loading bar** — contribute warming progress to `state.progress` and hold reveal (`state.loaded`) until both the start scene and warming are done (see §5.3).
5. **Crossing** behaviour is unchanged: the existing `switchTo` enables the target scene; the engine's normal streaming now hits the warm cache. The on-crossing overlay remains as the fallback.

## 5. Components

### 5.1 Coarse-file discovery (pure, unit-testable)

The streaming `lod-meta.json` has this shape (confirmed from `GSplatOctree`'s parser, ~`133516`–`133547`):

```jsonc
{
  "lodLevels": <number>,
  "filenames": ["d0.0.bin", "d1.0.bin", ...],   // relative to the meta's directory
  "tree": { /* hierarchical; leaf nodes have a `lods` object */ }
  // leaf node: { "lods": { "0": {file:<idx>,offset,count}, "1": {...}, ... }, "bound": ... }
  // branch node: { "children": [ ... ] }
}
```

- LOD level **0 = finest**, level **`lodLevels-1` = coarsest** (matches the viewer's fast-reveal `lodRangeMax = lodRangeMin = lodLevels-1` and the overlay's `REVEAL_LOD` convention).
- A pure helper — e.g. `collectCoarseFileUrls(meta, metaUrl)` — walks `meta.tree` leaves, gathers `filenames` indices referenced by `lods[String(lodLevels-1)]`, de-duplicates them, and resolves each to a full URL against the meta's directory (relative paths joined to `dirname(metaUrl)`; absolute/`http(s)` URLs left as-is, mirroring the engine's `path.isRelativePath` handling).
- Pure (meta object + URL string in, URL list out), so it is **unit-tested** like `portal-geom.ts` / `portal-anim-timeline.ts`. If it is needed inside the injected runtime, it is stringified in via `Function.toString()` (the established technique for `segmentCrossesRect` etc.); otherwise it can run in `buildPortalsInjection` — **decided in planning** based on whether metas are fetched at runtime (preferred, no build-time fetch) vs. build time.

> Note: the coarsest LOD is normally a small number of files (coarse = few splats), so warming is cheap relative to the start scene's download.

### 5.2 Warming routine (runtime)

For each streaming extra scene URL in `portalScenes` (those containing `lod-meta.json`, skipping index 0 = start scene):

1. `fetch(metaUrl)` → `JSON.parse` → `collectCoarseFileUrls(...)`.
2. `fetch(fileUrl)` each coarse file (default GET, same URL the engine will later request, so the browser cache key matches). Consume/`.catch` to free the body; the goal is only to populate the HTTP cache, not to keep the bytes.
3. Track per-file completion to drive progress (§5.3).

Robustness: every fetch is wrapped so a failure (404, CORS, offline) logs a warning and counts as "done" for progress purposes — warming must **never** stall the loading bar; the on-crossing overlay remains the correctness fallback. Concurrency may be capped (e.g. a small parallelism limit) to avoid saturating the connection against the start scene's stream — tuning decided in planning.

### 5.3 Loading-bar integration

`state` (`viewer.global.state`) is an `observe()` Proxy: writing `state.progress` fires `progress:changed` (drives the bar text + fill, `ui.ts` ~`288`), and writing `state.loaded` fires `loaded:changed` (hides `loadingWrap`, `ui.ts` ~`298`). The viewer sets these from its start-scene `readyHandler`/`firstFrame` (`viewer.ts` ~`463`–`504`, `319`).

Goal: the **one existing bar** reflects start-scene + warming, and the loading screen stays up until **both** are complete.

- **Progress:** combine the viewer's start-scene progress with warming progress (e.g. a weighted or `min()` blend) so the bar cannot reach 100 % until warming is done. The companion writes the combined value to `state.progress`.
- **Reveal hold:** keep the loading screen visible until warming completes. The exact, flicker-free technique for holding `state.loaded` from the injected companion is the **one implementation-level uncertainty** and will be validated during implementation and E2E (candidates: gating/deferring the transition to `loaded`, or covering with the companion's own backdrop until warming finishes). It is isolated so the rest of the design is independent of the chosen technique.
- **Graceful degradation (correctness floor):** if the reveal-hold cannot be made clean, fall back to **best-effort background warming** — warming still runs in parallel and, because coarse files are small relative to the start scene, normally finishes first anyway; any crossing that beats warming is covered by the existing on-crossing overlay. Correctness is never sacrificed for the bar integration.

## 6. What does NOT change

- The crossing/swap logic (`switchTo`, `applyActive`, collision swap, anim-timeline driving) is untouched.
- The on-crossing loading overlay (`beginLoading`/`endLoading`/`tick` poll, `readyScenes`, `REVEAL_LOD`, plateau/cap fallbacks) is **retained as-is** as the fallback.
- No `cooldownTicks` change; no pinning; no extra resident memory.
- Export bundle format, payload schema (beyond reusing `portalScenes`), server, and editor: unchanged. SOG exports: unchanged.

## 7. Testing

- **Unit:** `collectCoarseFileUrls` — given representative `lod-meta.json` fixtures (nested tree, branch+leaf, relative vs. absolute filenames, multiple nodes sharing a coarse file), returns the de-duplicated, correctly-resolved coarse-LOD URL set; ignores finer levels; handles empty/malformed trees defensively.
- **E2E (manual, RELEASE build):** produce a real streaming portal export (≥ 2 scenes). Verify: (a) the initial bar covers warming and reveal waits for it; (b) the Network panel shows the extra scenes' coarse files fetched during the initial load; (c) crossing a portal for the **first** time shows no perceptible loading (no black flash, overlay does not need to engage); (d) SOG exports and non-portal exports are unaffected. Per project convention, always E2E a **terser/release** build (stringified-helper minification gotcha — see [[portals-sp2-phase1-done]]).

## 8. Risks / honesty

- **Cache dependency.** Warming only helps if the files are cacheable in the deployment's serving setup. The target environment already caches them (that is *why* repeat crossings are fast today), so this holds in practice; a `no-store`/`no-cache` config would defeat it — but then repeat crossings would not be fast either, contradicting the observed behaviour. Degrades gracefully to the on-crossing overlay.
- **Cache-key match.** The warming `fetch(url)` must hit the same browser cache entry the engine's later streaming request uses. Same-URL GETs share the HTTP cache by default; low risk, verified in E2E (step b/c). If a mismatch is ever observed, Appendix A's pin-in-RAM (which warms via the engine's own loader) removes this dependency.
- **Reveal-hold cleanliness.** See §5.3 — isolated, validated in implementation, with best-effort background warming as the correctness floor.
- **Engine-version coupling.** Cache-warming itself uses no engine internals (only `fetch` + the public `lod-meta.json` contents). The `file:line` references above are for understanding only.

---

## Appendix A — Future fallback: "pin in RAM" mode (NOT implemented now)

Record kept so this can be implemented later **without re-investigation** if cache-warming proves insufficient (e.g. a deployment that does not cache files, or a need for truly-instant, overlay-free crossings).

**Idea:** keep each extra scene's **coarse** LOD data resident in memory (parsed, not just on disk), while letting the active scene's finer LODs evict normally — i.e. "coarse resides forever, everything else uses the normal `cooldownTicks`."

**Why the obvious lever does not work:** there is **no native per-LOD cooldown** — `octree.decRefCount(fileIndex, cooldownTicks)` applies one global value (`app.scene.gsplat.cooldownTicks`, default 100) to every file. Raising it globally would also retain the active scene's fine LODs (unbounded VRAM growth as you explore).

**The mechanism that does work — pin specific files by ref-count:** the octree exposes the needed surface (in `GSplatOctree`, `../supersplat-viewer/node_modules/playcanvas/build/playcanvas.dbg.mjs`):
- `octree.files[i]` → `{ url, lodLevel }` (`lodLevel` set during parse, ~`133547`; coarsest = `lodLevels-1`).
- `octree.ensureFileResource(fileIndex)` (~`133397`) — triggers the engine's own loader to fetch/parse the file (guarantees the engine's cache key).
- `octree.incRefCount(fileIndex)` (~`133317`) — increments the ref count and **cancels any pending cooldown**, so the file is never unloaded while pinned.
- `octree.getFileResource(fileIndex)` (~`133310`) — check whether a file is resident.

**Sketch:**
1. Get each extra scene's octree (e.g. via the asset created by `app.assets.loadFromUrl`; the start entity's `gsplat.asset` is a numeric id, so reach the resource through the loaded asset — see [[portals-sp2-phase1-done]] Task 8 notes).
2. For file indices with `octree.files[i].lodLevel === lodLevels-1` (optionally the coarsest *K* levels for smoother reveal): `ensureFileResource(i)` then `incRefCount(i)`.
3. Drive the initial bar off `getFileResource(i)` becoming truthy for the pinned set.
4. Leave global `cooldownTicks` at its default — the active scene evicts normally; only the pinned coarse files of extras stay resident → VRAM ≈ (one active scene working set) + (coarse of each extra).

**Trade-off:** deterministic, truly-instant, overlay-free crossings, no dependency on HTTP caching — at the cost of holding coarse data in memory and coupling to these engine-internal octree APIs (consistent with the companion's existing internal poking: `app.renderer._gsplatCount`, voxel `_nodes`, etc.).
