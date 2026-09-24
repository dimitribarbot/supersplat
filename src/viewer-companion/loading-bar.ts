// Loading-bar companion for the exported viewer.
//
// Authoring constraints (the runtime body is a template literal baked verbatim
// into the exported HTML): NO backslash escapes of any kind, including inside
// comments (they are cooked away at build time), and ES5 only.

const buildLoadingBarInjection = (): string => {
    return `<script>
(function () {
  // ?noui means config.ui is false, so createViewer never inserts the UI
  // markup at all (root.innerHTML = uiHtml only runs when config.ui is true;
  // otherwise the root gets a bare canvas) -- there is no loading bar to
  // paint. Painting a 0% bar before that is known would flash an indicator on
  // a deliberately chrome-less embed, so stand down completely -- return
  // before anything at all is registered. Read the param EXACTLY as
  // index.html does (new URL -> searchParams.has) rather than by substring,
  // and wrap it: an unparseable href would throw here, in a parse-time
  // script, and take the companion down.
  var params = null;
  try { params = new URL(location.href).searchParams; } catch (e) {}
  if (params && params.has('noui')) { return; }

  // Paint the bar at 0% with no JS at all. The stock index.css gives
  // .sse-loadingBar no background-image and .sse-loadingText is empty, so the
  // markup renders nothing until the viewer's own updateLoadingProgress
  // paints it -- which happens as soon as initUI runs (synchronously, at
  // construction: it registers on progress:changed and immediately calls
  // updateLoadingProgress(state.progress) once), not gated by the splats +
  // skybox reveal. The UI markup itself does not exist in the DOM until the
  // viewer module runs and createViewer inserts it (unlike upstream 1.31,
  // it is not present from the first byte); this rule applies the instant
  // that happens.
  //
  // Two properties make this safe:
  //   - the viewer writes dom.loadingBar.style.backgroundImage, an INLINE
  //     style, which outranks any injected author rule. So no !important, which
  //     would freeze the bar at 0% forever, and JS updates take over cleanly.
  //   - :empty stops matching the moment JS sets textContent, so the
  //     placeholder clears itself with no teardown code.
  // The selectors match the stock rules' specificity (0,3,0) and win by source
  // order (this style is appended after the index.css link) -- a pure
  // addition rather than a specificity fight.
  try {
    var style = document.createElement('style');
    style.textContent =
      '.sse-viewer .sse-loadingWrap > .sse-loadingBar { background-image: linear-gradient(90deg, white 0%, white 100%); }' +
      '.sse-viewer .sse-loadingWrap > .sse-loadingText:empty::after { content: "0%"; }';
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

  // Flipped at the reveal, when .sse-loadingWrap gains .sse-hidden. Until
  // then the display is held below 100 -- see onProgress.
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
    var p = Math.floor(100 * blocks);
    // Cap below 100: the last step belongs to the actual reveal, so the bar
    // never sits at a finished-looking 100% while the viewer is still gated.
    if (p > 99) { p = 99; }
    show(p);
  }

  // The viewer's gauge is drain-from-peak over a LIVE pending count, so work
  // queued after the peak drops the displayed percentage (field-reported on
  // mobile as "80% -> 60% -> 100%"). Clamp the display to its running maximum:
  // on a rising tick do nothing -- the viewer's own painter already ran, since
  // initUI registers it synchronously right after the viewer handle
  // (published at construction) becomes available, and this companion only
  // ever observes that handle a requestAnimationFrame tick later at the
  // earliest -- and on a falling one write the high-water mark back.
  //
  // The write-back is re-entrant through the same Proxy, but it terminates at
  // depth two: the inner fire arrives with target === p and returns immediately.
  //
  // The cap matters as much as the floor. supersplat-viewer >= 1.32 already
  // writes progress monotonically, capped at 99 itself
  // (state.progress = Math.max(state.progress, Math.min(99, ...))), and the
  // reveal gates on splats + skybox only -- collision, when present, attaches
  // after the reveal. The clamp here is kept regardless: it is what makes the
  // frame:ready gauge this companion writes obey the same "never decrease,
  // never finish early" rule as the viewer's own writes. Holding at 99 until
  // the reveal costs nothing: .sse-loadingWrap gains .sse-hidden the moment
  // loaded flips.
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
  // very first one; the viewer's own listener does not attach until gsplatLoad
  // resolves (its progress handler is installed inside a .then chained off
  // gsplatLoad, not at construction and not at the splats+skybox reveal), so
  // there is still a real head start to claim. Take the app from
  // window.__supersplatViewer.global -- the viewer handle (published at
  // construction) -- NOT from debugPanel/navCursor, which are built inside the
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
        // At the reveal the bar is hidden (.sse-loadingWrap gains .sse-hidden)
        // and the viewer switches to on-demand rendering, so stop doing
        // per-frame work. The progress:changed clamp is left attached: it is
        // event-driven, costs nothing while idle, and lifting the cap to 100
        // is its job.
        g.events.on('loaded:changed', function () {
          revealed = true;
          try { gsplat.off('frame:ready', onFrameReady); } catch (e) {}
        });
        update();
      }
    }
    // Once attached, there is nothing left for the poll to do: frame:ready and
    // progress:changed are event-driven from here on.
    if (attached) { return; }
    if (++frames > MAX_FRAMES) {
      // Upstream drift, or a viewer that never booted. Leave nothing behind.
      console.warn('[loading-bar] no viewer handle after ' + MAX_FRAMES + ' frames -- companion stood down');
      return;
    }
    requestAnimationFrame(poll);
  }
  requestAnimationFrame(poll);
})();
</script>`;
};

export { buildLoadingBarInjection };
