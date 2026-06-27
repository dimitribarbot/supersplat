import { buildPortalAnimTimeline } from '../portal-anim-timeline';
import { segmentCrossesRect, resolveActiveSplat } from '../portal-geom';

// Localized default loading labels, keyed by primary language subtag. Mirrors
// the language set used by off-limits-zones.ts / annotation-links.ts.
const DEFAULT_MESSAGES: Record<string, string> = {
    en: 'Loading…',
    de: 'Wird geladen…',
    es: 'Cargando…',
    fr: 'Chargement…',
    ja: '読み込み中…',
    ko: '로딩 중…',
    pt: 'Carregando…',
    ru: 'Загрузка…',
    zh: '加载中…'
};

// Pure default-message resolver. Custom text wins; otherwise pick the viewer's
// language (region subtag -> base subtag -> English). Self-contained so it is
// also injected verbatim into the runtime via Function.toString().
const resolveLoadingMessage = (custom: string, defaults: Record<string, string>, lang: string): string => {
    if (custom) {
        return custom;
    }
    const l = (lang || 'en').toLowerCase();
    return defaults[l] || defaults[l.split('-')[0]] || defaults.en;
};

// CSS for the streaming-scene loading overlay (backdrop covers the viewer's
// clear color, a CSS-only spinner + label sit centered). Non-blocking
// (pointer-events: none) and fades via the `active` class, matching the
// 200ms timing used by off-limits-zones.ts.
const companionStyle = `
.ss-portal-loading-backdrop {
  position: fixed; inset: 0; z-index: 2000; pointer-events: none;
  background: #1a1a1a; opacity: 0; transition: opacity 200ms ease-out;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
}
.ss-portal-loading-backdrop.active { opacity: 1; }
.ss-portal-loading-spinner {
  width: 42px; height: 42px; border-radius: 50%;
  border: 4px solid rgba(255,255,255,0.25); border-top-color: #fff;
  animation: ss-portal-spin 0.9s linear infinite;
}
.ss-portal-loading-label {
  margin-top: 16px; color: #fff; font-family: sans-serif; font-size: 15px;
}
@keyframes ss-portal-spin { to { transform: rotate(360deg); } }
`;

