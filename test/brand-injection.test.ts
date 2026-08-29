import { describe, it, expect, vi } from 'vitest';

import { injectBrand } from '../src/viewer-companion/brand';

// Stand-in for the exported viewer's document, carrying the exact five anchors
// injectBrand reaches for (copied from the baked viewer; the sibling
// viewer-html-anchors.test.ts is what proves they still exist upstream).
const HTML = `<!doctype html>
<html lang="en">
    <head>
        <title>SuperSplat Viewer</title>
        <link rel="stylesheet" href="./index.css" />
    </head>
    <body>
        <div id="ui">
            <!-- SuperSplat Branding -->
            <a id="viewerBranding" class="hidden" target="_blank" rel="noopener noreferrer">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="64 64 384 384" role="img" aria-label="SuperSplat">
                    <path fill="#F26722" d="M129.83,217Z" />
                </svg>
                <span>SuperSplat</span>
            </a>
            <div id="infoPanel" class="hidden">
                <div id="infoPanelContent">
                    <a id="viewerTitle" target="_blank" rel="noopener noreferrer">
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 32 32">
                            <g class="stroke"><use href="#supersplatIcon" /></g>
                            <g class="fill"><use href="#supersplatIcon" /></g>
                        </svg>
                        <span class="title-name">SuperSplat Viewer</span>
                        <span class="title-version">v<span id="appVersionLabel"></span></span>
                    </a>
                    <div id="infoPanels">
                        <div id="desktopInfoPanel"></div>
                    </div>
                </div>
            </div>
        </div>
    </body>
</html>`;

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('injectBrand', () => {
    describe('with no branding configured', () => {
        it('returns the document unchanged', () => {
            expect(injectBrand(HTML, {})).toBe(HTML);
        });

        it('adds no attribution and no style block', () => {
            const out = injectBrand(HTML, {});
            expect(out).not.toContain('brandAttribution');
            expect(out).not.toContain('<style');
        });
    });

    describe('name', () => {
        it('replaces the document title', () => {
            expect(injectBrand(HTML, { name: 'Acme' })).toContain('<title>Acme</title>');
        });

        it('replaces the overlay badge label', () => {
            const out = injectBrand(HTML, { name: 'Acme' });
            expect(out).toContain('<span>Acme</span>');
            expect(out).not.toContain('<span>SuperSplat</span>');
        });

        it('replaces the info-panel name but keeps the version span', () => {
            const out = injectBrand(HTML, { name: 'Acme' });
            expect(out).toContain('<span class="title-name">Acme</span>');
            expect(out).toContain('<span class="title-version">v<span id="appVersionLabel"></span></span>');
        });

        it('leaves both logos in place when no icon is configured', () => {
            const out = injectBrand(HTML, { name: 'Acme' });
            expect(out).toContain('aria-label="SuperSplat"');
            expect(occurrences(out, '<use href="#supersplatIcon" />')).toBe(2);
        });

        it('escapes HTML metacharacters in the name', () => {
            const out = injectBrand(HTML, { name: 'A&B <"Labs">' });
            expect(out).toContain('<title>A&amp;B &lt;&quot;Labs&quot;&gt;</title>');
            expect(out).not.toContain('<"Labs">');
        });
    });

    describe('icon', () => {
        it('replaces the overlay badge svg with an img', () => {
            const out = injectBrand(HTML, { iconHref: './brand-icon.png' });
            expect(out).toContain('<img id="brandBadgeIcon" src="./brand-icon.png" alt="" />');
            expect(out).not.toContain('aria-label="SuperSplat"');
            expect(out).not.toContain('fill="#F26722"');
        });

        it('replaces the info-panel svg with an img', () => {
            const out = injectBrand(HTML, { iconHref: './brand-icon.png' });
            expect(out).toContain('<img id="brandTitleIcon" src="./brand-icon.png" alt="" />');
            expect(out).not.toContain('supersplatIcon');
        });

        it('keeps the two anchors that carry the images', () => {
            const out = injectBrand(HTML, { iconHref: './brand-icon.svg' });
            expect(out).toContain('<a id="viewerBranding" class="hidden"');
            expect(out).toContain('<a id="viewerTitle" target="_blank"');
        });

        it('restyles the images to the sizes the replaced svgs had', () => {
            const out = injectBrand(HTML, { iconHref: './brand-icon.png' });
            expect(out).toContain('#viewerBranding > img');
            expect(out).toContain('#viewerTitle > img');
        });

        it('leaves both names in place when no name is configured', () => {
            const out = injectBrand(HTML, { iconHref: './brand-icon.png' });
            expect(out).toContain('<span>SuperSplat</span>');
            expect(out).toContain('<span class="title-name">SuperSplat Viewer</span>');
        });
    });

    describe('font', () => {
        const font = { fontFamily: 'Acme Sans', fontHref: './brand-font.woff2', fontFormat: 'woff2' };

        it('declares the face against the sibling font file', () => {
            const out = injectBrand(HTML, font);
            expect(out).toContain('@font-face');
            expect(out).toContain("font-family: 'Acme Sans';");
            expect(out).toContain("src: url('./brand-font.woff2') format('woff2');");
        });

        it('applies the family to the two brand labels only', () => {
            const out = injectBrand(HTML, font);
            expect(out).toContain("#viewerBranding > span,\n#viewerTitle > .title-name {\n    font-family: 'Acme Sans'");
        });

        it('puts the style block after the viewer stylesheet so it wins', () => {
            const out = injectBrand(HTML, font);
            expect(out.indexOf('./index.css')).toBeLessThan(out.indexOf('@font-face'));
            expect(out.indexOf('@font-face')).toBeLessThan(out.indexOf('</head>'));
        });

        it('escapes backslashes and quotes in the family name', () => {
            const out = injectBrand(HTML, { ...font, fontFamily: "O'Brien\\Co" });
            expect(out).toContain("font-family: 'O\\'Brien\\\\Co'");
        });

        it('strips angle brackets, so the family cannot close the style block', () => {
            const out = injectBrand(HTML, { ...font, fontFamily: 'A</style><script>x' });
            expect(out).not.toContain('</style><script>');
            expect(out).toContain('@font-face');
        });
    });

    describe('attribution', () => {
        it('is added above the help sections when the name is replaced', () => {
            const out = injectBrand(HTML, { name: 'Acme' });
            expect(out).toContain('id="brandAttribution"');
            expect(out).toContain('Based on');
            expect(out).toContain('href="https://superspl.at/"');
            expect(out).toContain('PlayCanvas SuperSplat Viewer');
            expect(out.indexOf('brandAttribution')).toBeLessThan(out.indexOf('<div id="infoPanels">'));
        });

        it('is added when only the icon is replaced', () => {
            expect(injectBrand(HTML, { iconHref: './brand-icon.png' })).toContain('id="brandAttribution"');
        });

        it('is not added for a font-only override, which hides no identity', () => {
            const out = injectBrand(HTML, { fontFamily: 'Acme Sans', fontHref: './f.woff2', fontFormat: 'woff2' });
            expect(out).not.toContain('brandAttribution');
            expect(out).toContain('@font-face');
        });

        it('opens in a new tab without leaking the referrer chain', () => {
            const out = injectBrand(HTML, { name: 'Acme' });
            expect(out).toContain('<a href="https://superspl.at/" target="_blank" rel="noopener noreferrer">');
        });
    });

    describe('robustness', () => {
        it('is idempotent (a second pass changes nothing)', () => {
            const once = injectBrand(HTML, { name: 'Acme', iconHref: './brand-icon.png' });
            const twice = injectBrand(once, { name: 'Other', iconHref: './other.png' });
            expect(twice).toBe(once);
        });

        it('applies the surfaces it can find and warns about one it cannot', () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const html = HTML.replace('<span>SuperSplat</span>', '<span>Renamed Upstream</span>');
            const out = injectBrand(html, { name: 'Acme' });
            expect(out).toContain('<title>Acme</title>');
            expect(out).toContain('<span class="title-name">Acme</span>');
            expect(warn).toHaveBeenCalled();
            warn.mockRestore();
        });

        it('returns a document with no </head> unchanged', () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const html = '<html><body>no head here</body></html>';
            expect(injectBrand(html, { name: 'Acme' })).toBe(html);
            expect(warn).toHaveBeenCalled();
            warn.mockRestore();
        });

        it('drops a name that is only whitespace', () => {
            expect(injectBrand(HTML, { name: '   ' })).toBe(HTML);
        });

        it('drops a font missing either half of its configuration', () => {
            expect(injectBrand(HTML, { fontFamily: 'Acme Sans' })).toBe(HTML);
            expect(injectBrand(HTML, { fontHref: './f.woff2', fontFormat: 'woff2' })).toBe(HTML);
        });
    });
});
