# Off-limits zones — infinite (extendable) bounds

**Date:** 2026-06-27
**Status:** Approved (design)
**Reference feature:** Portals "infinite boundaries" — commit `17022aa`

## Goal

Give off-limits zones the same per-edge "extend to infinity" capability portals
already have. Each zone gains an optional set of four edge flags
(`top` / `right` / `bottom` / `left`). When an edge is flagged, the blocking wall
extends past that edge to the scene boundary, so the player cannot walk around it.

The editor exposes this through the off-limits-zone toolbar: an "extends" button
(`⤢`) opens a plus-shaped popup with four directional toggles, and a red arrow is
drawn in the 3D scene at the midpoint of every infinite edge. Infinite edges are
persisted in the document and baked into the exported / published viewer.

This mirrors the portal feature 1:1, with two deliberate differences:
- Arrows are **red** (matching the red zone) rather than cyan.
- Zones have **no editor-side walkthrough collision** (collision only runs in the
  exported viewer), so there is no runtime preview module to change — one fewer
  surface than portals had.

## Background — why this maps cleanly

Off-limits zones and portals are structurally twins: both are 2D quads
(`width × height`) centered at `position` and oriented by a unit quaternion
`rotation`. The portal crossing test (`segmentCrossesRect`, `portal-geom.ts`) was
itself adapted from the zone collision test (`segmentBlockedByWall`,
`viewer-companion/off-limits-collision.ts`) — they share the identical
local-frame transform and the same final bounds check. The only behavioral change
this feature needs is to relax that bounds check per-edge, exactly as portals
already do.

**Semantic note.** For a portal, an infinite edge relaxes *swap* detection. For a
zone, an infinite edge means the *blocking wall extends to infinity* past that
edge. Both are the same geometric relaxation (skip the out-of-bounds rejection on
a flagged edge); the meaning differs only in what the crossing triggers.

**Message placement is unaffected.** The viewer's "off limits" message is a fixed
DOM overlay (`.ss-offlimits-message { position: fixed; left: 50%; bottom: 12% }`)
pinned to the viewport, flashed whenever *any* wall blocks the camera. It is never
anchored to a wall in 3D, so infinite edges — no matter how far they extend — do
not move it off-screen.

## Components & changes

### 1. Data model — `src/off-limits-zones.ts`

- `import type { InfiniteEdges } from './portal-geom'` (type-only; `InfiniteEdges`
  is already exported there. Type-only import = zero runtime coupling).
- Add `infinite?: InfiniteEdges` to both `ZoneData` and `ZoneExport` (optional →
  old documents without the field stay valid; `undefined` = no infinite edges).
- Thread `infinite: z.infinite` through the three emitters:
  - `offLimitsZones.export` (line ~204) — feeds the export/publish payloads.
  - `docSerialize.offLimitsZones` (line ~215) — `.ssproj` save.
  - `docDeserialize.offLimitsZones` (line ~225) — `.ssproj` load (copy
    `infinite: d.infinite` straight through; absent stays `undefined`).
- **No new undo op.** `UpdateZoneOp` already takes
  `Partial<Omit<ZoneData,'id'>>` and fires `offLimitsZones.updateRaw`, so an edge
  toggle is a normal undoable `UpdateZoneOp({ infinite })`. Confirm
  `updateRaw` shallow-assigns the patch (it does — `Object.assign`-style merge).

### 2. Tool UI — `src/tools/off-limits-zone-tool.ts`

Copy the portal-tool patterns verbatim, renaming `portal*` → zone equivalents.

**Bounds button** (after the rotate button, ~line 46):
```ts
const boundsButton = new Button({ text: '⤢', class: 'select-toolbar-button' });
boundsButton.dom.title = localize('offLimitsZones.bounds.tooltip');
// ...append to bar after rotateButton
```

**Plus-shaped popup** (mirror `portal-tool.ts:89-151`):
- `Container({ class: 'off-limits-bounds-popup', hidden: true })`, `pointerdown`
  stops propagation, appended to `canvasContainer`.
