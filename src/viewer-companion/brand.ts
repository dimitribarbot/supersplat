// Optional brand override for the exported viewer.
//
// The stock viewer identifies itself as SuperSplat in three places: the
// document <title>, the overlay badge (`.sse-viewerBranding`, only revealed
// when the viewer is embedded cross-origin) and the info panel's header
// (`.sse-viewerTitle`). When the export server is configured with
// VIEWER_BRAND_NAME / VIEWER_BRAND_ICON_URL / VIEWER_BRAND_FONT_NAME +
// VIEWER_BRAND_FONT_URL it fetches the assets, stores them beside index.html
// and swaps all three here.
//
// supersplat-viewer >= 1.32 builds its badge and info-panel markup from a JS
// string (`var uiHtml = "…"` in index.js) rather than baking it into the page,
// so the override has two halves: injectBrand patches the page (the <title>
// and the injected <style>), injectBrandJs patches index.js's uiHtml literal
// (the badge and panel markup).
//
// The brand belongs to the deployment, not to a capture or an editing session,
// so it is configured once on the server (like VIEWER_FAVICON_URL) rather than
// chosen per export in the editor: nothing about it crosses the client ->
// server boundary, so it cannot be set or spoofed per request.
//
// The three overrides are independent -- a name with no icon keeps the stock
// logos, an icon with no name keeps the stock labels -- because each one is
// fetched and validated separately on the server and any of them may drop out.
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

// supersplat-viewer >= 1.32 builds its UI from a JS string (`var uiHtml = "…"`
// in index.js). These anchors are written in HTML form for readability; the JS
// pass searches for their jsString() form, which is how they appear in the file.
const BADGE_LOGO_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="64 64 384 384" role="img" aria-label="SuperSplat">';
const BADGE_LABEL = '<span>SuperSplat</span>';
const PANEL_LOGO_OPEN = '<svg class="sse-viewerLogo" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">';
const PANEL_LABEL = '<span class="sse-title-name">SuperSplat Viewer</span>';
const PANEL_SECTIONS = '<div class="sse-infoGpu">';

const SVG_CLOSE = '</svg>';

// Attribution shown under the rebranded panel header. Placed in the info panel
// because that is where a viewer looks to find out what they are looking at,
// and it stays reachable in a standalone export -- unlike the overlay badge,
// which only ever appears inside a cross-origin iframe.
const ATTRIBUTION_URL = 'https://superspl.at/';

export type BrandInjection = {
    // Operator-supplied (VIEWER_BRAND_NAME / VIEWER_BRAND_FONT_NAME): escaped
    // at every interpolation site below.
    name?: string;
    fontFamily?: string;
    // Export-derived relative filenames, from a fixed extension allow-list --
    // never the configured URL, so no network-supplied string reaches the
    // document (same rule as the favicon's href).
    iconHref?: string;
    fontHref?: string;
    fontFormat?: string;
};

