import { buildPortalAnimTimeline } from '../portal-anim-timeline';
import { segmentCrossesRect, resolveActiveSplat } from '../portal-geom';
import { collectLodFileUrls, collectSogBlockFileUrls, buildPortalAdjacency, desiredResidentScenes, assignPinDepths, computeWarmSet, computeResidentCeiling, selectResidentScenes } from '../portal-preload';

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
  var collectLodFileUrls = ${collectLodFileUrls.toString()};
  var collectSogBlockFileUrls = ${collectSogBlockFileUrls.toString()};
  var buildPortalAdjacency = ${buildPortalAdjacency.toString()};
  var desiredResidentScenes = ${desiredResidentScenes.toString()};
  var selectResidentScenes = ${selectResidentScenes.toString()};
  var computeResidentCeiling = ${computeResidentCeiling.toString()};
  var assignPinDepths = ${assignPinDepths.toString()};
  var computeWarmSet = ${computeWarmSet.toString()};
  var loadingText = resolveLoadingMessage('', data.loadingDefaults || {}, navigator.language || 'en');

  // Live pc.AppBase handle (primary path confirmed by the Task 8 spike, navCursor fallback).
  function getApp(v) { return (v && v.debugPanel && v.debugPanel._global && v.debugPanel._global.app) || (v && v.navCursor && v.navCursor.app) || null; }

  var entities = [];                       // scene index -> gsplat Entity (index 0 = start)
  var comps = [];                           // scene index -> gsplat component (for per-scene lodRange control)
  var octrees = [];                         // scene index -> GSplatOctree (or null for SOG)
  var deviceFinest = null;                  // finest (lowest) LOD level the engine has actually loaded for the start scene = the finest this DEVICE renders (0 desktop, coarser on tight budget). Running-min.
  var assets = [];                          // scene index -> loaded gsplat Asset
  var pinnedFiles = [];                     // scene index -> [octree file indices we incRefCount-ed]
  var pinGen = [];                          // scene index -> pin generation; bumped on unpin to invalidate an in-flight pump
  var pinBatches = [];                      // scene index -> [{files, markReady, done}] in level-major (coarsest-first) order
  var pinPumping = [];                      // scene index -> a pump rAF loop is active
  var PIN_WAVE = 4;                         // max not-yet-loaded pinned files kept in-flight per scene: the engine's per-scene block loader is a 2-concurrent FIFO, so flooding it with every pinned URL would starve interactive requests (the start scene's initial load + environment, a crossed-into scene's per-view files) behind the whole preload backlog
  var sceneMinLevel = [];                   // scene index -> device-depth level (its reveal lodRangeMin)
  var adjacency = null;                     // built in start() from data.portals
  var pinnedScenes = {};                    // scene index -> true when currently pinned
  var pinDepth = [];                        // scene index -> currently applied pin depth (min pinned level)
  var recency = [];                         // scene indices, most-recently-active first (LRU)
  // Mobile detection (UA-based, mirroring the viewer's own platform split; iPadOS
  // reports as Mac + multi-touch). Used only to pick the resident multiplier.
  var IS_MOBILE = (function () {
    try {
      var ua = navigator.userAgent || '';
      if (/android|iphone|ipad|ipod|windows phone|mobile/i.test(ua)) { return true; }
      return ((navigator.maxTouchPoints || 0) > 1 && /mac/i.test(navigator.platform || ''));
    } catch (e) { return false; }
  })();
  // Render-budget multiple used by computeResidentCeiling: the whole ceiling
  // on mobile (conservative -- never-OOM outranks instant crossings there),
  // only a lower FLOOR on desktop, where the ceiling is project-aware (the
  // summed pyramid cost of ALL scenes, capped by a RAM-derived limit) so any
  // project that fits memory stays fully resident and never re-streams. Tune
  // live via ?residentBudget=<n> (counts resident splats across ALL pinned
  // LOD levels, ~1.9x the finest-level splat total).
  var RESIDENT_BUDGET_MULT = IS_MOBILE ? 3 : 12;
  var residentBudgetOverride = (function () {
    // ?residentBudget=<n> overrides the ceiling for on-device tuning.
    // String ops only: this runtime is authored inside a template literal,
    // where regex character-class escapes lose their backslash at build time
    // (the original digit-class regex shipped without it and never matched --
    // the override was silently dead in the field). No backslashes here.
    try {
      var q = location.search || '';
      var key = 'residentBudget=';
      var k = q.indexOf(key);
      while (k > 0 && q.charAt(k - 1) !== '?' && q.charAt(k - 1) !== '&') {
        k = q.indexOf(key, k + 1);
      }
      if (k <= 0) { return 0; }
      var v = parseInt(q.substring(k + key.length), 10);
      return (isFinite(v) && v > 0) ? v : 0;
    } catch (e) { return 0; }
  })();
  var pinReady = false;                     // set once the budget + deviceFinest have first settled; later reconciles run immediately
  var viewerReady = false;                  // set when the viewer fires 'firstFrame' (initial load done); preload waits for it
  var lastDiag = '';                        // last logged residency diagnostic (dedupe)
  var sceneLoading = [];                    // scene index -> gsplat asset load in flight
  var liveApp = null;                       // pc.AppBase, captured once start() finds it
  var startEntityRef = null;                // the viewer's own start-scene entity (transform template for extra scenes)
  var EntityCtor = null;                    // pc.Entity constructor (reached via the start entity)
  var activeIndex = data.portalStart || 0;
  // Streaming vs SOG: streaming scenes stream progressively via the pin
  // machinery; SOG scenes are frontier-managed whole assets (loaded when they
  // enter the adjacency frontier, fully unloaded when they leave), so a fast
  // crossing into a still-loading SOG scene shows the loading overlay too.
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
  // --- GPU memory field diagnostic (mobile device-lost investigation) ----
  // The Android "OOM" presents as a WebGPU device loss (Dawn: "A valid
  // external Instance reference no longer exists" -> handleDeviceLost). Log
  // the engine's own VRAM accounting (graphicsDevice._vram byte counters) so
  // a remote-debug session shows the memory curve up to the death: a sample
  // every 5s when the total moved >= 32MB, one on every crossing (the loss
  // correlates with crossings), and a final line from the devicelost event.
  var lastVramLogged = -1;                  // last logged total (MB), -1 = never
  function vramLine() {
    try {
      var d = liveApp && liveApp.graphicsDevice;
      var v = d && d._vram;
      if (!v) { return ''; }
      var mb = function (n) { return Math.round((n || 0) / 1048576); };
      var total = (v.tex || 0) + (v.vb || 0) + (v.ib || 0) + (v.sb || 0) + (v.ub || 0);
      return 'tex=' + mb(v.tex) + 'MB vb=' + mb(v.vb) + 'MB ib=' + mb(v.ib) +
             'MB sb=' + mb(v.sb) + 'MB ub=' + mb(v.ub) + 'MB total=' + mb(total) + 'MB';
    } catch (vramErr) { return ''; }
  }
  function logVram(tag, force) {
    var line = vramLine();
    if (!line) { return; }
    try {
      var total = parseInt(line.substring(line.lastIndexOf('total=') + 6), 10) || 0;
      if (!force && lastVramLogged >= 0 && Math.abs(total - lastVramLogged) < 32) { return; }
      lastVramLogged = total;
      console.info('[portals] vram' + (tag ? ' (' + tag + ')' : '') + ' ' + line);
    } catch (logVramErr) {}
  }

  // Switch to scene idx: enable it, swap collision, reconcile the frontier and
  // arm the loading overlay when the destination is not ready (still streaming,
  // or a SOG scene whose asset has not finished loading). Tolerates a target
  // whose entity does not exist yet: activeIndex flips immediately (the frontier
  // reconcile loads it) and the load callback enables it on arrival.
  function switchTo(idx) {
    if (idx === activeIndex || idx === null || idx === undefined) return;
    if (idx < 0 || idx >= data.portalScenes.length) return;
    activeIndex = idx;
    noteVisit(idx);
    logVram('crossing to ' + idx, true);
    applyActive();
    swapCollision(idx);
    scheduleRefine(idx);
    reconcileFrontier();
    if (!readyScenes[idx] && pendingIndex !== idx) { beginLoading(idx); }
  }

  // --- device-depth reveal -----------------------------------------------
  // Clamp a crossed-into scene to the device-budget LOD depth (sceneMinLevel)
  // so it shows the pinned-resident levels everywhere INSTANTLY (no black).
  // No re-open needed: the device level is already the final floor; the engine
  // will stream + refine anything finer on its own.
  function scheduleRefine(idx) {
    if (idx === 0) return;                                   // start scene is the viewer's own
    var comp = comps[idx];
    if (!comp) return;
    var min = (sceneMinLevel[idx] != null) ? sceneMinLevel[idx] : deviceMinLevel(idx);
    sceneMinLevel[idx] = min;
    comp.lodRangeMin = min;                                  // floor at device-depth (all pinned resident -> instant)
    comp.lodRangeMax = 1000;                                 // allow coarser for far nodes (also pinned)
    var app = getApp(window.__supersplatViewer);
    if (app) app.renderNextFrame = true;
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
  var REVEAL_LOD = 0;              // which LOD level's count to reveal at: 0 = coarsest (earliest/sparsest, kept resident by pinSceneToLevel), higher = finer/denser/later
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
  var voxelLoading = [];                   // scene index -> voxel fetch in flight
  var snapshotIdx = data.portalStart || 0; // scene whose field-set is the live-instance snapshot; retained all session (it is the restore source for walking back to the start and was captured, not fetched)
  var snapshotTaken = false;               // set once initCollisions captures the pristine start snapshot
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
  // Ensure scene idx's collision field-set is loaded (fetch once; concurrent
  // calls guarded). On completion: discard if the scene left the frontier while
  // fetching, and apply immediately if the user already crossed into it.
  function loadVoxel(idx) {
    if (!data.portalCollision || voxels[idx] || voxelLoading[idx]) return;
    var url = data.portalCollision[idx];
    if (!url) return;
    voxelLoading[idx] = true;
    parseVoxel(url).then(function (f) {
      voxelLoading[idx] = false;
      if (idx !== snapshotIdx && idx !== activeIndex && !sceneWanted(idx)) { return; }
      voxels[idx] = f;
      if (idx === activeIndex) swapCollision(idx);
    }).catch(function (err) {
      voxelLoading[idx] = false;
      console.warn('portal collision ' + idx + ' failed:', err);
    });
  }

  // Frontier-manage the collision field-sets: fetch voxels for the active scene
  // + its portal neighbours (scene 0 included -- crossing back into it must swap
  // to its data, which is the retained snapshot), drop the rest so their
  // Uint32Arrays can be GC'd. The start snapshot (snapshotIdx) is never dropped.
  function reconcileCollisions(want) {
    if (!data.portalCollision || data.portalCollision.length === 0) return;
    var keep = {};
    keep[snapshotIdx] = true;
    keep[activeIndex] = true;
    for (var i = 0; i < want.length; i++) { keep[want[i]] = true; }
    var neigh = (adjacency && adjacency[activeIndex]) || [];
    for (var n = 0; n < neigh.length; n++) { keep[neigh[n]] = true; }
    for (var idx = 0; idx < data.portalCollision.length; idx++) {
      if (keep[idx]) { loadVoxel(idx); } else if (voxels[idx]) { voxels[idx] = undefined; }
    }
  }

  // Startup: wait for the viewer's own (asynchronously loaded) collision
  // instance, snapshot the pristine start-scene field-set, then bring the
  // frontier in. Collision-on exports always bundle + load the instance.
  function initCollisions() {
    if (!data.portalCollision || data.portalCollision.length === 0) return;
    var live = liveCollision();
    if (!live) { requestAnimationFrame(initCollisions); return; }
    voxels[snapshotIdx] = snapshot(live);
    snapshotTaken = true;
    // If the user already crossed while we were waiting for the live instance,
    // bring collision in sync with the visuals now.
    if (activeIndex !== snapshotIdx && voxels[activeIndex]) { swapCollision(activeIndex); }
    reconcileCollisions(adjacency ? residentScenes() : []);
  }
  function swapCollision(idx) {
    var live = liveCollision();
    // Never overwrite the shared instance before the pristine start snapshot is
    // captured: the snapshot is the only restore source for the start scene.
    // initCollisions re-applies the active voxel right after snapshotting, so a
    // crossing during the startup poll still ends up in sync.
    if (!snapshotTaken || !live || !voxels[idx]) return;
    applyVoxel(live, voxels[idx]);
    // Live-update the overlay only if it is currently shown; otherwise it is
    // refreshed lazily when the user enables it (see the listener in start()).
    if (overlayEnabled()) refreshOverlay();
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
    comps[0] = startComp;
    // The start entity's gsplat.asset is a numeric id (set up by the viewer), so
    // resolve the Asset to reach its octree. Used to observe deviceFinest and to
    // pin scene 0's blocks (the engine frees a disabled scene's blocks, so the
    // start scene must be pin-managed like the extra scenes).
    octrees[0] = getOctree(app.assets.get(startComp.asset));
    adjacency = buildPortalAdjacency(
      (data.portals || []).map(function (p) { return { front: p.front, back: p.back }; }),
      data.portalScenes.length
    );

    // When the collision overlay is enabled after the user has already moved to
    // another scene, its buffers are stale -> refresh to the active scene.
    var ev = viewer && viewer.global && viewer.global.events;
    if (ev && ev.on) {
      // The viewer fires 'firstFrame' when its initial load completes (the
      // loading bar's ready gate). Preload/pinning waits for it: our traffic
      // would otherwise compete with the start scene's own (deliberately
      // small, coarsest-only) initial load and stall the bar. Reconcile right
      // after so scene 0's own pins (strictly firstFrame-gated) get applied.
      ev.on('firstFrame', function () { viewerReady = true; reconcileFrontier(); });
      ev.on('collisionOverlayEnabled:changed', function (on) { if (on) refreshOverlay(); });
      // The R shortcut and the viewer's reset menu both fire inputEvent 'reset',
      // returning the camera to its spawn pose. The spawn lives in the start
      // scene, but free-nav crossing detection can't see the move (it need not
      // pass through a doorway), so force the start scene here. lastSafe is
      // cleared so the spawn discontinuity isn't read as a spurious crossing on
      // the next frame. In anim mode the timeline-driven switchTo immediately
      // re-asserts the cursor's scene, so this is a harmless no-op there.
      ev.on('inputEvent', function (name) {
        if (name === 'reset') { switchTo(data.portalStart || 0); lastSafe = null; }
      });
    }

    liveApp = app;
    startEntityRef = startEntity;
    EntityCtor = Entity;
    // Streaming scenes load eagerly: the asset is only the small lod-meta.json
    // (a disabled scene streams no blocks on its own). SOG scenes are frontier-
    // managed by reconcileFrontier: the asset IS the full splat data, so only
    // the active scene's portal neighbours are kept loaded.
    for (var i = 1; i < data.portalScenes.length; i++) {
      var u = data.portalScenes[i];
      if (u && u.indexOf('lod-meta.json') !== -1) { loadScene(i); }
    }

    noteVisit(activeIndex);
    applyActive();
    reconcileFrontier();
    initCollisions();
    // Stuck-loading-bar field diagnostic: the bar completes (and the viewer
    // fires firstFrame) only when the gsplat manager reports
    //   ready  = world.currentVersion === world.lastWorldStateVersion
    //            && !world.awaitingLodUpdate      (sorter caught up, no LOD due)
    //   loading = world.pendingLoadCount === 0    (instance pending + env)
    // so dump BOTH sides plus the start scene's block-loader state. Logged at
    // 20s and again at 45s (two samples show whether anything is moving).
    function startupDiag(tag) {
      try {
        var out = tag + ':';
        var oc = octrees[0];
        if (oc && oc.files) {
          var total = oc.files.length;
          var res = 0;
          for (var fi = 0; fi < total; fi++) { if (oc.getFileResource && oc.getFileResource(fi)) { res++; } }
          out += ' files=' + res + '/' + total;
          out += ' envUrl=' + (oc.environmentUrl || 'none') + ' envLoaded=' + !!oc.environmentResource;
          var al = oc.assetLoader;
          if (al) {
            out += ' loaderQueue=' + (al._loadQueue ? al._loadQueue.length : '?') +
                   ' loading=' + (al._currentlyLoading ? al._currentlyLoading.size : '?');
            if (al._retryCount && al._retryCount.size) {
              var retries = [];
              al._retryCount.forEach(function (v, k) { retries.push(k + ' x' + v); });
              out += ' retries=[' + retries.join(', ') + ']';
            }
          }
        }
        var dApp = getApp(window.__supersplatViewer);
        var dir = dApp && dApp.renderer && dApp.renderer.gsplatDirector;
        if (dir && dir.camerasMap) {
          dir.camerasMap.forEach(function (cd) {
            if (!cd || !cd.layersMap) { return; }
            cd.layersMap.forEach(function (ld) {
              var m = ld && ld.gsplatManager;
              if (!m || !m.world) { return; }
              var w = m.world;
              out += ' | ver=' + w.currentVersion + '/' + w.lastWorldStateVersion +
                     ' awaitingLod=' + !!w.awaitingLodUpdate +
                     ' pendingLoad=' + w.pendingLoadCount;
              if (m.cpuSorter) { out += ' sortJobs=' + m.cpuSorter.jobsInFlight; }
            });
          });
        }
        console.info('[portals] ' + out);
      } catch (diagErr) {}
    }
    setTimeout(function () { if (!viewerReady) { startupDiag('startup not ready after 20s'); } }, 20000);
    setTimeout(function () { if (!viewerReady) { startupDiag('startup still not ready after 45s'); } }, 45000);

    // GPU-memory curve sampler + devicelost hook (see vramLine above): the
    // periodic sample self-mutes while the total is stable, so a quiet run
    // logs almost nothing and a climb toward device loss is fully visible.
    setInterval(function () { logVram('', false); }, 5000);
    try {
      var gdev = app.graphicsDevice;
      if (gdev && gdev.on) {
        gdev.on('devicelost', function () {
          console.warn('[portals] DEVICE LOST -- last vram: ' + (vramLine() || 'unavailable') +
                       ' (previous logged total=' + lastVramLogged + 'MB)');
        });
      }
    } catch (dlErr) {}

    // --- engine ready-gate watchdog ------------------------------------
    // Upstream engine race (reproduces on SINGLE-scene exports too, cold
    // cache only): an octree instance's pending/prefetchPending can retain an
    // entry that never completes while the block loader sits idle -- either
    // the entry's placement was already nulled (the completion check requires
    // it), or its asset ended up loaded-without-resource (ensureFileResource
    // then no-ops forever). world.pendingLoadCount then never reaches 0, so
    // the viewer's ready gate (ready && loading === 0) never fires: the
    // loading bar parks at ~95%, firstFrame (walkthrough autostart) never
    // fires, and splatBudget stays 0 = the engine budget balancer is DISABLED
    // (unbounded streaming -> mobile OOM). Until fixed upstream, repair the
    // bookkeeping in place; each pass logs what it fixed.
    function unstickInstances() {
      var fixed = 0;
      var dApp = getApp(window.__supersplatViewer);
      var dir = dApp && dApp.renderer && dApp.renderer.gsplatDirector;
      if (!dir || !dir.camerasMap) { return 0; }
      dir.camerasMap.forEach(function (cd) {
        if (!cd || !cd.layersMap) { return; }
        cd.layersMap.forEach(function (ld) {
          var m = ld && ld.gsplatManager;
          var w = m && m.world;
          var insts = w && w._octreeInstances;
          if (!insts || !insts.forEach) { return; }
          insts.forEach(function (inst) {
            try {
              var oc = inst && inst.octree;
              var al = oc && oc.assetLoader;
              if (!oc || !al) { return; }
              var busy = (al._currentlyLoading && al._currentlyLoading.size) ||
                         (al._loadQueue && al._loadQueue.length);
              if (busy) { return; }   // loader active -> not stuck, let it work
              // Kick a file whose asset the loader considers done but that
              // produced no resource: unload it so the instance's next
              // ensureFileResource poll starts a FRESH load.
              var kick = function (fi) {
                if (oc.getFileResource && oc.getFileResource(fi)) { return; }   // completes naturally
                var url = oc.files && oc.files[fi] && oc.files[fi].url;
                var asset = url && al._urlToAsset && al._urlToAsset.get(url);
                if (asset && asset.loaded && !asset.resource) { al.unload(url); fixed++; }
              };
              if (inst.pending && inst.pending.forEach) {
                var stale = [];
                inst.pending.forEach(function (fi) {
                  // A pending entry whose placement is gone can never complete
                  // (addFilePlacement requires the placement): drop it -- the
                  // delete decrementFileRef should have done.
                  if (!inst.filePlacements || !inst.filePlacements[fi]) { stale.push(fi); } else { kick(fi); }
                });
                for (var s = 0; s < stale.length; s++) { inst.pending.delete(stale[s]); fixed++; }
              }
              if (inst.prefetchPending && inst.prefetchPending.forEach) {
                inst.prefetchPending.forEach(function (fi) { kick(fi); });
              }
              if (oc.environmentUrl && !inst.environmentPlacement && al._urlToAsset) {
                var ea = al._urlToAsset.get(oc.environmentUrl);
                if (ea && ea.loaded && !ea.resource) { al.unload(oc.environmentUrl); fixed++; }
              }
            } catch (instErr) {}
          });
        });
      });
      return fixed;
    }
    var watchdogTicks = 0;
    var watchdogTimer = setInterval(function () {
      if (viewerReady) { clearInterval(watchdogTimer); return; }
      watchdogTicks++;
      if (watchdogTicks < 3) { return; }   // grace: give a cold initial load 15s before touching anything
      try {
        var fixed = unstickInstances();
        if (fixed > 0) { console.info('[portals] ready-gate watchdog repaired ' + fixed + ' stuck entr' + (fixed === 1 ? 'y' : 'ies')); }
        // Priority-1 backstop: if the ready gate still has not fired, the
        // viewer never applied a splat budget and the engine streams
        // UNBOUNDED. Apply the viewer's own high-quality default so a phone
        // can never OOM from an un-ready start (applyPerfSettings simply
        // overwrites this with the same value once ready fires), and
        // reconcile so pins pick up the now-real ceiling.
        var bApp = getApp(window.__supersplatViewer);
        var gs = bApp && bApp.scene && bApp.scene.gsplat;
        if (gs && !gs.splatBudget) {
          gs.splatBudget = (IS_MOBILE ? 2 : 4) * 1000000;
          console.info('[portals] ready-gate watchdog applied fallback splatBudget=' + gs.splatBudget);
          reconcileFrontier();
        }
      } catch (wdErr) {}
    }, 5000);
    requestAnimationFrame(tick);
  }

  var tickErrored = false;
  function tick() {
    // Never let a stray error kill the rAF loop (which would freeze navigation
    // entirely and switching with it); log it once and keep ticking.
    try {
      updateDeviceFinest();
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
          // A crossing whose target has neither loaded nor started loading is
          // skipped (defensive: frontier preloading starts every reachable
          // neighbour's load, so this only bites after a load failure).
          var next = resolveActiveSplat(lastSafe, cur, rects, activeIndex, segmentCrossesRect);
          if (next !== activeIndex && next !== null && (entities[next] || sceneLoading[next])) {
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

  // --- preload (cache-warming) of extra streaming scenes ----------------
  // --- cache-warming fetch helpers (used by warmScene below) ------------
  // Plain fetch only: populate the BROWSER CACHE, keep nothing resident (no
  // engine APIs, zero added RAM/VRAM, which matters on low-end devices). A
  // streaming scene's lod-meta.json lists per-block meta.json files; each block
  // in turn bundles the heavy data as webp textures, so warming is TWO levels:
  // lod-meta -> block-metas -> webps. Failures are non-fatal (the on-crossing
  // overlay covers a cold file).
  function fetchJson(u) {
    return fetch(u).then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); });
  }
  // Warm a flat list of URLs with a small concurrency cap so we don't starve
  // the start scene's own stream.
  function warmUrls(urls) {
    var CONCURRENCY = 4;
    var total = urls.length, active = 0, idx = 0;
    function next() {
      while (active < CONCURRENCY && idx < total) {
        var url = urls[idx++];
        active++;
        // Only populate the HTTP cache; the body is consumed then discarded.
        fetch(url).then(function (r) { return (r && r.arrayBuffer) ? r.arrayBuffer() : null; })
          .catch(function () { /* non-fatal: the on-crossing overlay covers a cold file */ })
          .then(function () { active--; next(); });
      }
    }
    next();
  }
  // The device splat budget, read from the live app (set after the start scene's
  // first ready). 0 until then.
  function getSplatBudget() {
    var app = getApp(window.__supersplatViewer);
    var b = app && app.scene && app.scene.gsplat && app.scene.gsplat.splatBudget;
    return (typeof b === 'number' && b > 0) ? b : 0;
  }
  // Total resident splats we allow across all kept scenes (see
  // computeResidentCeiling): mobile = MULT x render budget; desktop = the
  // whole project's pyramid cost when a RAM-derived cap allows it. 0 until
  // the budget is known.
  function getResidentCeiling() {
    var costs = sceneCosts();
    var total = 0;
    for (var i = 0; i < costs.length; i++) { total += (costs[i] || 0); }
    var mem = 0;
    try { mem = navigator.deviceMemory || 0; } catch (e) { mem = 0; }
    return computeResidentCeiling(residentBudgetOverride, getSplatBudget(), RESIDENT_BUDGET_MULT, IS_MOBILE, total, mem);
  }
  // Per-scene resident cost in splats: streaming = whole-scene count at the
  // device-finest level [deviceFinest..coarsest]; SOG = its single baked count.
  // 0 (free) when no count is baked (older SOG exports).
  function sceneCost(idx) {
    var counts = (data.portalSceneLodCounts || [])[idx];
    if (!counts || !counts.length) { return 0; }
    var coarse = counts.length - 1;
    var lv = (deviceFinest !== null) ? Math.min(Math.max(deviceFinest, 0), coarse) : coarse;
    var sum = 0;
    for (var i = lv; i < counts.length; i++) { sum += (counts[i] || 0); }
    return sum;
  }
  function sceneCosts() {
    var arr = [];
    for (var i = 0; i < data.portalScenes.length; i++) { arr[i] = sceneCost(i); }
    return arr;
  }
  // The budget-bounded resident set for the LIVE activeIndex (replaces Plan 3's
  // adjacency-only desiredResidentScenes across the reconcile paths).
  function residentScenes() {
    return selectResidentScenes(adjacency, activeIndex, recency, sceneCosts(), getResidentCeiling());
  }
  // Track most-recently-active order for LRU eviction under a tight budget.
  function noteVisit(idx) {
    var i = recency.indexOf(idx);
    if (i >= 0) { recency.splice(i, 1); }
    recency.unshift(idx);
  }
  // --- incremental cache-warming of distance-2 scenes --------------------
  // When the frontier shifts (startup + each crossing), warm the HTTP cache for
  // scenes at graph distance 2 (neighbours of the pinned frontier that are not
  // themselves pinned): distance <= 1 is pinned resident, distance 2 becomes
  // pinned after one more crossing, so a warm cache makes that future pin fetch
  // fast. Streaming scenes warm their block files down to the device-observed
  // finest level (exactly what a future pin would fetch); SOG scenes warm the
  // single .sog bundle. Plain fetch only (nothing resident). Each scene warms at
  // most once per session. Failures are non-fatal (the loading overlay covers a
  // cold crossing). Scenes >= 3 hops away are neither resident nor warmed --
  // the accepted trade for bounded memory.
  var warmedScenes = {};
  function warmScene(idx) {
    var u = data.portalScenes[idx];
    if (!u) return;
    if (u.indexOf('lod-meta.json') === -1) { warmUrls([u]); return; }   // SOG: one bundle file
    fetchJson(u).then(function (meta) {
      var coarse = (meta && meta.lodLevels) ? meta.lodLevels - 1 : 0;
      var min = (deviceFinest !== null) ? Math.min(deviceFinest, coarse) : coarse;
      // Phones: warm only the two coarsest levels. A future mobile pin is
      // depth-degraded anyway (tight ceiling), and warming a full pyramid
      // churns hundreds of MB through memory/data for blocks never pinned.
      if (IS_MOBILE) { min = Math.max(min, coarse > 0 ? coarse - 1 : 0); }
      return collectLodFileUrls(meta, u, min);
    }).then(function (blockUrls) {
      return Promise.all(blockUrls.map(function (burl) {
        return fetchJson(burl)
          .then(function (bmeta) { return collectSogBlockFileUrls(bmeta, burl); })
          .catch(function (err) { console.warn('portal warm block-meta failed (' + burl + '):', err); return []; });
      }));
    }).then(function (perBlock) {
      var webpUrls = [];
      perBlock.forEach(function (arr) { for (var k = 0; k < arr.length; k++) { webpUrls.push(arr[k]); } });
      warmUrls(webpUrls);
    }).catch(function (err) { console.warn('portal warm lod-meta failed (' + u + '):', err); });
  }
  function warmFrontier(want) {
    if (!adjacency) return;
    var warmSet = computeWarmSet(activeIndex, adjacency, want);
    for (var i = 0; i < warmSet.length; i++) {
      var idx = warmSet[i];
      if (!warmedScenes[idx]) { warmedScenes[idx] = true; warmScene(idx); }
    }
  }

  // Reach the streaming octree from a loaded gsplat asset, tolerating either
  // resource shape (GSplatOctreeResource.octree, or the octree directly). Null
  // for SOG / non-streaming assets.
  function getOctree(asset) {
    var r = asset && asset.resource;
    if (!r) { return null; }
    if (r.octree && r.octree.files) { return r.octree; }
    if (r.files && r.incRefCount) { return r; }
    return null;
  }

  // Observe the finest (lowest) LOD level the engine has actually made resident
  // for the start scene = the finest level THIS DEVICE renders (0 on desktop;
  // coarser on a tight budget where the engine's budget balancer caps near nodes).
  // Running-min so it only deepens as the start scene streams its near detail in.
  function updateDeviceFinest() {
    var oc = octrees[0];
    if (!oc || !oc.files || !oc.getFileResource) { return; }
    var best = null;
    for (var i = 0; i < oc.files.length; i++) {
      var f = oc.files[i];
      if (f && oc.getFileResource(i) && (best === null || f.lodLevel < best)) { best = f.lodLevel; }
    }
    if (best !== null && (deviceFinest === null || best < deviceFinest)) { deviceFinest = best; }
  }

  function deviceMinLevel(idx) {
    // Pin adjacent scenes down to the finest level the device actually renders
    // (observed via deviceFinest), CLAMPED to this scene's own coarsest level --
    // a neighbour can have fewer LOD levels than the start scene we observed it on,
    // and an out-of-range floor would pin zero blocks / reveal nothing (a gap).
    // Revealing at that level matches the engine's per-node optimal for this device
    // -> nothing finer to stage -> immediate; pinning no finer than the device
    // shows -> bounded on low-end. Coarsest fallback until deviceFinest is known.
    var octree = octrees[idx];
    var coarse = (octree && octree.lodLevels) ? octree.lodLevels - 1 : 0;
    return (deviceFinest !== null) ? Math.min(deviceFinest, coarse) : coarse;
  }

  // Pin LOD levels [minLevel .. maxLevel] of a streaming scene RESIDENT
  // (decoded, in GPU) via the engine's octree loader, so a crossing into it shows
  // device-appropriate quality with no cold streaming. incRefCount immediately
  // (files never enter the unload cooldown), then enqueue the batch on the
  // scene's pin pump, which loads it wave-by-wave (see pumpPins). markReady:
  // set readyScenes[idx] once THIS batch is resident -- the caller passes it on
  // the coarsest-level batch, so a crossing drops the loading overlay as soon
  // as coarse whole-scene content is showable (finer levels keep streaming
  // behind the visible scene). Records the pinned file indices for later
  // reclaim. SOG scenes (no octree) are a no-op. Idempotent-ish: files already
  // pinned are re-polled by the pump but not re-pinned.
  function pinSceneToLevel(asset, idx, minLevel, maxLevel, markReady) {
    // Scene 0 has no tracked asset (the viewer owns it): fall back to the octree
    // captured in start() instead of clobbering it with null.
    var octree = getOctree(asset) || octrees[idx] || null;
    octrees[idx] = octree;
    if (!octree || !octree.lodLevels || !octree.files ||
        !octree.incRefCount || !octree.ensureFileResource || !octree.getFileResource) { return; }
    if (maxLevel === undefined || maxLevel === null) { maxLevel = 1000000; }
    if (!pinnedFiles[idx]) { pinnedFiles[idx] = []; }
    var already = {};
    for (var p = 0; p < pinnedFiles[idx].length; p++) { already[pinnedFiles[idx][p]] = true; }
    var batch = [];
    for (var i = 0; i < octree.files.length; i++) {
      var f = octree.files[i];
      if (f && f.lodLevel >= minLevel && f.lodLevel <= maxLevel) {
        if (!already[i]) {
          try { octree.incRefCount(i); pinnedFiles[idx].push(i); }
          catch (e) { console.warn('portal pin block ' + i + ' (scene ' + idx + ') failed:', e); continue; }
        }
        batch.push(i);
      }
    }
    if (!pinBatches[idx]) { pinBatches[idx] = []; }
    pinBatches[idx].push({ files: batch, markReady: !!markReady, done: false });
    pumpPins(idx);
  }

  // Per-scene pin pump: walk the scene's batches strictly in order (level-major,
  // coarsest first) and keep at most PIN_WAVE not-yet-loaded files in flight.
  // The engine's per-scene block loader is a 2-concurrent FIFO with no
  // prioritisation, so a small wave leaves it responsive to interactive
  // requests instead of burying them behind the whole preload. A completed
  // batch flagged markReady marks the scene ready (drops a pending overlay).
  // While a crossing is loading (pendingIndex), pumps of the OTHER scenes yield
  // so the destination scene gets the bandwidth. A reclaim bumps pinGen and the
  // pump exits (pinBatches was cleared).
  function pumpPins(idx) {
    if (pinPumping[idx]) { return; }
    pinPumping[idx] = true;
    var gen = pinGen[idx] || 0;
    (function pump() {
      if ((pinGen[idx] || 0) !== gen) { pinPumping[idx] = false; return; }
      var octree = octrees[idx];
      var batches = pinBatches[idx] || [];
      if (!octree || !octree.ensureFileResource || !octree.getFileResource) { pinPumping[idx] = false; return; }
      if (pendingIndex !== null && pendingIndex !== idx && activeIndex !== idx) {
        requestAnimationFrame(pump);   // yield bandwidth to the scene being crossed into
        return;
      }
      var inflight = 0;
      var allDone = true;
      for (var b = 0; b < batches.length; b++) {
        var bt = batches[b];
        if (bt.done) { continue; }
        var missing = 0;
        for (var j = 0; j < bt.files.length; j++) {
          if (!octree.getFileResource(bt.files[j])) {
            missing++;
            if (inflight < PIN_WAVE) { octree.ensureFileResource(bt.files[j]); inflight++; }
          }
        }
        if (missing === 0) {
          bt.done = true;
          if (bt.markReady) { readyScenes[idx] = true; }
          continue;
        }
        allDone = false;
        break;   // strict order: don't start a finer batch before this one is resident
      }
      if (allDone) { pinPumping[idx] = false; return; }
      requestAnimationFrame(pump);
    })();
  }

  // Reclaim an extra scene's pinned blocks. decRefCount(i, 0) routes to the
  // octree's immediate unloadResource when our pin was the last ref (a disabled
  // scene has no render instance, so nothing else holds these). An ACTIVE scene's
  // instance holds its own ref, so this never frees blocks it is still rendering
  // (count stays > 0). Clears our bookkeeping and marks the scene not-ready so a
  // later crossing into it re-pins/loads. Engine cooldown never ticks a disabled
  // octree, so this explicit call is the only way to free a hidden scene's memory.
  function unpinScene(idx) {
    var octree = octrees[idx];
    var files = pinnedFiles[idx];
    if (octree && octree.decRefCount && files) {
      for (var i = 0; i < files.length; i++) {
        try { octree.decRefCount(files[i], 0); }
        catch (e) { console.warn('portal unpin block ' + files[i] + ' (scene ' + idx + ') failed:', e); }
      }
    }
    pinnedFiles[idx] = [];
    pinBatches[idx] = [];
    pinGen[idx] = (pinGen[idx] || 0) + 1;   // invalidate the scene's in-flight pin pump
    readyScenes[idx] = false;
  }

  function getAsset(idx) { return assets[idx] || null; }

  // Defer the FIRST frontier reconcile until the device splat budget is applied AND
  // the observed deviceFinest has settled (stopped deepening) -- deviceMinLevel
  // reads deviceFinest to pick the pin/reveal depth, so pinning before the start
  // scene has streamed its finest near detail would pin too coarse. Frame-capped.
  // Once settled (pinReady), later calls reconcile immediately so a crossing never
  // waits ~1s to pin its new neighbours.
  function pinWhenBudgetReady() {
    if (pinReady) { pinDesired(); return; }
    var waited = 0, last = null, stableFor = 0;
    (function poll() {
      if (pinReady) { pinDesired(); return; }
      updateDeviceFinest();
      if (deviceFinest !== last) { last = deviceFinest; stableFor = 0; } else { stableFor++; }
      // SOG exports have no start octree to observe, so deviceFinest never
      // settles -- don't hold the first reconcile (and warming) for it. Also
      // wait for the viewer's own initial load (firstFrame): preload traffic
      // would otherwise compete with the start scene while the loading bar is
      // up. Frame-capped fallback (~30s) in case firstFrame never fires.
      if ((viewerReady && getSplatBudget() && (!streaming || deviceFinest !== null) && stableFor > 60) || waited++ > 1800) {
        pinReady = true; pinDesired(); return;
      }
      requestAnimationFrame(poll);
    })();
  }
  // Reconcile the resident frontier to the LIVE activeIndex (read here, never a
  // captured argument): a deferred poll may resolve a frame or a second after a
  // crossing, by which point activeIndex has changed. Reconciling to a stale scene
  // would unpin the new active and leak its re-pinned refs. Reading live activeIndex
  // makes every (possibly stale) call idempotent, and the "s !== active" check then
  // protects the true active scene.
  function pinDesired() {
    if (!adjacency) { return; }
    var active = activeIndex;
    var want = residentScenes();
    // Budget-capped per-scene depths: the active scene keeps deviceFinest; the
    // other resident scenes degrade toward coarser only if the summed pinned
    // splat count exceeds the RESIDENT ceiling (getResidentCeiling(), a multiple
    // of the engine budget). Pinned blocks of disabled scenes bypass the budget
    // balancer, so we cap the whole resident set ourselves.
    var depths = assignPinDepths(
      active,
      want,
      data.portalSceneLodCounts || [],
      deviceFinest,
      getResidentCeiling()
    );
    // One-line residency diagnostic (deduped) so a field E2E can read the
    // decision at a glance: any depth above deviceFinest or a scene missing
    // from resident=[] explains a visible re-stream on crossing.
    try {
      var diag = 'ceiling=' + getResidentCeiling() + ' costs=[' + sceneCosts().join(',') + ']' +
        ' resident=[' + want.join(',') + '] depths=' + JSON.stringify(depths) +
        ' deviceFinest=' + deviceFinest + ' active=' + active;
      if (diag !== lastDiag) { lastDiag = diag; console.info('[portals] ' + diag); }
    } catch (logErr) {}
    var wantSet = {};
    var pinMins = {};                 // scene idx -> target min level this reconcile (absent = pins already correct)
    var maxCoarse = 0;
    for (var i = 0; i < want.length; i++) {
      var idx = want[i];
      wantSet[idx] = true;
      if (!entities[idx] || !octrees[idx]) { continue; }
      // Scene 0 shares its block loader with the viewer's own initial load:
      // never queue its pins until firstFrame (the 30s fallback that unblocks
      // the OTHER scenes' pins must not touch the start scene's loader).
      if (idx === 0 && !viewerReady) { continue; }
      // Clamp the assigned depth to the loaded octree's real level span (the
      // payload counts can disagree with the octree; the octree is ground truth).
      var coarse = octrees[idx].lodLevels ? octrees[idx].lodLevels - 1 : 0;
      var min = (depths[idx] != null) ? Math.min(Math.max(depths[idx], 0), coarse) : deviceMinLevel(idx);
      if (pinnedScenes[idx] && min === pinDepth[idx]) { continue; }
      if (pinnedScenes[idx] && min > pinDepth[idx]) {
        // Role changed toward neighbour on a tight budget -> coarsen. Full
        // unpin + re-pin: pinSceneToLevel is additive so it cannot shed levels.
        // An ACTIVE scene's own instance holds refs, so unpin never frees what
        // is being rendered; a hidden scene reloads its coarse levels from the
        // HTTP cache (cheap: coarse levels are small).
        unpinScene(idx);
      }
      if (idx !== 0) {
        // Scene 0's lodRange floor stays viewer-owned (the engine's balancer
        // already drives the start scene); we only pin its blocks resident.
        sceneMinLevel[idx] = min;
        if (comps[idx]) { comps[idx].lodRangeMin = min; }
      }
      pinMins[idx] = min;
      if (coarse > maxCoarse) { maxCoarse = coarse; }
      pinnedScenes[idx] = true;
      pinDepth[idx] = min;
    }
    // Pin LEVEL-MAJOR, coarsest level first ACROSS scenes: every resident
    // scene's coarse (small, whole-scene) levels download before any scene's
    // fine levels, so a crossing during the preload window shows coarse
    // content almost immediately instead of the loading overlay. The coarsest
    // batch marks its scene ready (drops a pending overlay); finer batches
    // keep streaming behind the visible scene.
    for (var lv = maxCoarse; lv >= 0; lv--) {
      for (var w = 0; w < want.length; w++) {
        var ps = want[w];
        var pmin = pinMins[ps];
        if (pmin === undefined || pmin > lv || !octrees[ps]) { continue; }
        var pcoarse = octrees[ps].lodLevels ? octrees[ps].lodLevels - 1 : 0;
        if (lv > pcoarse) { continue; }
        pinSceneToLevel(getAsset(ps), ps, lv, lv, lv === pcoarse);
      }
    }
    for (var k in pinnedScenes) {
      var s = Number(k);
      if (pinnedScenes[s] && !wantSet[s] && s !== active) {
        unpinScene(s);
        pinnedScenes[s] = false;
        pinDepth[s] = null;
      }
    }
    // Warm here (not in reconcileFrontier): pinDesired runs once deviceFinest
    // has settled, so streaming scenes warm at the depth a future pin will fetch.
    warmFrontier(want);
  }

  // Load scene idx's gsplat asset and create its (disabled unless active)
  // entity. Extracted from start() so the frontier reconcile can (re)load SOG
  // scenes on demand. No-op until start() has captured the live handles.
  function loadScene(idx) {
    if (entities[idx] || sceneLoading[idx] || !liveApp) { return; }
    var url = data.portalScenes[idx];
    if (!url) { return; }
    var isStreamingScene = url.indexOf('lod-meta.json') !== -1;
    sceneLoading[idx] = true;
    // loadFromUrl builds + loads the gsplat Asset internally (the start entity's
    // gsplat.asset is a numeric id, so the Asset class is not reachable that
    // way). Works for both SOG and streaming (lod-meta.json).
    liveApp.assets.loadFromUrl(url, 'gsplat', function (err, asset) {
      sceneLoading[idx] = false;
      if (err || !asset) { console.warn('portal scene ' + idx + ' failed to load:', err); return; }
      // A SOG frontier may have moved on while the asset was in flight (fast
      // multi-crossing): discard instead of keeping a hidden full copy.
      // Streaming assets are always kept (only the small octree meta).
      if (!isStreamingScene && !sceneWanted(idx)) {
        try { liveApp.assets.remove(asset); asset.unload(); } catch (discardErr) { console.warn('portal scene ' + idx + ' discard failed:', discardErr); }
        return;
      }
      var e = new EntityCtor('portalScene' + idx);
      var comp = e.addComponent('gsplat', { unified: true, asset: asset });
      // The start gsplat is parented directly to app.root in exported viewers,
      // so copying its LOCAL transform places extra scenes in the same shared
      // world frame the export already baked them into.
      e.setLocalPosition(startEntityRef.getLocalPosition());
      e.setLocalRotation(startEntityRef.getLocalRotation());
      e.setLocalScale(startEntityRef.getLocalScale());
      liveApp.root.addChild(e);
      e.enabled = (idx === activeIndex);
      entities[idx] = e;
      comps[idx] = comp;
      assets[idx] = asset;
      octrees[idx] = getOctree(asset);
      sceneMinLevel[idx] = deviceMinLevel(idx);
      if (comp && octrees[idx]) {
        comp.lodRangeMin = sceneMinLevel[idx];
        comp.lodRangeMax = 1000;
      }
      if (!octrees[idx]) { readyScenes[idx] = true; }   // SOG: fully resident once loaded
      if (idx === activeIndex) scheduleRefine(idx);
      pinWhenBudgetReady();               // reconcile pins (incl. this just-loaded scene) once budget/deviceFinest settle
      liveApp.renderNextFrame = true;
    });
  }

  // Live frontier membership: the active scene or one of its portal neighbours.
  function sceneWanted(idx) {
    if (idx === activeIndex) { return true; }
    if (!adjacency) { return true; }                    // before start() settles, keep everything
    var want = residentScenes();
    for (var i = 0; i < want.length; i++) { if (want[i] === idx) { return true; } }
    return false;
  }

  // Fully release a hidden SOG scene that left the frontier. Order matters:
  // destroy the entity first (the gsplat component's onRemove destroys its
  // placement, letting the unified manager release its resource refs), then
  // deregister the asset (assets.remove deletes the registry's url->asset map
  // entry, so a later loadFromUrl of the same URL creates a fresh Asset) and
  // unload it (destroys the GSplatResource -- the engine defers the actual GPU
  // free until the sorter's refCount hits 0 and GSplatDirector.update processes
  // the cleanup queue, hence the renderNextFrame nudge). Streaming scenes are
  // never asset-unloaded here: their asset is only the small octree meta and
  // their block memory is governed by the pin/unpin machinery.
  function unloadScene(idx) {
    if (idx === 0 || idx === activeIndex || !entities[idx]) { return; }
    var e = entities[idx];
    var a = assets[idx];
    entities[idx] = null; comps[idx] = null; octrees[idx] = null; assets[idx] = null;
    sceneMinLevel[idx] = null; readyScenes[idx] = false;
    pinDepth[idx] = null;
    pinBatches[idx] = [];
    pinGen[idx] = (pinGen[idx] || 0) + 1;   // invalidate the scene's in-flight pin pump
    try { e.destroy(); } catch (err) { console.warn('portal scene ' + idx + ' entity destroy failed:', err); }
    if (a && liveApp) {
      try { liveApp.assets.remove(a); a.unload(); } catch (err) { console.warn('portal scene ' + idx + ' unload failed:', err); }
    }
    if (liveApp) { liveApp.renderNextFrame = true; }
  }

  // Reconcile the frontier to the LIVE activeIndex: SOG scene assets (load
  // wanted, unload unwanted) and streaming block pins (via pinWhenBudgetReady ->
  // pinDesired). Called at startup and on every crossing; idempotent, so stale
  // or duplicate calls are harmless.
  function reconcileFrontier() {
    if (!adjacency || !liveApp) { return; }
    var want = residentScenes();
    var wantSet = {};
    for (var i = 0; i < want.length; i++) { wantSet[want[i]] = true; }
    for (var idx = 1; idx < data.portalScenes.length; idx++) {
      var u = data.portalScenes[idx];
      if (!u || u.indexOf('lod-meta.json') !== -1) { continue; }   // streaming: pin-managed, asset stays
      if (wantSet[idx]) { loadScene(idx); } else { unloadScene(idx); }
    }
    reconcileCollisions(want);
    pinWhenBudgetReady();
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
