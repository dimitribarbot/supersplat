import { describe, it, expect } from 'vitest';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Column, DataTable, Transform, writeFile, MemoryFileSystem } from '@playcanvas/splat-transform';
import { runExport, makeExportFileHandler } from '../src/run-export.js';

// Mirrors the shared collisionSceneIndex classifier (src/collision-size-report.ts)
// without depending on the dist-shared build: 0 for the primary scene, N for an
// extra scene, null for anything that isn't a collision binary.
const sceneIndexOf = (name: string): number | null => {
  const m = /^(?:scenes\/(\d+)\/scene|index)\.voxel\.bin$/.exec(name);
  if (!m) return null;
  return m[1] === undefined ? 0 : parseInt(m[1], 10);
};

const NAMES = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

const makePlyGz = async (n = 6): Promise<Buffer> => {
  const cols = NAMES.map((name, i) => new Column(name, Float32Array.from({ length: n }, (_, r) => Math.fround((i + 1) + r * 0.01))));
  const memFs = new MemoryFileSystem();
  await writeFile({ filename: 'p.ply', outputFormat: 'ply', dataTable: new DataTable(cols, Transform.PLY), options: {} }, memFs);
  return Buffer.from(gzipSync(Buffer.from(memFs.results.get('p.ply')!)));
};

const noGpu = () => async () => { throw new Error('GPU not needed for this test'); };

describe('runExport', () => {
  it('passes through uncompressed PLY unchanged (gunzipped upload bytes)', async () => {
    const plyGz = await makePlyGz();
    const res = await runExport({ plyGz, options: { fileType: 'ply', filename: 'out.ply' }, sink: { emit() {} }, getDeviceCreator: noGpu });
    expect(res.files).toHaveLength(1);
    expect(res.files[0].name).toBe('out.ply');
    expect(Buffer.from(res.files[0].data)).toEqual(Buffer.from(gunzipSync(plyGz)));
  });

  it('produces a compressed PLY', async () => {
    const plyGz = await makePlyGz();
    const res = await runExport({ plyGz, options: { fileType: 'compressedPly', filename: 'out.compressed.ply' }, sink: { emit() {} }, getDeviceCreator: noGpu });
    expect(res.files).toHaveLength(1);
    expect(res.files[0].name).toBe('out.compressed.ply');
    expect(res.files[0].data.length).toBeGreaterThan(0);
  });

  it('rejects splat (handled client-side)', async () => {
    const plyGz = await makePlyGz();
    await expect(runExport({ plyGz, options: { fileType: 'splat', filename: 'x.splat' }, sink: { emit() {} }, getDeviceCreator: noGpu }))
      .rejects.toThrow(/splat .*client/i);
  });

  it('emits a collision progress event for each collision binary written', () => {
    const emitted: any[] = [];
    const sink = { emit: (e: any) => emitted.push(e) };
    const { handler } = makeExportFileHandler(sink, sceneIndexOf);

    handler({ name: 'index.voxel.bin', bytes: 3682632 });
    handler({ name: 'scenes/1/scene.voxel.bin', bytes: 39375284 });
    handler({ name: 'index.html', bytes: 1234 });

    expect(emitted.filter(e => e.collision)).toEqual([
      { kind: 'progress', collision: { index: 0, bytes: 3682632 } },
      { kind: 'progress', collision: { index: 1, bytes: 39375284 } }
    ]);
  });
});
