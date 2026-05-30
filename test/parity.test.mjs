import { describe, it, expect } from 'vitest';
import { Column, DataTable, Transform, writeFile, readFile, MemoryFileSystem, MemoryReadFileSystem } from '@playcanvas/splat-transform';

const READ_OPTS = { iterations: 10, lodSelect: [0], unbundled: false, lodChunkCount: 512, lodChunkExtent: 16 };

describe('extract -> PLY -> readback parity', () => {
  it('preserves float columns bit-exact through an uncompressed PLY round-trip', async () => {
    const N = 8;
    const names = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
    const cols = names.map((n, i) => new Column(n, Float32Array.from({ length: N }, (_, r) => Math.fround((i + 1) * 0.731 + r * 0.013))));
    const src = new DataTable(cols, Transform.PLY);

    const memFs = new MemoryFileSystem();
    await writeFile({ filename: 'p.ply', outputFormat: 'ply', dataTable: src, options: {} }, memFs);
    const bytes = memFs.results.get('p.ply');
    expect(bytes && bytes.length).toBeGreaterThan(0);

    const rfs = new MemoryReadFileSystem();
    rfs.set('p.ply', bytes);
    const tables = await readFile({ filename: 'p.ply', inputFormat: 'ply', options: READ_OPTS, params: [], fileSystem: rfs });
    const back = tables[0];

    for (const n of names) {
      const a = src.columns.find(c => c.name === n).data;
      const b = back.columns.find(c => c.name === n).data;
      expect(Array.from(b)).toEqual(Array.from(a));
    }
  });

  it('preserves the Transform.PLY tag through the round-trip', async () => {
    const cols = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'rot_0', 'rot_1', 'rot_2', 'rot_3']
      .map((n, i) => new Column(n, Float32Array.from({ length: 4 }, (_, r) => i + r * 0.25)));
    const src = new DataTable(cols, Transform.PLY);
    const memFs = new MemoryFileSystem();
    await writeFile({ filename: 'p.ply', outputFormat: 'ply', dataTable: src, options: {} }, memFs);
    const rfs = new MemoryReadFileSystem();
    rfs.set('p.ply', memFs.results.get('p.ply'));
    const tables = await readFile({ filename: 'p.ply', inputFormat: 'ply', options: READ_OPTS, params: [], fileSystem: rfs });
    expect(tables[0].transform.equals(Transform.PLY)).toBe(true);
  });
});
