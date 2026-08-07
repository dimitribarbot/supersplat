# Portal marker: click behaviour and plane alignment — design

**Date:** 2026-08-07
**Branch:** `portal-viewer-icon` (continues the unshipped feature; not yet squashed or merged)
**Supersedes parts of:** `docs/superpowers/specs/2026-08-06-portal-viewer-icon-design.md`

Two changes to the exported viewer's portal marker icon, both raised during the
E2E pass of the original feature.

1. **A click on an icon shows the tooltip and nothing else.** Today it also moves
   the camera, because the marker listeners are passive and the click still
   reaches the viewer's own click-to-move handler.
2. **The icon lies in the portal's plane** instead of turning to face the camera,
   and only the ellipse it actually projects to is clickable.

Nothing else about the marker changes: same look, same size, same occlusion
model, same suppression rules, same scope (ZIP package export, both the local
writer and the export-server path).

---

## Change 1 — a click on an icon opens the tooltip and nothing else

### Where the movement comes from

The bundled viewer decides "this click means navigate" in exactly two places,
one per input path. Both branch three ways on camera mode:

| mode | what a click does today |
| --- | --- |
| walk (gaming controls off) | picks collision → fires `navigateTo` — walks you there |
| fly | flies toward the picked point |
| orbit | re-targets the orbit centre on the picked point |

The marker's own listeners are registered `{ passive: true }` and never stop the
event — deliberately, so that an orbit-drag or click-to-walk gesture *starting*
on an icon is not swallowed. That is why the click both opens the tooltip and
moves you.

### Approaches considered

**A. Capture-phase `stopPropagation` from the companion.** Register `pointerup`
on `window` with `{ capture: true }` and stop the event when it lands on an
icon; no engine patch needed. **Rejected:** the camera controllers also listen
for `pointerup` on the canvas to end a drag and release pointer capture.
Swallowing it strands them mid-drag — the camera keeps orbiting after the button
is released.

**B. Reuse the viewer's own `_suppressClick` flag**, set at `pointerdown` from a
single patch in `_onPointerDown`. Tempting: the flag already gates both the
mouse path and the mobile-tap path, so one insert would cover everything.
**Rejected:** on touch, `mobileTap` only fires when the tap did not move. A
touch-down on an icon that then drags never consumes the flag, so it stays set
and swallows the *next* tap.

**C. Guard the two nav decision points. — chosen.** No stored state, so nothing
can go stale, and the guard is evaluated at click time against the very offsets
the viewer is about to pick with.

### Mechanics

Two new entries in `src/viewer-engine-patch.ts` (patch count 4 → 6), anchored on
the `_onPointerUp` and `_onMobileTap` navigation branches. Each inserts one line
ahead of the mode branches:

```js
if (window.__ssPortalMarkerAt && window.__ssPortalMarkerAt(this._lastPointerOffsetX, this._lastPointerOffsetY)) return;
```

One line per site covers walk, fly and orbit together, which is the decision
taken: **all three modes stop at the tooltip.** In orbit that means clicking an
icon no longer re-centres the orbit pivot — accepted, so the icon means the same
thing in every mode.

`src/viewer-companion/portal-markers.ts` publishes the global:

```js
window.__ssPortalMarkerAt = function (x, y) { return markerHitTest(markers, x, y) !== -1; };
```

`x`/`y` are canvas-relative CSS pixels. `_lastPointerOffsetX/Y` are
`event.offsetX/Y` — the same space the marker's existing `clientX - rect.left`
conversion produces.

Markers suppressed by `noui`, `anim` playback or a running transition cover are
already `visible: false` / `onScreen: false`, so they cannot be hit and the guard
is inert in those states. Nothing extra is needed for that.

### Anchor uniqueness

Both anchors were verified to occur **exactly once** in the real splat-transform
3.1.7 baked viewer. The naive single-line anchor
`if (state.cameraMode === 'walk' && !state.gamingControls) {` occurs **twice** —
once per site — so each patch must carry enough surrounding context to
disambiguate:

- `_onPointerUp`: preceded by `if (this._mouseClickDelta < TAP_EPSILON) {` (12-space indent).
- `_onMobileTap`: preceded by the `_suppressClick` early-return block (8-space indent).

Verification is by hand against the escape-encoded bundle, as for the existing
patches; the unit test asserts against synthetic snippets of those exact byte
shapes.

### Failure mode

Unchanged from the existing patches, and soft at both ends. A patch that no
longer matches is a non-fatal `console.warn` and today's behaviour; a missing
`window.__ssPortalMarkerAt` short-circuits the `&&`.

### Deliberately not covered

- **Double-click on an icon.** `_onInputEvent('dblclick')` swaps camera mode and
  navigates. It is a distinct, deliberate gesture and is left alone.
- **Drag starting on an icon.** Still orbits / pans normally. The guard sits only
  on the click branch, so the property the original design fought for is kept.
- **Pointer lock.** With gaming controls on, no click reaches anything anyway,
  and the viewer already excludes that case from click-to-move.

### Threshold coherence

The marker opens its tooltip when the straight-line distance from `pointerdown`
to `pointerup` is under 5px; the viewer treats a click as a click when
*accumulated* pointer movement stays under `TAP_EPSILON = 15`. Now that the two
are coupled, a 5–15px wobble on an icon would suppress the movement *and* open no
tooltip — a dead zone where nothing at all happens.

The marker's own threshold is therefore raised from **5px to 15px**, still
measured as straight-line displacement. The two metrics stay different in kind
(displacement vs. accumulated path, and accumulated path is never smaller), so
this does not make them identical — it makes the marker at least as forgiving as
the viewer, which is what closes the dead zone. Where they still differ, a
slow curved drag ending near its origin now opens a tooltip on a click the
viewer would have rejected; that is harmless, since no movement happens either
way.

