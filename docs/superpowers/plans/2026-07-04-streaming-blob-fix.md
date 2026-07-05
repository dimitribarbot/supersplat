# Streaming Dark-Blob Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Root-cause and fix the engine bug that renders dark/garbled (unbaked work-buffer) splat regions while a SOG LOD streaming export is downloading, so exports show the superspl.at blurry→sharp progressive load.

**Architecture:** Two-tier repro (Tier A: unminified `playcanvas.dbg` harness for diagnosis; Tier B: real release export for validation), a bookkeeping detector that catches live-but-unbaked work-buffer intervals, then a minimal engine fix delivered as new export-time string-replacement entries in `src/viewer-engine-patch.ts` (browser + server via `dist-shared`).

**Tech Stack:** PlayCanvas engine 2.20.x `gsplat-unified`, `@playcanvas/splat-transform` 2.7.1, Node 22 (server tooling via `tsx` + Dawn WebGPU), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-04-streaming-blob-fix-design.md`

## Global Constraints

- Streaming (LOD SOG) exports only — non-streaming SOG's black-until-loaded behavior is stock and out of scope (confirmed by Dimitri).
- Targeted patch only: no bundled-engine upgrade, no `@playcanvas/splat-transform` bump, no writer/parity changes, `MIN_LOD_SPLATS` untouched.
- Patch style must match the existing `PATCHES` entries: exact tab-indented search strings, each verified to occur exactly once in the real bundle, idempotent second pass, `applied` marker when search survives replacement.
- Use Git Bash (the Bash tool), never PowerShell, for git/npm/npx; run commands plainly (no `cd`/`git -C`/`npm --prefix` pointing at the cwd). Repo-external dirs may be `cd`-ed into.
- Never delete `package-lock.json`; only targeted `npm install`.
- Final validation must use a release (default `BUILD_TYPE`) export — minification gotchas have bitten before.
- Source scene: `C:\Users\User\Splats\RdC_Maison_Bueil\ply-result\point_cloud\iteration_100\scene.ply` — the confirmed-repro scene. Header verified: 5,588,857 splats, 17 float props (`x/y/z`, normals, `f_dc_0-2`, `opacity`, scales, rots) — **no `f_rest_*` SH bands in this file**, so the artifact does not depend on the SH color-update path (diagnostic constraint: `hasSphericalHarmonics` is false for this scene).
- Repro tooling lives OUTSIDE the repo in `C:\Dev\playcanvas\blob-repro\` — never committed. Repo commits only for: `src/viewer-engine-patch.ts`, `test/viewer-engine-patch.test.ts`, docs.
- Visual confirmations (blobs present/absent) are **user checkpoints** — Dimitri looks at the browser; the agent prepares everything and states exactly what to look for.

---

### Task 1: Repro workspace + headless export generation

**Files:**
- Create: `C:\Dev\playcanvas\blob-repro\gen-export.mts` (outside repo)
- Uses: `server/src/run-export.ts` (`runExport`), `server/src/gpu.ts` (`createGpuSession`) — unchanged

**Interfaces:**
- Produces: `C:\Dev\playcanvas\blob-repro\www\` — the unzipped streaming viewer bundle (`index.html`, `index.js`, `settings.json`, `lod-meta.json`, `<n>_<n>/` chunk folders). Tasks 2–8 serve this directory.
- Produces: re-runnable generation command (Task 8 re-runs it after the fix; it picks up a rebuilt `dist-shared` automatically because `run-export.ts` dynamically imports it).

- [ ] **Step 1: Ensure server deps + shared core are built**

```bash
npm run build:shared --prefix C:/Dev/playcanvas/supersplat/server 2>/dev/null || (cd C:/Dev/playcanvas/supersplat/server && npm run build:shared)
```

(If `server/node_modules` is missing, first: `cd C:/Dev/playcanvas/supersplat/server && npm install`.)

- [ ] **Step 2: Write the generation script**

`C:\Dev\playcanvas\blob-repro\gen-export.mts`:

```ts
// Headless streaming-viewer export of the repro scene, byte-identical to the
// editor's "Export on server" path (same runExport + dist-shared core).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { runExport } from 'C:/Dev/playcanvas/supersplat/server/src/run-export.ts';
import { createGpuSession } from 'C:/Dev/playcanvas/supersplat/server/src/gpu.ts';

