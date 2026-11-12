import { followFullscreen } from './fullscreen-follow';
import { segmentBlockedByWall, xrRigAfterBlock } from './off-limits-collision';

type ZoneLike = {
    position: [number, number, number];
    rotation: [number, number, number, number];
    width: number;
    height: number;
    infinite?: { top: boolean; right: boolean; bottom: boolean; left: boolean };
};

// Localized default messages, keyed by primary language subtag. Mirrors the
// language set used by annotation-links.ts.
const DEFAULT_MESSAGES: Record<string, string> = {
    en: 'You have reached the end of the scene.',
    de: 'Sie haben das Ende der Szene erreicht.',
    es: 'Has llegado al final de la escena.',
    fr: 'Vous avez atteint la fin de la scène.',
    ja: 'シーンの終わりに到達しました。',
    ko: '장면의 끝에 도달했습니다.',
    pt: 'Você chegou ao fim da cena.',
    ru: 'Вы достигли конца сцены.',
    zh: '您已到达场景的尽头。'
};

// Pure default-message resolver. Custom text wins; otherwise pick the viewer's
// language (region subtag -> base subtag -> English). Self-contained so it is
// also injected verbatim into the runtime via Function.toString().
const resolveOffLimitsMessage = (custom: string, defaults: Record<string, string>, lang: string): string => {
    if (custom) {
        return custom;
    }
    const l = (lang || 'en').toLowerCase();
    return defaults[l] || defaults[l.split('-')[0]] || defaults.en;
};

// CSS for the message overlay + the red screen-edge flash (DOM feedback that
// works regardless of whether the 3D red quad can be created).
const companionStyle = `
.ss-offlimits-overlay {
  position: fixed; inset: 0; pointer-events: none; z-index: 1000;
  box-shadow: inset 0 0 120px 40px rgba(255,0,0,0.0);
  transition: box-shadow 200ms ease-out; display: block;
}
.ss-offlimits-overlay.active { box-shadow: inset 0 0 120px 40px rgba(255,0,0,0.55); }
.ss-offlimits-message {
  position: fixed; left: 50%; bottom: 12%; transform: translateX(-50%);
  background: rgba(0,0,0,0.78); color: #fff; padding: 10px 16px; border-radius: 6px;
  font-family: sans-serif; font-size: 15px; pointer-events: none; z-index: 1001;
  opacity: 0; transition: opacity 200ms ease-out; max-width: 80%; text-align: center;
}
.ss-offlimits-message.active { opacity: 1; }
`;

