import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { probeGpu, createGpuSession } from '../src/gpu.js';
import { runExport, type RunResult } from '../src/run-export.js';
import { makePlyGz, zipEntryNames, zipReadEntry, experienceSettings } from './zip-helpers.js';

const ICON_URL = 'https://brand.example.com/logo.png';
const FONT_URL = 'https://brand.example.com/acme.woff2';
const ICON = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
const FONT = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4]);

describe('runExport packageViewer brand override (GPU)', () => {
    let gpu = false;
    let pkg: RunResult | undefined;
    let streaming: RunResult | undefined;

    beforeAll(async () => {
        gpu = (await probeGpu()).gpu;
        if (!gpu) return;
        process.env.VIEWER_BRAND_NAME = 'Acme';
        process.env.VIEWER_BRAND_ICON_URL = ICON_URL;
        process.env.VIEWER_BRAND_FONT_NAME = 'Acme Sans';
        process.env.VIEWER_BRAND_FONT_URL = FONT_URL;
        // Serve the two brand assets from a stub, but let any other fetch
        // through: the export pipeline must not be starved of a real fetch.
        const realFetch = globalThis.fetch;
        const serve = (bytes: Uint8Array, contentType: string) => {
            let delivered = false;
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
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
            if (String(url) === ICON_URL) return serve(ICON, 'image/png');
            if (String(url) === FONT_URL) return serve(FONT, 'font/woff2');
            return realFetch(url, init);
        }));

        const plyGz = await makePlyGz(2048);
        const session = createGpuSession();
        try {
            const run = (streamingMode: boolean) => runExport({
                plyGz,
                options: {
                    fileType: 'packageViewer',
                    filename: 'out.zip',
                    viewerExportSettings: { type: 'zip', streaming: streamingMode, experienceSettings }
                },
                sink: { emit: () => {} },
                getDeviceCreator: session.getDeviceCreator
            });
            pkg = await run(false);
            streaming = await run(true);
        } finally {
            await session.dispose();
        }
    }, 300000);

    afterAll(() => {
        delete process.env.VIEWER_BRAND_NAME;
        delete process.env.VIEWER_BRAND_ICON_URL;
        delete process.env.VIEWER_BRAND_FONT_NAME;
        delete process.env.VIEWER_BRAND_FONT_URL;
        vi.unstubAllGlobals();
    });

    const expectBrand = (res: RunResult | undefined) => {
        const zip = Buffer.from(res!.files[0].data);
        const names = zipEntryNames(zip);
        expect(names).toContain('brand-icon.png');
        expect(names).toContain('brand-font.woff2');
        expect(Uint8Array.from(zipReadEntry(zip, 'brand-icon.png'))).toEqual(ICON);
        expect(Uint8Array.from(zipReadEntry(zip, 'brand-font.woff2'))).toEqual(FONT);

        const html = zipReadEntry(zip, 'index.html').toString('utf8');
        expect(html).toContain('<title>Acme</title>');
        expect(html).toContain('<span>Acme</span>');
        expect(html).toContain('<span class="title-name">Acme</span>');
        expect(html).toContain('<img id="brandBadgeIcon" src="./brand-icon.png" alt="" />');
        expect(html).toContain('<img id="brandTitleIcon" src="./brand-icon.png" alt="" />');
        expect(html).toContain("src: url('./brand-font.woff2') format('woff2');");
        expect(html).toContain('id="brandAttribution"');
        expect(html).toContain('href="https://superspl.at/"');
        // The attribution is the only SuperSplat mention left in the document.
        expect(html.split('SuperSplat').length - 1).toBe(1);
    };

    it('bakes the brand into a package ZIP', () => {
        if (!gpu) { console.warn('No GPU available; skipping brand GPU test'); return; }
        expectBrand(pkg);
    });

    it('bakes the brand into a streaming ZIP', () => {
        if (!gpu) return;
        expectBrand(streaming);
    });
});
