import { describe, it, expect, beforeAll, vi } from 'vitest';
import { probeGpu, createGpuSession } from '../src/gpu.js';
import { runExport, type RunResult } from '../src/run-export.js';
import { makePlyGz, zipEntryNames, zipReadEntry, experienceSettings } from './zip-helpers.js';

// Covers the package (non-streaming) portal branch, whose portalSceneLodCounts is
// built from the scene write loop's return values rather than from resident tables.
describe('runExport package portal walkthrough, 2 scenes, non-streaming (GPU)', () => {
    let gpu = false;
    let res: RunResult | undefined;

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
                    viewerExportSettings: { type: 'zip', streaming: false, experienceSettings: portalExperienceSettings },
                    portalExtras: [{ seed: [0, 0, 0], environment: 'indoor', collisionUrl: null, streaming: false }]
                },
                sink: { emit() {} },
                getDeviceCreator: session.getDeviceCreator,
                extraPlyGz: [extraGz]
            });
        } finally {
            await session.dispose();
            spy.mockRestore();
        }
    }, 240000);

    it('writes the extra scene as scenes/1/scene.sog', () => {
        if (!gpu) { console.warn('No GPU available; skipping package portal GPU test'); return; }
        const names = zipEntryNames(Buffer.from(res!.files[0].data));
        expect(names).toContain('scenes/1/scene.sog');
    });

    it('bakes a single-element count per scene into portalSceneLodCounts', () => {
        if (!gpu) return;
        const html = zipReadEntry(Buffer.from(res!.files[0].data), 'index.html').toString('utf8');
        const m = /"portalSceneLodCounts":(\[\[.*?\]\])/.exec(html);
        expect(m).toBeTruthy();
        expect(JSON.parse(m![1])).toEqual([[2048], [1024]]);
    });
});
