// Early LOD clamp for the exported viewer.
//
// The stock viewer streams the ENTIRE LOD pyramid before its first reveal --
// 120.6 MB measured on a scene whose coarsest level is 8.4 MB -- where upstream
// intends the coarsest level only. Cause: GSplatComponent defaults to
// _lodRangeMin = 0 / _lodRangeMax = 99, and the viewer's own coarse-only clamp
// ("reveal once low lod has loaded for fastest possible reveal") sits inside
// Promise.all([gsplatLoad, skyboxLoad, collisionLoad]) -- so it lands only after
// the collision binary has downloaded, by which point the engine's first LOD
// selection has already requested every block. Those requests then compete for
// bandwidth with the collision binary that gates the reveal, and the engine's
// budget balancer is disabled for the whole window (app.scene.gsplat.splatBudget
// is 0 until applyPerfSettings runs at the ready gate), so the streaming is
// unbounded -- on mobile that is the memory pressure as well as the data cost.
//
// Clamping LATE cannot undo it: of the blocks in flight, all but a couple sit in
// the octree instance's prefetchPending, which has no range-driven removal path
// and is re-issued through ensureFileResource on every poll until it lands. The
// only fix is to clamp BEFORE the first selection.
//
// That race is winnable, and by construction rather than by luck:
//   - App.tick fires 'frameupdate', then update(), then 'framerender'.
//     GSplatComponentSystem hooks 'framerender' -> gsplatDirector.updateStreaming(),
//     which is where LOD selection and the block requests happen. So a
//     'frameupdate' handler always precedes the same frame's selection.
//   - The gsplat entity is created inside the asset's 'load' callback -- an HTTP
//     macrotask, which cannot interrupt a synchronous frame tick -- so the
//     component always appears BETWEEN ticks, never mid-frame.
//   - main() kicks off the loads and returns `new Viewer(...)` synchronously;
//     Viewer's constructor assigns this.global first. So
//     window.__supersplatViewer.global.app is in hand long before the octree
//     asset lands. Do NOT reach for the app via debugPanel._global.app or
//     navCursor.app the way device-fallback/portals do: both of those are built
//     INSIDE the very Promise.all this companion exists to get ahead of.
//
// Belt and braces on the hook: this script is classic (parse-time), so its rAF
// poll is registered before app.start() registers the engine tick, and rAF
// callbacks run in registration order -- the poll therefore runs ahead of
// App.tick within a frame, one notch earlier still than 'frameupdate'. Both
// paths call the same idempotent one-shot, so whichever fires first wins and the
// other finds it done.
//
// After the clamp the companion detaches entirely. The viewer's own late clamp
// then becomes an idempotent no-op, applyPerfSettings reopens the range to
// [0, 1000] at the ready gate as designed, and the splat budget caps residency
// from there -- so most of the deferred pyramid is never fetched at all rather
// than merely postponed. Everything the portals companion does to scene 0's
// floor (applyStartFloor / scheduleRefine) is firstFrame- or cameraManager-
// gated, i.e. strictly after this has detached.
//
// Authoring constraints (the runtime body is a template literal baked verbatim):
// NO backslash escapes of any kind, including inside comments (they are cooked
// away at build time), and ES5 only.

// Frame budget for the poll. Deliberately generous (~5 minutes at 60fps): a
// cold mobile load can take a long time to produce lod-meta.json, and giving up
// early would forfeit the win exactly where it matters most. The cost per frame
// is one findComponent over a tree that holds only the camera until the gsplat
// entity appears, and the poll stops the moment it resolves. Counted in FRAMES,
// not wall-clock, on purpose: a backgrounded tab fires no rAF, so a time-based
// cap could expire while nothing was being selected either -- and then hand the
// unclamped pyramid to the first frame after the user comes back.
const MAX_POLL_FRAMES = 18000;

const companionRuntime = `
(function () {
  var MAX_FRAMES = ${MAX_POLL_FRAMES};

  // ?fullload is the viewer's own screenshot path: it reveals only once FULL
  // quality has loaded, so a coarse-only clamp is the one thing it does not
  // want. Honour it by standing down completely -- return before anything is
  // registered, so this is a silent no-op and the viewer behaves exactly as it
  // did before this companion existed.
  //
  // Read the param EXACTLY as index.html does (new URL(location.href) ->
  // searchParams.has) rather than by substring: ?content=fullload.json would
  // otherwise switch the clamp off and quietly restore the slow load. Wrapped
  // because an unparseable href would throw here, in a parse-time script, and
  // take the whole companion down with it.
  var fullload = false;
  try { fullload = new URL(location.href).searchParams.has('fullload'); } catch (e) {}
  if (fullload) { return; }

  var app = null;
  var hooked = false;
  var done = false;
  var frames = 0;

  function detach() {
    if (hooked && app && app.off) { app.off('frameupdate', clamp); }
    hooked = false;
  }

  // Idempotent one-shot. Returns true once it has settled (clamped, or decided
  // there is nothing to clamp), false while it should keep waiting.
  function clamp() {
    if (done) { return true; }
    if (!app || !app.root || !app.root.findComponent) { return false; }
    var comp = app.root.findComponent('gsplat');
    if (!comp) { return false; }
    // The component can exist a moment before its asset resolves; a resource of
    // null is "not yet", not "no octree". Keep waiting -- detaching here would
    // silently forfeit the clamp.
    var res = comp.resource;
    if (!res) { return false; }
    done = true;
    detach();
    var levels = res.octree && res.octree.lodLevels;
    if (typeof levels === 'number' && levels > 0) {
      comp.lodRangeMin = comp.lodRangeMax = levels - 1;
      console.info('[lod] start scene clamped to level ' + (levels - 1) + ' of ' + levels + ' until reveal');
    }
    return true;
  }

  function poll() {
    if (done) { return; }
    if (!app) {
      var v = window.__supersplatViewer;
      app = (v && v.global && v.global.app) || null;
      if (app && app.on) { app.on('frameupdate', clamp); hooked = true; }
    }
    if (clamp()) { return; }
    if (++frames > MAX_FRAMES) {
      done = true;
      detach();
      console.warn('[lod] no gsplat component after ' + MAX_FRAMES + ' frames -- early clamp stood down');
      return;
    }
    requestAnimationFrame(poll);
  }
  requestAnimationFrame(poll);
})();
`;

// Produce the HTML fragment to inject before </body>. Always injected: a
// non-streaming export (SOG/PLY) has no octree, so the runtime settles on its
// first look and detaches.
const buildEarlyLodClampInjection = (): string => {
    return `<script>${companionRuntime}</script>`;
};

export { buildEarlyLodClampInjection };
