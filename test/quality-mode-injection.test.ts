import { describe, it, expect } from 'vitest';

import { buildQualityModeInjection } from '../src/viewer-companion/quality-mode';

describe('buildQualityModeInjection', () => {
    it('emits a classic script so it runs before the deferred module bootstrap', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain('<script>');
        // NOT type="module" -- a module would be deferred past main()
        expect(out).not.toContain('<script type="module">');
    });

    it('publishes the three globals the engine patch reads', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain('__ssQualityMode');
        expect(out).toContain('__ssQualityClass');
        expect(out).toContain('__ssHdBudget');
    });

    it('inlines the pure tier helpers rather than importing them', () => {
        const out = buildQualityModeInjection();
        // stringified via Function.toString() -- the bodies must be present
        expect(out).toContain('swiftshader');
        expect(out).toContain('powervr sgx');
        expect(out).toContain('ssQualityAutoFloor');
    });

    it('uses the documented localStorage keys', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain("'ssQualityMode'");
        expect(out).toContain("'ssQualityAutoFloor'");
        // seeds the stock viewer's own key so its state default lands right
        expect(out).toContain("'performanceMode'");
    });

    it('exposes the apply entry point the UI and watchdog call', () => {
        expect(buildQualityModeInjection()).toContain('__ssQualityApply');
    });

    it('contains no backslash escapes (they are cooked away at build time)', () => {
        // The runtime is authored inside a template literal; any backslash that
        // survives into the emitted text means a regex or escape was used that
        // will silently lose it. See companion-template-no-backslash-escapes.
        expect(buildQualityModeInjection()).not.toContain('\\');
    });

    it('wraps the runtime in an IIFE so nothing leaks to global scope but the published names', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain('(function () {');
        expect(out).toContain('})();');
    });
});

