# Portal transition: dropdown with two effects

**Date:** 2026-08-06
**Status:** approved, ready for planning
**Source:** Claude Design project `96a1d3ef-c7bc-4b9c-9446-ee5fc621313d`,
files `Portal Transitions.html` + `portal-variants.js`

## Summary

The portal editor bar has a single `⧉` toggle that turns the exported viewer's
tile transition on or off for one portal. Replace it with a dropdown offering
three choices:

| choice | effect |
| --- | --- |
| **None** | no cover; crossing switches the scene immediately (today's "off") |
| **Defocus Dip** | **the default.** New: the whole frame blurs, desaturates and darkens, then comes back |
| **Tiles** | today's tile dismantle/reconstruct, retimed and with a much finer grid; now opt-in |

Both effects are ported from the design prototype's timings.

## Design provenance

The prototype's playback loop is `t += dt * speed * 2` — the `2` is baked in, so
its "1.00×" label already runs the animation at twice the variant's declared
spec durations. The design was reviewed at **0.75×**, which the user confirmed
means *the playback they actually watched*: spec durations ÷ 1.5.

| | prototype spec | shipped (÷ 1.5) |
| --- | --- | --- |
| Tiles: dismantle / hold / reconstruct | 375 / 100 / 375 ms | **250 / 67 / 250 ms** |
| Defocus: dismantle / hold / reconstruct | 320 / 110 / 560 ms | **213 / 73 / 373 ms** |

Tile size was reviewed at the prototype's **26px** minimum (from 110px today).

## 1. Data model

`PortalData.transition` changes from `boolean` to a string enum:

```ts
type PortalTransition = 'none' | 'tiles' | 'defocus';
// PortalData
transition?: PortalTransition   // absent = 'defocus' (the default)
```

A single pure reader normalizes every legacy and current shape:

```ts
const normalizePortalTransition = (v: unknown): PortalTransition => {
    if (v === false || v === 'none') return 'none';
    if (v === 'tiles') return 'tiles';
    return 'defocus';          // true, undefined, anything else
};
```

| stored | resolves to | rationale |
| --- | --- | --- |
| `false` | `none` | legacy "disabled" |
| `'tiles'` | `tiles` | the only way to select the tile cover |
| `true`, absent, anything else | **`defocus`** | the default |

**Defocus is the default cover, not tiles.** Absence resolves to it, so a
pre-dropdown document whose portals played tiles by virtue of having no field
now plays defocus. That is deliberate: nothing on disk is rewritten, only how
absence is read, and a portal that wants tiles now says so explicitly. It also
means the tile grid's ~1200 divs are never built unless a portal asks for them,
which makes the heavier cover opt-in rather than inherited.

Consequences:

- Existing `.ssproj` documents need **no migration**.
- An older build reading a new document sees an unrecognised string, and its
  `transition !== false` test resolves to "enabled". Nothing breaks, but state
  this plainly rather than calling it graceful: **a portal set to None plays
  Tiles on an older build.** An author who deliberately disabled the transition
  gets it back. No encoding satisfies both directions, so this is accepted, not
  solved.
- The dropdown always writes an explicit string; only untouched portals keep
  `undefined`.

**Home:** `PortalTransition` and `normalizePortalTransition` go in
`src/portal-transition.ts`. It is pure, dependency-free, already unit-tested,
and is the cohesive owner of this concept. Its header comment must be amended:
today it claims *every* function in the file is stringified into the exported
viewer, which will no longer be true. Name the four stringified functions
(`tileGrid`, `tileGeometry`, `tileDelay`, `transitionReducer`) explicitly and
note that `normalizePortalTransition` is a plain import.

`normalizePortalTransition` is called at three boundaries:

1. `src/portals.ts` — document deserialize, via a thin wrapper that maps legacy
   booleans onto the enum but leaves `undefined` as `undefined`:

   ```ts
   const migrateDocTransition = (v: unknown): PortalTransition | undefined =>
       (v === undefined || v === null) ? undefined : normalizePortalTransition(v);
   ```

   Without the wrapper, loading and re-saving any document that never touched
   the feature would write an explicit `"defocus"` into every portal record. The
   "absent means the default" invariant is preserved on disk; only reads resolve it.
2. `src/portal-export.ts` — so the exported viewer payload only ever contains
   one of the three strings (here `undefined` *does* resolve to `'defocus'`).
3. `src/tools/portal-tool.ts` — resolving the dropdown's displayed value.

The viewer runtime also normalizes defensively (see §4).

## 2. Editor UI — `src/tools/portal-tool.ts`

Replace the `transitionButton` (`Button({ text: '⧉', class: glyphClass })`) with
a labelled dropdown occupying the same slot in the bar, between the bounds
button and the Width group:

```
[+] [move] [rotate] [⤢]   Transition [ Defocus Dip ▾ ]   Width [2.00]   Height [2.00]   …
```

```ts
const transitionLabel = new Label({ text: i18n.t('portals.transition') });
const transitionInput = new SelectInput({
    type: 'string',
    options: [
        { v: 'none',    t: i18n.t('portals.transition.none') },
        { v: 'defocus', t: i18n.t('portals.transition.defocus') },
        { v: 'tiles',   t: i18n.t('portals.transition.tiles') }
    ],
    width: 140
});
transitionInput.dom.title = i18n.t('portals.transition.tooltip');
bar.append(group(transitionLabel, transitionInput));
```

This matches the Width / Height / Front / Back / Start / Entrypoint groups
already in the bar, which are all `group(Label, SelectInput|NumericInput)`.
Options are built once at construction, consistent with every other label in
this file.

Wiring, following the existing `frontInput` / `backInput` pattern exactly:

- `refreshBar()`: replace the two `transitionButton` lines with
  `transitionInput.enabled = !!z` and, when `z` exists,
  `transitionInput.value = normalizePortalTransition(z.transition)`. This runs
  inside the existing `suppress = true` window, so it does not re-enter.
- `transitionInput.on('change', ...)`: bail on `suppress`; bail when the new
  value equals `normalizePortalTransition(z.transition)`; otherwise fire
  `new UpdatePortalOp(events, z.id, { transition: z.transition }, { transition: next })`.

Undo restores the previous raw value (possibly `undefined`), which is how the
bounds and front/back edits already behave.

The `pointerdown` listener on the old button is deleted along with the button;
`SelectInput`'s own `change` event replaces it. The bar-level
`pointerdown → stopPropagation` guard already covers the new control.

### Localization

`portals.transition` ("Transition") and `portals.transition.tooltip` already
exist in all 9 locales and are both reused. Three new keys per locale:

| key | en |
| --- | --- |
| `portals.transition.none` | None |
| `portals.transition.tiles` | Tiles |
| `portals.transition.defocus` | Defocus Dip |

27 entries across `static/locales/{de,en,es,fr,ja,ko,pt-BR,ru,zh-CN}.json`.
Non-English strings are machine-assisted and must be flagged for review before
the branch is finished, per the project's standing practice.

## 3. Tile grid — `src/portal-transition.ts`

`tileGrid` currently targets 110px tiles and hard-clamps to 20×16 (max 320
tiles). The design's 26px target requires dropping that clamp, which on a
1440p display would otherwise produce ~5400 animated divs. Replace the fixed
clamp with a total-tile cap:

```ts
const tileGrid = (width: number, height: number): { cols: number, rows: number } => {
    const TARGET = 26;
    const MAX_TILES = 1200;
    const w = (typeof width === 'number' && width > 0) ? width : TARGET;
    const h = (typeof height === 'number' && height > 0) ? height : TARGET;
    let cols = Math.max(6, Math.round(w / TARGET));
    let rows = Math.max(4, Math.round(cols * h / w));
    if (cols * rows > MAX_TILES) {
        // scale both axes together so the tiles stay roughly square
        const k = Math.sqrt(MAX_TILES / (cols * rows));
        cols = Math.max(6, Math.floor(cols * k));
        rows = Math.max(4, Math.floor(rows * k));
    }
    return { cols: cols, rows: rows };
};
```

The function stays self-contained (it is stringified into the viewer), so all
literals remain inline and it references no siblings.

Resulting grids:

| viewport | grid | tiles | effective tile |
| --- | --- | --- | --- |
| 390×844 (phone) | 15×32 | 480 | 26px — exact |
| 1366×768 | 46×26 | 1196 | ~30px |
| 1600×1000 | 43×27 | 1161 | ~37px |
| 1920×1080 | 45×26 | 1170 | ~43px |
| 2560×1440 | 46×25 | 1150 | ~56px |
| 6000×400 | 135×8 | 1080 | ~44px |
| 0×0 (degenerate) | 6×6 | 36 | — |

Phones and small laptops get the design intent exactly; only large displays
degrade, and they degrade to a grid still ~4× finer than today's.

### Fly distance

`tileAway()` in the companion hardcodes a 140px radial offset. The prototype
scales it with tile size, `FLY = 140 × (0.5 + 0.5 × T/110)`, which at T=26 gives
**86.5px**. Ship that as a constant — the cap already changes effective tile
size per viewport, and an absolute distance is what reads as "how far the tiles
travel". The `scale(.25)` and `rotate(spin)` parts are unchanged, as is the
spin assignment (`(16 + random()*50) * (ux > 0 ? 1 : -1)`); neither was part of
the reviewed change.

## 4. Viewer runtime — `src/viewer-companion/portals.ts`

`transitionReducer` is cover-agnostic (`cover: 'none'|'dismantle'|'reconstruct'|'clear'`)
and **does not change**. Only the three drivers it commands become
kind-dependent.

### Cover selection

```js
function transitionKind(portalIndex) {
  if (portalIndex === null || portalIndex === undefined) { return 'none'; }
  var p = data.portals[portalIndex];
  if (!p) { return 'none'; }
  var v = p.transition;
  if (v === false || v === 'none') { return 'none'; }
  if (v === 'tiles') { return 'tiles'; }
  return 'defocus';
}
```

This replaces `transitionEnabled()`. The gate in `tick()` becomes
`transitionKind(cr.portalIndex) !== 'none'`, and the same call site captures
`coverKind = transitionKind(cr.portalIndex)` immediately before
`transDispatch({ type: 'crossing', target: next })`. The reducer only accepts a
crossing while idle, so exactly one crossing is in flight at a time and
`coverKind` is stable across its whole lifecycle (dismantle → covered →
reconstruct → idle).

`startDismantle`, `startReconstruct` and `clearCover` each branch on
`coverKind`; the phase timings (`T_SWEEP`, `T_TILE`, `T_HOLD`) become per-kind
lookups rather than module constants.

### Build gating

Today `wantsTransition = data.portals.some(p => p.transition !== false)` decides
whether to pay for the tile grid at all. Split it:

```js
var kinds = data.portals.map(function (p, i) { return transitionKind(i); });
var wantsTiles   = kinds.indexOf('tiles')   !== -1;
var wantsDefocus = kinds.indexOf('defocus') !== -1;
```

Build the tile grid only when `wantsTiles`, create the defocus element only when
`wantsDefocus`. When neither is present nothing is mounted, the phase machine
can never leave `idle`, and no code path dereferences either cover — the same
invariant the current comment documents. The existing resize handler stays
gated on `wantsTiles` (defocus has no geometry and needs no rebuild).

### Tiles cover

Same CSS-transition mechanism, retimed. The per-tile duration lives in the
injected stylesheet and must move with the constants:

| | today | new |
| --- | --- | --- |
| `T_SWEEP` (stagger across grid) | 225ms | **150ms** |
| `T_TILE` (per-tile, CSS `transition` duration) | 150ms | **100ms** |
| `T_HOLD` (covered, before reconstruct) | 100ms | **67ms** |
| dismantle = sweep + tile | 375ms | **250ms** |
| total crossing | 850ms | **567ms** |

```css
.ss-portal-tile {
  background: #0a0c10; opacity: 0;
  transition: opacity 100ms ease-out, transform 100ms cubic-bezier(.2,.75,.3,1);
}
```

Everything else about this cover (layer `opacity: .7`, `#0a0c10` tiles, `armed`
class, the single `offsetWidth` flush, `will-change` scoped to `.armed`) is
unchanged.

### Defocus cover

One full-screen element. The prototype stacks a `backdrop-filter` div under a
`#070a0e` veil div; folding both onto one element composites identically
(the element's own background paints over its own backdrop-filter result) and
halves the layer count.

```css
.ss-portal-defocus {
  position: fixed; inset: 0; z-index: 1999; pointer-events: none;
  visibility: hidden;
  background: rgba(7,10,14,0);
  -webkit-backdrop-filter: blur(0px) saturate(1);
          backdrop-filter: blur(0px) saturate(1);
}
.ss-portal-defocus.armed { visibility: visible; will-change: backdrop-filter, background-color; }
.ss-portal-defocus.on {
  background: rgba(7,10,14,.9);
  -webkit-backdrop-filter: blur(26px) saturate(.45);
          backdrop-filter: blur(26px) saturate(.45);
}
```

Endpoints come straight from the prototype's `update(c)`:
`blur(26 × c)px`, `saturate(1 − 0.55c)`, veil `opacity 0.9c`.

Driven by toggling `.on`, with the `transition` shorthand set inline per phase
so each direction gets its own duration and curve:

| phase | duration | curve | CSS |
| --- | --- | --- | --- |
| dismantle (`c` 0→1) | 213ms | cubicIn | `cubic-bezier(.32,0,.67,0)` |
| reconstruct (`c` 1→0) | 373ms | quintOut | `cubic-bezier(.22,1,.36,1)` |

Transitioning the same properties *back* to their base values on an ease-out
curve is exactly the prototype's `c = 1 − quintOut(p)`, so no rAF driver is
needed and the mechanism stays identical in shape to the tiles cover.

Hold is **67ms, not the 73ms** the arithmetic above derives (110 ÷ 1.5). The
defocus cover reuses the tile cover's `T_HOLD` rather than minting a second
constant; 6ms is imperceptible and one shared hold is the simpler code. Total
653ms.

`clearCover` for this kind mirrors the tile version: kill the transition,
remove `.on` and `.armed`, force one flush, restore the transition.

### Reduced motion

`REDUCED_MOTION` behaviour is unchanged for tiles (`T_SWEEP = 0`, opacity-only,
`transform: none`). Defocus under reduced motion drops the blur and animates the
veil alone (`background-color` only, both phases 150ms linear), matching the
prototype's reduced-motion substitute — a plain cross-fade of the cover layer on
the same phase contract.

### Risks, explicitly accepted

There are **two** independent Android risks here, not one. Both need their own
E2E row.

- **`backdrop-filter` over the WebGL canvas (defocus).** It is compositor-level,
  not a JS canvas readback, so it does not violate the export's architecture —
  but it forces the compositor to snapshot the canvas backdrop every frame for
  ~590ms per crossing, and *longer than that* when the destination is a cold
  streaming scene: the `covered` phase is unbounded, so the blur holds for the
  whole load. Where `backdrop-filter` is unsupported, the 0.9 veil alone still
  covers the swap, degrading to a dark fade rather than breaking.
- **Compositor layer count (tiles).** The grid change takes the animated element
  count from 170 to 1170 on a 1920×1080 desktop and from 78 to 480 on a 390×844
  phone — **~6.9× and ~6.2×**, measured against what the old 110px grid actually
  returned at those sizes, not against its 320 ceiling, which only a display
  wider than ~2200px ever reached. This is the bigger exposure of the two,
  because tiles is the **default** every existing portal inherits while defocus
  is opt-in.

  **`will-change` was removed from both covers** rather than held back as a
  mitigation. `.ss-portal-tiles.armed .ss-portal-tile` previously carried
  `will-change: transform, opacity`, promoting every tile to its own layer for
  the duration of the cover. At up to 1200 cells that is far past the point the
  hint helps, and it had no lead time to work with anyway — `startTileDismantle`
  adds `.armed` and starts the transition in the same frame. Browsers already
  promote an element with a running transform/opacity transition, so the hint
  was redundant for exactly the properties being animated. The defocus layer's
  `will-change: backdrop-filter, background-color` went with it: a
  backdrop-filter transition composites regardless, and `background-color` is a
  paint property no compositor fast path covers. A `not.toContain('will-change')`
  assertion on the injected viewer keeps either from creeping back.

Defocus is opt-in per portal, so neither outcome requires reverting anything.
The defocus cover is also one element against the tile cover's ~1200, so it is
the natural fallback if the finer grid still proves heavy on a low-end phone.

## 5. Export — `src/portal-export.ts`

`ExportPortal.transition` and `PortalBundle.portals[].transition` change from
`boolean` to `PortalTransition`, and the pass-through at the bundle builder
normalizes:

```ts
transition: normalizePortalTransition(p.transition)
```

`portal-export.ts` currently imports only from `./portal-geom`; it gains an
import from `./portal-transition`, which is equally dependency-free, so the
"no playcanvas imports, unit-testable in isolation" property holds and the
`dist-shared` build is unaffected.

`src/portal-upload.ts` (S3 publish) reuses this builder and needs no change —
verified: it contains no `transition` references of its own.

## 6. Tests

| file | change |
| --- | --- |
| `test/portal-transition.test.ts` | rewrite the four `tileGrid` cases for the 26px target (1600×1000 → 43×27; 320×640 → 12×24; 6000×400 → 135×8; degenerate unchanged); add cap tests asserting `cols × rows ≤ 1200` and near-square aspect at 1920×1080 and 2560×1440; add a `normalizePortalTransition` table test covering `false`, `true`, `undefined`, all three strings, and a junk value |
| `test/portal-export.test.ts` | assert the bundle normalizes `false → 'none'`, absent → `'tiles'`, and passes `'defocus'` through |
| `test/portals-injection.test.ts` | assert the injected runtime contains the defocus CSS class and the `transitionKind` driver alongside the existing `var tileGrid =` check |
| `test/portals.test.ts` | assert deserialize normalizes a legacy `transition: false` record |

`tileGeometry`, `tileDelay` and `transitionReducer` tests are untouched — none
of those functions change.

## Out of scope

- The other five prototype variants (Depth Cascade, Optical Iris, Light Bleach,
  Glass Shards, Light Curtain).
- Per-portal tuning of tile size, speed or hold. Both effects ship with fixed
  timings.
- The tile spin/scale choreography and the `.7` layer opacity, which were not
  part of the reviewed change.
- Any change to `transitionReducer`, the crossing reducer, or collision swap
  timing.
