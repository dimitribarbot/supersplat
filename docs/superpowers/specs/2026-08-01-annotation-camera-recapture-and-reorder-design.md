# Annotation camera re-capture and reordering — design

Date: 2026-08-01
Status: approved (brainstorming), ready for implementation planning

## Goal

Make two properties of an annotation editable after it has been placed:

1. **Its saved camera view.** Today the camera pose (position, target, fov) is
   captured once, at placement, and can never be changed. A button on the
   annotation toolbar overwrites it with the editor camera's current view.
2. **Its position in the annotation order.** Today the order is placement order
   and cannot be changed. Two buttons move the selected annotation one slot
   earlier or later.

## Current behaviour (verified)

- `src/tools/annotation-tool.ts:276-293` — placement calls
  `events.invoke('camera.getPose')` and bakes `{position, target, fov}` into the
  new record. Nothing writes `camera` afterwards: the only `UpdateAnnotationOp`
  call sites are the toolbar's text/select fields, the move gizmo (`position`
  only, line 200) and the images dialog. Moving the marker with the gizmo leaves
  `camera` pointing at the original view.
- `src/annotations.ts:188-195` — `annotations.insertRaw` only `push`es. Its
  `index` argument exists solely so undoing a delete restores the original slot.
  There is no reorder event and no annotation list UI; the only annotation
  surfaces are the floating toolbar and the numbered SVG markers.
- Array order drives the badge numbers (`annotation-overlay.ts:85,102`), the
  order of `annotations.export`, and therefore the `index` of the exported
  viewer's iframe API (`viewer-companion/iframe-api.ts:34`).

## Scope

In scope:

- Editor: a "set view from camera" button and move earlier/later buttons on the
  annotation toolbar.
- One new low-level mutator and one new edit-history op in `src/annotations.ts`.
- Three tooltip strings in all 9 locales.
- Unit tests in `test/annotations.test.ts`.

Out of scope:

- A go-to-view / preview button that flies the editor camera to an annotation's
  stored pose.
- An annotations list panel, drag-and-drop reordering, a numeric order field,
  and keyboard shortcuts.
- Per-scene ordering. Order stays one global list, as it is today.
- Any change to the project format, the export payload or the iframe API — both
  `camera` and array order are already persisted and already exported.

## Decisions and rationale

| Decision | Rationale |
|---|---|
| Re-capture the current view rather than "reset to a computed default" | The author wants to *choose* the view, not just undo a bad one. Mirrors `CameraAnimTrack.addKey()` (`src/camera-poses.ts:62-86`), which overwrites an existing keyframe with the current pose. |
| No go-to-view companion button | YAGNI for this pass. Accepted cost: the editor never renders the stored pose, so the button has no visible effect — the only confirmation is the new undo-history entry. |
| A dedicated `annotations.moveRaw` rather than `removeRaw` + `insertRaw` | `removeRaw` clears the selection when the removed annotation is the selected one (`annotations.ts:200-204`), so reuse would close the toolbar on every click and fire `annotations.changed` twice per move. |
| Array position stays the order; no `order` field | Position already *is* the order and is already persisted in array order. An explicit field would need legacy-document migration and every consumer would have to sort. |
| Compact glyph buttons with `dom.title` tooltips | The bar is already wide (Title, Text, Link Type, URL, New Tab, Images, Scene) and floats over the canvas. Follows `portal-tool.ts:54-57`, so no new icon assets. |
| Move is an edit-history op | Every other annotation mutation (field edits, marker drags) is undoable; a reorder that is not would be the odd one out. |

## 1. Data layer (`src/annotations.ts`)

### Camera re-capture — no new plumbing

`annotations.updateRaw` is an `Object.assign`, so a patch of `{ camera: {...} }`
replaces the whole sub-object, and `UpdateAnnotationOp` already snapshots old
and new values for undo. `camera` is already written by
`docSerialize.annotations` and already read by `annotations.export`, so the new
value reaches `.ssproj`, every export path and the iframe API unchanged.

The op's `oldValues`/`newValues` must hold **copies** of the packed arrays, not
references to the live record's arrays, so the undo snapshot cannot be mutated
in place later.

### Reorder — one mutator, one op

```ts
events.on('annotations.moveRaw', (id: string, toIndex: number) => {
    const from = annotations.findIndex(a => a.id === id);
    if (from < 0) return;
    const to = Math.max(0, Math.min(annotations.length - 1, toIndex));
    if (to === from) return;
    const [a] = annotations.splice(from, 1);
    annotations.splice(to, 0, a);
    fireChanged();
});
```

Selection is deliberately untouched: nothing is removed, so the selected id
stays valid and the toolbar stays open.

