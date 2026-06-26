# Portal Viewer — Streaming-Scene Loading Overlay: Design Spec

> **Status:** Approved design, ready for implementation planning.
> **Parent:** `docs/superpowers/specs/2026-06-20-portals-sub-project-2-exported-viewer-design.md` (the exported-viewer walkthrough this improves).
> **Touches:** `src/viewer-companion/portals.ts` only (plus a new unit test). No editor, export-bundle-format, or `portal-export.ts` changes.

## 1. Goal

In the **exported standalone viewer**, the first time the camera crosses a portal into a **streaming** scene, the viewer briefly shows the empty clear color — a "black screen" — because that scene's splat data has not streamed yet. Replace that black frame with a **loading overlay**: a full-viewport dark backdrop, a CSS spinner, and a localized "Loading…" label, shown only while the target scene is not yet renderable and hidden the instant its data is ready.

## 2. Root cause (confirmed)

The companion runtime (`src/viewer-companion/portals.ts`) eagerly creates one gsplat entity per extra scene at startup via `app.assets.loadFromUrl`. In **streaming** mode the URL is `lod-meta.json`: that metadata loads quickly and the entity is created, but the actual splat data streams in **on demand, camera-driven**. The PlayCanvas 2.19 build drives this through `evaluateNodeLods(cameraNode, …)` / `selectDesiredLodIndex(...)`, fetching each scene's data by its screen-space size from a camera that is **currently rendering it**.

Inactive portal scenes are held **disabled** (`e.enabled = false`), so they are not in the render pipeline, their LOD is never evaluated, and **nothing streams**. On the first crossing the entity is enabled but has zero resident splats → the clear color shows until the first chunks arrive. On later visits the data is already resident, so the switch is instant.

For **non-streaming** (SOG) exports this never happens: `loadFromUrl`'s callback fires only once the whole `.sog` is loaded, and `tick()` skips the crossing until `entities[next]` exists — so the scene is fully resident the moment it can be switched to.

## 2b. As-built design (supersedes the readiness mechanism in §3–§8)

§1–§2 (goal, root cause) held up. But a **console spike on a real streaming export** disproved the core assumption behind §3/§5/§6/§8 — there is **no per-scene splat count** for unified/streaming gsplats (`gsplat.instance` is `null`; the octree resource exposes none), so `readySplatCount(idx)` as specified is not implementable. Combined with user feedback during the E2E, the shipped design is:

