# (3) Make the exported viewer's loading bar appear immediately and never regress

Status: **DONE 2026-08-16** — implemented, code-reviewed, and field-confirmed
working by the user. Prerequisite reading:
`docs/superpowers/2026-08-15-viewer-load-critical-path-findings.md`.

Shipped as `src/viewer-companion/loading-bar.ts` +
`injectLoadingBar`/`collisionBinaryBytes` in `src/splat-export-core.ts`, injected
on **all three** HTML export paths. 24 tests in `test/loading-bar.test.ts`.

## Re-measurement that set the scope

Re-measured before starting, as this memo required. With gzip (`a951a4d`) and
the early LOD clamp (`5447039`) both live, lauterbrunnen still takes **~3 s on
mobile** from poster to bar; the backwards-stepping bar is no longer reproducible
in the field. That killed the memo's original plan on the spot: the remaining
wait is now almost entirely **the 11.2 MB gzipped collision binary**, and
`world.pendingLoadCount` counts gsplat blocks only — so the "optional third step"
as designed would have filled the bar during the small coarse-level download and
then parked it for most of the wait.

The user chose the collision-aware option explicitly, and signed off on the fetch
wrapper on the condition that it be a strict pass-through.

## What shipped, vs. what this memo originally designed

**Kept:** the CSS instant-0% paint (verbatim, including the no-`!important`
reasoning and the `:empty::after` self-clearing placeholder), and the
running-maximum clamp.

**Changed, and why:**

1. **`app.systems.gsplat.on('frame:ready')`, not a walk through
   `gsplatDirector.camerasMap -> layersMap -> gsplatManager.world`.**
   `GSplatManager.fireFrameReadyEvent()` fires `frame:ready` on
   `app.systems.gsplat` **every frame from the first one** — the viewer just does
   not register its listener until the ready gate. So the companion needs no
   traversal at all: it subscribes to the same event the viewer eventually uses
   and receives `(camera, layer, ready, loading)` directly. The traversal in
   `portals.ts` is unnecessary here.

2. **Drives `global.state.progress`, not the DOM.** `state` is the `observe()`
   Proxy, so a single write repaints the bar through the viewer's own painter
   **and** advances the poster's progressive unblur (`initPoster`'s
   `blur = (100 - progress) * 0.4px`). Both are otherwise frozen until the gate.
   This is a strictly better perceived-speed result than DOM-poking for the same
   work, and it keeps one painter. Verified `state.progress` has exactly two
   consumers (poster blur, loading bar) and no reader in the reveal logic, so
   driving it cannot perturb the gate.

3. **A collision term, fed by a parse-time `window.fetch` wrapper.** The exporter
   bakes the **raw** byte length of `index.voxel.bin` into the companion
   (`collisionBinaryBytes(memFs)`); the wrapper tees the response with `clone()`
   and counts decompressed stream bytes against it.
   **The total cannot come from `Content-Length`:** the publish path gzips
   `.voxel.bin`, so that header reports the compressed size while the stream the
   browser hands back is already decompressed — a 3.53x skew.

4. **50/50 blend, and the whole display capped at 99 until the reveal.** Two
   independent downloads gate the reveal and only one has a knowable byte total,
   so the range is split evenly rather than inventing a weighting; which term
   dominates is scene-dependent (collision on an outdoor scan, roughly the
   reverse indoors).

   The cap applies to **incoming upstream values too**, not just the companion's
   own gauge — see the correction below. It costs nothing, because
   `#loadingWrap` is hidden the instant `loaded` flips, so the bar never needs
   to display 100 at all.

5. **Stands down entirely under `?noui`.** initUI hides all UI on that path; a 0%
   bar flashing before that runs would be a regression on chrome-less embeds.
   Read via `searchParams.has`, never a substring (the `?fullload` trap from the
   (4) memo). `?fullload` is deliberately NOT stood down for — the gauge is still
   correct there.

## Correction: "the bar has exactly one data source" is STREAMING-ONLY

The original diagnosis (and the first version of this memo) said the bar's only
data source is `readyHandler`. That holds on the **streaming** path only, because
`GSplatOctreeParser.load` calls `http.get` without `progress: asset` and the
engine gates asset progress events on that option.

On **SOG / package / single-file** exports there is a second writer:
`downloadArrayBuffer` fires `asset.fire('progress', received, total)` per chunk,
`loadGsplat`'s handler turns that into `state.progress`, and it reaches 100 as
soon as the content bundle lands — while the collision binary may still have
seconds to run. On a single-file export `content-length` is 0, so
`Math.min(1, received / 0)` is 1 and it hits 100 immediately.

