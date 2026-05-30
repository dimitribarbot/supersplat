import { Column, DataTable, Transform, writeFile, MemoryFileSystem } from '@playcanvas/splat-transform';
import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { buildApp } from '../src/index.js';

const NAMES = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
const makePlyGz = async (n = 32): Promise<Buffer> => {
    const cols = NAMES.map((name, i) => new Column(name, Float32Array.from({ length: n }, (_, r) => Math.fround((i + 1) + r * 0.01))));
    const memFs = new MemoryFileSystem();
    await writeFile({ filename: 'p.ply', outputFormat: 'ply', dataTable: new DataTable(cols, Transform.PLY), options: {} }, memFs);
    return Buffer.from(gzipSync(Buffer.from(memFs.results.get('p.ply')!)));
};

describe('export routes', () => {
    it('POST /api/export -> events(done) -> result returns a compressed PLY', async () => {
        const app = await buildApp();
        await app.listen({ port: 0, host: '127.0.0.1' });
        const addr = app.server.address() as any;
        const base = `http://127.0.0.1:${addr.port}`;
        try {
            const plyGz = await makePlyGz();
            const form = new FormData();
            form.append('ply', new Blob([new Uint8Array(plyGz)]), 'scene.ply.gz');
            form.append('options', JSON.stringify({ fileType: 'compressedPly', filename: 'out.compressed.ply' }));
            const startRes = await fetch(`${base}/api/export`, { method: 'POST', body: form });
            expect(startRes.status).toBe(202);
            const { jobId } = await startRes.json();
            expect(jobId).toBeTruthy();

            const evRes = await fetch(`${base}/api/export/${jobId}/events`);
            expect(evRes.headers.get('content-type')).toContain('text/event-stream');
            const text = await evRes.text();
            expect(text).toContain('"kind":"done"');

            const resultRes = await fetch(`${base}/api/export/${jobId}/result`);
            expect(resultRes.status).toBe(200);
            expect(resultRes.headers.get('content-type')).toContain('application/octet-stream');
            const buf = Buffer.from(await resultRes.arrayBuffer());
            expect(buf.length).toBeGreaterThan(0);
        } finally {
            await app.close();
        }
    }, 30000);

  it('rejects an export with an unsafe filename', async () => {
    const app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as any;
    const base = `http://127.0.0.1:${addr.port}`;
    try {
      const plyGz = await makePlyGz();
      const form = new FormData();
      form.append('ply', new Blob([new Uint8Array(plyGz)]), 'scene.ply.gz');
      form.append('options', JSON.stringify({ fileType: 'compressedPly', filename: 'evil"\r\nX-Injected: 1.ply' }));
      const res = await fetch(`${base}/api/export`, { method: 'POST', body: form });
      expect(res.status).toBe(400);
    } finally {
      await app.close();
    }
  }, 30000);
});
