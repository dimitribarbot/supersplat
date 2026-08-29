// Optional brand override for the exported viewer.
//
// The stock viewer identifies itself as SuperSplat in three places: the
// document <title>, the overlay badge (`#viewerBranding`, only revealed when
// the viewer is embedded cross-origin) and the info panel's header
// (`#viewerTitle`). When the export server is configured with VIEWER_BRAND_NAME
// / VIEWER_BRAND_ICON_URL / VIEWER_BRAND_FONT_NAME + VIEWER_BRAND_FONT_URL it
// fetches the assets, stores them beside index.html and swaps all three here.
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
// Upstream's info-panel logo is `<use href="#supersplatIcon" />` twice over a
// symbol that is defined NOWHERE in the shipped viewer, so that header renders
// text-only today. Replacing it with a real <img> is therefore a repair as well
// as a rebrand -- do not read the dead <use> as evidence of a symbol to match.
//
// Environment-agnostic (compiled for the export server via dist-shared):
// string operations only.

const HEAD_CLOSE = '</head>';

// Injecting twice would double the style block and re-run replacements against
// an already-branded document; the marker makes the injection idempotent
// (mirrors the other companions' soft no-op posture).
const MARKER = '<!-- viewer brand applied -->';

// The five anchors in the baked viewer's html. Each one is unique in that
// document, and test/viewer-html-anchors.test.ts asserts they still are --
// a failure there means an upstream bump moved a seam.
const DOC_TITLE = '<title>SuperSplat Viewer</title>';
const BADGE_LOGO_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="64 64 384 384" role="img" aria-label="SuperSplat">';
const BADGE_LABEL = '<span>SuperSplat</span>';
const PANEL_LOGO_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 32 32">';
const PANEL_LABEL = '<span class="title-name">SuperSplat Viewer</span>';
const PANEL_SECTIONS = '<div id="infoPanels">';

const SVG_CLOSE = '</svg>';

// Cosmetic only -- an html comment nobody renders. Scrubbed on a best-effort
// basis (no warning if upstream reworded it) so that "view source" on a
// white-labelled export does not still announce the stock brand.
const BADGE_COMMENT = '<!-- SuperSplat Branding -->';

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

const skip = (what: string): void => {
    console.warn(`brand: ${what} not found in the exported viewer html; leaving it unbranded`);
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
            '#viewerBranding > span,',
            '#viewerTitle > .title-name {',
            `    font-family: '${family}', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;`,
            '}'
        );
    }

    // The stock rules size `#viewerBranding > svg` and `#viewerTitle > svg`;
    // once those elements are <img>, nothing styles them, so restate the
    // metrics (16px badge on its dark rounded backdrop, 20px panel icon).
    if (iconHref) {
        rules.push(
            '#viewerBranding > img {',
            '    height: 16px;',
            '    width: auto;',
            '    flex-shrink: 0;',
            '    padding: 8px;',
            '    border-radius: 6px;',
            '    background-color: rgba(0, 0, 0, 0.3);',
            '}',
            '#viewerTitle > img {',
            '    height: 20px;',
            '    width: auto;',
            '    flex-shrink: 0;',
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

    // Attribution follows the *identity*: a font-only override still says
    // "SuperSplat Viewer" in full, so there is nothing to attribute.
    const attribution = !!name || !!iconHref;

    let out = html;

    if (name) {
        const escaped = escapeHtml(name);
        out = replaceOnce(out, DOC_TITLE, `<title>${escaped}</title>`, 'the document title');
        out = replaceOnce(out, BADGE_LABEL, `<span>${escaped}</span>`, 'the overlay badge label');
        out = replaceOnce(out, PANEL_LABEL, `<span class="title-name">${escaped}</span>`, 'the info panel label');
    }

    if (iconHref) {
        // alt="" on both: each image sits next to a span carrying the brand
        // name, so describing it again would just double up for a screen
        // reader.
        out = replaceSvg(out, BADGE_LOGO_OPEN, `<img id="brandBadgeIcon" src="${iconHref}" alt="" />`, 'the overlay badge logo');
        out = replaceSvg(out, PANEL_LOGO_OPEN, `<img id="brandTitleIcon" src="${iconHref}" alt="" />`, 'the info panel logo');
    }

    if (attribution) {
        out = replaceOnce(out, BADGE_COMMENT, '<!-- Branding -->');
        const markup = `<div id="brandAttribution">Based on <a href="${ATTRIBUTION_URL}" target="_blank" rel="noopener noreferrer">PlayCanvas SuperSplat Viewer</a></div>`;
        out = replaceOnce(out, PANEL_SECTIONS, `${markup}\n                    ${PANEL_SECTIONS}`, 'the info panel sections');
    }

    // Last, so the block lands after the viewer's own ./index.css link and
    // wins the cascade at equal specificity. Re-read </head>: the replacements
    // above may have moved it.
    const style = styleBlock(iconHref, font, attribution);
    const end = out.indexOf(HEAD_CLOSE);
    return `${out.slice(0, end)}        ${MARKER}\n        ${style}\n    ${out.slice(end)}`;
};

// Every literal injectBrand reaches into the exported document for.
// test/viewer-html-anchors.test.ts asserts each of these still occurs exactly
// once in the viewer splat-transform actually ships, so an upstream bump that
// moves a seam fails loudly instead of silently un-branding every export.
export const BRAND_ANCHORS = [
    DOC_TITLE,
    BADGE_LOGO_OPEN,
    BADGE_LABEL,
    PANEL_LOGO_OPEN,
    PANEL_LABEL,
    PANEL_SECTIONS
];