Consequence, caught in review: a running-maximum clamp that let 100 through would
**pin the bar at a finished-looking 100% for the whole collision download**, which
reads as a hang. Hence the cap now applies to incoming values as well, lifting to
100 only at `loaded:changed`. Verified against the engine
(`playcanvas.dbg.mjs` `downloadArrayBuffer`) and the baked viewer
(`loadGsplat`), not inferred.

## The fetch wrapper, in detail

The one genuinely risky part, so the constraints it holds to:

- **Installed only when the export actually has collision** (`COLLISION_BYTES > 0`)
  and no `?collision=`/`?voxel=` override is present — an override points at a
  file whose size the exporter cannot know, so the collision term is dropped and
  the gsplat blocks own the whole range.
- **Strict pass-through**: returns `originalFetch.apply(this, arguments)`
  untouched. `this` is passed through rather than forced to `window`; WebIDL
  substitutes the global for a null/undefined receiver, so a bare `fetch(url)`
  (which is what `loadVoxelCollision` does) works, and any other receiver fails
  exactly as it would have without the wrapper.
- **Counts on a `clone()`**, never on the response the viewer consumes.
- **Counting is registered SYNCHRONOUSLY**, before the wrapper returns, so it
  runs ahead of `loadVoxelCollision`'s own `await` continuation and the body is
  still undisturbed when `clone()` is called. This ordering is load-bearing:
  deferring it would make `clone()` throw (swallowed, silently killing the
  collision term), and reading `response.body` instead of the clone would
  disturb the body the viewer is about to read — rejecting `collisionLoad` and
  the gating `Promise.all`, so **the scene would never reveal at all**.
  `test/loading-bar.test.ts` models the browser's disturbed-body rules and fails
  on exactly that mutation (verified by making it).
- **Uninstalls at the earliest possible moment** — synchronously, the instant a
  `.voxel.bin` request is seen — and again on `loaded:changed`, and again on a
  bounded frame countdown that keeps running after attach. That last path exists
  because a collision JSON that 404s makes `loadVoxelCollision` throw *before* it
  requests the `.bin`, so neither of the first two would ever fire.
- Accepts a string, a `Request` (`.url`), or a `URL` (stringified).
- Everything is wrapped in try/catch: a failure anywhere costs progress
  reporting and nothing else.

**Tee memory, checked:** `clone()` tees the decompressed body (39 MB raw for
lauterbrunnen), but the counting reader pumps on a microtask chain and discards
each chunk immediately, so the tee's lag buffer stays small; the viewer's
`arrayBuffer()` allocates the full buffer either way. The only pathological case
would be the pump stalling mid-stream, which cannot happen — its only exits are
`done` and a rejected read. Worth recording given this repo's history with mobile
memory.

Portal scenes' `.voxel.bin` loads are unaffected: the wrapper is gone long before
the portals companion (firstFrame-gated) fetches them.

## Verification

- 33 tests in `test/loading-bar.test.ts`, run against the exact emitted string.
  The host registers a **viewer painter on `progress:changed` before the
  companion attaches**, mirroring `initUI` running inside `main()` while
  `window.__supersplatViewer` is published only after `main()` resolves — so the
  tests assert on what the user actually sees, and a companion that registered
  its clamp too early would fail.
- Full suite 890 pass, `tsc --noEmit` clean, lint 0, release build 0 TS-plugin
  errors, server suite 128 pass (parity guarantee intact).
- Runtime confirmed baked verbatim into `dist/index.js` and compiled into
  `dist-shared/viewer-companion/loading-bar.js` for the export server. The 155
  backslashes in the bundled segment are all `\n` — the bundler re-emitting the
  runtime's newlines, not cooked escapes.

## E2E

Field-confirmed working by the user 2026-08-16. Note the baked collision size
only reaches already-published scenes on **re-publish**.

Kept as the regression checklist for future changes here:

1. The bar is visible at 0% essentially with the poster.
2. It climbs steadily through the collision download rather than parking.
3. The poster unblurs progressively along with it.
4. It never steps backwards, including across the ready gate.

Two more cases worth one pass each:

5. **A package (ZIP) export with collision**, which is the path where the second
   upstream progress writer exists. Confirm the bar does not park at 99 for the
   whole collision download either — if it does, the 50/50 blend is the wrong
   shape for that path and the SOG term should feed the gauge instead.
6. **A scene that used to load instantly.** Every export now briefly shows a
   white bar and "0%" where previously nothing rendered at all. Expected, but
   it is a new visible artifact worth eyeballing once.

## Known upstream quirk, deliberately not fixed

`readyHandler` skips its update whenever `loading` happens to equal the loaded
count (`if (loading !== current)`), so the bar can occasionally skip a step.
Cosmetic, inside upstream code, and the running-max clamp does not make it worse.
