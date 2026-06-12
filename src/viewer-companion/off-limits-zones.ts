import { segmentBlockedByWall } from './off-limits-collision';

type ZoneLike = {
    position: [number, number, number],
    rotation: [number, number, number, number],
    width: number,
    height: number
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
  var msgText = resolveOffLimitsMessage(custom, defaults, navigator.language || 'en');

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
  // controller, so we set the manager's pose and call snap() to re-seed the
  // active controller (this is how the viewer's own debug panel repositions the
  // camera). window.__supersplatViewer is published from the viewer bootstrap;
  // poll for it via rAF until it is ready.
  var lastSafe = null;
  function tick() {
    var viewer = window.__supersplatViewer;
    var cm = viewer && viewer.cameraManager;
    var cam = cm && cm.camera;
    if (cam && cam.position) {
      var cur = [cam.position.x, cam.position.y, cam.position.z];
      if (lastSafe) {
        for (var i = 0; i < zones.length; i++) {
          var safe = segmentBlockedByWall(lastSafe, cur, zones[i]);
          if (safe) {
            cam.position.set(safe[0], safe[1], safe[2]);
            if (typeof cm.snap === 'function') cm.snap();
            cur = safe;
            flashFeedback();
            break;
          }
        }
      }
      lastSafe = cur;
    }
    requestAnimationFrame(tick);
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
    return `<style>${companionStyle}</style>` +
        `<script>window.__supersplatOffLimitsZones = ${payloadJson};</script>` +
        `<script>${companionRuntime}</script>`;
};

export { buildOffLimitsZonesInjection, resolveOffLimitsMessage, DEFAULT_MESSAGES };
