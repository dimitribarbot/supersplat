// WebGPU -> WebGL2 crash fallback for the exported viewer.
//
// Some mobile GPUs run WebGPU nominally but Dawn drops the device under
// gsplat streaming's allocation churn (field case: Adreno 618 / Redmi Note
// 9S -- "A valid external Instance reference no longer exists" at only
// ~200-300MB of tracked VRAM, while the same scene walks fine on WebGL2).
// Engine 2.20.2's handleDeviceLost restore path then crashes on the null
// adapter that follows, so the page is dead. The viewer already supports a
// ?webgl URL param (renderer = searchParams.has('webgl') ? 'webgl' : 'webgpu').
//
// This companion keeps WebGPU the default everywhere it works and reacts to
// the first failure: on a WebGPU devicelost it stamps localStorage and
// reloads the page with ?webgl appended; at boot the stamp redirects
// straight to WebGL2 (sticky per device, so each device crashes at most
// once, ever). An explicit ?webgpu param clears the stamp (escape hatch for
// retrying after browser/driver updates). Injected into EVERY export (portal
// or not -- plain single-scene exports die the same way on such devices).
//
// Authored inside a template literal: NO backslash escapes of any kind (they
// are cooked away at build time -- the residentBudget override shipped as a
// dead regex that way) and ES5 only (the string is baked verbatim).

