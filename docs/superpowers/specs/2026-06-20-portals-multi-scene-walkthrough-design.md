# Portals — multi-scene walkthrough (design spec)

- **Date:** 2026-06-20
- **Status:** Approved (brainstorm); sub-project 1 ready for an implementation plan
- **Supersedes:** the abandoned merge-cut tool (archived as git tag `archive/merge-cut-tool`)

## 1. Background & motivation

The merge-cut tool tried to fuse two overlapping 3DGS floor captures into one clean
scene by a geometric half-space cut. This is constructive solid geometry on a
radiance field, and it cannot work: the cross-floor "haze" (each capture's blurry
reconstruction of the *other* floor) is made of large, soft, anisotropic gaussians
centered right at the slab — at the *same plane-distance as real surface*. No
positional rule (plane, margin, straddler cut, anisotropy ratio) can drop them
without eating real geometry. The discriminator is "which scene has good data
here," which a single cut plane does not capture.

**New approach — portals.** Don't merge at all. Keep each floor as its own scene,
render only one at a time, and switch the active scene when the camera passes
through an author-defined doorway rectangle. This deletes the seam problem instead
of solving it: every scene renders at full fidelity, there are zero seam artifacts,
and only one scene's gaussians are ever drawn (cheaper). It reuses the existing
off-limits-zone authoring UI (rectangle + gizmo) and the multi-scene Splat model.

## 2. Goal & non-goals

**Goal:** an author can place portal rectangles between loaded 3DGS scenes and, in a
"Walkthrough" mode, navigate a multi-space experience where crossing a portal swaps
the visible scene.

**Non-goals (this spec):**
- Producing a single fused/merged splat asset (portals deliberately avoid this).
- Crossfade / transition effects (postponed; hard swap for v1).
- The exported standalone viewer (see §5 — separate sub-project, gated behind a spike).

## 3. Decomposition

Two sub-projects, shipped in order:

1. **Editor portals** (this spec, fully designed below): authoring + live switching
   inside the SuperSplat editor viewport. Self-contained, low risk, feasible today.
2. **Exported-viewer portals** (sketched in §5, deferred): multi-scene bundle +
   runtime switching in the published HTML. Needs a feasibility spike first and
   reuses sub-project 1's data model; it gets its own spec after the spike.

## 4. Sub-project 1 — editor portals

### 4.1 Switching model (decided)

**Cross-the-doorway, stateful.** Each portal is a finite rectangle. As the camera
moves, the segment `prevCamPos → curCamPos` is tested against every portal each
frame. When it crosses a portal, the active scene becomes the scene on the side the
camera ended on. The portal records the scene on each side, so a crossing picks a
definite target (it is not a blind toggle). A single global `activeSplatId` is
visible at any time. Topology supported: a **general N-scene graph** (any number of
scenes connected by any number of portals).

### 4.2 Data model

A portal mirrors `ZoneData` (`src/off-limits-zones.ts:7-21`) plus the two scenes it
bridges:

```ts
type PortalData = {
    id: string;
    position: [number, number, number];   // rectangle center, world space
    rotation: [number, number, number, number]; // quaternion; local +Z is the rect normal
    width: number;
    height: number;
    frontSplatId: string;   // scene on the +normal (+Z) side
    backSplatId: string;    // scene on the -normal (-Z) side
};
```

Plus one global setting: `startSplatId` (the seed for Walkthrough; default = first
loaded splat).

Storage/serialization parallels off-limits zones exactly — a new
`src/portals.ts` module providing `registerPortalsEvents(events)` with:
- in-memory `PortalData[]` + selected id + `startSplatId`;
- events `portals.changed`, `portals.selectionChanged`, `portals.byId`,
  `portals.selected`, `portals.count`, `portals.startSplat`;
- edit ops `AddPortalOp` / `RemovePortalOp` / `UpdatePortalOp` (undo/redo), mirroring
  the zone ops;
