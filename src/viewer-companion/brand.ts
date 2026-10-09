// Optional brand override for the exported viewer.
//
// The stock viewer identifies itself as SuperSplat in three places: the
// document <title>, the overlay badge (`.sse-viewerBranding`, only revealed
// when the viewer is embedded cross-origin) and the info panel's header
// (`.sse-viewerTitle`). The export server resolves the operator brand
// (VIEWER_BRAND_*) and, for an S3 publish, an optional per-publish client
// brand into one BrandInjection (server/src/brand-resolve.ts), and this file
// swaps the surfaces. See
// docs/superpowers/specs/2026-10-09-publish-brand-override-design.md.
//
// supersplat-viewer >= 1.32 builds its badge and info-panel markup from a JS
// string (`var uiHtml = "…"` in index.js) rather than baking it into the page,
// so the override has two halves: injectBrand patches the page (the <title>
// and the injected <style>), injectBrandJs patches index.js's uiHtml literal.
//
// The name is written exactly once, into `<title data-brand-name>`. The badge
// tooltip and the panel label read it back from document.title when uiHtml is
// evaluated (index.js is a deferred module, so the head is parsed by then, and
// the viewer never writes document.title itself), so renaming a published
// scene only means rewriting that one element in its index.html.
//
// Environment-agnostic (compiled for the export server via dist-shared):
// string operations only.

const HEAD_CLOSE = '</head>';

// Injecting twice would double the style block and re-run replacements against
// an already-branded document; the marker makes the injection idempotent
// (mirrors the other companions' soft no-op posture).
const MARKER = '<!-- viewer brand applied -->';

// The <title> is the one brand surface left in the page itself.
const DOC_TITLE = '<title>SuperSplat Viewer</title>';

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

// Attribution shown under the rebranded panel header. Placed in the info panel
// because that is where a viewer looks to find out what they are looking at,
// and it stays reachable in a standalone export -- unlike the overlay badge,
// which only ever appears inside a cross-origin iframe.
const ATTRIBUTION_URL = 'https://superspl.at/';

// Runtime read of the brand name, declared right before uiHtml (same module
// scope). HTML-escaped because it is concatenated into markup, including a
// double-quoted attribute.
const NAME_VAR = '__brandNameHtml';
const NAME_DECL = `var ${NAME_VAR} = (typeof document === "undefined" ? "" : document.title).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");\n`;

// Placeholder for the runtime name inside an HTML fragment. NUL cannot occur in
// any input (the server rejects control characters in names, URL parsing
// percent-encodes them, and env values cannot carry NUL), and jsString leaves
// it untouched, so toJs can swap it for the splice after escaping.
const NAME_TOKEN = String.fromCharCode(0);

// Closes the uiHtml string literal, concatenates the name, reopens it.
const NAME_SPLICE = `"+${NAME_VAR}+"`;

