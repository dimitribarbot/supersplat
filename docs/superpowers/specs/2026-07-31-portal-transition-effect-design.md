# Portal transition effect (exported viewer) — design

Date: 2026-07-31
Status: approved, ready for implementation planning

## Problem

In the exported viewer (ZIP package / S3 publish), walking through a portal swaps
the visible scene on a single frame. The cut is abrupt: one frame shows the room
you are leaving, the next shows the room you are entering. In streaming mode a
not-yet-resident destination additionally snaps to a solid loading backdrop.

We want a transition that reads as the outgoing scene being **dismantled** and the
incoming scene being **reconstructed**, configurable per portal, and correctly
sequenced with the existing streaming loading overlay.

## Scope

In scope:

- A per-portal on/off toggle in the editor, default ON.
- The effect in the **exported viewer only** (local ZIP export, server export and
  S3 publish all share one bundle, so all three inherit it).
- Free-navigation portal crossings (walk / fly / orbit motion that physically
  crosses a portal rectangle).

Out of scope (keep today's instant switch):

- Camera reset (`inputEvent` `reset`), annotation jumps (`annotation.activate`),
  and animation-timeline scene changes. These are teleports with no portal, so
  there is no per-portal setting to read.
- The editor's own portal preview (`portals-runtime.ts`).
- Any per-portal tuning beyond on/off (duration, tile size and colour are fixed
  constants in the runtime).

## Chosen effect

Decided by comparing animated mockups in the visual companion
(`.superpowers/brainstorm/*/content/tile-*.html`).

A grid of translucent tiles overlaid on the viewer canvas:

1. **Dismantle** — tiles fly in from outside the frame while spinning, and settle
   into their slots. Ordered by distance from the screen centre, **edges first**,
   so the centre of the outgoing scene is the last thing covered.
2. **Hidden swap** — the scene switch happens while covered (~0.1s).
3. **Reconstruct** — tiles break up **centre first** and spin outward off-screen,
   revealing the incoming scene from the middle out.

The dismantle is the exact time-reverse of the reconstruct: one motion played
forwards, then backwards.

Constants (fixed, tuned in the mockups):

| Constant | Value |
| --- | --- |
| Sweep (stagger across the grid), each half | 225 ms |
| Per-tile motion | 150 ms |
| Covered hold before reconstruct | 100 ms |
| Tile colour | `#0a0c10` tiles in a `opacity: .7` group (same 70% result) |
| Tile fly distance / scale / spin | 140 px outward, `scale(.25)`, ±(16–66)° |
| Grid at desktop aspect | ~14 × 9 (roughly square tiles, viewport-derived) |

The 70% translucency is deliberate: the scenes stay faintly visible behind the
cover. It means the scene swap is slightly readable through the tiles during the
0.1s covered hold — accepted, and reviewed at that exact timing in the mockup.

### Why cover tiles and not the real pixels

An alternative was snapshotting the outgoing frame and tiling the actual pixels so
the scene itself flies apart. It was rejected: side by side the two were
indistinguishable at this speed, and it would have required a canvas readback per
crossing with an unproven WebGPU path (the viewer runs WebGPU with a WebGL2
fallback) plus a per-crossing frame hitch. The cover approach touches no engine or
GPU state at all.

## Architecture

### 1. Data model

`PortalData` (`src/portals.ts`) gains:

```ts
transition?: boolean   // absent = enabled
```

**Absent means enabled.** Existing projects and older `.ssproj` documents get the
effect with no migration step, and only an explicit `false` disables it. The same
rule applies in the runtime (`p.transition !== false`).

Serialization follows `infinite` exactly: written by `docSerialize.portals`, read
back by `docDeserialize.portals`.

### 2. Editor UI

One toggle button in the portal toolbar (`src/tools/portal-tool.ts`), placed next
to the existing infinite-bounds button (`⤢`), styled with the same
`select-toolbar-button` class and carrying the `active` class when the selected
portal has the effect enabled. It acts on the selected portal and commits through
`UpdatePortalOp`, so it is undoable like every other portal edit and refreshes via
the existing `refreshBar` path.

New i18n keys (9 locales, following `portals.bounds` / `portals.bounds.tooltip`):

- `portals.transition` — button label/glyph tooltip text
- `portals.transition.tooltip` — "Play a transition effect when crossing this portal"

### 3. Export path

`transition` is added to the `portals.export` event shape, to `ExportPortal`, and
to the rewritten record produced by `buildPortalBundle`
(`src/portal-export.ts`). That is the single choke point — `file-handler.ts`
(local ZIP), the server export path and `portal-upload.ts` /
`s3-publish-dialog.ts` (S3 publish) all consume the same bundle, so no per-path
changes are needed. The field lands in `window.__supersplatPortals.portals[i]`.

### 4. Identifying the crossed portal

`resolveActiveSplat` (`src/portal-geom.ts`) returns only the resulting scene, so
the runtime cannot tell which portal produced a crossing. Add a sibling pure
function:

```ts
resolvePortalCrossing(prev, cur, portals, currentUid, cross)
  => { uid: number | null, portalIndex: number | null }
```

`portalIndex` is the portal of the last effective crossing along the segment
(matching how `resolveActiveSplat` resolves multiple crossings by sorted `t`).

`resolveActiveSplat` is left untouched — the editor preview
(`portals-runtime.ts`) and its existing unit tests keep using it. The ~12 lines of
duplicated loop-and-sort are deliberate: both functions are stringified into the
exported viewer in separate scopes and cannot call each other by name after
terser minification. This is the same constraint that already forces `cross` to be
passed in explicitly rather than referenced from module scope.

### 5. Runtime

**New pure module `src/portal-transition.ts`** (unit-tested, stringified into the
viewer like the other shared helpers — no imports, no sibling references, no
backslash escapes since it is authored inside a template literal):

- `tileGrid(viewportWidth, viewportHeight)` → `{ cols, rows }`, roughly square
  tiles, clamped to a sane range.
- `tileGeometry(cols, rows, index)` → normalised distance from centre (0 centre,
  1 corner) and the outward unit vector for that tile.
- `tileDelay(dist, sweep, phase)` → `(1 - dist) * sweep` for dismantle,
  `dist * sweep` for reconstruct.
- `transitionReducer(state, event)` → the phase machine
  (`idle` → `dismantling` → `covered` → `reconstructing` → `idle`) with the
  commit and walk-back-cancel rules below.

**Wiring in `src/viewer-companion/portals.ts`:**

A tile cover layer appended to `document.body`, `pointer-events: none`, z-index
just **below** the existing loading backdrop (which is `z-index: 2000`), so the
opaque loading overlay and its spinner always draw above the cover. CSS lives
alongside `companionStyle`.

Sequence for a crossing through a transition-enabled portal:

1. **Detect.** In the free-navigation branch of `tick`, when
   `resolvePortalCrossing` reports a target different from `activeIndex` and the
   crossed portal has the effect enabled and the phase machine is `idle`: latch
   the target, start the dismantle, and **freeze `lastSafe` on the near side**
   instead of dispatching.

   The freeze is load-bearing. It is the same mechanism `blocked` mode already
   uses. Without it the camera walks past the portal during the dismantle,
   the frozen segment no longer crosses the rectangle, and a subsequent `blocked`
   dispatch could never re-fire — the crossing would be lost.

2. **Commit** when the cover completes. Re-resolve the crossing from the frozen
   `lastSafe` to the current camera position:
   - resolves back to `activeIndex` (the user walked back through the doorway
     mid-dismantle) → cancel, reconstruct, no switch;
   - otherwise `dispatch({ type: 'crossing', target, loaded, ready })` exactly as
     today.

3. **Hand-off.** `crossingReducer` is **not modified** and still owns every
   `activeIndex` change:
   - actions `keep` / `hide` (destination ready) → start the reconstruct
     immediately;
   - action `poll` (streaming, not yet resident) or `show` (target not loadable
     yet) → the cover stays in place, the opaque loading overlay fades in above it
     with its spinner, and the reconstruct runs when the overlay hides (on reveal,
     or on the blocked→switch completion). This is the required ordering: the
     reconstruction plays *after* the loading screen.

Transitions never run for the reset, annotation-activate or animation-timeline
dispatch paths; those call `dispatch` directly as they do today.

`prefers-reduced-motion: reduce` replaces the tile motion with a short plain fade
of the same cover layer, keeping the identical phase sequence and timing contract.

Cost: ~126 absolutely-positioned divs animating `transform` + `opacity` only
(compositor-only, no layout, no paint of scene content), created once and reused;
the grid is rebuilt on resize while `idle`.

## Error handling

- The transition wiring runs inside the existing `tick` try/catch. A throw during
  a transition must never strand the cover: on error, clear the phase machine,
  remove all tiles' `on` state, and fall back to today's behaviour (immediate
  dispatch), mirroring how the overlay poll's catch drops the overlay.
- A watchdog bound on the covered phase: if the machine has been `covered` for
  more than ~2 s while no loading overlay is showing (the hand-off was missed —
  e.g. a dispatch path that neither switched nor armed an overlay), force the
  reconstruct. While an overlay *is* showing, the overlay's own reveal caps bound
  the wait and the reconstruct follows it; the cover must never outlive it.
- An export whose bundle predates this feature has no `transition` field on its
  portals — every portal is enabled by the absent-means-enabled rule.

## Testing

Unit tests (`test/`, Vitest):

- `portal-transition.ts` — grid sizing across aspect ratios, per-tile delays in
  both directions (edges-first vs centre-first), phase machine transitions
  including the walk-back cancel and the error reset.
- `resolvePortalCrossing` — returns the correct `portalIndex` for single and
  multiple crossings along one segment; `undefined` transition resolves as
  enabled.
- `buildPortalBundle` — `transition` survives into the rewritten portal records.
- Document round-trip — `docSerialize.portals` / `docDeserialize.portals` preserve
  the flag, and a legacy document without it loads as enabled.

Manual E2E, on a **release** build (minification has broken stringified helpers
before — see `docs/superpowers/` portal memos):

1. Non-streaming (SOG) multi-scene ZIP export: crossing plays dismantle →
   reconstruct with no loading overlay.
2. Streaming export, cold cache: crossing plays dismantle → loading overlay with
   spinner → reconstruct after reveal.
3. A portal with the toggle off: instant switch, exactly today's behaviour.
4. Walk-back during the dismantle: cover reconstructs, scene unchanged.
5. Reset (R), annotation jump, and walkthrough playback: unchanged, no transition.
6. Phone (mobile budget path): no frame-rate regression during the transition.

## Open risks

- The 70% translucency lets the swap read faintly through the cover during the
  0.1s hold, and in streaming mode produces a two-step darkening as the solid
  loading backdrop fades in behind the tiles. Both were reviewed and accepted; if
  the E2E on real scenes looks wrong, the opacity is a one-constant change.
