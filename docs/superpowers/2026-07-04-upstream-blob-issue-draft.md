# DRAFT — upstream issue for github.com/playcanvas/engine

Status: ready for Dimitri to review, attach screenshots, and file. Evidence
gathered 2026-07-03/04 during portal-viewer E2E rounds 3–9; reproduces
WITHOUT any of our fork's viewer modifications.

---

**Title:** Unified gsplat LOD streaming: transient dark/garbled splat regions
while files are still streaming; `GSPLAT_DEBUG_LOD` colors also absent until
loading completes

**Engine version:** 2.20.2 as bundled in the `@playcanvas/splat-transform`
2.7.1 exported viewer — and unchanged after back-porting PR #8998 and #9011,
i.e. with `gsplat-unified` byte-identical to the 2.20.5 build. WebGPU
renderer (`Renderer: webgpu` in the viewer log).

**Platforms observed:** Windows 11 desktop (Chromium) and Android
(Redmi Note 9S).

## Repro

1. Export a single-scene SOG LOD streaming viewer with
   `@playcanvas/splat-transform` (`writeLod` + `writeHtml`, the stock viewer —
   no custom code).
2. Load it with a **cold cache** (large scene helps, e.g. ~5.8M splats /
   4 LOD levels).
3. While the LOD files are still downloading, a large region of the scene
   renders as dark, garbled, blob-like splats (screenshot attached).
4. Once downloads finish the region heals completely; steady state is always
   clean. A warm-cache reload never shows it.

## Evidence that it is not simply "coarse LOD looks coarse"

With `config.colorize = true` (`GSPLAT_DEBUG_LOD`), the affected region shows
**no debug tint at all during the streaming window** — the LOD debug colors
only appear after loading completes. So the region is being rendered from
work-buffer data whose color population hasn't happened yet, rather than
being an already-rendered node at a coarse LOD (which would carry its LOD
debug color).

## What we ruled out

- Not fixed by 2.20.3–2.20.5: we diffed the 2.20.2 and 2.20.5 builds — the
  only gsplat changes in that range are #8998 and #9011, and the repro
  persists with both applied.
- Not caused by viewer-side load scheduling: reproduces on a stock
  single-scene export with no custom code.
- Not the #8998 ready-gate stall (fixed separately; blob persists).

## Question

Is this a known/expected transitional state (freshly streamed blocks
rendered before their color/SH work-buffer pass), or a bug in work-buffer /
color population ordering for newly streamed octree files? Happy to provide
the export or a hosted repro.

---

*Attachments to add before filing: r3 blob screenshot, viewer console log,
optionally a short screen capture of the streaming window.*
