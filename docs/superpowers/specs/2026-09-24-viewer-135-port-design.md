# Exported viewer port to supersplat-viewer 1.35 — design

Date: 2026-09-24
Status: approved (brainstorming), ready for implementation planning

## Context

The upstream merge SuperSplat v3.3.0 -> v3.4.2 (branch
`feature/upstream-merge-v3.4.2`, merge in progress, uncommitted) brings
`@playcanvas/splat-transform` 3.4.2 -> 3.6.4. Upstream's single-sweep loader
(#1053) needs `sortMortonInterleaved`, which only exists from 3.6.1, and every
splat-transform >= 3.6.1 bundles `@playcanvas/supersplat-viewer` >= 1.32
(3.6.4 bundles 1.35.0). Staying on 3.4.2 is therefore not possible without
reverting upstream's loader.

supersplat-viewer 1.35.0 is restructured:

- The module exports `createViewer` instead of `main`. The standalone page calls
  `createViewer({ container: document.body, settings, ...options })` and discards
  the returned promise. `createViewer` returns a slim public `ViewerHandle`, not
  the internal `Viewer`.
- All UI markup moved from the HTML (53 KB -> 6 KB) into a JS string
  (`var uiHtml`) injected with `root.innerHTML` into a `div.sse-viewer` root.
  Every element id became an `sse-`-prefixed class.
- `annotation.activate` / `annotation.deactivate` / `annotation.navigate` are
  gone, replaced by `state.selectedAnnotation`, the `selectedAnnotation:changed
  (index, prev)` event and `Viewer.selectAnnotation(i | null)`.
- Collision was removed from the reveal gate (`Promise.all([gsplatLoad,
  skyboxLoad])`); collision is attached later via `attachCollision`.
- `voxelOverlay` is created lazily (first enable, never on WebGL); `navCursor`
  only exists with UI on; `config.noui` became `config.ui`.
- Annotation camera flights last 1.2-2.4 s (were 1 s).

Every fork companion finds the viewer through `window.__supersplatViewer`,
which was published by soft-replacing
`const viewer = await main(canvas, settingsJson, config);` in the HTML. That
line no longer exists, so with no port **every exported-viewer feature silently
dies**: portals, off-limits zones, annotation links / i18n / iframe API, quality
modes, loading bar, device fallback, XR floor grounding, poster keepalive,
brand override.

The full anchor inventory (fork `file:line`, old/new occurrence counts, new
replacement code) was produced during brainstorming and is the checklist for
the plan.

## Goal

Feature parity: every fork exported-viewer feature behaves on viewer 1.35 as it
does today on 1.31.2. Where 1.35 now does something natively, the fork's copy is
dropped only if the result is identical. One deliberate exception: the load
gate (see Loading bar).

## Non-goals

- Migrating companions to the public `ViewerHandle` (they need internals the
  handle does not expose: `cameraManager`, `inputController`, `voxelOverlay`,
  `cameraFrame`).
- Vendoring viewer 1.31.2.
- Removing `early-lod-clamp` (already redundant since 1.31.2; untouched beyond
  re-anchoring).
- Any change to the iframe API's postMessage protocol.

## Design

### 1. Viewer handle, engine patch, drift guard

- A new engine patch in `src/viewer-engine-patch.ts` appends
  `window.__supersplatViewer = viewer;` after
  `const viewer = new Viewer(global, gsplatLoad, skyboxLoad, collisionLoad);`
  (one occurrence in index.js). It runs synchronously before `initUI`, i.e.
  earlier than today's publish. Unlike the other patches, a miss on this anchor
  **throws** and fails the export: without it every companion is dead.
- The three HTML soft-replaces in `src/splat-export-core.ts` (`injectDeviceFallback`
  and the two portal/zones paths) and the portals idempotency check on
  `window.__supersplatViewer = viewer;` are removed.
- The `window.__ssPc` patch is re-anchored from `export { main };` to
  `export { createViewer };` (all 18 symbols are still unaliased at module
  scope).
- `VIEWER_ENGINE_PATCH_COUNT` 8 -> 9.
- `test/viewer-html-anchors.test.ts` is rewritten against 1.35: JS extraction
  marker `export { createViewer };`; pins the handle anchor, every `sse-`
  selector, event name and internal field the companions use at runtime, and
  the brand anchors in their escaped `uiHtml` form. Runtime drift, not only
  build-time strings, becomes a test failure.

### 2. Annotations

All listeners move to `selectedAnnotation:changed (index, prev)` on the
viewer's events (`index === null` = deselected).

- **annotation-links**: `.pc-annotation` -> `.sse-annotation`; activate /
  deactivate listeners -> one `selectedAnnotation:changed` listener. Chips keep
  their `stopPropagation` (the viewer now deselects on any click inside its
  root).
- **annotation-i18n**: selectors -> `.sse-annotation-title`,
  `.sse-annotation-text`, `.sse-annotationNavTitle`. The viewer re-shows the
  tooltip from its base-language copy on `loaded` / `controlsHidden` /
  `showAnnotations` / `cameraMode` / `gamingControls` changes with no event, so
  a MutationObserver on those nodes re-applies the translation whenever the
  viewer writes base text, skipping text the companion wrote itself (no loop).
- **iframe-api**: readiness = `state.loaded` (viewer commands throw before it);
  inbound navigate -> internal `viewer.selectAnnotation(i)`; outbound
  activate / deactivate messages driven by `selectedAnnotation:changed`;
  `config.noui` -> `!config.ui`. The postMessage protocol is byte-identical.
- **portals teleport guard**: `TELEPORT_GUARD_MS` 1250 -> 2650 (viewer max
  flight `ANNOTATION_MAX_DURATION` 2.4 s plus today's 250 ms margin over the old
  1 s flight). Re-selecting the same annotation flies without an event,
  so the companion wraps `viewer.selectAnnotation` to open the guard on every
  call; the event listener stays as a backup.

To verify first in implementation (the design depends on them):

- whether the viewer's own hotspot / nav-button clicks call
  `Viewer.selectAnnotation` or set `state.selectedAnnotation` directly. If
  directly, the wrap misses UI re-selects; fallback is a guard that re-arms
  while the camera is still moving;
- how the viewer writes tooltip text (`textContent` vs `innerHTML`), which the
  MutationObserver relies on.

### 3. DOM, CSS, brand, lang

- **quality-mode**: `#performanceModeRow` -> `.sse-performanceModeRow`, queried
  inside `.sse-viewer`. Injected CSS selector becomes
  `.sse-viewer .sse-settingsPanel > .sse-settingsGroup > .sse-settingsRow > div.ssQ`
  (specificity 0,5,1 beats the stock 0,4,1). The budget engine patch is
  unchanged.
- **poster keepalive**: `#application-canvas` -> `.sse-viewer > canvas`;
  `#poster` -> `.sse-viewer .sse-poster`; `--canvas-opacity` is read/set on the
  `.sse-viewer` root, not `documentElement`. The Android rule stands: never
  `opacity:0` a rendering canvas; cover it with the opaque poster.
- **brand**: `injectBrand` gains a JS pass over the `uiHtml` string in index.js
  (escaped `\"` form): badge SVG + label, panel logo
  (`sse-viewerLogo` / `<use href="#supersplatIcon" />`), `sse-title-name`,
  attribution inserted before `<div class=\"sse-infoGpu\">`. String operations
  only; no backslash escapes or backticks in companion template source.
  `<title>` stays an HTML patch. Runtime CSS -> `.sse-viewerBranding`,
  `.sse-viewerTitle > .sse-title-name`. Verify single-file HTML exports inline
  the same string, so one pass covers both export kinds. The stale
  `#supersplatIcon` comment in `brand.ts` is corrected (the symbol is now
  defined).
- **lang**: the viewer sets `root.lang` itself; confirm `injectViewerLang`'s
  value still reaches it and correct the stale comment in `viewer-lang.ts`.
- **loading bar**: selectors -> `.sse-viewer .sse-loadingWrap > .sse-loadingBar`,
  `.sse-loadingText`. **Follow upstream's load gate**: reveal after splats +
  skybox; the gauge tracks splats only; collision streams in afterwards. The
  50/50 splat/collision split and the collision-aware pre-gate gauge are
  removed. The instant 0% paint and never-regress clamp stay. Accepted
  consequence: walk mode can briefly run without voxel collision until it
  lands.

### 4. Portals and off-limits runtime timing

- **Late collision**: `inputController.collision` may land after `firstFrame`.
  Portals' scene-swap collision handling (`portals.ts` ~928 and the
  VoxelCollision grid reads) tolerates `null` and re-applies once collision
  lands; walk-permission checks likewise. Off-limits zones do not depend on
  voxel collision.
