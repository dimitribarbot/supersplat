import { describe, it, expect } from 'vitest';
import { resolveBrand, validateBrandOverride } from '../src/brand-resolve.js';
import type { EnvBrand } from '../src/brand.js';

const ICON = { filename: 'brand-icon.png', mime: 'image/png', data: new Uint8Array([1]) };
const LOGO = { filename: 'brand-logo.svg', mime: 'image/svg+xml', data: new Uint8Array([2]) };
const ENV: EnvBrand = { name: 'Acme', icon: ICON, logo: LOGO, url: 'https://acme.example/' };

const C_ICON = 'https://cdn.example/client/icon.png';
const C_LOGO = 'https://cdn.example/client/logo.png';

describe('resolveBrand', () => {
    it('returns null with no env brand and no override', () => {
        expect(resolveBrand(null)).toBeNull();
        expect(resolveBrand(null, {})).toBeNull();
    });

    it('env only: embeds the operator assets and links to the operator URL', () => {
        expect(resolveBrand(ENV)).toEqual({
            files: [{ filename: 'brand-icon.png', data: ICON.data }, { filename: 'brand-logo.svg', data: LOGO.data }],
            injection: {
                name: 'Acme',
                iconHref: './brand-icon.png',
                iconMime: 'image/png',
                logoHref: './brand-logo.svg',
                panelHref: 'https://acme.example/',
                badgeLink: true,
                poweredBy: undefined
            }
        });
    });

    it('env only without a URL: the panel header is not a link', () => {
        expect(resolveBrand({ ...ENV, url: null })!.injection.panelHref).toBeUndefined();
    });

    it('full client brand: hotlinks everything, embeds nothing, client mode', () => {
        expect(resolveBrand(ENV, { name: 'Client Co', iconUrl: C_ICON, logoUrl: C_LOGO })).toEqual({
            files: [],
            injection: {
                name: 'Client Co',
                iconHref: C_ICON,
                iconMime: undefined,
                logoHref: C_LOGO,
                panelHref: undefined,
                badgeLink: false,
                poweredBy: { name: 'Acme', href: 'https://acme.example/' }
            }
        });
    });

    it('a complete client pair beats the env logo in the panel', () => {
        const r = resolveBrand(ENV, { name: 'Client Co', iconUrl: C_ICON })!;
        expect(r.injection.logoHref).toBeUndefined();
        expect(r.injection.iconHref).toBe(C_ICON);
        expect(r.files).toEqual([]);
        expect(r.injection.badgeLink).toBe(false);
    });

    it('a client name alone falls back entirely to the env brand (not client mode)', () => {
        expect(resolveBrand(ENV, { name: 'Client Co' })).toEqual(resolveBrand(ENV));
    });

    it('a client icon alone falls back entirely to the env brand (not client mode)', () => {
        expect(resolveBrand(ENV, { iconUrl: C_ICON })).toEqual(resolveBrand(ENV));
    });

    it('a client logo alone: env name and icon, client logo, client mode', () => {
        const r = resolveBrand(ENV, { logoUrl: C_LOGO })!;
        expect(r.injection).toEqual({
            name: 'Acme',
            iconHref: './brand-icon.png',
            iconMime: 'image/png',
            logoHref: C_LOGO,
            panelHref: undefined,
            badgeLink: false,
            poweredBy: { name: 'Acme', href: 'https://acme.example/' }
        });
        expect(r.files).toEqual([{ filename: 'brand-icon.png', data: ICON.data }]);
    });

    it('a client logo and name without an icon: env pair, client logo', () => {
        const r = resolveBrand(ENV, { name: 'Client Co', logoUrl: C_LOGO })!;
        expect(r.injection.name).toBe('Acme');
        expect(r.injection.iconHref).toBe('./brand-icon.png');
        expect(r.injection.logoHref).toBe(C_LOGO);
        expect(r.injection.badgeLink).toBe(false);
    });

    it('client mode without an env name adds no "Powered by"', () => {
        const r = resolveBrand(null, { name: 'Client Co', iconUrl: C_ICON })!;
        expect(r.injection.poweredBy).toBeUndefined();
        expect(r.injection.badgeLink).toBe(false);
        expect(r.files).toEqual([]);
    });

    it('client mode with an env name but no URL: "Powered by" unlinked', () => {
        const r = resolveBrand({ ...ENV, url: null }, { logoUrl: C_LOGO })!;
        expect(r.injection.poweredBy).toEqual({ name: 'Acme', href: undefined });
    });

    it('a client logo with no env brand at all', () => {
        expect(resolveBrand(null, { logoUrl: C_LOGO })!.injection).toEqual({
            name: undefined,
            iconHref: undefined,
            iconMime: undefined,
            logoHref: C_LOGO,
            panelHref: undefined,
            badgeLink: false,
            poweredBy: undefined
        });
    });
});

describe('validateBrandOverride', () => {
    const ok = (raw: unknown) => {
        const r = validateBrandOverride(raw);
        expect(r.ok).toBe(true);
        return (r as { ok: true; value: unknown }).value;
    };
    const bad = (raw: unknown) => {
        const r = validateBrandOverride(raw);
        expect(r.ok).toBe(false);
        return (r as { ok: false; error: string }).error;
    };

    it('accepts an absent override', () => {
        expect(ok(undefined)).toBeUndefined();
        expect(ok(null)).toBeUndefined();
    });

    it('treats blank and whitespace-only fields as absent', () => {
        expect(ok({ name: '', iconUrl: '  ', logoUrl: '' })).toBeUndefined();
        expect(ok({ name: '  Client Co ', iconUrl: ' ' })).toEqual({ name: 'Client Co' });
    });

    it('returns only the fields provided, URLs normalised', () => {
        expect(ok({ iconUrl: 'https://CDN.example/a b.png' })).toEqual({ iconUrl: 'https://cdn.example/a%20b.png' });
        expect(ok({ name: 'Client Co', iconUrl: C_ICON, logoUrl: C_LOGO })).toEqual({ name: 'Client Co', iconUrl: C_ICON, logoUrl: C_LOGO });
    });

    it('rejects a non-object', () => {
        expect(bad('x')).toContain('brandOverride');
        expect(bad([])).toContain('brandOverride');
    });

    it('rejects a non-string field', () => {
        expect(bad({ name: 3 })).toContain('name');
        expect(bad({ logoUrl: {} })).toContain('logoUrl');
    });

    it('rejects a name over 100 characters or with control characters', () => {
        expect(bad({ name: 'x'.repeat(101) })).toContain('name');
        expect(bad({ name: `a${String.fromCharCode(7)}b` })).toContain('name');
        expect(ok({ name: 'x'.repeat(100) })).toEqual({ name: 'x'.repeat(100) });
    });

    it('rejects anything but an absolute https URL', () => {
        expect(bad({ iconUrl: 'http://cdn.example/i.png' })).toContain('iconUrl');
        expect(bad({ iconUrl: 'javascript:alert(1)' })).toContain('iconUrl');
        expect(bad({ iconUrl: 'https://user:pass@cdn.example/i.png' })).toContain('iconUrl');
        expect(bad({ logoUrl: 'data:image/png;base64,AAAA' })).toContain('logoUrl');
        expect(bad({ logoUrl: 'not a url' })).toContain('logoUrl');
        expect(bad({ logoUrl: '/relative.png' })).toContain('logoUrl');
    });

    it('rejects a URL over 2048 characters', () => {
        expect(bad({ iconUrl: `https://cdn.example/${'a'.repeat(2048)}` })).toContain('iconUrl');
    });
});
