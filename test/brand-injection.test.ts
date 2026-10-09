import { describe, it, expect, vi } from 'vitest';

import { injectBrand, injectBrandJs } from '../src/viewer-companion/brand';
import { brandFragments, resolveBrandView } from '../src/viewer-companion/brand-rules';
import { extractBrandScript, runBrandRuntime } from './brand-runtime-stub';
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

const OPERATOR = { name: 'Acme', iconHref: './brand-icon.png', iconMime: 'image/png', logoHref: './brand-logo.png', url: 'https://acme.example/' };
const ENV = { operator: OPERATOR, client: {} };
const CLIENT = { operator: OPERATOR, client: { name: 'Client Co', iconUrl: 'https://cdn.example/client/icon.png', logoUrl: 'https://cdn.example/client/logo.png' } };

describe('injectBrand (page half)', () => {
    it('returns the document unchanged when there is nothing to brand', () => {
        expect(injectBrand(HTML, { operator: {}, client: {} })).toBe(HTML);
        expect(injectBrand(HTML, { operator: { url: 'https://acme.example/' }, client: {} })).toBe(HTML);
    });

    it('writes the export-time name into a plain <title>', () => {
        const out = injectBrand(HTML, ENV);
        expect(out).toContain('<title>Acme</title>');
        expect(out).not.toContain('data-brand-name');
        expect(injectBrand(HTML, CLIENT)).toContain('<title>Client Co</title>');
    });

    it('escapes HTML metacharacters in the name and keeps a $ literal', () => {
        expect(injectBrand(HTML, { operator: { name: 'A&B <"Labs">' }, client: {} })).toContain('<title>A&amp;B &lt;&quot;Labs&quot;&gt;</title>');
        expect(injectBrand(HTML, { operator: { name: '$& Co' }, client: {} })).toContain('<title>$&amp; Co</title>');
    });

    it('leaves the stock title when no name resolves', () => {
        const out = injectBrand(HTML, { operator: { iconHref: './brand-icon.png' }, client: {} });
        expect(out).toContain('<title>SuperSplat Viewer</title>');
        expect(out).toContain('<style id="brandStyle">');
    });

    it('links the export-time icon as the favicon', () => {
        expect(injectBrand(HTML, ENV)).toContain('<link rel="icon" type="image/png" href="./brand-icon.png">');
        expect(injectBrand(HTML, CLIENT)).toContain('<link rel="icon" href="https://cdn.example/client/icon.png">');
        // `<link rel="icon"`, not `rel="icon"`: the runtime script's own source
        // carries the selector link[rel="icon"]
        expect(injectBrand(HTML, { operator: { name: 'Acme' }, client: {} })).not.toContain('<link rel="icon"');
    });

    it('pre-fills the three client metas, escaped, empty when unset', () => {
        const env = injectBrand(HTML, ENV);
        expect(env).toContain('<meta name="brand-client-name" content="">');
        expect(env).toContain('<meta name="brand-client-icon" content="">');
        expect(env).toContain('<meta name="brand-client-logo" content="">');
        const client = injectBrand(HTML, { operator: OPERATOR, client: { name: 'A"B', iconUrl: 'https://cdn.example/i.png?a=1&b=2' } });
        expect(client).toContain('<meta name="brand-client-name" content="A&quot;B">');
        expect(client).toContain('<meta name="brand-client-icon" content="https://cdn.example/i.png?a=1&amp;b=2">');
    });

    it('orders the head: stylesheet, style, favicon, metas, runtime script, </head>', () => {
        const out = injectBrand(HTML, ENV);
        const order = ['./index.css', '<style id="brandStyle">', '<link rel="icon"', 'name="brand-client-name"', '<script id="brandRuntime">', '</head>'].map(s => out.indexOf(s));
        expect(order.every(i => i > -1)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it('bakes only the operator into the runtime script', () => {
        const script = extractBrandScript(injectBrand(HTML, CLIENT));
        expect(script).toContain('"Acme"');
        expect(script).not.toContain('Client Co');
    });

    it('operator JSON cannot close the script element', () => {
        const name = 'Acme</script><!--';
        const out = injectBrand(HTML, { operator: { name }, client: {} });
        expect(out.split('</script>').length - 1).toBe(HTML.split('</script>').length);
        expect(runBrandRuntime(out).title).toBe(name);
    });

    it('styles the replacement images and the non-link variants', () => {
        const out = injectBrand(HTML, ENV);
        expect(out).toContain('.sse-viewer .sse-viewerBranding > img {\n    height: 16px;');
        expect(out).toContain('.sse-viewer div.sse-viewerBranding {\n    cursor: default;\n}');
        expect(out).toContain('    max-width: 100%;\n    object-fit: contain;');
        expect(out).toContain('div.sse-viewerTitle:hover {\n    opacity: 1;\n}');
        expect(out).toContain('#brandAttribution {');
    });

    it('sizes the panel logo to the icon + margin + name block it replaces (56 + 6 + 6 + 18 = 86px)', () => {
        const out = injectBrand(HTML, ENV);
        expect(out).toContain('.sse-viewer .sse-infoPanel > .sse-infoPanelContent > .sse-viewerTitle > #brandTitleLogo {\n    height: 86px;\n    margin-bottom: 0;\n}');
        expect(out.indexOf('> #brandTitleLogo {')).toBeGreaterThan(out.indexOf('.sse-viewerTitle > img {'));
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

    it('warns but still brands when the stock title has moved', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const out = injectBrand(HTML.replace('<title>SuperSplat Viewer</title>', '<title>Other</title>'), ENV);
        expect(out).toContain('<title>Other</title>');
        expect(out).toContain('<script id="brandRuntime">');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('document title'));
        warn.mockRestore();
    });
});

describe('injectBrandJs (uiHtml half)', () => {
    const OPERATOR_VIEW = resolveBrandView({ name: 'Acme', iconHref: './brand-icon.png', iconMime: 'image/png', url: 'https://acme.example/' }, {})!;
    const CLIENT_VIEW = resolveBrandView({ name: 'Acme', url: 'https://acme.example/' }, { name: 'Client Co', iconUrl: 'https://cdn.example/client/icon.png' })!;
    const js = injectBrandJs(JS);

    it('renders the exact stock uiHtml when the brand runtime left no fragments', () => {
        expect(renderUiHtml(js)).toBe(UI);
        expect(renderUiHtml(js, {})).toBe(UI);
    });

    it('declares __brandPart right before uiHtml, on one line', () => {
        const at = js.indexOf('var __brandPart = ');
        expect(at).toBeGreaterThan(-1);
        expect(js.indexOf('var uiHtml = ')).toBe(js.indexOf('\n', at) + 1);
    });

    it('__brandPart returns a fragment string (even empty), else the stock markup', () => {
        const at = js.indexOf('var __brandPart = ');
        const decl = js.slice(at, js.indexOf('\n', at));
        const part = (win: unknown) => new Function('window', `${decl}\nreturn __brandPart;`)(win) as (key: string, stock: string) => string;
        expect(part(undefined)('k', 'stock')).toBe('stock');
        expect(part({})('k', 'stock')).toBe('stock');
        expect(part({ __brandUi: { k: 'x' } })('k', 'stock')).toBe('x');
        expect(part({ __brandUi: { k: '' } })('k', 'stock')).toBe('');
        expect(part({ __brandUi: { k: 3 } })('k', 'stock')).toBe('stock');
    });

    describe('operator view', () => {
        const ui = renderUiHtml(js, brandFragments(OPERATOR_VIEW));

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
            expect(ui).toContain(`<div id="brandAttribution">${BASED_ON}</div><div class="sse-infoGpu">`);
            expect(ui).not.toContain('Powered by');
        });
    });

    describe('client view', () => {
        const ui = renderUiHtml(js, brandFragments(CLIENT_VIEW));

        it('renders the badge and the panel header as non-link elements', () => {
            expect(ui).toContain(
                '<div class="sse-viewerBranding sse-hidden" title="Client Co">\n' +
                '        <img id="brandBadgeIcon" src="https://cdn.example/client/icon.png" alt="" />\n' +
                '        </div>'
            );
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

        it('shows a logo alone in the panel (the label fragment is an empty string)', () => {
            const withLogo = renderUiHtml(js, brandFragments({ ...CLIENT_VIEW, logoHref: 'https://cdn.example/client/logo.png' }));
            expect(withLogo).toContain(
                '<div class="sse-viewerTitle">\n' +
                '                <img id="brandTitleLogo" src="https://cdn.example/client/logo.png" alt="Client Co" />\n' +
                '                \n' +
                `                ${VERSION}\n`
            );
            expect(withLogo).not.toContain('sse-title-name');
        });
    });

    it('keeps the stock badge logo when the view has a name but no icon', () => {
        const ui = renderUiHtml(js, brandFragments(resolveBrandView({ name: 'Acme' }, {})!));
        expect(ui).toContain('title="Acme"');
        expect(ui).toContain('aria-label="SuperSplat"');
        expect(ui).not.toContain('<span>SuperSplat</span>');
        expect(ui).toContain('<span class="sse-title-name">Acme</span>');
    });

    it('is idempotent', () => {
        expect(injectBrandJs(js)).toBe(js);
    });

    it('leaves index.js untouched, with a warning, when the uiHtml declaration has moved', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const moved = JS.replace('var uiHtml = ', 'let uiHtml = ');
        expect(injectBrandJs(moved)).toBe(moved);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('ui template'));
        warn.mockRestore();
    });

    it('splices what it can when an anchor is missing, with a warning', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const noBadge = JS.replace('sse-viewerBranding sse-hidden', 'sse-somethingElse');
        const ui = renderUiHtml(injectBrandJs(noBadge), brandFragments(OPERATOR_VIEW));
        expect(ui).toContain('<span class="sse-title-name">Acme</span>');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('overlay badge'));
        warn.mockRestore();
    });
});