- Four toggle buttons keyed by `EDGE_DIRS = ['top','right','bottom','left']`,
  glyphs `{ top:'↑', right:'→', bottom:'↓', left:'←' }`, classes
  `['off-limits-bounds-toggle', 'off-limits-bounds-${dir}']`, title
  `localize('offLimitsZones.bounds.${dir}')`.
- Helpers `emptyEdges()`, `edgesOf(z)`, `refreshBoundsPopup()`,
  `positionBoundsPopup()`, `toggleBoundsPopup()` — identical logic to portals;
  `boundsButton.enabled = !!selectedZone`, popup hidden when nothing selected.
- Each toggle fires
  `events.fire('edit.add', new UpdateZoneOp(events, z.id, { infinite: z.infinite }, { infinite: newEdges }))`
  where `newEdges = { ...edgesOf(z), [dir]: !edgesOf(z)[dir] }`.
- The popup must refresh whenever the selection or zone data changes (hook into
  the existing `offLimitsZones.changed` / `offLimitsZones.selectionChanged`
  listeners, alongside `syncShapes`).

**In-scene red arrow overlay** (mirror `portal-tool.ts:480-562`):
- A `pointer-events:none` `<svg>` created with the SVG namespace, positioned
  `absolute / inset:0 / 100%×100%`, **prepended** to `canvasContainer.dom` (sits
  above `#canvas`, below editor chrome).
- `EDGE_MIDS` unit midpoints `{ top:(0,.5), right:(.5,0), bottom:(0,-.5),
  left:(-.5,0) }`. For the selected zone, for each flagged edge: compute the
  world midpoint and a point stepped outward (`1.6×` half-extent) along the edge
  axis using the zone's quaternion + position, project both via
  `scene.camera.worldToScreen`, draw a `➜` `<text>` glyph at the midpoint rotated
  by `atan2(dy,dx)` to point outward. Hide the glyph when either projection is
  behind the camera.
- **Red styling:** `fill = '#ff3333'`, `stroke = '#7a0000'`, `stroke-width 0.5`,
  `text-anchor middle`, `dominant-baseline central`. Size via
  **`t.style.fontSize = '24px'`** (inline), NOT the SVG `font-size` attribute —
  the global `* { font-size: 12px }` rule overrides the presentation attribute.
- Pool the `<text>` elements (grow/shrink to the count of flagged edges) and
  redraw on the existing `postrender` event. Reuse scratch `Vec3`/`Quat`
  objects (no per-frame allocation), matching the portal implementation.
- Requires the tool to track an `active` boolean (set on activate/deactivate). If
  the zone tool does not already have one, add it alongside the existing
  `bar.hidden` toggling.
- Clean up on dispose: remove the `postrender` listener and the SVG element.

### 3. Collision — `src/viewer-companion/off-limits-collision.ts`

- Add `infinite?: { top: boolean, right: boolean, bottom: boolean, left: boolean }`
  to the `Wall` type. (Keep it inline rather than importing `InfiniteEdges`: this
  file is injected verbatim via `Function.prototype.toString()` and must stay
  self-contained with no module references in its *runtime* body — a type-only
  import is erased at compile and is acceptable, but inlining keeps the file's
  "no outer references" contract obvious.)
- Replace the single bounds check (lines 60-62):
  ```ts
  if (Math.abs(ix) > hw || Math.abs(iy) > hh) {
      return null;
  }
  ```
  with the per-edge form (identical shape to `portal-geom.ts:59-63`):
  ```ts
  const inf = wall.infinite;
  if (ix >  hw && !(inf && inf.right))  return null;
  if (ix < -hw && !(inf && inf.left))   return null;
  if (iy >  hh && !(inf && inf.top))    return null;
  if (iy < -hh && !(inf && inf.bottom)) return null;
  ```
  With no flags this is behaviorally identical to the original test (backward
  compatible). `inf` reads off the plain payload object, so no import is needed at
  runtime.

### 4. Type threading

