import { describe, it, expect, vi } from 'vitest';

import { injectBrand, injectBrandJs } from '../src/viewer-companion/brand';
import { renderUiHtml } from './ui-html';

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

// Stand-in for index.js's uiHtml, carrying every anchor the override reaches
// for with the exact whitespace supersplat-viewer ships (pinned against the
// real bundle by test/viewer-html-anchors.test.ts).
const UI = '\n<div class="sse-ui">\n' +
    '    <a class="sse-viewerBranding sse-hidden" target="_blank" rel="noopener noreferrer">\n' +
    '        <svg xmlns="http://www.w3.org/2000/svg" viewBox="64 64 384 384" role="img" aria-label="SuperSplat">\n' +
    '            <path fill="#F26722" d="M1,2Z"/>\n' +
    '        </svg>\n' +
    '        <span>SuperSplat</span>\n' +
    '    </a>\n' +
    '            <a\n' +
    '                class="sse-viewerTitle"\n' +
    '                href="https://github.com/playcanvas/supersplat-viewer"\n' +
    '                target="_blank"\n' +
    '                rel="noopener noreferrer"\n' +
    '            >\n' +
    '                <svg class="sse-viewerLogo" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">\n' +
    '                    <use href="#supersplatIcon" />\n' +
    '                </svg>\n' +
    '                <span class="sse-title-name">SuperSplat Viewer</span>\n' +
    '                <span class="sse-title-version">v<span class="sse-appVersionLabel"></span></span>\n' +
    '            </a>\n' +
    '            <div class="sse-infoGpu">\n' +
    '</div>\n';
// index.js carries it as `var uiHtml = "<escaped>";`
const JS = `const a = 1;\nvar uiHtml = ${JSON.stringify(UI)};\nconst b = 2;\n`;

const VERSION = '<span class="sse-title-version">v<span class="sse-appVersionLabel"></span></span>';
const BASED_ON = 'Based on <a href="https://superspl.at/" target="_blank" rel="noopener noreferrer">PlayCanvas SuperSplat Viewer</a>';

const ENV = { name: 'Acme', iconHref: './brand-icon.png', iconMime: 'image/png', panelHref: 'https://acme.example/', badgeLink: true };
const CLIENT = {
    name: 'Client Co',
    iconHref: 'https://cdn.example/client/icon.png',
    badgeLink: false,
    poweredBy: { name: 'Acme', href: 'https://acme.example/' }
};

describe('injectBrand (page half)', () => {
    it('returns the document unchanged when there is nothing to brand', () => {
        expect(injectBrand(HTML, {})).toBe(HTML);
        expect(injectBrand(HTML, { panelHref: 'https://acme.example/', badgeLink: false })).toBe(HTML);
    });

    it('writes the name once, into a marked <title>', () => {
        expect(injectBrand(HTML, { name: 'Acme' })).toContain('<title data-brand-name>Acme</title>');
    });

    it('escapes HTML metacharacters in the name', () => {
        const out = injectBrand(HTML, { name: 'A&B <"Labs">' });
        expect(out).toContain('<title data-brand-name>A&amp;B &lt;&quot;Labs&quot;&gt;</title>');
    });

    it('keeps a $ in the name literal (never a replacement pattern)', () => {
        expect(injectBrand(HTML, { name: '$& Co' })).toContain('<title data-brand-name>$&amp; Co</title>');
    });

    it('leaves the stock title when only images are configured', () => {
        const out = injectBrand(HTML, { iconHref: './brand-icon.png' });
        expect(out).toContain('<title>SuperSplat Viewer</title>');
        expect(out).toContain('<style id="brandStyle">');
    });

    it('styles the replacement images and the non-link variants', () => {
        const out = injectBrand(HTML, { logoHref: './brand-logo.png' });
        expect(out).toContain('.sse-viewer .sse-viewerBranding > img {\n    height: 16px;');
        expect(out).toContain('.sse-viewer div.sse-viewerBranding {\n    cursor: default;\n}');
        expect(out).toContain('    max-width: 100%;\n    object-fit: contain;');
        expect(out).toContain('div.sse-viewerTitle:hover {\n    opacity: 1;\n}');
        expect(out).toContain('#brandAttribution {');
    });

    it('sizes the panel logo to the icon + margin + name block it replaces (56 + 6 + 6 + 18 = 86px)', () => {
        const out = injectBrand(HTML, { logoHref: './brand-logo.png' });
        expect(out).toContain('.sse-viewer .sse-infoPanel > .sse-infoPanelContent > .sse-viewerTitle > #brandTitleLogo {\n    height: 86px;\n    margin-bottom: 0;\n}');
        // after the shared panel image rule, so it also wins on order
        expect(out.indexOf('> #brandTitleLogo {')).toBeGreaterThan(out.indexOf('.sse-viewerTitle > img {'));
    });

    it('lands the style block after the stylesheet link, before </head>', () => {
        const out = injectBrand(HTML, ENV);
        const style = out.indexOf('<style id="brandStyle">');
        expect(style).toBeGreaterThan(out.indexOf('./index.css'));
        expect(style).toBeLessThan(out.indexOf('</head>'));
    });

    it('is idempotent', () => {
        const once = injectBrand(HTML, ENV);
        expect(injectBrand(once, ENV)).toBe(once);
    });

    it('is a soft no-op without </head>', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const html = '<html><body>no head</body></html>';
        expect(injectBrand(html, ENV)).toBe(html);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it('warns but still styles when the stock title has moved', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const out = injectBrand(HTML.replace('<title>SuperSplat Viewer</title>', '<title>Other</title>'), ENV);
        expect(out).toContain('<title>Other</title>');
        expect(out).toContain('<style id="brandStyle">');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('document title'));
        warn.mockRestore();
    });
});