describe('buildQualityModeInjection settings control', () => {
    it('targets the stock performance-mode row', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain('performanceModeRow');
    });

    it('gates the control build on the viewer handle before touching the DOM', () => {
        // #performanceModeRow is static markup that initUI() CAPTURES by id after
        // main()'s awaits. The handle is published only once main() resolves, so
        // waiting for it is what guarantees the capture already happened --
        // replacing the row earlier strips the id and throws inside initUI,
        // killing the whole viewer.
        const out = buildQualityModeInjection();
        expect(out).toContain('function buildControl() {');
        const body = out.slice(out.indexOf('function buildControl() {'));
        const gate = body.indexOf('if (!getViewer()) { return false; }');
        const firstDomRead = body.indexOf('document.getElementById');
        expect(gate).toBeGreaterThan(-1);
        expect(firstDomRead).toBeGreaterThan(gate);
    });

    it('clone-replaces the row so the stock click listener is dropped', () => {
        // Rewriting innerHTML would leave the stock listener bound to the row
        // element itself, which keeps flipping performanceMode on every click.
        const out = buildQualityModeInjection();
        expect(out).toContain('cloneNode');
        expect(out).toContain('replaceChild');
    });

    it('builds a dropdown trigger and a popup with three exclusive items, not a segmented control', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain('ssQ-trig');
        expect(out).toContain('ssQ-pop');
        expect(out).toContain('ssQ-item');
        expect(out).toContain("'perf'");
        expect(out).toContain("'normal'");
        expect(out).toContain("'hd'");
        expect(out).not.toContain('ssQualitySeg');
        expect(out).not.toContain('ssQualityRow');
    });

    it('marks the trigger and popup with the aria roles a menu-button dropdown needs', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain("trig.setAttribute('aria-haspopup', 'true');");
        expect(out).toContain("trig.setAttribute('aria-expanded', 'false');");
        expect(out).toContain("pop.setAttribute('role', 'menu');");
        expect(out).toContain("item.setAttribute('role', 'menuitemradio');");
        expect(out).toContain("item.setAttribute('aria-checked', 'false');");
    });

    it('nests the trigger button inside the .ssQ wrapper rather than directly inside the row', () => {
        // The stock #settingsPanel > .settingsRow > button rule sets flex-grow: 1
        // and padding: 0 20px. If the trigger were a direct child of the row it
        // would be stretched across the whole row width -- exactly what the
        // dropdown exists to avoid. It must be a GRANDCHILD: appended to .ssQ,
        // never appended to the cloned row itself.
        const out = buildQualityModeInjection();
        expect(out).toContain('wrap.appendChild(trig);');
        expect(out).toContain('fresh.appendChild(wrap);');
        expect(out).not.toContain('fresh.appendChild(trig)');
    });

    it('ships labels for the same nine languages as the portals companion', () => {
        const out = buildQualityModeInjection();
        // literal UTF-8, no unicode escapes
        expect(out).toContain('Qualité');
        expect(out).toContain('Qualität');
        expect(out).toContain('Calidad');
        expect(out).toContain('Qualidade');
        expect(out).toContain('Качество');
        expect(out).toContain('画質');
        expect(out).toContain('품질');
        expect(out).toContain('画质');
    });

    it('keeps diacritics in the descriptions rather than stripping them to ASCII', () => {
        const out = buildQualityModeInjection();
        // The authoring rule forbids BACKSLASH escapes, not non-ASCII characters:
        // literal UTF-8 is already used throughout (Qualität, Équilibre, netteté).
        // Stripping accents does not make a string safer, it just misspells it.
        expect(out).toContain('Flüssig auf Mobilgeräten');
        expect(out).toContain('Schärfe');
        expect(out).toContain('móviles');
        expect(out).toContain('Máximo detalle');
        expect(out).toContain('Equilíbrio');
        expect(out).toContain('Detalhe máximo');
    });

    it('abbreviates the Performance segment wherever the full word set the panel width', () => {
        const out = buildQualityModeInjection();
        // A segmented control is only as narrow as its longest label, and these
        // were sizing the entire settings modal on a phone.
        // scoped to the LABEL, not the bare word: the runtime also carries prose
        // comments about the stock "Performance Mode" row it replaces, and a bare
        // not.toContain('Performance') would trip on those instead of on a
        // reverted label.
        expect(out).not.toContain("perf: 'Performance'");
        expect(out).not.toContain("perf: 'Производительность'");
        expect(out).not.toContain("perf: 'Rendimiento'");
        expect(out).not.toContain("perf: 'Desempenho'");
        expect(out).not.toContain("perf: 'パフォーマンス'");
        expect(out).toContain("perf: 'Perf'");
        expect(out).toContain("perf: 'Произв.'");
        expect(out).toContain("perf: 'Rend.'");
        expect(out).toContain("perf: 'Desemp.'");
        // locales whose word was already short keep it
        expect(out).toContain("perf: 'Leistung'");
    });

    it('carries styles for the dropdown trigger, popup and items', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain('<style>');
        expect(out).toContain('.ssQ-trig');
        expect(out).toContain('.ssQ-pop');
        expect(out).toContain('.ssQ-item');
    });

    it('scopes the wrapper override through #settingsPanel to beat the stock (1,1,1) row rule', () => {
        // #settingsPanel > .settingsRow > div is (1,1,1) specificity in the
        // viewer's own stylesheet (padding: 0 8px; color: #AAA; height: 34px)
        // and outranks a plain .ssQ class selector. Left unneutralised, that
        // padding would land on the wrapper and throw off the trigger/popup
        // position, so this one rule must carry the id-scoped prefix to win.
        const out = buildQualityModeInjection();
        expect(out).toContain('#settingsPanel > .settingsRow > div.ssQ { padding: 0; position: relative; }');
        // Nothing else needs it: the trigger is a grandchild of the row (never
        // matched by the stock > button rule) and the popup/items are deeper
        // still, so exactly one id-scoped selector should exist in the sheet.
        const styleOut = out.slice(out.indexOf('<style>'), out.indexOf('</style>'));
        const idScopedCount = styleOut.split('#settingsPanel').length - 1;
        expect(idScopedCount).toBe(1);
    });

    it('anchors the popup upward from the row, with an entrance transform that rises into place', () => {
        // #settingsPanel is position: fixed with bottom: calc(... + 70px), so a
        // downward-opening popup would open into the bottom toolbar. It must
        // open upward (bottom: calc(100% + 5px); top: auto) and rise into
        // place, i.e. START translated down a few px and settle to none.
        const out = buildQualityModeInjection();
        expect(out).toContain('top: auto; bottom: calc(100% + 5px)');
        expect(out).toContain('right: 0');
        expect(out).toContain('transform: translateY(6px)');
        expect(out).toContain('.ssQ-pop.ssQ-open { opacity: 1; visibility: visible; pointer-events: auto; transform: translateY(0); }');
    });

    it('draws the checkmark from two borders on a rotated pseudo-element, not a glyph or SVG', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain('.ssQ-check::after');
        expect(out).toContain('border-right: 2px solid #F60');
        expect(out).toContain('border-bottom: 2px solid #F60');
        expect(out).toContain('rotate(45deg)');
        // shown only on the checked item, whose <strong> also turns accent-coloured
        expect(out).toContain('.ssQ-item[aria-checked="true"] .ssQ-check::after { opacity: 1; }');
        expect(out).toContain('.ssQ-item[aria-checked="true"] strong { color: #F60; }');
    });

    it('carries the touch variant under a pointer:coarse media query rather than a runtime class branch', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain('@media (pointer: coarse)');
        const mediaIdx = out.indexOf('@media (pointer: coarse)');
        const mediaBody = out.slice(mediaIdx, out.indexOf('</style>'));
        expect(mediaBody).toContain('height: 36px');
        expect(mediaBody).toContain('min-height: 44px');
        // never toggled from JS -- no class name that would gate it at runtime
        expect(out).not.toContain('ssQ-touch');
    });
});

