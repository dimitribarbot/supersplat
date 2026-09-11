// Export-shaped annotation, as it appears in viewerSettingsJson.annotations
// (produced by annotations.export in src/annotations.ts).
type AnyAnnotation = {
    title?: string,
    text?: string,
    extras?: {
        url?: string,
        images?: { src: string, caption: string }[],
        i18n?: Record<string, { title?: string, text?: string, url?: string, captions?: string[] }>
    }
};

// Injection gate: an export with no translated annotation gets no companion at
// all, which keeps an untranslated export byte-identical to what it was before
// this feature existed.
const hasAnnotationTranslations = (annotations: AnyAnnotation[]): boolean => {
    return (annotations || []).some(a => Object.keys(a?.extras?.i18n ?? {}).length > 0);
};

// Apply one language's overrides to an annotation IN PLACE.
//
// In place is the whole trick. The exported viewer's annotation navigator reads
// `global.settings.annotations[i].title` live on every refresh, the link
// companion reads `extras.url` on every activation and the gallery companion
// reads `extras.images[i].caption` when it opens -- so mutating these objects
// localizes three surfaces without any of them knowing translations exist.
//
// Fallback is PER FIELD: a missing key leaves the base value untouched, so a
// half-finished translation never blanks anything.
//
// Self-contained (no module-level references) so it is injected verbatim into
// the runtime via Function.toString().
const applyAnnotationTranslation = (ann: any, lang: string): void => {
    const extras = (ann && ann.extras) || {};
    const t = (extras.i18n || {})[lang];
    if (!t) {
        return;
    }
    if (t.title) {
        ann.title = t.title;
    }
    if (t.text) {
        ann.text = t.text;
    }
    // Requiring a non-empty BASE url is INTENTIONAL, not a defensive null-check:
    // a translated url overrides a base url, it does not introduce a link the
    // base annotation never had.
    if (t.url && extras.url) {
        extras.url = t.url;
    }
    const captions = t.captions;
    const images = extras.images;
    if (captions && images) {
        for (let i = 0; i < images.length && i < captions.length; i++) {
            if (captions[i]) {
                images[i].caption = captions[i];
            }
        }
    }
};

// The runtime companion. Kept as a plain string so it is injected verbatim.
//
// BUILD TRAP: no backslash escapes, no backticks and no `${` other than the
// deliberate Function.toString() injection below.
const companionRuntime = `
(function () {
  var applyAnnotationTranslation = ${applyAnnotationTranslation.toString()};

  var lang = window.__ssLang || 'en';

  // The shared tooltip is rewritten by the viewer on every activation from the
  // engine Annotation instance's OWN copies of title/text, taken when the
  // instances were constructed -- before this companion could touch anything.
  // So the settings mutation below cannot reach it and the divs are written
  // here instead, on 'annotation.activate', which the viewer fires AFTER
  // writing them. Same hook and same ordering guarantee the link companion
  // relies on.
  function paint(ann) {
    if (!ann) return;
    var title = document.querySelector('.pc-annotation-title');
    if (title) title.textContent = ann.title || '';
    var text = document.querySelector('.pc-annotation-text');
    if (text) text.textContent = ann.text || '';
    var nav = document.querySelector('#annotationNavTitle');
    if (nav) nav.textContent = ann.title || '';
  }

  function start() {
    var viewer = window.__supersplatViewer;
    var global = viewer && viewer.global;
    var ev = global && global.events;
    var list = global && global.settings && global.settings.annotations;
    if (!ev || !ev.on || !list) { requestAnimationFrame(start); return; }

    for (var i = 0; i < list.length; i++) {
      applyAnnotationTranslation(list[i], lang);
    }

    // The navigator ran its initial refresh against the base strings, possibly
    // before this companion started, so paint the first one now. Every later
    // refresh reads the mutated objects and needs no help.
    var nav = document.querySelector('#annotationNavTitle');
    if (nav && list.length > 0) nav.textContent = list[0].title || '';

    ev.on('annotation.activate', paint);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
`;

// Produce the full HTML fragment to inject before </body>, or '' when nothing
// is translated.
const buildAnnotationI18nInjection = (annotations: AnyAnnotation[]): string => {
    if (!hasAnnotationTranslations(annotations)) {
        return '';
    }
    return `<script>${companionRuntime}</script>`;
};

export { applyAnnotationTranslation, buildAnnotationI18nInjection, hasAnnotationTranslations };
export type { AnyAnnotation };