describe('injectBrandJs (uiHtml half)', () => {
    it('returns index.js unchanged when there is nothing to brand', () => {
        expect(injectBrandJs(JS, {})).toBe(JS);
        expect(injectBrandJs(JS, { panelHref: 'https://acme.example/' })).toBe(JS);
    });

    describe('env-only brand', () => {
        const ui = renderUiHtml(injectBrandJs(JS, ENV), 'Acme');

        it('keeps the badge a link, icon only, with the name as its tooltip', () => {
            expect(ui).toContain(
                '<a class="sse-viewerBranding sse-hidden" title="Acme" target="_blank" rel="noopener noreferrer">\n' +
                '        <img id="brandBadgeIcon" src="./brand-icon.png" alt="" />\n' +
                '        </a>'
            );
            expect(ui).not.toContain('<span>SuperSplat</span>');
        });

        it('links the panel header to the operator URL, with icon and name', () => {
            expect(ui).toContain(
                '<a class="sse-viewerTitle" href="https://acme.example/" target="_blank" rel="noopener noreferrer">\n' +
                '                <img id="brandTitleIcon" src="./brand-icon.png" alt="" />\n' +
                '                <span class="sse-title-name">Acme</span>\n' +
                `                ${VERSION}\n` +
                '            </a>'
            );
            expect(ui).not.toContain('github.com');
        });

        it('adds the PlayCanvas attribution only, right before the GPU row', () => {
            expect(ui).toContain(`<div id="brandAttribution">${BASED_ON}</div>\n            <div class="sse-infoGpu">`);
            expect(ui).not.toContain('Powered by');
        });

        it('drops the panel link when no operator URL is configured', () => {
            const plain = renderUiHtml(injectBrandJs(JS, { ...ENV, panelHref: undefined }), 'Acme');
            expect(plain).toContain('<div class="sse-viewerTitle">\n');
            expect(plain).toContain(`${VERSION}\n            </div>`);
        });
    });

    describe('client mode', () => {
        const ui = renderUiHtml(injectBrandJs(JS, CLIENT), 'Client Co');

        it('renders the badge as a non-link element', () => {
            expect(ui).toContain(
                '<div class="sse-viewerBranding sse-hidden" title="Client Co">\n' +
                '        <img id="brandBadgeIcon" src="https://cdn.example/client/icon.png" alt="" />\n' +
                '        </div>'
            );
        });

        it('renders the panel header as a non-link element', () => {
            expect(ui).toContain(
                '<div class="sse-viewerTitle">\n' +
                '                <img id="brandTitleIcon" src="https://cdn.example/client/icon.png" alt="" />\n' +
                '                <span class="sse-title-name">Client Co</span>\n' +
                `                ${VERSION}\n` +
                '            </div>'
            );
        });

        it('adds "Powered by" with only the operator name linked', () => {
            expect(ui).toContain(
                `<div id="brandAttribution">${BASED_ON}<br />Powered by <a href="https://acme.example/" target="_blank" rel="noopener noreferrer">Acme</a></div>`
            );
        });

        it('leaves the operator name unlinked when no operator URL is configured', () => {
            const plain = renderUiHtml(injectBrandJs(JS, { ...CLIENT, poweredBy: { name: 'Acme' } }), 'Client Co');
            expect(plain).toContain('<br />Powered by Acme</div>');
        });

        it('shows the client logo alone in the panel when one is given', () => {
            const withLogo = renderUiHtml(injectBrandJs(JS, { ...CLIENT, logoHref: 'https://cdn.example/client/logo.png' }), 'Client Co');
            expect(withLogo).toContain(
                '<div class="sse-viewerTitle">\n' +
                '                <img id="brandTitleLogo" src="https://cdn.example/client/logo.png" alt="Client Co" />\n' +
                '                \n' +
                `                ${VERSION}\n`
            );
            expect(withLogo).not.toContain('brandTitleIcon');
            expect(withLogo).not.toContain('sse-title-name');
            // the badge keeps the icon
            expect(withLogo).toContain('<img id="brandBadgeIcon" src="https://cdn.example/client/icon.png" alt="" />');
        });
    });

    describe('the name', () => {
        it('is not baked into index.js: it is read from document.title at runtime', () => {
            const js = injectBrandJs(JS, CLIENT);
            expect(js).not.toContain('Client Co');
            const renamed = renderUiHtml(js, 'Renamed Co');
            expect(renamed).toContain('title="Renamed Co"');
            expect(renamed).toContain('<span class="sse-title-name">Renamed Co</span>');
            const logoOnly = renderUiHtml(injectBrandJs(JS, { ...CLIENT, logoHref: 'https://cdn.example/client/logo.png' }), 'Renamed Co');
            expect(logoOnly).toContain('id="brandTitleLogo" src="https://cdn.example/client/logo.png" alt="Renamed Co"');
        });

        it('is HTML-escaped by the injected runtime read', () => {
            const js = injectBrandJs(JS, ENV);
            const at = js.indexOf('var __brandNameHtml = ');
            expect(at).toBeGreaterThan(-1);
            expect(at).toBeLessThan(js.indexOf('var uiHtml = '));
            const decl = js.slice(at, js.indexOf(';\n', at) + 1);
            // our own injected declaration, evaluated against a fake document
            const read = new Function('document', `${decl}\nreturn __brandNameHtml;`) as (doc: { title: string }) => string;
            expect(read({ title: 'A&B <"x">' })).toBe('A&amp;B &lt;&quot;x&quot;&gt;');
        });

        it('is not referenced at all when there is no name', () => {
            const js = injectBrandJs(JS, { iconHref: './brand-icon.png', badgeLink: true });
            expect(js).not.toContain('__brandNameHtml');
            const ui = renderUiHtml(js);
            expect(ui).toContain('<a class="sse-viewerBranding sse-hidden" target="_blank" rel="noopener noreferrer">');
            expect(ui).toContain('<span class="sse-title-name">SuperSplat Viewer</span>');
        });

        it('keeps the stock badge logo when there is a name but no icon', () => {
            const ui = renderUiHtml(injectBrandJs(JS, { name: 'Acme', badgeLink: true }), 'Acme');
            expect(ui).toContain('title="Acme"');
            expect(ui).toContain('aria-label="SuperSplat"');
            expect(ui).not.toContain('<span>SuperSplat</span>');
            expect(ui).toContain('<span class="sse-title-name">Acme</span>');
        });

        it('is skipped, with a warning, when the uiHtml declaration has moved', () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const out = injectBrandJs(JS.replace('var uiHtml = ', 'let uiHtml = '), ENV);
            expect(out).not.toContain('__brandNameHtml');
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('ui template'));
            warn.mockRestore();
        });
    });

    it('escapes URLs for the attribute and the JS string literal', () => {
        const href = 'https://cdn.example/i.png?a=1&b="x"';
        const js = injectBrandJs(JS, { ...CLIENT, iconHref: href });
        const ui = renderUiHtml(js, 'Client Co');
        expect(ui).toContain('src="https://cdn.example/i.png?a=1&amp;b=&quot;x&quot;"');
    });

    it('keeps a $ in the operator name literal', () => {
        const ui = renderUiHtml(injectBrandJs(JS, { ...CLIENT, poweredBy: { name: '$& Co' } }), 'Client Co');
        expect(ui).toContain('Powered by $&amp; Co</div>');
    });

    it('is idempotent', () => {
        const once = injectBrandJs(JS, CLIENT);
        expect(injectBrandJs(once, CLIENT)).toBe(once);
    });

    it('brands what it can when an anchor is missing, with a warning', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const noBadge = JS.replace('sse-viewerBranding sse-hidden', 'sse-somethingElse');
        const ui = renderUiHtml(injectBrandJs(noBadge, ENV), 'Acme');
        expect(ui).toContain('<span class="sse-title-name">Acme</span>');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('overlay badge'));
        warn.mockRestore();
    });
});
