# Annotation ↔ scene association — design

Date: 2026-07-25
Status: approved (design), not yet implemented

## Problem

Annotations are authored globally: `AnnotationData` (`src/annotations.ts`) carries a position, title,
text, link and camera pose, but no reference to *which splat/scene it belongs to*. In a single-scene
export that is fine. In a **portal** export it is not:

- The exported viewer renders an annotation navigator (`#annotationNav`, prev/next chevrons) that
  cycles through every annotation and flies the camera to each one's stored pose.
- Portal scenes deliberately **overlap in space** (floors, rooms, the same building interior/exterior).
  Flying to an annotation that lives in another scene leaves the *wrong* scene visible — the camera
  arrives at the right coordinates showing the wrong geometry.
- Free-nav crossing detection cannot rescue this: the annotation fly-to is a teleport, it does not
  pass through a portal rectangle, so `segmentCrossesRect` never fires.

The camera-animation path already solved the equivalent problem: `src/portal-anim-timeline.ts` bakes a
`{t, scene}` timeline at export time and the companion dispatches the active scene per frame. This
design does the same for annotations, keyed on navigation instead of cursor time.

## Scope

In scope:

- A per-annotation scene association in the editor (auto-assigned at placement, overridable via a
  dropdown), persisted in `.ssproj`.
- Baking the association into the exported viewer settings as a **scene index**.
- Switching the active scene in the exported viewer when an annotation is activated (nav arrows *or*
  hotspot click).
Explicitly **not** in scope (reversed during E2E — see the decision table):

- Hiding annotation hotspots that belong to a non-active scene.

Out of scope, deliberately:

- The **editor** annotation overlay (`src/annotation-overlay.ts`) keeps drawing every marker
  regardless of splat visibility. In the editor you author across scenes on purpose, and the overlay
  currently has no splat-visibility awareness at all — that would be a separate change with its own
  scope.
- Backfilling a scene onto annotations authored before this feature (no nearest-bounds guessing —
  overlapping floors make it unreliable). They stay unset and behave exactly as today.
- Any change to the annotation **link** companion (`src/viewer-companion/annotation-links.ts`).
- The PlayCanvas-publish path (`src/ui/publish-settings-dialog.ts`) gains nothing: it has no portals.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| How does an annotation get its scene? | **Auto-assign the raycast-hit splat at placement**; dropdown is an override | `scene.camera.intersect()` already returns `result.splat`, so the normal workflow (place an annotation on the scene you are looking at) is correct by default and costs nothing. |
| Store a scene index or a splat reference? | **Splat reference** (`sceneUid`) | Scene *indices* do not exist until export: `buildPortalBundle` derives them from the portal graph (start first, then first-seen order). An index stored in the editor would silently rot whenever portals change. |
| Unset scene, or a splat no portal references? | **No switch** — fly the camera, stay in the current scene | Both collapse to "no index" at export. Doing nothing is non-destructive: pre-existing annotations and single-scene exports behave exactly as today. Switching to the start scene would actively yank the viewer out of the scene it is in. |
| Hotspots of non-active scenes? | **Visible and clickable** (revised 2026-07-30) | Originally "hidden", implemented in `8b27f1a` and **reverted** after E2E. The mechanism was unsound: `.pc-annotation-hotspot` is an invisible (`opacity: 0`) DOM *hit-target*; the visible marker is a 3D mesh (`base`/`overlay` render entities). Hiding the class therefore left the marker on screen but made it unclickable — the worst of both. Hiding it properly would mean disabling the annotation entity, but the user chose cross-scene clickability instead: a marker from another scene stays visible, and clicking it switches scene via the same `annotation.activate` path as the nav arrows. Accepted cost: overlapping floors show each other's markers. |
| When is the Scene dropdown shown? | **Only when ≥1 portal exists** | The field is meaningless without portals. `sceneUid` is still recorded at placement in all cases, so associations pre-exist and the pre-filled dropdown simply appears if portals are added later. |
| Which viewer event drives the switch? | **`annotation.activate`** | The arrows go `annotation.navigate` → `showTooltip()` → script `'show'` → `annotation.activate`; hotspot clicks land on the same event. One listener covers both paths. |
| Transport into the viewer? | **`extras.scene`** in the exported annotation | The viewer does `this.annotations = global.settings.annotations` and hands the raw object to `annotation.activate`, so `extras` arrives verbatim — the channel `extras.url` / `extras.newTab` already uses. |

