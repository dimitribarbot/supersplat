# Portal marker interaction refinements — design

**Date:** 2026-08-07
**Branch:** `portal-viewer-icon`
**Follows:** `docs/superpowers/specs/2026-08-07-portal-marker-click-and-orientation-design.md`
**Origin:** E2E pass on `docs/superpowers/2026-08-06-portal-viewer-icon-handoff.md` — all 32 items
verified, three refinements requested.

## Problem

The E2E pass surfaced three gaps between what the marker does and what the
hand-off memo says it does.

1. **A tap with gaming controls on both opens the tooltip and jumps.** The memo
   documents item 13 as "visible but not clickable" under pointer lock. It is
   not. In walk mode with gaming controls on, a mobile tap raises the viewer's
   `_tapJump` inside the touch input source (`MultiTouchSource` consumer, not
   `NavInteraction`), so it reaches neither of the two engine guards this
   branch installed — while the companion's own canvas `pointerup` listener
   still opens the tooltip. Both happen at once.

   The desktop half of the same state is worse in a quieter way: under pointer
   lock `clientX`/`clientY` are frozen at the lock position, so a click can open
   a tooltip for whatever icon happens to sit under that stale point, and a
   `pointermove` under lock latches the hover tint there permanently.

2. **The nav hover ring does not hide over an icon.** The viewer's annotations
   hide it for free: their hotspot is a DOM div over the canvas, so moving onto
   one makes the canvas fire `pointerleave`, and `NavCursor.onPointerLeave`
   hides the ring. Portal markers deliberately have no DOM hit-target (a per-
   marker div swallowed the orbit-drag and click-to-walk gestures that start on
   a doorway), so the canvas keeps receiving `pointermove` and the ring keeps
   tracking.

   The ring is also the only available cue for a known limitation: an icon fully
   hidden behind a wall still eats the click. With the ring hidden over icons,
   "ring gone" reads as "this click opens a tooltip, it will not move you".

3. **Re-clicking an open tooltip does not close it.** Only a click elsewhere, a
   drag, a scene change or the marker leaving the screen closes it.

## Non-goals

- Making an occluded icon non-clickable. Occlusion is layer-order paint-over
  with no depth readback; nothing the runtime can query knows the icon is
  hidden. Change C below gives it a *cue*, not a fix.
- Suppressing the jump itself. Rejected in favour of A: the tap position is not
  available inside the touch input source, which sees only accumulated deltas,
  so guarding it would mean plumbing coordinates through a third code path for
  a state where the pointer is not an aim point anyway.
- Any editor-side change. Scope stays the exported viewer.

## Change A — gate marker interaction on the gaming-controls state

**New pure helper** in `src/portal-marker.ts`, joining the existing five under
the same self-contained constraint (stringified into the runtime via
`Function.prototype.toString()`, so no module-scope references):

```ts
const markerInteractive = (s: { cameraMode: string, gamingControls: boolean }): boolean => {
    if (!s) return true;
    if (s.gamingControls && (s.cameraMode === 'walk' || s.cameraMode === 'fly')) return false;
    return true;
};
```

One predicate covers both reported environments. `PointerLockManager` engages
the lock exactly when the mode is walk or fly, gaming controls are on and the
input mode is desktop — so the desktop pointer-lock case is a subset of this
condition and needs no separate `document.pointerLockElement` test. On touch the
same condition is the joystick/tap-to-jump state.

It is deliberately a *separate* predicate from `markerVisible`, which answers a
different question (does the icon draw at all). Icons stay visible here; only
their pointer response goes away, which is what the memo already promises.

**Wiring** in `src/viewer-companion/portal-markers.ts`, reading the existing
`getState()` from the portals companion's closure:

- `pointerup` — return before the hit test. No tooltip opens.
- `pointermove` — return, after clearing any live hover. This is what stops the
  frozen-coordinate tint latch under pointer lock.
- `window.__ssPortalMarkerAt` — returns `false`. One choke point, so every
  engine-side guard (both existing ones plus C below) inherits the gate rather
  than each re-deriving it.
- `refreshPortalMarkers()` — when the state is non-interactive, close any open
  tooltip and clear hover, so a tooltip opened before the user pressed **G**
  does not hang around.

**One new listener** in `src/viewer-companion/portals.ts`, next to the existing
`cameraMode:changed` hook:

```js
ev.on('gamingControls:changed', function () { refreshPortalMarkers(); });
```

