# (3) Make the exported viewer's loading bar appear immediately and never regress

Status: NOT STARTED 2026-08-15. Design agreed in outline, not implemented.
Prerequisite reading: `docs/superpowers/2026-08-15-viewer-load-critical-path-findings.md`.
**Do this LAST, and re-measure before starting** — the gzip fix has already
landed and (4) `2026-08-15-early-lod-clamp.md` will move the numbers again. The
user's stated reason for ordering it last is to be able to see the time savings
from the earlier fixes.

## Problem

Two separate defects, same surface:

1. **The bar appears late.** It has exactly one data source — `readyHandler`,
   registered inside the `Promise.all([gsplatLoad, skyboxLoad, collisionLoad])`
   handler — so nothing can paint it until the collision binary has downloaded.
   Measured before the gzip fix: ~3 s desktop / ~5 s mobile on lauterbrunnen.
   On top of that the first `frame:ready` always computes `0`, and `observe()`
   only fires `progress:changed` on a *change*, so even that tick is swallowed:
   the bar needs progress ≥ 1 to become visible at all.
2. **The bar goes backwards.** The gauge is drain-from-peak
   (`(watermark - loading) / watermark`), not loaded/total, so any work queued
   after the peak drops the percentage. Reported in the field on mobile as
   "80% → 60% → 100%".

Both are in upstream viewer code, which the user does not want to modify. Both
are fixable from a fork-side companion injection.

## Design

### Paint at 0% immediately

`#loadingWrap` is in the DOM from the first byte, but `#loadingBar` has no
`background-image` in the stock `index.css` and `#loadingText` is empty, so it
renders nothing. A `<style>` injected into `<head>` fixes that with no JS:

```css
#loadingWrap > #loadingBar {
    background-image: linear-gradient(90deg, white 0%, white 100%);
}
#loadingWrap > #loadingText:empty::after {
    content: '0%';
}
```

Two properties make this safe:

- the viewer writes `dom.loadingBar.style.backgroundImage` — an **inline**
  style, which outranks any injected author rule. So no `!important` (which
  would freeze the bar at 0% forever), and JS updates take over cleanly.
- `:empty` stops matching the moment JS sets `textContent`, so the placeholder
  clears itself with no teardown code.

Match the stock selector specificity (`#loadingWrap > #loadingBar`, two IDs) so
this stays a pure addition rather than a specificity fight.

This subsumes any separate "don't swallow the first tick" fix: once the bar
already shows 0%, the swallowed 0% tick is a visual no-op.

### Clamp the displayed value to its running maximum

```js
const g = window.__supersplatViewer && window.__supersplatViewer.global;
if (g && g.events) {
    let seen = 0;
    const text = document.getElementById('loadingText');
    const bar  = document.getElementById('loadingBar');
    g.events.on('progress:changed', (p) => {
        if (p >= seen) { seen = p; return; }   // rising: the viewer already painted it
        if (text) text.textContent = seen + '%';
        if (bar)  bar.style.backgroundImage =
            'linear-gradient(90deg, #F60 0%, #F60 ' + seen + '%, white ' + seen + '%, white 100%)';
    });
}
```

`EventHandler` fires listeners in registration order, and the viewer registers
its own handler in `initUI()` *inside* `main()`, while
`window.__supersplatViewer` is only published after `main()` returns. So a
companion listener is always later and gets the last word on the DOM. On a
rising tick we do nothing; on a falling one we repaint at the high-water mark.

Keep the gradient string in sync with the viewer's own (`#F60` fill, white
remainder) — if upstream restyles the bar this is the line that drifts.

### Optional third step, only if still needed after (4)

Drive the bar from `world.pendingLoadCount` directly, from the first frame,
instead of waiting for `readyHandler`. The traversal already exists in
`src/viewer-companion/portals.ts` (`unstickInstances` walks
`app.renderer.gsplatDirector.camerasMap → layersMap → gsplatManager.world`), and
`window.__supersplatViewer.global.app` is reachable early (see the (4) memo —
**not** `getApp()`, which is gated behind the same `Promise.all`).

Judge this on fresh measurements. With gzip landed and (4) done, the gate may
fire early enough that steps 1 and 2 are the whole fix and this is unnecessary
complexity.

## Risks / must-handle

- The bar will sit at a static `0%` for the whole pre-gate window. That is
  honest — zero blocks are resident — but it is static, not moving. If a moving
  indicator is wanted, that needs the optional third step or an engine patch.
- Companion bodies are template literals: **no backslash escapes** (cooked away
  at build time). The CSS above is escape-free; keep it that way.
- Injection goes through `insertBeforeBodyClose` in `src/splat-export-core.ts` —
  never `String.replace` with the injection as the replacement (`$` sequences in
  the payload get substituted; this has corrupted exports before).
- Release-build E2E, desktop and a real phone.

## Known upstream quirk, deliberately not fixed

The same `readyHandler` skips its update whenever `loading` happens to equal the
loaded count (`if (loading !== current)`), so the bar can occasionally skip a
step. Cosmetic, inside upstream code, and the running-max clamp does not make it
worse.

## Classification for the implementing session

Bounded — one new small companion module plus its injection call, following
`src/viewer-companion/poster.ts` (which already injects both a `<style>`-writing
script and a default value) as the closest existing model.
