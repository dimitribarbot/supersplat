import { describe, it, expect, vi } from 'vitest';

import { injectBrand, injectBrandJs } from '../src/viewer-companion/brand';

// Stand-in for the exported viewer's page (1.35 shape: the badge/title/panel
// markup lives in index.js's uiHtml, not in the page itself).
const HTML = `<!doctype html>
<html lang="en">
    <head>
        <title>SuperSplat Viewer</title>
        <link rel="stylesheet" href="./index.css" />
    </head>
    <body>
        <script type="module">createViewer({ container: document.body });</script>
    </body>
</html>
`;

const UI = '\n<div class="sse-ui">\n' +
    '    <a class="sse-viewerBranding sse-hidden" target="_blank" rel="noopener noreferrer">\n' +
    '        <svg xmlns="http://www.w3.org/2000/svg" viewBox="64 64 384 384" role="img" aria-label="SuperSplat">\n' +
    '            <path fill="#F26722" d="M1,2Z"/>\n' +
    '        </svg>\n' +
    '        <span>SuperSplat</span>\n' +
    '    </a>\n' +
    '            <a class="sse-viewerTitle" href="https://github.com/playcanvas/supersplat-viewer">\n' +
    '                <svg class="sse-viewerLogo" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">\n' +
    '                    <use href="#supersplatIcon" />\n' +
    '                </svg>\n' +
    '                <span class="sse-title-name">SuperSplat Viewer</span>\n' +
    '            </a>\n' +
    '            <div class="sse-infoGpu">\n' +
    '</div>\n';
// index.js carries it as `var uiHtml = "<escaped>";`
const JS = `const a = 1;\nvar uiHtml = ${JSON.stringify(UI)};\nconst b = 2;\n`;
const uiOf = (js: string): string => JSON.parse(js.slice(js.indexOf('var uiHtml = ') + 13, js.indexOf(';\nconst b')));

