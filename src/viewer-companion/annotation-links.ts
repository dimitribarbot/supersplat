type AnyAnnotation = {
    title?: string,
    text?: string,
    extras?: { url?: string, newTab?: boolean }
};

// Build the link table the runtime companion consumes. label is 1-based to
// match the viewer's auto-generated annotation label (index + 1).
const buildLinkTable = (annotations: AnyAnnotation[]): { label: number, url: string, newTab: boolean }[] => {
    const table: { label: number, url: string, newTab: boolean }[] = [];
    annotations.forEach((a, i) => {
        const url = a.extras?.url;
        if (url) {
            table.push({ label: i + 1, url, newTab: !!a.extras?.newTab });
        }
    });
    return table;
};

// The runtime companion. Kept as a plain string so it is injected verbatim.
//
// The exported viewer renders annotations with a single shared tooltip
// (.pc-annotation, holding .pc-annotation-title/.pc-annotation-text) whose
// content is rewritten each time a hotspot (.pc-annotation-hotspot) is clicked.
// Hotspots are emitted in annotation order, so the Nth hotspot maps to label
// N+1. The tooltip itself is pointer-events:none, so any link inside it must
// re-enable pointer events (see .ss-annotation-link in companionStyle).
//
// This companion: (1) reads the link table, (2) binds a click handler to each
// hotspot that has a link, (3) on click injects/refreshes a clickable link in
// the shared tooltip. A MutationObserver keeps binding hotspots created after
// load (the splat scene loads asynchronously). URLs are sanitised to http(s).
const companionRuntime = `
(function () {
  var links = window.__supersplatAnnotationLinks || [];
  if (!links.length) return;

  // Localize the "Open link" label by the viewer's browser language (the
  // exported file is standalone, with no access to the editor's i18next). Keys
  // are primary subtags; a navigator.language like 'pt-BR'/'zh-CN' falls back to
  // its base subtag, then to English.
  var openLinkLabels = {
    en: 'Open link', de: 'Link \\u00f6ffnen', es: 'Abrir enlace', fr: 'Ouvrir le lien',
    ja: '\\u30ea\\u30f3\\u30af\\u3092\\u958b\\u304f', ko: '\\ub9c1\\ud06c \\uc5f4\\uae30',
    pt: 'Abrir link', ru: '\\u041e\\u0442\\u043a\\u0440\\u044b\\u0442\\u044c \\u0441\\u0441\\u044b\\u043b\\u043a\\u0443',
    zh: '\\u6253\\u5f00\\u94fe\\u63a5'
  };
  var navLang = (navigator.language || 'en').toLowerCase();
  var openLinkText = (openLinkLabels[navLang] || openLinkLabels[navLang.split('-')[0]] || openLinkLabels.en) + ' \\u2197';

  var byLabel = {};
  links.forEach(function (l) { byLabel[String(l.label)] = l; });

  function safeHref(url) {
    try {
      var u = new URL(url, window.location.href);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
    } catch (e) {}
    return null;
  }

  function container() { return document.getElementById('annotations') || document; }

  // Inject (or refresh) the link inside the shared tooltip for the given link
  // entry. Passing null just clears any previously injected link.
  function injectLink(link) {
    var tip = document.querySelector('.pc-annotation');
    if (!tip) return;
    var existing = tip.querySelector('.ss-annotation-link');
    if (existing) existing.remove();
    if (!link) return;
    var href = safeHref(link.url);
    if (!href) return;
    var a = document.createElement('a');
    a.className = 'ss-annotation-link';
    a.href = href;
    a.textContent = openLinkText;
    if (link.newTab) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    // keep the tooltip open (the viewer closes it on document click) and let
    // the navigation proceed normally
    a.addEventListener('click', function (e) { e.stopPropagation(); });
    tip.appendChild(a);
  }

  // Bind every not-yet-bound hotspot to inject its label's link on click. Our
  // listener is added after the viewer's (the hotspot already exists), so it
  // runs after showTooltip has populated the shared tooltip.
  function bindHotspots() {
    var hotspots = container().querySelectorAll('.pc-annotation-hotspot');
    for (var i = 0; i < hotspots.length; i++) {
      var h = hotspots[i];
      if (h.getAttribute('data-ss-bound')) continue;
      h.setAttribute('data-ss-bound', '1');
      (function (label) {
        h.addEventListener('click', function () { injectLink(byLabel[String(label)] || null); });
      })(i + 1);
    }
  }

  function start() {
    bindHotspots();
    // hotspots are created once the splat scene loads; keep binding as they appear
    var obs = new MutationObserver(function () { bindHotspots(); });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
`;

const companionStyle = `
.ss-annotation-link {
  display: inline-block;
  margin-top: 8px;
  padding: 4px 8px;
  border-radius: 4px;
  background: rgba(255,255,255,0.15);
  color: #fff;
  text-decoration: none;
  font-size: 13px;
  cursor: pointer;
  pointer-events: auto;
}
.ss-annotation-link:hover { background: rgba(255,255,255,0.3); }
`;

// Produce the full HTML fragment to inject before </body>, or '' if no links.
const buildAnnotationLinksInjection = (annotations: AnyAnnotation[]): string => {
    const table = buildLinkTable(annotations || []);
    if (table.length === 0) {
        return '';
    }
    // Escape characters that are unsafe inside an HTML <script> context so a
    // URL containing e.g. "</script>" or a line/paragraph separator cannot
    // break out of the injected script tag.
    const tableJson = JSON.stringify(table)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
    return `<style>${companionStyle}</style>` +
        `<script>window.__supersplatAnnotationLinks = ${tableJson};</script>` +
        `<script>${companionRuntime}</script>`;
};

export { buildAnnotationLinksInjection, buildLinkTable };
