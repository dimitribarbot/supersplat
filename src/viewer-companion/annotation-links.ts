import { galleryRuntime, galleryStyle, hasGallery } from './annotation-gallery';

type AnyAnnotation = {
    title?: string,
    text?: string,
    extras?: { url?: string, newTab?: boolean, images?: { src: string, caption: string }[] }
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
// (.sse-annotation, holding .sse-annotation-title/.sse-annotation-text) whose
// title/text are rewritten on every selection. The tooltip itself is
// pointer-events:none, so any link inside it must re-enable pointer events
// (see .ss-annotation-link in companionStyle).
//
// This companion listens for the published viewer handle's
// 'selectedAnnotation:changed' (index: number | null) and injects, refreshes
// or clears a clickable link in that shared tooltip from the selected
// annotation's own extras (read from viewer.global.settings.annotations).
// Reading extras directly means there is no "Nth hotspot = Nth annotation"
// ordering assumption to violate. URLs are sanitised to http(s).
//
// The runtime reads nothing from the baked window.__supersplatAnnotationLinks
// table: whether this companion is injected at all is decided at build time by
// buildAnnotationLinksInjection (which gates on links OR galleries, since a
// gallery-only export legitimately has an empty link table). The table is still
// baked as a build-time record of which annotations carry links -- readable in
// an exported file, and asserted by the injection tests.
const companionRuntime = `
(function () {
  // Localize the "Open link" label using the language the shared resolver
  // publishes to window.__ssLang (honours ?lang=, then the browser's
  // languages -- the exported file is standalone, with no access to the
  // editor's i18next). Keys are primary subtags; a value like 'pt-BR'/'zh-CN'
  // falls back to its base subtag, then to English.
  var openLinkLabels = {
    en: 'Open link', de: 'Link \\u00f6ffnen', es: 'Abrir enlace', fr: 'Ouvrir le lien',
    ja: '\\u30ea\\u30f3\\u30af\\u3092\\u958b\\u304f', ko: '\\ub9c1\\ud06c \\uc5f4\\uae30',
    pt: 'Abrir link', ru: '\\u041e\\u0442\\u043a\\u0440\\u044b\\u0442\\u044c \\u0441\\u0441\\u044b\\u043b\\u043a\\u0443',
    zh: '\\u6253\\u5f00\\u94fe\\u63a5'
  };
  var navLang = (window.__ssLang || 'en').toLowerCase();
  var openLinkText = (openLinkLabels[navLang] || openLinkLabels[navLang.split('-')[0]] || openLinkLabels.en) + ' \\u2197';

  ${galleryRuntime}

  // Literal non-ASCII glyphs are fine here: the exported HTML declares
  // <meta charset="UTF-8"> and is written through TextEncoder, so the bytes
  // survive. The unicode escapes in openLinkLabels above are equivalent, just
  // an older convention -- neither table needs converting to the other.
  var viewImagesLabels = {
    en: 'View images', de: 'Bilder ansehen', es: 'Ver imágenes', fr: 'Voir les images',
    ja: '画像を見る', ko: '이미지 보기', pt: 'Ver imagens', ru: 'Смотреть изображения',
    zh: '查看图片'
  };
  var viewImagesText = viewImagesLabels[navLang] || viewImagesLabels[navLang.split('-')[0]] || viewImagesLabels.en;

  function safeHref(url) {
    try {
      var u = new URL(url, window.location.href);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
    } catch (e) {}
    return null;
  }

  // Inject (or refresh) the action chip inside the shared tooltip for the given
  // annotation. Passing null just clears any previously injected chip.
  function injectChip(ann) {
    var tip = document.querySelector('.sse-annotation');
    if (!tip) return;
    var existing = tip.querySelector('.ss-annotation-link');
    if (existing) existing.remove();
    if (!ann) return;
    var extras = ann.extras || {};
    var images = extras.images;
    if (images && images.length) {
      var chip = document.createElement('a');
      chip.className = 'ss-annotation-link';
      chip.href = '#';
      chip.textContent = viewImagesText + ' (' + images.length + ')';
      chip.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openGallery(images, chip);
      });
      tip.appendChild(chip);
      return;
    }
    var url = extras.url;
    var href = url ? safeHref(url) : null;
    if (!href) return;
    var a = document.createElement('a');
    a.className = 'ss-annotation-link';
    a.href = href;
    a.textContent = openLinkText;
    if (extras.newTab) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    // keep the tooltip open (the viewer closes it on document click) and let
    // the navigation proceed normally
    a.addEventListener('click', function (e) { e.stopPropagation(); });
    tip.appendChild(a);
  }

  // Refresh the chip whenever the selection changes. supersplat-viewer >= 1.32
  // keeps the selection in state.selectedAnnotation and fires
  // 'selectedAnnotation:changed' with the index (null = deselected). The
  // viewer's own tooltip listener is registered in initUI, synchronously after
  // the handle is published, and this rAF poll only sees the handle after that,
  // so the viewer has already rewritten the shared tooltip's title/text when
  // this runs. The chip is a sibling of those nodes, so the viewer's own
  // repaints (textContent writes) never remove it.
  function start() {
    var viewer = window.__supersplatViewer;
    var global = viewer && viewer.global;
    var ev = global && global.events;
    if (!ev || !ev.on) { requestAnimationFrame(start); return; }
    ev.on('selectedAnnotation:changed', function (index) {
      closeGallery();
      var list = global.settings && global.settings.annotations;
      var ann = (index === null || index === undefined || !list) ? null : (list[index] || null);
      injectChip(ann);
    });
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
    const list = annotations || [];
    const table = buildLinkTable(list);
    // Gate on either action: a gallery-only export has an empty link table but
    // still needs the companion.
    if (table.length === 0 && !hasGallery(list)) {
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
    return `<style>${companionStyle}${galleryStyle}</style>` +
        `<script>window.__supersplatAnnotationLinks = ${tableJson};</script>` +
        `<script>${companionRuntime}</script>`;
};

export { buildAnnotationLinksInjection, buildLinkTable };