describe('buildQualityModeInjection watchdog', () => {
    it('samples real frames rather than forcing renders', () => {
        const out = buildQualityModeInjection();
        // app.autoRender is false after the ready gate, so a still camera draws
        // nothing; forcing frames would burn battery measuring an idle state.
        expect(out).toContain("'frameend'");
        expect(out).not.toContain('renderNextFrame = true');
    });

    it('arms after firstFrame plus its own arm delay, not the post-demotion settle', () => {
        // The two were one constant despite being unrelated: one waits out the
        // initial streaming decode, the other waits out a budget-change
        // transient. Sharing them meant tuning either one moved the other.
        const out = buildQualityModeInjection();
        expect(out).toContain("'firstFrame'");
        expect(out).toContain('setTimeout(armWatchdog, WD_ARM_DELAY_MS)');
        expect(out).not.toContain('setTimeout(armWatchdog, WD_SETTLE_MS)');
    });

    it('carries the documented window-counter constants', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain('WD_ARM_DELAY_MS = 2000');    // firstFrame -> arm
        expect(out).toContain('WD_SETTLE_MS = 1000');       // post-demotion transient
        expect(out).toContain('WD_WINDOW_MS = 2000');       // observation window length
        expect(out).toContain('WD_MIN_FPS = 30');           // demote floor
        expect(out).toContain('WD_MAX_WINDOW_MS = 10000');  // interrupted-window ceiling
    });

    it('keeps the settle strictly shorter than the window it precedes', () => {
        // A device needing two steps pays arm + window + settle + window before
        // it reaches the floor, so the settle is the one phase that can shrink
        // without costing measurement confidence -- a demotion only ever LOWERS
        // the budget, so its transient is eviction, not streaming.
        const out = buildQualityModeInjection();
        const settle = Number(/WD_SETTLE_MS = (\d+)/.exec(out)[1]);
        const window = Number(/WD_WINDOW_MS = (\d+)/.exec(out)[1]);
        expect(settle).toBeLessThan(window);
    });

    it('classifies the window via classifyFpsWindow rather than a sample buffer', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain('classifyFpsWindow(wdFrameCount, elapsed, WD_MIN_FPS, WD_WINDOW_MS, WD_MAX_WINDOW_MS)');
    });

    it('handles all four classifyFpsWindow verdicts in the frameend handler', () => {
        const out = buildQualityModeInjection();
        const fnIdx = out.indexOf('function armWatchdog() {');
        const handlerIdx = out.indexOf("g.app.on('frameend'", fnIdx);
        const body = out.slice(handlerIdx, out.indexOf('    });', handlerIdx));
        expect(body).toContain("if (verdict === 'wait') { return; }");
        expect(body).toContain("if (verdict === 'reset' || verdict === 'ok') {");
        expect(body).toContain('var next = demoteQuality(curMode, curClass);');
    });

    it('resets the window on a visibilitychange transition rather than inside the frameend handler', () => {
        // A hidden tab fires no requestAnimationFrame ticks at all, so the check
        // must happen on this transition -- doing it inside frameend would let
        // the resumed tick see a huge elapsed against almost no frames.
        const out = buildQualityModeInjection();
        expect(out).toContain("document.addEventListener('visibilitychange', function () {");
        const idx = out.indexOf("document.addEventListener('visibilitychange', function () {");
        const body = out.slice(idx, out.indexOf('});', idx));
        expect(body).toContain('wdFrameCount = 0;');
        expect(body).toContain('wdWindowStart = 0;');
        expect(out).not.toContain('document.hidden');
    });

    it('persists the demoted tier so a return visit starts there', () => {
        expect(buildQualityModeInjection()).toContain('writeStore(KEY_FLOOR, next.mode)');
    });

    it('reports the measured rate and window as the demotion log evidence, not a sample count', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain("fps.toFixed(1) + 'fps over ' + Math.round(elapsed) + 'ms)'");
        expect(out).not.toContain('samples over');
        expect(out).not.toContain('sampleCount');
        expect(out).not.toContain('observedMs');
    });

    it('is demote-only and bounded', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain('demoteQuality(curMode, curClass)');
        // a pinned manual choice disables it entirely, checked inside the frameend handler
        expect(out).toContain('window.__ssQualityPinned() || wdDemotions >= WD_MAX_DEMOTIONS');
    });
});

