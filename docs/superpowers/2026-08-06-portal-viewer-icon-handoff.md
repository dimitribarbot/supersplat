# Portal icon in the exported viewer — hand-off

**Date:** 2026-08-06
**Branch:** `portal-viewer-icon`, off `main` at `87a9826`
**Spec:** `docs/superpowers/specs/2026-08-06-portal-viewer-icon-design.md`
**Plan:** `docs/superpowers/plans/2026-08-06-portal-viewer-icon.md`
**Status:** complete. All automated gates green, and **both** end-to-end passes
run and passed — the full 32-item pass (which is what produced the interaction
refinements below) and the scoped re-run covering those refinements.

**Amended:** 2026-08-07 — click behaviour and plane alignment, see
`docs/superpowers/specs/2026-08-07-portal-marker-click-and-orientation-design.md`.
Items 9-10 changed meaning; items 23-32 are new.

**Amended:** 2026-08-07 — post-E2E marker interaction refinements, see
`docs/superpowers/specs/2026-08-07-portal-marker-interaction-refinements-design.md`.
Items 13 and 21 changed meaning; items 33-38 are new.

## What shipped

Every portal in a ZIP-package export now draws a visible marker at its centre —
the same point the editor's transform gizmo sits on.

| property | value |
| --- | --- |
| look | black disc, white ring, the `src/ui/svg/portal.svg` door glyph, drawn to a 256² canvas texture |
| size | `MARKER_SIZE = 48` screen px, constant regardless of distance (annotation hotspots are 25) |
| which portals | only those whose `front` or `back` is the **active** scene |
| occlusion | **hidden** behind splats; thin haze dims it proportionally |
| click | canvas hit-test against the icon's projected ellipse → tooltip, "Portal to another scene", localized in 9 languages; the camera does **not** move. Clicking the open icon again closes the tooltip |
| orientation | lies flat in the portal's plane; foreshortens and disappears when viewed edge-on |
| hover | emissive tints orange, cursor becomes a pointer, and the viewer's walk-mode nav hover ring hides |
| pointer | **inert while gaming controls are on** (mobile joystick, desktop pointer lock) — icons stay visible, no tooltip, no tint, the jump is untouched |
| walk / fly | **stays visible while moving**, including with gaming controls on — unlike annotations |
| suppressed when | `config.noui`, `cameraMode === 'anim'`, or a portal transition cover is running |
| toggle | none; always on |

Scope is the ZIP package export, which is the only place portals exist. Both the
local writer and the export-server path get it (shared `splat-export-core.ts`).
The editor is untouched.

## How it works

Three pieces, because the exported viewer is a vendored third-party bundle we can
only reach through string patches and injected companions.

1. **`src/portal-marker.ts`** — pure, playcanvas-free decisions: `portalsForScene`,
   `markerScale`, `markerVisible`, `markerInteractive` (gates whether the icons
   respond to the pointer at all), `resolveMarkerTooltip`, `markerHitTest`, plus
   `MARKER_SIZE` and `MARKER_TOOLTIPS`. Unit-tested normally AND stringified into
   the runtime with `Function.prototype.toString()`, which is why each function is
   self-contained.
2. **`src/viewer-engine-patch.ts`** — string patches into the vendored bundle,
   the only lever available since the bundle is unminified with real
   module-scope class names but exports only `main`, so nothing in it is
   otherwise reachable from a classic-script companion. One patch prepends
   `try { window.__ssPc = { Entity, Layer, Mesh, ... }; } catch {}` before the
   exported bundle's `export { main };`, publishing the engine classes the
   marker companion needs. Two more — the subtlest thing on this branch —
   guard the viewer's own click-to-navigate decision points, `_onPointerUp`
   (mouse) and `_onMobileTap` (touch): each inserts one line ahead of the
   walk/fly/orbit mode branches that calls back into
   `window.__ssPortalMarkerAt(x, y)` (published by the companion, piece 3
   below) and returns early when the click landed on an icon. That pair is
   the entire mechanism that stops a click on a marker from also moving the
   camera. A third guards `NavCursor.updateCursor`, the walk-mode nav hover
   ring: it hides the ring while the pointer is over an icon, the cue that
   tells the user a click there will not move the camera.
