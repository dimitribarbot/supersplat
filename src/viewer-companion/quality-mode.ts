// Quality-mode companion for the exported viewer.
//
// Gives the viewer three modes (Performance / Normal / HD) chosen from a device
// capability class rather than the stock mobile/desktop user-agent split, and
// corrects a wrong guess downward with a passive frame-time watchdog.
//
// Injected into EVERY export as a classic <script>, so it executes at parse
// time -- BEFORE the deferred <script type="module"> bootstrap calls main().
// That ordering is load-bearing: the stock viewer reads
// localStorage.performanceMode synchronously while building its state, so the
// mode must be resolved before then. It is also why the heuristic is
// synchronous: WebGPU adapter.info would be a better mobile signal but needs an
// async requestAdapter().
//
// The engine patch in viewer-engine-patch.ts reads the three globals published
// here; all decision logic lives in ../quality-tier (unit-tested) and is
// stringified in verbatim via Function.toString().
//
// state.performanceMode keeps its exact stock meaning -- "is Performance mode",
// false for BOTH Normal and HD -- so the viewer's resolution scale (0.5),
// colorUpdateAngle (4/2), its own persistence, and the portals companion's
// existing performanceMode:changed listener all keep working untouched.
//
// Authoring constraints (the runtime body is a template literal baked
// verbatim): NO backslash escapes of any kind, including inside comments (they
// are cooked away at build time -- the residentBudget override once shipped as
// a permanently dead regex that way), and ES5 only.

import { pickQualityClass, pickAutoMode, hdBudgetFor, demoteQuality, resolveQualityMode, classifyFpsWindow } from '../quality-tier';

// Quality dropdown styling. A segmented control was tried first and dropped:
// showing all three labels at once made the row -- and so the whole settings
// panel -- as wide as "Perf + Normal + HD" plus padding, which pushed the
// panel to the screen edge on a phone. A dropdown shows one label, so the
// closed control is a small fraction of that width, and the freed space
// carries a one-line description per mode instead of jargon abbreviations.
//
// Unlike the old segmented control this restates the viewer's own palette
// explicitly (accent #F60, panel text #E0DCDD, dim text #AAA, the 4%/10%
// white control surfaces, the 34px control height) rather than inheriting
// it, because the popup floats above the panel on its own surface.
//
// Two rules are scoped through #settingsPanel > .settingsRow > div.ssQ
// rather than a bare .ssQ class. The viewer's own (separately loaded)
// stylesheet already targets #settingsPanel > .settingsRow > div at
// specificity (1,1,1), with padding: 0 8px and color: #AAA, which beats any
// plain class selector. Left alone, that padding would land on the wrapper
// and throw off the trigger's position -- so this one selector is written
// with the same id-scoped prefix to win. The 34px height that same stock
// rule sets is left standing; it is exactly the control height wanted here.
// The trigger button itself is a GRANDCHILD of the row (wrapped inside
// .ssQ), never a direct child, so the stock #settingsPanel > .settingsRow >
// button rule (flex-grow: 1; padding: 0 20px) never matches it at all --
// nothing needs to fight that one. Everything else below (the trigger, the
// popup, its items, the dot, the caret) has no such collision and stays a
// plain class selector.
const companionStyle = `
#settingsPanel > .settingsRow > div.ssQ { padding: 0; position: relative; }

.ssQRow { display: flex; align-items: center; justify-content: space-between; gap: 12px; }

.ssQ-trig { display: flex; align-items: center; gap: 6px; height: 34px; padding: 0 8px; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; background-color: rgba(255,255,255,0.04); color: #AAA; font-size: 13px; white-space: nowrap; cursor: pointer; transition: background-color 250ms ease, color 250ms ease; }
.ssQ-trig:hover { background-color: rgba(255,255,255,0.1); color: #E0DCDD; }

.ssQ-dot { width: 6px; height: 6px; border-radius: 50%; background-color: rgba(255,102,0,0.45); flex: 0 0 auto; }
.ssQ-lvl1 .ssQ-dot, .ssQ-lvl2 .ssQ-dot { background-color: #F60; }

.ssQ-val { flex: 0 1 auto; }

.ssQ-car { width: 0; height: 0; flex: 0 0 auto; border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 5px solid currentColor; transition: transform 200ms ease; }
.ssQ-trig[aria-expanded="true"] .ssQ-car { transform: rotate(180deg); }

.ssQ-pop { position: absolute; right: 0; top: auto; bottom: calc(100% + 5px); z-index: 20; min-width: 200px; display: flex; flex-direction: column; gap: 2px; padding: 6px; background-color: rgba(68,68,68,0.95); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; box-shadow: 0 14px 32px rgba(0,0,0,0.5); opacity: 0; visibility: hidden; pointer-events: none; transform: translateY(6px); transition: opacity 200ms ease, transform 200ms ease, visibility 200ms ease; }
.ssQ-pop.ssQ-open { opacity: 1; visibility: visible; pointer-events: auto; transform: translateY(0); }

.ssQ-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; padding: 6px 8px; border: 0; border-radius: 6px; background-color: transparent; color: #E0DCDD; font-size: 13px; text-align: left; cursor: pointer; transition: background-color 250ms ease, color 250ms ease; }
.ssQ-item:hover { background-color: rgba(255,255,255,0.1); }
.ssQ-item + .ssQ-item { border-top: 1px solid rgba(255,255,255,0.08); }

.ssQ-label { display: flex; flex-direction: column; gap: 2px; }
.ssQ-item strong { color: #AAA; font-weight: 600; }
.ssQ-item[aria-checked="true"] strong { color: #F60; }
.ssQ-desc { color: #AAA; font-size: 11px; }

.ssQ-check { position: relative; width: 10px; height: 10px; flex: 0 0 auto; }
.ssQ-check::after { content: ''; position: absolute; left: 2px; top: -1px; width: 5px; height: 8px; border-right: 2px solid #F60; border-bottom: 2px solid #F60; transform: rotate(45deg); opacity: 0; }
.ssQ-item[aria-checked="true"] .ssQ-check::after { opacity: 1; }

@media (pointer: coarse) {
  .ssQ-trig { height: 36px; }
  .ssQ-pop { min-width: 240px; }
  .ssQ-item { min-height: 44px; font-size: 14px; }
  .ssQ-desc { font-size: 12px; }
}
`;

