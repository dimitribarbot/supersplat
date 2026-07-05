# Streaming dark-blob fix — superspl.at-style progressive load

Date: 2026-07-04
Status: REVISED after diagnosis (evening 2026-07-04) — root cause is viewer UX,
not an engine bug; fix approved by Dimitri (poster + crossing-gate rework).
Sections below marked SUPERSEDED are kept for the diagnostic record.

## Problem

During a cold-cache load of a SOG LOD streaming export (single- or multi-scene),
large regions of the scene render as dark, garbled, blob-like splats until all
octree files finish downloading. The same artifact appears when crossing a
portal into a destination scene that has not finished streaming: some regions
are black/garbled while already-resident regions render at high quality. Once
downloads complete the artifact heals; warm-cache loads never show it.

Reference: `docs/superpowers/2026-07-04-upstream-blob-issue-draft.md` (evidence
gathered during portal-viewer E2E rounds 3–9; reproduces on a stock
single-scene export with no fork viewer code).

## ROOT CAUSE (diagnosed 2026-07-04, evidence-backed)

There is no engine bug. Demonstrated via an instrumented unminified-engine
harness plus an instrumented copy of Dimitri's real export:

1. A work-buffer detector (bake bookkeeping vs live sorted intervals) never
   fired — the engine only draws correctly baked splats. The stale/unbaked
   work-buffer hypothesis is FALSIFIED.
2. The stock viewer's coarse-LOD lock ENGAGES correctly in our shipped bundle
   (`coarse lock ENGAGED at level 3` logged), and the reveal gate
   (`ready && loading === 0`) fired exactly once, correctly, at
   coarse-complete (loading 22→0 monotonic over 15.4 s).
3. The black regions appear BEFORE the unlock — during the coarse-lock phase.

