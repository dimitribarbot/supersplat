import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { loadBrand } from '../src/brand.js';
import { makeResponse, stubFetch } from './fetch-stub.js';

const ICON_URL = 'https://brand.example.com/logo.png';
const FONT_URL = 'https://brand.example.com/acme.woff2';
const BYTES = new Uint8Array([1, 2, 3, 4]);

const response = makeResponse(BYTES);

const setEnv = (env: Record<string, string>) => {
    for (const [k, v] of Object.entries(env)) {
        process.env[k] = v;
    }
};

beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    delete process.env.VIEWER_BRAND_NAME;
    delete process.env.VIEWER_BRAND_ICON_URL;
    delete process.env.VIEWER_BRAND_FONT_NAME;
    delete process.env.VIEWER_BRAND_FONT_URL;
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
            setEnv({ VIEWER_BRAND_NAME: '  ', VIEWER_BRAND_ICON_URL: '   ' });
            const fetchFn = stubFetch(() => response());
            expect(await loadBrand()).toBeNull();
            expect(fetchFn).not.toHaveBeenCalled();
        });
    });

    describe('name', () => {
        it('is returned trimmed, with no fetch', async () => {
            setEnv({ VIEWER_BRAND_NAME: '  Acme  ' });
            const fetchFn = stubFetch(() => response());
            expect(await loadBrand()).toEqual({ name: 'Acme', icon: null, font: null });
            expect(fetchFn).not.toHaveBeenCalled();
        });
    });

    describe('icon', () => {
        it('is fetched and named from its content type', async () => {
            setEnv({ VIEWER_BRAND_ICON_URL: ICON_URL });
            stubFetch(() => response({ contentType: 'image/png' }));
            const brand = await loadBrand();
            expect(brand!.icon).toEqual({ filename: 'brand-icon.png', mime: 'image/png', data: BYTES });
        });

        it('falls back to the URL extension when no content type is sent', async () => {
            setEnv({ VIEWER_BRAND_ICON_URL: 'https://brand.example.com/logo.svg?v=2' });
            stubFetch(() => response({ contentType: null }));
            expect((await loadBrand())!.icon!.filename).toBe('brand-icon.svg');
        });

        it('drops out on a failed fetch, leaving the rest of the brand intact', async () => {
            setEnv({ VIEWER_BRAND_NAME: 'Acme', VIEWER_BRAND_ICON_URL: ICON_URL });
            stubFetch(() => response({ ok: false, status: 404, statusText: 'Not Found' }));
            expect(await loadBrand()).toEqual({ name: 'Acme', icon: null, font: null });
            expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(ICON_URL));
        });

        it('rejects a non-image type with no usable URL extension', async () => {
            setEnv({ VIEWER_BRAND_ICON_URL: 'https://brand.example.com/logo' });
            stubFetch(() => response({ contentType: 'text/html' }));
            expect(await loadBrand()).toBeNull();
        });

        it('is not fetched for a non-http URL', async () => {
            setEnv({ VIEWER_BRAND_ICON_URL: 'file:///C:/logo.png' });
            const fetchFn = stubFetch(() => response({ contentType: 'image/png' }));
            expect(await loadBrand()).toBeNull();
            expect(fetchFn).not.toHaveBeenCalled();
        });
    });

    describe('font', () => {
        const fontEnv = { VIEWER_BRAND_FONT_NAME: 'Acme Sans', VIEWER_BRAND_FONT_URL: FONT_URL };

        it('is fetched and carries the family and the CSS format keyword', async () => {
            setEnv(fontEnv);
            stubFetch(() => response({ contentType: 'font/woff2' }));
            expect((await loadBrand())!.font).toEqual({
                family: 'Acme Sans',
                format: 'woff2',
                asset: { filename: 'brand-font.woff2', mime: 'font/woff2', data: BYTES }
            });
        });

        it('maps a .ttf to the truetype format keyword', async () => {
            setEnv({ ...fontEnv, VIEWER_BRAND_FONT_URL: 'https://brand.example.com/acme.ttf' });
            stubFetch(() => response({ contentType: 'font/ttf' }));
            const font = (await loadBrand())!.font!;
            expect(font.format).toBe('truetype');
            expect(font.asset.filename).toBe('brand-font.ttf');
        });

        it('maps an .otf to the opentype format keyword', async () => {
            setEnv({ ...fontEnv, VIEWER_BRAND_FONT_URL: 'https://brand.example.com/acme.otf' });
            stubFetch(() => response({ contentType: 'font/otf' }));
            expect((await loadBrand())!.font!.format).toBe('opentype');
        });

        it('recovers the type from the URL when the host sends octet-stream', async () => {
            setEnv(fontEnv);
            stubFetch(() => response({ contentType: 'application/octet-stream' }));
            expect((await loadBrand())!.font!.asset.filename).toBe('brand-font.woff2');
        });

        it('is skipped, with a warning, when only the family is set', async () => {
            setEnv({ VIEWER_BRAND_NAME: 'Acme', VIEWER_BRAND_FONT_NAME: 'Acme Sans' });
            const fetchFn = stubFetch(() => response());
            expect(await loadBrand()).toEqual({ name: 'Acme', icon: null, font: null });
            expect(fetchFn).not.toHaveBeenCalled();
            expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('VIEWER_BRAND_FONT_URL'));
        });

        it('is skipped, with a warning, when only the URL is set', async () => {
            setEnv({ VIEWER_BRAND_NAME: 'Acme', VIEWER_BRAND_FONT_URL: FONT_URL });
            const fetchFn = stubFetch(() => response());
            expect(await loadBrand()).toEqual({ name: 'Acme', icon: null, font: null });
            expect(fetchFn).not.toHaveBeenCalled();
            expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('VIEWER_BRAND_FONT_NAME'));
        });

        it('rejects a font that is not one of the four accepted types', async () => {
            setEnv({ ...fontEnv, VIEWER_BRAND_FONT_URL: 'https://brand.example.com/acme.eot' });
            stubFetch(() => response({ contentType: 'application/vnd.ms-fontobject' }));
            expect(await loadBrand()).toBeNull();
        });

        it('rejects a font over the 4 MiB cap', async () => {
            setEnv(fontEnv);
            stubFetch(() => response({ contentType: 'font/woff2', body: new Uint8Array(4 * 1024 * 1024 + 1) }));
            expect(await loadBrand()).toBeNull();
        });

        it('drops out on a failed fetch, leaving the rest of the brand intact', async () => {
            setEnv({ VIEWER_BRAND_NAME: 'Acme', ...fontEnv });
            stubFetch(() => { throw new Error('DNS failure'); });
            expect(await loadBrand()).toEqual({ name: 'Acme', icon: null, font: null });
        });
    });

    describe('the whole brand', () => {
        it('fetches the icon and the font and returns all three parts', async () => {
            setEnv({
                VIEWER_BRAND_NAME: 'Acme',
                VIEWER_BRAND_ICON_URL: ICON_URL,
                VIEWER_BRAND_FONT_NAME: 'Acme Sans',
                VIEWER_BRAND_FONT_URL: FONT_URL
            });
            stubFetch(url => (url === ICON_URL ?
                response({ contentType: 'image/png' }) :
                response({ contentType: 'font/woff2' })));
            const brand = await loadBrand();
            expect(brand!.name).toBe('Acme');
            expect(brand!.icon!.filename).toBe('brand-icon.png');
            expect(brand!.font!.asset.filename).toBe('brand-font.woff2');
        });

        it('returns null when every configured part failed to load', async () => {
            setEnv({ VIEWER_BRAND_ICON_URL: ICON_URL });
            stubFetch(() => response({ ok: false, status: 500, statusText: 'Server Error' }));
            expect(await loadBrand()).toBeNull();
        });
    });
});
