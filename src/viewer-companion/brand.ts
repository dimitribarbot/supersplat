// Optional brand override for the exported viewer.
//
// The stock viewer identifies itself as SuperSplat in four places: the
// document <title>, the overlay badge (`.sse-viewerBranding`, only revealed
// when the viewer is embedded cross-origin), the info panel's header
// (`.sse-viewerTitle`) and, by omission, a missing favicon. The export server
// passes the operator brand (VIEWER_BRAND_*) and, for an S3 publish, a client
// brand; the brand RULES (brand-rules.ts) are applied by the page itself on
// every load, so the operator's other application can rename a published
// scene, change its images, or switch it between operator and client mode by
// rewriting the three client metas in its index.html. See
// docs/superpowers/specs/2026-10-09-runtime-brand-switch-design.md.
//
// Two halves:
//   - injectBrand patches the page: the export-time <title>, the <style>
//     block, the export-time favicon link, the three client metas, and the
//     brand runtime script: a synchronous inline script that, during head
//     parsing, resolves the operator brand baked into it against the metas,
//     sets document.title and the favicon, and leaves the badge and panel
//     markup in window.__brandUi.
//   - injectBrandJs patches index.js (supersplat-viewer >= 1.32 builds that
//     markup from `var uiHtml = "…"`): each brand surface becomes a
//     __brandPart splice reading window.__brandUi. No brand value is ever
//     written into index.js.
//
// Environment-agnostic (compiled for the export server via dist-shared):
// string operations only.

import { brandFragments, resolveBrandView, type BrandClient, type BrandOperator } from './brand-rules';
import { faviconLinkTag } from './favicon';

const HEAD_CLOSE = '</head>';

// Injecting twice would double the style block and re-run replacements against
// an already-branded document; the marker makes the injection idempotent
// (mirrors the other companions' soft no-op posture).
const MARKER = '<!-- viewer brand applied -->';

// The stock <title>, replaced by the name resolved at export time. Link
// previews and crawlers that do not run scripts keep seeing that value.
const STOCK_NAME = 'SuperSplat Viewer';
const DOC_TITLE = `<title>${STOCK_NAME}</title>`;

// The contract with the operator's other application: it may rewrite these
// metas' content at any time; empty or missing means not set.
export const BRAND_CLIENT_METAS = {
    name: 'brand-client-name',
    icon: 'brand-client-icon',
    logo: 'brand-client-logo'
} as const;

// uiHtml anchors. Written in HTML form for readability; the JS pass searches
// for their jsString() form, which is how they appear in index.js.
const UI_HTML_DECL = 'var uiHtml = ';
const BADGE_OPEN = '<a class="sse-viewerBranding sse-hidden" target="_blank" rel="noopener noreferrer">';
const BADGE_LOGO_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="64 64 384 384" role="img" aria-label="SuperSplat">';
const BADGE_CLOSE = '<span>SuperSplat</span>\n    </a>';
const PANEL_OPEN = '<a\n                class="sse-viewerTitle"\n                href="https://github.com/playcanvas/supersplat-viewer"\n                target="_blank"\n                rel="noopener noreferrer"\n            >';
const PANEL_LOGO_OPEN = '<svg class="sse-viewerLogo" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">';
const PANEL_LABEL = '<span class="sse-title-name">SuperSplat Viewer</span>';
const PANEL_VERSION = '<span class="sse-title-version">v<span class="sse-appVersionLabel"></span></span>\n            ';
const PANEL_CLOSE = `${PANEL_VERSION}</a>`;
const PANEL_SECTIONS = '<div class="sse-infoGpu">';

const SVG_CLOSE = '</svg>';

// The uiHtml surfaces the brand runtime can replace. Each anchor becomes a
// __brandPart call returning window.__brandUi[key] when the page's brand
// runtime script set it (an empty string included) and the anchor's stock
// markup otherwise, so a page whose runtime resolved nothing, or failed,
// renders exactly the stock viewer. Nothing brand-specific is ever written
// into index.js: the same file serves every mode.
const UI_PART = '__brandPart';
const UI_PART_DECL = `var ${UI_PART} = function (key, stock) { var ui = typeof window === "undefined" ? null : window.__brandUi; return ui && typeof ui[key] === "string" ? ui[key] : stock; };\n`;