```ts
class MoveAnnotationOp {
    name = 'moveAnnotation';
    // { events, id, fromIndex, toIndex }
    do()   { this.events.fire('annotations.moveRaw', this.id, this.toIndex); }
    undo() { this.events.fire('annotations.moveRaw', this.id, this.fromIndex); }
    destroy() { this.events = null; }
}
```

Exported alongside `AddAnnotationOp` / `RemoveAnnotationOp` /
`UpdateAnnotationOp`. A single-slot move is its own inverse, so
`fromIndex`/`toIndex` round-trip exactly.

Nothing else keys off array identity: the overlay re-reads `annotations.list`
every postrender, `annotations.export` maps in array order, `imageRefs` is
order-insensitive, and the images dialog is keyed by `id`.

## 2. UI (`src/tools/annotation-tool.ts`)

Three buttons appended to the existing `bar`, styled like the portal tool's
compact buttons (`class: 'select-toolbar-button'`, glyph text,
`button.dom.title = i18n.t(...)`):

| Button | Glyph | Action |
|---|---|---|
| Set view from camera | `⊙` | `events.invoke('camera.getPose')` → `UpdateAnnotationOp` on `camera` |
| Move earlier | `↑` | `MoveAnnotationOp(id, index, index - 1)` |
| Move later | `↓` | `MoveAnnotationOp(id, index, index + 1)` |

The glyphs are plain text, as in `portal-tool.ts` (`⤢`, `⧉`) — not emoji, which
render inconsistently across platforms and would sit oddly next to the existing
buttons.

Details:

- The camera button compares the current pose against the stored one
  component-wise and skips when identical. The generic `commit()` helper's
  `a[field] === value` test can never be true for an object, so routing the
  camera through it unchanged would push an empty undo entry on every click.
- `refreshBar()` sets `upButton.enabled = index > 0` and
  `downButton.enabled = index < annotations.length - 1`, so the ends are dead
  rather than silently no-op.
- All three use `pointerdown` + `stopPropagation` like the portal tool's
  buttons, so a press never falls through to the canvas and places a new
  annotation.
- No extra gating is needed: `bar` is visible only while the annotation tool is
  active *and* an annotation is selected.

Feedback: reordering is immediately visible because the overlay prints `i + 1`
and `annotations.changed` forces a redraw. Re-capturing the camera has no
visible effect in the viewport, by the design decision above.

## 3. Localization

Three tooltip-only keys, added next to the existing `panel.annotations.*` block
(`static/locales/en.json:61-72`) in all 9 locales (`de, en, es, fr, ja, ko,
pt-BR, ru, zh-CN`):

- `panel.annotations.set-view` — "Set View From Camera"
- `panel.annotations.move-earlier` — "Move Earlier"
- `panel.annotations.move-later` — "Move Later"

Title Case matches the surrounding block ("Open in New Tab", "Link Type"), and
the key names match the strings so neither has to be read against the other.

Non-English strings are machine-assisted and flagged for review, as with
previous batches.

## 4. Export and persistence impact

No format change, and no code change on any export path: `camera` and array
order are already serialized and already exported, so `.ssproj` save/load, HTML
and ZIP export, S3 publish and the export server pick up the new values as they
stand.

One consequence to be aware of: reordering shifts the `index` in the exported
viewer's iframe API (`buildAnnotationIndex`,
`src/viewer-companion/iframe-api.ts:34`). A host page that hard-codes
`{ index: 2 }` will address a different annotation after a reorder. The stable
`extras.id` is unaffected, so hosts that reference annotations by id are safe.
This is documented, not fixed.

## 5. Testing

Unit tests in `test/annotations.test.ts`, using the existing fake-`Events`
harness:

- `moveRaw` reorders the array.
- `moveRaw` clamps an out-of-range `toIndex` and no-ops when it equals the
  current index.
- `moveRaw` leaves the selection intact when the moved annotation is selected —
  the specific property that ruled out the `removeRaw` + `insertRaw` approach.
- `MoveAnnotationOp` do/undo restores the exact original order.
- The new order is reflected in `annotations.export` and
  `docSerialize.annotations`.
- An `UpdateAnnotationOp` on `camera` round-trips through undo and lands in
  `annotations.export`'s `camera.initial`.

The toolbar has no automated coverage (this repo has no DOM tests), so button
wiring is verified by manual E2E:

1. Place an annotation, move the camera, press the camera button, export, and
   confirm the viewer flies to the new view.
2. Reorder, and confirm the viewport badges renumber and the exported viewer's
   annotation order matches.
3. Undo/redo both operations.
4. Save and reload a `.ssproj` and confirm both survive the round-trip.