describe('buildQualityModeInjection watchdog observability', () => {
    it('does not arm when a demotion would change nothing, but still settles wdArmed', () => {
        // The device is already at the floor: attaching a per-frame frameend
        // listener that can never lead to an action would cost exactly the
        // devices that can least afford it. wdArmed must still be set in this
        // path -- it is what stops the readyTimer interval from retrying
        // armWatchdog() every 500ms for the rest of the page's life.
        const out = buildQualityModeInjection();
        const fnIdx = out.indexOf('function armWatchdog() {');
        expect(fnIdx).toBeGreaterThan(-1);
        const body = out.slice(fnIdx, out.indexOf('g.app.on(\'frameend\'', fnIdx));
        expect(body).toContain('demoteQuality(window.__ssQualityMode, window.__ssQualityClass)');
        expect(body).toContain('floor.mode === window.__ssQualityMode && floor.cls === window.__ssQualityClass');
        // wdArmed = true appears before the early return in the not-arming branch
        const notArmIdx = body.indexOf('floor.mode === window.__ssQualityMode && floor.cls === window.__ssQualityClass');
        const branchBody = body.slice(notArmIdx, body.indexOf('return;', notArmIdx));
        expect(branchBody).toContain('wdArmed = true;');
        expect(branchBody).toContain('not arming');
    });

    it('logs when the watchdog actually arms, naming the firstFrame-vs-fallback path and the starting mode/class', () => {
        const out = buildQualityModeInjection();
        const fnIdx = out.indexOf('function armWatchdog() {');
        const listenerIdx = out.indexOf('g.app.on(\'frameend\'', fnIdx);
        const armLogIdx = out.indexOf('watchdog armed via', fnIdx);
        expect(armLogIdx).toBeGreaterThan(-1);
        // logged AFTER the not-arm early return, BEFORE the listener is registered
        expect(armLogIdx).toBeGreaterThan(fnIdx);
        expect(armLogIdx).toBeLessThan(listenerIdx);
        const logLine = out.slice(out.lastIndexOf('console.info(', armLogIdx), out.indexOf(');', armLogIdx));
        expect(logLine).toContain('wdFirstFrameSeen ? \'firstFrame\' : \'fallback timer\'');
        expect(logLine).toContain('window.__ssQualityMode');
        expect(logLine).toContain('window.__ssQualityClass');
    });

    it('logs once, at the mid-session silent latch, when the watchdog reaches the floor', () => {
        // This is the existing silent latch: once next equals cur on both
        // fields, wdDemotions is force-set to WD_MAX_DEMOTIONS, which makes the
        // frameend handler's own leading guard (wdDemotions >= WD_MAX_DEMOTIONS)
        // return before ever reaching this code again -- so it fires once per
        // page load, not once per frame.
        const out = buildQualityModeInjection();
        const latchIdx = out.indexOf('if (next.mode === curMode && next.cls === curClass) {');
        expect(latchIdx).toBeGreaterThan(-1);
        const latchBody = out.slice(latchIdx, out.indexOf('}', out.indexOf('return;', latchIdx)) + 1);
        expect(latchBody).toContain('wdDemotions = WD_MAX_DEMOTIONS;');
        expect(latchBody).toContain('at floor -- nothing left to demote');
        expect(latchBody).toContain('curMode');
        expect(latchBody).toContain('curClass');
        // guarded by the leading frameend precondition, so it cannot re-fire
        expect(out).toContain('if (window.__ssQualityPinned() || wdDemotions >= WD_MAX_DEMOTIONS) { return; }');
    });
});

