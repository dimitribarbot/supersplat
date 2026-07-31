import { buildPortalAnimTimeline } from '../portal-anim-timeline';
import { crossingReducer } from '../portal-crossing';
import { segmentCrossesRect, resolvePortalCrossing } from '../portal-geom';
import { collectLodFileUrls, collectSogBlockFileUrls, buildPortalAdjacency, desiredResidentScenes, assignPinDepths, computeWarmSet, computeResidentCeiling, selectResidentScenes, sceneResidentToDepth, startSceneLodFloor, shouldSampleDeviceFinest, pinBatchAllowed, computeRevealLevel, parseBudgetParam } from '../portal-preload';
import { tileGrid, tileGeometry, tileDelay, transitionReducer } from '../portal-transition';

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
.ss-portal-tiles {
  position: fixed; inset: 0; z-index: 1999; pointer-events: none;
  display: grid; visibility: hidden; opacity: .7;
}
.ss-portal-tiles.armed { visibility: visible; }
.ss-portal-tiles.armed .ss-portal-tile { will-change: transform, opacity; }
.ss-portal-tile {
  background: #0a0c10; opacity: 0;
  transition: opacity 150ms ease-out, transform 150ms cubic-bezier(.2,.75,.3,1);
}
.ss-portal-tiles.reduced .ss-portal-tile { transition: opacity 150ms linear; }
.ss-portal-tile.on { opacity: 1; transform: scale(1.02) rotate(0deg); }
`;

// Runtime companion injected verbatim into the exported viewer. It creates one
// disabled gsplat per extra scene, switches the visible scene when the camera
// crosses a portal, and swaps the walk/fly collision to match. The pure crossing
// helpers (portal-geom) and the crossing/overlay lifecycle reducer
// (portal-crossing) are stringified in so they stay shared and unit-tested.
// Everything else is dep-internal (the live pc.AppBase and the
// viewer's collision instance), verified by the Task 8/9 console spikes and the
// Task 12 end-to-end walkthrough rather than unit tests.
const companionRuntime = `
(function () {
  var data = window.__supersplatPortals;
  if (!data || !data.portals || !data.portalScenes || data.portalScenes.length < 2) return;
  var segmentCrossesRect = ${segmentCrossesRect.toString()};
  var crossingReducer = ${crossingReducer.toString()};
  var resolveLoadingMessage = ${resolveLoadingMessage.toString()};
  var collectLodFileUrls = ${collectLodFileUrls.toString()};
  var collectSogBlockFileUrls = ${collectSogBlockFileUrls.toString()};
  var buildPortalAdjacency = ${buildPortalAdjacency.toString()};
  var desiredResidentScenes = ${desiredResidentScenes.toString()};
  var shouldSampleDeviceFinest = ${shouldSampleDeviceFinest.toString()};
  var selectResidentScenes = ${selectResidentScenes.toString()};
  var computeResidentCeiling = ${computeResidentCeiling.toString()};
  var assignPinDepths = ${assignPinDepths.toString()};
  var computeWarmSet = ${computeWarmSet.toString()};
  var sceneResidentToDepth = ${sceneResidentToDepth.toString()};
  var startSceneLodFloor = ${startSceneLodFloor.toString()};
  var pinBatchAllowed = ${pinBatchAllowed.toString()};
  var parseBudgetParam = ${parseBudgetParam.toString()};
  var computeRevealLevel = ${computeRevealLevel.toString()};
  var resolvePortalCrossing = ${resolvePortalCrossing.toString()};
  var tileGrid = ${tileGrid.toString()};
  var tileGeometry = ${tileGeometry.toString()};
  var tileDelay = ${tileDelay.toString()};
  var transitionReducer = ${transitionReducer.toString()};
  var loadingText = resolveLoadingMessage('', data.loadingDefaults || {}, navigator.language || 'en');

  // Live pc.AppBase handle (primary path confirmed by the Task 8 spike, navCursor fallback).
  function getApp(v) { return (v && v.debugPanel && v.debugPanel._global && v.debugPanel._global.app) || (v && v.navCursor && v.navCursor.app) || null; }

  var entities = [];                       // scene index -> gsplat Entity (index 0 = start)
  var comps = [];                           // scene index -> gsplat component (for per-scene lodRange control)
  var octrees = [];                         // scene index -> GSplatOctree (or null for SOG)
  var deviceFinest = null;                  // finest (lowest) LOD level the engine has actually loaded for the start scene = the finest this DEVICE renders (0 desktop, coarser on tight budget). Running-min.
  var deviceDead = false;                   // graphics device lost: every load/pin is a dead-device no-op that still costs decode CPU + error spam, so the GPU-feeding paths halt until 'devicerestored'
  var assets = [];                          // scene index -> loaded gsplat Asset
  var pinnedFiles = [];                     // scene index -> [octree file indices we incRefCount-ed]
  var pinGen = [];                          // scene index -> pin generation; bumped on unpin to invalidate an in-flight pump
  var pinBatches = [];                      // scene index -> [{remaining, markReady, done}] in level-major (coarsest-first) order; remaining shrinks (swap-remove) as files become resident
  var pinPumping = [];                      // scene index -> a pump rAF loop is active
  var PIN_WAVE = 4;                         // max not-yet-loaded pinned files kept in-flight per scene: the engine's per-scene block loader is a 2-concurrent FIFO, so flooding it with every pinned URL would starve interactive requests (the start scene's initial load + environment, a crossed-into scene's per-view files) behind the whole preload backlog
  var sceneMinLevel = [];                   // scene index -> device-depth level (its reveal lodRangeMin)
  var adjacency = null;                     // built in start() from data.portals
  var pinnedScenes = {};                    // scene index -> true when currently pinned
  var pinDepth = [];                        // scene index -> currently applied pin depth (min pinned level)
  var startFloor = null;                    // active clamp on scene 0's lodRangeMin (null = floor viewer-owned; see applyStartFloor)
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
  // ?budget=<n> (the stock viewer's engine-splat-budget override, in millions).
  // The viewer applies it only inside applyPerfSettings (ready/firstFrame-gated),
  // so the ready-gate watchdog reads it directly to honor the override when
  // firstFrame never fires (else it would clobber an explicit ?budget= with the
  // hardcoded default). 0 when absent/invalid -> watchdog uses its 2M/4M default.
  var budgetOverride = parseBudgetParam(location.search || '');
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
  var lastSafe = null;                      // null until primed / cleared on reset; otherwise === lastSafeBuf
  var lastSafeBuf = [0, 0, 0];              // persistent storage behind lastSafe (no per-frame allocation)
  var curPos = [0, 0, 0];                   // per-frame scratch for the camera position
  var timeline = data.portalAnimTimeline || null;   // [{t, scene}] sorted ascending; null/absent when no animation
  var spawnScene = null;                    // scene active when walk/fly was last ENTERED (== the scene its reset-spawn pose lives in); null until first walk/fly entry
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

  // Switch to scene idx: enable it, swap collision, refine + re-pin via the
  // frontier reconcile. Overlay arming/cancelling is decided by crossingReducer
  // (via dispatch), not here. Tolerates a target whose entity does not exist
  // yet: activeIndex flips immediately (the frontier reconcile loads it) and
  // the load callback enables it on arrival.
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
  }

  // --- device-depth reveal -----------------------------------------------
  // Floor a crossed-into scene (the start scene included) at the finest
  // FULLY-resident level (never a blob fallback) and let pumpFloor open it
  // toward the canonical floor as finer levels complete.
  function scheduleRefine(idx) {
    // Scene 0 is included: its CANONICAL floor stays viewer-owned (see
    // canonicalFloor), but the held-floor descent applies to it like any
    // other crossed-into scene (field case: retreating to the start scene
    // rendered blob fallbacks over a nearly-complete L1 because scene 0 was
    // exempt from the invariant while its floor pointed at a mostly-missing
    // L0). Startup is unaffected: scheduleRefine only runs on crossings.
    var comp = comps[idx];
    if (!comp) return;
    if (idx !== 0) {
      if (sceneMinLevel[idx] == null) { sceneMinLevel[idx] = deviceMinLevel(idx); }
      comp.lodRangeMax = 1000;                               // allow coarser for far nodes (also pinned)
    }
    floorGen[idx] = (floorGen[idx] || 0) + 1;
    var fine = finestFullLevel(idx);
    heldFloor[idx] = (fine === null) ? null : Math.max(canonicalFloor(idx), fine);
    applySceneFloor(idx);
    if (heldFloor[idx] != null && heldFloor[idx] > canonicalFloor(idx)) {
      pumpFloor(idx);
    } else {
      heldFloor[idx] = null;
    }
    var app = getApp(window.__supersplatViewer);
    if (app) app.renderNextFrame = true;
  }

  // --- streaming loading overlay ---------------------------------------
  // A crossing into a streaming scene that is not showable at its reveal
  // depth would expose the viewer's clear color (nothing streamed yet) or a
  // region-by-region refine (budget-degraded pin depth promoted to active
  // depth by the crossing). Cover both with a backdrop+spinner+label until
  // the scene is resident at the depth it will actually be shown at.
  //
  // Readiness = per-DESTINATION residency at the scene's pin/reveal depth
  // (octree introspection, same handles the pin pump uses): every octree file
  // at levels [sceneMinLevel .. coarsest] has a resident resource. That is the
  // scene's final quality on THIS device (scheduleRefine floors lodRangeMin at
  // the same depth, and the depth is budget-degraded on mobile), so the reveal
  // shows a uniformly sharp scene with nothing left to pop in. Coarse-only
  // gating revealed earlier but with visibly mixed LOD regions; a global
  // renderer-splat-count threshold before that was invalidated by
  // budget-bounded multi-scene residency (field case: black regions after a
  // crossing). An absolute frame cap remains purely as an anti-stick bound
  // (it only fires if the engine's octree shape drifts and the residency
  // probe goes blind).
  // A short SHOW_DELAY defers showing the backdrop so an already-resident scene
  // (e.g. a non-streaming SOG export) never flashes it.
  var readyScenes = {};            // scene index -> true once revealed
  readyScenes[activeIndex] = true; // start scene is already loaded; never overlay it
  var shown = {};                  // scene index -> displayed to the user (no overlay covering it) this session; cleared when reclaim frees the scene
  shown[activeIndex] = true;       // the start scene is on screen from the first frame
  var pendingIndex = null;         // scene index currently loading (or null)
  var pendingFrames = 0;           // frames since the crossing
  var overlayShown = false;        // backdrop currently visible
  var SHOW_DELAY = 0;              // streaming-only (SOG gated out) => show immediately
  var LOADING_MAX_FRAMES = 3600;      // ~60s cap: reveal-with-blur, but ONLY once coarse coverage is complete (no missing regions)
  var LOADING_ABS_MAX_FRAMES = 21600; // ~6min absolute anti-stick bound (fires even without coverage: overlay must never stick)

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

  // --- portal transition cover -------------------------------------------
  // A grid of translucent tiles above the canvas (below the loading overlay).
  // Dismantle: tiles fly in from outside, spinning, edges-first, so the centre
  // of the outgoing scene is covered last. The scene swap happens under the
  // cover. Reconstruct: tiles spin away outward, centre-first, revealing the
  // incoming scene. All phase decisions live in transitionReducer.
  var REDUCED_MOTION = false;
  try { REDUCED_MOTION = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (mmErr) { REDUCED_MOTION = false; }
  var T_SWEEP = REDUCED_MOTION ? 0 : 225;     // stagger across the grid
  var T_TILE = REDUCED_MOTION ? 150 : 150;    // per-tile motion
  var T_HOLD = 100;                            // covered hold before reconstruct
  var T_COVERED_MAX_FRAMES = 120;              // ~2s watchdog while covered with no overlay

  var tileLayer = document.createElement('div');
  tileLayer.className = 'ss-portal-tiles' + (REDUCED_MOTION ? ' reduced' : '');
  var tiles = [];                 // {el, dist, ux, uy, spin}
  var transState = { phase: 'idle', target: null };
  var coveredFrames = 0;
  var coverTimer = null;
  var lastGridCols = 0;            // last built grid shape; an idle resize that keeps the
  var lastGridRows = 0;            // same cols x rows (e.g. mobile URL bar show/hide) is a no-op

  function mountTiles() { document.body.appendChild(tileLayer); }
  if (document.body) { mountTiles(); } else { document.addEventListener('DOMContentLoaded', mountTiles); }

  function buildTiles() {
    var g = tileGrid(window.innerWidth || 1280, window.innerHeight || 720);
    if (g.cols === lastGridCols && g.rows === lastGridRows) { return; }   // 1fr tracks: same shape needs no rebuild
    lastGridCols = g.cols; lastGridRows = g.rows;
    tileLayer.style.gridTemplateColumns = 'repeat(' + g.cols + ', 1fr)';
    tileLayer.style.gridTemplateRows = 'repeat(' + g.rows + ', 1fr)';
    while (tileLayer.firstChild) { tileLayer.removeChild(tileLayer.firstChild); }
    tiles = [];
    var n = g.cols * g.rows;
    for (var i = 0; i < n; i++) {
      var el = document.createElement('div');
      el.className = 'ss-portal-tile';
      tileLayer.appendChild(el);
      var geo = tileGeometry(g.cols, g.rows, i);
      tiles.push({
        el: el, dist: geo.dist, ux: geo.ux, uy: geo.uy,
        spin: (16 + Math.random() * 50) * (geo.ux > 0 ? 1 : -1)
      });
    }
  }
  // Only build the tile grid (and pay its up-to-320-div compositor cost) when at
  // least one portal has the effect enabled. When none do, transitionEnabled
  // returns false for every portal, the phase machine below can never leave
  // 'idle' (see the tick() gating on transitionEnabled(cr.portalIndex)), and no
  // code path ever dereferences tiles -- it is safe to leave it empty.
  var wantsTransition = data.portals.some(function (p) { return p.transition !== false; });
  if (wantsTransition) { buildTiles(); }
  window.addEventListener('resize', function () {
    if (wantsTransition && transState.phase === 'idle') { buildTiles(); }
  });

  // The off-slot transform a tile animates from (dismantle) and to
  // (reconstruct): pushed outward along its radial direction, small, spun.
  // Reduced motion keeps the tile in place and animates opacity only.
  function tileAway(t) {
    if (REDUCED_MOTION) { return 'none'; }
    return 'translate(' + (t.ux * 140) + 'px,' + (t.uy * 140) + 'px) scale(.25) rotate(' + t.spin + 'deg)';
  }

  function startDismantle() {
    tileLayer.classList.add('armed');
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      t.el.style.transition = 'none';
      t.el.style.transitionDelay = '0ms';
      t.el.classList.remove('on');
      t.el.style.transform = tileAway(t);
    }
    void tileLayer.offsetWidth;                 // one flush for the whole layer, so the class add animates
    for (var j = 0; j < tiles.length; j++) {
      var u = tiles[j];
      u.el.style.transition = '';
      u.el.style.transitionDelay = tileDelay(u.dist, T_SWEEP, 'dismantle') + 'ms';
      u.el.classList.add('on');
      u.el.style.transform = '';
    }
    if (coverTimer) { clearTimeout(coverTimer); }
    coverTimer = setTimeout(onCoverComplete, T_SWEEP + T_TILE);
  }

  function startReconstruct() {
    if (coverTimer) { clearTimeout(coverTimer); }
    coverTimer = setTimeout(function () {
      for (var i = 0; i < tiles.length; i++) {
        var t = tiles[i];
        t.el.style.transitionDelay = tileDelay(t.dist, T_SWEEP, 'reconstruct') + 'ms';
        t.el.style.transform = tileAway(t);
        t.el.classList.remove('on');
      }
      coverTimer = setTimeout(function () { transDispatch({ type: 'done' }); }, T_SWEEP + T_TILE);
    }, T_HOLD);
  }

  function clearCover() {
    if (coverTimer) { clearTimeout(coverTimer); coverTimer = null; }
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      t.el.style.transition = 'none';
      t.el.style.transitionDelay = '0ms';
      t.el.classList.remove('on');
      t.el.style.transform = 'none';
    }
    void tileLayer.offsetWidth;                 // one flush for the whole layer
    for (var j = 0; j < tiles.length; j++) {
      tiles[j].el.style.transition = '';
    }
    tileLayer.classList.remove('armed');
  }

  // Does portal p want the effect? Absent means enabled.
  function transitionEnabled(portalIndex) {
    if (portalIndex === null || portalIndex === undefined) { return false; }
    var p = data.portals[portalIndex];
    return !!p && p.transition !== false;
  }

  // Cover complete: re-resolve the crossing from the FROZEN lastSafe to the
  // camera's current position. If the user walked back through the doorway
  // during the dismantle, the target is gone -> cancel with no switch.
  function onCoverComplete() {
    var target = null;
    try {
      if (lastSafe) {
        var r = resolvePortalCrossing(lastSafe, curPos, rects, activeIndex, segmentCrossesRect);
        if (r.uid !== null && r.uid !== activeIndex) { target = r.uid; }
      }
    } catch (ccErr) { target = transState.target; }
    transDispatch({ type: 'covered', target: target });
  }

  function transDispatch(ev) {
    var res = transitionReducer(transState, ev);
    transState = res.state;
    var a = res.actions;
    if (transState.phase === 'covered') { coveredFrames = 0; }
    if (a.cover === 'dismantle') { startDismantle(); }
    else if (a.cover === 'reconstruct') { startReconstruct(); }
    else if (a.cover === 'clear') { clearCover(); }
    if (a.dispatchTarget !== null) {
      var u = a.dispatchTarget;
      dispatch({ type: 'crossing', target: u, loaded: !!(entities[u] || sceneLoading[u]), ready: sceneReady(u) });
    }
    if (transState.phase === 'idle' && a.cover !== 'dismantle') { tileLayer.classList.remove('armed'); }
  }

  // The LOD level a crossing's loading overlay waits for -- the "coarsest
  // acceptable" quality: normally the finest level THIS device loads
  // (deviceFinest, clamped to the scene coarsest), or REVEAL_MARGIN levels
  // above the scene's coarsest before deviceFinest is known. On desktop the
  // pin depth is the FULL pyramid (deviceFinest=0), which takes minutes on a
  // slow network; the overlay instead reveals at the same near-coarse
  // quality the viewer's own initial loading bar accepts for the start
  // scene, and the engine refines in view afterwards (the final pin depth
  // is unchanged; only the overlay gate and the temporary streaming floor
  // below read this).
  var REVEAL_MARGIN = 2;   // reveal at most this many levels finer than coarsest
  function revealLevel(idx) {
    var oc = octrees[idx];
    var coarse = (oc && oc.lodLevels) ? oc.lodLevels - 1 : 0;
    // Target the finest level this DEVICE loads for the scene, not a stale coarse
    // NEIGHBOUR pin: a scene crossed into is re-pinned to the active (fine) depth,
    // so its pre-crossing coarse pin must not raise the gate and reveal it at the
    // coarsest with no overlay. computeRevealLevel keeps the original stuck-overlay
    // guard for a genuinely-active, legitimately budget-degraded scene.
    return computeRevealLevel(coarse, REVEAL_MARGIN, deviceFinest, idx === activeIndex, pinReady, pinDepth[idx]);
  }
  // True when EVERY octree file of scene idx at levels [revealLevel ..
  // coarsest] has a resident (decoded) resource -- the scene is showable at
  // the acceptable reveal quality, everywhere. False while the octree is
  // unknown or the engine's shape drifted (the caller's frame caps then bound
  // the overlay).
  function sceneRevealResident(idx) {
    var oc = octrees[idx];
    if (!oc || !oc.files || !oc.getFileResource || !oc.lodLevels) { return false; }
    return sceneResidentToDepth(oc.files, oc.lodLevels, revealLevel(idx), function (i) { return !!oc.getFileResource(i); });
  }

  // True when EVERY region of scene idx has at least COARSEST-level data
  // resident -- the scene renders with no missing/black regions (possibly
  // blurry; the engine refines in view after the reveal). Vacuously true when
  // the octree is unknown (SOG or engine drift), so a probe-blind scene exits
  // at the 60s cap; the absolute cap only matters when coverage is probeable
  // but incomplete.
  function sceneCoverageResident(idx) {
    var oc = octrees[idx];
    if (!oc || !oc.files || !oc.getFileResource || !oc.lodLevels) { return true; }
    return sceneResidentToDepth(oc.files, oc.lodLevels, oc.lodLevels - 1, function (i) { return !!oc.getFileResource(i); });
  }

  // --- progressive rendering floor ---------------------------------------
  // A crossed-into streaming scene renders at the finest level that is FULLY
  // resident, and the floor descends one level at a time as finer levels
  // complete, until the canonical pin floor is reached. Rendering a floor
  // finer than what is fully resident makes the engine select missing files
  // and draw coarse blob fallbacks (field case: crossing with L1 100%
  // resident but L0 at 3/9 rendered giant blobs over a perfectly good L1);
  // holding the floor also keeps the engine from scattering bandwidth over
  // missing finest in-view blocks while the pins complete the next level.
  // The pin pump fetches ALL pinned levels regardless of the floor, so the
  // descent cannot deadlock. Scene 0's floor stays viewer-owned
  // (applyStartFloor); SOG scenes have no octree and are never held.
  var heldFloor = [];   // scene index -> held floor level while descending (null/undefined = open at canonical)
  var floorGen = [];    // scene index -> generation; bumped to invalidate an in-flight pump
  function canonicalFloor(idx) {
    // Scene 0's floor is viewer-owned: the budget clamp when degraded
    // (startFloor), else fully open -- the viewer's applyPerfSettings opens
    // it to 0 once ready. sceneMinLevel is deliberately never set for it.
    if (idx === 0) { return (startFloor !== null) ? startFloor : 0; }
    return (sceneMinLevel[idx] != null) ? sceneMinLevel[idx] : deviceMinLevel(idx);
  }
  // Finest level L such that every file at levels [L..coarsest] is resident
  // (the finest the scene can render everywhere without blob fallbacks);
  // coarsest when nothing is complete yet; null when the octree is unknown.
  function finestFullLevel(idx) {
    var oc = octrees[idx];
    if (!oc || !oc.files || !oc.getFileResource || !oc.lodLevels) { return null; }
    for (var lv = 0; lv < oc.lodLevels; lv++) {
      if (sceneResidentToDepth(oc.files, oc.lodLevels, lv, function (i) { return !!oc.getFileResource(i); })) { return lv; }
    }
    return oc.lodLevels - 1;
  }
  function applySceneFloor(idx) {
    var comp = comps[idx];
    if (!comp) { return; }
    var canon = canonicalFloor(idx);
    comp.lodRangeMin = (heldFloor[idx] != null) ? Math.max(canon, heldFloor[idx]) : canon;
  }
  // Descend the held floor as levels complete; exits when fully open, when
  // the scene stops being active, or when a newer generation supersedes it.
  function pumpFloor(idx) {
    var gen = floorGen[idx];
    (function step() {
      if (floorGen[idx] !== gen) { return; }
      if (idx !== activeIndex || heldFloor[idx] == null) { heldFloor[idx] = null; applySceneFloor(idx); return; }
      var canon = canonicalFloor(idx);
      var fine = finestFullLevel(idx);
      var target = (fine === null) ? canon : Math.max(canon, fine);
      if (target < heldFloor[idx]) {
        heldFloor[idx] = target;
        var app = getApp(window.__supersplatViewer);
        if (app) { app.renderNextFrame = true; }
      }
      // Re-assert every step (not only on change): the viewer's
      // applyPerfSettings (ready / performance-mode) and applyStartFloor
      // write scene 0's floor directly and would otherwise reopen a held
      // floor mid-descent.
      applySceneFloor(idx);
      if (heldFloor[idx] <= canon) { heldFloor[idx] = null; applySceneFloor(idx); return; }
      requestAnimationFrame(step);
    })();
  }

  // Arm the overlay for a crossing into scene idx. showLoading is deferred to
  // the poll (SHOW_DELAY) so an already-resident scene never flashes.
  function beginLoading(idx) {
    pendingIndex = idx; pendingFrames = 0; overlayShown = false;
  }
  // A scene is "ready" when a crossing into it needs no loading overlay.
  // A scene the user has ALREADY had on screen this session shows instantly at
  // whatever quality it currently has -- it is exactly what they were looking
  // at when they left it (field case: desktop on a slow network, retreating to
  // the start scene armed an overlay gated on the FULL pyramid -- deviceFinest
  // reveal depth -- which only the 60s anti-stick cap could exit, over a
  // half-streamed scene). Otherwise: streaming scenes probe LIVE residency at
  // the reveal depth (a budget-degraded device may have pinned the destination
  // coarser than the depth the crossing just assigned -- the flag alone would
  // reveal region-by-region refine); SOG scenes have no octree to probe, so
  // the flag (set on asset load) stays their truth.
  function sceneReady(idx) {
    if (shown[idx]) return true;
    return !!(octrees[idx] ? sceneRevealResident(idx) : readyScenes[idx]);
  }
  // Crossing/overlay lifecycle. ALL decisions (switch now, hold a crossing into
  // a not-yet-loadable scene, arm/drop the reveal poll, mark revealed) live in
  // the pure, unit-tested crossingReducer; this wiring just applies its actions.
  // 'hide' and 'show' deliberately clear pendingIndex WITHOUT touching
  // readyScenes: an abandoned poll must never mark its target ready (a stale
  // poll once did, and frontier reclaim could then be undone by it). On a
  // blocked entry ('show') loadScene retries the target: it is a no-op while
  // loaded/loading, and re-fetches after a failed load so a blocked crossing
  // can actually complete.
  var crossState = { mode: 'idle', target: null };
  // Field diagnostic: per-LOD-level resident-file counts for scene idx
  // ('L0:3/12 L1:4/4 ...'), so a crossing/reveal decision can be checked
  // against what was ACTUALLY resident at that moment.
  function residencySummary(idx) {
    var oc = octrees[idx];
    if (!oc || !oc.files || !oc.getFileResource || !oc.lodLevels) { return 'no-octree'; }
    var have = [], total = [];
    for (var l = 0; l < oc.lodLevels; l++) { have[l] = 0; total[l] = 0; }
    for (var i = 0; i < oc.files.length; i++) {
      var f = oc.files[i];
      if (!f) { continue; }
      total[f.lodLevel]++;
      if (oc.getFileResource(i)) { have[f.lodLevel]++; }
    }
    var parts = [];
    for (var lv = 0; lv < oc.lodLevels; lv++) { parts.push('L' + lv + ':' + have[lv] + '/' + total[lv]); }
    return parts.join(' ');
  }
  function dispatch(ev) {
    // Field diagnostic: log every crossing DECISION with the gate inputs and
    // the destination's live residency -- the reveal log is blind in the
    // no-overlay path (ready at the crossing itself), which is exactly the
    // path early-reveal field reports come from. The blocked re-fire (same
    // target every frame while lastSafe is frozen) is suppressed.
    if (ev.type === 'crossing' && !(crossState.mode === 'blocked' && crossState.target === ev.target)) {
      try {
        var dComp = comps[ev.target];
        console.info('[portals] crossing -> ' + ev.target + ' loaded=' + ev.loaded + ' ready=' + ev.ready +
          ' shown=' + !!shown[ev.target] + ' gate=' + revealLevel(ev.target) +
          ' pinDepth=' + pinDepth[ev.target] + ' sceneMinLevel=' + sceneMinLevel[ev.target] +
          ' lodRangeMin=' + (dComp ? dComp.lodRangeMin : 'n/a') + ' | ' + residencySummary(ev.target));
      } catch (xLogErr) {}
    }
    var res = crossingReducer(crossState, ev);
    crossState = res.state;
    var a = res.actions;
    if (a.switchTo !== null) { switchTo(a.switchTo); }
    // Displayed-without-overlay bookkeeping: a switch not covered by a poll
    // ('keep'/'hide') puts the scene straight on screen; a reveal (markReady,
    // incl. the anti-stick cap) uncovers it.
    if (a.switchTo !== null && a.overlay !== 'poll') { shown[a.switchTo] = true; }
    if (a.markReady !== null) { readyScenes[a.markReady] = true; shown[a.markReady] = true; }
    if (a.overlay === 'show') { pendingIndex = null; overlayShown = true; showLoading(); loadScene(crossState.target); }
    else if (a.overlay === 'poll') { beginLoading(crossState.target); }
    else if (a.overlay === 'hide') { pendingIndex = null; overlayShown = false; hideLoading(); }
    // The cover is up and the crossing lifecycle just settled (switched and
    // ready, reveal completed, or the crossing was abandoned): the destination
    // is on screen behind the tiles, so reconstruct. This single hook covers
    // the immediate-ready commit AND the post-loading-overlay reveal.
    if (transState.phase === 'covered' && crossState.mode === 'idle') {
      transDispatch({ type: 'sceneShown' });
    }
  }

  // Portal rects carry index-based front/back: the export (buildPortalBundle)
  // already rewrote editor scene-uids to scene indices, so resolvePortalCrossing's
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
      // returning the camera to its spawn pose. free-nav crossing detection
      // can't see the move (it need not pass through a doorway), so force the
      // matching scene here via the reducer -- which also drops any
      // blocked/loading overlay WITHOUT falsely marking its abandoned target
      // ready. lastSafe is cleared so the spawn discontinuity isn't read as a
      // spurious crossing on the next frame.
      //
      // Which scene the reset restores depends on the viewer's cameraMode: in
      // orbit/anim it goes to the initial camera (start scene), but in walk/fly
      // it calls resetToSpawn, whose spawn is the pose captured when walk/fly
      // was ENTERED -- e.g. the walkthrough pose where autoplay was exited,
      // which may live in a non-start scene. spawnScene records the scene
      // active at that entry instant (the scene the spawn pose belongs to), so
      // a walk/fly reset restores the matching scene; anim/orbit reset falls
      // back to the start scene. (The animation cursor time is NOT usable here:
      // it freezes when anim mode is left, so after an intervening orbit reset
      // it points at a scene the spawn pose no longer lives in.) In anim mode
      // the timeline-driven per-frame dispatch immediately re-asserts the
      // cursor's scene, so the start-scene dispatch is a harmless no-op there.
      ev.on('inputEvent', function (name) {
        if (name === 'reset') {
          var sIdx = data.portalStart || 0;
          var s = getState();
          if (spawnScene !== null && s && (s.cameraMode === 'walk' || s.cameraMode === 'fly')) {
            sIdx = spawnScene;
          }
          dispatch({ type: 'crossing', target: sIdx, loaded: !!(entities[sIdx] || sceneLoading[sIdx]), ready: sceneReady(sIdx) });
          lastSafe = null;
        }
      });
      // The annotation navigator chevrons and a hotspot click both end at
      // 'annotation.activate', fired with the RAW settings annotation -- so
      // extras.scene (baked at export from the annotation's splat) says which
      // scene the pose it flies to actually lives in. The fly-to is a TELEPORT:
      // it need not pass through a doorway, so free-nav crossing detection
      // can never see it, exactly like the reset case above. Route through the
      // reducer so a not-yet-resident target reuses the normal loading overlay,
      // and clear lastSafe so the position discontinuity is not read as a
      // spurious crossing on the next frame.
      ev.on('annotation.activate', function (ann) {
        var idx = ann && ann.extras && ann.extras.scene;
        // NaN is typeof 'number' and fails every ordering comparison, so idx < 0
        // and idx >= length would both be false for it without this isFinite check.
        if (typeof idx !== 'number' || !isFinite(idx) || idx < 0 || idx >= data.portalScenes.length) { return; }
        if (idx === activeIndex) { return; }
        dispatch({ type: 'crossing', target: idx, loaded: !!(entities[idx] || sceneLoading[idx]), ready: sceneReady(idx) });
        lastSafe = null;
      });
      // walk/fly resetToSpawn restores the pose captured on mode ENTRY, so the
      // scene active at entry is the scene that spawn pose lives in. Record it
      // for the reset handler above. (value, prev) fires on every mode change.
      ev.on('cameraMode:changed', function (mode) {
        if (mode === 'walk' || mode === 'fly') { spawnScene = activeIndex; }
      });
      // The viewer's applyPerfSettings re-runs on this event: it reopens the
      // start component's lodRangeMin to 0 (wiping the budget clamp) AND
      // applies the new mode's splatBudget. A frame later (rAF: all listeners
      // on the event run synchronously, so by then applyPerfSettings has
      // definitely run), re-assert the clamp first, then re-reconcile the
      // pins under the NEW budget -- without this, a raised budget would not
      // release the clamp (or admit finer pin depths) until the next portal
      // crossing, which may never come if the user lingers in one scene. The
      // re-assert must precede pinDesired: its loop skips scenes whose
      // assigned depth is unchanged, leaving the wiped floor unrepaired.
      ev.on('performanceMode:changed', function () {
        requestAnimationFrame(function () {
          if (startFloor !== null && comps[0]) { comps[0].lodRangeMin = (heldFloor[0] != null) ? Math.max(startFloor, heldFloor[0]) : startFloor; }
          if (pinReady) { pinDesired(); }
        });
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
          deviceDead = true;
          console.warn('[portals] DEVICE LOST -- halting scene loads/pins -- last vram: ' + (vramLine() || 'unavailable') +
                       ' (previous logged total=' + lastVramLogged + 'MB)');
        });
        gdev.on('devicerestored', function () {
          deviceDead = false;
          console.info('[portals] device restored -- resuming scene loads/pins');
          reconcileFrontier();
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
      if (deviceDead) { return; }   // kicking the loader / budget on a lost device only adds churn
      watchdogTicks++;
      if (watchdogTicks < 3) { return; }   // grace: give a cold initial load 15s before touching anything
      try {
        var fixed = unstickInstances();
        if (fixed > 0) { console.info('[portals] ready-gate watchdog repaired ' + fixed + ' stuck entr' + (fixed === 1 ? 'y' : 'ies')); }
        // Priority-1 backstop: if the ready gate still has not fired, the
        // viewer never applied a splat budget and the engine streams
        // UNBOUNDED. Apply the user's ?budget= override if present (the viewer
        // only applies it via the ready-gated applyPerfSettings, so a stuck gate
        // would otherwise silently drop it), else the viewer's own high-quality
        // default so a phone can never OOM from an un-ready start
        // (applyPerfSettings overwrites this with the same value once ready
        // fires), and reconcile so pins pick up the now-real ceiling.
        var bApp = getApp(window.__supersplatViewer);
        var gs = bApp && bApp.scene && bApp.scene.gsplat;
        if (gs && !gs.splatBudget) {
          gs.splatBudget = budgetOverride || (IS_MOBILE ? 2 : 4) * 1000000;
          console.info('[portals] ready-gate watchdog applied fallback splatBudget=' + gs.splatBudget +
            (budgetOverride ? ' (from ?budget)' : ''));
          reconcileFrontier();
        }
        // The gate is stuck (firstFrame never fired) but a budget is in place:
        // treat the viewer as ready. viewerReady is what gates scene 0's pins
        // (pinDesired skips idx 0 without it), and the engine FREES a disabled
        // scene's unpinned blocks -- so an unpinned start scene came back
        // BLACK (and re-downloaded from scratch) on every retreat/reset after
        // a crossing. pinSceneToLevel incRefCounts already-resident files
        // immediately, so this retains exactly what the user was looking at;
        // the real firstFrame handler firing later is an idempotent no-op.
        // Gated on a present splatBudget so the budget backstop above cannot
        // be skipped by this latch clearing the watchdog.
        if (!viewerReady && gs && gs.splatBudget) {
          viewerReady = true;
          console.info('[portals] ready-gate watchdog: firstFrame never fired -- treating viewer as ready so the start scene gets pinned');
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
      sampleDeviceFinest();
      var viewer = window.__supersplatViewer;
      var cm = viewer && viewer.cameraManager;
      var cam = cm && cm.camera;
      if (cam && cam.position) {
        curPos[0] = cam.position.x; curPos[1] = cam.position.y; curPos[2] = cam.position.z;
        var st = getState();
        // In animation mode the camera is driven by the authored path, so the
        // active scene is a pure function of the cursor time (handles play,
        // scrub, scrubTo and loop wrap). In free navigation, detect crossings
        // from frame-to-frame motion; both paths route through dispatch so the
        // crossingReducer owns every activeIndex change. lastSafe is kept fresh
        // in anim mode so the hand-off between modes never produces a spurious
        // crossing; in free nav it is FROZEN while a crossing is blocked, so
        // the frozen segment re-fires the crossing every frame (the reducer is
        // idempotent for it) and the switch completes the frame the target
        // becomes loadable.
        // If state is unreachable (st null) we fall back to the free-nav branch;
        // exports always bake a truthy timeline, so this only degrades to
        // delta-detection in the unexpected case where the viewer state is missing.
        if (st && st.cameraMode === 'anim' && timeline) {
          var want = sceneAtTime(st.animationTime || 0);
          if (want !== activeIndex && want !== null && want !== undefined) {
            dispatch({ type: 'crossing', target: want, loaded: !!(entities[want] || sceneLoading[want]), ready: sceneReady(want) });
          } else if (crossState.mode === 'blocked') {
            dispatch({ type: 'noCrossing' });   // timeline moved back before the target loaded
          }
          // Copy (never alias curPos) so next frame's fill can't corrupt lastSafe.
          lastSafeBuf[0] = curPos[0]; lastSafeBuf[1] = curPos[1]; lastSafeBuf[2] = curPos[2]; lastSafe = lastSafeBuf;   // anim mode: keep fresh for the mode hand-off
        } else if (lastSafe) {
          var cr = resolvePortalCrossing(lastSafe, curPos, rects, activeIndex, segmentCrossesRect);
          var next = cr.uid;
          if (next !== activeIndex && next !== null) {
            if (transState.phase === 'dismantling') {
              // Crossing already latched; the commit re-resolves it. Dispatching
              // now would switch the scene before the cover has closed.
            } else if (transState.phase === 'idle' && transitionEnabled(cr.portalIndex)) {
              // Defer the switch: dismantle first, commit when covered.
              transDispatch({ type: 'crossing', target: next });
            } else {
              // No transition for this portal, or one is already past its commit
              // (covered / reconstructing). Dispatch normally. This path is
              // REQUIRED, not just an optimisation: when the committed crossing
              // came back 'blocked', the frozen-lastSafe re-fire arrives here
              // every frame and is what finally completes the switch once the
              // target loads. Suppressing it would strand the cover until the
              // watchdog.
              dispatch({ type: 'crossing', target: next, loaded: !!(entities[next] || sceneLoading[next]), ready: sceneReady(next) });
            }
          } else if (crossState.mode === 'blocked') {
            dispatch({ type: 'noCrossing' });   // user retreated to the known side
          }
          // Freeze lastSafe while a crossing is blocked OR while the dismantle
          // is playing. The dismantle freeze is load-bearing: without it the
          // camera walks past the portal during the sweep, the frozen segment
          // no longer crosses the rectangle, and a later blocked dispatch could
          // never re-fire - the crossing would be lost.
          if (crossState.mode !== 'blocked' && transState.phase !== 'dismantling') {
            lastSafeBuf[0] = curPos[0]; lastSafeBuf[1] = curPos[1]; lastSafeBuf[2] = curPos[2]; lastSafe = lastSafeBuf;
          }
        } else {
          lastSafeBuf[0] = curPos[0]; lastSafeBuf[1] = curPos[1]; lastSafeBuf[2] = curPos[2]; lastSafe = lastSafeBuf;
        }
      }
    } catch (err) {
      if (!tickErrored) { tickErrored = true; console.warn('portal tick error (suppressed further):', err); }
      try { if (transState.phase !== 'idle') { transDispatch({ type: 'abort' }); } } catch (abortErr) {}
    }
    // Advance the loading overlay (outside the pose guard so it polls every
    // frame). Self-contained try/catch: a throw here must never kill the rAF
    // loop nor leave the overlay stuck, so on error we just clear it.
    try {
      if (pendingIndex !== null) {
        pendingFrames++;
        var pApp = getApp(window.__supersplatViewer);
        if (pApp) { pApp.renderNextFrame = true; }
        // Reveal when the DESTINATION scene is ready at its reveal depth
        // (device-final quality, no mixed-LOD regions; SOG: asset-load flag);
        // the 60s cap reveals blurry-but-complete (coarse coverage required:
        // a slow network must never expose missing regions), and the absolute
        // cap is the only unconditional exit for a probeable scene whose
        // coverage never completes.
        // Reveal routes through dispatch so a stale poll
        // for an abandoned target is ignored by the reducer.
        var capHit = pendingFrames > LOADING_MAX_FRAMES;
        var readyByGate = sceneReady(pendingIndex);
        var readyByCoverage = !readyByGate && capHit && sceneCoverageResident(pendingIndex);
        var ready = readyByGate || readyByCoverage || (pendingFrames > LOADING_ABS_MAX_FRAMES);
        if (ready) {
          // Field diagnostic: WHICH exit revealed, at what gate depth, and
          // whether the pin machinery had assigned that depth yet -- an early
          // blurry reveal is otherwise indistinguishable from a cap timeout.
          try {
            var rIdx = pendingIndex;
            var rDepth = revealLevel(rIdx);
            console.info('[portals] reveal ' + rIdx +
              (readyByGate ? ' via readiness' : (readyByCoverage ? ' via NO-HOLES CAP' : ' via ABSOLUTE CAP')) +
              ' after ' + pendingFrames + ' frames, gateDepth=' + rDepth +
              ' (pinDepth=' + pinDepth[rIdx] + ' sceneMinLevel=' + sceneMinLevel[rIdx] +
              ' deviceFinest=' + deviceFinest + ' pinReady=' + pinReady + ') | ' + residencySummary(rIdx));
          } catch (revLogErr) {}
          dispatch({ type: 'revealed', target: pendingIndex });
        } else if (!overlayShown && pendingFrames >= SHOW_DELAY) {
          showLoading();
          overlayShown = true;
        }
      }
      // Watchdog: the cover must never outlive its hand-off. While an overlay
      // is showing, the overlay's own reveal caps bound the wait; with no
      // overlay, a missed hand-off would strand the cover, so force the
      // reconstruct after ~2s.
      if (transState.phase === 'covered' && !overlayShown) {
        coveredFrames++;
        if (coveredFrames > T_COVERED_MAX_FRAMES) {
          console.warn('[portals] transition cover watchdog fired -- reconstructing');
          transDispatch({ type: 'sceneShown' });
        }
      }
    } catch (e) {
      // Defensive: never leave the overlay stuck (mark the in-flight scene
      // ready so we don't re-arm forever). Logged: a swallowed error here
      // force-reveals the scene and would otherwise masquerade as an early
      // legitimate reveal.
      console.warn('portal overlay poll error (overlay dropped):', e);
      if (transState.phase !== 'idle') { transDispatch({ type: 'abort' }); }
      if (crossState.mode === 'loading' && crossState.target !== null) { readyScenes[crossState.target] = true; shown[crossState.target] = true; }
      crossState = { mode: 'idle', target: null };
      pendingIndex = null; overlayShown = false;
      hideLoading();
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
    if (!adjacency || deviceDead) return;
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

  // Gate the O(files) octree scan behind the pure cadence helper: full rate
  // during the settle window, then throttled, then stopped once settled/consumed
  // (see shouldSampleDeviceFinest). pinWhenBudgetReady's bounded pre-pinReady
  // poll still calls updateDeviceFinest directly (it self-terminates and needs
  // per-frame freshness for its own stability check).
  var dfFrame = 0;    // frames since the runtime started ticking (sampling clock)
  var dfStable = 0;   // frames since deviceFinest last ratcheted
  var dfFloorWasBelow = false;   // previous floorBelowFinest, to catch the floor-open edge
  function sampleDeviceFinest() {
    // floorBelowFinest: the start scene is still allowed to render finer than the
    // finest level we have observed resident (its viewer-owned floor is open below
    // deviceFinest). On a slow network the finer levels arrive well after the 10s
    // settle window, so keep observing while this holds (see shouldSampleDeviceFinest).
    var floorBelowFinest = !!comps[0] && deviceFinest !== null && comps[0].lodRangeMin < deviceFinest;
    // Re-arm on the floor-OPEN edge: on a slow network (firstFrame never fires)
    // the viewer opens scene 0's LOD floor to 0 only minutes in -- long after the
    // deviceFinest sampler stopped (stable ~10s while the floor was still closed
    // at coarsest). Without this, the finer levels then stream in with nobody
    // observing and deviceFinest stays frozen at coarsest, capping every
    // neighbour scene. Resetting dfStable when the floor first drops below the
    // observed finest resumes sampling so the imminent finer residency is caught.
    if (floorBelowFinest && !dfFloorWasBelow) { dfStable = 0; }
    dfFloorWasBelow = floorBelowFinest;
    if (!shouldSampleDeviceFinest(dfFrame++, deviceFinest, dfStable, pinReady, floorBelowFinest)) { dfStable++; return; }
    var before = deviceFinest;
    updateDeviceFinest();
    if (deviceFinest === before) {
      dfStable++;
    } else {
      dfStable = 0;
      // deviceFinest only ratchets FINER (running-min). After the first pin cycle
      // (pinReady), re-pin so neighbour scenes upgrade to the newly-observed depth
      // without waiting for the next crossing; the active-scene-first gates hold
      // that finer neighbour traffic until the active scene is resident at depth.
      if (pinReady) { pinDesired(); }
    }
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
  // the finest pinned batch (the reveal-depth floor), so a crossing holds the
  // loading overlay until the scene is showable at device-final quality
  // everywhere. Records the pinned file indices for later
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
    pinBatches[idx].push({ remaining: batch, markReady: !!markReady, done: false, level: minLevel });
    pumpPins(idx);
  }

  // --- active-scene-first pin priority gates -----------------------------
  // Gate 1 (gateRevealed): the active scene has been revealed to the user.
  // For crossed-into scenes this is shown[active] (crossing reducer). For the
  // START scene, shown[] is pre-latched true at init and the viewer's own
  // progress bar is not observable (viewerReady deliberately latches early
  // under throttling), so a one-shot startRevealed latch probes residency at
  // revealLevel(startSceneIdx) -- the same condition that drops a crossing
  // overlay -- throttled (the probe is O(files)), with an anti-stick frame
  // cap so neighbours are never held forever.
  // Gate 2 (gateActiveDone): every pin batch of the active scene is done (it
  // is resident at its pin depth). While its pins are not queued yet (e.g.
  // firstFrame has not fired so pinDesired skips scene 0), the same anti-
  // stick cap bounds the hold. There is deliberately NO cap on a queued-and-
  // loading active scene: on a slow network it may legitimately take minutes,
  // and that is exactly when neighbours' fine levels must wait.
  // Gates recompute at most once per frame (dfFrame-stamped) and ONLY while a
  // pump asks, so gate work stops with the pumps -- steady-state per-frame
  // cost stays zero. The closed->open transition of gate 2 fires the deferred
  // distance-2 warming (warmedScenes dedups against pinDesired's own call).
  var startSceneIdx = data.portalStart || 0;
  var startRevealed = false;      // one-shot: start scene revealed at startup
  var startRevealFrames = 0;      // frames observed while unlatched (cap clock)
  var gateRevealed = false;       // gate 1, valid for gateFrame
  var gateActiveDone = false;     // gate 2, valid for gateFrame
  var gateStuckFrames = 0;        // frames with active pins not queued (cap clock)
  var gateFrame = -1;             // dfFrame the gates were last computed for
  var REVEAL_PROBE_EVERY = 15;    // start-reveal probe cadence while unlatched
  function refreshGates() {
    if (gateFrame === dfFrame) { return; }
    gateFrame = dfFrame;
    if (!startRevealed) {
      if (!streaming || !octrees[startSceneIdx]) {
        startRevealed = true;     // SOG start (no octree to probe): the viewer's own bar handles it
      } else {
        startRevealFrames++;
        if (startRevealFrames > LOADING_MAX_FRAMES) {
          startRevealed = true;
          console.info('[portals] start-reveal gate opened via cap');
        } else if (startRevealFrames % REVEAL_PROBE_EVERY === 0 && sceneRevealResident(startSceneIdx)) {
          startRevealed = true;
          console.info('[portals] start-reveal gate opened via residency');
        }
      }
    }
    gateRevealed = (activeIndex !== startSceneIdx || startRevealed) && !!shown[activeIndex];
    var wasDone = gateActiveDone;
    var batches = pinBatches[activeIndex] || [];
    if (!octrees[activeIndex]) {
      gateActiveDone = true;      // SOG active: no batches to wait for
      gateStuckFrames = 0;
    } else if (pinnedScenes[activeIndex] && batches.length) {
      gateStuckFrames = 0;
      var done = true;
      for (var i = 0; i < batches.length; i++) { if (!batches[i].done) { done = false; break; } }
      gateActiveDone = done;
    } else {
      gateStuckFrames++;
      gateActiveDone = gateStuckFrames > LOADING_MAX_FRAMES;
    }
    if (!wasDone && gateActiveDone && pinReady) { warmFrontier(residentScenes()); }
  }

  // Per-scene pin pump: walk the scene's batches strictly in order (level-major,
  // coarsest first) and keep at most PIN_WAVE not-yet-loaded files in flight.
  // The engine's per-scene block loader is a 2-concurrent FIFO with no
  // prioritisation, so a small wave leaves it responsive to interactive
  // requests instead of burying them behind the whole preload. A completed
  // batch flagged markReady marks the scene ready (drops a pending overlay).
  // While a crossing is loading (pendingIndex), pumps of the OTHER scenes yield
  // so the destination scene gets the bandwidth. A reclaim bumps pinGen and the
  // pump exits (pinBatches was cleared). Each batch's remaining set tracks
  // only its not-yet-resident files, swap-removed as they arrive, so per-frame
  // work shrinks to zero as loading completes. Re-polling a not-yet-resident
  // file is load-bearing: ensureFileResource is what migrates an arrived
  // resource into the octree's resident map (getFileResource reads that map);
  // a resident pinned file never regresses while our incRefCount pin is held,
  // so it never needs re-polling once removed from the remaining set.
  function pumpPins(idx) {
    if (pinPumping[idx]) { return; }
    pinPumping[idx] = true;
    var gen = pinGen[idx] || 0;
    (function pump() {
      if (deviceDead) { pinPumping[idx] = false; return; }   // devicerestored reconciles and re-pumps
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
        // Active-scene-first priority: a non-active batch may be held until
        // the active scene is revealed / resident at its pin depth. Strict
        // batch order means holding this batch holds everything finer too;
        // spin (rAF below) exactly like the crossing yield above.
        if (idx !== activeIndex) {
          refreshGates();
          if (!pinBatchAllowed(bt.level, idx, activeIndex, pinDepth[activeIndex], deviceFinest,
            (octree.lodLevels ? octree.lodLevels - 1 : 0), gateRevealed, gateActiveDone)) {
            allDone = false;
            break;
          }
        }
        var j = 0;
        while (j < bt.remaining.length) {
          if (octree.getFileResource(bt.remaining[j])) {
            bt.remaining[j] = bt.remaining[bt.remaining.length - 1];   // swap-remove; order within a level is irrelevant
            bt.remaining.pop();
          } else {
            if (inflight < PIN_WAVE) { octree.ensureFileResource(bt.remaining[j]); inflight++; }
            j++;
          }
        }
        if (bt.remaining.length === 0) {
          bt.done = true;
          if (bt.markReady) { readyScenes[idx] = true; }
          continue;
        }
        allDone = false;
        break;   // strict order: don't start a finer batch before this one is resident
      }
      if (allDone) {
        if (idx === activeIndex) { gateFrame = -1; refreshGates(); }   // catch the gate-2 transition (fires deferred warming) even if no held pump remains
        pinPumping[idx] = false;
        return;
      }
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
    shown[idx] = false;
    heldFloor[idx] = null;
    floorGen[idx] = (floorGen[idx] || 0) + 1;   // invalidate an in-flight floor pump
  }

  // Partial unpin: drop refs on ONLY the levels FINER than min (lodLevel < min)
  // and keep the coarse [min..coarsest] blocks ref-held. Used for the ACTIVE
  // (on-screen) scene's budget coarsen: a full unpinScene would decRefCount(_, 0)
  // every pinned block, immediately FREEING the coarse blocks that cover NEAR
  // regions -- those are held only by our pin (the render instance holds refs only
  // to the FINER level it is currently drawing there), and the raised floor (min)
  // would then select them, missing, as a transient coarse blob until the async
  // re-pin refetches them. Shedding only the finer levels frees exactly what the
  // coarsen is meant to drop while the coarse pins never lose a ref -> no blob.
  // readyScenes/shown are left untouched: the scene stays coherently on screen at
  // coarser detail, so a later crossing back needs no overlay. pinBatches is
  // cleared and pinGen bumped so the caller's re-pin rebuilds the coarse batches
  // (the kept coarse files dedup in pinSceneToLevel and their batch completes at
  // once, already resident). The floor pump (floorGen/heldFloor) is deliberately
  // NOT invalidated: applySceneFloor below reasserts the new coarser canonical
  // floor, and any in-flight descent self-terminates against it.
  function unpinSceneFinerThan(idx, min) {
    var octree = octrees[idx];
    var files = pinnedFiles[idx];
    if (!octree || !octree.decRefCount || !files) { return; }
    var kept = [];
    for (var i = 0; i < files.length; i++) {
      var fi = files[i];
      var f = octree.files ? octree.files[fi] : null;
      // Unclassifiable file (malformed octree): keep it pinned rather than risk
      // freeing a block that is still on screen.
      if (f && f.lodLevel < min) {
        try { octree.decRefCount(fi, 0); }
        catch (e) { console.warn('portal partial-unpin block ' + fi + ' (scene ' + idx + ') failed:', e); }
      } else {
        kept.push(fi);
      }
    }
    pinnedFiles[idx] = kept;
    pinBatches[idx] = [];
    pinGen[idx] = (pinGen[idx] || 0) + 1;   // stop the in-flight pin pump; re-pin rebuilds coarse batches
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
  // Scene 0's lodRange floor stays viewer-owned (applyPerfSettings opens it
  // to 0 once ready) EXCEPT when the budget degraded its assigned pin depth
  // below the device's observed finest: the engine then endlessly requests
  // finest-level blocks the device cannot hold (field case: ERR_FAILED-with-
  // 200 churn on scene-0 level-0 webps under mobile memory pressure) for
  // splats that can never be shown. Clamp the component floor to the pin
  // depth, exactly as pinDesired does for extra scenes; release it (restore
  // the viewer's 0) if a later reconcile lifts the degradation. A never-
  // clamped device (floor null throughout -- desktop) never writes the
  // component at all, so stock start-scene behavior is untouched.
  // sceneMinLevel[0] stays unset: the reveal gate resolves pinDepth[0]
  // first, which pinDesired always assigns for scene 0.
  function applyStartFloor(floor) {
    if (floor === null && startFloor === null) { return; }   // never clamped: strict no-op
    startFloor = floor;
    if (comps[0]) {
      var base = (floor !== null) ? floor : 0;
      comps[0].lodRangeMin = (heldFloor[0] != null) ? Math.max(base, heldFloor[0]) : base;
    }
  }

  // Reconcile the resident frontier to the LIVE activeIndex (read here, never a
  // captured argument): a deferred poll may resolve a frame or a second after a
  // crossing, by which point activeIndex has changed. Reconciling to a stale scene
  // would unpin the new active and leak its re-pinned refs. Reading live activeIndex
  // makes every (possibly stale) call idempotent, and the "s !== active" check then
  // protects the true active scene.
  function pinDesired() {
    if (!adjacency || deviceDead) { return; }
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
        // Role changed toward neighbour on a tight budget -> coarsen.
        // pinSceneToLevel is additive so it cannot shed levels; we drop them
        // explicitly, then the level-major loop below re-pins [min..coarsest].
        if (idx === active) {
          // The ACTIVE (on-screen) scene: shed ONLY the excess finer levels and
          // keep the coarse pins ref-held, so the raised floor never selects a
          // just-freed coarse block as a transient blob (see unpinSceneFinerThan).
          unpinSceneFinerThan(idx, min);
        } else {
          // A hidden scene has no render instance, so a full unpin + re-pin just
          // reloads its coarse levels from the HTTP cache (cheap: coarse levels
          // are small) with nothing on screen to blob.
          unpinScene(idx);
        }
      }
      if (idx !== 0) {
        // Extra scenes: the component floor IS the pin depth.
        // applySceneFloor respects a pump-held floor (a scene mid-descent
        // must not reopen to the final depth before its finer levels are
        // fully resident).
        sceneMinLevel[idx] = min;
        applySceneFloor(idx);
      } else {
        // Scene 0's floor is viewer-owned unless the budget degraded its pin
        // depth below the device's observed finest (see applyStartFloor).
        // pinDesired only runs pinReady-gated, so deviceFinest has settled
        // by the time a clamp can engage.
        applyStartFloor(startSceneLodFloor(min, deviceFinest));
      }
      pinMins[idx] = min;
      if (coarse > maxCoarse) { maxCoarse = coarse; }
      pinnedScenes[idx] = true;
      pinDepth[idx] = min;
    }
    // Pin LEVEL-MAJOR, coarsest level first ACROSS scenes: every resident
    // scene's coarse (small, whole-scene) levels download before any scene's
    // fine levels, so no scene monopolises the bandwidth. A scene is marked
    // ready only when its FINEST pinned batch (the reveal-depth floor, lv ===
    // pmin) is resident: revealing on coarse alone showed visibly mixed LOD
    // regions right after a crossing, and the preference is to hold the
    // loading overlay until the scene shows at device-final quality.
    for (var lv = maxCoarse; lv >= 0; lv--) {
      for (var w = 0; w < want.length; w++) {
        var ps = want[w];
        var pmin = pinMins[ps];
        if (pmin === undefined || pmin > lv || !octrees[ps]) { continue; }
        var pcoarse = octrees[ps].lodLevels ? octrees[ps].lodLevels - 1 : 0;
        if (lv > pcoarse) { continue; }
        pinSceneToLevel(getAsset(ps), ps, lv, lv, lv === pmin);
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
    // has settled, so streaming scenes warm at the depth a future pin will
    // fetch. Deferred behind gate 2 (active scene resident at its pin depth):
    // distance-2 warming is the lowest-value traffic and must never compete
    // with the scene on screen. When gate 2 is still closed here, refreshGates
    // fires the warming on its closed->open transition instead.
    refreshGates();
    if (gateActiveDone) { warmFrontier(want); }
  }

  // Load scene idx's gsplat asset and create its (disabled unless active)
  // entity. Extracted from start() so the frontier reconcile can (re)load SOG
  // scenes on demand. No-op until start() has captured the live handles.
  function loadScene(idx) {
    if (entities[idx] || sceneLoading[idx] || !liveApp || deviceDead) { return; }
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
    sceneMinLevel[idx] = null; readyScenes[idx] = false; shown[idx] = false;
    heldFloor[idx] = null;
    floorGen[idx] = (floorGen[idx] || 0) + 1;   // invalidate an in-flight floor pump
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
