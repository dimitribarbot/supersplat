import { vi } from 'vitest';

// Minimal Response stand-in shared by the favicon and brand loader tests.
// Both loaders only touch ok/status/statusText/headers.get('content-type'|
// 'content-length')/body.getReader(). `body` is a single-use ReadableStream-like
// reader built from `chunks` (or a single chunk of `body`) so the incremental-
// read loop can be exercised chunk-by-chunk; `reader` is exposed on the return
// value so tests can assert on `read`/`cancel` calls directly. Pass
// `noBody: true` to simulate a response with no body at all.
export const makeResponse = (fallbackBody: Uint8Array) => (opts: {
    ok?: boolean;
    status?: number;
    statusText?: string;
    contentType?: string | null;
    contentLength?: string | null;
    body?: Uint8Array;
    chunks?: Uint8Array[];
    noBody?: boolean;
} = {}) => {
    const chunks = opts.chunks ?? [opts.body ?? fallbackBody];
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

export const stubFetch = (impl: (url: string) => any) => {
    const fn = vi.fn(async (url: any) => impl(String(url)));
    vi.stubGlobal('fetch', fn);
    return fn;
};