const PLY = 'C:/Users/User/Splats/RdC_Maison_Bueil/ply-result/point_cloud/iteration_100/scene.ply';
const OUT = 'C:/Dev/playcanvas/blob-repro/out.zip';

const experienceSettings = {
    version: 2,
    tonemapping: 'none',
    highPrecisionRendering: false,
    background: { color: [0.4, 0.4, 0.4] },
    postEffectSettings: {},
    animTracks: [],
    cameras: [{ initial: { position: [2, 2, -2], target: [0, 0, 0], fov: 75 } }],
    annotations: [],
    startMode: 'default'
};

const ply = readFileSync(PLY);
console.log(`read ${PLY} (${(ply.length / 1e6).toFixed(0)} MB)`);
const plyGz = gzipSync(ply, { level: 0 }); // level 0: container only, fast

const session = createGpuSession();
try {
    const res = await runExport({
        plyGz,
        options: {
            fileType: 'packageViewer',
            filename: 'out.zip',
            viewerExportSettings: { type: 'zip', streaming: true, experienceSettings }
        },
        sink: { emit: (e: any) => { if (e.message) console.log(`[progress] ${e.message}${e.value != null ? ` ${e.value}%` : ''}`); } },
        getDeviceCreator: session.getDeviceCreator
    });
    mkdirSync('C:/Dev/playcanvas/blob-repro', { recursive: true });
    writeFileSync(OUT, res.files[0].data);
    console.log(`wrote ${OUT} (${(res.files[0].data.length / 1e6).toFixed(0)} MB)`);
} finally {
    await session.dispose();
}
```

Note: the script imports the server's TS sources by absolute path; run it with the server's own `tsx` so TS + bare specifiers resolve against `server/node_modules`.

- [ ] **Step 3: Run it and unzip the bundle**

```bash
cd C:/Dev/playcanvas/blob-repro && NODE_OPTIONS=--max-old-space-size=8192 C:/Dev/playcanvas/supersplat/server/node_modules/.bin/tsx gen-export.mts
mkdir -p C:/Dev/playcanvas/blob-repro/www && tar -xf C:/Dev/playcanvas/blob-repro/out.zip -C C:/Dev/playcanvas/blob-repro/www
ls C:/Dev/playcanvas/blob-repro/www
```

Expected: LOD decimation progress (levels ~5.59M/2.79M/1.40M/699K — the last is below the 1M floor, so 4 levels total), then `www/` containing `index.html`, `index.js`, `settings.json`, `lod-meta.json`, and `N_N/` chunk folders. This may take several minutes (GPU decimation).

- [ ] **Step 4: Sanity-check the LOD chain**

```bash
grep -o '"lodLevels":[0-9]*' C:/Dev/playcanvas/blob-repro/www/lod-meta.json | head -1
```

Expected: `"lodLevels":4`. If the key is nested differently, inspect the JSON head instead — the requirement is 4 levels.

No commit (nothing in the repo changed).

---

### Task 2: Throttled cold-cache static server

**Files:**
- Create: `C:\Dev\playcanvas\blob-repro\throttle-server.mjs` (outside repo)

**Interfaces:**
- Produces: `node throttle-server.mjs <dir> [port] [KBps]` — serves `<dir>` at `http://localhost:<port>` with a per-response bandwidth cap and `Cache-Control: no-store` (every reload is a cold load). Used by Tasks 3–8.

- [ ] **Step 1: Write the server**

`C:\Dev\playcanvas\blob-repro\throttle-server.mjs`:

