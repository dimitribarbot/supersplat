# Exported viewer: what actually gates the loading bar (diagnosis)

Status: DIAGNOSIS COMPLETE 2026-08-15. Shared prerequisite reading for three
follow-up tasks, each with its own memo:

- `2026-08-15-early-lod-clamp.md` — (4) biggest win, do first — **IMPLEMENTED
  2026-08-15**, runtime E2E still owed; re-measure (2) and (3) against it
- `2026-08-15-per-scene-collision-params.md` — (2) architectural
- `2026-08-15-companion-driven-loading-bar.md` — (3) do last, re-measure first

One fix already landed from this diagnosis: gzip of `.voxel.bin` on S3 publish
(`server/src/s3.ts`), see "Already fixed" below.

Origin: field report 2026-08-15 — "the poster shows immediately but the progress
bar takes ~5 s on mobile / ~3 s on desktop" on
`.../public/lauterbrunnen/index.html` (no portals), versus ~3 s / ~1 s on
`.../public/maison_bueil/index.html` (4 portal scenes). Cold cache only
(reproduced in a Brave private window; warm cache is fast).

## How to read the viewer bundle

The exported viewer ships inside `@playcanvas/splat-transform`
(3.1.7 at the time of writing). Three string literals in
`node_modules/@playcanvas/splat-transform/dist/index.mjs` carry it — at the
time of writing lines 21309 (`index.css`), 21311 (`index.html`) and 21313
(`index.js` = PlayCanvas 2.20.6 + the viewer app). **Line numbers drift with
every bump; find them by grepping for `posterUrl` and `TRACEID_GPU_TIMINGS`.**
Extract with `JSON.parse` of each literal (they are escape-encoded — do not
try to read them in place):

```js
const l = src[lineNo - 1];
const lit = l.slice(l.indexOf(' = ') + 3).replace(/;$/, '');
fs.writeFileSync('viewer.js', JSON.parse(lit));
```

All symbol references below are to that extracted `viewer.js` / `index.html`.

## The gate

```js
Promise.all([gsplatLoad, skyboxLoad, collisionLoad]).then((results) => {
    …                                                    // ~120 lines of setup
    gsplatComponent.lodRangeMax = gsplatComponent.lodRangeMin = lodLevels - 1;
    …
    eventHandler.on('frame:ready', readyHandler);
});
```

That single `Promise.all` in the `Viewer` constructor gates **both**:

