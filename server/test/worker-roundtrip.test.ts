import { Column, DataTable, Transform, writeFile, MemoryFileSystem } from '@playcanvas/splat-transform';
import { gzipSync } from 'node:zlib';
import { describe, it, expect } from 'vitest';
import { runExportViaWorker } from '../src/run-export-worker-host.js';

const NAMES = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

const makePlyGz = async (n = 64): Promise<Buffer> => {
    const cols = NAMES.map((name, i) => new Column(name, Float32Array.from({ length: n }, (_, r) => Math.fround((i + 1) + r * 0.01))));
    const memFs = new MemoryFileSystem();
    await writeFile({ filename: 'p.ply', outputFormat: 'ply', dataTable: new DataTable(cols, Transform.PLY), options: {} }, memFs);
    return Buffer.from(gzipSync(Buffer.from(memFs.results.get('p.ply')!)));
};

describe('runExportViaWorker round-trip (CPU)', () => {
    it('runs a compressedPly export in a worker and returns the result', async () => {
        const plyGz = await makePlyGz();
        const events: any[] = [];
        const { promise } = runExportViaWorker({
            plyGz,
            options: { fileType: 'compressedPly', filename: 'out.compressed.ply' },
            onProgress: e => events.push(e)
        });
        const res = await promise;
        expect(res.files).toHaveLength(1);
        expect(res.files[0].name).toBe('out.compressed.ply');
        expect(res.files[0].data.byteLength).toBeGreaterThan(0);
    }, 30000);
});
