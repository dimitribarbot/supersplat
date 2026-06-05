import { Column, DataTable, Transform, writeFile, MemoryFileSystem } from '@playcanvas/splat-transform';
import { gzipSync } from 'node:zlib';
import { describe, it, expect, beforeAll } from 'vitest';
import { probeGpu } from '../src/gpu.js';
import { runExportViaWorker } from '../src/run-export-worker-host.js';
import type { ProgressEvent } from '../src/progress.js';

const NAMES = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

const makePlyGz = async (n = 2048): Promise<Buffer> => {
    const cols = NAMES.map((name, i) => new Column(name, Float32Array.from({ length: n }, (_, r) => Math.fround(Math.sin((i + 1) + r * 0.001)))));
    const memFs = new MemoryFileSystem();
    await writeFile({ filename: 'p.ply', outputFormat: 'ply', dataTable: new DataTable(cols, Transform.PLY), options: {} }, memFs);
    return Buffer.from(gzipSync(Buffer.from(memFs.results.get('p.ply')!)));
};

describe('runExportViaWorker GPU progress relay', () => {
    let gpu = false;
    beforeAll(async () => { gpu = (await probeGpu()).gpu; });

    it('relays progress events from the worker and returns a SOG', async () => {
        if (!gpu) { console.warn('No GPU available; skipping worker GPU progress test'); return; }
        const plyGz = await makePlyGz(2048);
        const events: ProgressEvent[] = [];
        const { promise } = runExportViaWorker({
            plyGz,
            options: { fileType: 'sog', filename: 'out.sog', sogIterations: 10 },
            onProgress: e => events.push(e)
        });
        const res = await promise;
        expect(res.files[0].name).toBe('out.sog');
        expect(res.files[0].data.byteLength).toBeGreaterThan(0);
        // The worker forwarded splat-transform's progress through postMessage.
        expect(events.some(e => e.kind === 'progress')).toBe(true);
        expect(events.some(e => e.kind === 'progress' && typeof e.value === 'number')).toBe(true);
    }, 180000);
});
