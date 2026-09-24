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

  // supersplat-viewer >= 1.32 builds its annotation UI in initUI, synchronously
  // right after constructing the Viewer, copying each annotation's title and
  // text out of global.settings.annotations. The engine patch calls
  // window.__ssOnViewer at exactly that point (viewer-engine-patch.ts), so
  // translating the settings here lets the viewer render the visitor's language
  // natively: tooltip, navigator, and every repaint the viewer does on its own.
  // The link, gallery and iframe companions read the same mutated objects.
  // No DOM access here: initUI has not captured the UI yet.
  var previous = window.__ssOnViewer;
  window.__ssOnViewer = function (viewer) {
    if (typeof previous === 'function') { previous(viewer); }
    var global = viewer && viewer.global;
    var list = global && global.settings && global.settings.annotations;
    if (!list) { return; }
    for (var i = 0; i < list.length; i++) {
      applyAnnotationTranslation(list[i], lang);
    }
  };
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