- `src/viewer-companion/off-limits-zones.ts` — add `infinite?` to the `ZoneLike`
  type so the payload carries it (the companion already serializes whole zone
  objects into `window.__supersplatOffLimitsZones`, so the value flows through
  once the type allows it).
- `src/splat-serialize.ts:127` — add `infinite?: { top: boolean, right: boolean,
  bottom: boolean, left: boolean }` to the `offLimitsZones` array element type
  (mirrors the portal entry on the adjacent line).

### 5. Export / publish — no changes

`export-popup.ts`, `publish-settings-dialog.ts`, and `s3-publish-dialog.ts` all
build their payload from `events.invoke('offLimitsZones.export')`. Once `export`
emits `infinite` (step 1), these three inherit it automatically. **Do not edit
them.**

### 6. Localization — 9 locale files

Add keys mirroring `portals.bounds.*`, under the `offLimitsZones.*` namespace, to
`en, de, es, fr, ja, ko, pt-BR, ru, zh-CN`:
- `offLimitsZones.bounds` — "Bounds" (label, for consistency; may be unused if the
  button is glyph-only — include it to match the portal key set).
- `offLimitsZones.bounds.tooltip` — "Extend zone edges to the scene boundary".
- `offLimitsZones.bounds.top` / `.right` / `.bottom` / `.left` — "Top" / "Right" /
  "Bottom" / "Left".

Translate using the existing `portals.bounds.*` values in each locale as the
reference (same wording, "zone" instead of "portal").

### 7. Styling — `src/ui/scss/off-limits-bounds-popup.scss`

Copy `portal-bounds-popup.scss`, renaming the classes
`portal-bounds-*` → `off-limits-bounds-*` (3×3 grid, 36px cells, `↑→↓←` toggles,
`.active` → `$clr-hilight`). Register it in `src/ui/scss/style.scss` next to the
`@use 'portal-bounds-popup.scss';` line. A separate stylesheet (rather than
reusing the portal classes) keeps the two subsystems independent.

### 8. Tests

- `test/off-limits-collision.test.ts` — add per-edge infinite cases mirroring the
  portal geometry tests: a segment crossing past an un-flagged edge is **not**
  blocked; the same segment **is** blocked once that edge is flagged `infinite`;
  no-flags behavior unchanged.
- `test/off-limits-zones.test.ts` — `infinite` round-trips through
  `offLimitsZones.export`, `docSerialize`, and `docDeserialize` (and is `undefined`
  when never set).

## Out of scope / explicitly not touched

- No editor-side walkthrough collision exists for zones, so there is **no
  `*-runtime.ts`** to change (portals had one; zones do not).
- No change to `off-limits-zone-shape.ts` — arrows live in the tool's SVG overlay,
  not the zone mesh.
- No change to the export/publish dialogs (they inherit `infinite` via `export`).
- No shared-helper extraction — patterns are copied into the zone files, matching
  the existing fork convention where portals and zones are parallel-but-independent
  siblings.

## Touch list

| File | Change |
|------|--------|
| `src/off-limits-zones.ts` | `infinite?` on `ZoneData`/`ZoneExport`; thread through export + (de)serialize |
| `src/tools/off-limits-zone-tool.ts` | bounds button + popup + red arrow overlay + `active` flag |
| `src/viewer-companion/off-limits-collision.ts` | `Wall.infinite`; per-edge bounds relaxation |
| `src/viewer-companion/off-limits-zones.ts` | `infinite?` on `ZoneLike` |
| `src/splat-serialize.ts` | `infinite?` on the `offLimitsZones` element type |
| `src/ui/scss/off-limits-bounds-popup.scss` | new popup stylesheet (copy of portal popup) |
| `src/ui/scss/style.scss` | `@use 'off-limits-bounds-popup.scss';` |
| `static/locales/*.json` (9) | `offLimitsZones.bounds*` keys |
| `test/off-limits-collision.test.ts` | per-edge infinite crossing tests |
| `test/off-limits-zones.test.ts` | serialize/export round-trip tests |