describe('buildQualityModeInjection watchdog fallback arming', () => {
    it('arms the watchdog on a bounded fallback timer even if firstFrame never fires', () => {
        // Root-cause of the field bug: firstFrame can be permanently withheld by
        // an upstream engine ready-gate race (see portals.ts's own watchdog for
        // the same race). Without a bounded fallback the quality watchdog can
        // never arm on an affected device. Pin the ARM CALL SITE, not just the
        // variable's declaration -- `toContain('wdFallbackAt')` alone would still
        // pass with the arming call deleted and only the declaration left behind.
        const out = buildQualityModeInjection();
        expect(out).toContain('WD_FALLBACK_MS = 30000');
        expect(out).toContain('if (pastFallback) { armWatchdog(); }');
    });

    it('does not let the readyTries wait-for-handle cap cut off a pending fallback deadline', () => {
        // readyTries > 240 is a "give up waiting for the viewer handle" cap. Once
        // wdFallbackAt is set (the handle appeared), the interval must survive to
        // that deadline even past tick 240, or a main() that resolves later than
        // ~90s after parse silently loses the whole fallback fix.
        const out = buildQualityModeInjection();
        expect(out).toContain('!wdFallbackAt && readyTries > 240');
    });

    it('clears the ready-poll interval on wdArmed, pinned, or the absolute ceiling -- never merely on hooking the listener or on a single missed fallback tick', () => {
        // Load-bearing: clearing on window.__ssQualityReadyHooked alone stops the
        // interval the instant the firstFrame listener is attached, so a later
        // fallback tick could never run -- which was the actual bug. Pinned is
        // included so a pinned user's interval stops promptly instead of spinning
        // for the full 240 ticks and re-checking armWatchdog() every tick past 30s.
        // pastFallback must NOT appear in the clear condition: armWatchdog()'s own
        // precondition (g.app.on) is stricter than the one that starts the
        // countdown (g.events), so a single missed attempt on the tick the
        // deadline is first crossed must not permanently disable the fallback --
        // that is the same bug moved one level down. readyTries > 600 (~5 min) is
        // the absolute ceiling that takes its place, so the interval can never
        // outlive the page pointlessly.
        const out = buildQualityModeInjection();
        expect(out).toContain('if (wdArmed || window.__ssQualityPinned() || readyTries > 600 || (!wdFallbackAt && readyTries > 240)) {');
        expect(out).not.toContain('window.__ssQualityReadyHooked || readyTries > 240');
        expect(out).not.toContain('if (wdArmed || window.__ssQualityPinned() || pastFallback || (!wdFallbackAt && readyTries > 240)) {');
    });

    it('caps demotions at three steps to allow the new class-floor step', () => {
        expect(buildQualityModeInjection()).toContain('WD_MAX_DEMOTIONS = 3');
    });
});