// The runtime companion, kept as a string so it is injected verbatim. It reads
// window.__supersplatOffLimitsZones = { zones, message, defaults }, then each
// frame reads the viewer camera pose from window.__supersplatViewer.cameraManager,
// clamps it against each wall (set pose + snap()), and shows a red screen flash
// + message. The exported viewer exposes no `pc` global, so feedback is DOM-only
// (no 3D quad) and the camera is driven through cameraManager rather than the
// entity. window.__supersplatViewer is published by splat-export-core.
const companionRuntime = `
(function () {
  var data = window.__supersplatOffLimitsZones;
  if (!data || !data.zones || !data.zones.length) return;
  var zones = data.zones;
  var defaults = data.defaults || {};
  var custom = data.message || '';

  var segmentBlockedByWall = ${segmentBlockedByWall.toString()};
  var resolveOffLimitsMessage = ${resolveOffLimitsMessage.toString()};
  var followFullscreen = ${followFullscreen.toString()};
  var msgText = resolveOffLimitsMessage(custom, defaults, window.__ssLang || 'en');

  // --- DOM feedback (always available) ---
  var overlay = document.createElement('div');
  overlay.className = 'ss-offlimits-overlay';
  var msgEl = document.createElement('div');
  msgEl.className = 'ss-offlimits-message';
  msgEl.textContent = msgText;
  function mount() {
    document.body.appendChild(overlay);
    document.body.appendChild(msgEl);
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
  // the viewer fullscreens its own root, which draws only that subtree
  followFullscreen(document, function () { return [overlay, msgEl]; });
  var feedbackTimer = null;
  function flashFeedback() {
    overlay.classList.add('active');
    msgEl.classList.add('active');
    if (feedbackTimer) clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(function () {
      overlay.classList.remove('active');
      msgEl.classList.remove('active');
    }, 700);
  }

  // --- per-frame camera clamp ---
  // The exported viewer keeps its camera pose in viewer.cameraManager.camera.
  // Setting the camera entity's position would be overwritten each frame by the
  // controller, so we set the manager's pose and re-seed the active controller.
  // Prefer reseat() -- a spawn-preserving reposition added by the export-time
  // engine patch (see viewer-engine-patch.ts): it re-seats the controller pose
  // WITHOUT re-storing the walk/fly reset spawn, so being blocked no longer
  // corrupts where R (resetToSpawn) returns to. Fall back to snap() when the
  // patch did not apply (older/newer bundle); snap() re-seeds too but re-stores
  // the spawn at the clamp position (the pre-patch behaviour).
  // window.__supersplatViewer is published from the viewer bootstrap; poll for
  // it via rAF until it is ready.
  //
  // In an XR session the viewer leaves its camera manager alone, so its pose
  // stays where the session started: the headset drives the camera entity
  // instead, under the rig (its parent), which teleport and grab-move move.
  // There the clamp reads the camera entity and moves the rig back
  // (xrRigAfterBlock). The browser need not run window rAF callbacks while an
  // immersive session presents, so in a session the clamp runs from the app's
  // update event, which the session's frames drive. The red flash and the
  // message are page overlays, which a session does not show: none there.
  var lastSafe = null;
  var xrRigAfterBlock = ${xrRigAfterBlock.toString()};
  var wasXr = false;
  var prevRig = null;
  var hookedApp = null;
  function reseat(cm) {
    if (typeof cm.reseat === 'function') cm.reseat();
    else if (typeof cm.snap === 'function') cm.snap();
  }
  function liveApp() {
    var v = window.__supersplatViewer;
    return (v && v.global && v.global.app) || null;
  }
  function inXr(app) {
    return !!(app && app.xr && app.xr.active);
  }
  function tick() {
    var app = liveApp();
    if (app && app.on && hookedApp !== app) {
      hookedApp = app;
      app.on('update', function () { if (inXr(app)) clamp(); });
    }
    if (!inXr(app)) clamp();
    requestAnimationFrame(tick);
  }
  function clampXr(camera) {
    var rig = camera && camera.parent;
    if (!rig || !camera.getPosition || !rig.getPosition || !rig.setPosition) return;
    var p = camera.getPosition();
    var cur = [p.x, p.y, p.z];
    var r = rig.getPosition();
    var rigPos = [r.x, r.y, r.z];
    if (lastSafe && prevRig) {
      for (var i = 0; i < zones.length; i++) {
        var safe = segmentBlockedByWall(lastSafe, cur, zones[i]);
        if (safe) {
          var to = xrRigAfterBlock(safe, cur, prevRig, rigPos);
          rig.setPosition(to[0], to[1], to[2]);
          cur = [cur[0] + to[0] - rigPos[0], cur[1] + to[1] - rigPos[1], cur[2] + to[2] - rigPos[2]];
          rigPos = to;
          break;
        }
      }
    }
    lastSafe = cur;
    prevRig = rigPos;
  }
  function clamp() {
    var viewer = window.__supersplatViewer;
    var xr = inXr(liveApp());
    // a session's edges jump the camera (to the headset, and back): no walk
    if (xr !== wasXr) {
      wasXr = xr;
      lastSafe = null;
      prevRig = null;
    }
    if (xr) {
      clampXr(viewer.global.camera);
      return;
    }
    var cm = viewer && viewer.cameraManager;
    var cam = cm && cm.camera;
    if (cam && cam.position) {
      var cur = [cam.position.x, cam.position.y, cam.position.z];
      if (lastSafe) {
        for (var i = 0; i < zones.length; i++) {
          var safe = segmentBlockedByWall(lastSafe, cur, zones[i]);
          if (safe) {
            cam.position.set(safe[0], safe[1], safe[2]);
            reseat(cm);
            cur = safe;
            flashFeedback();
            break;
          }
        }
      }
      lastSafe = cur;
    }
  }
  requestAnimationFrame(tick);
})();
`;

// Produce the full HTML fragment to inject before </body>, or '' if no zones.
const buildOffLimitsZonesInjection = (zones: ZoneLike[], message: string): string => {
    if (!zones || zones.length === 0) {
        return '';
    }
    const payload = { zones, message: message || '', defaults: DEFAULT_MESSAGES };
    // Escape characters unsafe inside an HTML <script> context so the payload
    // cannot break out of the injected script tag (mirrors annotation-links.ts).
    const payloadJson = JSON.stringify(payload)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
    return (
        `<style>${companionStyle}</style>` +
        `<script>window.__supersplatOffLimitsZones = ${payloadJson};</script>` +
        `<script>${companionRuntime}</script>`
    );
};

export { buildOffLimitsZonesInjection, resolveOffLimitsMessage, DEFAULT_MESSAGES };
