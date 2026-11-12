import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { Column, DataTable, Transform, writePly, writeCompressedPly, writeSource, readFile, createChunkDataPool, dataTableToChunkSource, materializeToDataTable, MemoryFileSystem, MemoryReadFileSystem } from '@playcanvas/splat-transform';
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
    await writePly({ filename: 'p.ply', plyData: { comments: [], elements: [{ name: 'vertex', dataTable: new DataTable(cols, Transform.PLY) }] } }, memFs);
    const ply = Buffer.from(memFs.results.get('p.ply')!);
    const plyGz = Buffer.from(gzipSync(ply));

    // server path
    const res = await runExport({ plyGz, options: { fileType: 'compressedPly', filename: 'out.compressed.ply' }, sink: { emit() {} }, getDeviceCreator: noGpu });

    // reference: replicate run-export.ts's readback + writeCompressedPly directly
    const rfs = new MemoryReadFileSystem();
    rfs.set('input.ply', new Uint8Array(ply));
    const sources = await readFile({ filename: 'input.ply', inputFormat: 'ply', options: READ_OPTS, params: [], fileSystem: rfs });
    const dataTable = await materializeToDataTable(sources[0], createChunkDataPool());
    (dataTable as any).transform = Transform.PLY;
    const ref = new MemoryFileSystem();
    await writeCompressedPly({ filename: 'out.compressed.ply', dataTable }, ref);

    expect(Buffer.from(res.files[0].data)).toEqual(Buffer.from(ref.results.get('out.compressed.ply')!));
  });

  // End to end with the browser's side: a local compressed-PLY export writes the
  // export source directly (writeSource), while a server export ships that source
  // as a linear-opacity, model-tagged PLY and writes from its readback. Both must
  // produce the same bytes, model tag included.
  it('matches a local writeSource export of an anti-aliased, linear-opacity source', async () => {
    const n = 1024;
    const cols = NAMES.map((name, i) => new Column(name, Float32Array.from({ length: n }, (_, r) => Math.fround(Math.sin(i + r * 0.01) * (name === 'opacity' ? 9 : 1)))));
    const base = dataTableToChunkSource(new DataTable(cols, Transform.PLY), undefined, undefined, 'antialiased');
    const source = { meta: { ...base.meta, opacityAboveOne: true }, read: (r: any) => base.read(r), close: () => base.close() };

    // local export of the same source (the browser's writeSplatFile path)
    const local = new MemoryFileSystem();
    await writeSource({ filename: 'out.compressed.ply', outputFormat: 'compressed-ply', source, pool: createChunkDataPool(), options: {} }, local);

    // server export: the browser's shipped PLY, then runExport
    const shipped = new MemoryFileSystem();
    await writeSource({ filename: 'p.ply', outputFormat: 'ply', source, pool: createChunkDataPool(), options: {} }, shipped);
    const plyGz = Buffer.from(gzipSync(Buffer.from(shipped.results.get('p.ply')!)));
    const res = await runExport({ plyGz, options: { fileType: 'compressedPly', filename: 'out.compressed.ply' }, sink: { emit() {} }, getDeviceCreator: noGpu });

    const out = Buffer.from(res.files[0].data);
    expect(out.subarray(0, 1024).toString('latin1')).toContain('SplatRenderMode: mip');
    expect(out).toEqual(Buffer.from(local.results.get('out.compressed.ply')!));
  });
});
