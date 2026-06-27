# Portal infinite (extendable) boundaries — design

Date: 2026-06-27

## Goal

Let an author mark one or more edges of a portal quad as **infinite** (extending
to the edge of the scene). A crossing through the portal's plane then counts even
when the crossing point lies far past an infinite edge. This handles fly-mode
transitions in exterior scenes, where a finite portal rectangle cannot cover the
whole boundary between two scenes.

The portal's center, gizmo, and visible quad must **not** move or grow — only the
crossing test is relaxed. The author keeps a normal, finite, grabbable rectangle.

## Concept & crossing semantics

A portal is a finite rectangle in its **local frame**, the same frame the gizmo,
the `width`/`height` inputs, and the quad corners already use:

- local **+X = right**, **−X = left**
- local **+Y = top**, **−Y = bottom**
- local **Z** is the portal normal (front = +Z, back = −Z)

Today `segmentCrossesRect` (in `src/portal-geom.ts`) accepts a crossing only when
the camera segment pierces the infinite plane (`az * bz <= 0`) **and** the pierce
point `(ix, iy)` lands inside the rectangle:

```ts
if (Math.abs(ix) > hw || Math.abs(iy) > hh) return null;
```

The relaxation replaces that single combined test with four per-side tests, each
gated by whether that edge is infinite:

```ts
if (ix >  hw && !inf.right)  return null;
if (ix < -hw && !inf.left)   return null;
if (iy >  hh && !inf.top)    return null;
if (iy < -hh && !inf.bottom) return null;
```

Properties:

- **No edges infinite** → byte-identical behavior to today (back-compat).
- **All four infinite** → the portal acts as the full infinite splitting plane
  (the fly-mode-in-exterior case).
- The plane-crossing requirement (`az * bz > 0` early reject, plus the `t in
  [0,1]` test) is unchanged, so the gizmo / center / visible quad never move.

`inf` defaults to "no edges infinite" when the field is absent, so every existing
portal and every caller that does not set it keeps current behavior.

### Inherent subtlety (documented, not a blocker)

A portal is double-sided, so "right" is defined in the portal's **own local
frame**, not "the viewer's right." Viewed from the back side, local +X appears
mirrored. The in-scene edge icon (sitting on the actual edge) makes which edge is
extended unambiguous while authoring.

## Data model

New optional field, shared by every portal-shaped type:

```ts
infinite?: { top: boolean, right: boolean, bottom: boolean, left: boolean }
```

Optional / absent = no infinite edges (treated as all-false).

It threads through:

- `src/portals.ts` — `PortalData` type; `docSerialize.portals` /
  `docDeserialize.portals` (round-trip, default-safe on load); `portals.export`.
- `src/portal-geom.ts` — `PortalRect` type; consumed by `segmentCrossesRect`.
- `src/portal-export.ts` — `ExportPortal` type; `buildPortalBundle` copies
  `infinite` onto each rewritten portal in the exported bundle.
- Rect mapping in `src/portals-runtime.ts`, `src/portal-anim-timeline.ts`, and
  `src/viewer-companion/portals.ts` — each builds `PortalRect`s and must pass
  `infinite` through.

Because `viewer-companion/portals.ts` stringifies `segmentCrossesRect` verbatim
(`segmentCrossesRect.toString()`) and injects it into the exported viewer, the
editor and the exported viewer share **one** implementation of the relaxed test —
no second copy to keep in sync.

## Editor UI

In `src/tools/portal-tool.ts`:

### Toolbar button

A new button in the floating portal bar (an arrows-out glyph, e.g. ⛶, with a
localized tooltip), enabled only when a portal is selected. Clicking it toggles a
floating popup anchored to the button.

### Floating popup (cross layout)

Four toggle buttons arranged in a plus/cross layout — top, right, bottom, left —
so each toggle's on-screen position mirrors the edge it controls. Each toggle
carries a directional arrow glyph. The popup reflects the selected portal's
`infinite` state and closes on outside click.

Toggling an edge fires an undoable `UpdatePortalOp` that patches the portal's
`infinite` field (the same op used by `width`/`height`), so it participates in
undo/redo and triggers `portals.changed` → re-render of the edge icons.

### In-scene edge icons (selected portal only)

Reuse the existing entrypoint-dot pattern: an SVG overlay drawn on `postrender`,
never occluded. For the **selected** portal only, for each enabled edge:

- compute the edge-midpoint world position (e.g. right = local `(+hw, 0, 0)`
  rotated by the portal rotation + position) and a second point a small step
  further **outward** along the same local axis;
- project both with `scene.camera.worldToScreen`;
- draw an outward-pointing arrow glyph at the edge midpoint, oriented along the
  screen-space vector between the two projected points.

Icons appear/disappear immediately as edges are toggled (driven by
`portals.changed` / `portals.selectionChanged`, like the rest of the bar). When
no portal is selected, no edge icons are shown.

## Runtime (editor walkthrough + exported viewer)

No new runtime wiring. Both the in-editor walkthrough (`portals-runtime.ts`) and
the exported viewer (`viewer-companion/portals.ts`) already resolve scene swaps
through `resolveActiveSplat` → `segmentCrossesRect`. Once `infinite` rides on the
rects, both honor it automatically, including the baked animation timeline
(`portal-anim-timeline.ts`), which uses the same crossing helper.

## Localization

New keys in `static/locales/en.json` and the other 8 locale files
(`de`, `es`, `fr`, `ja`, `ko`, `pt-BR`, `ru`, `zh-CN`):

- toolbar button label / tooltip,
- the four direction labels (or tooltips): top, right, bottom, left.

## Testing (TDD)

- `test/portal-geom.test.ts`:
  - pierce past each edge triggers a crossing **only** when that edge is infinite;
  - the no-infinite case is unchanged (existing tests stay green);
  - all-four-infinite behaves as the full plane (a far-off crossing registers).
- `test/portals.test.ts`: `infinite` round-trips through `docSerialize` /
  `docDeserialize` and `portals.export`; an absent field defaults safely.
- `test/portal-export.test.ts`: `buildPortalBundle` carries `infinite` onto each
  rewritten portal.
- `test/portal-anim-timeline.test.ts`: a crossing past an infinite edge registers
  in the baked timeline.

## Out of scope

- No change to portal selection / hit-testing (the visible quad stays finite, so
  click-to-select is unaffected).
- No new export-bundle URLs or collision behavior.
- Exported viewer has no portal visuals, so edge icons are editor-only.