3. **`src/viewer-companion/portal-markers.ts`** — the runtime, spliced *inside*
   the portals companion's IIFE (it reads that closure's `data`, `activeIndex`,
   `liveApp`, `transState`, `getState`). Owns the texture, mesh, layer, per-marker
   entity and material, the canvas pointer listeners and the tooltip.

**The occlusion is layer order, not a depth test.** The marker layer is inserted
at `getOpaqueIndex(World) + 1`; splats render later in World-transparent and
simply paint over an occluded icon. There is deliberately **no** always-on-top
second copy — that is what makes an occluded icon vanish instead of ghosting the
way annotation hotspots do. (Confirmed against the bundle: gsplat materials are
`depthWrite: false` with depth testing on.)

**Icons have no DOM hit-targets.** An early implementation gave each marker a
56px `pointer-events: auto` div. That swallowed any orbit-drag or click-to-walk
gesture that *started* on an icon — and icons sit exactly where you aim to walk
through a doorway. They were replaced with a hit-test against the canvas: passive
`pointerdown`/`pointerup`/`pointermove`/`pointerleave`/`pointercancel`, a 15px
click slop matching the viewer's own `TAP_EPSILON`, `getBoundingClientRect`
coordinate conversion, and a hit test against the ellipse the icon actually
projects to (no radius parameter). A side effect worth knowing during E2E:
**a drag no longer counts as a click**, which the earlier `document`-level
listener got wrong.

## Commits

| commit | what |
| --- | --- |
| `182d2b3` | pure decision helpers |
| `00c0f32` | `window.__ssPc` engine-class publish patch |
| `f3acd3a` | marker companion runtime |
| `2b00449` | wiring into the portals companion |
| `4f301a5` | test fix — the plan mandated an `indexOf` assertion that could never pass |
| `0c9e9e4` | final-review fixes: tooltip closes on scene change; canvas hit-test replaces DOM divs |
| `bf3a86a` | clear hover on `pointerleave` / `pointercancel` |
| `1ad534d` | marker icon lies in the portal plane — plane-aligned orientation plus the elliptical hit test |
| `2d18c2b` | a click on a marker opens its tooltip only — two viewer-engine guards, click slop raised to 15px |
| `90c0e0a` | final-review fixes: tooltip hit-tests the press position (closes the down/up disagreement), hand-off memo prose refresh |
| `1b6a6aa` | `markerInteractive` — pointer response gated on the gaming-controls state |
| `4052766` | marker icons stop taking clicks under gaming controls |
| `a354dd3` | a second click on a marker closes its tooltip |
| `6486e03` | the walk-mode nav ring hides over a portal icon |
| `4113137` | patch-count header comment corrected from six to seven |
| `01175c8` | marker hover-out restores the viewer cursor |

## Automated gates

The figures below are from the branch head at the time of writing; re-run
them before sign-off rather than trusting the numbers as-is.

```
npm run test     # 696 passed (696), 52 files
npm run lint     # exit 0
npm run build    # grep -c "plugin typescript" build log => 0
node scripts/build-shared.mjs
                 # dist-shared/portal-marker.js
                 # dist-shared/viewer-companion/portal-markers.js
```

The build's **exit code is not a type gate** in this repo — Rollup reports TS
errors as warnings and exits 0 anyway. The gate is the zero `plugin typescript`
count.

---

# E2E checklist

## Setup

Use a **release** build, not `npm run develop`. The runtime ships as a stringified
companion and release-only minification has broken stringified helpers here before.

```bash
git checkout portal-viewer-icon
npm run build
npm run serve          # http://localhost:3333
```