Mechanism: the coarsest LOD level is spatially chunked (~512K splats/chunk from
`chunkCount: 512`; 2 chunks for the repro house). While the lock holds, a
region whose coarse chunk has not arrived has NO data — the engine renders
nothing there and the scene background shows through the hole (black in
Dimitri's exports, grey in the synthetic repro). "Garbled" edges = giant
boundary splats of the loaded chunk against the void; missing
`GSPLAT_DEBUG_LOD` tint = no splats to tint. A 727K-splat indoor coarse level
looks near-sharp up close, which made the loaded half read as "high quality"
next to the black half.

superspl.at never *shows* this phase: its CDN delivers the few-MB coarse level
near-instantly AND gallery scenes ship a poster — the stock viewer's dormant
`initPoster` path (`#poster` element + `?poster=` param) blurs the poster by
`(100 - progress)` and holds the canvas at opacity 0 until `loaded` — that IS
the admired "blurry at 0% → sharp at 100%" effect. Post-reveal, the engine's
underfill strategy guarantees a resident-coarse fallback per node: blurry,
never holes.

Portal crossings (separate defect, same symptom): the crossing overlay's
readiness proxy assumes one enabled scene at a time and reveals when the
GLOBAL `_gsplatCount` reaches the destination's coarsest-level count. The
budget-bounded residency feature (commit 641aec7) keeps multiple scenes
resident, so the threshold is crossed immediately and the overlay drops while
the destination is still streaming → black regions after crossing.

## Diagnosis evidence so far (SUPERSEDED — original working hypotheses)

- With `GSPLAT_DEBUG_LOD` (`config.colorize`), the affected region shows **no
  LOD debug tint during the streaming window**. The tint is written by the
  work-buffer bake pass, so the affected splats are being sorted and drawn from
  work-buffer texels that were **never baked** — not from an already-baked node
  at a coarse LOD.
- The work-buffer render pass never clears (`colorOps.clear = false` in
  `gsplat-work-buffer-render-pass`), and work-buffer slots are recycled by
  alloc-id. A newly allocated slot whose bake has not run yet would show stale
  garbage. This is the **first-lead hypothesis**, to be verified — not a
  confirmed diagnosis.
- Not fixed upstream as of engine 2.20.5 (we diffed 2.20.2→2.20.5 and ship
  byte-exact parity with it). Web research found no upstream issue or PR
  matching this bug (closest: #8998, #9011 — both already in our parity patch).
  2.21.0-beta has large gsplat refactors; its `gsplat-unified` diff serves as a
  diagnosis aid only.

## Goal

Fix the root cause in the engine bundle we ship so that during streaming only
correctly-baked splats are drawn. The desired superspl.at UX (uniformly blurry
scene at 0% → progressively sharper to 100%) then comes for free:

- The bundled viewer (splat-transform 2.7.1) already contains supersplat-viewer's
  coarse-LOD lock (`lodRangeMin = lodRangeMax = lodLevels - 1` until
  `ready && loading === 0`, then unlock) — verified present in our bundle.
- Our LOD chain (`buildStreamingLodTable`, `MIN_LOD_SPLATS = 1M`) gives a
  coarsest level of ~0.5–1M splats — dense enough for a legible blurry preview.

### Explicitly in scope

- Single-scene exports (primary repro).
- Portal crossings into partially streamed destination scenes: same engine
  bug; after the fix, a crossing must show blurry/coarse regions refining, never
  black/garbled ones. (Mixed blurry+sharp is acceptable; black is not.)

### Explicitly out of scope (noted as follow-up knobs)

- Tuning the coarsest LOD size. Ruled out as the *cause* (the artifact is
  uncolored/unbaked data, not sparse-but-valid splats; the coarsest level is
  already ~725K splats for the 5.8M reference scene). If the post-fix blurry
  phase looks too coarse, raise/lower `MIN_LOD_SPLATS` in
  `src/splat-export-core.ts` as a separate change.
- Upgrading the bundled engine to 2.21-beta (decision: targeted patch only).
- Server writer changes (parity guarantee untouched; the fix is viewer-side).

## Repro harness (two tiers)

- **Tier A — diagnosis, readable source.** Generate the LOD SOG bundle from the
  source `.ply` (available) via splat-transform (`writeLod`, same options as
  `splat-export-core.ts`: chunkCount 512, chunkExtent 16, plus our LOD chain).
  Serve locally with network throttling. Load in a minimal harness page running
  the unminified `playcanvas.dbg` 2.20.5 build from node_modules (faithful to
  our 2.20.2 + 2.20.5-parity bundle for the gsplat subsystem). Instrument
  `gsplat-unified` source (GSplatWorld / work-buffer render pass / octree
  instance).
- **Tier B — validation, the real artifact.** A release export from the editor
  of the same scene, served throttled. The artifact must reproduce here before
  the fix and be gone after. (Stringified-runtime/minification gotchas make a
  release-build E2E mandatory.)

## Diagnosis strategy

Governed by the systematic-debugging skill. Verify the first-lead hypothesis by
catching the first garbled frame and dumping which alloc-ids are present in the
live sorted intervals but have no completed work-buffer bake. Candidate defect
sites: `needsUpload` merging in `cleanupOldWorldStates`, the `fullRebuild`
path, bake batching in `applyWorkBufferUpdates`. Cross-check the 2.21-beta
`gsplat-unified` diff for changes touching the identified site. Verify on both
WebGPU and the WebGL2 fallback (sorter paths differ; the artifact was observed
on WebGPU).

Known risk: if the root cause is GPU-side in a way that can't be reached by
string-patching the minified bundle, stop and present options instead of
forcing it.

## Fix delivery (REVISED — approved by Dimitri)

No engine patch. `src/viewer-engine-patch.ts` stays untouched. Three parts:

1. **Poster generation (browser-side, all export paths).** At export time the
   editor renders a poster image of the scene from the export's start camera
   (`settings.cameras[0].initial`), reusing the existing offscreen render
   pipeline (`render.ts`, overlays/zones/portals hidden as in `render.image`).
   The poster bytes ride the export payload the same way extra portal scenes
   do (browser export directly; server export via the job upload; S3 publish
   through the same shared core options).

2. **Poster injection into the viewer (shared core).** `writeViewerCore` gains
   optional poster bytes; a new `injectPoster` in the existing injection chain
   ships the image (file `poster.jpg` for package/streaming, data-URI for
   single-file HTML) and defaults the stock viewer's
   `posterUrl = url.searchParams.get('poster')` to it. This activates the
   stock `initPoster` path: blurred poster over a hidden canvas, unblurring
   with progress, canvas revealed at `loaded` — superspl.at parity for free,
   pre-reveal chunk pop-in never visible. `?poster=` query param still wins
   (upstream behavior preserved).

3. **Crossing overlay gate rework (`src/viewer-companion/portals.ts`).**
   Replace the global-`_gsplatCount` reveal threshold with per-destination
   readiness: the destination octree instance reports all its nodes' files at
   the pinned/coarsest level resident (companion already introspects octrees
   for pinning). Keep the plateau and absolute-cap fallbacks so the overlay
   can never stick. Result: overlay stays up until the destination genuinely
   has full coarse coverage — blurry after crossing is OK, black is not
   (Dimitri: showing the overlay longer is acceptable).

The upstream issue draft is rewritten: not an engine defect; optionally a
small supersplat-viewer suggestion (default poster / cover canvas until
firstFrame when no poster is present).

## Fix delivery (SUPERSEDED — engine-patch plan, kept for the record)

- New entries in `src/viewer-engine-patch.ts` `PATCHES`: exact tab-indented
  string replacement against the real splat-transform 2.7.1 bundle, each search
  pattern unique-match verified, `applied` markers where search survives
  replacement, idempotent second pass. Environment-agnostic (compiled for the
  export server via `dist-shared`), so browser and server exports stay
  identical.
- Header comment documents root cause and the removal condition (splat-transform
  shipping a fixed engine), matching the existing #8998/#9011 patch style.
- Update `docs/superpowers/2026-07-04-upstream-blob-issue-draft.md` from
  "question" to "root cause + proposed fix" so it can be filed upstream with a
  patch attached.

## Verification

- **Tests:** extend `test/viewer-engine-patch.test.ts` (patterns apply exactly
  once against the real bundle; second pass is a no-op). Server parity test
  stays green (writers untouched).
- **E2E (agent-side, release builds, throttled cold cache):**
  1. Single-scene export: no dark blobs at any point; `GSPLAT_DEBUG_LOD` tint
     present immediately on streamed-in regions; blurry→sharp progression
     visible; warm-cache reload regression.
  2. Portals export: crossing into a partially streamed scene shows
     blurry/coarse content (or the loading overlay), never black regions.
  3. WebGL2 fallback path sanity pass.
- **E2E (user-side, final):** desktop Chromium + Redmi Note 9S (Android), the
  original repro scenes.
