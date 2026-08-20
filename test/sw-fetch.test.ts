import { describe, it, expect, beforeEach, vi } from 'vitest';

// The service worker answers requests with event.respondWith(), which makes it
// re-issue the body through its own fetch(). For a non-GET request that is
// pure harm: the Cache API cannot match a non-GET anyway, so nothing is gained,
// while the page loses ALL XMLHttpRequest upload progress events (a request
// answered by a service worker reports none) and every multi-hundred-MB upload
// takes a pointless proxy hop.
//
// That is what pinned the render upload's progress bar at 0%: neither
// xhr.upload.onprogress nor xhr.upload.onload ever fired.

type FetchHandler = (event: any) => void;

const loadFetchHandler = async (): Promise<FetchHandler> => {
    const handlers = new Map<string, FetchHandler>();
    vi.stubGlobal('self', {
        addEventListener: (type: string, fn: FetchHandler) => handlers.set(type, fn)
    });
    vi.stubGlobal('caches', {
        open: async () => ({ addAll: async () => {} }),
        keys: async () => [],
        delete: async () => true,
        // a cache hit, so the handler never falls through to the real fetch()
        // (which would reject on this test's stand-in request object)
        match: async () => ({ ok: true })
    });
    vi.resetModules();
    await import('../src/sw');
    return handlers.get('fetch')!;
};

// Minimal stand-in for a FetchEvent: records whether the worker claimed the
// request.
const fakeEvent = (method: string) => {
    const event = {
        request: { method, url: 'https://example.test/api/upload' },
        respondWith: vi.fn(),
        waitUntil: vi.fn()
    };
    return event;
};

describe('service worker fetch handler', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
    });

    it('claims GET requests so they can be served from the cache', async () => {
        const onFetch = await loadFetchHandler();
        const event = fakeEvent('GET');
        onFetch(event);
        expect(event.respondWith).toHaveBeenCalledTimes(1);
    });

    // Claiming a POST suppresses xhr.upload progress events on the page.
    it('lets POST requests go straight to the network', async () => {
        const onFetch = await loadFetchHandler();
        const event = fakeEvent('POST');
        onFetch(event);
        expect(event.respondWith).not.toHaveBeenCalled();
    });

    it.each(['PUT', 'DELETE', 'HEAD'])('lets %s requests go straight to the network', async (method) => {
        const onFetch = await loadFetchHandler();
        const event = fakeEvent(method);
        onFetch(event);
        expect(event.respondWith).not.toHaveBeenCalled();
    });
});