describe('buildQualityModeInjection watchdog persistence gate', () => {
    it('sets wdFirstFrameSeen only from the real firstFrame listener, not from the fallback timeout', () => {
        const out = buildQualityModeInjection();
        const idx = out.indexOf("g.events.on('firstFrame', function () {");
        expect(idx).toBeGreaterThan(-1);
        const listenerBody = out.slice(idx, out.indexOf('});', idx));
        expect(listenerBody).toContain('wdFirstFrameSeen = true;');
        // must be set directly, not inside the settle setTimeout
        const setTimeoutIdx = listenerBody.indexOf('setTimeout(armWatchdog');
        expect(listenerBody.indexOf('wdFirstFrameSeen = true;')).toBeLessThan(setTimeoutIdx);
    });

    it('only persists a demotion to KEY_FLOOR once the ready gate has actually fired', () => {
        const out = buildQualityModeInjection();
        const gateIdx = out.indexOf('if (wdFirstFrameSeen) {');
        const applyIdx = out.indexOf('window.__ssQualityApply(next.mode, false, next.cls);', gateIdx);
        expect(gateIdx).toBeGreaterThan(-1);
        expect(applyIdx).toBeGreaterThan(gateIdx);
        const gateBody = out.slice(gateIdx, applyIdx);
        expect(gateBody).toContain('writeStore(KEY_FLOOR, next.mode);');
    });

    it('only writes the auto-class key when the class actually changed, inside the same persistence gate', () => {
        // The reader only ever compares KEY_AUTO_CLASS against 'weak', so a
        // 'standard' write on ladder steps 1/2 is inert -- gating on change keeps
        // the key reading as the 'weak' latch it is.
        const out = buildQualityModeInjection();
        const gateIdx = out.indexOf('if (wdFirstFrameSeen) {');
        const applyIdx = out.indexOf('window.__ssQualityApply(next.mode, false, next.cls);', gateIdx);
        expect(gateIdx).toBeGreaterThan(-1);
        expect(applyIdx).toBeGreaterThan(gateIdx);
        const gateBody = out.slice(gateIdx, applyIdx);
        expect(gateBody).toContain('if (next.cls !== curClass) { writeStore(KEY_AUTO_CLASS, next.cls); }');
    });

    it('logs when a demotion was session-only because the ready gate never fired', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain("(wdFirstFrameSeen ? '' : ' (session only -- ready gate never fired)')");
    });

    it('passes the demoted class through to __ssQualityApply on a watchdog demotion', () => {
        // Without the third argument, a class-only step (perf -> perf@weak)
        // would silently stop taking effect even though every other assertion
        // in this file still passes.
        const out = buildQualityModeInjection();
        expect(out).toContain('window.__ssQualityApply(next.mode, false, next.cls);');
    });
});