```js
// Static server with per-response bandwidth throttling and no caching, so
// every reload is a cold, slow load — stretches the streaming window where
// the blob artifact lives. Usage: node throttle-server.mjs <dir> [port] [KBps]
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';

const [dir = '.', port = 8123, kbps = 5000] = process.argv.slice(2);
const CHUNK = 64 * 1024;
const DELAY_MS = CHUNK / (Number(kbps) * 1024) * 1000; // per-64KB delay for the cap

const MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.json': 'application/json', '.css': 'text/css', '.webp': 'image/webp',
    '.sog': 'application/octet-stream', '.bin': 'application/octet-stream'
};

createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const path = normalize(join(dir, url === '/' ? 'index.html' : url));
    let size;
    try { size = statSync(path).size; } catch { res.writeHead(404).end(); return; }
    res.writeHead(200, {
        'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
        'Content-Length': size,
        'Cache-Control': 'no-store'
    });
    const stream = createReadStream(path, { highWaterMark: CHUNK });
    stream.on('data', (chunk) => {
        stream.pause();
        res.write(chunk, () => setTimeout(() => stream.resume(), DELAY_MS));
    });
    stream.on('end', () => res.end());
    stream.on('error', () => res.destroy());
}).listen(Number(port), () => console.log(`http://localhost:${port} serving ${dir} @ ${kbps} KB/s per response`));
```

- [ ] **Step 2: Smoke-test**

```bash
node C:/Dev/playcanvas/blob-repro/throttle-server.mjs C:/Dev/playcanvas/blob-repro 8123 5000 &
sleep 1 && curl -s -o /dev/null -w "%{http_code} %{size_download}\n" http://localhost:8123/www/lod-meta.json
```

Expected: `200 <nonzero>`. Serve the `blob-repro` ROOT (not `www/`) in every task, so `/www/index.html` (real export) and `/harness/index.html` (Task 4+) are both reachable at stable URLs. Leave the server running for the following tasks (restart as needed).

Note: throttling is per-response; the viewer loads many chunk files in parallel, so effective total bandwidth is higher. Tune the KB/s argument down (e.g. 1000–2000) if the streaming window is too short to observe.

No commit.

---

### Task 3: Baseline repro on the real export (user checkpoint)

**Interfaces:**
- Consumes: Task 1 `www/`, Task 2 server.
- Produces: confirmed pre-fix baseline (blobs visible on this regenerated export) — the reference against which Task 8 validates the fix.

- [ ] **Step 1: Prepare the two baseline URLs**

The stock viewer supports URL params (verified in the bundle): `?debug` and colorize via viewer config. Open:
- `http://localhost:8123/www/index.html` — normal view
- `http://localhost:8123/www/index.html?debug` — check what the stock debug param exposes; if it does not enable LOD colorize, note it and rely on the Tier A harness (Task 4) for the tint check instead.

- [ ] **Step 2: User checkpoint — confirm baseline**

Ask Dimitri to load the normal URL with the throttle at 2000 KB/s and confirm: during streaming, dark/garbled blob regions appear (same artifact as E2E rounds 3–9); after load completes, the scene is clean. If the artifact does NOT reproduce on this regenerated export, STOP — the repro recipe is wrong; debug the difference (camera pose, throttle rate, WebGPU vs WebGL2) before proceeding.

No commit.

---

### Task 4: Tier A diagnosis harness (unminified engine)

**Files:**
- Create: `C:\Dev\playcanvas\blob-repro\harness\index.html`
- Create: `C:\Dev\playcanvas\blob-repro\harness\main.mjs`
- Create: `C:\Dev\playcanvas\blob-repro\harness\engine.mjs` (copy of `node_modules/playcanvas/build/playcanvas.dbg.mjs` — the 2.20.5 debug build, faithful to our 2.20.2+2.20.5-parity bundle for the gsplat subsystem)

**Interfaces:**
- Consumes: Task 1 `www/lod-meta.json` + chunks (served by the throttle server — serve `C:\Dev\playcanvas\blob-repro` root so both `harness/` and `www/` are reachable).
- Produces: a harness page reproducing the artifact against readable engine source, with `?debug=lod`, `?gfx=webgl2`, `?budget=<millions>` switches. Tasks 5–6 instrument/fix `harness/engine.mjs`.

- [ ] **Step 1: Copy the engine debug build**

