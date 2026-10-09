import { describe, it, expect } from 'vitest';

import { injectBrand } from '../src/viewer-companion/brand';
import type { BrandClient, BrandOperator } from '../src/viewer-companion/brand-rules';
import { rewriteClientMeta, runBrandRuntime } from './brand-runtime-stub';

// Stand-in for the exported viewer's page (head shape of supersplat-viewer 1.35).
const HTML = `<!doctype html>
<html lang="en">
    <head>
        <title>SuperSplat Viewer</title>
        <link rel="stylesheet" href="./index.css" />
    </head>
    <body></body>
</html>
`;

const OPERATOR: BrandOperator = { name: 'Acme', iconHref: './brand-icon.png', iconMime: 'image/png', logoHref: './brand-logo.png', url: 'https://acme.example/' };
const C_ICON = 'https://cdn.example/client/icon.png';
const C_LOGO = 'https://cdn.example/client/logo.png';

const publish = (client: BrandClient = {}, operator: BrandOperator = OPERATOR) => injectBrand(HTML, { operator, client });

const setClient = (html: string, name: string, icon: string, logo: string) => {
    let out = rewriteClientMeta(html, 'brand-client-name', name);
    out = rewriteClientMeta(out, 'brand-client-icon', icon);
    return rewriteClientMeta(out, 'brand-client-logo', logo);
};

describe('brand runtime script', () => {
    it('operator mode: title, favicon and linked UI from the baked operator brand', () => {
        const r = runBrandRuntime(publish());
        expect(r.title).toBe('Acme');
        expect(r.favicon).toEqual({ rel: 'icon', type: 'image/png', href: './brand-icon.png' });
        expect(r.ui!.badgeOpen).toContain('<a class="sse-viewerBranding sse-hidden" title="Acme"');
        expect(r.ui!.panelLogo).toBe('<img id="brandTitleLogo" src="./brand-logo.png" alt="Acme" />');
        expect(r.ui!.attribution).not.toContain('Powered by');
        expect(r.warnings).toEqual([]);
    });

    it('switches operator -> client -> operator by rewriting only the metas', () => {
        const operatorPage = publish();
        const clientPage = setClient(operatorPage, 'Client Co', C_ICON, C_LOGO);

        const client = runBrandRuntime(clientPage);
        expect(client.title).toBe('Client Co');
        expect(client.favicon).toEqual({ rel: 'icon', href: C_ICON });
        expect(client.ui!.badgeOpen).toBe('<div class="sse-viewerBranding sse-hidden" title="Client Co">');
        expect(client.ui!.panelOpen).toBe('<div class="sse-viewerTitle">');
        expect(client.ui!.panelLogo).toBe(`<img id="brandTitleLogo" src="${C_LOGO}" alt="Client Co" />`);
        expect(client.ui!.attribution).toContain('Powered by <a href="https://acme.example/" target="_blank" rel="noopener noreferrer">Acme</a>');

        const back = runBrandRuntime(setClient(clientPage, '', '', ''));
        expect(back).toEqual(runBrandRuntime(operatorPage));
    });

    it('creates the favicon link when a switch brings the first icon', () => {
        const page = publish({}, { name: 'Acme' });
        expect(runBrandRuntime(page).favicon).toBeNull();
        const r = runBrandRuntime(setClient(page, 'Client Co', C_ICON, ''));
        expect(r.favicon).toEqual({ rel: 'icon', href: C_ICON });
    });

    it('removes the favicon link when a switch leaves no icon', () => {
        const page = publish({ name: 'Client Co', iconUrl: C_ICON }, { name: 'Acme' });
        expect(runBrandRuntime(page).favicon).toEqual({ rel: 'icon', href: C_ICON });
        const r = runBrandRuntime(setClient(page, '', '', ''));
        expect(r.favicon).toBeNull();
        expect(r.title).toBe('Acme');
    });

    it('falls back to the stock viewer when nothing resolves', () => {
        const page = publish({ name: 'Client Co', iconUrl: C_ICON }, {});
        const r = runBrandRuntime(setClient(page, '', '', ''));
        expect(r.title).toBe('SuperSplat Viewer');
        expect(r.favicon).toBeNull();
        expect(r.ui).toBeNull();
    });

    it('ignores a non-https client URL, with a warning', () => {
        const r = runBrandRuntime(setClient(publish(), 'Client Co', 'javascript:alert(1)', 'http://cdn.example/logo.png'));
        expect(r.title).toBe('Acme');
        expect(r.favicon!.href).toBe('./brand-icon.png');
        expect(r.warnings.length).toBeGreaterThan(0);
    });

    it('escapes a hostile client name in the fragments and sets the title as text', () => {
        const hostile = '"><script>alert(1)</script>';
        const r = runBrandRuntime(setClient(publish(), hostile, C_ICON, ''));
        expect(r.title).toBe(hostile);
        expect(r.ui!.badgeOpen).toContain('title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
        for (const fragment of Object.values(r.ui!)) {
            expect(fragment).not.toContain('<script');
        }
    });

    it('treats a deleted meta as unset', () => {
        const page = setClient(publish(), 'Client Co', C_ICON, '');
        const withoutName = page.replace(/<meta name="brand-client-name" content="[^"]*">/, '');
        expect(runBrandRuntime(withoutName).title).toBe('Acme');
    });

    it('treats whitespace-only values as unset', () => {
        expect(runBrandRuntime(setClient(publish(), '  ', `  ${C_ICON}`, ' ')).title).toBe('Acme');
    });

    it('keeps the stock UI, with a warning, when the runtime throws', () => {
        const r = runBrandRuntime(publish(), { breakDocument: true });
        expect(r.ui).toBeNull();
        expect(r.warnings[0][0]).toContain('brand: runtime failed');
    });
});