- `docSerialize.portals` / `docDeserialize.portals` (+ `startSplatId`) wired in
  `src/doc.ts` alongside the existing `offLimitsZones` hooks;
- `scene.clear` handler to wipe the list;
- a `portals.export` event (used later by sub-project 2; harmless now).

### 4.3 Authoring UI

**Portal tool** — `src/tools/portal-tool.ts`, cloned from
`src/tools/off-limits-zone-tool.ts`. Reuses verbatim: the `select-toolbar` floating
bar, TranslateGizmo/RotateGizmo with the Move/Rotate mode toggle, Add button,
click-to-select-by-projected-corners, width/height `NumericInput`s, and the
"render the shape on `offLimitsLayer` even when the tool is inactive" behavior.

Changes from the zone tool:
- Replace the single "message" `TextInput` with two `SelectInput`s — **Front scene**
  and **Back scene** — populated from the loaded splats and refreshed on splat
  add/remove. Editing a selected portal's front/back goes through `UpdatePortalOp`.
- Add a **Start scene** `SelectInput` (defaults to the first loaded splat; writes
  `startSplatId`).

**Portal shape** — `src/portal-shape.ts`, cloned from
`src/off-limits-zone-shape.ts`, rendered on the same `offLimitsLayer` with the same
depth-occluded translucent quad, but a **distinct color** (e.g. cyan/green) so
portals read differently from red off-limits walls.

**Toolbar button** — a portal button in `src/ui/bottom-toolbar.ts` next to the
off-limits button, same registration/active-toggle pattern.

**Localization** — `portals.*` keys in `static/locales/en.json` (`add`, `move`,
`rotate`, `front`, `back`, `start`, tool/tooltip labels). Other locales fall back to
English, consistent with the existing `offLimitsZones.*` and `mergeCut.*` keys.

### 4.4 Toolbar active-state bug fix (applies to off-limits too)

The off-limits Move/Rotate buttons add the `.active` class in JS
(`off-limits-zone-tool.ts:159-160`) but `src/ui/scss/select-toolbar.scss` styles
`.select-toolbar-button` with only height/padding/border-radius — there is **no
`&.active` rule**, so the active state is invisible. Fix: add a single
`&.active { background-color: <accent token from colors.scss>; }` rule to
`.select-toolbar-button` in `select-toolbar.scss`. Because the off-limits bar and the
new portal bar share the `select-toolbar` / `select-toolbar-button` classes
(`off-limits-zone-tool.ts:41,44-46`), this one rule fixes the existing off-limits bug
and gives portals correct active styling for free.

### 4.5 Walkthrough toggle

A **Walkthrough** toggle button is added next to the "Solo Selected" toggle in the
scene panel header (`src/ui/scene-panel.ts:46-61`), using the same
`panel-header-button` + `.active` pattern. It is **disabled unless ≥1 portal exists**
(listen to `portals.changed`/`portals.count`). On click it flips `.active` and fires
`portals.walkthrough(active)`. A new svg icon + tooltip key accompany it.

Walkthrough mode is a **non-destructive visibility overlay**:
- **On enable:** snapshot every splat's current `visible` flag; set
  `activeSplatId = startSplatId`; show only the active splat, hide the rest.
- **On disable:** restore the snapshot exactly. No edit op, no document change.

### 4.6 Runtime switching (editor)

A runtime module (in `src/portals.ts` or `src/portals-runtime.ts`) listens to the
`prerender` event (which carries the camera world transform;
`src/scene.ts:381`) **only while Walkthrough is active**. Each frame:
1. Read `curCamPos`; with `prevCamPos`, form the movement segment.
2. For each portal, call the pure `segmentCrossesRect` (§4.8). If it crosses, set
   `activeSplatId` to `frontSplatId`/`backSplatId` per the side the camera ended on.
3. If the active scene changed, apply visibility (active visible, others hidden).
4. Store `curCamPos` as `prevCamPos`.

If the segment crosses multiple portals in one frame, process them in order of
crossing parameter `t` along the segment so the final state is the last doorway
entered.

