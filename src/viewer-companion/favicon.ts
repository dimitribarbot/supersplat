// Favicon injection for the exported viewer.
//
// The stock viewer's <head> (from splat-transform's writeHtml) carries a title
// and no icon link at all, so a browser showing an exported viewer asks the
// hosting origin for /favicon.ico and falls back to a blank tab icon. When the
// export server is configured with VIEWER_FAVICON_URL it fetches that icon,
// embeds a copy beside index.html in the ZIP, and injects the link below.
//
// The href is always an export-derived relative filename (favicon.<ext>, from a
// fixed MIME allow-list) — never the configured URL — so no operator- or
// network-supplied string is interpolated into the document.
//
// Environment-agnostic (compiled for the export server via dist-shared):
// string operations only.

const HEAD_CLOSE = '</head>';

// Injecting twice would produce two competing icon links; the marker makes the
// injection idempotent (mirrors the other companions' soft no-op posture).
const ICON_MARKER = 'rel="icon"';

export const injectFaviconLink = (html: string, href: string, mime: string): string => {
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
    const tag = `<link rel="icon" type="${mime}" href="${href}">`;
    return `${html.slice(0, headEnd)}        ${tag}\n    ${html.slice(headEnd)}`;
};