// Runtime companion injected verbatim into the exported viewer. It creates one
// disabled gsplat per extra scene, switches the visible scene when the camera
// crosses a portal, and swaps the walk/fly collision to match. The two pure
// crossing helpers are stringified in from portal-geom so the geometry is shared
// and unit-tested. Everything else is dep-internal (the live pc.AppBase and the
// viewer's collision instance), verified by the Task 8/9 console spikes and the
// Task 12 end-to-end walkthrough rather than unit tests.
const companionRuntime = `
(function () {
  var data = window.__supersplatPortals;
  if (!data || !data.portals || !data.portalScenes || data.portalScenes.length < 2) return;
  var segmentCrossesRect = ${segmentCrossesRect.toString()};
  var resolveActiveSplat = ${resolveActiveSplat.toString()};
  var resolveLoadingMessage = ${resolveLoadingMessage.toString()};
  var loadingText = resolveLoadingMessage('', data.loadingDefaults || {}, navigator.language || 'en');

  // Live pc.AppBase handle (primary path confirmed by the Task 8 spike, navCursor fallback).
  function getApp(v) { return (v && v.debugPanel && v.debugPanel._global && v.debugPanel._global.app) || (v && v.navCursor && v.navCursor.app) || null; }

  var entities = [];                       // scene index -> gsplat Entity (index 0 = start)
  var activeIndex = data.portalStart || 0;
  // Streaming vs SOG: only streaming scenes stream progressively (and can show
  // the black clear color on first crossing); SOG scenes are fully resident the
  // moment their entity exists, so they never get the loading overlay.
  var streaming = (data.portalScenes || []).some(function (u) { return u && u.indexOf('lod-meta.json') !== -1; });
  var lastSafe = null;
  var timeline = data.portalAnimTimeline || null;   // [{t, scene}] sorted ascending; null/absent when no animation
  function getState() {
    var v = window.__supersplatViewer;
    return (v && v.global && v.global.state) || (v && v.debugPanel && v.debugPanel._global && v.debugPanel._global.state) || null;
  }
  // Active scene for cursor time t (seconds), from the baked timeline. Linear
  // scan: timeline has one entry per crossing (small).
  function sceneAtTime(t) {
    if (!timeline || !timeline.length) return activeIndex;
    var s = timeline[0].scene;
    for (var i = 0; i < timeline.length; i++) {
      if (timeline[i].t <= t) { s = timeline[i].scene; } else { break; }
    }
    return s;
  }
  // Switch to scene idx: enable it, swap collision, and arm the streaming
  // loading overlay on a first visit. No-op when already active or not loaded.
  function switchTo(idx) {
    if (idx === activeIndex || idx === null || !entities[idx]) return;
    activeIndex = idx;
    applyActive();
    swapCollision(idx);
    if (streaming && !readyScenes[idx] && pendingIndex !== idx) { beginLoading(idx); }
  }

  // --- streaming loading overlay ---------------------------------------
  // First crossing into a streaming scene enables an entity whose splat data
  // has not streamed yet (LOD is camera-driven; disabled scenes stream
  // nothing), so the viewer briefly shows its clear color. Cover that with a
  // backdrop+spinner+label until the scene's splats are visibly present.
  //
  // Readiness uses the GLOBAL renderer splat count. That is valid per-scene
  // because the companion keeps exactly ONE scene enabled at a time, so right
  // after a crossing the global count is effectively the active scene's
  // resident-splat count. We cannot know a scene's target count in advance, so
  // "visibly present" is detected three ways (whichever fires first):
  //   1. LOD threshold - resident count reaches the payload-baked splat count
  //                     for the chosen LOD level (deterministic early reveal),
  //   2. plateau      - count stopped climbing (fully streamed for this view),
  //   3. safety cap   - absolute frame bound so the overlay can never stick.
  // A short SHOW_DELAY defers showing the backdrop so an already-resident scene
  // (e.g. a non-streaming SOG export) never flashes it.
  var readyScenes = {};            // scene index -> true once revealed
  readyScenes[activeIndex] = true; // start scene is already loaded; never overlay it
  var pendingIndex = null;         // scene index currently loading (or null)
  var pendingFrames = 0;           // frames since the crossing
  var overlayShown = false;        // backdrop currently visible
  var peakCount = 0;               // highest count seen since the crossing
  var plateauFrames = 0;           // consecutive frames near the peak
  var revealThreshold = 0;         // resident-splat count that means "shown enough" (0 = unknown)
  var crossedBelow = false;        // count dipped below the threshold after the swap (we're now measuring the NEW scene)
  var SETTLE_FRAMES = 4;           // let the enable/disable swap settle before tracking the plateau
  var SHOW_DELAY = 0;              // streaming-only (SOG gated out) => show immediately
  var REVEAL_LOD = 1;              // which LOD level's count to reveal at: 0 = coarsest (earliest/sparsest), higher = finer/denser/later
  var PLATEAU_TOL = 0.9;           // "near peak" fraction for plateau detection
  var PLATEAU_FRAMES = 15;         // near-peak frames => plateau reached (fallback when the threshold is never met)
  var LOADING_MAX_FRAMES = 600;    // ~10s absolute safety cap (rAF-counted)

  var lBackdrop = document.createElement('div');
  lBackdrop.className = 'ss-portal-loading-backdrop';
  var lSpinner = document.createElement('div');
  lSpinner.className = 'ss-portal-loading-spinner';
  var lLabel = document.createElement('div');
  lLabel.className = 'ss-portal-loading-label';
  lLabel.textContent = loadingText;
  lBackdrop.appendChild(lSpinner);
  lBackdrop.appendChild(lLabel);
  function mountLoading() { document.body.appendChild(lBackdrop); }
  if (document.body) mountLoading(); else document.addEventListener('DOMContentLoaded', mountLoading);
  function showLoading() { lBackdrop.classList.add('active'); }
  function hideLoading() { lBackdrop.classList.remove('active'); }

  // Global resident-splat count (see note above). 0 when unavailable.
  function gsplatCount() {
    var app = getApp(window.__supersplatViewer);
    return (app && app.renderer && app.renderer._gsplatCount) || 0;
  }

  // Resident-splat count at which scene idx is "shown enough", taken from the
  // per-scene LOD level counts baked into the payload (level 0 = finest/full,
  // last = coarsest). REVEAL_LOD selects the level from the coarsest end. 0 when
  // unknown (e.g. counts absent) -> the threshold trigger is then disabled and
  // the overlay relies on the plateau/cap fallbacks.
  function lodThreshold(idx) {
    var counts = (data.portalSceneLodCounts || [])[idx];
    if (!counts || !counts.length) { return 0; }
    var i = counts.length - 1 - REVEAL_LOD;
    if (i < 0) { i = 0; }
    return counts[i] || 0;
  }

  // Arm the overlay for a first-time crossing into scene idx. showLoading is
  // deferred to the poll (SHOW_DELAY) so an already-resident scene never flashes.
  function beginLoading(idx) {
    pendingIndex = idx; pendingFrames = 0; overlayShown = false;
    peakCount = 0; plateauFrames = 0; crossedBelow = false;
    revealThreshold = lodThreshold(idx);
  }
  function endLoading() {
    if (pendingIndex !== null) { readyScenes[pendingIndex] = true; }
    hideLoading();
    pendingIndex = null; overlayShown = false;
  }

  // Portal rects carry index-based front/back: the export (buildPortalBundle)
  // already rewrote editor scene-uids to scene indices, so resolveActiveSplat's
  // "uid" values are indices here, matching the entities/collision arrays.
  var rects = data.portals.map(function (p) {
    return { position: p.position, rotation: p.rotation, width: p.width, height: p.height, frontUid: p.front, backUid: p.back, infinite: p.infinite };
  });

  // --- collision: in-place mutation of the ONE shared VoxelCollision instance ---
  // The viewer hands a single collision instance to both the (closure-private)
  // camera movers and inputController, so reading inputController.collision returns
  // that same object. VoxelCollision keeps no derived/cached state - its queries
  // read these fields live each frame - so overwriting the fields in place is seen
  // by the movers on the next frame. We never construct a new instance, which keeps
  // the original class (e.g. legacy FlippedVoxelCollision stays flipped).
  var voxels = [];                         // scene index -> parsed field-set (or undefined)
  function liveCollision() {
    var v = window.__supersplatViewer;
    return (v && v.inputController && v.inputController.collision) || null;
  }
  function snapshot(c) {
    return {
      gridMinX: c._gridMinX, gridMinY: c._gridMinY, gridMinZ: c._gridMinZ,
      numVoxelsX: c._numVoxelsX, numVoxelsY: c._numVoxelsY, numVoxelsZ: c._numVoxelsZ,
      voxelResolution: c._voxelResolution, leafSize: c._leafSize, treeDepth: c._treeDepth,
      nodes: c._nodes, leafData: c._leafData
    };
  }
  function applyVoxel(c, f) {
    c._gridMinX = f.gridMinX; c._gridMinY = f.gridMinY; c._gridMinZ = f.gridMinZ;
    c._numVoxelsX = f.numVoxelsX; c._numVoxelsY = f.numVoxelsY; c._numVoxelsZ = f.numVoxelsZ;
    c._voxelResolution = f.voxelResolution; c._leafSize = f.leafSize; c._treeDepth = f.treeDepth;
    c._nodes = f.nodes; c._leafData = f.leafData;
  }
  function parseVoxel(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('voxel json ' + r.status);
      return r.json();
    }).then(function (meta) {
      var binUrl = url.replace('.voxel.json', '.voxel.bin');
      return fetch(binUrl).then(function (rb) {
        if (!rb.ok) throw new Error('voxel bin ' + rb.status);
        return rb.arrayBuffer();
      }).then(function (buf) {
        var u32 = new Uint32Array(buf);
        var res = meta.voxelResolution;
        return {
          gridMinX: meta.gridBounds.min[0], gridMinY: meta.gridBounds.min[1], gridMinZ: meta.gridBounds.min[2],
          numVoxelsX: Math.round((meta.gridBounds.max[0] - meta.gridBounds.min[0]) / res),
          numVoxelsY: Math.round((meta.gridBounds.max[1] - meta.gridBounds.min[1]) / res),
          numVoxelsZ: Math.round((meta.gridBounds.max[2] - meta.gridBounds.min[2]) / res),
          voxelResolution: res, leafSize: meta.leafSize, treeDepth: meta.treeDepth,
          nodes: u32.slice(0, meta.nodeCount),
          leafData: u32.slice(meta.nodeCount, meta.nodeCount + meta.leafDataCount)
        };
      });
    });
  }
  function preloadCollisions() {
    if (!data.portalCollision || data.portalCollision.length === 0) return;
    // The viewer loads its collision asynchronously and independently of the
    // camera/gsplat, so the shared instance may not exist yet on the first
    // attempt. Poll until it does (collision-on exports always bundle + load it).
    var live = liveCollision();
    if (!live) { requestAnimationFrame(preloadCollisions); return; }
    // The viewer already loaded the start scene's collision - snapshot it so we
    // can restore it when walking back to the start scene.
    voxels[activeIndex] = snapshot(live);
    for (var i = 0; i < data.portalCollision.length; i++) {
      (function (idx) {
        if (idx === activeIndex || voxels[idx]) return;
        var url = data.portalCollision[idx];
        if (!url) return;
        parseVoxel(url).then(function (f) {
          voxels[idx] = f;
          // If the user already crossed into this scene while its collision was
          // still loading, apply it now so visual and collision stay in sync.
          if (idx === activeIndex) swapCollision(idx);
        }).catch(function (err) { console.warn('portal collision ' + idx + ' failed:', err); });
      })(i);
    }
  }
  function swapCollision(idx) {
    var live = liveCollision();
    if (live && voxels[idx]) {
      applyVoxel(live, voxels[idx]);
      // Live-update the overlay only if it is currently shown; otherwise it is
      // refreshed lazily when the user enables it (see the listener in start()).
      if (overlayEnabled()) refreshOverlay();
    }
  }

  // The overlay's GPU buffers are uploaded once at construction, so an in-place
  // collision swap leaves them showing the previous scene. Track which scene the
  // overlay buffers represent and rebuild from the live (already-swapped)
  // collision when needed. overlayScene starts at the scene the viewer built the
  // overlay from (the start scene).
  var overlayScene = data.portalStart || 0;
  function overlayEnabled() {
    var v = window.__supersplatViewer;
    return !!(v && v.voxelOverlay && v.voxelOverlay.enabled);
  }
  function refreshOverlay() {
    var v = window.__supersplatViewer;
    var ov = v && v.voxelOverlay;
    var live = liveCollision();
    if (!ov || !ov.constructor || !live || overlayScene === activeIndex) return;
    try {
      var app = getApp(v);
      var nv = new ov.constructor(app, live, ov.camera);  // re-uploads nodes/leafData buffers from the live collision
      nv.mode = ov.mode;
      nv.enabled = ov.enabled;
      v.voxelOverlay = nv;                                 // prerender reads this.voxelOverlay live, so the swap is seen next frame
      ov.destroy();
      overlayScene = activeIndex;
      if (app) app.renderNextFrame = true;
    } catch (e) {
      console.warn('portal overlay refresh failed:', e);
    }
  }

  // Enable exactly the active scene; disable the rest (avoids overlapping haze).
  function applyActive() {
    for (var i = 0; i < entities.length; i++) {
      if (entities[i]) entities[i].enabled = (i === activeIndex);
    }
    var app = getApp(window.__supersplatViewer);
    if (app) app.renderNextFrame = true;
  }

  function start() {
    var viewer = window.__supersplatViewer;
    var app = getApp(viewer);
    var cm = viewer && viewer.cameraManager;
    if (!app || !cm || !cm.camera) { requestAnimationFrame(start); return; }

    var startComp = app.root.findComponent('gsplat');
    if (!startComp) { requestAnimationFrame(start); return; }
    var startEntity = startComp.entity;
    var Entity = startEntity.constructor;
    entities[0] = startEntity;

    // When the collision overlay is enabled after the user has already moved to
    // another scene, its buffers are stale -> refresh to the active scene.
    var ev = viewer && viewer.global && viewer.global.events;
    if (ev && ev.on) {
      ev.on('collisionOverlayEnabled:changed', function (on) { if (on) refreshOverlay(); });
    }

    for (var i = 1; i < data.portalScenes.length; i++) {
      (function (idx) {
        var url = data.portalScenes[idx];
        if (!url) return;
        // loadFromUrl builds + loads the gsplat Asset internally (Task 8: the
        // start entity's gsplat.asset is a numeric id, so the Asset class is not
        // reachable that way). Works for both SOG and streaming (lod-meta.json).
        app.assets.loadFromUrl(url, 'gsplat', function (err, asset) {
          if (err || !asset) { console.warn('portal scene ' + idx + ' failed to load:', err); return; }
          var e = new Entity('portalScene' + idx);
          e.addComponent('gsplat', { unified: true, asset: asset });
          // The start gsplat is parented directly to app.root in exported
          // viewers, so copying its LOCAL transform places extra scenes in the
          // same shared world frame the export already baked them into.
          e.setLocalPosition(startEntity.getLocalPosition());
          e.setLocalRotation(startEntity.getLocalRotation());
          e.setLocalScale(startEntity.getLocalScale());
          app.root.addChild(e);
          e.enabled = (idx === activeIndex);
          entities[idx] = e;
          app.renderNextFrame = true;
        });
      })(i);
    }

    applyActive();
    preloadCollisions();
    requestAnimationFrame(tick);
  }

  var tickErrored = false;
  function tick() {
    // Never let a stray error kill the rAF loop (which would freeze navigation
    // entirely and switching with it); log it once and keep ticking.
    try {
      var viewer = window.__supersplatViewer;
      var cm = viewer && viewer.cameraManager;
      var cam = cm && cm.camera;
      if (cam && cam.position) {
        var cur = [cam.position.x, cam.position.y, cam.position.z];
        var st = getState();
        // In animation mode the camera is driven by the authored path, so the
        // active scene is a pure function of the cursor time (handles play,
        // scrub, scrubTo and loop wrap). In free navigation, detect crossings
        // from frame-to-frame motion. lastSafe is kept fresh in both so the
        // hand-off between modes never produces a spurious crossing.
        // If state is unreachable (st null) we fall back to the free-nav branch;
        // exports always bake a truthy timeline, so this only degrades to
        // delta-detection in the unexpected case where the viewer state is missing.
        if (st && st.cameraMode === 'anim' && timeline) {
          switchTo(sceneAtTime(st.animationTime || 0));
        } else if (lastSafe) {
          // A crossing whose target scene has not finished loading (entities[next]
          // missing) is skipped; eager preload at startup makes this rare.
          var next = resolveActiveSplat(lastSafe, cur, rects, activeIndex, segmentCrossesRect);
          if (next !== activeIndex && next !== null && entities[next]) {
            switchTo(next);
          }
        }
        lastSafe = cur;
      }
    } catch (err) {
      if (!tickErrored) { tickErrored = true; console.warn('portal tick error (suppressed further):', err); }
    }
    // Advance the loading overlay (outside the pose guard so it polls every
    // frame). Self-contained try/catch: a throw here must never kill the rAF
    // loop nor leave the overlay stuck, so on error we just clear it.
    try {
      if (pendingIndex !== null) {
        pendingFrames++;
        var pApp = getApp(window.__supersplatViewer);
        if (pApp) { pApp.renderNextFrame = true; }
        var c = gsplatCount();
        // Threshold reveal needs us to be measuring the NEW scene: after the
        // swap the count briefly lags at the old scene's (high) value, so only
        // arm the trigger once it has dipped below the threshold.
        if (revealThreshold > 0 && c < revealThreshold) { crossedBelow = true; }
        // Plateau tracking (fallback), after the swap lag clears.
        if (pendingFrames >= SETTLE_FRAMES) {
          if (c > peakCount) { peakCount = c; plateauFrames = 0; }
          else if (c >= peakCount * PLATEAU_TOL) { plateauFrames++; }
          else { plateauFrames = 0; }
        }
        var ready =
          (revealThreshold > 0 && crossedBelow && c >= revealThreshold) ||
          (peakCount > 0 && plateauFrames >= PLATEAU_FRAMES) ||
          (pendingFrames > LOADING_MAX_FRAMES);
        if (ready) {
          endLoading();
        } else if (!overlayShown && pendingFrames >= SHOW_DELAY) {
          showLoading();
          overlayShown = true;
        }
      }
    } catch (e) {
      endLoading();
    }
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(start);
})();
`;