// Closes the uiHtml string literal, calls __brandPart, reopens it. `stockJs` is
// already in its escaped string-literal form.
const part = (key: string, stockJs: string): string => `"+${UI_PART}("${key}","${stockJs}")+"`;

export type BrandInput = {
    // Baked into the page's runtime script; never rewritten after export.
    operator: BrandOperator;
    // Pre-filled into the client metas.
    client: BrandClient;
};

const escapeHtml = (text: string): string => text
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;')
.replace(/'/g, '&#39;');

// Built by code point so no backslash escape appears in this file's source.
const BACKSLASH = String.fromCharCode(92);

// Escape an HTML fragment for a double-quoted JS string literal, exactly as the
// bundler wrote uiHtml: backslash, double quote, and every character that is a
// JS LineTerminator (LF, CR, U+2028, U+2029) -- any of these, left raw, would
// break the string literal (a pre-ES2019 engine even treats a raw U+2028/2029
// as a syntax error). split/join, not String.replace, so a `$` in brand text
// is never read as a pattern.
const jsString = (html: string): string => html
.split(BACKSLASH).join(BACKSLASH + BACKSLASH)
.split('"').join(`${BACKSLASH}"`)
.split('\n').join(`${BACKSLASH}n`)
.split('\r').join(`${BACKSLASH}r`)
.split(String.fromCharCode(0x2028)).join(`${BACKSLASH}u2028`)
.split(String.fromCharCode(0x2029)).join(`${BACKSLASH}u2029`);

const skip = (what: string): void => {
    console.warn(`brand: ${what} not found in the exported viewer; leaving it unbranded`);
};

// Never String.replace: a `$` in the replacement (a brand name is free text)
// would be read as a substitution pattern and corrupt the export.
const replaceOnce = (text: string, needle: string, replacement: string, what: string): string => {
    const at = text.indexOf(needle);
    if (at < 0) {
        skip(what);
        return text;
    }
    return text.slice(0, at) + replacement + text.slice(at + needle.length);
};

// Replaces a whole <svg>...</svg> element, located by its (unique) opening
// tag; `replace` receives the element's text as it stands in the input.
const replaceSvg = (text: string, openTag: string, replace: (svg: string) => string, what: string): string => {
    const at = text.indexOf(openTag);
    if (at < 0) {
        skip(what);
        return text;
    }
    const close = text.indexOf(SVG_CLOSE, at);
    if (close < 0) {
        skip(what);
        return text;
    }
    const end = close + SVG_CLOSE.length;
    return text.slice(0, at) + replace(text.slice(at, end)) + text.slice(end);
};

// The stock rules size `.sse-viewerBranding > svg` (16px badge on its dark
// rounded backdrop) and `.sse-viewerLogo` (56px, in the info panel's column
// layout); once those elements are <img>, nothing styles them, so restate the
// same metrics. object-fit keeps a wide logo's aspect once max-width clamps it.
// The div.* rules undo the stock pointer cursor and hover fade on the non-link
// variants. Rules for elements a given export lacks are inert.
const STYLE = [
    '<style id="brandStyle">',
    '.sse-viewer .sse-viewerBranding > img {',
    '    height: 16px;',
    '    width: auto;',
    '    flex-shrink: 0;',
    '    padding: 8px;',
    '    border-radius: 6px;',
    '    background-color: rgba(0, 0, 0, 0.3);',
    '}',
    '.sse-viewer div.sse-viewerBranding {',
    '    cursor: default;',
    '}',
    '.sse-viewer .sse-infoPanel > .sse-infoPanelContent > .sse-viewerTitle > img {',
    '    height: 56px;',
    '    width: auto;',
    '    max-width: 100%;',
    '    object-fit: contain;',
    '    margin-bottom: 6px;',
    '}',
    // A logo stands in for the whole icon + margin + name block (56 + 6 + 6
    // gap + 18), so the header keeps its height: 86px, then the gap and the
    // version line as before.
    '.sse-viewer .sse-infoPanel > .sse-infoPanelContent > .sse-viewerTitle > #brandTitleLogo {',
    '    height: 86px;',
    '    margin-bottom: 0;',
    '}',
    '.sse-viewer .sse-infoPanel > .sse-infoPanelContent > div.sse-viewerTitle:hover {',
    '    opacity: 1;',
    '}',
    '#brandAttribution {',
    '    padding: 0 16px;',
    '    text-align: center;',
    '    font-size: 11px;',
    '    line-height: 1.4;',
    '    color: #e0dcdd;',
    '    opacity: 0.55;',
    '}',
    '#brandAttribution > a {',
    '    color: inherit;',
    '}',
    '</style>'
].join('\n');

const hasBrand = (brand: BrandInput): boolean => {
    const operator = brand.operator || {};
    const client = brand.client || {};
    return [operator.name, operator.iconHref, operator.logoHref, client.name, client.iconUrl, client.logoUrl]
    .some(value => !!(value ?? '').trim());
};

// The operator brand as a JS object literal for an inline <script>. JSON is
// valid JS; `<` is escaped so no value (a name is free text) can close the
// script element or open an HTML comment.
const scriptJson = (value: unknown): string => JSON.stringify(value).split('<').join(`${BACKSLASH}u003c`);

// The brand runtime script. Classic and synchronous, so it runs during head
// parsing, before first paint and before the deferred index.js evaluates
// uiHtml. Wrapped in try/catch: on any failure window.__brandUi stays unset and
// every __brandPart splice renders its stock markup.
//
// BUILD TRAP: no backslash escapes and no backticks in this template other
// than the ${} injections.
const runtimeScript = (operator: BrandOperator): string => `
(function () {
  try {
    var resolveBrandView = ${resolveBrandView.toString()};
    var brandFragments = ${brandFragments.toString()};
    var operator = ${scriptJson(operator || {})};
    var meta = function (name) {
      var el = document.querySelector('meta[name="' + name + '"]');
      return el ? el.getAttribute('content') || '' : '';
    };
    var view = resolveBrandView(operator, {
      name: meta(${JSON.stringify(BRAND_CLIENT_METAS.name)}),
      iconUrl: meta(${JSON.stringify(BRAND_CLIENT_METAS.icon)}),
      logoUrl: meta(${JSON.stringify(BRAND_CLIENT_METAS.logo)})
    });
    document.title = view && view.name ? view.name : ${JSON.stringify(STOCK_NAME)};
    var link = document.querySelector('link[rel="icon"]');
    if (view && view.iconHref) {
      if (!link) {
        link = document.createElement('link');
        link.setAttribute('rel', 'icon');
        document.head.appendChild(link);
      }
      link.setAttribute('href', view.iconHref);
      if (view.iconMime) {
        link.setAttribute('type', view.iconMime);
      } else {
        link.removeAttribute('type');
      }
    } else if (link) {
      link.parentNode.removeChild(link);
    }
    if (view) {
      window.__brandUi = brandFragments(view);
    }
  } catch (e) {
    console.warn('brand: runtime failed; the viewer keeps its stock branding', e);
  }
})();
`;

// The page half of the override.
export const injectBrand = (html: string, brand: BrandInput): string => {
    if (!hasBrand(brand)) {
        return html;                    // not configured: the default, silent
    }

    const headEnd = html.indexOf(HEAD_CLOSE);
    if (headEnd < 0) {
        console.warn('brand: exported viewer html has no </head>; skipping the brand override');
        return html;
    }
    // Scan only the head, not the whole document: the companions' script blobs
    // already landed in the body by the time this runs, so a whole-document
    // scan could false-positive on one whose text happens to carry the marker.
    if (html.slice(0, headEnd).includes(MARKER)) {
        return html;
    }

    // The export-time view: what the page shows before (and, for clients that
    // do not run scripts, instead of) the runtime script's own resolution.
    const view = resolveBrandView(brand.operator, brand.client);
    let out = html;
    if (view && view.name) {
        out = replaceOnce(out, DOC_TITLE, `<title>${escapeHtml(view.name)}</title>`, 'the document title');
    }

    const client = brand.client || {};
    const metas = [
        [BRAND_CLIENT_METAS.name, client.name],
        [BRAND_CLIENT_METAS.icon, client.iconUrl],
        [BRAND_CLIENT_METAS.logo, client.logoUrl]
    ].map(([name, value]) => `<meta name="${name}" content="${escapeHtml((value ?? '').trim())}">`);

    // The favicon link comes before the runtime script so the script finds it
    // rather than adding a second one. The style block lands after the
    // viewer's own ./index.css link and wins the cascade at equal specificity.
    const block = [
        MARKER,
        STYLE,
        ...(view && view.iconHref ? [faviconLinkTag(view.iconHref, view.iconMime || undefined)] : []),
        ...metas,
        `<script id="brandRuntime">${runtimeScript(brand.operator)}</script>`
    ].join('\n        ');

    // Re-read </head>: the title replacement may have moved it.
    const end = out.indexOf(HEAD_CLOSE);
    return `${out.slice(0, end)}        ${block}\n    ${out.slice(end)}`;
};

// The uiHtml half of the override, applied to index.js: every brand surface
// becomes a __brandPart splice. Idempotent by the declaration it adds.
export const injectBrandJs = (js: string): string => {
    if (js.includes(UI_PART)) {
        return js;
    }
    // A splice without the declaration in uiHtml's scope would throw and break
    // the viewer, so without the anchor nothing is spliced at all.
    if (!js.includes(UI_HTML_DECL)) {
        skip('the ui template');
        return js;
    }

    let out = replaceOnce(js, UI_HTML_DECL, UI_PART_DECL + UI_HTML_DECL, 'the ui template');
    out = replaceOnce(out, jsString(BADGE_OPEN), part('badgeOpen', jsString(BADGE_OPEN)), 'the overlay badge');
    out = replaceSvg(out, jsString(BADGE_LOGO_OPEN), svg => part('badgeIcon', svg), 'the overlay badge logo');
    out = replaceOnce(out, jsString(BADGE_CLOSE), part('badgeClose', jsString(BADGE_CLOSE)), 'the overlay badge label');
    out = replaceOnce(out, jsString(PANEL_OPEN), part('panelOpen', jsString(PANEL_OPEN)), 'the info panel header');
    out = replaceSvg(out, jsString(PANEL_LOGO_OPEN), svg => part('panelLogo', svg), 'the info panel logo');
    out = replaceOnce(out, jsString(PANEL_LABEL), part('panelLabel', jsString(PANEL_LABEL)), 'the info panel label');
    out = replaceOnce(out, jsString(PANEL_CLOSE), jsString(PANEL_VERSION) + part('panelClose', jsString('</a>')), 'the info panel header end');
    out = replaceOnce(out, jsString(PANEL_SECTIONS), part('attribution', '') + jsString(PANEL_SECTIONS), 'the info panel sections');
    return out;
};

// Every literal the override reaches into the exported viewer for.
// test/viewer-html-anchors.test.ts asserts each still occurs exactly once in the
// viewer splat-transform ships: the html one in the page, the rest in index.js.
export const BRAND_HTML_ANCHORS = [DOC_TITLE];
export const BRAND_JS_ANCHORS = [UI_HTML_DECL, BADGE_OPEN, BADGE_LOGO_OPEN, BADGE_CLOSE, PANEL_OPEN, PANEL_LOGO_OPEN, PANEL_LABEL, PANEL_CLOSE, PANEL_SECTIONS].map(jsString);