- **Lazy voxel overlay**: portals' overlay bookkeeping (`portals.ts`
  ~1062-1076) handles `voxelOverlay === null` and adopts the overlay once it
  exists; its `collisionOverlayEnabled` handler defers to the next frame so the
  viewer's own handler has created the overlay.
- **Internal field moves**: `v.debugPanel._global` -> `v.global`;
  `v.navCursor.app` -> `v.global.app` (device-fallback, portals);
  `window.sse.config.noui` -> `!window.sse.options.ui` (portal-markers).
- XR floor grounding (P2/P3) and off-limits reseat (P1) need no change of their
  own; they work again once the handle is published.

## Amendments from plan research

Reading the 1.35 source while writing the plan settled the two open questions
and simplified three items. The plan implements these, not the text above
where they differ:

1. **annotation-i18n uses a pre-UI hook, not a MutationObserver.** `createViewer`
   runs `initUI` synchronously right after `new Viewer(...)`, and `initUI`
   copies each annotation's title/text out of `global.settings.annotations`
   (`script.title = ann.title`). The handle-publish patch therefore also calls
   `window.__ssOnViewer(viewer)`, and the i18n companion translates the settings
   there. The viewer then renders the translated text natively everywhere,
   including its own repaints, so no DOM repainting is needed. The drift test
   pins "no await between `new Viewer` and `initUI`".
