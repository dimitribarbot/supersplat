import { Column, DataTable, Transform, writeFile, MemoryFileSystem } from '@playcanvas/splat-transform';
import { gzipSync, inflateRawSync } from 'node:zlib';
import { describe, it, expect, beforeAll } from 'vitest';
import { probeGpu, createGpuSession } from '../src/gpu.js';
import { runExport, type RunResult } from '../src/run-export.js';

const NAMES = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

const makePlyGz = async (n = 2048): Promise<Buffer> => {
    const cols = NAMES.map((name, i) => new Column(name, Float32Array.from({ length: n }, (_, r) => Math.fround(Math.sin((i + 1) + r * 0.001)))));
    const memFs = new MemoryFileSystem();
    await writeFile({ filename: 'p.ply', outputFormat: 'ply', dataTable: new DataTable(cols, Transform.PLY), options: {} }, memFs);
    return Buffer.from(gzipSync(Buffer.from(memFs.results.get('p.ply')!)));
};

// A near-origin cluster (within ~1 m) plus far outliers (~200 m on +x). Used to
// prove the collision radius subset excludes splats outside the sphere.
const makeClusterPlusOutliersPlyGz = async (): Promise<Buffer> => {
    const near = 256, far = 64, n = near + far;
    const data: Record<string, Float32Array> = {};
    for (const name of NAMES) data[name] = new Float32Array(n);
    for (let r = 0; r < n; r++) {
        const outlier = r >= near;
        // near cluster within ~1 m of origin; outliers ~200 m away on +x
        data.x[r] = outlier ? 200 + Math.sin(r) : Math.sin(r) * 0.5;
        data.y[r] = Math.cos(r) * 0.5;
        data.z[r] = Math.sin(r * 1.3) * 0.5;
        data.scale_0[r] = data.scale_1[r] = data.scale_2[r] = -3; // small
        data.opacity[r] = 6; // high (sigmoid ~1)
        data.rot_0[r] = 1; // identity quaternion
    }
    const cols = NAMES.map(name => new Column(name, data[name]));
    const memFs = new MemoryFileSystem();
    await writeFile({ filename: 'p.ply', outputFormat: 'ply', dataTable: new DataTable(cols, Transform.PLY), options: {} }, memFs);
    return Buffer.from(gzipSync(Buffer.from(memFs.results.get('p.ply')!)));
};

const zipEntryNames = (buf: Buffer): string[] => {
    let eocd = buf.length - 22;
    while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
    if (eocd < 0) throw new Error('zip: end-of-central-directory not found');
    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('zip: bad central directory header');
        const fnLen = buf.readUInt16LE(off + 28);
        const exLen = buf.readUInt16LE(off + 30);
        const cmLen = buf.readUInt16LE(off + 32);
        names.push(buf.toString('utf8', off + 46, off + 46 + fnLen));
        off += 46 + fnLen + exLen + cmLen;
    }
    return names;
};

const zipReadEntry = (buf: Buffer, want: string): Buffer => {
    let eocd = buf.length - 22;
    while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
    if (eocd < 0) throw new Error('zip: end-of-central-directory not found');
    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    for (let i = 0; i < count; i++) {
        const method = buf.readUInt16LE(off + 10);
        const compSize = buf.readUInt32LE(off + 20);
        const fnLen = buf.readUInt16LE(off + 28);
        const exLen = buf.readUInt16LE(off + 30);
        const cmLen = buf.readUInt16LE(off + 32);
        const lho = buf.readUInt32LE(off + 42);
        const name = buf.toString('utf8', off + 46, off + 46 + fnLen);
        if (name === want) {
            const lfnLen = buf.readUInt16LE(lho + 26);
            const lexLen = buf.readUInt16LE(lho + 28);
            const dataStart = lho + 30 + lfnLen + lexLen;
            const comp = buf.subarray(dataStart, dataStart + compSize);
            return method === 0 ? Buffer.from(comp) : inflateRawSync(comp);
        }
        off += 46 + fnLen + exLen + cmLen;
    }
    throw new Error(`zip: entry not found: ${want}`);
};

