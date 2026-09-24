// Export-shaped annotation, as it appears in viewerSettingsJson.annotations
// (produced by annotations.export in src/annotations.ts).
type AnyAnnotation = {
    title?: string,
    text?: string,
    extras?: { id?: string, scene?: number, i18n?: Record<string, { title?: string, text?: string }> }
};

// One baked table entry. Deliberately the exact shape sent back to the host in
// annotation.list.result / annotation.goto.result, so replies need no field
// stripping. `index` is the join key back into the live viewer array
// (viewer.global.settings.annotations) and into viewer.selectAnnotation(index),
// which selects by position -- no object-identity matching needed.
type AnnotationEntry = {
    index: number,
    id: string,
    title: string,
    text: string,
    scene: number | null,
    // Baked so the runtime can resolve to the visitor's language. Stripped
    // before anything is sent to the host.
    i18n?: Record<string, { title?: string, text?: string }>,
    // The untranslated title, kept so goto-by-name still matches a host that
    // was keyed on it before the visitor's language changed.
    baseTitle?: string
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
        const entry: AnnotationEntry = {
            index: i,
            id: typeof extras.id === 'string' ? extras.id : '',
            title: (a && typeof a.title === 'string') ? a.title : '',
            text: (a && typeof a.text === 'string') ? a.text : '',
            scene: typeof extras.scene === 'number' ? extras.scene : null
        };
        // Carried through only when non-empty, so an untranslated export's
        // baked JSON stays free of "i18n":null noise.
        if (extras.i18n && Object.keys(extras.i18n).length > 0) {
            entry.i18n = extras.i18n;
        }
        return entry;
    });
};

// Pure reference resolver. Tries id, then index, then name (the title, compared
// case- and surrounding-whitespace-insensitively); the first hit wins, so a host
// may send several forms and the strongest available one is used. Duplicate
// titles are legal in the editor: the first match wins, by documented design.
// The same first-index-wins rule also covers a second, newer way titles can
// collide: since a table can carry per-language titles (see
// localizeAnnotationTable below), one annotation's TRANSLATED title can equal
// a different annotation's BASE (or baseTitle-matched) title -- e.g. annotation
// A's French translation happens to read "Roof" while annotation B's English
// title already is "Roof". This is the same class of ambiguity as duplicate
// titles, considered deliberately, not overlooked: it resolves the same way.
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
            if (entries[i].title.trim().toLowerCase() === want ||
                (entries[i].baseTitle || '').trim().toLowerCase() === want) {
                return { index: i, reason: '' };
            }
        }
    }
    return { index: -1, reason: usable ? 'not-found' : 'bad-request' };
};

// Resolve a baked table to one language. Returns a NEW array -- the runtime
// keeps the baked table intact so a later request can resolve differently.
// Per-field fallback: a missing key keeps the base string. `baseTitle` records
// the untranslated title so goto-by-name accepts either form, and `i18n` is
// dropped so nothing sent to the host carries the whole dictionary.
//
// Self-contained (no module-level references) so it is also injected verbatim
// into the runtime via Function.toString(), beside resolveAnnotationRef above.
const localizeAnnotationTable = (table: AnnotationEntry[], lang: string): AnnotationEntry[] => {
    return (table || []).map((entry) => {
        const t = (entry.i18n || {})[lang] || {};
        const out: AnnotationEntry = {
            index: entry.index,
            id: entry.id,
            title: t.title || entry.title,
            text: t.text || entry.text,
            scene: entry.scene
        };
        if (t.title && t.title !== entry.title) {
            out.baseTitle = entry.title;
        }
        return out;
    });
};