2. **Selection goes through `Viewer.selectAnnotation`: confirmed.** Hotspot
   clicks, the navigator chevrons, deselect-on-click and the public handle all
   call it through the instance at call time. So portals and the iframe API
   **wrap** it. That covers re-selecting the current annotation, which fires no
   `selectedAnnotation:changed`. No backup event listener is needed.
   annotation-links listens to `selectedAnnotation:changed`, because a re-select
   leaves its chip correct.
3. **Two guard durations, not one.** Reset/frame transitions keep the viewer's
   default 1 s, so `TELEPORT_GUARD_MS` stays 1250 for them. A new
   `ANNOTATION_GUARD_MS = 2650` covers annotation flights (1.2-2.4 s).
4. **Late collision and the lazy voxel overlay need no code change.**
   `initCollisions` already polls `inputController.collision` and re-syncs, and
   `refreshOverlay` already no-ops on a null overlay. The viewer builds the lazy
   overlay from the same collision instance portals mutates in place, so it
   shows the live scene. Only the `getApp`/`getState` field moves remain.
5. **Brand is ZIP-only.** `applyBrand` never runs on the single-file HTML path,
   so the JS pass patches `memFs['index.js']`. The rebranded panel icon takes
   1.35's stock logo size (56 px, column layout) instead of the old 20 px.
6. **The handle-publish miss throws at the export-core call sites.**
   `patchViewerEngine` stays pure and reports `handlePublished`; callers throw.
   This keeps the existing partial-bundle unit tests valid.

## Testing and merge gate

- Unit: existing companion / injector tests updated to 1.35 fixtures (`sse-`
  classes, `selectedAnnotation:changed`, escaped `uiHtml`). New tests: handle
  patch (applies once, idempotent, throws on miss), brand JS pass, i18n
  MutationObserver loop guard, portals `selectAnnotation` guard wrap.
- Drift guard: the rewritten `test/viewer-html-anchors.test.ts` against the real
  installed bundle.
- Automated gate before the merge commit: `tsc` clean; `eslint` clean; root and
  server vitest fully green including byte-parity and GPU suites; release build
  `exit=0` with zero `plugin typescript` lines.
- User E2E in Chrome on a release build via the export server: single-file HTML
  and ZIP exports; portal walkthrough (crossing, cross-scene annotation jumps,
  markers); off-limits walls; collision walk including immediately after reveal;
  annotations in another language, then H and UI-mode toggles (text stays
  translated); iframe annotation API from a parent page; brand override on ZIP;
  Perf / Normal / HD; poster and loading bar; VR/AR floor grounding if a headset
  is available.

## Delivery

The upstream merge and this port land as one two-parent merge commit on
`feature/upstream-merge-v3.4.2` (never squashed; see the never-squash rule),
including this spec and its plan. `main` fast-forwards to it after user E2E.