Without it, `refreshPortalMarkers()` never runs on the transition that matters.

`markerVisible` is untouched: `refreshPortalMarkers` will still want the same
set of markers enabled, so the only observable effect of the extra call is the
tooltip/hover teardown.

## Change B — re-click toggles the tooltip closed

In the `pointerup` hit branch of `portal-markers.ts`:

| click lands on | today | after |
| --- | --- | --- |
| the marker whose tooltip is open | reopens (no-op) | closes |
| a different marker | switches | switches (unchanged) |
| no marker | closes | closes (unchanged) |

The closing click is still suppressed from navigating: the engine guards
hit-test the press position and know nothing about tooltip state. That is the
consistent choice — a click on an icon never moves the camera, regardless of
what it does to the tooltip — but it is new observable behaviour and goes on
the E2E list.

## Change C — hide the nav hover ring over an icon

A **seventh** entry in `src/viewer-engine-patch.ts`, guarding
`NavCursor.updateCursor`:

```js
    updateCursor(offsetX, offsetY) {
+       if (window.__ssPortalMarkerAt && window.__ssPortalMarkerAt(offsetX, offsetY)) { this.hoverRing.hide(); return; }
        if (!this.hoverActive || this.navigating) {
```

Verified against the decoded splat-transform 3.1.7 baked bundle: both anchor
lines occur exactly once each, and the insert separates them, so the search text
stops matching after the first pass. Like the other two nav guards it
self-destructs and needs no `applied` marker. `VIEWER_ENGINE_PATCH_COUNT` goes
6 → 7.

`updateCursor` takes the offsets directly as parameters — canvas-relative CSS
pixels, the same space `__ssPortalMarkerAt` expects and the same space the
existing guards read out of `_lastPointerOffsetX/Y`.

**Rejected alternative:** reaching the `NavCursor` instance from the companion
and hiding its SVG. The hover ring and the target ring share one `<svg>`
element, so hiding it would take the click-target ring with it, and the instance
is not published on `window.__supersplatViewer`.

The hover ring only exists in walk mode without gaming controls
(`NavCursor.hoverActive`), which is disjoint from the state Change A gates — so
A and C never both apply to the same click, and neither masks the other.

## Change D — restore the canvas cursor instead of clearing it

`markerSetHover` currently sets `markerCanvas.style.cursor = 'pointer'` on
hover-in and `''` on hover-out. The `''` wipes the viewer's own `'pointer'`
cursor (`NavInteraction._updateCursor` sets it whenever a click can target
something), leaving a default arrow until the next click restores it.

Fix: save `markerCanvas.style.cursor` on hover-in, restore that value on
hover-out.

Documented caveat rather than engineered around: if the viewer changes the
cursor *while* an icon is hovered, the restore writes back a stale value. It
self-heals on the next pointer-down/up pair.

## Testing

**`test/portal-marker.test.ts`** — `markerInteractive` truth table: walk+gaming
false, fly+gaming false, orbit+gaming true, walk without gaming true, `anim`
true, null state true.

**`test/viewer-engine-patch.test.ts`** — a new `NAV_CURSOR_SNIPPET` in the
synthetic bundle, an assertion that the guard lands ahead of the `hoverActive`
check, `VIEWER_ENGINE_PATCH_COUNT` 6 → 7, and the existing idempotence test
extended to cover it.

**`test/portal-markers.test.ts`** — this harness asserts against the runtime
*template string*; it does not execute it. So the additions there are string
assertions: `var markerInteractive =` is stringified in, the pointer handlers
consult it, `__ssPortalMarkerAt` is gated, and the toggle branch is present. The
behavioural confidence for A comes from the pure helper's unit tests, not from
here.

**`test/portals-injection.test.ts`** — the `gamingControls:changed` listener is
wired.

## E2E impact

Rewritten:

- **13** — under pointer lock / gaming controls: icon visible, hover does not
  tint, click does nothing. No tooltip, and the jump is unaffected.
- **21** — mobile: with gaming controls **off**, tap opens the tooltip; with
  them **on**, tap jumps and no tooltip appears.

New:

- Click an open tooltip's own icon → it closes, and you do not move.
- Hover an icon in walk mode → the nav hover ring disappears.
- Move a few tens of pixels off the icon → the ring comes back.
- Open a tooltip in walk mode, press **G** → tooltip closes, hover tint clears.
- Hover an icon then move off it in walk mode → the cursor returns to the
  viewer's pointer, not a default arrow.