## Data model

`AnnotationData` (`src/annotations.ts`) gains one field:

```ts
sceneUid: number | null    // editor splat uid, or null when unassociated
```

`AnnotationExport` gains an optional `extras.scene?: number` (export scene index, omitted when unresolved).

The on-disk record additionally carries `sceneIndex: number | null` — a document splat index — exactly
mirroring the `PortalDocData.frontIndex` / `backIndex` scheme, because uids are session-scoped and are
**not** stable across loads.

## Editor

**Placement** (`src/tools/annotation-tool.ts`, `pointerup`): the new `AnnotationData` is built with
`sceneUid: result.splat.uid` from the existing `await scene.camera.intersect(nx, ny)`. No extra edit
op — it rides inside the existing `AddAnnotationOp`.

**Editing**: a `Scene` row in the floating annotation bar — a `SelectInput({ type: 'number' })` whose
options are `{ v: splat.uid, t: '<uid>: <name>' }` over
`scene.getElementsByType(ElementType.splat)`, plus a "None" entry. This is the same construction
`src/tools/portal-tool.ts` uses for its front/back/start selects, including the `splatName()` helper
shape. As in `portal-tool.ts`, the options list is rebuilt inside `refreshBar()` rather than tracked
incrementally — `refreshBar()` already runs on `annotations.changed`, `annotations.selectionChanged`
and `activate()`.

The row is hidden unless `events.invoke('portals.count') > 0`, evaluated in the same `refreshBar()`.
The annotation tool additionally listens to `portals.changed` so the row appears/disappears when a
portal is added or removed while the annotation tool is active.

Commit path is the existing generic one:

```ts
commit('sceneUid', value)   // -> UpdateAnnotationOp
```

`commit()`'s `value` parameter widens from `string | boolean` to `string | boolean | number | null`.
Undo/redo therefore needs no new code.

**Dangling references**: if the referenced splat is deleted, the select reconciles its authoritative
value against the current options and falls back to "None" — the same reconciliation `portal-tool.ts`
performs for its entrypoint select. Export treats it as unset.

## Document serialization

- `docSerialize.annotations` takes the `uidToIndex` map `src/doc.ts` already builds (`doc.ts:196`) and
  writes `sceneIndex` alongside `sceneUid`. It always writes a value — `null`, never `undefined` — so
  the field survives `JSON.stringify` and marks the record as new-format.
- `docDeserialize.annotations` takes a `{ indexToUid: number[] }` remap. `indexToUid` is available at
  the call site (`doc.ts:136`) as `loadedSplats.map(s => s.uid)`, already computed for the portal
  deserialize on the following line.
- **Index is authoritative when present**; a legacy document without `sceneIndex` keeps the raw-uid
  behaviour verbatim (and, having never written one, resolves to `null`).

## Export mapping (uid → scene index)

`annotations.export` gains an optional argument:

```ts
events.invoke('annotations.export', bundle?.sceneUids)
```

When `sceneUids` is supplied and `a.sceneUid` resolves to an index ≥ 0, the exported annotation gets
`extras.scene = <index>`; otherwise the field is omitted.

The lookup itself lives in `src/portal-export.ts` as a small pure function next to `buildPortalBundle`,
so it is unit-testable without playcanvas.

Call sites:

| Call site | Passes | Result |
| --- | --- | --- |
| `src/ui/export-popup.ts:800` | `bundle?.sceneUids` (`bundle` in scope from line 789) | indices baked |
| `src/ui/s3-publish-dialog.ts:249` | `bundle?.sceneUids` (from line 239) | indices baked |
| `src/ui/publish-settings-dialog.ts:386` | nothing | no `extras.scene` — correct, no portals on that path |

## Exported-viewer runtime

In `src/viewer-companion/portals.ts`, inside `start()`, alongside the existing `firstFrame`,
`inputEvent`/`reset` and `cameraMode:changed` handlers:

```
ev.on('annotation.activate', function (ann) {
  // read ann.extras.scene; if a number and !== activeIndex:
  //   dispatch({ type: 'crossing', target: idx,
  //              loaded: !!(entities[idx] || sceneLoading[idx]),
  //              ready: sceneReady(idx) })
  //   lastSafe = null
})
```

