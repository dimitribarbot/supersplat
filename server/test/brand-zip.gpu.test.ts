import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { probeGpu, createGpuSession } from '../src/gpu.js';
import { runExport, type RunResult } from '../src/run-export.js';
import { rewriteClientMeta, runBrandRuntime } from './brand-runtime-stub.js';
import { renderUiHtml } from './ui-html.js';
import { makePlyGz, zipEntryNames, zipReadEntry, experienceSettings } from './zip-helpers.js';

const ICON_URL = 'https://brand.example.com/icon.png';
const LOGO_URL = 'https://brand.example.com/logo.png';
const ICON = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
const LOGO = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 1, 1, 1]);
const CLIENT = { name: 'Client Co', iconUrl: 'https://cdn.example/client/icon.png', logoUrl: 'https://cdn.example/client/logo.png' };

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('runExport packageViewer brand (GPU)', () => {
    let gpu = false;
    let pkg: RunResult | undefined;
    let streaming: RunResult | undefined;
    let client: RunResult | undefined;
    const fetched: string[] = [];

    beforeAll(async () => {
        gpu = (await probeGpu()).gpu;
        if (!gpu) return;
        process.env.VIEWER_BRAND_NAME = 'Acme';
        process.env.VIEWER_BRAND_ICON_URL = ICON_URL;
        process.env.VIEWER_BRAND_LOGO_URL = LOGO_URL;
        process.env.VIEWER_BRAND_URL = 'https://acme.example/';
        // Serve the two operator assets from a stub, but let any other fetch
        // through: the export pipeline must not be starved of a real fetch.
        const realFetch = globalThis.fetch;
        const serve = (bytes: Uint8Array) => {
            let delivered = false;
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'image/png' : null) },
                body: {
                    getReader: () => ({
                        read: async () => {
                            if (delivered) return { done: true, value: undefined };
                            delivered = true;
                            return { done: false, value: bytes.slice() };
                        },
                        cancel: async () => {}
                    })
                }
            };
        };
        vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => {
            fetched.push(String(url));
            if (String(url) === ICON_URL) return serve(ICON);
            if (String(url) === LOGO_URL) return serve(LOGO);
            return realFetch(url, init);
        }));

        const plyGz = await makePlyGz(2048);
        const session = createGpuSession();
        try {
            const run = (streamingMode: boolean, brandOverride?: typeof CLIENT) => runExport({
                plyGz,
                options: {
                    fileType: 'packageViewer',
                    filename: 'out.zip',
                    viewerExportSettings: { type: 'zip', streaming: streamingMode, experienceSettings },
                    brandOverride
                },
                sink: { emit: () => {} },
                getDeviceCreator: session.getDeviceCreator
            });
            pkg = await run(false);
            streaming = await run(true);
            client = await run(false, CLIENT);
        } finally {
            await session.dispose();
        }
    }, 300000);

    afterAll(() => {
        delete process.env.VIEWER_BRAND_NAME;
        delete process.env.VIEWER_BRAND_ICON_URL;
        delete process.env.VIEWER_BRAND_LOGO_URL;
        delete process.env.VIEWER_BRAND_URL;
        vi.unstubAllGlobals();
    });

    const expectEnvBrand = (res: RunResult | undefined) => {
        const zip = Buffer.from(res!.files[0].data);
        const names = zipEntryNames(zip);
        expect(Uint8Array.from(zipReadEntry(zip, 'brand-icon.png'))).toEqual(ICON);
        expect(Uint8Array.from(zipReadEntry(zip, 'brand-logo.png'))).toEqual(LOGO);
        expect(names).not.toContain('favicon.png');

        const html = zipReadEntry(zip, 'index.html').toString('utf8');
        expect(html).toContain('<title>Acme</title>');
        expect(html).not.toContain('data-brand-name');
        expect(html).toContain('<link rel="icon" type="image/png" href="./brand-icon.png">');
        expect(html).toContain('<style id="brandStyle">');
        expect(html).toContain('<meta name="brand-client-name" content="">');
        expect(html).toContain('<script id="brandRuntime">');

        const js = zipReadEntry(zip, 'index.js').toString('utf8');
        // Proves the handle-publish patch (viewer-engine-patch.ts) ran AFTER
        // branding on the same memFs 'index.js' entry.
        expect(js).toContain('window.__supersplatViewer = viewer;');
        expect(js).toContain('var __brandPart = ');
        expect(js).not.toContain('Acme');

        const r = runBrandRuntime(html);
        expect(r.title).toBe('Acme');
        const ui = renderUiHtml(js, r.ui);
        expect(ui).toContain('<a class="sse-viewerBranding sse-hidden" title="Acme" target="_blank" rel="noopener noreferrer">');
        expect(ui).toContain('<img id="brandBadgeIcon" src="./brand-icon.png" alt="" />');
        expect(ui).toContain('<a class="sse-viewerTitle" href="https://acme.example/" target="_blank" rel="noopener noreferrer">');
        expect(ui).toContain('<img id="brandTitleLogo" src="./brand-logo.png" alt="Acme" />');
        expect(ui).not.toContain('sse-title-name');
        expect(ui).not.toContain('Powered by');
        const attributionAt = ui.indexOf('id="brandAttribution"');
        expect(attributionAt).toBeGreaterThan(-1);
        expect(ui.indexOf('<div class="sse-infoGpu">')).toBeGreaterThan(attributionAt);
        expect(occurrences(ui.split('id="supersplatIcon"').join(''), 'SuperSplat')).toBe(1);
    };

    it('bakes the env brand into a package ZIP', () => {
        if (!gpu) { console.warn('No GPU available; skipping brand GPU test'); return; }
        expectEnvBrand(pkg);
    });

    it('bakes the env brand into a streaming ZIP', () => {
        if (!gpu) return;
        expectEnvBrand(streaming);
    });

    it('hotlinks a client brand, ships the operator files, and switches back via the metas', () => {
        if (!gpu) return;
        const zip = Buffer.from(client!.files[0].data);
        // operator files ship even in client mode, for the switch back
        expect(Uint8Array.from(zipReadEntry(zip, 'brand-icon.png'))).toEqual(ICON);
        expect(Uint8Array.from(zipReadEntry(zip, 'brand-logo.png'))).toEqual(LOGO);
        // client URLs are never fetched by the server
        expect(fetched).not.toContain(CLIENT.iconUrl);
        expect(fetched).not.toContain(CLIENT.logoUrl);

        const html = zipReadEntry(zip, 'index.html').toString('utf8');
        expect(html).toContain('<title>Client Co</title>');
        expect(html).toContain('<link rel="icon" href="https://cdn.example/client/icon.png">');
        expect(html).toContain('<meta name="brand-client-name" content="Client Co">');
        expect(html).toContain('<meta name="brand-client-icon" content="https://cdn.example/client/icon.png">');
        expect(html).toContain('<meta name="brand-client-logo" content="https://cdn.example/client/logo.png">');

        const js = zipReadEntry(zip, 'index.js').toString('utf8');
        expect(js).not.toContain('Client Co');

        const r = runBrandRuntime(html);
        expect(r.title).toBe('Client Co');
        const ui = renderUiHtml(js, r.ui);
        expect(ui).toContain('<div class="sse-viewerBranding sse-hidden" title="Client Co">');
        expect(ui).toContain('<img id="brandBadgeIcon" src="https://cdn.example/client/icon.png" alt="" />');
        expect(ui).toContain('<div class="sse-viewerTitle">');
        expect(ui).toContain('<img id="brandTitleLogo" src="https://cdn.example/client/logo.png" alt="Client Co" />');
        expect(ui).toContain('Powered by <a href="https://acme.example/" target="_blank" rel="noopener noreferrer">Acme</a>');
        expect(ui).not.toContain('github.com/playcanvas/supersplat-viewer');

        // What the other application does to switch the scene back.
        let back = rewriteClientMeta(html, 'brand-client-name', '');
        back = rewriteClientMeta(back, 'brand-client-icon', '');
        back = rewriteClientMeta(back, 'brand-client-logo', '');
        const b = runBrandRuntime(back);
        expect(b.title).toBe('Acme');
        expect(b.favicon).toEqual({ rel: 'icon', type: 'image/png', href: './brand-icon.png' });
        const backUi = renderUiHtml(js, b.ui);
        expect(backUi).toContain('<a class="sse-viewerTitle" href="https://acme.example/" target="_blank" rel="noopener noreferrer">');
        expect(backUi).toContain('<img id="brandTitleLogo" src="./brand-logo.png" alt="Acme" />');
        expect(backUi).not.toContain('Powered by');
    });
});