const escapeHtml = (text: string): string => text
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;')
.replace(/'/g, '&#39;');

// The family name is interpolated into a single-quoted CSS string inside a
// <style> element, so it needs both CSS-string escaping (backslash, quote) and
// the removal of anything that could terminate the element itself. Newlines go
// too: a raw one would split the declaration.
const escapeCssString = (text: string): string => text
.replace(/[<>\r\n]/g, '')
.replace(/\\/g, '\\\\')
.replace(/'/g, '\\\'');

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
// `what` is the label to warn under; omit it for a best-effort scrub.
const replaceOnce = (html: string, needle: string, replacement: string, what?: string): string => {
    const at = html.indexOf(needle);
    if (at < 0) {
        if (what) {
            skip(what);
        }
        return html;
    }
    return html.slice(0, at) + replacement + html.slice(at + needle.length);
};

// Replaces a whole <svg>...</svg> element, located by its (unique) opening tag.
const replaceSvg = (html: string, openTag: string, replacement: string, what: string): string => {
    const at = html.indexOf(openTag);
    if (at < 0) {
        skip(what);
        return html;
    }
    const close = html.indexOf(SVG_CLOSE, at);
    if (close < 0) {
        skip(what);
        return html;
    }
    return html.slice(0, at) + replacement + html.slice(close + SVG_CLOSE.length);
};

const styleBlock = (iconHref: string, font: { family: string; href: string; format: string } | null, attribution: boolean): string => {
    const rules: string[] = [];

    if (font) {
        const family = escapeCssString(font.family);
        rules.push(
            '@font-face {',
            `    font-family: '${family}';`,
            `    src: url('${font.href}') format('${font.format}');`,
            '    font-display: swap;',
            '}',
            '.sse-viewer .sse-viewerBranding > span,',
            '.sse-viewer .sse-infoPanel > .sse-infoPanelContent > .sse-viewerTitle > .sse-title-name {',
            `    font-family: '${family}', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;`,
            '}'
        );
    }

    // The stock rules size `.sse-viewerBranding > svg` (16px badge on its dark
    // rounded backdrop) and `.sse-viewerLogo` (56px, in the info panel's
    // column layout); once those elements are <img>, nothing styles them, so
    // restate the same metrics.
    if (iconHref) {
        rules.push(
            '.sse-viewer .sse-viewerBranding > img {',
            '    height: 16px;',
            '    width: auto;',
            '    flex-shrink: 0;',
            '    padding: 8px;',
            '    border-radius: 6px;',
            '    background-color: rgba(0, 0, 0, 0.3);',
            '}',
            '.sse-viewer .sse-infoPanel > .sse-infoPanelContent > .sse-viewerTitle > img {',
            '    height: 56px;',
            '    width: auto;',
            // A very wide operator logo would otherwise overflow the panel's
            // ~320px width (the stock svg has no such risk: it is drawn from a
            // fixed viewBox).
            '    max-width: 100%;',
            '    margin-bottom: 6px;',
            '}'
        );
    }

    if (attribution) {
        rules.push(
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
            '}'
        );
    }

    return `<style id="brandStyle">\n${rules.join('\n')}\n</style>`;
};

// The page half of the override: the <title> and the injected <style>. The
// badge and info-panel markup live in index.js's uiHtml (see injectBrandJs).
export const injectBrand = (html: string, brand: BrandInjection): string => {
    const name = (brand.name ?? '').trim();
    const iconHref = (brand.iconHref ?? '').trim();
    const fontFamily = (brand.fontFamily ?? '').trim();
    const fontHref = (brand.fontHref ?? '').trim();
    const fontFormat = (brand.fontFormat ?? '').trim();

    // A font needs its family AND its file: half a configuration would emit a
    // face rule pointing at nothing, silently falling back to the stock font.
    const font = (fontFamily && fontHref && fontFormat) ?
        { family: fontFamily, href: fontHref, format: fontFormat } :
        null;

    if (!name && !iconHref && !font) {
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

    if (name) {
        const escaped = escapeHtml(name);
        out = replaceOnce(out, DOC_TITLE, `<title>${escaped}</title>`, 'the document title');
    }

    // Last, so the block lands after the viewer's own ./index.css link and
    // wins the cascade at equal specificity. Re-read </head>: the replacement
    // above may have moved it.
    const attribution = !!name || !!iconHref;
    const style = styleBlock(iconHref, font, attribution);
    const end = out.indexOf(HEAD_CLOSE);
    return `${out.slice(0, end)}        ${MARKER}\n        ${style}\n    ${out.slice(end)}`;
};

// The uiHtml half of the override, applied to index.js. Idempotent by the
// attribution id, which the first pass always inserts when there is anything to
// rebrand here (a font-only override touches only the page's <style>).
export const injectBrandJs = (js: string, brand: BrandInjection): string => {
    const name = (brand.name ?? '').trim();
    const iconHref = (brand.iconHref ?? '').trim();
    if (!name && !iconHref) {
        return js;
    }
    if (js.includes('brandAttribution')) {
        return js;
    }
    let out = js;
    if (name) {
        const escaped = escapeHtml(name);
        out = replaceOnce(out, jsString(BADGE_LABEL), jsString(`<span>${escaped}</span>`), 'the overlay badge label');
        out = replaceOnce(out, jsString(PANEL_LABEL), jsString(`<span class="sse-title-name">${escaped}</span>`), 'the info panel label');
    }
    if (iconHref) {
        out = replaceSvg(out, jsString(BADGE_LOGO_OPEN), jsString(`<img id="brandBadgeIcon" src="${iconHref}" alt="" />`), 'the overlay badge logo');
        out = replaceSvg(out, jsString(PANEL_LOGO_OPEN), jsString(`<img id="brandTitleIcon" src="${iconHref}" alt="" />`), 'the info panel logo');
    }
    const markup = `<div id="brandAttribution">Based on <a href="${ATTRIBUTION_URL}" target="_blank" rel="noopener noreferrer">PlayCanvas SuperSplat Viewer</a></div>\n            `;
    out = replaceOnce(out, jsString(PANEL_SECTIONS), jsString(markup + PANEL_SECTIONS), 'the info panel sections');
    return out;
};

// Every literal the override reaches into the exported viewer for.
// test/viewer-html-anchors.test.ts asserts each still occurs exactly once in the
// viewer splat-transform ships: the html one in the page, the rest in index.js.
export const BRAND_HTML_ANCHORS = [DOC_TITLE];
export const BRAND_JS_ANCHORS = [BADGE_LOGO_OPEN, BADGE_LABEL, PANEL_LOGO_OPEN, PANEL_LABEL, PANEL_SECTIONS].map(jsString);
