# RESOLVED LOCALLY — no engine bug; optional supersplat-viewer suggestion below

Status: the original draft (an engine issue about "transient dark/garbled
splat regions" during LOD streaming) was WITHDRAWN after a full diagnosis on
2026-07-04 falsified it. Kept for the record, with the corrected findings and
an optional upstream suggestion Dimitri may still file — against
**supersplat-viewer**, not the engine.

## What the diagnosis established (evidence-backed)

Full chain in `docs/superpowers/specs/2026-07-04-streaming-blob-fix-design.md`
(ROOT CAUSE section). Summary:

- **The engine renders correctly.** A bake-bookkeeping detector in an
  unminified-engine harness (2.20.5 debug build, same gsplat code we ship
  after the parity patch) never observed a live sorted interval whose
  work-buffer texels had not been baked — across cold throttled loads,
  with and without `GSPLAT_DEBUG_LOD`.
- **The stock viewer's coarse-LOD lock and reveal gate work.** Instrumenting
  the real export showed `lodRangeMin/Max = lodLevels - 1` engaging at load,
  `loading` counting 22→0 monotonically, and the `ready && loading === 0`
  unlock firing exactly once at coarse-complete.
- **The "dark garbled blobs" are background holes.** The coarsest LOD level
  is spatially chunked (~512K splats per chunk); until a region's coarse
  chunk arrives it has no splats at all, so the scene background (black in
  the field case) shows through, edged by giant boundary splats of the
  neighbouring loaded chunk. The missing LOD debug tint that motivated the
  original draft is trivially explained: there were no splats to tint.
- **Why superspl.at never shows this:** its CDN delivers the few-MB coarse
  level near-instantly, and gallery scenes ship a poster — supersplat-viewer's
  `initPoster` path blurs the poster by `(100 - progress)` and holds the
  canvas at opacity 0 until `loaded`. The visible pre-reveal window simply
  never exists there.

## Local fix (this fork, branch fix/streaming-blob)

- Every viewer export/publish now ships a poster (an export-time screenshot
  from the start camera; solid background-color cover when no screenshot is
  available) and defaults the viewer's `?poster=` to it — activating the
  stock poster path: covered canvas + progress until reveal, then the
  complete coarse scene refining to sharp. `?poster=` (empty) disables.
- Portal crossings: the companion overlay now reveals on per-destination
  coarse-file residency instead of a global splat-count threshold (which
  multi-scene residency had invalidated).

## Optional upstream suggestion (supersplat-viewer)

**Title:** Cover the canvas during initial LOD streaming when no poster is
present (avoid background holes showing through partially streamed scenes)

Locally exported/self-hosted streamed scenes have no poster, so the canvas is
visible during the pre-reveal window while coarse octree chunks pop in;
regions whose coarse chunk has not arrived render as holes showing the
background color (screenshots available — dramatic with a black background on
slow connections). Suggestion: when `config.poster` is absent, fall back to a
solid cover in the scene background color (or keep `--canvas-opacity` at 0)
until the existing `loaded` state fires, so self-hosted exports get the same
clean first frame as superspl.at gallery scenes. Happy to provide a repro or
a PR.
