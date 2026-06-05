# Annotations as a Distance-style Bottom Tool — Design

**Date:** 2026-06-04
**Status:** Approved (pending spec review)
**Supersedes (authoring UX only):** the authoring/UI portions of
`docs/superpowers/specs/2026-06-04-annotations-with-links-design.md`. The data model, persistence,
export injection, and viewer-companion link feature from that spec are **unchanged** and remain
authoritative.

## Goal

Rework **how annotations are authored** in the SuperSplat Editor so the workflow mirrors the existing
**Distance (measure) tool**: a button in the **bottom toolbar**, a floating editor bar above the
bottom toolbar, click-to-place / click-to-select, and a real **`TranslateGizmo`** for moving the
point. Annotation markers are redrawn as Distance-style on-screen dots with a numeric badge, and a
hover preview shows what the annotation will look like in the exported viewer.

This replaces the current right-side panel + 3D "jack" marker authoring UX. The annotation **data
model and everything downstream of it is untouched**.

## Background / current state (verified)

- Annotations are owned by a manager `src/annotations.ts` (`registerAnnotationsEvents`): a global
  list of `AnnotationData` (`id`, `position` [world-space], `title`, `text`, `url`, `newTab`,
  `camera`), with undoable ops `AddAnnotationOp` / `RemoveAnnotationOp` / `UpdateAnnotationOp`,
  selection (`annotations.select` / `annotations.selected`), doc serialize/deserialize, and an
  export shape (`annotations.export`). **All of this is kept as-is.**
- Current authoring UI (to be replaced):
  - Right-toolbar button added in commit `129b2ac` (`src/ui/right-toolbar.ts`) toggling a panel.
  - Right-side panel `src/ui/annotations-panel.ts` (+ `src/ui/scss/annotations-panel.scss`,
    `@use` in `src/ui/scss/style.scss`) with list + editor + recapture/delete buttons.
  - 3D "jack" marker `src/annotation-gizmos.ts` (line mesh, yellow when selected, cyan otherwise).
  - Click-to-place tool `src/tools/annotation-tool.ts` (no gizmo; repositions selected on click).
- The **Distance tool** `src/tools/measure-tool.ts` is the reference pattern:
  - Button in `src/ui/bottom-toolbar.ts` (`tool.measure`, active-highlight in the `tool.activated`
    handler at `bottom-toolbar.ts:188`).
  - Floating `select-toolbar` Container appended to `canvasContainer`, shown only when active
    (`measure-tool.ts:84-95`).
  - `TranslateGizmo(scene.camera.camera, scene.gizmoLayer)` attached to a helper entity at the
    selected point (`measure-tool.ts:97,116-125`).
  - Click logic: near an existing point (≤8px screen) → select; else raycast splat → place
    (`measure-tool.ts:295-331`).
  - Screen-space SVG visuals drawn each `postrender` by projecting world→screen
    (`measure-tool.ts:333-371`); circle style `fill:white; stroke:black; stroke-width:2; r:5`
    (`src/ui/scss/tool.scss:72-77`).
  - Delete: splat-delete handler skips when measure is active (`src/editor.ts:534-538`); delete is
    bound to `Delete`/`Backspace` (`src/shortcut-manager.ts:36`).
- Exported viewer tooltip styling (ground truth, bundled in `@playcanvas/splat-transform@2.5.1`'s
  `writeHtml`): class `.pc-annotation` — `background: rgba(0,0,0,0.8)`, `color: white`,
  `padding: 8px`, `border-radius: 4px`, `font-size: 14px`, system font; `.pc-annotation-title`
  is `font-weight: bold; margin-bottom: 4px`. The link companion appends
  `.ss-annotation-link` ("Open link ↗", `src/viewer-companion/annotation-links.ts:98-111`).

## User decisions

- **Many annotations, no list.** Select by clicking a marker in the viewport (mirrors Distance).
- **UI location:** button in the bottom toolbar next to Distance; editor in a floating bar above
  the bottom toolbar.
- **Editor bar:** single inline row, wide inputs — **Title · Text · URL · New-tab toggle**.
- **No Delete button** (use the `Delete`/`Backspace` key). **No Recapture** (camera auto-captured
  once at placement).
- **Marker:** Distance-style on-screen dot with a **numeric badge (1, 2, 3…)** matching the viewer.
- **Hover preview:** hovering a marker shows the exported-look tooltip; the **currently-selected**
  annotation is **excluded** (its move gizmo is active).
- **Marker visibility:** markers (and hover previews) are visible **whenever overlays are on**, even
  when the Annotations tool is inactive.

## Architecture

