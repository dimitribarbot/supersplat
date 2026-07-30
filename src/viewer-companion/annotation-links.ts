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
// title/text are rewritten on every activation. The tooltip itself is
// pointer-events:none, so any link inside it must re-enable pointer events
// (see .ss-annotation-link in companionStyle).
//
// This companion listens for 'annotation.activate' and injects, refreshes or
// clears a clickable link in that shared tooltip from the activated
// annotation's own extras. Reading extras directly means there is no
// "Nth hotspot = Nth annotation" ordering assumption to violate. URLs are
// sanitised to http(s). The baked link table survives only as the gate that
// decides whether this companion is injected at all.
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

  function safeHref(url) {
    try {
      var u = new URL(url, window.location.href);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
    } catch (e) {}
    return null;
  }

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

  // Refresh the link on every activation. Both the nav chevrons and a hotspot
  // click end at 'annotation.activate', which showTooltip fires AFTER writing
  // the shared tooltip's title/text -- so appending here is correctly ordered.
  // Binding the hotspot click instead (as this companion first did) missed
  // chevron navigation entirely: the viewer rewrites title/text on the *shared*
  // tooltip but never touches our appended link, so the previous annotation's
  // link stayed on screen and read as if it belonged to the new one.
  function start() {
    var viewer = window.__supersplatViewer;
    var ev = viewer && viewer.global && viewer.global.events;
    if (!ev || !ev.on) { requestAnimationFrame(start); return; }
    ev.on('annotation.activate', function (ann) {
      var extras = ann && ann.extras;
      var url = extras && extras.url;
      injectLink(url ? { url: url, newTab: !!extras.newTab } : null);
    });
    ev.on('annotation.deactivate', function () { injectLink(null); });
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