---

## Change 2 — the icon lies in the portal's plane

### Orientation

The exported portal payload already carries `rotation` (`portal-export.ts:82`),
so this is mostly deletion. `markerMakeOne` sets the orientation **once**:

```js
entity.setRotation(portalQuat);
entity.rotateLocal(90, 0, 0);
```

and `markerUpdate` drops its per-frame `setRotation`, `rotateLocal` and
`markerCamera.getRotation()`. The result is strictly less per-frame work than
billboarding.

The 90° step is unchanged in meaning: `PlaneGeometry` lies in XZ with a +Y
normal, and +90° about X sends +Y to +Z — the portal's normal axis under the
same convention `portal-export.ts:158` uses (`n = rotateByQuat(rotation, [0,0,1])`).

`Quat` joins the `window.__ssPc` publish list in the existing engine patch. Its
`applied` marker (`window.__ssPc = {`) still holds, so idempotency is unaffected.

### Grazing angles

Accepted as-is: the icon foreshortens and disappears when viewed along the
portal plane, the way a sign painted on a door does. No fade, no fallback, no
angle threshold. It is visible when you are facing the doorway, which is when it
is useful.

### Hit test — an ellipse, not a circle

A plane-aligned disc projects to an **ellipse**. Foreshortening compresses one
axis only, so a door seen at a steep angle still draws a full-width icon.
Shrinking a circular hit radius by the view angle would therefore make the
icon's own left and right extremes unclickable. Only the projected ellipse is
clickable.

The quad's two in-plane half-axes are the entity's `right` and `forward` vectors
scaled by the half-extent (`0.5 × scale`, which is `MARKER_SIZE / 2` in pixels —
`PlaneGeometry` is 1×1 and `markerScale` sizes the full quad to `MARKER_SIZE`).
Their signs are irrelevant: any pair of conjugate half-axes describes the same
ellipse.

`markerUpdate` projects three points per visible marker instead of one — the
centre `C`, and `C ± halfExtent·right` and `C ± halfExtent·forward` — and stores
the two screen-space vectors `u = A - C`, `v = B - C`. The test undoes that 2×2
map and checks the unit disc:

```
d   = (x - sx, y - sy)
det = ux*vy - uy*vx
k1  = ( vy*dx - vx*dy) / det
k2  = (-uy*dx + ux*dy) / det
hit = k1*k1 + k2*k2 <= 1
```

This is exact rather than approximate, and three properties drop out of the
geometry rather than needing code:

- **Edge-on collapses `det` to zero**, so an invisible icon is unclickable with
  no angle threshold to tune. A `|det| < 1e-6` guard is only there to keep the
  division from producing `NaN`.
- **A tilted doorway gives a rotated ellipse**, which a circle never handled at
  any angle.
- **`k1² + k2²` is the nearest-centre tie-break** for overlapping icons, so that
  existing behaviour is preserved for free.

`markerHitTest` changes shape accordingly: each marker carries
`{ sx, sy, ux, uy, vx, vy, onScreen }` and the shared `radius` parameter goes
away. It stays a pure, self-contained function in `src/portal-marker.ts` — it is
stringified into the runtime via `Function.prototype.toString()`, so it must not
reference module scope. No second helper is introduced.

Cost is two extra `worldToScreen` calls per visible marker per frame (three
instead of one), reusing scratch vectors so the per-frame path stays
allocation-free. Only the active scene's portals are ever touched.

### Back face

`cull` is already `CULLFACE_NONE`, so from the far side of a portal the icon
draws mirrored — for this glyph that only moves the door's knob dot to the other
side. Accepted and documented rather than fixed; flipping it would reintroduce a
camera-dependent orientation, which is what this change removes.

---

## Testing

**Unit — updated.** `markerHitTest` moves to the elliptical form: facing-on
behaves like the old circle; a foreshortened marker accepts points along its
major axis and rejects the equivalent distance along its minor axis; a
degenerate (`det ≈ 0`) marker is never hit; overlapping markers still resolve
nearest-centre-first. `markerHitRadius` is **not** added — the ellipse subsumes
it.

**Unit — updated.** `viewer-engine-patch.test.ts`: count 4 → 6, with synthetic
snippets for the two new anchors, both new guards asserted present, and the
existing idempotency / partial-bundle / unknown-source cases extended to cover
them.

**Gates.** `npm run test`, `npm run lint`, `npm run build` with a zero
`plugin typescript` count (the build's exit code is not a type gate in this
repo), and `node scripts/build-shared.mjs`.

**E2E.** The existing 22-item checklist in
`docs/superpowers/2026-08-06-portal-viewer-icon-handoff.md` needs revising, not
just re-running — items 9 and 10 change meaning:

- Click-to-walk aimed at a doorway icon must now **not** move you; it opens the
  tooltip only. Item 10's old expectation is inverted.
- Item 9 is unchanged and still critical: a drag *starting* on an icon must still
  orbit.

New items to add: tooltip-only on click in each of walk, fly and orbit (orbit
must not re-centre); the icon visibly lies in the doorway plane; a near-edge-on
icon is neither visible nor clickable; clicking beside a steeply-angled icon
moves you normally rather than being eaten.

---

## Out of scope

The editor is untouched. No `static/locales/*.json` changes — the tooltip string
is viewer-side. The two items still outstanding from the original feature are
unaffected and remain outstanding: locale sign-off on the eight non-English
`MARKER_TOOLTIPS` strings, and the squash-and-merge of the whole branch.