```
[Authoring tool — active only]   src/tools/annotation-tool.ts (rewritten, modeled on measure-tool)
  bottom-toolbar button ─▶ tool.annotation
  click near marker  ─▶ annotations.select
  click on splat     ─▶ AddAnnotationOp (auto-select, auto-capture camera)
  drag TranslateGizmo─▶ UpdateAnnotationOp(position)
  Delete/Backspace   ─▶ RemoveAnnotationOp
  floating editor bar (Title/Text/URL/NewTab) ─▶ UpdateAnnotationOp(field)

[Persistent overlay — whenever overlays on]   src/annotation-overlay.ts (replaces annotation-gizmos.ts)
  postrender: project each annotation → numbered SVG dot (selected = highlighted)
  pointermove hit-test (~8px): hover a non-selected marker → HTML preview tooltip (.pc-annotation look)

[Unchanged]   src/annotations.ts (data, ops, selection, persistence, export)
              doc.ts serialize/deserialize · splat-export-core.ts companion injection · viewer
```

The split is deliberate: marker drawing + hover preview must run independent of the active tool
(markers are always visible), so they live in a persistent overlay, not in the tool. The tool owns
only the active-mode interactions (place / select / move / edit / delete).

## Components

### Rewritten: `src/tools/annotation-tool.ts`

Constructed as today in `src/main.ts:247`
(`new AnnotationTool(events, scene, editorUI.canvasContainer)`); registered under tool name
`annotation`. Responsibilities (active only):

- Owns the floating **editor bar**: a `select-toolbar`-style `Container` appended to
  `canvasContainer`, hidden unless the tool is active AND an annotation is selected. One inline row:
  `Title` (TextInput), `Text` (TextInput), `URL` (TextInput, placeholder `https://`), `New tab`
  (BooleanInput toggle). Inputs sized generously wide. Stops pointer events bubbling to the canvas.
  Field changes commit via the existing `UpdateAnnotationOp` (suppressed while programmatically
  populating, as `annotations-panel.ts` does today).
- **Click handling** (pointerdown/move/up, `isPrimary`, mirrors measure):
  - hit-test all annotations' projected screen positions; if within ~8px of one → `annotations.select`
    that id (no add);
  - else `scene.camera.intersect(nx, ny)`; on hit → `AddAnnotationOp` with the world hit point and a
    fresh `annotations.newId`, capturing the current camera pose (as `annotation-tool.ts:60-73` does
    today); `AddAnnotationOp.do` already auto-selects;
  - on miss → no-op.
- **Move gizmo**: `TranslateGizmo(scene.camera.camera, scene.gizmoLayer)` attached to a helper
  `Entity` placed at the selected annotation's world position. On `transform:move` update a live
  position (force render); on `transform:end` fire `UpdateAnnotationOp({position: old},
  {position: new})`. World-space throughout (annotations are world-anchored). Gizmo size handling +
  `render:update → scene.forceRender` mirror `measure-tool.ts:141-143,373-383`. Detach the gizmo when
  nothing is selected or the tool deactivates.
- **Delete**: listen on `select.delete`; when the tool is active and an annotation is selected, fire
  `RemoveAnnotationOp` for it.
- **activate/deactivate**: add/remove canvas pointer listeners, show/hide the editor bar, attach/
  detach the gizmo, refresh from current selection. (No `transformHandler.push` coupling needed;
  annotations are not splat-relative.)

### New: `src/annotation-overlay.ts` (replaces `src/annotation-gizmos.ts`)

A persistent component constructed at editor/main setup with access to `events`, `scene`, and the
canvas container. Not tool-scoped.

- Builds an SVG layer (a `tool-svg`-style absolutely-positioned `<svg>`, `pointer-events:none`)
  appended to the canvas container, plus a hidden HTML **preview tooltip** element.
- On `postrender` (when `scene.camera.renderOverlays`): for each annotation, project world→screen
  (`scene.camera.worldToScreen`, ×client size, as `measure-tool.ts:109-114`) and position a numbered
  marker: an SVG `circle` (`fill:white; stroke:black; r:5`) plus a small `text`/badge showing the
  1-based index at the upper-left. The **selected** annotation's marker is highlighted (e.g. yellow
  fill). Markers hidden entirely when overlays are off.
- **Hover preview**: listen on `pointermove` over the canvas; hit-test projected marker positions
  (~8px). If a non-selected marker is hovered, show the preview tooltip near it; otherwise hide it.
  The selected annotation is never hover-previewed (its gizmo is active). The preview tooltip's DOM
  mirrors the viewer: a container styled like `.pc-annotation` with a bold title node
  (`.pc-annotation-title`), a body text node, and — if the annotation has a URL — an "Open link ↗"
  anchor styled like `.ss-annotation-link`. (Editor preview is non-interactive: it shows the link
  affordance but need not navigate.)