describe('buildQualityModeInjection manual pick clears auto-corrections', () => {
    it('captures the heuristic class before the stored auto-class override is applied', () => {
        const out = buildQualityModeInjection();
        const heuristicIdx = out.indexOf('var heuristicClass = qualityClass;');
        const overrideIdx = out.indexOf("if (readStore(KEY_AUTO_CLASS) === 'weak') { qualityClass = 'weak'; }");
        expect(heuristicIdx).toBeGreaterThan(-1);
        expect(overrideIdx).toBeGreaterThan(-1);
        expect(overrideIdx).toBeGreaterThan(heuristicIdx);
    });

    it('adds a removeStore helper next to readStore/writeStore', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain('function removeStore(key) {');
        expect(out).toContain('localStorage.removeItem(key)');
    });

    it('wipes both auto-correction keys and reverts to the heuristic class on a manual pick, before publish() runs', () => {
        const out = buildQualityModeInjection();
        const applyIdx = out.indexOf('window.__ssQualityApply = function (mode, isManual, cls) {');
        expect(applyIdx).toBeGreaterThan(-1);
        const body = out.slice(applyIdx);
        const isManualIdx = body.indexOf('if (isManual) {');
        const removeFloorIdx = body.indexOf('removeStore(KEY_FLOOR);');
        const removeClassIdx = body.indexOf('removeStore(KEY_AUTO_CLASS);');
        const resetIdx = body.indexOf('qualityClass = heuristicClass;');
        const publishIdx = body.indexOf('publish(mode);');
        expect(isManualIdx).toBeGreaterThan(-1);
        expect(removeFloorIdx).toBeGreaterThan(isManualIdx);
        expect(removeClassIdx).toBeGreaterThan(isManualIdx);
        expect(resetIdx).toBeGreaterThan(isManualIdx);
        expect(publishIdx).toBeGreaterThan(resetIdx);
    });
});

describe('buildQualityModeInjection class demotion', () => {
    it('persists an auto class demotion under its own key', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain("'ssQualityAutoClass'");
        expect(out).toContain('writeStore(KEY_AUTO_CLASS');
        expect(out).toContain('readStore(KEY_AUTO_CLASS)');
    });

    it('lets __ssQualityApply accept and apply a device class', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain('function (mode, isManual, cls)');
        expect(out).toContain('qualityClass = cls');
    });

    it('re-applies when only the class changed, leaving the mode identical', () => {
        // perf -> perf@weak leaves the MODE the same, so the pre-existing
        // "fire performanceMode:changed only when the mode changed" condition
        // would otherwise skip the re-apply and the new budget would never
        // take effect.
        const out = buildQualityModeInjection();
        expect(out).toContain('prevClass !== qualityClass');
    });
});

