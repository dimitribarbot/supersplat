// Export-shaped annotation, as it appears in viewerSettingsJson.annotations
// (produced by annotations.export in src/annotations.ts).
type AnyAnnotation = {
    title?: string,
    text?: string,
    extras?: { id?: string, scene?: number }
};

// One baked table entry. Deliberately the exact shape sent back to the host in
// annotation.list.result / annotation.goto.result, so replies need no field
// stripping. `index` is the join key back into the live viewer array
// (viewer.global.settings.annotations): the viewer's internal scriptMap is keyed
// by object identity, so annotation.navigate must be fired with the viewer's own
// annotation object, not a copy.
type AnnotationEntry = {
    index: number,
    id: string,
    title: string,
    text: string,
    scene: number | null
};

// A host's reference to an annotation, taken straight off the postMessage
// payload -- so every field is untrusted and must be type-checked.
type AnnotationRef = {
    name?: unknown,
    id?: unknown,
    index?: unknown
};

// Bake the table the runtime companion consumes. Order matches
// viewerSettingsJson.annotations exactly, which is what makes `index` a valid
// join key at runtime.
const buildAnnotationIndex = (annotations: AnyAnnotation[]): AnnotationEntry[] => {
    return (annotations || []).map((a, i) => {
        const extras = (a && a.extras) || {};
        return {
            index: i,
            id: typeof extras.id === 'string' ? extras.id : '',
            title: (a && typeof a.title === 'string') ? a.title : '',
            text: (a && typeof a.text === 'string') ? a.text : '',
            scene: typeof extras.scene === 'number' ? extras.scene : null
        };
    });
};

// Pure reference resolver. Tries id, then index, then name (the title, compared
// case- and surrounding-whitespace-insensitively); the first hit wins, so a host
// may send several forms and the strongest available one is used. Duplicate
// titles are legal in the editor: the first match wins, by documented design.
//
// bad-request means no usable reference was supplied at all; not-found means one
// was, but nothing matched. Self-contained (no module-level references) so it is
// also injected verbatim into the runtime via Function.toString().
const resolveAnnotationRef = (table: AnnotationEntry[], ref: AnnotationRef): { index: number, reason: string } => {
    const entries = table || [];
    const r = ref || {};
    let usable = false;
    if (typeof r.id === 'string' && r.id !== '') {
        usable = true;
        for (let i = 0; i < entries.length; i++) {
            if (entries[i].id === r.id) {
                return { index: i, reason: '' };
            }
        }
    }
    if (typeof r.index === 'number' && isFinite(r.index)) {
        usable = true;
        const idx = Math.floor(r.index);
        if (idx >= 0 && idx < entries.length) {
            return { index: idx, reason: '' };
        }
    }
    if (typeof r.name === 'string' && r.name.trim() !== '') {
        usable = true;
        const want = r.name.trim().toLowerCase();
        for (let i = 0; i < entries.length; i++) {
            if (entries[i].title.trim().toLowerCase() === want) {
                return { index: i, reason: '' };
            }
        }
    }
    return { index: -1, reason: usable ? 'not-found' : 'bad-request' };
};