- **Readiness signal = the global renderer splat count** `app.renderer._gsplatCount`, used as a per-scene proxy **because the companion already keeps exactly one scene enabled at a time**. At a crossing it craters (new scene unstreamed) then climbs to a plateau.
- **Reveal threshold = a chosen LOD level's exact splat count.** The streaming exporter decimates each scene into whole-scene LOD levels (`D0` full, ~¼ each step, down to ~64K); their per-level counts are **baked into the payload** as `portalSceneLodCounts[sceneIndex][lodLevel]` (level 0 = finest). The overlay hides when the resident count reaches `portalSceneLodCounts[next][len-1-REVEAL_LOD]` (`REVEAL_LOD=1`, tunable: 0 = coarsest/earliest, higher = denser/later). This replaced an interim `floor × REVEAL_FACTOR` heuristic and removes per-scene tuning.
- **`crossedBelow` lag guard:** the global count lags 1–2 frames at the old scene's value after the swap, so the threshold trigger only arms once the count has first dipped below the threshold (confirming we're measuring the new scene).
- **Fallbacks:** plateau detection (count stopped climbing — for when a portal drops you far from a scene's bulk and the threshold is never met) and an absolute frame cap (~600 ≈ 10 s). On any error the poll block degrades to `endLoading()` — never a stuck overlay or dead rAF loop.
- **Streaming-only:** the overlay is gated on streaming (detected from `lod-meta.json` scene URLs); **SOG exports never show it** (they're fully resident, no black frame), which also let `SHOW_DELAY = 0` (show immediately) since there's no SOG flash to defer past.
- **Start scene pre-marked ready** (`readyScenes[activeIndex] = true`): returning to the initial scene shows no overlay.
- **Scope grew beyond one file:** baking the LOD counts touches the export pipeline — `buildStreamingLodTable` / `writePortalScene` / `writeStreamingViewerCore` (`splat-export-core.ts`, incl. moving the extra-scenes write before the HTML injection), the `ExperienceSettings` type (`splat-serialize.ts`), and the payload (`buildPortalsInjection`). Because both local and server exports funnel through the same `writeStreamingViewerCore`, **no server/wire/file-handler changes were needed**; non-portal and SOG exports are byte-for-byte unchanged.

The localized label, overlay style/CSS, non-blocking input, `readyScenes` "shown once", and DOM/error-handling design (§3 style rows, §4, §7) shipped as originally specified.

## 3. Scope decisions (locked)

> Note: the "When the overlay shows" row below reflects the original `readySplatCount` design; see §2b for the as-built readiness mechanism. The other rows shipped as written.

| Decision | Choice |
|---|---|
| Where | **Exported viewer only** (`src/viewer-companion/portals.ts`). No editor changes. |
| When the overlay shows | **Only when the target scene isn't renderable yet** (`activeSplats === 0`). In practice the first visit to each extra scene; instant/no-overlay otherwise. Self-correcting for SOG (always immediately ready → never shows). |
| Per-scene "shown once" | Once a scene is confirmed renderable it is recorded; later crossings into it never re-show the overlay. |
| Overlay style | **Full-viewport near-opaque dark backdrop** (covers the black) + **CSS-only spinner** + **localized "Loading…" label**, fading in/out (200ms), matching `off-limits-zones.ts` timing. |
| Label localization | **Reuse the `off-limits-zones.ts` pattern**: a `DEFAULT_MESSAGES` map (same 9 languages) + a pure `resolveLoadingMessage(...)` resolver, picking from `navigator.language` (region → base → English). No custom-text field (YAGNI). |
| Input handling | **Non-blocking** overlay (`pointer-events: none`, like off-limits). The load window is short; intercepting the viewer's input controller would be more invasive and risk a stuck state. |
| Preloading inactive scenes | **Out of scope** for now. Considered and deferred: PlayCanvas LOD streaming is camera-driven, so forcing a disabled/off-screen scene to stream its correct detail requires tricking the engine (e.g. an offscreen throwaway camera), front-loads downloads, and partly defeats streaming. May revisit as a later enhancement that only makes the overlay appear less often. |

## 4. Architecture

Mirror the `off-limits-zones.ts` companion structure, which the portals companion does **not** yet use (it currently emits only two `<script>` tags and no `<style>`):

- **`companionStyle`** string injected as `<style>…</style>`. `buildPortalsInjection` gains this `<style>` tag alongside the existing payload + runtime scripts.
- **`DEFAULT_MESSAGES`** map + a pure **`resolveLoadingMessage(custom, defaults, lang)`** resolver, injected verbatim via `Function.toString()` (the same stringify-into-runtime technique already used for `segmentCrossesRect` / `resolveActiveSplat`). `custom` is unused for now but keeps the signature parallel to `resolveOffLimitsMessage` for a future text field.
- The runtime builds three DOM nodes once at startup — a **backdrop** `<div>`, a **spinner** `<div>` (CSS-animated, no image asset), and a **label** `<div>` — appended to `document.body`, hidden by default, toggled via an `active` class.

No payload/bundle changes. The `streaming` flag is not needed at runtime: for SOG the scene is resident the instant the entity exists, so the readiness check passes immediately and the overlay never shows.

## 5. Components (all inside the existing companion IIFE)

1. **`readySplatCount(idx)`** — returns the active-splat count for scene `idx`'s gsplat, via the `activeSplats` / `numSplats` surface found in the PlayCanvas build. The **exact property path** (per-instance vs. manager-global; how to reach it from the gsplat entity/component) is the one runtime-internal uncertainty and is **confirmed by a console spike before wiring**. Isolating it in this one function keeps the rest of the design independent of the answer. Returns `0` when not yet resolvable.
2. **`readyScenes` set** — scene indices already confirmed renderable. Membership suppresses the overlay on future crossings.
3. **`showLoading()` / `hideLoading()`** — add/remove the `active` class on backdrop + spinner + label.
4. **Overlay driver — folded into the existing `tick()` rAF loop** (no second loop):
   - When a crossing makes scene `next` active (`applyActive()` already runs), if `next ∉ readyScenes` **and** `readySplatCount(next) === 0` → `showLoading()`, set `pendingIndex = next`, reset `pendingFrames = 0`.
   - While `pendingIndex !== null`, each frame: increment `pendingFrames`; if `readySplatCount(pendingIndex) > 0` → add to `readyScenes`, `hideLoading()`, clear `pendingIndex`. Keep `app.renderNextFrame = true` while pending so the engine keeps streaming/rendering and polling advances.
   - **Safety cap**: if `pendingFrames` exceeds a fixed bound (~600 rAF frames ≈ 10 s; frame-counted because `Date.now`/`Math.random` are deliberately unused in this runtime) → `hideLoading()` and mark the scene ready anyway. The overlay can never get stuck.

## 6. Data flow

`buildPortalsInjection` emits `<style>` + the existing payload `<script>` + the runtime `<script>`. At runtime the driver reads only the live app/entities it already holds; no new payload fields. The flow per first crossing: cross → `applyActive()` enables `entities[next]` (streaming begins, camera-driven) → driver sees `readySplatCount(next) === 0` → `showLoading()` → frames tick, data streams → `readySplatCount(next) > 0` → `hideLoading()` + record ready.

## 7. Error handling

- The driver lives inside `tick()`'s existing `try/catch`, which already suppresses repeated errors to keep the rAF loop (and navigation) alive. A detection failure degrades to "no overlay," never to a frozen viewer.
- The **safety cap** guarantees the overlay always clears even if `readySplatCount` never reports > 0.
- DOM mount guarded on `document.body` readiness (append on `DOMContentLoaded` if needed), same as off-limits.
- Payload/CSS injection reuses the existing HTML-escaping; the new `<style>` is static text with no interpolated payload.

## 8. Testing

- **Unit**: `resolveLoadingMessage(...)` — language fallback (region subtag → base subtag → English) and the (currently unused) custom-text precedence. Mirrors the existing `resolveOffLimitsMessage` tests.
- **Console spike** (pre-wiring): in a real exported streaming viewer, confirm the property path that yields a per-scene resident-splat count (`activeSplats` / `numSplats`), and that it reads `0` before a freshly enabled scene streams and `> 0` after.
- **Release-build E2E walkthrough**: export a multi-scene streaming ZIP, serve it, cross a portal into a never-visited scene, and confirm the backdrop+spinner+label appears then clears as the scene resolves (and never appears on the second visit, nor for a SOG export). Per prior portal-task experience, stringified-helper minification can bite, so E2E **must** run against a real release build, not a dev build.

## 9. Out of scope / future

- **Preloading** inactive streaming scenes (see §3) — a possible later enhancement to reduce how often the overlay appears; not a replacement for it.
- **Custom overlay text / per-export styling** — the resolver signature leaves room, but no UI is added now.
- **Editor preview** of the overlay — the black-screen symptom is exported-viewer-only; the editor keeps all splats resident.
