import { describe, it, expect, vi } from 'vitest';

import { injectFaviconLink } from '../src/viewer-companion/favicon';

// Minimal stand-in for the exported viewer's <head> as writeHtml emits it:
// a title, no icon link of any kind (which is the whole reason this exists).
const HTML = `<html>
    <head>
        <title>SuperSplat Viewer</title>
        <meta charset="UTF-8">
        <link rel="stylesheet" href="./index.css">
    </head><body><div id="poster"></div></body></html>`;

describe('injectFaviconLink', () => {
    it('injects the icon link before </head>', () => {
        const out = injectFaviconLink(HTML, './favicon.png', 'image/png');
        expect(out).toContain('<link rel="icon" type="image/png" href="./favicon.png">');
        expect(out.indexOf('rel="icon"')).toBeLessThan(out.indexOf('</head>'));
    });

    it('leaves the rest of the document intact', () => {
        const out = injectFaviconLink(HTML, './favicon.svg', 'image/svg+xml');
        expect(out).toContain('<title>SuperSplat Viewer</title>');
        expect(out).toContain('<link rel="stylesheet" href="./index.css">');
        expect(out).toContain('type="image/svg+xml"');
        expect(out).toContain('<body><div id="poster"></div></body>');
    });

    it('is idempotent (a second pass adds no second link)', () => {
        const once = injectFaviconLink(HTML, './favicon.png', 'image/png');
        const twice = injectFaviconLink(once, './favicon.ico', 'image/x-icon');
        expect(twice).toBe(once);
        expect(twice.match(/rel="icon"/g)).toHaveLength(1);
    });

    it('returns HTML without </head> unchanged (soft no-op on upstream drift)', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const html = '<html><body>no head here</body></html>';
        expect(injectFaviconLink(html, './favicon.png', 'image/png')).toBe(html);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});