- Marker styling lives in a new SCSS partial (e.g. `src/ui/scss/annotation-overlay.scss`,
  `@use`d in `style.scss`), including a local copy of the `.pc-annotation` look for the preview.
- Listens on `annotations.changed` / `annotations.selectionChanged` / `camera`/`scene` changes to
  force re-render where needed (mirroring the `markDirty` wiring in `annotation-gizmos.ts:65-74`).

### Modified: `src/ui/bottom-toolbar.ts`

- Add an **Annotations** button next to `measure` (reuse `src/ui/svg/annotations.svg`), appended in
  the same separator group; `click → events.fire('tool.annotation')`; add an active-state line to the
  `tool.activated` handler (`bottom-toolbar.ts:188-201`); register a tooltip.

### Modified: `src/editor.ts`

- Extend the splat-delete guard at `editor.ts:536` so it also skips when
  `events.invoke('tool.active') === 'annotation'`.

### Removed

- `src/ui/annotations-panel.ts`, `src/ui/scss/annotations-panel.scss`, and the
  `@use 'annotations-panel.scss';` line in `src/ui/scss/style.scss`.
- The right-toolbar annotation additions in `src/ui/right-toolbar.ts` (import, button, append,
  tooltip, click handler, `annotationsPanel.visible` active-state listener).
- `src/annotation-gizmos.ts` (replaced by `annotation-overlay.ts`); update its construction site
  accordingly.
- The `annotationsPanel.*` events (`setVisible` / `toggleVisible` / `visible`) and the panel
  mutual-exclusion wiring.
- Construction/append of `AnnotationsPanel` in the UI editor (`src/ui/editor.ts:127,140`).

### i18n (`static/locales/*.json`)

- Keep labels used by the floating bar: title, text, url, new-tab.
- Remove panel-only strings (panel header, "add", "recapture", "delete", "untitled").
- Add a bottom-toolbar tooltip string for the Annotations button.

## Data flow (move example)

1. Tool active, user clicks near marker #2 → `annotations.select('annotation_1')`.
2. Overlay highlights marker #2; tool attaches `TranslateGizmo` at its world position; editor bar
   populates with that annotation's fields.
3. User drags the gizmo → live position update + `scene.forceRender`.
4. On release → `UpdateAnnotationOp({position: old}, {position: new})` (undoable). `annotations.changed`
   fires; overlay redraws the marker at the new spot.

## Edge cases & error handling

- Click on empty background (no raycast hit, no nearby marker) with tool active → no-op.
- `Delete`/`Backspace` with the Annotations tool active removes the selected annotation, not splats.
- Switching tools hides the editor bar and detaches the gizmo; markers remain (overlays on).
- Overlays off (`renderOverlays` false) → no markers, no hover previews.
- Many annotations: numeric badges are unbounded; markers may overlap when dense (acceptable; same
  limitation as Distance dots).
- Hover hit-test and click hit-test use the same ~8px projected-distance rule for consistency.

## Honest caveats

- The hover preview replicates `@playcanvas/splat-transform@2.5.1`'s viewer CSS. It is **visually
  representative, not pixel-locked**: a future viewer restyle could drift from the preview. The
  editor preview intentionally omits the viewer's fade animations, annotation nav bar, and
  side-aware arrow placement.
- Annotations remain **world-anchored** (they do not follow a splat's transform) — unchanged from
  today and out of scope here.

## Testing / verification posture

No test framework in this repo (only `npm run lint`), consistent with prior plans. Verification:

- `npm run lint` clean; `npm run build` succeeds (SCSS compiles).
- Manual browser verification:
  1. Bottom-toolbar Annotations button activates the tool and shows active state.
  2. Click on the splat places a numbered marker; the floating bar appears with Title/Text/URL/
     New-tab; edits persist and undo/redo.
  3. Click near a marker selects it; the TranslateGizmo appears and dragging moves it (undoable).
  4. `Delete` removes the selected annotation (does not delete splats).
  5. Hovering a non-selected marker shows a tooltip resembling the exported viewer; the selected one
     does not show a hover tooltip.
  6. Markers stay visible after switching to another tool (overlays on); disappear when overlays off.
  7. Save + reload → annotations persist. Export HTML/package/streaming → hotspots + links behave as
     before (unchanged path).

## Out of scope (YAGNI)

- Re-capturing an annotation's fly-to camera after placement (no Recapture button).
- A list/panel UI for annotations.
- Making annotations follow splat transforms.
- Forking or restyling the upstream `supersplat-viewer`.
- Pixel-perfect, upgrade-proof parity between the editor preview and the exported viewer.
