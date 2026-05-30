import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { Column, DataTable, Transform, writeFile, writeCompressedPly, readFile, MemoryFileSystem, MemoryReadFileSystem } from '@playcanvas/splat-transform';
import { runExport } from '../src/run-export.js';

const NAMES = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

// Must match READ_OPTS in server/src/run-export.ts exactly.
const READ_OPTS = { iterations: 10, lodSelect: [0], unbundled: false, lodChunkCount: 512, lodChunkExtent: 16 };

const noGpu = () => async () => { throw new Error('GPU not needed for this test'); };

describe('server compressed PLY parity', () => {
  it('matches direct writeCompressedPly on the same readback table', async () => {
    const n = 1024;
    const cols = NAMES.map((name, i) => new Column(name, Float32Array.from({ length: n }, (_, r) => Math.fround(Math.sin(i + r * 0.01)))));
    const memFs = new MemoryFileSystem();
    await writeFile({ filename: 'p.ply', outputFormat: 'ply', dataTable: new DataTable(cols, Transform.PLY), options: {} }, memFs);
    const ply = Buffer.from(memFs.results.get('p.ply')!);
    const plyGz = Buffer.from(gzipSync(ply));

    // server path
    const res = await runExport({ plyGz, options: { fileType: 'compressedPly', filename: 'out.compressed.ply' }, sink: { emit() {} }, getDeviceCreator: noGpu });

    // reference: replicate run-export.ts's readback + writeCompressedPly directly
    const rfs = new MemoryReadFileSystem();
    rfs.set('input.ply', new Uint8Array(ply));
    const tables = await readFile({ filename: 'input.ply', inputFormat: 'ply', options: READ_OPTS, params: [], fileSystem: rfs });
    (tables[0] as any).transform = Transform.PLY;
    const ref = new MemoryFileSystem();
    await writeCompressedPly({ filename: 'out.compressed.ply', dataTable: tables[0] }, ref);

    expect(Buffer.from(res.files[0].data)).toEqual(Buffer.from(ref.results.get('out.compressed.ply')!));
  });
});
