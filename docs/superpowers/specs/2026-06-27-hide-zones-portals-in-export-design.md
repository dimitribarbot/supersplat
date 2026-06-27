# Hide off-limits zones and portals in exported image/video

**Date:** 2026-06-27
**Status:** Approved

## Problem

The render menu can export an image or a video of the currently open scene(s). The
off-limits zones (red translucent panels) and portals (blue translucent panels) are
authoring aids, yet they currently appear in exported images and videos. They should
not be baked into the output.

## Root cause

Off-limits zones and portals both render via a dedicated **zone pass**
(`Camera.zonePass`) that draws `scene.offLimitsLayer`. That pass is a permanent member
of the camera's `framePasses` array (`src/camera.ts:609`) and is **not** gated by
`scene.camera.renderOverlays`.

Every other editor overlay — infinite grid, gizmos, annotations, selection highlight,
camera-pose gizmos — *is* gated by `renderOverlays` (see `src/infinite-grid.ts`,
`src/annotation-overlay.ts`, `src/splat.ts`, `src/camera-pose-gizmos.ts`,
`src/splat-overlay.ts`). The image/video export already exposes a **"Show Debug"**
checkbox (default **off**) that drives `renderOverlays`
(`src/render.ts:128`, `:245`). The zone pass simply isn't wired into it, so zones and
portals leak into the export regardless of the checkbox.

## Decision

Treat zones and portals like every other editor overlay: tie their visibility in export
to the existing **"Show Debug"** toggle.

- Show Debug **off** (default) → zones and portals are **hidden** in the export.
- Show Debug **on** → zones and portals are **shown** (consistent with all other
  overlays; lets a user intentionally include them).

No new UI, no new setting — the existing checkbox already represents this concept.

## Mechanism

PlayCanvas's forward render pass skips a layer's render action when `layer.enabled` is
`false`: `LayerComposition.isEnabled()` returns `false` if `layer.enabled` is false, and
`RenderPassForward.execute()` calls that before rendering each action (verified in
`node_modules/playcanvas/.../render-pass-forward.js` and `.../layer-composition.js`).

Therefore the entire fix is to set `scene.offLimitsLayer.enabled = showDebug` while the
export's offscreen render runs, and restore it to `true` afterward — exactly mirroring
how the surrounding code already toggles `scene.camera.renderOverlays`.

## Changes

Single file: `src/render.ts`.

### `render.image` (`events.function('render.image', ...)`)

- In the setup block, next to `scene.camera.renderOverlays = showDebug;`, add:
  `scene.offLimitsLayer.enabled = showDebug;`
- In the `finally` block, next to `scene.camera.renderOverlays = true;`, add:
  `scene.offLimitsLayer.enabled = true;`

### `render.video` (`events.function('render.video', ...)`)

- In the setup block, next to `scene.camera.renderOverlays = showDebug;`, add:
  `scene.offLimitsLayer.enabled = showDebug;`
- In the `finally` block, next to `scene.camera.renderOverlays = true;`, add:
  `scene.offLimitsLayer.enabled = true;`

`scene.offLimitsLayer` is constructed with the default `enabled = true`
(`src/scene.ts:211`), so restoring to `true` returns it to its normal editor state.

## Explicitly out of scope

- **`render.offscreen`** (`src/render.ts:79`) — a separate code path (not the render
  menu's image/video export). It already renders without overlays and is left untouched.
- **The `renderZoneDepth()` depth pass** in `Camera.onPreRender` (`src/camera.ts:710`)
  still runs during export if any zone/portal exists. With the layer disabled the zone
  mesh won't draw, so that depth texture is harmlessly unused for those frames. Not worth
  complicating the fix to skip it.
- **Portal scene-swap behavior is unaffected.** The walkthrough swap lives in
  `src/portals-runtime.ts` and is driven by the `portals.walkthrough` toggle plus the
  per-frame `prerender` camera position vs. portal *data* (`portals.list`); it flips
  `splat.visible` and never reads `offLimitsLayer`. Disabling the layer only stops the
  quads from being drawn — crossing a portal during a video export still swaps scenes as
  long as walkthrough mode is on.

## Testing

This is GPU render-path glue with no practical unit-test seam, so verification is manual
E2E:

1. Create at least one off-limits zone and one portal in a scene.
2. Export an image with **Show Debug off** → no red/blue panels in the PNG.
3. Export an image with **Show Debug on** → red/blue panels present (unchanged behavior).
4. Repeat for video export (Show Debug off, then on).
5. With walkthrough mode on and Show Debug off, export a video whose camera path crosses
   a portal → scenes still swap correctly, with no blue panel visible.
6. After export, confirm zones/portals are visible again in the normal editor view
   (the `enabled` flag was restored).
