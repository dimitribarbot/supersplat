import { describe, it, expect, beforeAll, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { Column, DataTable, Transform, writeSource, readFile, createChunkDataPool, dataTableToChunkSource, MemoryFileSystem, MemoryReadFileSystem } from '@playcanvas/splat-transform';
import { probeGpu, createGpuSession } from '../src/gpu.js';
import { runExport, type RunResult } from '../src/run-export.js';
import { NAMES, zipReadEntry, experienceSettings } from './zip-helpers.js';

const READ_OPTS = { iterations: 10, lodSelect: [0], unbundled: false, lodChunkCount: 512, lodChunkExtent: 16 };

// A gzipped PLY as the browser ships it for an anti-aliased layer: written from
// a source tagged 'antialiased' (the PLY header carries the tag) with linear
// opacity (see SerializeSettings.linearOpacity).
const taggedPlyGz = async (n: number): Promise<Buffer> => {
    const cols = NAMES.map((name, i) => new Column(name, Float32Array.from({ length: n }, (_, r) => Math.fround(Math.sin((i + 1) + r * 0.001)))));
    const base = dataTableToChunkSource(new DataTable(cols, Transform.PLY), undefined, undefined, 'antialiased');
    const source = { meta: { ...base.meta, opacityAboveOne: true }, read: (r: any) => base.read(r), close: () => base.close() };
    const memFs = new MemoryFileSystem();
    await writeSource({ filename: 'p.ply', outputFormat: 'ply', source, pool: createChunkDataPool(), options: {} }, memFs);
    return Buffer.from(gzipSync(Buffer.from(memFs.results.get('p.ply')!)));
};

const sogModel = async (bytes: Uint8Array) => {
    const rfs = new MemoryReadFileSystem();
    rfs.set('x.sog', bytes);
    const [source] = await readFile({ filename: 'x.sog', inputFormat: 'sog', options: READ_OPTS, params: [], fileSystem: rfs });
    const model = source.meta.model;
    await source.close();
    return model;
};

// A DataTable carries no splat-model tag, so the fork's DataTable writers are
// handed it explicitly (ViewerCoreOptions.model, writeSogCore's model,
// ExtraPortalScene.loadScene). These pin that a tagged upload comes out tagged
// from every GPU export the server runs.
describe('runExport carries the splat-model tag (GPU)', () => {
    let gpu = false;
    let sog: RunResult | undefined;
    let pkg: RunResult | undefined;
    let streaming: RunResult | undefined;

    beforeAll(async () => {
        gpu = (await probeGpu()).gpu;
        if (!gpu) return;
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const session = createGpuSession();
        const portalSettings = {
            ...experienceSettings,
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }]
        };
        try {
            const plyGz = await taggedPlyGz(2048);
            sog = await runExport({
                plyGz,
                options: { fileType: 'sog', filename: 'out.sog', sogIterations: 2 },
                sink: { emit() {} },
                getDeviceCreator: session.getDeviceCreator
            });
            pkg = await runExport({
                plyGz,
                options: {
                    fileType: 'packageViewer',
                    filename: 'out.zip',
                    viewerExportSettings: { type: 'zip', streaming: false, experienceSettings: portalSettings },
                    portalExtras: [{ seed: [0, 0, 0], environment: 'indoor', collisionUrl: null, streaming: false }]
                },
                sink: { emit() {} },
                getDeviceCreator: session.getDeviceCreator,
                extraPlyGz: [await taggedPlyGz(1024)]
            });
            streaming = await runExport({
                plyGz,
                options: {
                    fileType: 'packageViewer',
                    filename: 'out.zip',
                    viewerExportSettings: { type: 'zip', streaming: true, experienceSettings }
                },
                sink: { emit() {} },
                getDeviceCreator: session.getDeviceCreator
            });
        } finally {
            await session.dispose();
            spy.mockRestore();
        }
    }, 360000);

    it('tags a SOG export', async () => {
        if (!gpu) { console.warn('No GPU available; skipping model tag GPU test'); return; }
        expect(await sogModel(sog!.files[0].data)).toBe('antialiased');
    });

    it('tags a package viewer export and its portal scene', async () => {
        if (!gpu) return;
        const zip = Buffer.from(pkg!.files[0].data);
        expect(await sogModel(zipReadEntry(zip, 'index.sog'))).toBe('antialiased');
        expect(await sogModel(zipReadEntry(zip, 'scenes/1/scene.sog'))).toBe('antialiased');
    });

    it('tags a streaming viewer export', () => {
        if (!gpu) return;
        const lodMeta = JSON.parse(zipReadEntry(Buffer.from(streaming!.files[0].data), 'lod-meta.json').toString('utf8'));
        expect(lodMeta.model).toBe('antialiased');
    });
});