1. the coarse-only LOD clamp ("reveal once low lod has loaded for fastest
   possible reveal"), and
2. `readyHandler` — the loading bar's **only** data source.

It also gates `cameraManager`, `navCursor` and `debugPanel`, which is why
`getApp()` in `src/viewer-companion/portals.ts` cannot be used to reach the app
any earlier (it resolves through `debugPanel._global.app` / `navCursor.app`).
`window.__supersplatViewer.global.app` **is** available earlier — see the (4)
memo.

## Why the bar has no other data source

- `GSplatOctreeParser.load` (the parser for `lod-meta.json`) calls
  `http.get(url, { responseType: JSON })` **without** passing `progress: asset`.
  The engine only fires asset `progress` events when that option is present, so
  the `asset.on('progress')` callback wired up in `loadGsplat` is dead code for
  every streaming export. No progress at all during the octree download.
- `state.progress` starts at `0` and `observe()` fires `progress:changed` only
  when the value **changes**, so the first `frame:ready` — which always computes
  `0` — is swallowed. The bar stays invisible until progress ≥ 1.
- `#loadingBar` has no `background-image` in `index.css` and `#loadingText` is
  empty, so the markup is present from the first byte but renders nothing until
  JS paints it.

## Why progress can go backwards

```js
watermark = Math.max(watermark, loading);
current   = watermark - loading;
state.progress = Math.trunc(current / watermark * 100);
```

This is *drain-from-peak*, not loaded/total, and `loading` is
`world.pendingLoadCount` — a live instantaneous count summed over **all**
octree instances (`inst.pending.size + inst.prefetchPending.size +
(environment not yet placed ? 1 : 0)`). Any work queued after the peak pushes
the displayed percentage down. Confirmed in the field (see the log below):
`0` at 4455 ms → `16` at 4706 ms.

Ruled out as the cause: extra portal scenes. `loadScene` does
`liveApp.root.addChild(e)` then `e.enabled = (idx === activeIndex)`
synchronously, so scenes 1..N never join the world during the initial load —
the field log shows exactly one octree instance throughout.

## Root cause: the collision binary is on the critical path

```js
const loadVoxelCollision = async (jsonUrl) => {
    const metaResponse = await fetch(jsonUrl);        // index.voxel.json
    const metadata = await metaResponse.json();
    const binUrl = jsonUrl.replace('.voxel.json', '.voxel.bin');
    const binResponse = await fetch(binUrl);          // ← sequential, starts only now
    const buffer = await binResponse.arrayBuffer();
```

Two sequential round trips, the second of which was, before the gzip fix:

| scene | `index.voxel.bin` | `lod-meta.json` | octree nodes | grid extent |
|---|---|---|---|---|
| lauterbrunnen | **39,375,284 B** | 3.27 MB | 18,139 | 4435 × 3753 × 4426 |
| maison_bueil | **3,682,632 B** | 207 KB | 1,137 | 912 × 467 × 749 |

Both were served uncompressed (`application/octet-stream`; the CDN gzips text
types on the fly but not octet-stream — measured `lod-meta.json` 3.27 MB → 537 KB
and `index.js` 2.91 MB → 632 KB coming back `Content-Encoding: gzip`).

**Time to first bar ≈ time to download the collision binary.** The gsplat octree
resolves far earlier (37 KB–537 KB gz), so it is never the long pole. The
observed 1 s / 3 s desktop and 3 s / 5 s mobile all reconcile at ~100 Mbps once
the ~0.7 s (desktop) / ~2.5 s (mobile) fixed cost of downloading and parsing the
2.91 MB `index.js` is added.

lauterbrunnen's binary is large because collision is voxelised at
`voxelResolution: 0.05` over a 197 × 50 × 190 m outdoor scan — a
3948 × 1008 × 3792 grid, 5.1 M octree nodes. Five-centimetre collision
precision on a drone scan of a valley. The voxel-size slider already exists in
both export dialogs (0.02–0.5, default 0.05); 0.05 is simply a bad default at
that scale. That is task (2).

## Second consequence: the whole LOD pyramid streams before the reveal

`GSplatComponent` defaults are `_lodRangeMin = 0`, `_lodRangeMax = 99`. The
component builds its placement in `_onGSplatAssetLoad` and joins the layer on
`addChild`, both synchronously inside the viewer's own `asset.on('load')`
handler — long before the `Promise.all` clamp lands. The render loop is already
running (`app.start()` ran earlier in `main()`), so the first `updateLod` selects
and requests **every** block.

Measured for maison_bueil (summed `Content-Length` of every block file):

| level | blocks | bytes |
|---|---|---|
| L0 (finest) | 11 | 62.1 MB |
| L1 | 6 | 33.4 MB |
| L2 | 3 | 16.8 MB |
| **L3 (coarsest)** | **2** | **8.4 MB** |
| **full pyramid** | 22 | **120.6 MB** |

So the viewer downloads **120.6 MB** before the reveal where upstream intends
**8.4 MB** — 14×. And `app.scene.gsplat.splatBudget` is `0` until
`applyPerfSettings` runs at the ready gate, so the engine's budget balancer is
**disabled** for that entire window (the unbounded-streaming state
`portals.ts`'s ready-gate watchdog already warns about). After the reveal the
budget caps residency at 1–4 M splats, so most of that 112 MB would never be
fetched at all. That is task (4).

## Field log (desktop, Brave private window, maison_bueil)

Captured with a 250 ms poll over `world.pendingLoadCount`, printing
`pending.size + '+' + prefetchPending.size` per octree instance:

```
 956 'total=23' '2+21'      ← whole pyramid in flight (22 files + env, overlap double-counted)
1207 'total=20' '1+19'
…                            monotonic drain
4209 'total=3'  '0+3'
[portals] ceiling=… resident=[0,1,2,3] depths={"0":0,…} deviceFinest=0 active=0
4455 'total=0'  '0+0'      ← ready gate fires here
4706 'total=16' '8+8'      ← post-reveal refinement; invisible (readyHandler detached)
…
[portals] start-reveal gate opened via residency
[quality] watchdog armed via firstFrame
```

Exactly one instance the whole way through, and `prefetchPending` dominates
(21 of 23) — which is what makes a late clamp useless; see the (4) memo.

## Already fixed

**Gzip `.voxel.bin` on S3 publish** — `server/src/s3.ts`: `GZIP_EXTS`,
`shouldGzip()`, `gzipAsync()` (fflate async, level 6, off-thread so a 39 MB
buffer does not stall the job runner's progress stream), plus
`ContentEncoding: 'gzip'` on the `PutObjectCommand`. Publish-only by
construction — a ZIP downloaded and served statically has nothing to set the
header, so those bytes must stay raw. Tests in `server/test/s3.test.ts`.

Verified in production 2026-08-15 on a re-publish: the browser receives
`content-encoding: gzip` with `content-length: 11163399` for lauterbrunnen's
`index.voxel.bin` — **39,375,284 → 11,163,399 B (3.53×)**. Note `curl -sSI`
shows no encoding because curl sends no `Accept-Encoding`; `vary:
accept-encoding` confirms both representations. Already-published scenes only
benefit on re-publish.

## Open, not investigated

- Which of two mechanisms produces the visible mobile progress dip: discovery
  outrunning drain before the gate, or `loading` reaching 0 while `ready` is
  false so the gate is missed and work arrives afterwards. Same remedy either
  way (clamp the displayed value to its running max), so it was not chased.
- Whether `lod-meta.json` could be slimmed: `GSplatOctreeResource` discards
  `data.tree` immediately after construction (`this.data.tree = null`), and the
  tree is ~all of those 3.27 MB for lauterbrunnen.
