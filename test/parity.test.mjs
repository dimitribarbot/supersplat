import { describe, it, expect } from 'vitest';
import { Column, DataTable, Transform, writePly, writeSource, readFile, MemoryFileSystem, MemoryReadFileSystem, createChunkDataPool, dataTableToChunkSource, materializeToDataTable } from '@playcanvas/splat-transform';

const READ_OPTS = { iterations: 10, lodSelect: [0], unbundled: false, lodChunkCount: 512, lodChunkExtent: 16 };
const NAMES = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

const readBack = async (bytes) => {
  const rfs = new MemoryReadFileSystem();
  rfs.set('p.ply', bytes);
  const sources = await readFile({ filename: 'p.ply', inputFormat: 'ply', options: READ_OPTS, params: [], fileSystem: rfs });
  return materializeToDataTable(sources[0], createChunkDataPool());
};

describe('extract -> PLY -> readback parity', () => {
  // The export server's byte parity: the browser ships its export source as a
  // float32 PLY, and the server must read back exactly the table a local export
  // materializes from that same source. Since splat-transform 3.11 a source
  // holds LINEAR opacity, and its logit -> linear -> logit trip is not bit-exact
  // in float32 at high opacity -- so the shipped PLY carries `opacity_linear`
  // (the source says opacityAboveOne; see SerializeSettings.linearOpacity).
  it('reads back the local table bit-exact through a linear-opacity PLY', async () => {
    const N = 8;
    // opacity logits up to ~10 (alpha ~0.99995), where float32 sigmoid saturates
    const cols = NAMES.map((n, i) => new Column(n, Float32Array.from({ length: N }, (_, r) => Math.fround((i + 1) * 0.731 + r * 0.013))));
    const base = dataTableToChunkSource(new DataTable(cols, Transform.PLY));
    const source = { meta: { ...base.meta, opacityAboveOne: true }, read: (req) => base.read(req), close: () => base.close() };

    const local = await materializeToDataTable(source, createChunkDataPool());

    const memFs = new MemoryFileSystem();
    await writeSource({ filename: 'p.ply', outputFormat: 'ply', source, pool: createChunkDataPool(), options: {} }, memFs);
    const bytes = memFs.results.get('p.ply');
    expect(bytes && bytes.length).toBeGreaterThan(0);
    expect(new TextDecoder().decode(bytes.subarray(0, 2048))).toContain('opacity_linear');

    const back = await readBack(bytes);
    expect(back.columns.map(c => c.name).sort()).toEqual(local.columns.map(c => c.name).sort());
    for (const c of local.columns) {
      expect(Array.from(back.getColumnByName(c.name).data), c.name).toEqual(Array.from(c.data));
    }
  });

  it('preserves the Transform.PLY tag through the round-trip', async () => {
    const cols = NAMES.map((n, i) => new Column(n, Float32Array.from({ length: 4 }, (_, r) => i + r * 0.25)));
    const src = new DataTable(cols, Transform.PLY);
    const memFs = new MemoryFileSystem();
    await writePly({ filename: 'p.ply', plyData: { comments: [], elements: [{ name: 'vertex', dataTable: src }] } }, memFs);
    const back = await readBack(memFs.results.get('p.ply'));
    expect(back.transform.equals(Transform.PLY)).toBe(true);
  });
});