### 4.7 Start scene & desync (decided)

No per-scene bounding boxes — overlapping floor captures make them ambiguous, so they
are out. Seeding is handled entirely by Walkthrough mode: enabling it sets the active
scene to `startSplatId` (default first loaded splat, pickable in the portal tool).
The known weakness of the stateful model (a camera teleport that skips a doorway) is
accepted; recovery is to toggle Walkthrough off then on, which re-seeds to the start
scene.

### 4.8 Pure geometry + testing

The crossing math lives in a new playcanvas-free module `src/portal-geom.ts`
(mirroring `src/merge-cut-geom.ts` / `src/alignment-solve.ts`, which exist because
importing playcanvas under vitest's node env hangs). Core function:

```ts
segmentCrossesRect(prev, cur, portal): { crossed: boolean; side: 'front' | 'back' } | null
```

It computes the segment/plane intersection, checks the hit lies within the
rectangle's width/height extents (reusing the same geometry the off-limits
`segmentBlockedByWall` uses — `src/viewer-companion/off-limits-collision.ts:19-66`),
and reports which side the camera ended on. Unit-tested in
`test/portal-geom.test.ts` (cross front→back, back→front, miss outside extents,
parallel/no-cross, grazing edge). The tool/UI wiring follows the off-limits pattern,
which has no UI tests, so none are added there.

### 4.9 Files (sub-project 1)

**New:** `src/portals.ts`, `src/portal-geom.ts`, `src/portal-shape.ts`,
`src/tools/portal-tool.ts`, `test/portal-geom.test.ts`, a walkthrough svg icon.

**Modified:** `src/ui/bottom-toolbar.ts` (toolbar button), `src/ui/scene-panel.ts`
(walkthrough toggle), `src/ui/scss/select-toolbar.scss` (`.active` fix),
`static/locales/en.json` (keys), `src/doc.ts` (serialize portals + start scene), and
the tool/events registration site (wherever `off-limits-zone-tool` is registered).

### 4.10 Decisions baked in

Reuse the off-limits rectangle/gizmo authoring; portal = finite doorway with
front/back scene; general N-scene graph; stateful cross-the-doorway switching;
walkthrough is an explicit, non-destructive mode gated behind a toggle; hard swap (no
transition) in v1; start scene = first splat, pickable; no per-scene volumes; pure
crossing math unit-tested.

## 5. Sub-project 2 — exported-viewer portals (deferred)

The exported viewer is a **separate runtime** built by `@playcanvas/splat-transform`
(`writeHtml`), and today it hosts a **single** splat scene; off-limits zones work
there only because they are injected as an extra camera-clamping `<script>`
(`src/splat-export-core.ts`, `src/viewer-companion/off-limits-collision.ts`).
Portals need the viewer to actually hold and switch between multiple scenes.

**Spike first (open questions):** Can `writeHtml` emit/host multiple GSplat scenes in
one bundle? If not, can multiple scene assets be bundled and a custom companion
enable/disable them at runtime? How are scene assets referenced/loaded?

**Once feasible, the build mirrors off-limits:** extend `ExperienceSettings` with
`portals[]` + `startSplatId` (the `portals.export` event already planned in §4.2);
add a viewer companion (like `off-limits-collision.ts`) that runs the same
`portal-geom` crossing logic against `window.__supersplatViewer.cameraManager.camera`
and toggles scene visibility. This sub-project gets its own spec after the spike.

## 6. Risks & open items

- **Stateful desync** from camera jumps — accepted; recovered by toggling Walkthrough
  (§4.7).
- **Multiple portals per frame** — resolved by ordering on the crossing parameter
  (§4.6).
- **Memory** — all N scenes are loaded even though one is drawn; fine for the editor,
  revisited for the viewer in sub-project 2.
- **Portal vs off-limits visual distinction** — different shape color (§4.3).
- **Exported viewer feasibility** — unknown until the §5 spike.
