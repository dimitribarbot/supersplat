import { buildPortalAnimTimeline } from '../portal-anim-timeline';
import { segmentCrossesRect, resolveActiveSplat } from '../portal-geom';
import { collectLodFileUrls, collectSogBlockFileUrls, buildPortalAdjacency, desiredResidentScenes, assignPinDepths, computeWarmSet } from '../portal-preload';

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
  var pinGen = [];                          // scene index -> pin generation; bumped on unpin to invalidate an in-flight awaitResident
  var sceneMinLevel = [];                   // scene index -> device-depth level (its reveal lodRangeMin)
  var adjacency = null;                     // built in start() from data.portals
  var pinnedScenes = {};                    // scene index -> true when currently pinned
  var pinDepth = [];                        // scene index -> currently applied pin depth (min pinned level)
  var pinReady = false;                     // set once the budget + deviceFinest have first settled; later reconciles run immediately
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
  // Switch to scene idx: enable it, swap collision, reconcile the frontier and
  // arm the loading overlay when the destination is not ready (still streaming,
  // or a SOG scene whose asset has not finished loading). Tolerates a target
  // whose entity does not exist yet: activeIndex flips immediately (the frontier
  // reconcile loads it) and the load callback enables it on arrival.
  function switchTo(idx) {
    if (idx === activeIndex || idx === null || idx === undefined) return;
    if (idx < 0 || idx >= data.portalScenes.length) return;
    activeIndex = idx;
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
    reconcileCollisions(adjacency ? desiredResidentScenes(adjacency, activeIndex) : []);
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
    // The start entity's gsplat.asset is a numeric id (set up by the viewer), so
    // resolve the Asset to reach its octree. Used to observe deviceFinest.
    octrees[0] = getOctree(app.assets.get(startComp.asset));
    adjacency = buildPortalAdjacency(
      (data.portals || []).map(function (p) { return { front: p.front, back: p.back }; }),
      data.portalScenes.length
    );

    // When the collision overlay is enabled after the user has already moved to
    // another scene, its buffers are stale -> refresh to the active scene.
    var ev = viewer && viewer.global && viewer.global.events;
    if (ev && ev.on) {
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

    applyActive();
    reconcileFrontier();
    initCollisions();
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

  // Pin LOD levels [minLevel .. coarsest] of an extra streaming scene RESIDENT
  // (decoded, in GPU) via the engine's octree loader, so a crossing into it shows
  // device-appropriate quality with no cold streaming. incRefCount first so the
  // files never enter the unload cooldown, then re-poll ensureFileResource each
  // frame until they are resident (a disabled scene has no render instance to poll
  // it). Records the pinned file indices for later reclaim. SOG scenes (no octree)
  // are a no-op. Idempotent-ish: skips files already pinned for this scene.
  function pinSceneToLevel(asset, idx, minLevel) {
    var octree = getOctree(asset);
    octrees[idx] = octree || null;
    if (!octree || !octree.lodLevels || !octree.files ||
        !octree.incRefCount || !octree.ensureFileResource || !octree.getFileResource) { return; }
    if (!pinnedFiles[idx]) { pinnedFiles[idx] = []; }
    var already = {};
    for (var p = 0; p < pinnedFiles[idx].length; p++) { already[pinnedFiles[idx][p]] = true; }
    var added = [];
    for (var i = 0; i < octree.files.length; i++) {
      var f = octree.files[i];
      if (f && f.lodLevel >= minLevel && !already[i]) {
        try { octree.incRefCount(i); pinnedFiles[idx].push(i); added.push(i); }
        catch (e) { console.warn('portal pin block ' + i + ' (scene ' + idx + ') failed:', e); }
      }
    }
    if (added.length === 0 && pinnedFiles[idx].length === 0) { return; }
    var gen = pinGen[idx] || 0;   // a reclaim bumps pinGen[idx]; this loop then bails instead of marking a now-unpinned scene ready
    var frames = 0;
    (function awaitResident() {
      if ((pinGen[idx] || 0) !== gen) { return; }   // scene was reclaimed mid-pin -> do NOT vacuously mark the emptied pin set ready
      var allResident = true;
      for (var j = 0; j < pinnedFiles[idx].length; j++) {
        octree.ensureFileResource(pinnedFiles[idx][j]);
        if (!octree.getFileResource(pinnedFiles[idx][j])) { allResident = false; }
      }
      if (allResident) { readyScenes[idx] = true; return; }
      if (frames++ < 600) { requestAnimationFrame(awaitResident); }
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
    pinGen[idx] = (pinGen[idx] || 0) + 1;   // invalidate any in-flight awaitResident for this scene
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
      // settles -- don't hold the first reconcile (and warming) ~10s for it.
      if ((getSplatBudget() && (!streaming || deviceFinest !== null) && stableFor > 60) || waited++ > 600) {
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
    var want = desiredResidentScenes(adjacency, active);
    // Budget-capped per-scene depths: active keeps deviceFinest, neighbours
    // degrade toward coarser until the summed pinned splat count fits ~1x the
    // engine budget (pinned blocks of disabled scenes bypass the budget
    // balancer, so we must cap them ourselves).
    var depths = assignPinDepths(
      active,
      adjacency[active] || [],
      data.portalSceneLodCounts || [],
      deviceFinest,
      getSplatBudget()
    );
    var wantSet = {};
    for (var i = 0; i < want.length; i++) {
      var idx = want[i];
      wantSet[idx] = true;
      if (!entities[idx] || !octrees[idx]) { continue; }
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
      sceneMinLevel[idx] = min;
      if (comps[idx]) { comps[idx].lodRangeMin = min; }
      pinSceneToLevel(getAsset(idx), idx, min);   // additive when deepening; fresh pin otherwise
      pinnedScenes[idx] = true;
      pinDepth[idx] = min;
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
    var want = desiredResidentScenes(adjacency, activeIndex);
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
    pinGen[idx] = (pinGen[idx] || 0) + 1;   // invalidate any in-flight awaitResident
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
    var want = desiredResidentScenes(adjacency, activeIndex);
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
