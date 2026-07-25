import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { loadFavicon } from '../src/favicon.js';

const URL_PNG = 'https://icons.example.com/brand.png';
const ICON = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

// Minimal Response stand-in: loadFavicon only touches ok/status/statusText/
// headers.get('content-type'|'content-length')/body.getReader(). `body` is a
// single-use ReadableStream-like reader built from `chunks` (or a single
// chunk of `body`, defaulting to ICON) so the incremental-read loop in
// loadFavicon can be exercised chunk-by-chunk; `reader` is exposed on the
// return value so tests can assert on `read`/`cancel` calls directly. Pass
// `noBody: true` to simulate a response with no body at all.
const response = (opts: {
    ok?: boolean;
    status?: number;
    statusText?: string;
    contentType?: string | null;
    contentLength?: string | null;
    body?: Uint8Array;
    chunks?: Uint8Array[];
    noBody?: boolean;
} = {}) => {
    const chunks = opts.chunks ?? [opts.body ?? ICON];
    let i = 0;
    const reader = {
        read: vi.fn(async () => {
            if (i < chunks.length) {
                return { done: false, value: chunks[i++] };
            }
            return { done: true, value: undefined };
        }),
        cancel: vi.fn(async () => {})
    };
    return {
        ok: opts.ok ?? true,
        status: opts.status ?? 200,
        statusText: opts.statusText ?? 'OK',
        headers: {
            get: (k: string) => {
                const key = k.toLowerCase();
                if (key === 'content-type') return opts.contentType ?? null;
                if (key === 'content-length') return opts.contentLength ?? null;
                return null;
            }
        },
        body: opts.noBody ? null : { getReader: vi.fn(() => reader) },
        reader
    };
};

const stubFetch = (impl: (url: string) => any) => {
    const fn = vi.fn(async (url: any) => impl(String(url)));
    vi.stubGlobal('fetch', fn);
    return fn;
};

beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    delete process.env.VIEWER_FAVICON_URL;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('loadFavicon', () => {
    it('returns null and never fetches when the var is unset', async () => {
        const fetchFn = stubFetch(() => response());
        expect(await loadFavicon()).toBeNull();
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('returns null when the var is empty or whitespace', async () => {
        process.env.VIEWER_FAVICON_URL = '   ';
        const fetchFn = stubFetch(() => response());
        expect(await loadFavicon()).toBeNull();
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('fetches and names the icon from its content type', async () => {
        process.env.VIEWER_FAVICON_URL = URL_PNG;
        stubFetch(() => response({ contentType: 'image/png' }));
        expect(await loadFavicon()).toEqual({ filename: 'favicon.png', mime: 'image/png', data: ICON });
    });

    it('tolerates a charset parameter and odd casing in the content type', async () => {
        process.env.VIEWER_FAVICON_URL = URL_PNG;
        stubFetch(() => response({ contentType: 'IMAGE/PNG; charset=binary' }));
        expect((await loadFavicon())!.filename).toBe('favicon.png');
    });

    it('maps the Microsoft icon type to a .ico filename', async () => {
        process.env.VIEWER_FAVICON_URL = 'https://icons.example.com/brand.icon';
        stubFetch(() => response({ contentType: 'image/vnd.microsoft.icon' }));
        const fav = await loadFavicon();
        expect(fav!.filename).toBe('favicon.ico');
        expect(fav!.mime).toBe('image/vnd.microsoft.icon');
    });

    it('falls back to the URL extension when no content type is sent', async () => {
        process.env.VIEWER_FAVICON_URL = 'https://icons.example.com/brand.svg?v=2';
        stubFetch(() => response({ contentType: null }));
        expect(await loadFavicon()).toEqual({ filename: 'favicon.svg', mime: 'image/svg+xml', data: ICON });
    });

    it('returns null on a non-2xx response', async () => {
        process.env.VIEWER_FAVICON_URL = URL_PNG;
        stubFetch(() => response({ ok: false, status: 404, statusText: 'Not Found' }));
        expect(await loadFavicon()).toBeNull();
    });

    it('returns null for a non-image type with no usable URL extension', async () => {
        process.env.VIEWER_FAVICON_URL = 'https://icons.example.com/brand';
        stubFetch(() => response({ contentType: 'text/html' }));
        expect(await loadFavicon()).toBeNull();
    });

    it('falls back to the URL extension when the content type is unrecognised (not just missing)', async () => {
        process.env.VIEWER_FAVICON_URL = URL_PNG;
        stubFetch(() => response({ contentType: 'text/html' }));
        expect(await loadFavicon()).toEqual({ filename: 'favicon.png', mime: 'image/png', data: ICON });
    });

    it('rejects a "__proto__" content type instead of treating it as a match', async () => {
        // No usable URL extension either, so a wrongly-accepted content type
        // (via the prototype chain) is the only way this could pass.
        process.env.VIEWER_FAVICON_URL = 'https://icons.example.com/brand';
        stubFetch(() => response({ contentType: '__proto__' }));
        expect(await loadFavicon()).toBeNull();
    });

    it('rejects a "constructor" content type instead of treating it as a match', async () => {
        process.env.VIEWER_FAVICON_URL = 'https://icons.example.com/brand';
        stubFetch(() => response({ contentType: 'constructor' }));
        expect(await loadFavicon()).toBeNull();
    });

    it('rejects a URL path ending in ".constructor" via the extension fallback', async () => {
        process.env.VIEWER_FAVICON_URL = 'https://icons.example.com/brand.constructor';
        stubFetch(() => response({ contentType: null }));
        expect(await loadFavicon()).toBeNull();
    });

    it('returns null when the icon exceeds the 1 MiB cap', async () => {
        process.env.VIEWER_FAVICON_URL = URL_PNG;
        stubFetch(() => response({ contentType: 'image/png', body: new Uint8Array(1024 * 1024 + 1) }));
        expect(await loadFavicon()).toBeNull();
    });

    it('rejects an over-cap advertised Content-Length without reading the body', async () => {
        process.env.VIEWER_FAVICON_URL = URL_PNG;
        const res = response({ contentType: 'image/png', contentLength: String(1024 * 1024 + 1) });
        stubFetch(() => res);
        expect(await loadFavicon()).toBeNull();
        expect(res.body.getReader).not.toHaveBeenCalled();
    });

    it('bounds memory with no Content-Length: aborts once chunked total exceeds the cap', async () => {
        process.env.VIEWER_FAVICON_URL = URL_PNG;
        const chunk = new Uint8Array(600 * 1024).fill(1);
        const res = response({ contentType: 'image/png', contentLength: null, chunks: [chunk, chunk] });
        stubFetch(() => res);
        expect(await loadFavicon()).toBeNull();
        expect(res.reader.cancel).toHaveBeenCalled();
    });

    it('succeeds normally when no Content-Length header is sent', async () => {
        process.env.VIEWER_FAVICON_URL = URL_PNG;
        stubFetch(() => response({ contentType: 'image/png', contentLength: null }));
        expect(await loadFavicon()).toEqual({ filename: 'favicon.png', mime: 'image/png', data: ICON });
    });

    it('succeeds normally when Content-Length is not a valid number', async () => {
        process.env.VIEWER_FAVICON_URL = URL_PNG;
        stubFetch(() => response({ contentType: 'image/png', contentLength: 'not-a-number' }));
        expect(await loadFavicon()).toEqual({ filename: 'favicon.png', mime: 'image/png', data: ICON });
    });

    it('returns null on an empty body', async () => {
        process.env.VIEWER_FAVICON_URL = URL_PNG;
        stubFetch(() => response({ contentType: 'image/png', body: new Uint8Array(0) }));
        expect(await loadFavicon()).toBeNull();
    });

    it('returns null (without fetching) for a non-http URL', async () => {
        process.env.VIEWER_FAVICON_URL = 'file:///C:/icons/brand.png';
        const fetchFn = stubFetch(() => response({ contentType: 'image/png' }));
        expect(await loadFavicon()).toBeNull();
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('returns null (without fetching) for a malformed URL', async () => {
        process.env.VIEWER_FAVICON_URL = 'not a url';
        const fetchFn = stubFetch(() => response({ contentType: 'image/png' }));
        expect(await loadFavicon()).toBeNull();
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('returns null when the fetch rejects (timeout, DNS failure)', async () => {
        process.env.VIEWER_FAVICON_URL = URL_PNG;
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('The operation was aborted due to timeout'); }));
        expect(await loadFavicon()).toBeNull();
    });

    it('warns on every failure so a misconfiguration is visible in the log', async () => {
        process.env.VIEWER_FAVICON_URL = URL_PNG;
        stubFetch(() => response({ ok: false, status: 500, statusText: 'Server Error' }));
        await loadFavicon();
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(URL_PNG));
    });
});
