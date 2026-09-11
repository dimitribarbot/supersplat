// The one language resolver every fork companion shares.
//
// The exported viewer already localizes its OWN chrome: it reads `?lang=`,
// resolves it against nine locale dictionaries and sets
// document.documentElement.lang. This module reproduces that resolution rule
// exactly, so authored content and viewer chrome can never disagree about which
// language the visitor is in.
//
// Environment-agnostic (compiled for the export server via dist-shared): no DOM
// and no engine at module scope. Only the runtime string below touches window.
//
// BUILD TRAP: template literals in this directory have their backslash escapes
// eaten at build time, so the runtime below contains no regex literals and no
// backslash escapes of any kind.

// The locale codes the editor offers and the exported viewer ships dictionaries
// for. Keep in sync with `i18n.languages` in src/ui/localization.ts.
const VIEWER_LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'ru', 'zh-CN'];

// Pure resolver. The first candidate that matches anything wins:
//   1. exact tag, case-insensitive       'pt-br' -> 'pt-BR'
//   2. base subtag                       'fr-CA' -> 'fr'
//   3. any key whose base subtag matches 'pt'    -> 'pt-BR', 'zh-TW' -> 'zh-CN'
// Falls back to 'en'. Self-contained (no module-level references) so it is also
// injected verbatim into companion runtimes via Function.toString().
const resolveLocale = (candidates: string[], keys: string[]): string => {
    const list = keys || [];
    const wanted = candidates || [];
    for (let i = 0; i < wanted.length; i++) {
        const candidate = wanted[i];
        if (!candidate) {
            continue;
        }
        const lc = String(candidate).toLowerCase();
        const base = lc.split('-')[0];
        const match = list.find(k => k.toLowerCase() === lc) ||
            list.find(k => k.toLowerCase() === base) ||
            list.find(k => k.toLowerCase().split('-')[0] === base);
        if (match) {
            return match;
        }
    }
    return 'en';
};

// Publishes window.__ssLang once, from `?lang=` then the browser's languages.
//
// Injected ONCE per export, ahead of every companion, by injectViewerLang in
// splat-export-core.ts. Companions that read window.__ssLang used to prepend
// their own copy of this block, which cost up to seven identical copies in a
// single export. The `if (window.__ssLang) return;` guard is kept regardless:
// it makes the block idempotent, so a second injection from any future path
// stays harmless.
// The two interpolations are the deliberate build-time kind (a stringified pure
// function and a constant array), not runtime template expressions.
const viewerLangRuntime = `
(function () {
  if (window.__ssLang) return;
  var resolveLocale = ${resolveLocale.toString()};
  var locales = ${JSON.stringify(VIEWER_LOCALES)};
  var param = null;
  try { param = new URL(window.location.href).searchParams.get('lang'); } catch (e) {}
  var nav = navigator.languages || (navigator.language ? [navigator.language] : []);
  window.__ssLang = resolveLocale([param].concat(Array.prototype.slice.call(nav)), locales);
})();
`;

// The HTML fragment carrying the language runtime. injectViewerLang (in
// splat-export-core.ts) places this ahead of every other companion in the
// document, so each companion's own script can read window.__ssLang at parse
// time without carrying a resolver of its own.
const buildViewerLangInjection = (): string => {
    return `<script>${viewerLangRuntime}</script>`;
};

export { VIEWER_LOCALES, resolveLocale, viewerLangRuntime, buildViewerLangInjection };
