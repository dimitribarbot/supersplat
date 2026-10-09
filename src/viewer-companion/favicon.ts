// Favicon injection for the exported viewer.
//
// The exported viewer's <head> has a <title> and no icon link at all, so a
// browser showing an exported viewer asks the hosting origin for /favicon.ico
// and falls back to a blank tab icon. The brand icon (VIEWER_BRAND_ICON_URL,
// or a client's icon URL on an S3 publish) doubles as the favicon: the export
// core calls this with the resolved icon href.
//
// The href is either an export-derived relative filename (./brand-icon.<ext>)
// or a validated https: URL for a hotlinked client icon, whose type is not
// known, so `mime` is optional. Both are escaped.
//
// Environment-agnostic (compiled for the export server via dist-shared):
// string operations only.

const HEAD_CLOSE = '</head>';

// Injecting twice would produce two competing icon links; the marker makes the
// injection idempotent (mirrors the other companions' soft no-op posture).
const ICON_MARKER = 'rel="icon"';

const escapeAttr = (text: string): string => text
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;');

export const injectFaviconLink = (html: string, href: string, mime?: string): string => {
    const headEnd = html.indexOf(HEAD_CLOSE);
    if (headEnd < 0) {
        console.warn('favicon: exported viewer HTML has no </head>; skipping the icon link');
        return html;
    }
    // Scan only the head (everything before the first </head>), not the whole
    // document: the favicon link is injected last, after the portals /
    // off-limits / device-fallback / annotation script blobs already landed
    // in the body, so a whole-document scan could false-positive on a future
    // companion whose script text happens to contain this literal.
    if (html.slice(0, headEnd).includes(ICON_MARKER)) {
        return html;
    }
    const type = mime ? ` type="${escapeAttr(mime)}"` : '';
    const tag = `<link rel="icon"${type} href="${escapeAttr(href)}">`;
    return `${html.slice(0, headEnd)}        ${tag}\n    ${html.slice(headEnd)}`;
};
