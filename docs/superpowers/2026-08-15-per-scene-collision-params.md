# (2) Per-scene collision voxel size + radius, and a scene-aware default

Status: NOT STARTED 2026-08-15. Design decision still OPEN (see "The open
decision"). Architectural path — needs questions → approaches → spec → plan.
Prerequisite reading: `docs/superpowers/2026-08-15-viewer-load-critical-path-findings.md`.
Suggested order: do `2026-08-15-early-lod-clamp.md` (4) first.

## Problem

lauterbrunnen's `index.voxel.bin` was 39.4 MB because collision was voxelised at
`voxelResolution: 0.05` over a 197 × 50 × 190 m outdoor scan (3948 × 1008 × 3792
grid, 5.1 M octree nodes). That file sits on the exported viewer's critical path
— the loading bar cannot appear until it has fully downloaded (see the findings
memo).

**The control already exists.** Both export dialogs already expose a voxel-size
slider, and it already reaches `writeVoxel`:

- `src/ui/export-popup.ts` — `voxelSizeSlider`, `min: 0.02, max: 0.5, precision: 2, value: 0.05`
- `src/ui/s3-publish-dialog.ts` — `voxelSize`, same range and default
- `src/collision-voxel-options.ts` — `voxelResolutionLadder(base, floor)` already
  doubles the size on failure (working around splat-transform's 2^24 solid-block
  Set limit); `COLLISION_VOXEL_FLOOR = 0.4` in `splat-export-core.ts`
- `splat-export-core.ts` `writeCollisionVoxel` — `const baseVoxelSize = collision.voxelSize ?? 0.05`

So this is not a missing feature. `0.05` is simply a silently bad default at
outdoor scale, and the user has no signal that it is about to cost 39 MB.

## The requirement that makes this architectural

From the user, 2026-08-15:

> If we do this, we must adapt the popup to be able to define the voxel-size
> (and collision radius) by scene and not share them for all scenes.

Today `environment` **is** already per-scene, but `radius` and `voxelSize` are
single shared values:

- `src/ui/export-popup.ts:324-362` — `perSceneEnvRow` / `perSceneEnvSelects` /
  `perSceneEnvValues` (keyed by scene **uid**, with the select map keyed by
  index). This is the pattern to follow.
- `src/ui/export-popup.ts:390-408` — the single shared `voxelSizeRow`;
  `radiusRow` likewise. Assembled into the export settings around line 845.
- `src/ui/s3-publish-dialog.ts:65,85,196,275` — the same shared pair.
- `src/splat-serialize.ts:157` —
  `collision?: { environment: 'indoor' | 'outdoor'; radius: number; voxelSize: number }`
- `src/splat-export-core.ts` — `writePortalScene(memFs, index, scene, createDevice, radius, voxelSize, …)`
  takes the two as scalars and passes them into `writeCollisionVoxel`;
  `ExtraPortalScene` already carries `environment` and `seed` per scene.
- The server export path consumes the same serialized shape.

Making the two per-scene changes a type that the UI, the serializer, the export
core and the server all depend on. That is an interface change, hence the
architectural path.

## The open decision

I offered four options for the default and the user did not pick one — they
answered with the per-scene requirement instead. **Re-ask before designing.**

1. **Adaptive default from scene size** — set the slider's initial value so the
   voxel grid's longest axis stays under a fixed cap (~1024 voxels):
   `res = maxExtent / 1024`, clamped to the slider's 0.02–0.5 range.
   Reproduces 0.05 for room/house scans (maison_bueil: 48 m → 0.047) and
   coarsens large ones automatically (lauterbrunnen: 197 m → 0.19). Was my
   recommendation. Note the cap number is a guess — validate it against a couple
   of real scans before committing to it.
2. **Show the estimated binary size next to the slider**, leaving the default
   alone, so an expensive choice is visible before publishing.
3. **Just raise the fixed default** (e.g. 0.10) — simplest, but degrades
   collision precision on small indoor scans where 0.05 is correct.
4. **Nothing** — the control exists; pick a coarser voxel by hand.

(1) and (2) compose well and are not mutually exclusive.

Second open question for the implementing session: with per-scene values, what
should the **default** be per scene — derived from each scene's own extent, or
one global default the user then overrides per scene? The adaptive rule makes
per-scene derivation natural, but it means four sliders that start at four
different values, which needs a UI that makes that legible rather than confusing.

## Constraints worth carrying in

- Per-scene rows are only meaningful for a portal bundle; the single-scene
  export must keep exactly one row. `perSceneEnvRow.hidden` handling in
  `export-popup.ts` (around lines 332-345 and 563) shows how that is done today.
- `perSceneEnvValues` is keyed by scene **uid** so a value survives a scene list
  rebuild, while `perSceneEnvSelects` is keyed by index for assembly. Preserve
  that split.
- Both dialogs need the change; they do not share the collision UI today.
- Localization: any new label needs all 9 locales (`static/locales/*.json`).
  `popup.export.voxel-size` and `popup.export.collision-radius` already exist.
- The gzip fix (already landed) multiplies with this one: lauterbrunnen at 0.19
  voxels *and* gzipped should be a few MB rather than 39 MB.

## Verification

- Unit-test the pure default-derivation helper in `collision-voxel-options.ts`
  (it is deliberately dependency-free and already unit-tested — follow that).
- Export a portal bundle with deliberately different per-scene values and assert
  each scene's `.voxel.json` reports the `voxelResolution` it was given.
- Confirm the single-scene path is byte-identical when the value is left at the
  default (the server's byte-parity guarantee must not move).
