import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { loadBrand, warnRemovedBrandEnv } from '../src/brand.js';
import { makeResponse, stubFetch } from './fetch-stub.js';

const ICON_URL = 'https://brand.example.com/icon.png';
const LOGO_URL = 'https://brand.example.com/logo.png';
const BYTES = new Uint8Array([1, 2, 3, 4]);

const response = makeResponse(BYTES);

const VARS = [
    'VIEWER_BRAND_NAME', 'VIEWER_BRAND_ICON_URL', 'VIEWER_BRAND_LOGO_URL', 'VIEWER_BRAND_URL',
    'VIEWER_FAVICON_URL', 'VIEWER_BRAND_FONT_NAME', 'VIEWER_BRAND_FONT_URL'
];

const setEnv = (env: Record<string, string>) => {
    for (const [k, v] of Object.entries(env)) {
        process.env[k] = v;
    }
};

beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    for (const k of VARS) {
        delete process.env[k];
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('loadBrand', () => {
    describe('when nothing is configured', () => {
        it('returns null and never fetches', async () => {
            const fetchFn = stubFetch(() => response());
            expect(await loadBrand()).toBeNull();
            expect(fetchFn).not.toHaveBeenCalled();
        });

        it('treats whitespace-only values as unset', async () => {
            setEnv({ VIEWER_BRAND_NAME: '  ', VIEWER_BRAND_ICON_URL: '   ', VIEWER_BRAND_LOGO_URL: ' ' });
            const fetchFn = stubFetch(() => response());
            expect(await loadBrand()).toBeNull();
            expect(fetchFn).not.toHaveBeenCalled();
        });

        it('returns null when only the URL is set (it brands nothing on its own)', async () => {
            setEnv({ VIEWER_BRAND_URL: 'https://acme.example/' });
            expect(await loadBrand()).toBeNull();
        });
    });

    it('returns the name trimmed, with no fetch', async () => {
        setEnv({ VIEWER_BRAND_NAME: '  Acme  ' });
        const fetchFn = stubFetch(() => response());
        expect(await loadBrand()).toEqual({ name: 'Acme', icon: null, logo: null, url: null });
        expect(fetchFn).not.toHaveBeenCalled();
    });

    describe('logo', () => {
        it('is fetched and named from its content type', async () => {
            setEnv({ VIEWER_BRAND_LOGO_URL: LOGO_URL });
            stubFetch(() => response({ contentType: 'image/png' }));
            expect((await loadBrand())!.logo).toEqual({ filename: 'brand-logo.png', mime: 'image/png', data: BYTES });
        });

        it('drops out on a failed fetch, leaving the rest of the brand intact', async () => {
            setEnv({ VIEWER_BRAND_NAME: 'Acme', VIEWER_BRAND_LOGO_URL: LOGO_URL });
            stubFetch(() => response({ ok: false, status: 404, statusText: 'Not Found' }));
            expect(await loadBrand()).toEqual({ name: 'Acme', icon: null, logo: null, url: null });
            expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(LOGO_URL));
        });
    });

    describe('url', () => {
        it('is kept, normalised, when it is an absolute https URL', async () => {
            setEnv({ VIEWER_BRAND_NAME: 'Acme', VIEWER_BRAND_URL: 'https://ACME.example' });
            expect((await loadBrand())!.url).toBe('https://acme.example/');
        });

        it('is ignored, with a warning, when it is not https', async () => {
            setEnv({ VIEWER_BRAND_NAME: 'Acme', VIEWER_BRAND_URL: 'http://acme.example/' });
            expect((await loadBrand())!.url).toBeNull();
            expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('VIEWER_BRAND_URL'));
        });

        it('is ignored, with a warning, when it is malformed', async () => {
            setEnv({ VIEWER_BRAND_NAME: 'Acme', VIEWER_BRAND_URL: 'not a url' });
            expect((await loadBrand())!.url).toBeNull();
            expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('VIEWER_BRAND_URL'));
        });
    });

    describe('the whole brand', () => {
        it('fetches the icon and the logo and returns all four parts', async () => {
            setEnv({ VIEWER_BRAND_NAME: 'Acme', VIEWER_BRAND_ICON_URL: ICON_URL, VIEWER_BRAND_LOGO_URL: LOGO_URL, VIEWER_BRAND_URL: 'https://acme.example/' });
            stubFetch(url => (url === ICON_URL ? response({ contentType: 'image/png' }) : response({ contentType: 'image/svg+xml' })));
            const brand = await loadBrand();
            expect(brand!.name).toBe('Acme');
            expect(brand!.icon!.filename).toBe('brand-icon.png');
            expect(brand!.logo!.filename).toBe('brand-logo.svg');
            expect(brand!.url).toBe('https://acme.example/');
        });

        it('returns null when every configured asset failed and there is no name', async () => {
            setEnv({ VIEWER_BRAND_ICON_URL: ICON_URL, VIEWER_BRAND_LOGO_URL: LOGO_URL });
            stubFetch(() => response({ ok: false, status: 500, statusText: 'Server Error' }));
            expect(await loadBrand()).toBeNull();
        });

        it('no longer reads the removed font variables', async () => {
            setEnv({ VIEWER_BRAND_FONT_NAME: 'Acme Sans', VIEWER_BRAND_FONT_URL: 'https://brand.example.com/acme.woff2' });
            const fetchFn = stubFetch(() => response());
            expect(await loadBrand()).toBeNull();
            expect(fetchFn).not.toHaveBeenCalled();
        });
    });
});

describe('warnRemovedBrandEnv', () => {
    it('is silent when no removed variable is set', () => {
        warnRemovedBrandEnv();
        expect(console.warn).not.toHaveBeenCalled();
    });

    it('names each removed variable that is still set', () => {
        setEnv({ VIEWER_FAVICON_URL: 'https://x.example/f.png', VIEWER_BRAND_FONT_NAME: 'A', VIEWER_BRAND_FONT_URL: 'https://x.example/a.woff2' });
        warnRemovedBrandEnv();
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('VIEWER_FAVICON_URL'));
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('VIEWER_BRAND_ICON_URL is now also the favicon'));
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('VIEWER_BRAND_FONT_NAME'));
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('VIEWER_BRAND_FONT_URL'));
    });
});