describe('buildQualityModeInjection dropdown open/close behaviour', () => {
    it('picking a mode routes through __ssQualityApply(mode, true) exactly once, then closes and returns focus', () => {
        const out = buildQualityModeInjection();
        const clickIdx = out.indexOf("item.addEventListener('click', function (ev) {");
        expect(clickIdx).toBeGreaterThan(-1);
        const body = out.slice(clickIdx, out.indexOf('});', clickIdx));
        expect(body).toContain('window.__ssQualityApply(mode, true);');
        expect(body).toContain('closePopup();');
        expect(body).toContain('trig.focus();');
        // exactly one manual-pick CALL SITE in the whole file -- the watchdog's
        // own call passes isManual: false and a class, so it cannot collide.
        // Scoped to the actual call (window.__ssQualityApply(...)), not the
        // explanatory comment above it, which also names the same entry point.
        const manualCallCount = out.split('window.__ssQualityApply(mode, true);').length - 1;
        expect(manualCallCount).toBe(1);
    });

    it('toggles the trigger open and closed, flipping aria-expanded both ways', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain("function openPopup() {\n      pop.className = 'ssQ-pop ssQ-open';\n      trig.setAttribute('aria-expanded', 'true');\n    }");
        expect(out).toContain("function closePopup() {\n      pop.className = 'ssQ-pop';\n      trig.setAttribute('aria-expanded', 'false');\n    }");
        const trigClickIdx = out.indexOf("trig.addEventListener('click', function (ev) {");
        expect(trigClickIdx).toBeGreaterThan(-1);
        const body = out.slice(trigClickIdx, out.indexOf('});', trigClickIdx));
        // stopPropagation matters: without it the same click bubbles to the
        // outside-click listener below, which would immediately re-close what
        // this handler just opened
        expect(body).toContain('ev.stopPropagation();');
        expect(body).toContain('if (isOpen()) { closePopup(); } else { openPopup(); }');
    });

    it('closes on Escape and returns focus to the trigger', () => {
        const out = buildQualityModeInjection();
        const idx = out.indexOf("if (ev.key === 'Escape') {");
        expect(idx).toBeGreaterThan(-1);
        const body = out.slice(idx, out.indexOf('return;', idx));
        expect(body).toContain('closePopup();');
        expect(body).toContain('trig.focus();');
    });

    it('moves focus between popup items with Arrow Up/Down while open', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain("ev.key === 'ArrowDown' || ev.key === 'ArrowUp'");
        const idx = out.indexOf("ev.key === 'ArrowDown' || ev.key === 'ArrowUp'");
        const body = out.slice(idx, out.indexOf('    });', idx));
        expect(body).toContain('itemEls[order[idx]].focus();');
        // guarded so arrow keys do nothing while the popup is closed
        expect(out).toContain('if (!isOpen()) { return; }');
    });

    it('closes on a click anywhere outside the control', () => {
        const out = buildQualityModeInjection();
        const idx = out.lastIndexOf("document.addEventListener('click', function (ev) {");
        expect(idx).toBeGreaterThan(-1);
        const body = out.slice(idx, out.indexOf('});', idx));
        expect(body).toContain('wrapEl.contains(ev.target)');
        expect(body).toContain('closePopup();');
    });
});

describe('buildQualityModeInjection dropdown repaint', () => {
    it('keeps __ssQualityOnChange assigned to repaint the control on a watchdog auto-demotion', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain('window.__ssQualityOnChange = function (mode) { paint(mode); };');
    });

    it('repaints the trigger label, the wrapper level class and every item aria-checked from a single mode', () => {
        const out = buildQualityModeInjection();
        const fnIdx = out.indexOf('function paint(mode) {');
        expect(fnIdx).toBeGreaterThan(-1);
        const body = out.slice(fnIdx, out.indexOf('window.__ssQualityOnChange', fnIdx));
        // dot level
        expect(body).toContain("wrapEl.className = 'ssQ ssQ-lvl' + idx;");
        // trigger label
        expect(body).toContain('valEl.textContent = labelsT[mode]');
        // checkmark, via aria-checked driving the CSS
        expect(body).toContain("itemEls[m].setAttribute('aria-checked', (m === mode) ? 'true' : 'false');");
    });
});

describe('buildQualityModeInjection locale descriptions', () => {
    it('gives the FR mode descriptions supplied by the approved design, verbatim', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain('Fluide sur mobile et vieux GPU');
        expect(out).toContain('Équilibre netteté / fluidité');
        expect(out).toContain('Détail maximal, peut ralentir');
    });

    it('carries a "d" description object with all three modes for all nine locales', () => {
        const out = buildQualityModeInjection();
        // Each locale's d object opens with this exact prefix -- one per
        // locale, so this count is a direct proxy for "every locale has one".
        const perfCount = out.split("d: { perf: '").length - 1;
        expect(perfCount).toBe(9);
        // normal/hd also appear as top-level (abbreviated) label keys, so
        // these counts are locale-count x 2 (once as the label, once inside
        // the description object) rather than a bare 9.
        const normalCount = out.split("', normal: '").length - 1;
        expect(normalCount).toBe(18);
        const hdCount = out.split("', hd: '").length - 1;
        expect(hdCount).toBe(18);
    });
});