// The runtime bridge. Kept as a plain string so it is injected verbatim.
//
// The exported viewer keeps its app, camera and annotation objects in a private
// module closure, so the bridge reaches them through window.__supersplatViewer,
// published from the viewer bootstrap by splat-export-core (injectDeviceFallback
// runs unconditionally, so the handle is always there).
//
// Navigation reuses the viewer's own path: firing 'annotation.navigate' with an
// annotation object shows its tooltip, which fires 'annotation.activate', which
// makes the camera manager switch to orbit and fly to the baked pose -- and which
// the portals companion separately listens for to swap portal scene. So a
// cross-scene jump needs nothing here beyond firing the event.
//
// The annotation argument must be object-identical to an entry of
// global.settings.annotations: the viewer's internal scriptMap is keyed by
// identity. The baked table's `index` is the join key.
//
// NOTE: this is a template literal -- backslash escapes are consumed at build
// time. String operations only: no regex literals, no escape sequences.
const companionRuntime = `
(function () {
  var table = window.__supersplatIframeApi || [];
  var resolveAnnotationRef = ${resolveAnnotationRef.toString()};

  var ready = false;
  var pendingGoto = null;   // at most one; the latest press wins
  var pendingReplies = [];
  var subscribers = [];
  var MAX_SUBSCRIBERS = 8;

  // Reply narrowly to the sender's origin. A sandboxed or file:// host reports
  // the origin as the string 'null', which is not a legal targetOrigin and
  // throws -- a ZIP opened straight off disk hits exactly that, so fall back to
  // a broadcast rather than dropping the reply.
  function post(source, origin, message) {
    if (!source) return;
    try {
      source.postMessage(message, origin);
    } catch (e) {
      try { source.postMessage(message, '*'); } catch (e2) {}
    }
  }

  // First contact subscribes a window to activation notifications. Capped so a
  // parent spawning frames cannot grow an unbounded list of window references.
  function subscribe(source, origin) {
    if (!source) return;
    for (var i = 0; i < subscribers.length; i++) {
      if (subscribers[i].source === source) { subscribers[i].origin = origin; return; }
    }
    subscribers.push({ source: source, origin: origin });
    if (subscribers.length > MAX_SUBSCRIBERS) subscribers.shift();
  }

  function notify(message) {
    for (var i = 0; i < subscribers.length; i++) {
      post(subscribers[i].source, subscribers[i].origin, message);
    }
  }

  function getViewer() {
    return window.__supersplatViewer || null;
  }

  function getEvents() {
    var v = getViewer();
    return (v && v.global && v.global.events) || null;
  }

  // The real signal that navigation can do anything: the viewer's Annotations
  // object, which is what registers the annotation.navigate listener. main()
  // returns -- and publishes window.__supersplatViewer -- well before the
  // splat finishes loading, and this object is only constructed in the
  // viewer's post-gsplatLoad continuation (never at all under config.noui).
  // Checked live everywhere it matters (not cached) so a request arriving
  // after a slow-but-real load finally finishes still succeeds.
  function hasAnnotations() {
    var v = getViewer();
    return !!(v && v.annotations);
  }

  // config.noui skips constructing the annotations object forever. Detected
  // directly so a noui host gets an honest, immediate readiness signal
  // instead of waiting out the watchdog for something that will never come --
  // annotation.list and ping need no annotations object to answer correctly.
  function isNoUi() {
    var v = getViewer();
    return !!(v && v.global && v.global.config && v.global.config.noui);
  }

  // The viewer's own annotation array -- the objects annotation.navigate expects.
  function liveAnnotations() {
    var v = getViewer();
    var settings = v && v.global && v.global.settings;
    var list = settings && settings.annotations;
    return (list && list.length) ? list : null;
  }

  function doGoto(req) {
    var res = resolveAnnotationRef(table, req.ref);
    if (res.index < 0) {
      post(req.source, req.origin, { type: 'supersplat:annotation.goto.result', requestId: req.requestId, ok: false, reason: res.reason });
      return;
    }
    // Navigation only works once the viewer's own Annotations object exists to
    // hear annotation.navigate -- checked here regardless of how ready ended
    // up true (a real load completing, the watchdog backstop, or noui), so a
    // premature or permanently-unavailable request reports honestly instead of
    // firing into the void and claiming ok: true.
    if (!hasAnnotations()) {
      post(req.source, req.origin, { type: 'supersplat:annotation.goto.result', requestId: req.requestId, ok: false, reason: 'unavailable' });
      return;
    }
    var list = liveAnnotations();
    var ev = getEvents();
    if (!ev || !list || !list[res.index]) {
      post(req.source, req.origin, { type: 'supersplat:annotation.goto.result', requestId: req.requestId, ok: false, reason: 'unavailable' });
      return;
    }
    ev.fire('annotation.navigate', list[res.index]);
    post(req.source, req.origin, { type: 'supersplat:annotation.goto.result', requestId: req.requestId, ok: true, annotation: table[res.index] });
  }

  function answer(req) {
    if (req.type === 'supersplat:annotation.list') {
      post(req.source, req.origin, { type: 'supersplat:annotation.list.result', requestId: req.requestId, annotations: table });
    } else if (req.type === 'supersplat:ping') {
      post(req.source, req.origin, { type: 'supersplat:ready', requestId: req.requestId });
    }
  }

  // Installed at parse time, before the viewer's deferred module bootstrap runs,
  // so no host message can be missed. A handler that throws would be invisible to
  // the host and could disrupt unrelated listeners, hence the blanket catch.
  window.addEventListener('message', function (e) {
    try {
      var d = e && e.data;
      if (!d || typeof d !== 'object') return;
      var type = d.type;
      if (type !== 'supersplat:annotation.goto' &&
          type !== 'supersplat:annotation.list' &&
          type !== 'supersplat:ping') return;
      subscribe(e.source, e.origin);
      var req = { source: e.source, origin: e.origin, requestId: d.requestId, type: type };
      if (type === 'supersplat:annotation.goto') {
        req.ref = { name: d.name, id: d.id, index: d.index };
        if (ready) { doGoto(req); } else { pendingGoto = req; }
        return;
      }
      if (ready) { answer(req); } else { pendingReplies.push(req); }
    } catch (err) {}
  });

  function onReady() {
    if (ready) return;
    ready = true;
    post(window.parent, '*', { type: 'supersplat:ready' });
    for (var i = 0; i < pendingReplies.length; i++) answer(pendingReplies[i]);
    pendingReplies = [];
    if (pendingGoto) { var g = pendingGoto; pendingGoto = null; doGoto(g); }
  }

  var bound = false;
  function start() {
    var ev = getEvents();
    if (!ev) { requestAnimationFrame(start); return; }
    if (!bound) {
      bound = true;
      // Fires for every activation whatever the cause: a host goto, a hotspot
      // click, or the viewer's own prev/next chevrons -- which is what lets host
      // UI keep the right button highlighted.
      ev.on('annotation.activate', function (ann) {
        var list = liveAnnotations();
        var idx = list ? list.indexOf(ann) : -1;
        var entry = (idx >= 0) ? table[idx] : null;
        if (!entry) return;
        notify({ type: 'supersplat:annotation.activated', index: entry.index, id: entry.id, title: entry.title, scene: entry.scene });
      });
      ev.on('annotation.deactivate', function () {
        notify({ type: 'supersplat:annotation.deactivated' });
      });
      // Ready-gate watchdog, mirroring the portals companion's ready-gate
      // watchdog (src/viewer-companion/portals.ts). getEvents() above resolves
      // as soon as the viewer publishes its handle -- long before the splat
      // finishes loading -- so it is not a safe readiness signal on its own;
      // see hasAnnotations()/isNoUi() below, which are. Without a bound, a
      // load that never finishes (or a bug in that detection) would strand
      // every queued goto/list request forever and keep this rAF loop ticking
      // every frame indefinitely. ~15s grace mirrors the portals watchdog's
      // cadence; after that this is purely a backstop -- it reports readiness
      // honestly (ping/list still answer fine with no annotations object) but
      // never manufactures a successful goto, since doGoto checks
      // hasAnnotations() itself regardless of how ready became true.
      var watchdogTicks = 0;
      var watchdogTimer = setInterval(function () {
        if (ready) { clearInterval(watchdogTimer); return; }
        watchdogTicks++;
        if (watchdogTicks < 3) { return; }
        clearInterval(watchdogTimer);
        onReady();
      }, 5000);
    }
    // The real navigation-ready signal (see hasAnnotations() above). noui
    // exports skip constructing it forever, so detect that directly rather
    // than making every noui host wait out the watchdog for something that
    // will never arrive.
    if (hasAnnotations() || isNoUi()) { onReady(); return; }
    if (!ready) requestAnimationFrame(start);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
`;

// The two Unicode separators that are valid in JSON strings but terminate a
// JavaScript line, built by code point so this source file stays plain ASCII.
const SEP_LINE = String.fromCharCode(0x2028);
const SEP_PARAGRAPH = String.fromCharCode(0x2029);

// Produce the full HTML fragment to inject before </body>. Always non-empty: a
// host embedding an annotation-less scene should still get a ready broadcast and
// an empty list rather than silence.
const buildIframeApiInjection = (annotations: AnyAnnotation[]): string => {
    const table = buildAnnotationIndex(annotations || []);
    // Escape characters that are unsafe inside an HTML <script> context so an
    // annotation title containing e.g. "</script>" or a line/paragraph separator
    // cannot break out of the injected script tag.
    const tableJson = JSON.stringify(table)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .split(SEP_LINE).join('\\u2028')
    .split(SEP_PARAGRAPH).join('\\u2029');
    return `<script>window.__supersplatIframeApi = ${tableJson};</script>` +
        `<script>${companionRuntime}</script>`;
};

export { buildAnnotationIndex, buildIframeApiInjection, resolveAnnotationRef };
export type { AnnotationEntry, AnnotationRef, AnyAnnotation };
