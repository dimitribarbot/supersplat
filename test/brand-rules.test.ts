import { describe, it, expect, vi } from 'vitest';

import { brandFragments, resolveBrandView, type BrandOperator } from '../src/viewer-companion/brand-rules';

const OP: BrandOperator = { name: 'Acme', iconHref: './brand-icon.png', iconMime: 'image/png', logoHref: './brand-logo.svg', url: 'https://acme.example/' };
const C_ICON = 'https://cdn.example/client/icon.png';
const C_LOGO = 'https://cdn.example/client/logo.png';
const EXTERNAL = ' target="_blank" rel="noopener noreferrer"';
const BASED_ON = `Based on <a href="https://superspl.at/"${EXTERNAL}>PlayCanvas SuperSplat Viewer</a>`;

// The page gets both functions through Function.toString(), so every case also
// runs against a copy re-created from its source text: a reference to anything
// outside the function body fails there.
const fromSource = <T>(fn: T): T => new Function(`return ${String(fn)}`)() as T;
const variants: [string, typeof resolveBrandView, typeof brandFragments][] = [
    ['imported', resolveBrandView, brandFragments],
    ['from toString()', fromSource(resolveBrandView), fromSource(brandFragments)]
];

describe.each(variants)('brand rules (%s)', (_label, resolve, fragments) => {
    const operatorView = {
        name: 'Acme',
        iconHref: './brand-icon.png',
        iconMime: 'image/png',
        logoHref: './brand-logo.svg',
        panelHref: 'https://acme.example/',
        badgeLink: true,
        poweredBy: null
    };

    describe('resolveBrandView', () => {
        it('resolves nothing without a name, icon or logo', () => {
            expect(resolve({}, {})).toBeNull();
            expect(resolve({ url: 'https://acme.example/' }, {})).toBeNull();
            expect(resolve(undefined as any, undefined as any)).toBeNull();
        });

        it('operator only: operator values, links on', () => {
            expect(resolve(OP, {})).toEqual(operatorView);
        });

        it('operator without a URL: the panel header is not a link', () => {
            expect(resolve({ ...OP, url: undefined }, {})!.panelHref).toBe('');
        });

        it('full client brand: client values, client mode', () => {
            expect(resolve(OP, { name: 'Client Co', iconUrl: C_ICON, logoUrl: C_LOGO })).toEqual({
                name: 'Client Co',
                iconHref: C_ICON,
                iconMime: '',
                logoHref: C_LOGO,
                panelHref: '',
                badgeLink: false,
                poweredBy: { name: 'Acme', href: 'https://acme.example/' }
            });
        });

        it('a complete client pair beats the operator logo', () => {
            const view = resolve(OP, { name: 'Client Co', iconUrl: C_ICON })!;
            expect(view.logoHref).toBe('');
            expect(view.iconHref).toBe(C_ICON);
            expect(view.badgeLink).toBe(false);
        });

        it('a client name or icon alone falls back entirely to the operator', () => {
            expect(resolve(OP, { name: 'Client Co' })).toEqual(operatorView);
            expect(resolve(OP, { iconUrl: C_ICON })).toEqual(operatorView);
        });

        it('a client logo alone: operator pair, client logo, client mode', () => {
            expect(resolve(OP, { logoUrl: C_LOGO })).toEqual({
                name: 'Acme',
                iconHref: './brand-icon.png',
                iconMime: 'image/png',
                logoHref: C_LOGO,
                panelHref: '',
                badgeLink: false,
                poweredBy: { name: 'Acme', href: 'https://acme.example/' }
            });
        });

        it('a client logo and name without an icon: operator pair, client logo', () => {
            const view = resolve(OP, { name: 'Client Co', logoUrl: C_LOGO })!;
            expect(view.name).toBe('Acme');
            expect(view.iconHref).toBe('./brand-icon.png');
            expect(view.logoHref).toBe(C_LOGO);
        });

        it('client mode without an operator name has no "Powered by"', () => {
            expect(resolve({}, { name: 'Client Co', iconUrl: C_ICON })!.poweredBy).toBeNull();
        });

        it('client mode with an operator name but no URL: "Powered by" unlinked', () => {
            expect(resolve({ ...OP, url: undefined }, { logoUrl: C_LOGO })!.poweredBy).toEqual({ name: 'Acme', href: '' });
        });

        it('a client logo with no operator brand at all', () => {
            expect(resolve({}, { logoUrl: C_LOGO })).toEqual({
                name: '', iconHref: '', iconMime: '', logoHref: C_LOGO, panelHref: '', badgeLink: false, poweredBy: null
            });
        });

        it('trims values and treats whitespace-only as unset', () => {
            expect(resolve(OP, { name: '  ', iconUrl: ` ${C_ICON} ` })).toEqual(operatorView);
            expect(resolve(OP, { name: ' Client Co ', iconUrl: ` ${C_ICON} ` })!.name).toBe('Client Co');
        });

        it('ignores non-string client values', () => {
            expect(resolve(OP, { name: 3 as any, iconUrl: {} as any, logoUrl: null as any })).toEqual(operatorView);
        });

        it('ignores client URLs that are not absolute https, with a warning', () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            for (const bad of ['http://cdn.example/i.png', 'javascript:alert(1)', 'https://u:p@cdn.example/i.png', '/relative.png', 'not a url', 'data:image/png;base64,AAAA']) {
                expect(resolve(OP, { name: 'Client Co', iconUrl: bad, logoUrl: bad }), bad).toEqual(operatorView);
            }
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('brand: ignoring the client'));
            warn.mockRestore();
        });

        it('normalises a client URL the way the server does', () => {
            expect(resolve(OP, { logoUrl: 'https://CDN.example/a b.png' })!.logoHref).toBe('https://cdn.example/a%20b.png');
        });
    });

    describe('brandFragments', () => {
        it('operator view: linked badge and header, logo alone, attribution only', () => {
            expect(fragments(resolve(OP, {})!)).toEqual({
                badgeOpen: `<a class="sse-viewerBranding sse-hidden" title="Acme"${EXTERNAL}>`,
                badgeIcon: '<img id="brandBadgeIcon" src="./brand-icon.png" alt="" />',
                badgeClose: '</a>',
                panelOpen: `<a class="sse-viewerTitle" href="https://acme.example/"${EXTERNAL}>`,
                panelLogo: '<img id="brandTitleLogo" src="./brand-logo.svg" alt="Acme" />',
                panelLabel: '',
                panelClose: '</a>',
                attribution: `<div id="brandAttribution">${BASED_ON}</div>`
            });
        });

        it('client pair: non-link badge and header, icon and name, "Powered by"', () => {
            expect(fragments(resolve(OP, { name: 'Client Co', iconUrl: C_ICON })!)).toEqual({
                badgeOpen: '<div class="sse-viewerBranding sse-hidden" title="Client Co">',
                badgeIcon: `<img id="brandBadgeIcon" src="${C_ICON}" alt="" />`,
                badgeClose: '</div>',
                panelOpen: '<div class="sse-viewerTitle">',
                panelLogo: `<img id="brandTitleIcon" src="${C_ICON}" alt="" />`,
                panelLabel: '<span class="sse-title-name">Client Co</span>',
                panelClose: '</div>',
                attribution: `<div id="brandAttribution">${BASED_ON}<br />Powered by <a href="https://acme.example/"${EXTERNAL}>Acme</a></div>`
            });
        });

        it('leaves the stock badge logo and label when there is no icon and no name', () => {
            const f = fragments(resolve({}, { logoUrl: C_LOGO })!);
            expect(f.badgeIcon).toBeUndefined();
            expect(f.badgeOpen).toBe('<div class="sse-viewerBranding sse-hidden">');
            expect(f.panelLogo).toBe(`<img id="brandTitleLogo" src="${C_LOGO}" alt="" />`);
            expect(f.panelLabel).toBe('');
        });

        it('keeps the stock panel logo and label when a name-less view has no icon or logo', () => {
            const f = fragments({ ...resolve(OP, {})!, iconHref: '', logoHref: '', name: '' });
            expect('panelLogo' in f).toBe(false);
            expect('panelLabel' in f).toBe(false);
        });

        it('leaves "Powered by" unlinked without an operator URL', () => {
            const f = fragments(resolve({ name: 'Acme' }, { logoUrl: C_LOGO })!);
            expect(f.attribution).toBe(`<div id="brandAttribution">${BASED_ON}<br />Powered by Acme</div>`);
        });

        it('escapes names and URLs, and keeps a $ literal', () => {
            const f = fragments(resolve({ name: '$& <"Labs">', iconHref: './i.png?a=1&b="x"' }, {})!);
            expect(f.badgeOpen).toContain('title="$&amp; &lt;&quot;Labs&quot;&gt;"');
            expect(f.badgeIcon).toBe('<img id="brandBadgeIcon" src="./i.png?a=1&amp;b=&quot;x&quot;" alt="" />');
            expect(f.panelLabel).toBe('<span class="sse-title-name">$&amp; &lt;&quot;Labs&quot;&gt;</span>');
        });
    });
});