```bash
cp C:/Dev/playcanvas/supersplat/node_modules/playcanvas/build/playcanvas.dbg.mjs C:/Dev/playcanvas/blob-repro/harness/engine.mjs
```

- [ ] **Step 2: Write the harness page**

`C:\Dev\playcanvas\blob-repro\harness\index.html`:

```html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden}canvas{width:100%;height:100%}</style></head>
<body><canvas id="c"></canvas><script type="module" src="./main.mjs"></script></body>
</html>
```

`C:\Dev\playcanvas\blob-repro\harness\main.mjs` (modeled on the engine v2.20.5 `lod-streaming` example, stripped to essentials; replicates the stock viewer's coarse-LOD lock + unlock):

```js
import * as pc from './engine.mjs';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('c');

const device = await pc.createGraphicsDevice(canvas, {
    deviceTypes: params.get('gfx') === 'webgl2' ? ['webgl2'] : ['webgpu', 'webgl2'],
    antialias: false
});
console.log(`[harness] device: ${device.deviceType}`);

const createOptions = new pc.AppOptions();
createOptions.graphicsDevice = device;
createOptions.componentSystems = [pc.RenderComponentSystem, pc.CameraComponentSystem, pc.GSplatComponentSystem];
createOptions.resourceHandlers = [pc.TextureHandler, pc.GSplatHandler];

const app = new pc.AppBase(canvas);
app.init(createOptions);
app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
app.setCanvasResolution(pc.RESOLUTION_AUTO);

const asset = new pc.Asset('gsplat', 'gsplat', { url: '/www/lod-meta.json' });
app.assets.add(asset);
asset.on('load', () => {
    app.start();

    app.scene.gsplat.lodUpdateAngle = 90;
    app.scene.gsplat.splatBudget = Number(params.get('budget') ?? 4) * 1e6;
    if (params.get('debug') === 'lod') app.scene.gsplat.debug = pc.GSPLAT_DEBUG_LOD;

    const camera = new pc.Entity('camera');
    camera.addComponent('camera', { clearColor: new pc.Color(0.4, 0.4, 0.4), fov: 75, toneMapping: pc.TONEMAP_LINEAR });
    camera.setLocalPosition(2, 2, -2);
    camera.lookAt(0, 0, 0);
    app.root.addChild(camera);

    const entity = new pc.Entity('splat');
    entity.addComponent('gsplat', { asset });
    entity.setLocalEulerAngles(180, 0, 0); // PLY -> viewer orientation, same flip the exported viewer applies
    app.root.addChild(entity);
    const gs = entity.gsplat;

    // Stock-viewer behavior: lock to coarsest LOD until first batch is fully
    // streamed, then unlock (this is the superspl.at blurry->sharp mechanism).
    const lodLevels = gs.resource?.octree?.lodLevels;
    if (lodLevels) { gs.lodRangeMin = gs.lodRangeMax = lodLevels - 1; }
    const sys = app.systems.gsplat;
    const onFrameReady = (cam, layer, ready, loading) => {
        console.log(`[harness] frame:ready ready=${ready} loading=${loading}`);
        if (ready && loading === 0) {
            sys.off('frame:ready', onFrameReady);
            gs.lodRangeMin = 0; gs.lodRangeMax = 1000;
            console.log('[harness] LOD range unlocked');
        }
    };
    sys.on('frame:ready', onFrameReady);
});
asset.on('error', (err) => console.error('[harness] load failed:', err));
app.assets.load(asset);
```

- [ ] **Step 3: Reproduce in the harness**

With the Task 2 server running (blob-repro root, e.g. 2000 KB/s), open `http://localhost:8123/harness/index.html`. **User checkpoint:** confirm the same dark/garbled artifact appears during streaming with the unminified engine, and that with `?debug=lod` the affected region has no LOD tint. If the harness does NOT reproduce: vary camera pose (edit positions), throttle rate, and `?budget=`; if it still doesn't reproduce, STOP and re-plan (the dbg 2.20.5 build may differ from the bundle in a relevant way — fall back to instrumenting the bundled `www/index.js` directly).

No commit.

---

### Task 5: Unbaked-interval detector (evidence gathering)

**Files:**
- Modify: `C:\Dev\playcanvas\blob-repro\harness\engine.mjs` (instrumentation only, never committed)

**Interfaces:**
- Consumes: Task 4 harness reproducing the artifact.
- Produces: console evidence naming the defect: which alloc-ids/nodes are live in the rendered intervals without a completed work-buffer bake, and which code path put them there. Recorded in `C:\Dev\playcanvas\blob-repro\FINDINGS.md`.

The exact insertion points are discovered by reading the code around these anchors (all exist in the dbg build — verified):
- `applyWorkBufferUpdates(state, camera)` — incremental bake path (`GSplatWorld`)
- `this._workBuffer.render(` — geometry+color bake call sites (initial/full bake site(s) to be located via search)
- `renderColor(splats, cameraNode, colorsByLod` — color-only bake (`GSplatWorkBuffer`)
- `cleanupOldWorldStates(newVersion)` — version handoff / needsUpload merging (`GSplatWorld`)

- [ ] **Step 1: Record every bake**

In `GSplatWorkBuffer` (search `class GSplatWorkBuffer`), at the top of both `render(...)` and `renderColor(...)`, add (adapting the iteration to how splats/intervals are actually passed — read the method body first):

```js
// [DETECTOR] record baked alloc-ids
globalThis.__baked ??= new Set();
for (const s of splats) for (const id of (s.intervalAllocIds ?? [s.allocId])) globalThis.__baked.add(id);
```

- [ ] **Step 2: Check live intervals every frame**

In `GSplatWorld` where the active world state is applied per frame (read `update(...)` and the version-advance site that follows `cleanupOldWorldStates`), add a per-frame sweep:

```js
// [DETECTOR] every live alloc-id must have been baked before it is drawn
globalThis.__frame = (globalThis.__frame ?? 0) + 1;
const unbaked = [];
for (const splat of state.splats) {
    for (const id of (splat.intervalAllocIds ?? [splat.allocId])) {
        if (!globalThis.__baked?.has(id)) unbaked.push({ id, node: splat.node?.name });
    }
}
if (unbaked.length) console.error(`[UNBAKED] frame=${globalThis.__frame}`, JSON.stringify(unbaked.slice(0, 20)), `total=${unbaked.length}`);
```

- [ ] **Step 3: Correlate with the visual artifact**

Reload the throttled harness. Expected if the hypothesis holds: `[UNBAKED]` errors stream to the console exactly while the garbled region is visible, and stop when it heals. Capture: which alloc-ids, how many frames they stay unbaked, and whether they entered via a full rebuild or incremental path (add temporary `console.log` markers in the candidate sites: `cleanupOldWorldStates`, the `fullRebuild` branch, `needsUpload` consumption).

- [ ] **Step 4: If the detector stays silent while blobs show**

The hypothesis is wrong — pivot per systematic-debugging: the data IS baked but baked wrong (e.g. baked from source textures whose GPU upload hasn't completed, or baked with stale/zero color data). Instrument the bake inputs instead (log per-splat source-texture readiness at bake time). Do not proceed to Task 6 until the mechanism is demonstrated, not assumed.

- [ ] **Step 5: Write findings**

Record in `C:\Dev\playcanvas\blob-repro\FINDINGS.md`: the demonstrated mechanism, call-stack/order of events, and the candidate fix site(s). No commit (outside repo).

---

### Task 6: Root cause + candidate fix in the harness engine — PLAN CHECKPOINT

**Files:**
- Modify: `C:\Dev\playcanvas\blob-repro\harness\engine.mjs` (fix prototype)
- Modify: `C:\Dev\playcanvas\blob-repro\FINDINGS.md`

**Interfaces:**
- Consumes: Task 5 evidence.
- Produces: a minimal, mechanism-targeted fix (smallest change that makes newly streamed intervals bake before they are drawn — or not be drawn until baked), validated in the harness; FINDINGS.md gains the exact engine-source diff. Task 7 consumes that diff.

- [ ] **Step 1: Implement the minimal fix at the demonstrated defect site** (content comes from Task 5's findings — this is inherently investigation-dependent; keep it minimal and mechanism-targeted, not a workaround like forcing full rebuilds every frame)

- [ ] **Step 2: Validate in the harness (all four passes)**

1. Throttled cold load, normal: no dark/garbled regions at any point; coarse blurry content refines to sharp.
2. Throttled cold load, `?debug=lod`: every visible streamed-in region carries a LOD tint from its first visible frame; detector stays silent (`[UNBAKED]` never fires).
3. `?gfx=webgl2` repeat of pass 1 (sorter path differs).
4. Warm-ish regression: un-throttled reload — steady state identical to pre-fix (no perf/visual regression at rest; compare `frame:ready` timing logs).

- [ ] **Step 3: PLAN CHECKPOINT — report and update plan**

STOP. Report to Dimitri: the demonstrated root cause, the engine-source diff, and the harness validation results. Then update THIS plan file: fill Task 7's `search`/`replace` strings with the real ones derived from the fix, and update the spec + `docs/superpowers/2026-07-04-upstream-blob-issue-draft.md` root-cause section. Commit the docs updates:

```bash
git add docs/superpowers/plans/2026-07-04-streaming-blob-fix.md docs/superpowers/specs/2026-07-04-streaming-blob-fix-design.md docs/superpowers/2026-07-04-upstream-blob-issue-draft.md
git commit -m "docs: streaming blob root cause + fix design update"
```

---

### DIAGNOSIS OUTCOME (2026-07-04 evening) — plan revised from here down

Tasks 1–6 completed and the diagnosis **falsified the engine-bug premise** (see
the spec's ROOT CAUSE section for the full evidence chain). Summary:

- Engine renders correctly (work-buffer detector: zero violations). Coarse-LOD
  lock engages; reveal gate fires correctly at coarse-complete.
- The artifact = coarse-chunk pop-in against the scene background during the
  pre-reveal window (black bg → "black blobs"), plus a second defect on portal
  crossings: the companion overlay's global-`_gsplatCount` threshold reveals
  prematurely now that budget-bounded residency keeps multiple scenes resident.
- Fix approved by Dimitri: poster + covered canvas until reveal (stock viewer's
  dormant `initPoster` path gives superspl.at parity), poster rendered at
  export from the start camera; crossing overlay gated on per-destination
  coarse residency. `src/viewer-engine-patch.ts` stays untouched. Old Tasks
  7–9 (engine PATCHES port) are superseded and were removed.

Key code anchors discovered:
- Stock viewer poster path: `#poster` div + `initPoster` (blur by
  `(100 - progress)`, canvas opacity 0 until `loaded:changed`), activated by
  `posterUrl = url.searchParams.get('poster')` in the exported `index.html`'s
  inline module.
- Injection chain (all viewer types): `injectDeviceFallback(injectPortals(
  injectOffLimitsZones(injectAnnotationLinks(html, settings), ...)))` in
  `src/splat-export-core.ts` (`writeViewerCore`, html/package paths; streaming
  path inside `writeStreamingViewerCore`).
- Offscreen render: `events.function('render.offscreen', (w, h))` in
  `src/render.ts` renders the CURRENT camera; `render.image` shows how
  overlays/zones/portals are hidden during capture.
- Crossing overlay: `src/viewer-companion/portals.ts` lines ~223–300
  (`lodThreshold`, `beginLoading`, global `gsplatCount()` proxy, plateau + cap
  fallbacks; stale comment claims "exactly ONE scene enabled at a time").

---

### Task 7 (REVISED): Poster + covered-canvas injection

**Files:**
- Create: `src/viewer-companion/poster.ts` — `injectPoster(html, settings, posterBytes?)` (environment-agnostic, compiled into dist-shared like `device-fallback.ts`)
- Modify: `src/splat-export-core.ts` — `writeViewerCore(..., posterBytes?: Uint8Array)`: add `injectPoster` to the injection chain in all three viewer types; emit `poster.jpg` into the package/streaming memFs; data-URI inline for single-file HTML
- Modify: `src/file-handler.ts` — browser export: render the poster before export (see below) and pass bytes through both the local path and the server-upload path (multipart, alongside the existing extra-scene uploads)
- Modify: `server/src/run-export.ts` (+ `server/src/index.ts` / `jobs.ts` / `export-worker.ts` as needed for the multipart field) — accept optional poster bytes, hand to `writeViewerCore`
- Modify: `src/s3-publish.ts` — same pass-through for the publish flow
- Test: `test/poster-injection.test.ts` (new, model on `test/device-fallback-injection.test.ts`), extend server route test if a new multipart field is added

**Interfaces:**
- Produces: `injectPoster(html: string, settings: any, poster?: { bytes: Uint8Array, mime: string }): string`
- Behavior contract: with poster bytes → ship image + default `posterUrl` to it (query `?poster=` still wins). WITHOUT poster bytes (e.g. headless server export where the browser didn't provide one) → inject a solid cover in the scene background color that behaves like the poster (hides canvas until `loaded`), so no streaming export ever shows chunk pop-in.
- Poster render (browser): move camera to `settings.cameras[0].initial` pose, `render.offscreen(width, height)` (overlays/zones/portals hidden as in `render.image`), encode JPEG via canvas `toBlob`, restore camera. Resolution: 1920×1080 (clamp to device max).

**Steps (TDD):**
- [ ] Failing tests for `injectPoster`: (a) defaults `posterUrl` when poster present; (b) emits nothing / solid-cover variant when absent; (c) idempotent; (d) `?poster=` query override preserved.
- [ ] Implement `injectPoster`; wire into `writeViewerCore` (all three paths) + memFs emission.
- [ ] `npx vitest run test/poster-injection.test.ts` → PASS; commit.
- [ ] Browser poster render + local export path; commit.
- [ ] Server + publish plumbing; `cd server && npm run build:shared && npm run test`; commit.

### Task 8 (REVISED): Crossing overlay per-destination readiness gate

**Files:**
- Modify: `src/viewer-companion/portals.ts` (overlay section ~223–300 + poll site ~714)
- Test: extend `test/portals.test.ts` / `test/portals-injection.test.ts` for any extracted pure logic

**Interfaces:**
- Replace the reveal trigger "global `_gsplatCount` ≥ payload-baked coarsest count" with per-destination readiness: the destination scene's octree instance has a resident file for EVERY node at the reveal level (pinned/coarsest — reuse the pin-depth machinery the companion already has). Keep plateau + `LOADING_MAX_FRAMES` fallbacks so the overlay can never stick. Fix the stale "exactly ONE scene enabled" comment.
- Acceptance (Dimitri): after crossing, blurry content or the overlay — never black regions; overlay staying up longer is acceptable.

**Steps:**
- [ ] Extract/implement `sceneCoarseResident(idx)` readiness check (octree introspection, defensive try/catch like existing engine pokes).
- [ ] Swap the reveal condition; keep fallbacks; update comment.
- [ ] `npm run test` + `npm run lint`; commit.

### Task 9 (REVISED): Validation, docs, handoff

- [ ] Rebuild dist-shared; regenerate the synthetic export (`gen-export.mts`) → verify the no-poster solid-cover path: throttled cold load shows cover+progress until reveal, then complete blurry scene refining to sharp; no pop-in ever visible. (User checkpoint.)
- [ ] Editor release export of the repro scene with real poster → same check + poster blur-unblur UX. Editor-path smoke: grep output for the poster injection marker. (User checkpoint.)
- [ ] Portal export (user's real project): crossing into still-streaming scene → overlay until coarse-resident, never black. (User checkpoint, incl. Redmi.)
- [ ] Rewrite `docs/superpowers/2026-07-04-upstream-blob-issue-draft.md`: no engine bug; optionally a supersplat-viewer suggestion (cover canvas when no poster). Update spec status. Commit docs.
- [ ] superpowers:verification-before-completion, then superpowers:finishing-a-development-branch (squash incl. docs, FF-merge to local main, do not push).