This is the reset handler's shape, for the same reason: the camera **teleports**, so free-nav crossing
detection cannot see the move, and `lastSafe` must be cleared so the discontinuity is not read as a
spurious crossing on the next frame. Routing through `dispatch` (rather than setting `activeIndex`)
also means a not-yet-resident target reuses the existing blocked/loading overlay unchanged — no new
runtime state.

**Known behaviour**: the scene swaps immediately while the camera transition plays, so mid-flight you
briefly see the destination scene from the source scene's vantage point. This matches reset. Deferring
the swap to transition-end is worse — it would fly *through* the old scene's geometry to a pose that
belongs to the new one.

**During camera-animation playback** the switch also sticks, and no special handling is needed. The
concern was that the per-frame timeline dispatch would re-assert the animation cursor's scene and
instantly undo the switch, since it runs every frame. It cannot: that branch is gated on
`cameraMode === 'anim'`, and the viewer's own `annotation.activate` handler sets
`state.cameraMode = 'orbit'` before the next frame. Leaving anim mode on activation is pre-existing
viewer behaviour. E2E-confirmed 2026-07-30: activating an annotation mid-animation leaves the viewer
in the annotation's scene, flying to its pose, exactly as when paused.

## Hotspot filtering — attempted, reverted

Hotspots are **not** filtered by scene. Every annotation's marker is visible in every scene, and
clicking one activates it, which switches to its scene through the normal `annotation.activate`
path. This is the viewer's pre-existing behaviour, plus the scene switch.

An earlier implementation (`8b27f1a`, reverted 2026-07-30) added
`.ss-annotation-offscene { display: none !important }` to the Nth `.pc-annotation-hotspot` when
`annotationScenes[N]` differed from the active scene, re-applied from `applyActive()` and via a
`MutationObserver` for late-created hotspots. It did not work, for a reason no unit test could see:

> `.pc-annotation-hotspot` is not the marker. The viewer builds it as an invisible
> (`opacity: 0`, `cursor: pointer`) DOM **hit-target**; the marker you actually see is 3D — the
> `base` and `overlay` child entities carrying `MeshInstance`s on the annotation render layers.

Hiding the hit-target therefore left the marker floating on screen while silently killing its click
handler. The `!important` reasoning (beating the viewer's inline `hotspotDom.style.display`) was
correct but aimed at the wrong element. A working hide would have to disable the annotation entity
itself.

That was not pursued: cross-scene clickability was preferred over hiding. The accepted cost is that
overlapping floors show each other's markers.

The `annotationScenes` payload table existed solely for this filter and went with it — the surviving
scene-switch listener reads `extras.scene` off the raw annotation the viewer hands it. The link
companion was never involved.

## Testing

**Unit** (`test/`, vitest — extends the `test/portals.test.ts` style): the pure uid→index resolver in
`portal-export.ts`.

- start splat → `0`
- non-start referenced splat → its bundle index
- `sceneUid: null` → omitted
- splat referenced by no portal → omitted
- deleted / dangling uid → omitted

**E2E** — the companion body is a template-literal string and is not unit-testable. Must be run on a
**release** build (minification of stringified helpers has caused regressions here before).

- nav arrows cycling across scenes swap the active scene
- a target scene that is not resident shows the loading overlay and completes
- an off-scene marker is visible and clicking it switches to its scene
- annotations with no scene do not switch
- single-scene export unchanged; PlayCanvas publish unchanged
- S3 publish carries `extras.scene`

**Authoring constraints** for the companion string (both previously bit this file): no backslash
escapes in the template (they are eaten at build time), and no backticks inside comments.

## Files touched

- `src/annotations.ts` — `sceneUid` field, export shape, doc serialize/deserialize remap
- `src/tools/annotation-tool.ts` — auto-assign at placement, Scene select, portal-gated visibility
- `src/doc.ts` — pass `uidToIndex` / `{ indexToUid }` to the annotation (de)serializers
- `src/portal-export.ts` — pure uid→scene-index resolver
- `src/ui/export-popup.ts`, `src/ui/s3-publish-dialog.ts` — pass `bundle?.sceneUids`
- `src/viewer-companion/portals.ts` — `annotation.activate` dispatch
- `static/locales/*.json` — the `Scene` label for the annotation bar
- `test/` — unit tests for the resolver
