# (4) Clamp the start scene's LOD range before the first frame

Status: IMPLEMENTED 2026-08-15 — `src/viewer-companion/early-lod-clamp.ts`,
injected on the streaming export path only (`injectEarlyLodClamp` in
`src/splat-export-core.ts`). 12 unit tests run the emitted runtime against a
fake that reproduces the engine frame order. **RUNTIME E2E STILL OWED** (release
build, cold cache, desktop + real phone) — see "Verification" below.
Prerequisite reading: `docs/superpowers/2026-08-15-viewer-load-critical-path-findings.md`.
Do this one FIRST — it is the largest win of the three and it changes the
measurements the other two are judged against.

## Static analysis confirmed against the shipped bundle (implementing session)

Every load-bearing claim below was re-checked in the extracted
`@playcanvas/splat-transform` 3.1.7 viewer, not taken on trust:

- `App.tick` fires `frameupdate` → `update()` → `framerender` (viewer.js:50177/50184),
  and `GSplatComponentSystem`'s constructor hooks `framerender` →
  `gsplatDirector.updateStreaming()` (65045/65048). No other synchronous path
  reaches `updateStreaming`.
- `main()` never awaits `gsplatLoad`: it kicks off the three loads and returns
  `new Viewer(global, …)` synchronously (89823), and `Viewer`'s constructor
  assigns `this.global = global` as its first statement (88253). So
  `window.__supersplatViewer.global.app` is published a microtask after main()
  resolves, long before the octree lands.
- The gsplat entity is built inside `asset.on('load')` (89587-89596) — a
  macrotask, so always between ticks.
- `comp.resource.octree.lodLevels` is the right path (`GSplatOctreeResource`
  58034-58041), and the `lodRangeMin/Max` setters propagate to `_placement`
  (62608-62622), which `_onGSplatAssetLoad` has already created (62887).
- `GSplatManager.update()` calls `updateStreaming()` *before*
  `fireFrameReadyEvent()` (62126-62170), so the range reopen at the ready gate
  always queues its blocks before `frame:ready` reports `loading`. No premature
  reveal is possible from the reopen transient.
- Detaching from inside the handler is safe: PlayCanvas `EventHandler.off`
  copies the active callback list when called during `fire`.
- `portals.ts`: `start()` waits on `viewer.cameraManager` (1026), `pinDesired`
  is `pinReady`-gated on `firstFrame` (1963), `applyStartFloor` only runs from
  `pinDesired` (2065) and `scheduleRefine` only on crossings (317). All strictly
  after this companion has detached — re-read as the memo asked, still holds.

## What was built beyond the sketch

- Both hooks, not one: the parse-time rAF poll is registered before
  `app.start()`, so it runs ahead of `App.tick` within a frame — one notch
  earlier than `frameupdate`. Both call the same idempotent one-shot.
- `comp.resource === null` means "asset not resolved yet", not "no octree", so
  it keeps waiting instead of detaching and forfeiting the clamp.
- Bounded in FRAMES (18000, ~5 min), not wall-clock: a backgrounded tab fires
  no rAF, so a time cap could expire while nothing was being selected and then
  hand the unclamped pyramid to the first frame after the user returns.
- `?fullload` stands the companion down entirely — that flag exists to reveal
  only once full quality has loaded, which is the one thing a coarse-only clamp
  must not fight. It returns before registering anything, so it is a silent
  no-op, not an error path. The param is read exactly as `index.html` reads it
  (`new URL(location.href).searchParams.has('fullload')`), not by substring: a
  `?content=fullload.json` would otherwise switch the clamp off and quietly
  restore the slow load.
- Injected on the streaming path only: SOG/PLY package and single-file HTML
  exports have no octree for it to act on.

## Problem

The exported viewer downloads the **entire LOD pyramid** before its first
reveal — 120.6 MB measured on maison_bueil, where upstream intends the coarsest
level only (8.4 MB). Worse, `app.scene.gsplat.splatBudget` is `0` for that whole
window, so the engine's budget balancer is disabled and the streaming is
unbounded — on mobile that is both the data cost and the memory pressure.

Cause: `GSplatComponent` defaults to `_lodRangeMin = 0`, `_lodRangeMax = 99`.
The placement is created in `_onGSplatAssetLoad` and joins the layer on
`addChild`, both synchronously inside the viewer's own `asset.on('load')`
handler. The viewer's coarse-only clamp
(`lodRangeMax = lodRangeMin = lodLevels - 1`) only runs inside the
`Promise.all([gsplatLoad, skyboxLoad, collisionLoad])` handler — i.e. after the
collision binary has downloaded. By then the first `updateLod` has long since
requested everything.

## What does NOT work: clamping late

Narrowing the range after the fact cannot undo the requests.

`decrementFileRef` does clear `pending`, but `pending` was only 2 of the 23
entries in the field log. The other 21 were `prefetchPending`, and that set has
**no range-driven removal path**. Every reference to it:

- added in `prefetchNextLod`
- removed in `pollPrefetchCompletions` — only when the resource has *arrived*
- cleared in `destroy()` and `_onDeviceLost()`