const experienceSettings = {
    version: 2,
    tonemapping: 'none',
    highPrecisionRendering: false,
    background: { color: [0, 0, 0] },
    postEffectSettings: {},
    animTracks: [],
    cameras: [{ initial: { position: [0, 0, 0], target: [0, 0, -1], fov: 60 } }],
    annotations: [],
    startMode: 'default'
};

describe('runExport packageViewer with collision (GPU)', () => {
    let gpu = false;
    let withCollision: RunResult | undefined;
    let without: RunResult | undefined;

    beforeAll(async () => {
        gpu = (await probeGpu()).gpu;
        if (!gpu) return;
        const plyGz = await makePlyGz(2048);
        const session = createGpuSession();
        try {
            withCollision = await runExport({
                plyGz,
                options: {
                    fileType: 'packageViewer',
                    filename: 'out.zip',
                    viewerExportSettings: { type: 'zip', streaming: false, experienceSettings, collision: { environment: 'indoor', radius: 50, voxelSize: 0.05 } }
                },
                sink: { emit: () => {} },
                getDeviceCreator: session.getDeviceCreator
            });
            without = await runExport({
                plyGz,
                options: {
                    fileType: 'packageViewer',
                    filename: 'out.zip',
                    viewerExportSettings: { type: 'zip', streaming: false, experienceSettings }
                },
                sink: { emit: () => {} },
                getDeviceCreator: session.getDeviceCreator
            });
        } finally {
            await session.dispose();
        }
    }, 300000);

    it('includes index.voxel.json and index.voxel.bin when collision is enabled', () => {
        if (!gpu) { console.warn('No GPU available; skipping collision GPU test'); return; }
        const names = zipEntryNames(Buffer.from(withCollision!.files[0].data));
        expect(names).toContain('index.voxel.json');
        expect(names).toContain('index.voxel.bin');
    });

    it('repoints the viewer collisionUrl to the bundled voxel file', () => {
        if (!gpu) return;
        const html = zipReadEntry(Buffer.from(withCollision!.files[0].data), 'index.html').toString('utf8');
        expect(html).toContain("?? './index.voxel.json'");
    });

    it('omits voxel files and leaves collisionUrl unchanged when collision is disabled', () => {
        if (!gpu) return;
        const names = zipEntryNames(Buffer.from(without!.files[0].data));
        expect(names).not.toContain('index.voxel.json');
        expect(names).not.toContain('index.voxel.bin');
        const html = zipReadEntry(Buffer.from(without!.files[0].data), 'index.html').toString('utf8');
        expect(html).not.toContain("?? './index.voxel.json'");
    });
});

describe('runExport collision radius subset (GPU)', () => {
    let gpu = false;
    let result: RunResult | undefined;

    beforeAll(async () => {
        gpu = (await probeGpu()).gpu;
        if (!gpu) return;
        const plyGz = await makeClusterPlusOutliersPlyGz();
        const session = createGpuSession();
        try {
            // Small radius around the origin start position; outdoor avoids
            // external-fill's enclosed-volume requirement.
            result = await runExport({
                plyGz,
                options: {
                    fileType: 'packageViewer',
                    filename: 'out.zip',
                    viewerExportSettings: { type: 'zip', streaming: false, experienceSettings, collision: { environment: 'outdoor', radius: 10, voxelSize: 0.05 } }
                },
                sink: { emit: () => {} },
                getDeviceCreator: session.getDeviceCreator
            });
        } finally {
            await session.dispose();
        }
    }, 300000);

    it('excludes splats outside the collision radius', () => {
        if (!gpu) { console.warn('No GPU available; skipping collision subset GPU test'); return; }
        const meta = JSON.parse(zipReadEntry(Buffer.from(result!.files[0].data), 'index.voxel.json').toString('utf8'));
        // The near cluster spans ~1 m; the +200 m outliers must be excluded by
        // the radius-10 subset, so the voxelized bounds stay well under 50 m.
        expect(Math.abs(meta.sceneBounds.max[0])).toBeLessThan(50);
        expect(Math.abs(meta.sceneBounds.min[0])).toBeLessThan(50);
    });
});
