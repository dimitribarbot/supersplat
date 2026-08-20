# Dropped texture loads render as permanently black blocks (2026-08-20)

Field report: on a Redmi Note 9S over remote debugging (Brave inspector), the
network panel fills with `net::ERR_FAILED` rows for scene block webps and the
portal scenes come up incomplete / black. ~714 requests, 62.7 MB transferred,
135 MB of resources.

**Verdict: attaching the inspector is the trigger.** The same device with no
inspector attached drops nothing, and the underlying engine bug reproduces on
upstream builds and the public supersplat website, so it is upstream's to fix.
What shipped from this investigation is the diagnostic that established that —
not a fix. Evidence below.

## What the errors are

Line numbers in the console map exactly onto the unminified viewer bundle that
`@playcanvas/splat-transform` bakes (extracted from the `var index = "..."`
string literal in its `dist/index.mjs`):

| Console | Bundle | Meaning |
| --- | --- | --- |
| `index.js:17214` | `xhr.send(postdata)` in `pc.Http.request` | the engine's texture XHR (`ImgParser._loadImageBitmap`, `responseType: 'blob'`) |
| `index.js:37986` | `console.error` in `ResourceLoader._onFailure` | the `<url>-texture` key is `url + type`, not a real URL |

`Http._onError` emits the literal string `Network error` only when
`xhr.status === 0`, so these died at the network layer — not on an HTTP status.

The `206 (Partial Content)` shown against a failed row is **not** something the
app asked for: there is no `Range` / `bytes=` anywhere in the bundle. It is
Chromium's HTTP cache issuing a range-completion for a truncated cache entry and
then failing to finish it — a cache/storage-pressure signature.

The successful `fetch` rows for the *same* URLs (initiator `index.html?…`) are
our own cache warming, `warmUrls()` in `src/viewer-companion/portals.ts`.

## Why one dropped request costs a black region

`GSplatSogParser.loadTextures` (engine, still present in playcanvas 2.21.1):

```js
await Promise.allSettled(promises);   // results NEVER inspected
…
data.means_l = textures.means[0].resource;   // undefined when that webp failed
…
callback(null, resource);                     // reported as a SUCCESSFUL load
```

Consequences:

1. the block is built from null textures and renders black / missing;
2. no error reaches `GSplatAssetLoader._onAssetLoadError`, so its block-level
   `maxRetries = 2` and `_failed` bookkeeping never engage — the block is never
   re-fetched, permanently, for the rest of the session.

The texture itself has already retried: `AppBase.init()` calls
`loader.enableRetry()` (default 5) which reaches `ImgParser.maxRetries`. Getting
here means six attempts failed.

## Field result (2026-08-20, Redmi Note 9S, `?loaddiag`)

**Attaching DevTools is the trigger, not merely an amplifier.** Measured on the
same device, same project, same build:

| Session | Badge |
| --- | --- |
| no inspector attached | `drops 0 tex / 0 blk` |
| Brave remote inspector attached | `drops 8 tex / 2 blk` |

Also reproduced against the **upstream** repo and the public supersplat website,
so nothing about this fork — in particular not our distance-2 cache warming —
is implicated.

This reverses the pre-measurement reading in the analysis above, which called
debug mode an amplifier of real device pressure. It is the pressure.

Most likely mechanism (consistent with the evidence, not directly proven): with
the Network panel open Chromium retains response bodies so they can be
inspected, and the engine's texture loads are `responseType: 'blob'`. On a 4 GB
phone that extra retention is enough for blob allocation to fail, which surfaces
as `xhr.status === 0`. It fits the asymmetry seen in the console — only the
engine's blob XHRs failed, while our `fetch(...).arrayBuffer()` warm of the very
same URLs succeeded.

One device and one project, so this is not proof that no phone ever drops a load
in production. It does mean the reported black scenes were an artefact of
measuring, and that the swallowed-rejection bug below is the thing worth fixing —
not the network.

## What changed

Only the diagnostic survived. The engine fix was written, tested and verified
against the real baked bundle, then **deliberately dropped** once the field
result landed — see "Decision" below.

1. **`src/portal-preload.ts`** — new pure `warmConcurrency(loadFailures)`: `0`
   once the device has dropped anything, else `4`. Warming is optional traffic;
   a cold crossing costs the loading overlay, a dropped block texture costs a
   black region. Gates both `warmFrontier` (so the lod-meta → block-meta walk is
   skipped too) and `warmUrls`.

   Device class is not an input. An earlier revision throttled healthy phones to
   1, on the theory that our own warming created the pressure; the measurement
   above disproved that — an undebugged phone warms at 4 and drops nothing. The
   `isMobile` parameter briefly survived the revert "in case evidence arrives",
   which is just an untested branch waiting to rot, so it went too.

2. **`src/viewer-companion/portals.ts`** — a drop counter published as
   `window.__ssLoadFailures`, fed by the asset registry's `error` event, so it
   needs no engine patch and works against a stock bundle. `?loaddiag` mounts a
   fixed badge reading `drops N`, rendered at zero on load so an absent badge
   means "param not applied", never "no failures". This is the only way to see
   the problem on a phone with no inspector attached.

   It counts dropped *texture loads*, not ruined blocks — a block ruined by the
   upstream bug reports no error at all, so the texture count is the closest
   honest proxy. Non-zero means "this session is dropping loads and some region
   may be black", not "N regions are black".

## Decision: the engine fix is upstream's to make

A ninth export-time patch was built and verified (9/9 against the real bundle):
capture the `allSettled` results and, *after* the existing `_shouldAbort` branch,
release the block's texture assets and `callback(err)` — handing the block back
to `GSplatAssetLoader`'s retry + `_failed` path instead of rendering it black.

It was dropped because the trigger turned out to be debug-only. Carrying it would
mean re-verifying a ninth byte-exact anchor on every splat-transform bump, in a
file whose header currently promises that all its patches target the viewer *app*
(4-/8-space indented) rather than the engine — a promise that patch would have
been the first to break. Not worth it for a fault no production user hits.

If a `?loaddiag` badge ever comes back non-zero in an **undebugged** session, the
patch is the fix, and this memo plus git history for
`fix/texture-load-failure-handling` has the exact anchor and replacement text.

## Re-running the field check

Load the URL on the phone with `?loaddiag` appended and read `drops N`. Compare a
run with no inspector attached against one with it attached — that pairing is
what identified the trigger; either number alone proves nothing.
