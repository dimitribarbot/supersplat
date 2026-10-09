import { describe, it, expect } from 'vitest';
import { resolveBrand, validateBrandOverride } from '../src/brand-resolve.js';
import type { EnvBrand } from '../src/brand.js';

const ICON = { filename: 'brand-icon.png', mime: 'image/png', data: new Uint8Array([1]) };
const LOGO = { filename: 'brand-logo.svg', mime: 'image/svg+xml', data: new Uint8Array([2]) };
const ENV: EnvBrand = { name: 'Acme', icon: ICON, logo: LOGO, url: 'https://acme.example/' };

const C_ICON = 'https://cdn.example/client/icon.png';
const C_LOGO = 'https://cdn.example/client/logo.png';

describe('resolveBrand', () => {
    const OPERATOR = { name: 'Acme', iconHref: './brand-icon.png', iconMime: 'image/png', logoHref: './brand-logo.svg', url: 'https://acme.example/' };
    const FILES = [{ filename: 'brand-icon.png', data: ICON.data }, { filename: 'brand-logo.svg', data: LOGO.data }];

    it('returns null with no brand anywhere', () => {
        expect(resolveBrand(null)).toBeNull();
        expect(resolveBrand(null, {})).toBeNull();
        expect(resolveBrand({ name: null, icon: null, logo: null, url: 'https://acme.example/' })).toBeNull();
    });

    it('env only: embeds the operator assets, passes the operator through, no client', () => {
        expect(resolveBrand(ENV)).toEqual({ files: FILES, operator: OPERATOR, client: {} });
    });

    it('a full client brand still embeds every operator asset (for the switch back)', () => {
        const client = { name: 'Client Co', iconUrl: C_ICON, logoUrl: C_LOGO };
        expect(resolveBrand(ENV, client)).toEqual({ files: FILES, operator: OPERATOR, client });
    });

    it('passes partial client brands through unresolved (the page applies the rules)', () => {
        expect(resolveBrand(ENV, { name: 'Client Co' })!.client).toEqual({ name: 'Client Co' });
        expect(resolveBrand(ENV, { logoUrl: C_LOGO })!.client).toEqual({ logoUrl: C_LOGO });
    });

    it('omits operator fields the env does not configure', () => {
        expect(resolveBrand({ ...ENV, logo: null, url: null })).toEqual({
            files: [{ filename: 'brand-icon.png', data: ICON.data }],
            operator: { name: 'Acme', iconHref: './brand-icon.png', iconMime: 'image/png' },
            client: {}
        });
    });

    it('a client brand with no env brand at all', () => {
        expect(resolveBrand(null, { logoUrl: C_LOGO })).toEqual({ files: [], operator: {}, client: { logoUrl: C_LOGO } });
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