export type BrandInjection = {
    // Operator or client brand name. Escaped into the <title>; read back at
    // runtime for the badge tooltip and the panel label.
    name?: string;
    // Export-derived relative filenames (./brand-icon.png) for operator assets,
    // or validated https: URLs for a client's hotlinked images. Escaped at
    // every interpolation site.
    iconHref?: string;
    // The favicon link's type attribute; absent for a hotlinked icon.
    iconMime?: string;
    // When set, the panel header shows this logo alone (no icon, no name).
    logoHref?: string;
    // Panel header link target; absent renders the header as a non-link.
    panelHref?: string;
    // false renders the badge as a non-link element, so the viewer's own
    // runtime `href` assignment has no effect (client mode). Default true.
    badgeLink?: boolean;
    // Client mode only: "Powered by <name>", only the name linked to href.
    poweredBy?: { name: string; href?: string };
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

// jsString, then the runtime name wherever the fragment carries NAME_TOKEN.
const toJs = (html: string): string => jsString(html).split(NAME_TOKEN).join(NAME_SPLICE);

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

// Replaces a whole <svg>...</svg> element, located by its (unique) opening tag.
const replaceSvg = (text: string, openTag: string, replacement: string, what: string): string => {
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
    return text.slice(0, at) + replacement + text.slice(close + SVG_CLOSE.length);
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
    '    padding: 10px 16px 0;',
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

const hasBrand = (brand: BrandInjection): boolean => !!((brand.name ?? '').trim() || (brand.iconHref ?? '').trim() || (brand.logoHref ?? '').trim());

// The page half of the override: the <title> and the injected <style>. The
// badge and info-panel markup live in index.js's uiHtml (see injectBrandJs);
// the favicon link is added by the export core (viewer-companion/favicon.ts).
export const injectBrand = (html: string, brand: BrandInjection): string => {
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

    let out = html;
    const name = (brand.name ?? '').trim();
    if (name) {
        out = replaceOnce(out, DOC_TITLE, `<title data-brand-name>${escapeHtml(name)}</title>`, 'the document title');
    }

    // Last, so the block lands after the viewer's own ./index.css link and
    // wins the cascade at equal specificity. Re-read </head>: the replacement
    // above may have moved it.
    const end = out.indexOf(HEAD_CLOSE);
    return `${out.slice(0, end)}        ${MARKER}\n        ${STYLE}\n    ${out.slice(end)}`;
};

// The uiHtml half of the override, applied to index.js. Idempotent by the
// attribution id, which every branded pass inserts.
export const injectBrandJs = (js: string, brand: BrandInjection): string => {
    if (!hasBrand(brand)) {
        return js;
    }
    if (js.includes('brandAttribution')) {
        return js;
    }

    const name = (brand.name ?? '').trim();
    const iconHref = (brand.iconHref ?? '').trim();
    const logoHref = (brand.logoHref ?? '').trim();
    const panelHref = (brand.panelHref ?? '').trim();
    const badgeLink = brand.badgeLink !== false;

    let out = js;

    // The runtime name needs its declaration in uiHtml's scope; without the
    // anchor, a splice would reference an undeclared variable and break the
    // viewer, so fall back to no runtime name at all.
    let runtimeName = false;
    if (name) {
        if (out.includes(UI_HTML_DECL)) {
            out = replaceOnce(out, UI_HTML_DECL, NAME_DECL + UI_HTML_DECL, 'the ui template');
            runtimeName = true;
        } else {
            skip('the ui template');
        }
    }

    // Overlay badge: icon only, the name as its tooltip, a link only outside
    // client mode (the viewer sets its href to its own URL at runtime).
    const tooltip = runtimeName ? ` title="${NAME_TOKEN}"` : '';
    const badgeOpen = badgeLink ?
        `<a class="sse-viewerBranding sse-hidden"${tooltip} target="_blank" rel="noopener noreferrer">` :
        `<div class="sse-viewerBranding sse-hidden"${tooltip}>`;
    out = replaceOnce(out, jsString(BADGE_OPEN), toJs(badgeOpen), 'the overlay badge');
    out = replaceOnce(out, jsString(BADGE_CLOSE), toJs(badgeLink ? '</a>' : '</div>'), 'the overlay badge label');
    if (iconHref) {
        out = replaceSvg(out, jsString(BADGE_LOGO_OPEN), toJs(`<img id="brandBadgeIcon" src="${escapeHtml(iconHref)}" alt="" />`), 'the overlay badge logo');
    }

    // Info panel header: the operator URL or no link at all, never upstream's
    // repository; the logo alone, or the icon and the name.
    const panelOpen = panelHref ?
        `<a class="sse-viewerTitle" href="${escapeHtml(panelHref)}" target="_blank" rel="noopener noreferrer">` :
        '<div class="sse-viewerTitle">';
    out = replaceOnce(out, jsString(PANEL_OPEN), toJs(panelOpen), 'the info panel header');
    out = replaceOnce(out, jsString(PANEL_CLOSE), toJs(PANEL_VERSION + (panelHref ? '</a>' : '</div>')), 'the info panel header end');
    if (logoHref) {
        out = replaceSvg(out, jsString(PANEL_LOGO_OPEN), toJs(`<img id="brandTitleLogo" src="${escapeHtml(logoHref)}" alt="${runtimeName ? NAME_TOKEN : ''}" />`), 'the info panel logo');
        out = replaceOnce(out, jsString(PANEL_LABEL), '', 'the info panel label');
    } else {
        if (iconHref) {
            out = replaceSvg(out, jsString(PANEL_LOGO_OPEN), toJs(`<img id="brandTitleIcon" src="${escapeHtml(iconHref)}" alt="" />`), 'the info panel logo');
        }
        if (runtimeName) {
            out = replaceOnce(out, jsString(PANEL_LABEL), toJs(`<span class="sse-title-name">${NAME_TOKEN}</span>`), 'the info panel label');
        }
    }

    // Attribution, plus "Powered by" in client mode with only the name linked.
    let powered = '';
    const poweredName = (brand.poweredBy?.name ?? '').trim();
    if (poweredName) {
        const label = escapeHtml(poweredName);
        const href = (brand.poweredBy?.href ?? '').trim();
        powered = `<br />Powered by ${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label}`;
    }
    const markup = `<div id="brandAttribution">Based on <a href="${ATTRIBUTION_URL}" target="_blank" rel="noopener noreferrer">PlayCanvas SuperSplat Viewer</a>${powered}</div>\n            `;
    out = replaceOnce(out, jsString(PANEL_SECTIONS), toJs(markup + PANEL_SECTIONS), 'the info panel sections');
    return out;
};

// Every literal the override reaches into the exported viewer for.
// test/viewer-html-anchors.test.ts asserts each still occurs exactly once in the
// viewer splat-transform ships: the html one in the page, the rest in index.js.
export const BRAND_HTML_ANCHORS = [DOC_TITLE];
export const BRAND_JS_ANCHORS = [UI_HTML_DECL, BADGE_OPEN, BADGE_LOGO_OPEN, BADGE_CLOSE, PANEL_OPEN, PANEL_LOGO_OPEN, PANEL_LABEL, PANEL_CLOSE, PANEL_SECTIONS].map(jsString);