// Produce the full HTML fragment to inject before </body>, or '' when no portals
// are configured. The payload global is HTML-escaped so it cannot break out of
// the injected <script> tag (mirrors buildOffLimitsZonesInjection escaping).
const buildPortalsInjection = (viewerSettingsJson: any): string => {
    const portals = viewerSettingsJson?.portals;
    if (!portals || portals.length === 0) {
        return '';
    }
    // Precompute the active scene over the camera-animation timeline so the
    // exported viewer can switch scenes by cursor time (play/scrub) rather than
    // only by frame-to-frame crossings. Uses the first anim track, matching the
    // viewer's getAnimTrack (animTracks[0]).
    const portalRects = portals.map((p: any) => ({
        position: p.position,
        rotation: p.rotation,
        width: p.width,
        height: p.height,
        frontUid: p.front,
        backUid: p.back,
        infinite: p.infinite
    }));
    const portalAnimTimeline = buildPortalAnimTimeline(
        viewerSettingsJson.animTracks?.[0] ?? null,
        portalRects,
        viewerSettingsJson.portalStart ?? 0
    );
    const payload = {
        portals,
        portalScenes: viewerSettingsJson.portalScenes ?? [],
        portalStart: viewerSettingsJson.portalStart ?? 0,
        portalCollision: viewerSettingsJson.portalCollision ?? [],
        portalEnvironments: viewerSettingsJson.portalEnvironments ?? [],
        portalSceneLodCounts: viewerSettingsJson.portalSceneLodCounts ?? [],
        portalAnimTimeline,
        loadingDefaults: DEFAULT_MESSAGES
    };
    // Escape characters unsafe inside an HTML <script> context so the payload
    // cannot break out of the injected script tag (mirrors off-limits-zones.ts:
    // < > & are escaped; U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR
    // are escaped because they are treated as line terminators in JS).
    const payloadJson = JSON.stringify(payload)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
    return `<style>${companionStyle}</style>` +
        `<script>window.__supersplatPortals = ${payloadJson};</script>` +
        `<script>${companionRuntime}</script>`;
};

export { buildPortalsInjection, resolveLoadingMessage, DEFAULT_MESSAGES };
