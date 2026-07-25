import { describe, it, expect, beforeAll, vi } from 'vitest';
import { probeGpu, createGpuSession } from '../src/gpu.js';
import { runExport, type RunResult } from '../src/run-export.js';
import type { ProgressEvent } from '../src/progress.js';
import { makePlyGz, zipEntryNames, zipReadEntry, experienceSettings } from './zip-helpers.js';

describe('runExport streaming packageViewer (GPU)', () => {
    let gpu = false;
    let res: RunResult | undefined;
    const events: ProgressEvent[] = [];
    const logs: string[] = [];

    beforeAll(async () => {
        gpu = (await probeGpu()).gpu;
        if (!gpu) return;
        const plyGz = await makePlyGz(2048);
        const spy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { logs.push(a.join(' ')); });
        const session = createGpuSession();
        try {
            res = await runExport({
                plyGz,
                options: {
                    fileType: 'packageViewer',
                    filename: 'out.zip',
                    viewerExportSettings: { type: 'zip', streaming: true, experienceSettings }
                },
                sink: { emit: e => events.push(e) },
                getDeviceCreator: session.getDeviceCreator
            });
        } finally {
            await session.dispose();
            spy.mockRestore();
        }
    }, 180000);

    it('zip entries are all relative (no absolute / cwd-prefixed paths)', () => {
        if (!gpu) { console.warn('No GPU available; skipping streaming GPU test'); return; }
        const names = zipEntryNames(Buffer.from(res!.files[0].data));
        for (const nm of names) {
            expect(nm).not.toMatch(/^[A-Za-z]:[\\/]/);   // C:\ or C:/
            expect(nm).not.toContain('supersplat/server');
            expect(nm.startsWith('/')).toBe(false);
        }
    });

    it('includes lod-meta.json and a 0_0 chunk folder', () => {
        if (!gpu) return;
        const names = zipEntryNames(Buffer.from(res!.files[0].data));
        expect(names).toContain('lod-meta.json');
        expect(names.some(n => /^0_0\//.test(n))).toBe(true);
    });

    it('emits progress events carrying a numeric value (the bar can move)', () => {
        if (!gpu) return;
        expect(events.some(e => e.kind === 'progress' && typeof e.value === 'number')).toBe(true);
    });

    it('logs a per-chunk summary line for chunk 0_0', () => {
        if (!gpu) return;
        expect(logs.some(l => /Created streaming chunk 0_0 \(\d+ files?, /.test(l))).toBe(true);
    });

    it('viewer index.html fetches contentUrl (so ?content= can override) with lod-meta.json default', () => {
        if (!gpu) return;
        const html = zipReadEntry(Buffer.from(res!.files[0].data), 'index.html').toString('utf8');
        // content fetch is driven by contentUrl, not a hardcoded URL
        expect(html).toContain('fetch(contentUrl)');
        expect(html).not.toContain('fetch("./lod-meta.json")');
        expect(html).not.toContain('fetch("index.sog")');
        // default content (when ?content is absent) is the streaming bundle
        expect(html).toContain("'./lod-meta.json'");
    });
});

describe('runExport streaming packageViewer with a portal extra scene (GPU)', () => {
    let gpu = false;
    let res: RunResult | undefined;
    const events: ProgressEvent[] = [];

    beforeAll(async () => {
        gpu = (await probeGpu()).gpu;
        if (!gpu) return;
        const plyGz = await makePlyGz(2048);
        const extraGz = await makePlyGz(1024);
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const session = createGpuSession();
        // injectPortals (and its portalSceneLodCounts payload) only fires when
        // viewerSettingsJson.portals is non-empty, so a portal walkthrough test
        // needs at least one doorway; shape matches test/portals-injection.test.ts.
        const portalExperienceSettings = {
            ...experienceSettings,
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }]
        };
        try {
            res = await runExport({
                plyGz,
                options: {
                    fileType: 'packageViewer',
                    filename: 'out.zip',
                    viewerExportSettings: { type: 'zip', streaming: true, experienceSettings: portalExperienceSettings },
                    portalExtras: [{ seed: [0, 0, 0], environment: 'indoor', collisionUrl: null, streaming: true }]
                },
                sink: { emit: e => events.push(e) },
                getDeviceCreator: session.getDeviceCreator,
                extraPlyGz: [extraGz]
            });
        } finally {
            await session.dispose();
            spy.mockRestore();
        }
    }, 240000);

    it('writes the extra scene under scenes/1/ as a streaming bundle', () => {
        if (!gpu) { console.warn('No GPU available; skipping portal streaming GPU test'); return; }
        const names = zipEntryNames(Buffer.from(res!.files[0].data));
        expect(names).toContain('scenes/1/lod-meta.json');
        expect(names.some(n => /^scenes\/1\/0_0\//.test(n))).toBe(true);
    });

    it('bakes one portalSceneLodCounts entry per scene into index.html', () => {
        if (!gpu) return;
        const html = zipReadEntry(Buffer.from(res!.files[0].data), 'index.html').toString('utf8');
        const m = /"portalSceneLodCounts":(\[\[.*?\]\])/.exec(html);
        expect(m).toBeTruthy();
        const counts = JSON.parse(m![1]) as number[][];
        expect(counts).toHaveLength(2);
        // Streaming: every scene contributes its full LOD chain (finest level first).
        expect(counts[0][0]).toBe(2048);
        expect(counts[1][0]).toBe(1024);
    });

    it('extracts scene 2 lazily: its extraction is reported after scene 1 is packaged', () => {
        if (!gpu) return;
        const keys = events.flatMap(e => (e as any).loc?.segments?.map((s: any) => s.key) ?? []);
        const packaged = keys.indexOf('export.progress.packaging-chunks');
        const extracting = keys.indexOf('export.progress.extracting-scene');
        expect(packaged).toBeGreaterThanOrEqual(0);
        expect(extracting).toBeGreaterThan(packaged);
    });
});