const companionRuntime = `
(function () {
  var pickQualityClass = ${pickQualityClass.toString()};
  var pickAutoMode = ${pickAutoMode.toString()};
  var hdBudgetFor = ${hdBudgetFor.toString()};
  var demoteQuality = ${demoteQuality.toString()};
  var resolveQualityMode = ${resolveQualityMode.toString()};
  var classifyFpsWindow = ${classifyFpsWindow.toString()};

  var KEY_MODE = 'ssQualityMode';
  var KEY_FLOOR = 'ssQualityAutoFloor';
  var KEY_AUTO_CLASS = 'ssQualityAutoClass';
  var KEY_LEGACY = 'performanceMode';

  function readStore(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function writeStore(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { }
  }
  function removeStore(key) {
    try { localStorage.removeItem(key); } catch (e) { }
  }

  // Mobile detection, mirroring the viewer's own platform split and the
  // portals companion's IS_MOBILE (iPadOS reports as Mac + multi-touch).
  var isMobile = (function () {
    try {
      var ua = navigator.userAgent || '';
      if (/android|iphone|ipad|ipod|windows phone|mobile/i.test(ua)) { return true; }
      return ((navigator.maxTouchPoints || 0) > 1 && /mac/i.test(navigator.platform || ''));
    } catch (e) { return false; }
  })();

  // Unmasked GPU renderer string from a throwaway context. Lowercased here so
  // every rule downstream is a plain indexOf.
  function readGpu() {
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) { return ''; }
      var ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (!ext) { return ''; }
      var r = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
      return (typeof r === 'string') ? r.toLowerCase() : '';
    } catch (e) { return ''; }
  }

  var signals = {
    isMobile: isMobile,
    cores: (function () { try { return navigator.hardwareConcurrency || 0; } catch (e) { return 0; } })(),
    memGb: (function () { try { return navigator.deviceMemory || 0; } catch (e) { return 0; } })(),
    gpu: readGpu()
  };

  var qualityClass = pickQualityClass(signals);
  // Kept aside, before the stored auto-class override below is applied, so a
  // later MANUAL pick can revert to the heuristic's own answer -- see
  // __ssQualityApply's isManual branch.
  var heuristicClass = qualityClass;
  // A prior session's watchdog may have measured this device as too weak for
  // its heuristic class (see demoteQuality below). That is a measurement of
  // the DEVICE itself, not a mode preference, so -- unlike the mode floor
  // below, which only applies on the 'auto' path -- honour it unconditionally
  // and BEFORE pickAutoMode runs, so the auto-picked mode also drops to perf.
  // A manual pick clears this override immediately (see __ssQualityApply): a
  // deliberate mode choice already pins the mode and switches the watchdog
  // off, so the stored auto-correction is dead weight from that point on --
  // and leaving it in place would silently cap an explicit HD pick at the
  // weak budget.
  if (readStore(KEY_AUTO_CLASS) === 'weak') { qualityClass = 'weak'; }
  var autoMode = pickAutoMode(signals, qualityClass);
  // isMobile is passed so a legacy performanceMode equal to the stock platform
  // default is NOT mistaken for a deliberate user choice (see resolveQualityMode).
  var resolved = resolveQualityMode(readStore(KEY_MODE), readStore(KEY_LEGACY), readStore(KEY_FLOOR), autoMode, isMobile);

  if (resolved.write) { writeStore(KEY_MODE, resolved.write); }

  var pinned = resolved.pinned;

  // Publish the globals the engine patch reads, and seed the stock viewer's own
  // key so the state default it builds a moment from now lands on the right
  // boolean. performanceMode means "is Performance mode": false for BOTH
  // Normal and HD.
  function publish(mode) {
    window.__ssQualityMode = mode;
    window.__ssQualityClass = qualityClass;
    window.__ssHdBudget = hdBudgetFor(qualityClass, isMobile);
    writeStore(KEY_LEGACY, String(mode === 'perf'));
  }
  publish(resolved.mode);

  function getViewer() { return window.__supersplatViewer || null; }
  function getGlobal() { var v = getViewer(); return (v && v.global) || null; }

  // Apply a mode (and optionally a device class) at runtime. Setting
  // state.performanceMode fires performanceMode:changed through the viewer's
  // observe() proxy, which re-runs applyPerfSettings; for Normal <-> HD the
  // boolean does not move, so the event is fired manually -- and now also
  // when only the CLASS changed, because a perf -> perf@weak watchdog step
  // leaves the mode identical too and would otherwise never re-apply the new
  // (lower) HD budget. Exactly one of the two paths fires, never both.
  // Existing 2-arg callers (a manual pick from the settings-panel dropdown)
  // keep working unchanged: cls is undefined, so qualityClass is left untouched.
  window.__ssQualityApply = function (mode, isManual, cls) {
    if (mode !== 'perf' && mode !== 'normal' && mode !== 'hd') { return; }
    var prev = window.__ssQualityMode;
    var prevClass = qualityClass;
    if (isManual) {
      // A manual pick already pins the mode and switches the watchdog off,
      // so any persisted auto-correction is dead weight -- and leaving it in
      // place would silently cap an explicit HD pick at the weak budget.
      // Wipe both keys and revert to the heuristic's own class immediately,
      // in THIS session (not only after a reload), before publish() runs so
      // the republished globals below already reflect it.
      removeStore(KEY_FLOOR);
      removeStore(KEY_AUTO_CLASS);
      qualityClass = heuristicClass;
    } else if (cls && cls !== qualityClass) {
      qualityClass = cls;
    }
    publish(mode);
    if (isManual) {
      pinned = true;
      writeStore(KEY_MODE, mode);
    }
    var g = getGlobal();
    if (!g || !g.state) { return; }
    var wantPerf = (mode === 'perf');
    if (g.state.performanceMode !== wantPerf) {
      g.state.performanceMode = wantPerf;         // observe() fires the event
    } else if ((prev !== mode || prevClass !== qualityClass) && g.events) {
      g.events.fire('performanceMode:changed');   // normal <-> hd, or class-only change
    }
    if (window.__ssQualityOnChange) { window.__ssQualityOnChange(mode, pinned); }
  };
  window.__ssQualityPinned = function () { return pinned; };

  // --- settings panel: replace the stock Performance Mode toggle ----------
  // The perf label is abbreviated wherever the full word was setting the width
  // of the whole settings panel -- the trigger only shows one label at a time
  // now, but it is still sized to it, and the unabbreviated en/fr/es/pt/ru
  // words pushed the modal past the screen edge on a phone. Locales whose word
  // is already short (de, ko, zh) keep it; only the long ones are cut. A test
  // asserts each shortened label is present and its long form is gone.
  //
  // The "d" field is a one-line description per mode shown in the dropdown popup, so
  // "Perf / Normal / HD" is no longer the only thing explaining what a mode
  // does. Kept short -- it sets the popup width -- and literal UTF-8, never
  // unicode escapes.
  var LABELS = {
    en: { q: 'Quality', perf: 'Perf', normal: 'Normal', hd: 'HD',
      d: { perf: 'Smooth on mobile and older GPUs', normal: 'Balance of sharpness and speed', hd: 'Maximum detail, may run slower' } },
    de: { q: 'Qualität', perf: 'Leistung', normal: 'Normal', hd: 'HD',
      d: { perf: 'Flüssig auf Mobilgeräten und alten GPUs', normal: 'Ausgewogen zwischen Schärfe und Tempo', hd: 'Maximale Details, kann langsamer sein' } },
    es: { q: 'Calidad', perf: 'Rend.', normal: 'Normal', hd: 'HD',
      d: { perf: 'Fluido en móviles y GPU antiguas', normal: 'Equilibrio entre nitidez y fluidez', hd: 'Máximo detalle, puede ir más lento' } },
    fr: { q: 'Qualité', perf: 'Perf', normal: 'Normal', hd: 'HD',
      d: { perf: 'Fluide sur mobile et vieux GPU', normal: 'Équilibre netteté / fluidité', hd: 'Détail maximal, peut ralentir' } },
    ja: { q: '画質', perf: '性能', normal: '標準', hd: 'HD',
      d: { perf: 'モバイルや旧GPUでも滑らか', normal: '画質と滑らかさのバランス', hd: '最高画質、動作が重くなる場合あり' } },
    ko: { q: '품질', perf: '성능', normal: '보통', hd: 'HD',
      d: { perf: '모바일과 구형 GPU에서 부드럽게', normal: '선명함과 부드러움의 균형', hd: '최대 디테일, 느려질 수 있음' } },
    pt: { q: 'Qualidade', perf: 'Desemp.', normal: 'Normal', hd: 'HD',
      d: { perf: 'Fluido em celulares e GPUs antigas', normal: 'Equilíbrio entre nitidez e fluidez', hd: 'Detalhe máximo, pode ficar mais lento' } },
    ru: { q: 'Качество', perf: 'Произв.', normal: 'Обычное', hd: 'HD',
      d: { perf: 'Плавно на мобильных и старых GPU', normal: 'Баланс четкости и плавности', hd: 'Максимум деталей, может тормозить' } },
    zh: { q: '画质', perf: '性能', normal: '标准', hd: 'HD',
      d: { perf: '在手机和旧显卡上流畅运行', normal: '清晰度与流畅度的平衡', hd: '最高画质，可能运行较慢' } }
  };
  function labels() {
    var l = (navigator.language || 'en').toLowerCase();
    return LABELS[l] || LABELS[l.split('-')[0]] || LABELS.en;
  }

  // order is the fixed mode ladder, shared by the paint repaint, the popup's
  // build loop and its arrow-key navigation.
  var order = ['perf', 'normal', 'hd'];
  var wrapEl = null;    // the .ssQ wrapper -- also this module's "is the control built" latch
  var valEl = null;     // .ssQ-val -- the trigger's own current-mode label
  var itemEls = null;   // mode -> popup item button
  var labelsT = null;   // this locale's labels(), cached for repaint

  // Repaints the trigger label, the wrapper's ssQ-lvlN dot class and every
  // item's aria-checked (which alone drives the checkmark and the accented
  // <strong> via CSS). Called on initial build AND from __ssQualityOnChange,
  // so a watchdog auto-demotion (which never touches the DOM directly) is
  // reflected here too -- all three repainted pieces, every time.
  function paint(mode) {
    if (!wrapEl) { return; }
    var idx = order.indexOf(mode);
    if (idx < 0) { idx = 1; }
    wrapEl.className = 'ssQ ssQ-lvl' + idx;
    if (valEl && labelsT) { valEl.textContent = labelsT[mode] || mode; }
    for (var k = 0; k < order.length; k++) {
      var m = order[k];
      if (itemEls[m]) { itemEls[m].setAttribute('aria-checked', (m === mode) ? 'true' : 'false'); }
    }
  }
  window.__ssQualityOnChange = function (mode) { paint(mode); };

  function buildControl() {
    // Wait for the viewer handle before touching the DOM at all. The settings
    // panel -- #performanceModeRow included -- is STATIC markup in the exported
    // page, present at parse time; initUI() does not build it, it CAPTURES it by
    // id, and it does so only after main()'s awaits (settings fetch, then
    // createApp's WebGPU adapter). The handle is published immediately after
    // main() RESOLVES, so its presence proves the capture already happened.
    // Replacing the row any earlier strips the id initUI looks up, which makes
    // dom.performanceModeRow undefined, throws inside initUI, rejects main() and
    // takes the whole viewer down with it -- device fallback, portals and the
    // iframe API included.
    if (!getViewer()) { return false; }
    var row = document.getElementById('performanceModeRow');
    if (!row || wrapEl) { return !!wrapEl; }
    var t = labels();
    labelsT = { perf: t.perf, normal: t.normal, hd: t.hd };
    // Clone-replace rather than rewrite innerHTML: the stock click listener is
    // bound to the ROW element, so keeping it would flip performanceMode on
    // every click inside the new control. Cloning drops all listeners. The
    // stock code retains a stale performanceModeCheck reference afterwards,
    // which then points at a detached node -- its classList.toggle is a
    // harmless no-op.
    var fresh = row.cloneNode(false);
    fresh.className = 'settingsRow ssQRow';
    fresh.removeAttribute('id');
    var label = document.createElement('div');
    label.textContent = t.q;
    fresh.appendChild(label);

    // .ssQ is the dropdown wrapper. It is matched by the stock #settingsPanel
    // > .settingsRow > div rule (see the companionStyle comment above), which
    // is neutralised by the id-scoped override there; everything inside it
    // (the trigger button, the popup and its items) is a GRANDCHILD of the
    // row or deeper, so the stock ...> button rule never reaches the trigger.
    var wrap = document.createElement('div');
    wrap.className = 'ssQ';

    var trig = document.createElement('button');
    trig.type = 'button';
    trig.className = 'ssQ-trig';
    trig.setAttribute('aria-haspopup', 'true');
    trig.setAttribute('aria-expanded', 'false');

    var dot = document.createElement('span');
    dot.className = 'ssQ-dot';
    trig.appendChild(dot);

    var val = document.createElement('span');
    val.className = 'ssQ-val';
    trig.appendChild(val);

    var car = document.createElement('span');
    car.className = 'ssQ-car';
    trig.appendChild(car);

    wrap.appendChild(trig);

    var pop = document.createElement('div');
    pop.className = 'ssQ-pop';
    pop.setAttribute('role', 'menu');

    itemEls = {};
    for (var i = 0; i < order.length; i++) {
      (function (mode) {
        var item = document.createElement('button');
        item.type = 'button';
        item.className = 'ssQ-item';
        item.setAttribute('role', 'menuitemradio');
        item.setAttribute('aria-checked', 'false');

        var lbl = document.createElement('span');
        lbl.className = 'ssQ-label';

        var strong = document.createElement('strong');
        strong.textContent = t[mode];
        lbl.appendChild(strong);

        var desc = document.createElement('span');
        desc.className = 'ssQ-desc';
        desc.textContent = (t.d && t.d[mode]) || '';
        lbl.appendChild(desc);

        item.appendChild(lbl);

        var check = document.createElement('span');
        check.className = 'ssQ-check';
        item.appendChild(check);

        // A manual pick routes through __ssQualityApply(mode, true) exactly
        // once -- same entry point the old segmented control used -- which
        // already pins the mode, disables the watchdog and clears the stored
        // auto-corrections. Close and return focus to the trigger afterwards.
        item.addEventListener('click', function (ev) {
          ev.stopPropagation();
          window.__ssQualityApply(mode, true);
          closePopup();
          trig.focus();
        });

        pop.appendChild(item);
        itemEls[mode] = item;
      })(order[i]);
    }

    wrap.appendChild(pop);
    fresh.appendChild(wrap);
    row.parentNode.replaceChild(fresh, row);

    wrapEl = wrap;
    valEl = val;

    function isOpen() { return pop.className.indexOf('ssQ-open') !== -1; }
    function openPopup() {
      pop.className = 'ssQ-pop ssQ-open';
      trig.setAttribute('aria-expanded', 'true');
    }
    function closePopup() {
      pop.className = 'ssQ-pop';
      trig.setAttribute('aria-expanded', 'false');
    }

    // stopPropagation matters here: this click also bubbles to the document
    // listener below, which would otherwise immediately close what this
    // handler just opened.
    trig.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (isOpen()) { closePopup(); } else { openPopup(); }
    });

    // Escape closes and returns focus to the trigger. Arrow Up/Down move
    // between items while the popup is open. Enter/Space on the trigger
    // opens it via the native <button> click behaviour -- no extra handling
    // needed for that part.
    wrap.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        if (isOpen()) {
          ev.preventDefault();
          closePopup();
          trig.focus();
        }
        return;
      }
      if (!isOpen()) { return; }
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        var active = document.activeElement;
        var idx = -1;
        for (var k = 0; k < order.length; k++) {
          if (itemEls[order[k]] === active) { idx = k; break; }
        }
        if (idx === -1) {
          idx = 0;
        } else if (ev.key === 'ArrowDown') {
          idx = (idx + 1) % order.length;
        } else {
          idx = (idx - 1 + order.length) % order.length;
        }
        itemEls[order[idx]].focus();
      }
    });

    // A click anywhere outside the control closes it.
    document.addEventListener('click', function (ev) {
      if (!wrapEl || wrapEl.contains(ev.target)) { return; }
      closePopup();
    });

    paint(window.__ssQualityMode);
    return true;
  }

  // The settings panel is static markup in the exported page; initUI() merely
  // captures it by id, after main()'s awaits. So poll for the VIEWER HANDLE the
  // way device-fallback does -- the handle appears only once main() has
  // resolved, which guarantees the replacement can never precede that capture.
  // 240 tries x 500ms = 2 minutes, then give up (the stock toggle simply stays).
  var uiTries = 0;
  var uiTimer = setInterval(function () {
    uiTries++;
    if (buildControl() || uiTries > 240) { clearInterval(uiTimer); }
  }, 500);

  // --- demote-only frame-time watchdog -----------------------------------
  // Corrects a wrong heuristic guess downward by counting 'frameend' events
  // over a rolling window and comparing the observed rate to a floor.
  //
  // app.autoRender = false (set at the ready gate) only gates app.render();
  // in the engine's frame loop this.fire('frameend') sits OUTSIDE that
  // check, so it fires on every requestAnimationFrame tick regardless -- a
  // still camera still produces frameend events, just cheap ones. That is
  // what makes a passive frame COUNTER work here: an idle device reads close
  // to its display refresh rate (60fps, comfortably above WD_MIN_FPS, no
  // demotion), while a device that is genuinely struggling reads its true,
  // low rate even while the camera happens to be still.
  //
  // A window that mixes idle ticks with camera-driven rendering averages
  // toward "healthy" -- a run of cheap idle ticks outweighs a handful of
  // laggy rendered ones in the same window -- so a verdict still needs
  // SUSTAINED interaction to be trustworthy. That is the same behaviour the
  // previous per-frame-delta sampler had, and it is intentional: a user who
  // barely moved the camera has not demonstrated a problem.
  //
  // Demote-only on purpose: promoting mid-session raises the budget, which
  // makes the engine stream finer LOD (visible pop-in plus a portal pin
  // reconcile). Demoting makes things lighter, which is what a struggling
  // device wants, and one-way makes oscillation impossible.
  // Three of these run back to back before a device that needs two steps reaches
  // its floor -- arm delay, window, settle, window -- so each one is paid twice
  // over on the devices in the most trouble. They were all 3000ms, which meant
  // 9s of waiting after the arm message on a phone that needed the full ladder.
  // WD_SETTLE_MS was also doing double duty as the arm delay despite the two
  // having nothing to do with each other; they are separate constants now.
  var WD_ARM_DELAY_MS = 2000;    // firstFrame -> arm: let initial streaming decode drain
  var WD_SETTLE_MS = 1000;       // after a demotion: skip the budget-change transient
  var WD_WINDOW_MS = 2000;       // count frameend ticks over this span before judging
  var WD_MIN_FPS = 30;           // below this over the window -> demote
  var WD_MAX_WINDOW_MS = 10000;  // window open this long without closing -> interrupted, discard
  var WD_MAX_DEMOTIONS = 3;      // hd -> normal -> perf -> perf@weak
  var WD_FALLBACK_MS = 30000;    // see the readyTimer block below

  var wdFrameCount = 0;
  var wdWindowStart = 0;   // performance.now() the current window opened; 0 = not open yet
  var wdArmed = false;
  var wdDemotions = 0;
  var wdSettleUntil = 0;   // counting is suspended until this timestamp
  // Set ONLY inside the real firstFrame listener below (never inside the
  // fallback setTimeout), so it reflects the ready-gate signal itself and not
  // how the watchdog happened to arm. Gates whether a demotion PERSISTS --
  // see the frameend handler.
  var wdFirstFrameSeen = false;

  // A hidden tab fires no requestAnimationFrame ticks at all, so a window
  // simply stalls while backgrounded rather than accumulating bad data --
  // but the check still has to happen on THIS transition, not inside the
  // frameend handler, or the first tick after resuming would see a huge
  // elapsed (spanning the whole backgrounded gap) against almost no frames,
  // which reads as a spuriously low fps and would trigger a false demotion.
  // WD_MAX_WINDOW_MS stays as a backstop for throttling this event does not
  // cover (e.g. sustained background CPU contention without a visibility
  // change).
  document.addEventListener('visibilitychange', function () {
    wdFrameCount = 0;
    wdWindowStart = 0;
  });

  function armWatchdog() {
    if (wdArmed || window.__ssQualityPinned()) { return; }
    var g = getGlobal();
    if (!g || !g.app || !g.app.on) { return; }
    // A demotion that would change nothing means the device is already at the
    // floor -- attaching a per-frame callback that can never lead to an action
    // would cost exactly the devices that can least afford it. Settle arming
    // WITHOUT registering the listener. wdArmed is still set here: it stops
    // meaning "a listener is attached" and starts meaning "arming has been
    // decided", which is what stops the readyTimer interval below from
    // retrying armWatchdog() every 500ms for the next five minutes.
    var floor = demoteQuality(window.__ssQualityMode, window.__ssQualityClass);
    if (floor.mode === window.__ssQualityMode && floor.cls === window.__ssQualityClass) {
      wdArmed = true;
      console.info('[quality] watchdog not arming -- already at floor (mode=' + window.__ssQualityMode + ', class=' + window.__ssQualityClass + ')');
      return;
    }
    wdArmed = true;
    wdFrameCount = 0;
    wdWindowStart = 0;
    console.info('[quality] watchdog armed via ' + (wdFirstFrameSeen ? 'firstFrame' : 'fallback timer') +
      ' (mode=' + window.__ssQualityMode + ', class=' + window.__ssQualityClass + ')');
    g.app.on('frameend', function () {
      if (window.__ssQualityPinned() || wdDemotions >= WD_MAX_DEMOTIONS) { return; }
      var now = (window.performance && window.performance.now) ? window.performance.now() : Date.now();
      // post-demotion settle: the budget change re-streams LOD, so those frames
      // say nothing about steady-state cost -- restart the window rather than
      // counting through it
      if (wdSettleUntil && Date.now() < wdSettleUntil) { wdFrameCount = 0; wdWindowStart = now; return; }
      if (!wdWindowStart) { wdWindowStart = now; }
      wdFrameCount++;
      var elapsed = now - wdWindowStart;
      var verdict = classifyFpsWindow(wdFrameCount, elapsed, WD_MIN_FPS, WD_WINDOW_MS, WD_MAX_WINDOW_MS);
      if (verdict === 'wait') { return; }
      if (verdict === 'reset' || verdict === 'ok') {
        wdFrameCount = 0;
        wdWindowStart = now;
        return;
      }
      // verdict === 'demote'
      var fps = wdFrameCount * 1000 / elapsed;
      var curMode = window.__ssQualityMode;
      var curClass = window.__ssQualityClass;
      var next = demoteQuality(curMode, curClass);
      wdFrameCount = 0;
      wdWindowStart = now;
      if (next.mode === curMode && next.cls === curClass) {
        wdDemotions = WD_MAX_DEMOTIONS;
        console.info('[quality] watchdog at floor -- nothing left to demote (mode=' + curMode + ', class=' + curClass + ')');
        return;
      }
      wdDemotions++;
      console.info('[quality] watchdog demoting ' + curMode + ' -> ' + next.mode +
        (next.cls !== curClass ? ' (class ' + curClass + ' -> ' + next.cls + ')' : '') +
        ' (' + fps.toFixed(1) + 'fps over ' + Math.round(elapsed) + 'ms)' +
        (wdFirstFrameSeen ? '' : ' (session only -- ready gate never fired)'));
      // Acting on a demotion taken before firstFrame ever fired is still
      // correct -- a device stuck mid-load genuinely benefits from a lower
      // budget -- but REMEMBERING it is not: the reading may say more about
      // the load than about the device, so only persist once the real
      // ready-gate signal has actually been seen (see wdFirstFrameSeen above).
      if (wdFirstFrameSeen) {
        writeStore(KEY_FLOOR, next.mode);
        // Only write when the class itself changed: readStore(KEY_AUTO_CLASS)
        // is only ever compared against 'weak', so a 'standard' write here
        // (ladder steps 1 and 2) is inert -- writing only on change keeps the
        // key reading as the 'weak' latch it actually is.
        if (next.cls !== curClass) { writeStore(KEY_AUTO_CLASS, next.cls); }
      }
      window.__ssQualityApply(next.mode, false, next.cls);
      wdSettleUntil = Date.now() + WD_SETTLE_MS;
    });
  }

  // firstFrame is the viewer's initial-load-done signal; give streaming decode a
  // settle window past it before believing any frame time. firstFrame is NOT
  // reliable, though: an upstream engine ready-gate race can retain a pending
  // octree entry forever (see the ready-gate watchdog in portals.ts, around
  // its "engine ready-gate watchdog" comment), so world.pendingLoadCount never
  // reaches 0, the viewer's ready gate never fires, and firstFrame never fires
  // with it. That happens on cold/slow loads -- exactly the struggling devices
  // this watchdog exists to correct -- so a device stuck in that race would
  // otherwise never get a demotion. Add a bounded fallback (matching the ~30s
  // convention portals.ts already uses for the same race) that arms anyway.
  // Arming mid-load is intentional, not incidental. A frame counter has no
  // per-sample discard cap to blind it the way the old delta sampler had --
  // sustained streaming/decode stalls simply hold the count down for the
  // window they occur in, same as any other slow rendering would. So on a
  // long cold load, a fallback arm CAN see a real demotion-worthy window
  // well before firstFrame ever fires. Acting on it is still correct: a
  // device stuck mid-load genuinely benefits from a lower budget regardless
  // of why it is slow right now. Remembering it is a different question --
  // see wdFirstFrameSeen and its persistence gate above, which is what keeps
  // a single slow load from permanently capping a capable device.
  var readyTries = 0;
  var wdFallbackAt = 0;
  var readyTimer = setInterval(function () {
    readyTries++;
    var g = getGlobal();
    if (g && g.events && !window.__ssQualityReadyHooked) {
      window.__ssQualityReadyHooked = true;
      wdFallbackAt = Date.now() + WD_FALLBACK_MS;
      g.events.on('firstFrame', function () {
        wdFirstFrameSeen = true;
        setTimeout(armWatchdog, WD_ARM_DELAY_MS);
      });
    }
    var pastFallback = wdFallbackAt && Date.now() > wdFallbackAt;
    if (pastFallback) { armWatchdog(); }
    // Clear on wdArmed, pinned, or the absolute ceiling -- NOT merely on
    // hooking the listener (which happens long before the deadline, and
    // clearing there would stop this interval before a fallback tick could
    // ever run -- the original bug) and NOT on readyTries alone once a
    // deadline is pending (readyTries > 240 is a "give up waiting for the
    // viewer handle" cap; applying it unconditionally would cut off a
    // fallback deadline that lands later than that, on a main() that
    // resolves later than ~90s after parse). A pinned user is added here so
    // the interval stops promptly instead of spinning for the full 240
    // ticks and calling armWatchdog() every tick past the 30s mark for
    // nothing -- armWatchdog() already no-ops for a pinned user, but that
    // check happening every 500ms for up to two minutes was itself the bug.
    // pastFallback deliberately does NOT terminate the interval: it only
    // triggers the armWatchdog() attempt above. armWatchdog()'s precondition
    // (g.app.on) is strictly stronger than the one that starts this
    // countdown (g.events), so on the tick the deadline is first crossed,
    // g.app.on may not be reachable yet and the attempt can silently no-op.
    // Terminating on pastFallback would give the fallback exactly one try
    // and then disable it for the rest of the page's life -- the same bug
    // this fallback exists to fix, just moved one level down. So once the
    // deadline passes, keep retrying armWatchdog() every 500ms until it
    // actually succeeds (wdArmed). readyTries > 600 (~5 minutes) is an
    // absolute ceiling so that a page where g.app.on never becomes
    // reachable doesn't spin this interval for the life of the page.
    if (wdArmed || window.__ssQualityPinned() || readyTries > 600 || (!wdFallbackAt && readyTries > 240)) {
      clearInterval(readyTimer);
    }
  }, 500);

  console.info('[quality] class=' + qualityClass + ' mode=' + resolved.mode +
    ' hd=' + window.__ssHdBudget + 'M pinned=' + pinned +
    ' cores=' + signals.cores + ' memGb=' + signals.memGb + ' gpu=' + (signals.gpu || 'unknown'));
})();
`;

// Produce the HTML fragment to inject before </body>. Always injected: every
// export benefits, and unlike the portals/zones injectors this one never
// no-ops.
const buildQualityModeInjection = (): string => {
    return `<style>${companionStyle}</style><script>${companionRuntime}</script>`;
};

export { buildQualityModeInjection };
