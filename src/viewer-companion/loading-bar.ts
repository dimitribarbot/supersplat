// Loading-bar companion for the exported viewer.
//
// Authoring constraints (the runtime body is a template literal baked verbatim
// into the exported HTML): NO backslash escapes of any kind, including inside
// comments (they are cooked away at build time), and ES5 only.

const buildLoadingBarInjection = (collisionBytes: number): string => {
    const total = Math.max(0, Math.floor(collisionBytes || 0));
    return `<script>
(function () {
  var COLLISION_BYTES = ${total};

  // ?noui hides the entire UI (dom.ui gets .hidden inside initUI). Painting a
  // 0% bar before that runs would flash an indicator on a deliberately chrome-
  // less embed, so stand down completely -- return before anything at all is
  // registered. Read the param EXACTLY as index.html does (new URL ->
  // searchParams.has) rather than by substring, and wrap it: an unparseable
  // href would throw here, in a parse-time script, and take the companion down.
  var params = null;
  try { params = new URL(location.href).searchParams; } catch (e) {}
  if (params && params.has('noui')) { return; }

  // Paint the bar at 0% with no JS at all. #loadingWrap is in the DOM from the
  // first byte, but the stock index.css gives #loadingBar no background-image
  // and #loadingText is empty, so the markup renders nothing until the viewer
  // paints it -- which cannot happen until the ready gate.
  //
  // Two properties make this safe:
  //   - the viewer writes dom.loadingBar.style.backgroundImage, an INLINE
  //     style, which outranks any injected author rule. So no !important, which
  //     would freeze the bar at 0% forever, and JS updates take over cleanly.
  //   - :empty stops matching the moment JS sets textContent, so the
  //     placeholder clears itself with no teardown code.
  // Selector specificity matches the stock rules (two IDs) so this is a pure
  // addition rather than a specificity fight.
  try {
    var style = document.createElement('style');
    style.textContent =
      '#loadingWrap > #loadingBar { background-image: linear-gradient(90deg, white 0%, white 100%); }' +
      '#loadingWrap > #loadingText:empty::after { content: "0%"; }';
    (document.head || document.documentElement).appendChild(style);
  } catch (e) {}

  // Frame budget for the startup poll. Deliberately generous (~5 minutes at
  // 60fps) and counted in FRAMES, not wall-clock: a backgrounded tab fires no
  // rAF, so a time cap could expire while nothing was loading either.
  var MAX_FRAMES = 18000;

  var state = null;
  var gsplat = null;
  var attached = false;
  var frames = 0;

  // High-water mark of what has been displayed. Every write goes through show(),
  // so the bar is monotonic by construction.
  var shown = 0;

  // Drain-from-peak over world.pendingLoadCount, the same gauge the viewer uses
  // -- but fed from the FIRST frame instead of from the ready gate. Zero of zero
  // is "nothing discovered yet", not "done", so it must read as 0.
  var peak = 0;
  var pending = 0;

  // Collision term. COLLISION_BYTES is the RAW length of index.voxel.bin, baked
  // at export time. Counting decompressed stream bytes against it is correct
  // whether or not the CDN gzipped the file, which is why the total cannot come
  // from Content-Length: on the publish path that header reports the compressed
  // size (39.4 MB -> 11.2 MB measured) and would skew the gauge 3.5x.
  //
  // A ?collision= / ?voxel= override points the viewer at some other file whose
  // size the exporter cannot know, so the baked total is abandoned there and the
  // gsplat blocks own the whole range instead.
  var collisionTotal = COLLISION_BYTES;
  var collisionLoaded = 0;
  if (params && (params.has('collision') || params.has('voxel'))) { collisionTotal = 0; }

  // Flipped at the reveal, when #loadingWrap is hidden. Until then the display
  // is held below 100 -- see onProgress.
  var revealed = false;

  function show(p) {
    // Before the handle resolves there is nowhere to paint. Return WITHOUT
    // advancing the high-water mark: update() recomputes from live values, so
    // the accumulated progress paints on the first update after attaching.
    if (!state) { return; }
    if (p <= shown) { return; }
    shown = p;
    // Drive the viewer's own state rather than poking the DOM: state.progress is
    // an observe() Proxy, so this repaints the bar through the viewer's painter
    // AND advances the poster's progressive unblur, both of which are otherwise
    // frozen until the ready gate.
    try { state.progress = p; } catch (e) {}
  }

  function update() {
    var blocks = peak > 0 ? (peak - pending) / peak : 0;
    var p;
    if (collisionTotal > 0) {
      // Two independent downloads gate the reveal and only one of them has a
      // knowable byte total, so split the range evenly rather than inventing a
      // weighting. Which one dominates is scene-dependent: 11.2 MB of collision
      // against a small coarse level on an outdoor scan, roughly the reverse on
      // an indoor one.
      var bytes = collisionLoaded / collisionTotal;
      if (bytes > 1) { bytes = 1; }
      p = Math.floor(50 * blocks + 50 * bytes);
    } else {
      p = Math.floor(100 * blocks);
    }
    // Cap below 100: the last step belongs to the actual reveal, so the bar
    // never sits at a finished-looking 100% while the viewer is still gated.
    if (p > 99) { p = 99; }
    show(p);
  }

  // Observe the collision binary as it streams. Strict pass-through: the
  // wrapper returns the original fetch's result untouched and does its counting
  // on a clone(), so a failure anywhere in here costs progress reporting and
  // nothing else. Installed at PARSE time -- BOTH of the exported page's own
  // scripts are type="module" and therefore deferred until after parsing, so
  // nothing has been fetched yet when this classic script runs -- and
  // uninstalled the moment the request is seen. Only the start scene's binary
  // matters: portal scenes load theirs long after the reveal.
  //
  // LOAD-BEARING ORDERING: the wrapper attaches its .then SYNCHRONOUSLY, before
  // returning, so this runs ahead of loadVoxelCollision's own await
  // continuation and the body is still undisturbed when clone() is called.
  // Deferring that registration would make clone() throw -- swallowed by the
  // catch below, silently disabling the collision term. And reading
  // response.body instead of the clone would be far worse: it would disturb the
  // body the viewer is about to read, rejecting collisionLoad and the gating
  // Promise.all, so the scene would never reveal at all.
  function observeCollision(response) {
    try {
      if (!response || !response.ok || !response.clone) { return; }
      var copy = response.clone();
      if (!copy || !copy.body || !copy.body.getReader) { return; }
      var reader = copy.body.getReader();
      var pump = function () {
        reader.read().then(function (chunk) {
          if (!chunk || chunk.done) { return; }
          collisionLoaded += (chunk.value && chunk.value.length) || 0;
          update();
          pump();
        }, function () {});
      };
      pump();
    } catch (e) {}
  }

  var originalFetch = null;
  var wrappedFetch = null;

  function restoreFetch() {
    try {
      if (wrappedFetch && window.fetch === wrappedFetch) { window.fetch = originalFetch; }
    } catch (e) {}
    wrappedFetch = null;
  }

  if (collisionTotal > 0 && typeof window.fetch === 'function') {
    originalFetch = window.fetch;
    wrappedFetch = function (input) {
      var result = originalFetch.apply(this, arguments);
      try {
        // string (what loadVoxelCollision passes), Request (.url), or URL
        var url = typeof input === 'string' ? input : ((input && input.url) || String(input || ''));
        if (url.indexOf('.voxel.bin') !== -1) {
          restoreFetch();
          if (result && result.then) { result.then(observeCollision, function () {}); }
        }
      } catch (e) {}
      return result;
    };
    window.fetch = wrappedFetch;
  }

  // The viewer's gauge is drain-from-peak over a LIVE pending count, so work
  // queued after the peak drops the displayed percentage (field-reported on
  // mobile as "80% -> 60% -> 100%"). Clamp the display to its running maximum:
  // on a rising tick do nothing -- the viewer's own painter already ran, since
  // initUI registers inside main() and this companion attaches only after
  // main() has resolved -- and on a falling one write the high-water mark back.
  //
  // The write-back is re-entrant through the same Proxy, but it terminates at
  // depth two: the inner fire arrives with target === p and returns immediately.
  //
  // The cap matters as much as the floor. On SOG/package exports there is a
  // SECOND upstream writer -- loadGsplat's asset 'progress' callback, which
  // downloadArrayBuffer drives to 100 the moment the content bundle lands, while
  // the collision binary may still have seconds to run (and on a single-file
  // export, where content-length is 0, it reaches 100 instantly). Without the
  // cap, "never decrease" would pin the bar at a finished-looking 100% for that
  // whole window, which reads as a hang. Holding at 99 until the reveal costs
  // nothing: #loadingWrap is hidden the moment loaded flips.
  function onProgress(p) {
    if (typeof p !== 'number' || p !== p) { return; }
    if (p > shown) { shown = p; }
    var cap = revealed ? 100 : 99;
    var target = shown > cap ? cap : shown;
    if (target !== p) { try { state.progress = target; } catch (e) {} }
  }

  // NaN would be catastrophic rather than merely wrong: it fails every ordering
  // comparison, so it would latch into the high-water mark and disable the
  // monotonic guarantee for the rest of the load. Not reachable from the engine
  // today, but the cost of excluding it is one comparison.
  function onFrameReady(camera, layer, ready, loading) {
    if (typeof loading !== 'number' || loading !== loading) { return; }
    pending = loading;
    if (loading > peak) { peak = loading; }
    update();
  }

  // GSplatManager fires 'frame:ready' on app.systems.gsplat every frame from the
  // very first one; the viewer simply does not listen until its ready gate. Take
  // the app from window.__supersplatViewer.global, which is published as soon as
  // main() resolves -- NOT from debugPanel/navCursor, which are built inside the
  // gated Promise.all this companion exists to get ahead of.
  function poll() {
    if (!attached) {
      var v = window.__supersplatViewer;
      var g = v && v.global;
      var sys = g && g.app && g.app.systems && g.app.systems.gsplat;
      if (sys && sys.on && g.state && g.events) {
        attached = true;
        state = g.state;
        gsplat = sys;
        g.events.on('progress:changed', onProgress);
        gsplat.on('frame:ready', onFrameReady);
        // At the reveal the bar is hidden (#loadingWrap gains .hidden) and the
        // viewer switches to on-demand rendering, so stop doing per-frame work
        // and hand fetch back. The progress:changed clamp is left attached: it
        // is event-driven, costs nothing while idle, and lifting the cap to 100
        // is its job.
        g.events.on('loaded:changed', function () {
          revealed = true;
          try { gsplat.off('frame:ready', onFrameReady); } catch (e) {}
          restoreFetch();
        });
        // Paint whatever the collision observer accumulated while the handle was
        // still resolving, rather than waiting for the next chunk or frame.
        update();
      }
    }
    // Once attached, the only reason to keep ticking is to time the fetch
    // wrapper out. A collision JSON that 404s makes loadVoxelCollision throw
    // BEFORE it requests the .bin, so neither the request sighting nor
    // loaded:changed would ever fire and the wrapper would outlive its purpose.
    if (attached && !wrappedFetch) { return; }
    if (++frames > MAX_FRAMES) {
      // Upstream drift, or a viewer that never booted. Leave nothing behind.
      restoreFetch();
      if (!attached) {
        console.warn('[loading-bar] no viewer handle after ' + MAX_FRAMES + ' frames -- companion stood down');
      }
      return;
    }
    requestAnimationFrame(poll);
  }
  requestAnimationFrame(poll);
})();
</script>`;
};

export { buildLoadingBarInjection };
