import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { probeGpu, createGpuSession } from '../src/gpu.js';
import { runExport, type RunResult } from '../src/run-export.js';
import { makePlyGz, zipEntryNames, zipReadEntry, experienceSettings } from './zip-helpers.js';

const ICON_URL = 'https://icons.example.com/brand.png';
const ICON = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);

describe('runExport packageViewer favicon (GPU)', () => {
    let gpu = false;
    let pkg: RunResult | undefined;
    let streaming: RunResult | undefined;

    beforeAll(async () => {
        gpu = (await probeGpu()).gpu;
        if (!gpu) return;
        process.env.VIEWER_FAVICON_URL = ICON_URL;
        // Serve the icon from a stub, but let any other fetch through: the
        // export pipeline must not be starved of a real fetch by this stub.
        const realFetch = globalThis.fetch;
        vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => {
            if (String(url) !== ICON_URL) return realFetch(url, init);
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
                            return { done: false, value: ICON.slice() };
                        },
                        cancel: async () => {}
                    })
                }
            };
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
        delete process.env.VIEWER_FAVICON_URL;
        vi.unstubAllGlobals();
    });

    const expectFavicon = (res: RunResult | undefined) => {
        const zip = Buffer.from(res!.files[0].data);
        expect(zipEntryNames(zip)).toContain('favicon.png');
        expect(Uint8Array.from(zipReadEntry(zip, 'favicon.png'))).toEqual(ICON);
        const html = zipReadEntry(zip, 'index.html').toString('utf8');
        expect(html).toContain('<link rel="icon" type="image/png" href="./favicon.png">');
        expect(html.indexOf('rel="icon"')).toBeLessThan(html.indexOf('</head>'));
    };

    it('embeds and links the favicon in a package ZIP', () => {
        if (!gpu) { console.warn('No GPU available; skipping favicon GPU test'); return; }
        expectFavicon(pkg);
    });

    it('embeds and links the favicon in a streaming ZIP', () => {
        if (!gpu) return;
        expectFavicon(streaming);
    });
});
