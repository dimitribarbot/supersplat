# Portal icon in the exported viewer

**Date:** 2026-08-06
**Status:** approved, ready for planning

## Summary

The exported viewer renders portals invisibly: a crossing just happens. Give
each portal a visible marker — a billboarded icon at the portal centre (the same
point the editor's transform gizmo sits on), drawn on a dark circular disc, at
constant screen size. It hides behind splats, it is clickable, and clicking it
opens a tooltip saying the portal leads to another scene.

Scope is the **ZIP package export** (portals only exist there — a multi-scene
bundle cannot be a single-file HTML export). Both the local writer and the
export-server path get it, since they share `splat-export-core.ts`.

The editor is untouched: it already draws the portal rectangle and its gizmo.

## Requirements

| decision | choice |
| --- | --- |
| which portals show an icon | only those whose `front` or `back` is the **active scene** |
| occlusion | **hidden** behind splats — one pre-splat layer only, no ghost copy |
| tooltip text | generic, localized: "Portal to another scene" (9 languages) |
| toggle | none — always on |
| size | **larger** than the viewer's 25px annotation hotspot: `MARKER_SIZE = 48` |
| look | annotation-style disc: black disc, white ring, white door glyph |
| walk / fly | **visible while moving**, unlike annotations |
| suppressed when | `config.noui`, `cameraMode === 'anim'`, a portal transition is running |
| hover | emissive tint, as annotation hotspots do |

## How the viewer's own occlusion works (and why this design copies it)

The exported viewer already has this exact effect for annotation hotspots, and
it is **not** a depth-buffer test. `Annotation._initializeStatic` creates two
layers:

```js
createLayer('HotspotBase',    false)  // inserted at layers.getOpaqueIndex(World) + 1
createLayer('HotspotOverlay', true)   // inserted at layers.getTransparentIndex(World) + 1
```

Splats render in the World transparent sublayer, i.e. **after** `HotspotBase`
and **before** `HotspotOverlay`. So the base copy is simply painted over by any
splat in front of it, and the overlay copy (`depthTest: false`, `opacity: 0.25`)
is drawn on top of everything to keep an occluded annotation faintly visible.

That means "hide the icon entirely when occluded" costs nothing: **omit the
overlay layer**. A solid wall hides the icon completely; a thin, semi-transparent
haze dims it in proportion to its coverage, which is the soft fade we want, for
free. This is coverage-based rather than depth-based — see *Residual risks*.

## Why a standalone implementation rather than reusing `Annotation`

The viewer's `Annotation` class is otherwise a perfect fit, but the three things
this feature must change are all **statics** on it:

| what we need | why reuse fails |
| --- | --- |
| a larger icon | `_calculateScreenSpaceScale` reads `Annotation.hotspotSize` |
| visible in walk/fly while moving | `_update` writes `Annotation.opacity`, which the `Annotations` manager forces to `0` on `controlsHidden` or walk/fly-with-gaming-controls |
| our own DOM hit-targets | hotspots are appended to `Annotation.parentDom`, whose `display` the manager toggles |

Subclassing does not help: those are hard `Annotation.x` references, not
`this.constructor.x`. Reuse would mean four per-instance monkey-patches against
two private method names. We own ~180 lines instead and couple only to public
engine class names.

## Architecture

### 1. `src/portal-marker.ts` — new, pure, unit-tested

No playcanvas imports, so it runs under Vitest and is stringified into the
runtime the way `portal-geom` / `portal-crossing` / `portal-transition` already
are.

```ts
// indices of portals touching the active scene
portalsForScene(portals: {front: number|null, back: number|null}[], active: number): number[]

// constant-screen-size world scale; projData5 === projectionMatrix.data[5]
markerScale(size: number, canvasClientHeight: number, projData5: number, viewDepth: number): number

// the suppression rule
markerVisible(s: {noui: boolean, cameraMode: string, transitionActive: boolean}): boolean

// 9-language tooltip string, mirroring resolveLoadingMessage in portals.ts
resolveMarkerTooltip(defaults: Record<string, string>, lang: string): string
```

`markerScale` is the viewer's own formula, extracted so it is testable:

```
(size / canvasClientHeight) * (2 * viewDepth / projData5)
```

### 2. `src/viewer-engine-patch.ts` — one new patch

The exported `index.js` is a single **unminified** ESM bundle; every engine class
sits at module scope under its real name (verified against splat-transform
3.1.7's bundle: `class Entity`, `class Layer`, `class Mesh`, `class MeshInstance`,
`class StandardMaterial`, `class Texture`, `class Color`, `class BlendState`,
`class PlaneGeometry`, and `const PIXELFORMAT_RGBA8 / FILTER_LINEAR /
CULLFACE_NONE / BLENDEQUATION_ADD / BLENDMODE_ONE / BLENDMODE_SRC_ALPHA /
BLENDMODE_ONE_MINUS_SRC_ALPHA`). Nothing is exported but `main`, and the
companion is a classic script, so the bridge is a `window` publish.

Anchor: `export { main };` — one occurrence, at the tail of the bundle.

```
search:  export { main };
replace: window.__ssPc = { Entity, Layer, Mesh, MeshInstance, StandardMaterial,
           Texture, Color, BlendState, PlaneGeometry, PIXELFORMAT_RGBA8,
           FILTER_LINEAR, CULLFACE_NONE, BLENDEQUATION_ADD, BLENDMODE_ONE,
           BLENDMODE_SRC_ALPHA, BLENDMODE_ONE_MINUS_SRC_ALPHA };
         export { main };
applied: window.__ssPc =
```

The search text survives its own replacement, so the patch needs the `applied`
marker to stay idempotent on a second pass — the same mechanism the existing
`reseat()` patch uses. (The other patches self-destruct, because their search
text does not reappear in the output.)
`VIEWER_ENGINE_PATCH_COUNT` goes 3 → 4, so a bundle that stops matching produces
the existing non-fatal `console.warn` at export time.

The numeric constants are published rather than hardcoded: their values are
stable but not contractual, and they cost nothing in the same object.

### 3. `src/viewer-companion/portal-markers.ts` — new

Exports `markerStyle` (tooltip + hit-target CSS) and `markerRuntime` (plain
function declarations, **not** an IIFE) so it can be interpolated inside the
portals companion's IIFE. This is the `annotation-gallery.ts` →
`annotation-links.ts` idiom.

It owns: the canvas-drawn texture, the shared plane mesh, the material, the
layer, one entity per portal, the hit-target DOM, and the tooltip DOM.

### 4. `src/viewer-companion/portals.ts` — edited, ~15 lines

Splices `markerStyle` into its `<style>` and `markerRuntime` into its IIFE,
calls `buildPortalMarkers()` once the app handle is captured, and calls
`refreshPortalMarkers()` from the places it already owns: `applyActive()` (the
active scene changed) and the transition arm / disarm path.

The marker code lives *inside* that IIFE because `activeIndex`, the transition
state and the app handle are closure variables there; reaching them from a
separate companion would mean inventing a bridge. It lives in its *own file*
because `portals.ts` is already 2236 lines.

## Runtime behaviour

### Payload

**Unchanged.** `data.portals[i]` already carries `position` (the portal centre,
which is the editor gizmo's position), `front` and `back` scene indices.

### Build — once, when the portals companion captures the app handle

Bail out silently if `window.__ssPc` is absent, if the `World` layer cannot be
found, or if a 2D canvas context is unavailable. Otherwise:

- **Layer.** One `Layer('PortalMarkers')` inserted at
  `layers.getOpaqueIndex(World) + 1` and appended to the camera entity's
  `camera.layers`. There is no overlay layer — that is what makes occluded
  icons disappear.
- **Texture.** One 256×256 canvas (over 5× the icon's 48px screen size, so it
  stays crisp at a 3× device pixel ratio): black disc, white ring, and the door glyph traced from
  `src/ui/svg/portal.svg` — a `1.5`-radius rounded rect stroked at width 2 in a
  38-unit box, with a filled `r=1.2` knob dot at `(23, 19)` — scaled into the
  disc. Before upload, every pixel with `a < 255` gets `rgb` forced to white, the
  same edge-blending fix the viewer applies to hotspot textures.
- **Material.** One `StandardMaterial`: `emissiveMap` and `opacityMap` both the
  texture, `alphaTest 0.01`, standard src-alpha blend, `cull: CULLFACE_NONE`,
  lighting off, `depthTest: true`, `depthWrite: true`. It carries the viewer's
  near/far depth-clamp chunk under `litUserMainEndVS` in **both** `shaderChunks.glsl`
  and `shaderChunks.wgsl`, so the quad is never plane-clipped on either backend.
  The emissive colour is `.gamma()`-corrected when `viewer.cameraFrame != null`,
  matching how the viewer treats annotation hotspot colours.
- **Mesh.** One shared `Mesh.fromGeometry(device, new PlaneGeometry({ widthSegments: 1, lengthSegments: 1 }))`.
- **Entities.** One per portal, all created up front, visibility driven by
  `enabled`. Each gets a hit-target `div` in our own container on `document.body`.

### Per frame

One `app.on('prerender')` handler total. For each **enabled** marker:

1. Transform the centre by the camera's `viewMatrix`; if `z >= 0` the marker is
   behind the camera — hide its DOM and skip it.
2. `entity.setRotation(camera.getRotation())` then `entity.rotateLocal(90, 0, 0)`
   (the plane geometry lies in XZ).
3. `entity.setLocalScale(s, s, s)` with `s = markerScale(MARKER_SIZE, canvas.clientHeight, projectionMatrix.data[5], -viewZ)`.
4. Position the hit-target at `camera.worldToScreen(centre)`, and reposition the
   tooltip if this marker owns it.

Only the active-scene subset is iterated, so the cost is proportional to the
portals in the current scene.

### Visibility

A marker is enabled iff **both** hold:

- its portal touches `activeIndex` (`portalsForScene`), and
- `markerVisible({ noui, cameraMode, transitionActive })`.

| input | source |
| --- | --- |
| `noui` | `window.sse.config.noui`, fixed per page load |
| `cameraMode` | the companion's existing `cameraMode:changed` listener; `'anim'` hides |
| `transitionActive` | the existing tile / defocus arm and disarm |

Explicitly **not** driven by `controlsHidden` or `gamingControls` — that is the
whole divergence from annotations, and the reason this cannot reuse
`Annotation.opacity`.

Every visibility change sets `app.renderNextFrame = true`, because the viewer
renders on demand.

### Click, hover and tooltip

- The hit-target is a transparent `(MARKER_SIZE + 8)px` square with
  `transform: translate(-50%, -50%)` and `cursor: pointer`. It lives in **our
  own** container on `document.body`, never in `#annotations`, whose `display`
  the viewer's `Annotations` manager toggles.
- `pointerenter` / `pointerleave` set a hover flag; the material's emissive
  switches between `MARKER_COLOR = Color(0.85, 0.85, 0.85)` and
  `MARKER_HOVER_COLOR = Color(1.0, 0.4, 0.0)` — the viewer's own hotspot and
  hover accents — and requests a frame. Both are `.gamma()`-corrected alongside
  the base colour when `viewer.cameraFrame != null`.
- `click` opens our tooltip div with the localized string. At most one is open.
  It closes on a click elsewhere in the document, on a scene switch, and when
  its marker becomes hidden.
- Tooltip placement mirrors the viewer's: to the right of the icon by default,
  flipped to the left when it would overflow the right edge, clamped to the
  viewport with an 8px margin, with the arrow pointing back at the icon.

## Localization

The tooltip string ships as a 9-language table inside the runtime, keyed by
primary language subtag — the same shape and language set as `DEFAULT_MESSAGES`
in `portals.ts` and `galleryLabels` in `annotation-gallery.ts`: `en, de, es, fr,
ja, ko, pt, ru, zh`. This is viewer-side, so nothing is added to
`static/locales/*.json`. Translations are machine-assisted and flagged for
review.

## Build traps this code must respect

Both have bitten this repo before:

- Template literals under `src/viewer-companion/` have their **backslash escapes
  eaten at build time**. The runtime must contain no backslashes anywhere — no
  regex literals, no `\n` inside strings. Unicode glyphs are written literally.
- The companion body is itself a template literal, so **no backticks** may appear
  in its comments.

## Error handling

Every failure path is soft and leaves the rest of the export working:

| failure | behaviour |
| --- | --- |
| patch anchor gone | `patched < VIEWER_ENGINE_PATCH_COUNT` warns at export time; `window.__ssPc` absent at runtime; build returns early |
| `World` layer not found | build returns early rather than guessing a layer index and drawing icons in front of the splats |
| no 2D canvas context | build returns early |
| camera entity not found | build returns early |

## Testing

**Unit — `test/portal-marker.test.ts`:**

- `portalsForScene`: portal on `front`, on `back`, on neither, portal with a
  `null` side, empty list.
- `markerScale`: monotonic in `viewDepth`; invariant when canvas height and
  depth scale together; reproduces the viewer's value for a known input.
- `markerVisible`: each suppression flag independently and in combination; and
  explicitly **not** suppressed by `controlsHidden` / `gamingControls` inputs.
- `resolveMarkerTooltip`: exact locale, region subtag falling back to base
  (`fr-CA` → `fr`), unknown locale → English, empty/missing input → English.

**Injection — extend existing suites:**

- `test/viewer-engine-patch.test.ts`: the new patch applies once, is idempotent
  on a second pass, and the count is bumped.
- `test/portals-injection.test.ts`: the marker style and runtime appear in the
  injected HTML when portals exist, and do not when they do not.

**E2E — release build, ZIP export with portals:**

1. Icon appears at each portal centre in the start scene, at the gizmo position.
2. Occlusion: fully hidden behind a solid wall; partially dimmed through a thin
   haze.
3. Visible in orbit, walk and fly — including **while moving with gaming
   controls on**, where annotations vanish.
4. Hover tints; click opens the tooltip; click elsewhere dismisses it.
5. Crossing a portal swaps which icons are shown, and closes an open tooltip.
6. Hidden during a tile transition and during a defocus transition.
7. Hidden in `cameraMode === 'anim'` playback.
8. Hidden under `?noui`.
9. Server-side export (`server/`, after a `dist-shared` rebuild) produces the
   same result as the local writer.

## Deployment note

`viewer-engine-patch.ts` and the companion chain are compiled into `dist-shared`
for the export server, and `portal-markers.ts` is picked up transitively via
`splat-export-core.ts` → `portals.ts`. **`dist-shared` must be rebuilt** before
server-side exports carry the feature.

## Residual risks

- **Unclickable under pointer lock.** With gaming controls on in walk/fly the
  pointer is locked, so no DOM element can receive a click. The icon stays
  visible, which is the point, but the tooltip is reachable only in orbit mode
  and in click-to-walk / click-to-fly. A crosshair-style 3D pick would be needed
  otherwise; out of scope.
- **Coverage-based, not depth-based occlusion.** A portal centre sitting inside
  a very sparse region shows a partially-dimmed icon rather than a cleanly
  hidden one. This is exactly the behaviour the viewer's own annotations have.
- **Patch fragility.** The publish patch depends on the bundle staying
  unminified with module-scope class names. It has held across every
  splat-transform bump so far, and the failure mode is "no icons", not a broken
  export.
