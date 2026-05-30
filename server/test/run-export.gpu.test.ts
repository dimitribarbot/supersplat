import { describe, it, expect, beforeAll } from 'vitest';
import { gzipSync } from 'node:zlib';
import { Column, DataTable, Transform, writeFile, MemoryFileSystem } from '@playcanvas/splat-transform';
import { probeGpu, getDeviceCreator } from '../src/gpu.js';
import { runExport } from '../src/run-export.js';

const NAMES = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

const makePlyGz = async (n = 2048): Promise<Buffer> => {
  const cols = NAMES.map((name, i) => new Column(name, Float32Array.from({ length: n }, (_, r) => Math.fround(Math.sin((i + 1) + r * 0.001)))));
  const memFs = new MemoryFileSystem();
  await writeFile({ filename: 'p.ply', outputFormat: 'ply', dataTable: new DataTable(cols, Transform.PLY), options: {} }, memFs);
  return Buffer.from(gzipSync(Buffer.from(memFs.results.get('p.ply')!)));
};

describe('runExport GPU formats', () => {
  let gpu = false;
  beforeAll(async () => { gpu = (await probeGpu()).gpu; }, 60000);

  it('produces a non-empty SOG via the GPU', async () => {
    if (!gpu) { console.warn('No GPU available; skipping SOG GPU test'); return; }
    const plyGz = await makePlyGz();
    const res = await runExport({
      plyGz,
      options: { fileType: 'sog', filename: 'out.sog', sogIterations: 2 },
      sink: { emit() {} },
      getDeviceCreator
    });
    expect(res.files).toHaveLength(1);
    expect(res.files[0].name).toBe('out.sog');
    expect(res.files[0].data.length).toBeGreaterThan(0);
  }, 120000);

  it('aborts a running streaming export when cancellation is requested mid-run', async () => {
    if (!gpu) { console.warn('No GPU available; skipping cancel test'); return; }
    const plyGz = await makePlyGz();
    const experienceSettings = {
      version: 2, tonemapping: 'none', highPrecisionRendering: false,
      background: { color: [0, 0, 0] }, postEffectSettings: {},
      animTracks: [], cameras: [], annotations: [], startMode: 'default'
    };
    let progressed = false;
    let cancel = false;
    const sink = {
      emit(e: any) {
        // Flip cancel as soon as work starts reporting progress, so the next
        // forward-progress tick aborts the in-flight writer.
        if (e.kind === 'progress') {
          progressed = true;
          cancel = true;
        }
      }
    };
    await expect(runExport({
      plyGz,
      options: {
        fileType: 'packageViewer',
        filename: 'out.zip',
        viewerExportSettings: { type: 'zip', streaming: true, experienceSettings }
      },
      sink,
      getDeviceCreator,
      isCancelled: () => cancel
    })).rejects.toThrow(/cancel/i);
    expect(progressed).toBe(true);
  }, 180000);
});