and `pollPrefetchCompletions` actively re-issues the load on every poll:

```js
for (const fileIndex of this.prefetchPending) {
    this.octree.ensureFileResource(fileIndex);   // re-issued every poll, forever
    if (this.octree.getFileResource(fileIndex)) { _tempCompletedUrls.push(fileIndex); }
}
```

So once a block enters `prefetchPending` it stays there, and keeps being
re-requested, until it lands. A late clamp reclaims 2 blocks out of 22. Dead end
— do not spend time here.

## What does work: clamping before the first `updateLod`

The engine's tick order (`App.tick`) is:

```js
this.fire("frameupdate", ms);      // ①
this.update(dt);
this.fire("framerender");          // ② GSplatComponentSystem listens HERE
if (this.autoRender || this.renderNextFrame) this.render();
this.fire("frameend");
```

`GSplatComponentSystem`'s constructor does
`app.on("framerender", this.onFrameRender)` → `gsplatDirector.updateStreaming()`,
which is where LOD selection and the file requests happen. **`frameupdate` fires
before any LOD selection in the same frame.**

The race is therefore guaranteed-winnable. The gsplat entity is created inside
an HTTP load callback — a macrotask, which can never interrupt the synchronous
frame tick — so the entity always appears *between* ticks. The next tick then
runs our `frameupdate` handler before that tick's `framerender`.

## Sketch

```js
const app = window.__supersplatViewer.global.app;   // available as soon as main() resolves
const clamp = () => {
    const comp = app.root.findComponent('gsplat');
    if (!comp) return;                               // entity not created yet
    const levels = comp.resource?.octree?.lodLevels;
    app.off('frameupdate', clamp);                   // one-shot, either way
    if (levels) comp.lodRangeMin = comp.lodRangeMax = levels - 1;
};
app.on('frameupdate', clamp);
```

Reachability matters here: `window.__supersplatViewer = viewer` is published by
`splat-export-core.ts` right after `main()` resolves, and `Viewer.global` is a
public field set in its constructor — so `global.app` is in hand long before the
octree asset loads. **Do not use `getApp()` from `portals.ts`**: it resolves
through `debugPanel._global.app` / `navCursor.app`, both of which are created
inside the very `Promise.all` this task is trying to get ahead of.

`comp.lodRangeMin`'s setter propagates straight to `_placement`, which already
exists by the time our handler runs.

## Expected win

120.6 MB → 8.4 MB before the reveal on maison_bueil (14×), plus the reveal
arrives sooner so `splatBudget` starts bounding residency sooner. After the
reveal, `applyPerfSettings` opens the range to `[0, 1000]` as designed and the
budget (1–4 M splats) caps what is actually fetched — so most of the 112 MB is
never downloaded at all rather than merely deferred.

## Risks / must-handle

- **Non-streaming exports.** SOG/PLY exports have no `octree`, so `levels` is
  undefined. The sketch above detaches unconditionally, which is deliberate —
  without that the handler polls `findComponent` every frame forever.
- **Do not fight `applyPerfSettings`.** It opens the range at the ready gate;
  that is the desired behaviour, and our one-shot has detached by then. The
  viewer's own late clamp becomes an idempotent no-op.
- **Portal exports.** Only the start entity exists when this fires (extra scenes
  are loaded by the portals companion's `start()`, which is itself gated behind
  `cameraManager`), so `findComponent('gsplat')` is unambiguous. The one-shot
  detach keeps it that way.
- **Interaction with `portals.ts`'s floor machinery.** `canonicalFloor(0)` /
  `applyStartFloor` own scene 0's `lodRangeMin` after the reveal. This task only
  touches the pre-reveal window and detaches before any of that starts, but
  re-read `applyStartFloor` before wiring, and check that `scheduleRefine`'s
  "startup is unaffected" comment still holds.
- **Release build E2E.** Stringified companion helpers minify differently; per
  house rule, always E2E a release build, and on a real phone.

## Classification for the implementing session

Bounded — a new small module under `src/viewer-companion/`, injected via
`insertBeforeBodyClose` from `src/splat-export-core.ts` alongside the existing
companions (`injectPoster`, `injectQualityMode`, `buildPortalsInjection`).
Upgrade to architectural if it turns out to need coordination with
`quality-mode.ts` or `portals.ts` rather than standing alone.

Reminder: companion bodies are template literals — **no backslash escapes**
(they are cooked away at build time); use string ops only.

## Verification

Unit-testable part is thin (the clamp decision is three lines). The real proof
is runtime, on a release build, cold cache:

1. Re-run the 250 ms `world.pendingLoadCount` poll from the findings memo. Peak
   should be ~3 (2 coarsest blocks + environment) instead of ~23.
2. DevTools network total before `firstFrame` should be ~8 MB, not ~120 MB.
3. Time to the ready gate should drop substantially on both desktop and mobile.
4. Confirm the scene still reveals at full quality *after* the gate (the budget
   balancer takes over) — a regression here would look like a permanently blurry
   scene.
