import { describe, it, expect, vi } from 'vitest';
import { gzipSync } from 'node:zlib';

// Mock the S3 module so route tests need no real Space and no GPU.
// `s3state.configured` is toggleable so the 503 (not-configured) path is testable.
const s3state = vi.hoisted(() => ({ configured: true }));
vi.mock('../src/s3.js', () => ({
    isConfigured: () => s3state.configured,
    listPrefix: async (prefix: string) => ({ count: prefix.includes('taken') ? 1 : 0 }),
    publishZip: async (_bytes: Uint8Array, dest: any) => ({ url: dest.public ? `https://cdn/${dest.prefix}/index.html` : undefined, prefix: dest.prefix })
}));

// Mock the worker host so no GPU is needed: return a tiny fake zip.
vi.mock('../src/run-export-worker-host.js', () => ({
    runExportViaWorker: () => ({
        promise: Promise.resolve({ files: [{ name: 'output.zip', data: new Uint8Array([1, 2, 3]) }] }),
        cancel: () => {}
    })
}));

const { buildApp } = await import('../src/index.js');

const tinyPlyGz = () => Buffer.from(gzipSync(Buffer.from('ply')));

const withApp = async (fn: (base: string) => Promise<void>) => {
    const app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as any;
    try { await fn(`http://127.0.0.1:${addr.port}`); } finally { await app.close(); }
};

describe('publish routes', () => {
    it('capabilities reports publish: true when configured', async () => {
        await withApp(async (base) => {
            const caps = await (await fetch(`${base}/api/export/capabilities`)).json();
            expect(caps.publish).toBe(true);
        });
    });

    it('exists endpoint reports count for a prefix', async () => {
        await withApp(async (base) => {
            const taken = await (await fetch(`${base}/api/publish/exists?name=taken`)).json();
            expect(taken).toEqual({ exists: true, count: 1 });
            const free = await (await fetch(`${base}/api/publish/exists?subfolder=a&name=fresh`)).json();
            expect(free).toEqual({ exists: false, count: 0 });
        });
    });

    it('rejects an unsafe name', async () => {
        await withApp(async (base) => {
            const form = new FormData();
            form.append('ply', new Blob([new Uint8Array(tinyPlyGz())]), 'scene.ply.gz');
            form.append('options', JSON.stringify({ name: '../evil', public: false, overwrite: false, viewerExportSettings: { type: 'zip', experienceSettings: {} } }));
            const res = await fetch(`${base}/api/publish`, { method: 'POST', body: form });
            expect(res.status).toBe(400);
        });
    });

    it('409 when prefix exists and overwrite not set', async () => {
        await withApp(async (base) => {
            const form = new FormData();
            form.append('ply', new Blob([new Uint8Array(tinyPlyGz())]), 'scene.ply.gz');
            form.append('options', JSON.stringify({ name: 'taken', public: false, overwrite: false, viewerExportSettings: { type: 'zip', experienceSettings: {} } }));
            const res = await fetch(`${base}/api/publish`, { method: 'POST', body: form });
            expect(res.status).toBe(409);
        });
    });

    it('POST -> events(done) carries the publish url', async () => {
        await withApp(async (base) => {
            const form = new FormData();
            form.append('ply', new Blob([new Uint8Array(tinyPlyGz())]), 'scene.ply.gz');
            form.append('options', JSON.stringify({ subfolder: 'demos', name: 'scene', public: true, overwrite: false, viewerExportSettings: { type: 'zip', streaming: true, experienceSettings: {} } }));
            const startRes = await fetch(`${base}/api/publish`, { method: 'POST', body: form });
            expect(startRes.status).toBe(202);
            const { jobId } = await startRes.json();
            const text = await (await fetch(`${base}/api/publish/${jobId}/events`)).text();
            expect(text).toContain('"kind":"done"');
            expect(text).toContain('https://cdn/demos/scene/index.html');
        });
    });

    it('rejects "." as a name', async () => {
        await withApp(async (base) => {
            const res = await fetch(`${base}/api/publish/exists?name=.`);
            expect(res.status).toBe(400);
        });
    });

    it('exists returns 400 when name is missing', async () => {
        await withApp(async (base) => {
            const res = await fetch(`${base}/api/publish/exists`);
            expect(res.status).toBe(400);
        });
    });

    it('overwrite:true bypasses the 409 on an existing prefix', async () => {
        await withApp(async (base) => {
            const form = new FormData();
            form.append('ply', new Blob([new Uint8Array(tinyPlyGz())]), 'scene.ply.gz');
            form.append('options', JSON.stringify({ name: 'taken', public: false, overwrite: true, viewerExportSettings: { type: 'zip', experienceSettings: {} } }));
            const res = await fetch(`${base}/api/publish`, { method: 'POST', body: form });
            expect(res.status).toBe(202);
        });
    });

    it('503 when S3 is not configured', async () => {
        s3state.configured = false;
        try {
            await withApp(async (base) => {
                const ex = await fetch(`${base}/api/publish/exists?name=scene`);
                expect(ex.status).toBe(503);
                const form = new FormData();
                form.append('ply', new Blob([new Uint8Array(tinyPlyGz())]), 'scene.ply.gz');
                form.append('options', JSON.stringify({ name: 'scene', public: false, overwrite: false, viewerExportSettings: { type: 'zip', experienceSettings: {} } }));
                const res = await fetch(`${base}/api/publish`, { method: 'POST', body: form });
                expect(res.status).toBe(503);
            });
        } finally {
            s3state.configured = true;
        }
    });
});
