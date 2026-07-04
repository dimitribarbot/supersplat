# DRAFT — upstream issue #2 for github.com/playcanvas/engine

Status: ready for Dimitri to review and file (independent of the streaming-blob
draft). Evidence from portal-viewer E2E rounds 10–12, 2026-07-04.

---

**Title:** WebgpuGraphicsDevice.handleDeviceLost crashes on null adapter
(`requireFeature` TypeError) instead of failing gracefully; gsplat streaming
triggers device loss on Adreno 6xx

**Engine version:** 2.20.2 (splat-transform 2.7.1 viewer); the
`handleDeviceLost` path is unchanged through 2.20.5.

## Part 1 — the crash (engine bug, always reproducible once a device is lost)

When the browser refuses to return an adapter after a device loss,
`handleDeviceLost` → `createDevice` dereferences the null adapter:

```
Uncaught (in promise) TypeError: Cannot read properties of null (reading 'features')
    at requireFeature (index.js:11647:38)
    at WebgpuGraphicsDevice.createDevice (index.js:11653:33)
    at async WebgpuGraphicsDevice.handleDeviceLost (index.js:11748:4)
```

Also observed on the same path: `Failed to create WebGPU Context Provider`.
The application gets no usable signal to recover or fall back — the page is
dead. Suggested behavior: guard the null adapter, fire a terminal event (or
reject), so applications can e.g. reload with a WebGL2 device.

## Part 2 — the trigger (context, possibly out of scope)

On a Redmi Note 9S (Adreno 618, 6GB, Android Chrome/Brave), a gsplat unified
LOD streaming scene loses the WebGPU device reliably within a couple of
scene-load cycles: Dawn logs "A valid external Instance reference no longer
exists" followed by mapAsync AbortErrors. Notably:

- The engine's own VRAM accounting reads only **200–305MB total** at the
  moment of loss (textures 74–247MB, storage buffers ~57MB) — far from
  exhausting the device; one run died while the texture pool was shrinking.
- Losses correlate with allocation churn (initial streaming, scene swaps),
  not with a memory high-water mark.
- The identical scene and walkthrough are stable with `?webgl` (WebGL2).

We work around it by falling back to WebGL2 after the first loss. Filing
mostly for Part 1, but the Adreno-6xx churn sensitivity may be worth a note
in the WebGPU device-selection heuristics.

Recovery data point (relevant to any engine-level fallback design): after
the crash, Chromium blocks 3D APIs for the hostname browser-wide, and we
field-confirmed that **no JS-initiated reload clears it** — not even one
called from a tap handler (user activation). Only the browser's own reload
(menu button) unblocked; pull-to-refresh was unavailable because the viewer
canvas suppresses overscroll. So an automatic engine-side WebGL fallback
after a WebGPU loss cannot be fully hands-free on such builds; a user
prompt is required.

---

*Attachments to add before filing: full console log of a crash run (rounds
10–12 logs), device details (Redmi Note 9S, Adreno 618, Chrome/Brave versions).*
