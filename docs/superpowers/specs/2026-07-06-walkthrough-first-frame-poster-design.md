# Walkthrough-first-frame poster — design

**Date:** 2026-07-06
**Branch:** `feat/change-poster-image`
**Status:** approved (design), pending implementation plan

## Problem

The exported viewer shows a load-time **poster** image (blurred while the
scene streams, canvas revealed at `loaded`). Today that poster is a screenshot
of the **current editor viewport**, rendered at export time via
`events.invoke('render.poster', ...)` (`src/render.ts:124`, called from
`src/file-handler.ts:570` for file export and `src/s3-publish.ts:61` for S3
publish). The same viewport pose is also baked as `cameras[0].initial` (the
export's "start pose").

When the export includes a **walkthrough** (a camera animation track built from
the timeline camera poses), `experienceSettings.startMode` is set to
`'animTrack'`. In that mode the viewer **ignores** `cameras[0].initial` and
plays the animation from `t = 0` — i.e. it opens on the walkthrough's **first
frame**, not on the editor viewport. So the poster the user sees while loading
does not match the first rendered frame.

## Goal

When a walkthrough is included, render the poster from the walkthrough's
**first frame** (position + target + fov of the earliest keyframe) so the
poster matches what the viewer opens on. When there is no walkthrough, keep
today's behavior exactly (poster = current viewport).

Apply to **both** the file-export path and the S3-publish path (both build the
same anim track and render the poster the same way).

## Non-goals

- No change to the start-pose (`cameras[0].initial`) baked into the export — it
  stays the current viewport, unchanged.
- No change to the poster streaming/blur/reveal pipeline, the solid-color
  fallback cover, or the mobile canvas keepalive (`src/viewer-companion/poster.ts`).
- No change to how the walkthrough itself is authored or serialized.

## Approach

Derive the first-frame pose from the already-built `experienceSettings` and
pass it into an extended `render.poster`. The anim-track keyframes are flattened
into `experienceSettings` by export time, so no new option field needs to be
threaded through the export/publish plumbing.

### Component 1 — `firstWalkthroughPose(experienceSettings)` (pure helper)

Returns the first-frame camera pose, or `null` when there is no walkthrough.

- Returns `null` unless `experienceSettings.startMode === 'animTrack'` **and**
  a camera anim track with at least one keyframe exists.
- The camera track is `animTracks[0]` (the only track built; named
  `'cameraAnim'`). Its `keyframes.values` is
  `{ position: number[], target: number[], fov: number[] }` (see
  `AnimTrack` in `src/splat-serialize.ts:41`). The first frame is:
  - `position = [position[0], position[1], position[2]]`
  - `target   = [target[0], target[1], target[2]]`
  - `fov      = fov[0]` (fall back to the start-pose / current fov if the fov
    array is missing or shorter than the position array)
- Guard against malformed input (missing `animTracks`, empty `times`,
  `position.length < 3`) by returning `null` → caller falls back to current
  behavior.

Return shape matches what `render.poster` needs:
`{ position: Vec3, target: Vec3, fov: number }` (or the plain-number form the
call site converts to `Vec3`). Placement decided in planning — a small pure
function near the export core so both call sites and a unit test can import it.

### Component 2 — `render.poster` gains an optional `pose` param

`src/render.ts:124`, new signature:
`render.poster(width, height, bgColor, pose?)`.

- When `pose` is provided:
  1. Snapshot the live camera pose (`events.invoke('camera.getPose')`).
  2. Apply the walkthrough pose instantly: set fov, then
     `scene.camera.setPose(position, target, 0)` (damping 0). Entering
     `startOffscreenMode` calls `scene.camera.onUpdate(0)` (`src/camera.ts:879`),
     which snaps the 0-duration tweens — so the pose is fully settled before the
     forced render. (If ordering requires it, apply the pose before
     `startOffscreenMode`, or call `onUpdate(0)` explicitly after `setPose`.)
  3. Render offscreen exactly as today.
  4. In the existing `finally`, **restore the snapshotted pose** (again instant)
     so the editor camera is left untouched.
- When `pose` is omitted: behavior is byte-for-byte unchanged (current
  viewport) — this is the no-walkthrough fallback.

The function already returns `null` on any failure (→ solid-color cover); the
camera restore living in `finally` means a mid-render failure never leaves the
editor camera moved.

### Component 3 — two call sites derive and pass the pose

- `src/file-handler.ts:570` (file export): compute
  `firstWalkthroughPose(options.viewerExportSettings.experienceSettings)` and
  pass it as the 4th arg. `null` → current behavior.
- `src/s3-publish.ts:61` (S3 publish): same derivation from its
  `experienceSettings`, same pass-through.

## Data flow

```
experienceSettings.animTracks[0].keyframes.values (first frame)
  -> firstWalkthroughPose(experienceSettings)  ->  pose | null
    -> render.poster(w, h, bg, pose?)
      -> (pose) snapshot camera, apply pose, offscreen render, restore camera
      -> JPEG bytes (or null on failure)
        -> unchanged downstream: local / server / package / publish
```

## Error handling & edge cases

- **No walkthrough** (`startMode !== 'animTrack'`, or no/empty anim track):
  `firstWalkthroughPose` returns `null` → identical to today.
- **Malformed keyframes**: helper returns `null` (safe fallback), never throws.
- **Missing per-keyframe fov**: fall back to the start-pose / current fov.
- **Render failure with a pose applied**: `render.poster` returns `null`
  (solid-color cover) and restores the camera in `finally`.
- **Editor view**: restoring the snapshotted pose after the offscreen render
  leaves the on-screen editor camera where it was; the offscreen render itself
  does not present to the screen.

## Testing

- **Unit** (pure `firstWalkthroughPose`):
  - anim track present + `startMode: 'animTrack'` → returns first keyframe pose
    (position/target/fov from index 0).
  - `startMode: 'default'` → `null`.
  - empty / missing `animTracks` → `null`.
  - missing/short `fov` array → falls back to provided fov, no throw.
- **Manual E2E** (release build, per project convention):
  - Export a viewer with a multi-pose walkthrough → poster shows the first
    walkthrough pose (matches the viewer's opening frame).
  - Export with animation disabled / no poses → poster unchanged (current
    viewport).
  - S3 publish with a walkthrough → same first-frame poster.
  - Confirm the editor camera does not visibly jump during export/publish.

## Files touched

- `src/render.ts` — `render.poster` optional `pose` param + camera
  snapshot/apply/restore.
- new small helper (placement TBD in plan) — `firstWalkthroughPose`.
- `src/file-handler.ts` — derive + pass pose (file export).
- `src/s3-publish.ts` — derive + pass pose (S3 publish).
- test file for the pure helper.