describe('injectBrand (html half)', () => {
    describe('with no branding configured', () => {
        it('returns the document unchanged', () => {
            expect(injectBrand(HTML, {})).toBe(HTML);
        });

        it('adds no style block', () => {
            const out = injectBrand(HTML, {});
            expect(out).not.toContain('<style');
        });
    });

    describe('name', () => {
        it('replaces the document title', () => {
            expect(injectBrand(HTML, { name: 'Acme' })).toContain('<title>Acme</title>');
        });

        it('escapes HTML metacharacters in the name', () => {
            const out = injectBrand(HTML, { name: 'A&B <"Labs">' });
            expect(out).toContain('<title>A&amp;B &lt;&quot;Labs&quot;&gt;</title>');
            expect(out).not.toContain('<"Labs">');
        });
    });

    describe('icon', () => {
        it('does not touch the title', () => {
            const out = injectBrand(HTML, { iconHref: './brand-icon.png' });
            expect(out).toContain('<title>SuperSplat Viewer</title>');
        });

        it('restyles the images to the sizes the replaced svgs had', () => {
            const out = injectBrand(HTML, { iconHref: './brand-icon.png' });
            expect(out).toContain('.sse-viewer .sse-viewerBranding > img {');
            expect(out).toContain(
                '.sse-viewer .sse-infoPanel > .sse-infoPanelContent > .sse-viewerTitle > img {\n    height: 56px;'
            );
        });

        it('caps the panel image at the panel width so a wide logo cannot overflow it', () => {
            const out = injectBrand(HTML, { iconHref: './brand-icon.png' });
            expect(out).toContain(
                '.sse-viewer .sse-infoPanel > .sse-infoPanelContent > .sse-viewerTitle > img {\n    height: 56px;\n    width: auto;\n    max-width: 100%;'
            );
        });
    });

    describe('font', () => {
        const font = { fontFamily: 'Acme Sans', fontHref: './brand-font.woff2', fontFormat: 'woff2' };

        it('declares the face against the sibling font file', () => {
            const out = injectBrand(HTML, font);
            expect(out).toContain('@font-face');
            expect(out).toContain('font-family: \'Acme Sans\';');
            expect(out).toContain('src: url(\'./brand-font.woff2\') format(\'woff2\');');
        });

        it('applies the family to the two brand labels only', () => {
            const out = injectBrand(HTML, font);
            expect(out).toContain(
                '.sse-viewer .sse-viewerBranding > span,\n.sse-viewer .sse-infoPanel > .sse-infoPanelContent > .sse-viewerTitle > .sse-title-name {\n    font-family: \'Acme Sans\''
            );
        });

        it('puts the style block after the viewer stylesheet so it wins', () => {
            const out = injectBrand(HTML, font);
            expect(out.indexOf('./index.css')).toBeLessThan(out.indexOf('@font-face'));
            expect(out.indexOf('@font-face')).toBeLessThan(out.indexOf('</head>'));
        });

        it('escapes backslashes and quotes in the family name', () => {
            const out = injectBrand(HTML, { ...font, fontFamily: 'O\'Brien\\Co' });
            expect(out).toContain('font-family: \'O\\\'Brien\\\\Co\'');
        });

        it('strips angle brackets, so the family cannot close the style block', () => {
            const out = injectBrand(HTML, { ...font, fontFamily: 'A</style><script>x' });
            expect(out).not.toContain('</style><script>');
            expect(out).toContain('@font-face');
        });
    });

    describe('robustness', () => {
        it('is idempotent (a second pass changes nothing)', () => {
            const once = injectBrand(HTML, { name: 'Acme', iconHref: './brand-icon.png' });
            const twice = injectBrand(once, { name: 'Other', iconHref: './other.png' });
            expect(twice).toBe(once);
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

describe('injectBrandJs (uiHtml half)', () => {
    describe('with no branding configured', () => {
        it('returns the js unchanged', () => {
            expect(injectBrandJs(JS, {})).toBe(JS);
        });
    });

    describe('name', () => {
        it('replaces the overlay badge label and the info panel label', () => {
            const ui = uiOf(injectBrandJs(JS, { name: 'Acme' }));
            expect(ui).toContain('<span>Acme</span>');
            expect(ui).not.toContain('<span>SuperSplat</span>');
            expect(ui).toContain('<span class="sse-title-name">Acme</span>');
            expect(ui).not.toContain('<span class="sse-title-name">SuperSplat Viewer</span>');
        });

        it('escapes HTML metacharacters in the name', () => {
            const ui = uiOf(injectBrandJs(JS, { name: 'A&B <"Labs">' }));
            expect(ui).toContain('<span>A&amp;B &lt;&quot;Labs&quot;&gt;</span>');
        });
    });

    describe('icon', () => {
        it('replaces both svg elements with img tags', () => {
            const ui = uiOf(injectBrandJs(JS, { iconHref: './brand-icon.png' }));
            expect(ui).toContain('<img id="brandBadgeIcon" src="./brand-icon.png" alt="" />');
            expect(ui).toContain('<img id="brandTitleIcon" src="./brand-icon.png" alt="" />');
            expect(ui).not.toContain('aria-label="SuperSplat"');
            expect(ui).not.toContain('sse-viewerLogo');
        });

        it('leaves both names in place when no name is configured', () => {
            const ui = uiOf(injectBrandJs(JS, { iconHref: './brand-icon.png' }));
            expect(ui).toContain('<span>SuperSplat</span>');
            expect(ui).toContain('<span class="sse-title-name">SuperSplat Viewer</span>');
        });
    });

    describe('attribution', () => {
        it('is inserted immediately before the info-panel sections', () => {
            const ui = uiOf(injectBrandJs(JS, { name: 'Acme' }));
            expect(ui).toContain('id="brandAttribution"');
            expect(ui).toContain('Based on');
            expect(ui).toContain('href="https://superspl.at/"');
            expect(ui).toContain('PlayCanvas SuperSplat Viewer');
            expect(ui.indexOf('brandAttribution')).toBeLessThan(ui.indexOf('<div class="sse-infoGpu">'));

            // Not just "somewhere before": nothing but whitespace sits between
            // the attribution div's close tag and the info-panel sections.
            const attrEnd = ui.indexOf('</div>', ui.indexOf('brandAttribution')) + '</div>'.length;
            const sectionsStart = ui.indexOf('<div class="sse-infoGpu">');
            expect(ui.slice(attrEnd, sectionsStart)).toMatch(/^\s*$/);
        });

        it('is added when only the icon is replaced', () => {
            const ui = uiOf(injectBrandJs(JS, { iconHref: './brand-icon.png' }));
            expect(ui).toContain('id="brandAttribution"');
        });
    });

    describe('font-only', () => {
        it('leaves the js unchanged', () => {
            expect(injectBrandJs(JS, { fontFamily: 'Acme Sans', fontHref: './f.woff2', fontFormat: 'woff2' })).toBe(JS);
        });
    });

    describe('robustness', () => {
        it('is idempotent (a second pass changes nothing)', () => {
            const once = injectBrandJs(JS, { name: 'Acme', iconHref: './brand-icon.png' });
            const twice = injectBrandJs(once, { name: 'Other', iconHref: './other.png' });
            expect(twice).toBe(once);
        });

        it('the result still parses', () => {
            const out = injectBrandJs(JS, { name: 'Acme', iconHref: './brand-icon.png' });
            expect(() => uiOf(out)).not.toThrow();
        });

        it('drops a name that is only whitespace', () => {
            expect(injectBrandJs(JS, { name: '   ' })).toBe(JS);
        });

        it('applies the anchors it can find and warns about one it cannot', () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            // Simulate an upstream rename of the panel label only; the badge
            // label anchor is untouched.
            const brokenUi = UI.split('<span class="sse-title-name">SuperSplat Viewer</span>')
            .join('<span class="sse-title-name">Renamed Upstream</span>');
            const brokenJs = `const a = 1;\nvar uiHtml = ${JSON.stringify(brokenUi)};\nconst b = 2;\n`;
            const ui = uiOf(injectBrandJs(brokenJs, { name: 'Acme' }));
            expect(ui).toContain('<span>Acme</span>');
            expect(ui).not.toContain('<span class="sse-title-name">Acme</span>');
            expect(ui).toContain('<span class="sse-title-name">Renamed Upstream</span>');
            expect(warn).toHaveBeenCalled();
            warn.mockRestore();
        });
    });

    describe('hostile name (Review Focus)', () => {
        it('keeps the uiHtml literal intact for a name with $, quotes, backslashes, CR and JS line terminators', () => {
            // Built by code point (not pasted/escaped inline) so no raw
            // LineTerminator character sits inside a string literal in this
            // source file itself. Placed mid-string, not trailing: name.trim()
            // (in injectBrandJs) treats CR/LS/PS as whitespace and would
            // silently strip them if they were at either end.
            const CR = String.fromCharCode(13);
            const LS = String.fromCharCode(0x2028);
            const PS = String.fromCharCode(0x2029);
            const name = `A$&"B\\C$1${CR}${LS}${PS}D$2`;
            const out = injectBrandJs(JS, { name });
            const ui = uiOf(out); // throws if the literal broke
            const escapedName = `A$&amp;&quot;B\\C$1${CR}${LS}${PS}D$2`;
            expect(ui).toContain(`<span>${escapedName}</span>`);
            expect(ui).toContain(`<span class="sse-title-name">${escapedName}</span>`);
        });
    });
});