const companionRuntime = `
(function () {
  var KEY = 'ssViewerForceWebgl';
  function paramNames() {
    var q = location.search || '';
    if (q.charAt(0) === '?') { q = q.substring(1); }
    var out = {};
    var parts = q.split('&');
    for (var i = 0; i < parts.length; i++) {
      var name = parts[i].split('=')[0];
      if (name) { out[name] = true; }
    }
    return out;
  }
  function withWebglParam(href) {
    var hash = '';
    var h = href.indexOf('#');
    if (h !== -1) { hash = href.substring(h); href = href.substring(0, h); }
    return href + (href.indexOf('?') !== -1 ? '&' : '?') + 'webgl' + hash;
  }
  // After a GPU-process crash the browser cannot create ANY new GPU context
  // for a few seconds (field: 'WebGL not supported' from the viewer boot when
  // the fallback reloaded too early). Probe with a throwaway canvas and
  // release the probe context immediately. AT MOST ONCE PER PAGE LOAD:
  // repeated failed getContext attempts get the page instance blocked from
  // context creation entirely (field: a 500ms probe loop failed for 60s
  // straight while an immediate manual reload worked first try).
  function webglReady() {
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl2');
      if (gl) {
        var ext = gl.getExtension('WEBGL_lose_context');
        if (ext) { ext.loseContext(); }
        return true;
      }
    } catch (e) {}
    return false;
  }
  var params = paramNames();
  if (params.webgpu) {
    // Explicit ?webgpu retries WebGPU and clears the sticky fallback.
    try { localStorage.removeItem(KEY); } catch (e) {}
  } else if (!params.webgl) {
    var forced = false;
    try { forced = localStorage.getItem(KEY) === '1'; } catch (e) {}
    if (forced) {
      // Classic inline script: this runs during parse, before the viewer's
      // deferred module boots, so the aborted WebGPU start costs nothing.
      console.info('[viewer] webgpu previously crashed on this device -- starting with webgl (add ?webgpu to retry)');
      location.replace(withWebglParam(location.href));
      return;
    }
  }
  // Localized strings for the restart overlay: [title, button, browser hint].
  // Literal UTF-8 only -- unicode escapes are forbidden in this template.
  function restartText() {
    var t = {
      en: ['3D graphics needs a restart', 'Tap to restart', 'If nothing happens, reload the page with the reload button in your browser menu.'],
      fr: ['L’affichage 3D doit redémarrer', 'Appuyez pour redémarrer', 'Si rien ne se passe, rechargez la page avec le bouton Actualiser du menu de votre navigateur.'],
      de: ['Die 3D-Grafik muss neu gestartet werden', 'Zum Neustarten tippen', 'Wenn nichts passiert, laden Sie die Seite über die Schaltfläche „Neu laden“ im Browsermenü neu.'],
      es: ['Los gráficos 3D deben reiniciarse', 'Toca para reiniciar', 'Si no pasa nada, recarga la página con el botón Recargar del menú del navegador.']
    };
    // en hint intentionally says 'browser menu': field-tested on Android --
    // a tap-driven JS reload does NOT clear the 3D-API block and the viewer
    // canvas suppresses pull-to-refresh, so the browser menu is the path.
    var l = (navigator.language || 'en').toLowerCase().split('-')[0];
    return t[l] || t.en;
  }
  function showRestartOverlay() {
    try {
      var txt = restartText();
      var d = document.createElement('div');
      d.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;background:#101010;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:sans-serif;text-align:center;padding:24px;';
      var h = document.createElement('div');
      h.style.cssText = 'font-size:18px;margin-bottom:20px;';
      h.textContent = txt[0];
      d.appendChild(h);
      var b = document.createElement('button');
      b.style.cssText = 'font-size:16px;padding:12px 28px;border-radius:8px;border:0;background:#e05a00;color:#fff;cursor:pointer;';
      b.textContent = txt[1];
      // A tap-driven reload carries user activation: on builds where
      // user-initiated navigation unblocks 3D APIs this recovers in one tap;
      // where it does not, the next load shows the browser-reload hint.
      b.onclick = function () { location.reload(); };
      d.appendChild(b);
      // Browser-menu hint shown from the start: field-confirmed that the tap
      // reload does not unblock on at least some Android builds.
      var p = document.createElement('div');
      p.style.cssText = 'font-size:13px;margin-top:18px;opacity:0.85;max-width:420px;';
      p.textContent = txt[2];
      d.appendChild(p);
      if (document.body) { document.body.appendChild(d); } else {
        document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(d); });
      }
    } catch (e) {}
  }
  if (params.webgl) {
    var RETRY_KEY = 'ssViewerWebglRetry';
    if (webglReady()) {
      try { sessionStorage.removeItem(RETRY_KEY); } catch (e) {}
    } else {
      // We arrived on the webgl page but no context is creatable. Two causes:
      // (a) the GPU process is still restarting -- a reload a moment later
      // succeeds; (b) Chromium 3D-API domain blocking -- after a GPU crash
      // the HOSTNAME is blocked browser-wide (gpu_data_manager_impl_private
      // .cc), query params cannot escape it, and the only source-confirmed
      // unblock is a user/browser-initiated reload (three_d_api_observer.cc
      // infobar). JS reloads are NOT privileged (field: six auto-reloads
      // failed; one pull-to-refresh worked instantly). So: ONE automatic
      // reload for case (a), then a tap-to-restart overlay -- and once a
      // tap has failed too, the overlay adds the pull-to-refresh hint.
      var n = 0;
      var canCount = true;
      try {
        n = parseInt(sessionStorage.getItem(RETRY_KEY) || '0', 10) || 0;
        sessionStorage.setItem(RETRY_KEY, String(n + 1));
      } catch (e) { canCount = false; }
      if (canCount && n === 0) {
        console.warn('[viewer] webgl context not yet available -- one automatic reload in 2s');
        setTimeout(function () { location.reload(); }, 2000);
      } else {
        console.warn('[viewer] webgl context unavailable (3d apis likely domain-blocked) -- user reload needed');
        showRestartOverlay();
      }
    }
  }
  function arm() {
    var v = window.__supersplatViewer;
    var app = (v && v.debugPanel && v.debugPanel._global && v.debugPanel._global.app) || (v && v.navCursor && v.navCursor.app) || null;
    var gd = app && app.graphicsDevice;
    if (!gd || !gd.on) { return false; }
    if (gd.deviceType !== 'webgpu') { return true; }   // already on webgl: never loop a lost GL context into reloads
    gd.on('devicelost', function () {
      try { localStorage.setItem(KEY, '1'); } catch (e) {}
      console.warn('[viewer] webgpu device lost -- switching to webgl fallback');
      // Fixed short delay only, so diagnostics can flush. No context probing
      // here: failed attempts on this dying page instance would get it
      // blocked from context creation (see webglReady). The webgl page's
      // reload-backoff handles a navigation that lands too early.
      setTimeout(function () { location.replace(withWebglParam(location.href)); }, 1000);
    });
    return true;
  }
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    if (arm() || tries > 240) { clearInterval(timer); }
  }, 500);
})();
`;

// Produce the HTML fragment to inject before </body>. Always injected: the
// fallback is wanted in every export. The viewer handle used by arm() is
// published by the off-limits/portals injectors when present; when neither
// runs (plain export), injectDeviceFallback's own bootstrap soft-replace in
// splat-export-core publishes it.
const buildDeviceFallbackInjection = (): string => {
    return `<script>${companionRuntime}</script>`;
};

export { buildDeviceFallbackInjection };