Load a project with **at least two scenes and two portals**. Ideally set the
per-portal transition dropdown so you have one **None**, one **Defocus** and one
**Tiles** portal — items 15-17 each exercise a different code path. Export a
**ZIP package**, unzip, and serve the folder.

Both passes are done. The first covered items 1-32 and passed. The post-E2E
interaction refinements only touched what items **5-10, 13, 21, 23-27 and
30-38** cover, so the second pass re-ran just those — and passed too. The table
below is kept as the regression checklist for any future change to this
feature.

## Checks

| # | Do this | Expect |
| --- | --- | --- |
| 1 | Look at a portal in the start scene | Icon at the portal centre, same spot as the editor gizmo |
| 2 | Compare with an annotation hotspot | Portal disc clearly larger, door glyph legible, white ring visible |
| 3 | Put a solid wall between camera and portal | Icon disappears completely |
| 4 | View a portal through thin haze | Icon dims proportionally rather than vanishing |
| 5 | Orbit: hover the icon | Tints orange, cursor becomes a pointer |
| 6 | Orbit: click the icon | Tooltip opens, localized text |
| 7 | Click elsewhere | Tooltip closes |
| 8 | Click an icon near the right edge of the window | Tooltip flips to the icon's left, stays fully inside the viewport |
| 9 | **Orbit-drag starting ON an icon** | Camera orbits normally; the icon must not swallow it, and no tooltip opens |
| 10 | **Click-to-walk aimed at a doorway icon** | Tooltip opens and you do **not** move. (This inverts the original expectation.) |
| 11 | Walk mode, moving, **gaming controls ON** | Icons stay visible (annotations vanish here — that contrast is the point) |
| 12 | Fly mode, moving | Same as 11 |
| 13 | With gaming controls **on** (press G, or the mobile joystick), click/tap an icon | Nothing happens: no tooltip, no hover tint. In walk mode on a phone the tap still jumps, and only jumps |
| 14 | Cross a portal | Icons swap to the new scene's portals; any open tooltip closes |
| 15 | Open a tooltip on a **None**-transition portal, then cross it | Tooltip closes (this was a real bug, fixed in `0c9e9e4`) |
| 16 | Cross a **Tiles** portal | No icons for the whole cover, back afterwards |
| 17 | Cross a **Defocus** portal | Same as 16 |
| 18 | Play the camera animation | No icons during `anim` playback |
| 19 | Append `?noui=1` | No icons at all |
| 20 | Hover an icon, then move the pointer off the canvas | Tint and cursor clear (`bf3a86a`) |
| 21 | Load on a phone | Icons render, no context loss. With gaming controls **off** a tap opens the tooltip; with them **on** a tap jumps and no tooltip appears |
| 22 | Repeat 1-4 on a **server** export (`server/`: `npm run dev`, port 3334) | Identical to the local export |
| 23 | Click an icon in **fly** mode | Tooltip opens, no fly-to |
| 24 | Click an icon in **orbit** mode | Tooltip opens, orbit centre does **not** move to it |
| 25 | Click the floor *beside* an icon, in walk mode | You walk there normally — the guard must not eat nearby clicks |
| 26 | View a portal side-on until the icon is a sliver | It is neither visible nor clickable; clicks pass through to the scene |
| 27 | View a portal from a steep but readable angle | The icon is a squashed ellipse; its full width is still clickable, its squashed height is not |
| 28 | Stand behind a portal and look back at the icon | Visible, mirrored (knob dot on the other side) — known and accepted |
| 29 | **Double-click** an icon | Still swaps camera mode and navigates — deliberately not suppressed — and any tooltip on that icon flashes open then closed — the double-click path bypasses the marker guard by design |
| 30 | In walk mode, press down just inside an icon's edge and release just outside it (under ~15px) | Tooltip opens and the camera does not move — the tooltip hit test and the engine guard both read the press position, so they cannot disagree |
| 31 | Same, reversed: press down just outside an icon's edge and release just inside it | Normal navigation happens and no tooltip opens — pressing outside the icon means neither the guard nor the hit test ever saw it |
| 32 | Stand so a wall fully hides a portal icon, then click the wall where the icon would be | Tooltip opens and you do not move — known limitation, occlusion is paint-over and the hit test cannot see it |
| 33 | Click an icon whose tooltip is already open | Tooltip closes, and you do not move |
| 34 | Walk mode, hover an icon | The nav hover ring on the floor disappears while the pointer is over the icon |
| 35 | Walk mode, move a few tens of pixels off the icon | The ring comes back and tracks normally |
| 36 | Walk mode, stand where a wall hides an icon and hover that spot | The ring disappears there too — the cue for item 32's known limitation |
| 37 | Open a tooltip in walk mode, then press **G** | Tooltip closes and the hover tint clears |
| 38 | Walk mode, hover an icon then move off it | The cursor returns to the viewer's pointer, not a default arrow |