// The runtime bridge. Kept as a plain string so it is injected verbatim.
//
// The exported viewer keeps its app, camera and annotation state in a private
// module closure, so the bridge reaches them through window.__supersplatViewer,
// published by the engine patch right after the internal Viewer is constructed
// (well before the splat finishes loading; see isLoaded() below).
//
// Navigation reuses the viewer's own path: calling viewer.selectAnnotation(index)
// shows the annotation's tooltip and makes the camera manager switch to orbit
// and fly to the baked pose -- the same call the UI's prev/next chevrons,
// hotspot clicks and deselect-on-click all make, and which the portals
// companion separately observes to swap portal scene. So a cross-scene jump
// needs nothing here beyond calling it.
//
// selectAnnotation throws until the viewer has finished loading (state.loaded);
// see isLoaded() below. The baked table's `index` is the join key into
// global.settings.annotations, passed straight to selectAnnotation.
//
// NOTE: this is a template literal -- backslash escapes are consumed at build
// time. String operations only: no regex literals, no escape sequences.
const companionRuntime = `
(function () {
  var resolveAnnotationRef = ${resolveAnnotationRef.toString()};
  var localizeAnnotationTable = ${localizeAnnotationTable.toString()};
  var table = localizeAnnotationTable(window.__supersplatIframeApi || [], window.__ssLang || 'en');

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

  function getGlobal() {
    var v = getViewer();
    return (v && v.global) || null;
  }

  function getEvents() {
    var g = getGlobal();
    return (g && g.events) || null;
  }

  // The real signal that navigation can do anything. supersplat-viewer >= 1.32
  // publishes its handle at construction, long before the splat loads, and its
  // selectAnnotation throws until state.loaded (requireLoaded). Checked live
  // everywhere it matters (not cached), so a request arriving after a slow but
  // real load finally finishes still succeeds.
  function isLoaded() {
    var g = getGlobal();
    return !!(g && g.state && g.state.loaded);
  }

  // ?noui (config.ui === false): navigation stays reported as unavailable, as it
  // was on viewers <= 1.31, where noui skipped the annotation UI entirely. It is
  // detected directly so a noui host gets an immediate readiness signal.
  function isNoUi() {
    var g = getGlobal();
    return !!(g && g.config && g.config.ui === false);
  }

  // The viewer's own annotation array, in the same order as the export table.
  function liveAnnotations() {
    var g = getGlobal();
    var list = g && g.settings && g.settings.annotations;
    return (list && list.length) ? list : null;
  }

  function doGoto(req) {
    var res = resolveAnnotationRef(table, req.ref);
    if (res.index < 0) {
      post(req.source, req.origin, { type: 'supersplat:annotation.goto.result', requestId: req.requestId, ok: false, reason: res.reason });
      return;
    }
    // Navigation only works once the viewer has loaded; checked here
    // regardless of how ready became true (a real load completing, the
    // watchdog backstop, or noui), so a premature or permanently-unavailable
    // request reports honestly instead of calling into a viewer that would
    // throw, or claiming ok: true when nothing happened.
    var v = getViewer();
    var list = liveAnnotations();
    if (!isLoaded() || isNoUi() || !v || typeof v.selectAnnotation !== 'function' || !list || !list[res.index]) {
      post(req.source, req.origin, { type: 'supersplat:annotation.goto.result', requestId: req.requestId, ok: false, reason: 'unavailable' });
      return;
    }
    try {
      v.selectAnnotation(res.index);
    } catch (err) {
      post(req.source, req.origin, { type: 'supersplat:annotation.goto.result', requestId: req.requestId, ok: false, reason: 'unavailable' });
      return;
    }
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
      // Every selection -- a host goto, a hotspot click, the viewer's own
      // prev/next chevrons, a deselecting click -- goes through the internal
      // Viewer's selectAnnotation (the UI calls it through the public handle,
      // which looks it up on the instance at call time). Wrapping it, rather
      // than listening to selectedAnnotation:changed, keeps the old
      // "activated on every activation" contract: re-selecting the current
      // annotation flies the camera but changes no state, so it fires no event.
      //
      // 1.35 keeps state.selectedAnnotation set when only the tooltip is
      // hidden (Show Annotations off, walk/gaming modes, pointer capture), so
      // unlike 1.31 those paths send no deactivated here either -- the bridge
      // deliberately mirrors the viewer's own selection state rather than its
      // tooltip visibility, the same thing the viewer's own navigator does.
      var v0 = getViewer();
      var original = v0 && v0.selectAnnotation;
      if (typeof original === 'function') {
        v0.selectAnnotation = function (index) {
          var result = original.apply(this, arguments);
          if (index === null || index === undefined) {
            notify({ type: 'supersplat:annotation.deactivated' });
          } else {
            var entry = table[index] || null;
            if (entry) {
              notify({ type: 'supersplat:annotation.activated', index: entry.index, id: entry.id, title: entry.title, scene: entry.scene });
            }
          }
          return result;
        };
      }
      // Ready-gate watchdog, mirroring the portals companion's ready-gate
      // watchdog (src/viewer-companion/portals.ts). getEvents() above resolves
      // as soon as the viewer publishes its handle -- long before the splat
      // finishes loading -- so it is not a safe readiness signal on its own;
      // see isLoaded()/isNoUi() below, which are. Without a bound, a load that
      // never finishes (or a bug in that detection) would strand every queued
      // goto/list request forever and keep this rAF loop ticking every frame
      // indefinitely. ~15s grace mirrors the portals watchdog's cadence; after
      // that this is purely a backstop -- it reports readiness honestly
      // (ping/list still answer fine before the viewer has loaded) but never
      // manufactures a successful goto, since doGoto checks isLoaded() itself
      // regardless of how ready became true.
      var watchdogTicks = 0;
      var watchdogTimer = setInterval(function () {
        if (ready) { clearInterval(watchdogTimer); return; }
        watchdogTicks++;
        if (watchdogTicks < 3) { return; }
        clearInterval(watchdogTimer);
        onReady();
      }, 5000);
    }
    // The real navigation-ready signal (see isLoaded() above). state.loaded
    // still flips true under ?noui -- firstFrame sets it with no dependency
    // on the UI -- so isLoaded() alone would eventually go true there too.
    // isNoUi() is checked directly anyway so a noui host gets an immediate
    // readiness signal instead of waiting on a load it has no UI reason to
    // wait for; doGoto() then separately keeps isNoUi() in its own gate (see
    // above) so navigation itself stays unavailable there, matching <= 1.31.
    if (isLoaded() || isNoUi()) { onReady(); return; }
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

export { buildAnnotationIndex, buildIframeApiInjection, localizeAnnotationTable, resolveAnnotationRef };
export type { AnnotationEntry, AnnotationRef, AnyAnnotation };
