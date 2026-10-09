// Favicon link for branded exported viewers.
//
// The exported viewer's <head> has no icon link at all, so a browser asks the
// hosting origin for /favicon.ico and falls back to a blank tab icon. The
// brand icon doubles as the favicon: brand.ts writes this link for the icon
// resolved at export time, and the page's brand runtime script corrects it on
// every load.
//
// The href is either an export-derived relative filename (./brand-icon.<ext>)
// or a validated https: URL for a hotlinked client icon, whose type is not
// known, so `mime` is optional. Both are escaped.
//
// Environment-agnostic (compiled for the export server via dist-shared):
// string operations only.

const escapeAttr = (text: string): string => text
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;');

export const faviconLinkTag = (href: string, mime?: string): string => {
    const type = mime ? ` type="${escapeAttr(mime)}"` : '';
    return `<link rel="icon"${type} href="${escapeAttr(href)}">`;
};