Items **9, 10, 13, 15, 21, 30, 31, 33, 34 and 38** are the ones to watch: 9, 10
and 15 cover regressions the reviews caught that no automated test can prove;
30-31 verify that the tooltip hit test and the engine guard read the same
sample (the press position); 13 and 21 inverted meaning after the first E2E
pass; and 33, 34 and 38 are new behaviours.

## If something fails

Note the item number and what you saw; don't patch it in the browser. The fix
should go through one implementer dispatch plus one scoped re-review, the same
loop the rest of the branch used.

## Known limitations (not bugs, do not file)

- **Inert while gaming controls are on.** With the mobile joystick or desktop
  pointer lock active, the icons stay visible but ignore the pointer entirely.
  On touch a tap there is the viewer's jump, raised inside the touch input
  source where neither click guard can see it; on desktop pointer lock freezes
  `clientX`/`clientY`, so any hit test would read a stale point. Visibility is
  the point of the icon in those modes, not clickability.
- **Occlusion is coverage-based.** A portal centre in a very sparse region shows a
  partially-dimmed icon rather than a cleanly hidden one — the same behaviour the
  viewer's own annotations have.
- **An icon fully hidden behind geometry is still clickable.** Occlusion is
  depth/layer paint-over (the marker layer renders before the splats, which
  simply draw over an occluded icon) — there is no depth readback, so nothing
  the runtime can query tells it the icon is hidden. Clicking where a hidden
  icon sits still opens its tooltip and suppresses navigation; aiming a few
  tens of pixels away from that spot behaves normally.
  The walk-mode nav hover ring now disappears over such a spot, which is the
  only available warning that the click will not move you.
- **Gamma tint goes stale after leaving VR/AR.** The viewer destroys and recreates
  its `cameraFrame` on XR start/end, and the marker colours are gamma-corrected
  once at build. Exact parity with the viewer's own `Annotation.hotspotColor`.
  Reload fixes it.
- **Markers stay enabled inside an XR session**, where the constant-screen-size
  scale is derived from the flat canvas height. Nothing breaks.

## Still outstanding

- **Locale sign-off** on the 8 non-English `MARKER_TOOLTIPS` strings in
  `src/portal-marker.ts`. These are viewer-side, so nothing was added to
  `static/locales/*.json`. Machine-assisted, reviewed by one agent as idiomatic,
  but they follow the same sign-off route as previous batches. This is the only
  open item on the feature.

Both E2E passes are done and the branch has been squashed to a single commit and
merged into `main` locally. It has **not** been pushed.

## If you need the working artifacts

Per-task briefs, implementer reports and review packages are under
`.superpowers/sdd/2026-08-06-portal-viewer-icon/`, including `progress.md` — the
ledger with every review verdict, deferred minor and adjudication. That directory
is **git-ignored**, so it will not survive a `git clean -fdx`. Everything needed
to finish is in this memo.
