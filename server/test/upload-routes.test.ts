import { describe, it, expect, vi } from 'vitest';

// Mock the S3 module so route tests need no real Space. `s3state.configured`
// is toggleable so the 503 (not-configured) path is testable. Mirrors
// publish-routes.test.ts.
const s3state = vi.hoisted(() => ({ configured: true }));
const uploaded = vi.hoisted(() => ({ calls: [] as { path: string; key: string; public: boolean }[] }));
vi.mock('../src/s3.js', () => ({
    isConfigured: () => s3state.configured,
    listPrefix: async () => ({ count: 0 }),
    objectExists: async (key: string) => key.includes('taken'),
    uploadFile: async (path: string, key: string, isPublic: boolean, onProgress?: (pct: number) => void) => {
        uploaded.calls.push({ path, key, public: isPublic });
        onProgress?.(50);
        onProgress?.(100);
        return { url: isPublic ? `https://cdn/${key}` : undefined, key };
    }
}));

const { buildApp } = await import('../src/index.js');

const withApp = async (fn: (base: string) => Promise<void>) => {
    const app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as any;
    try { await fn(`http://127.0.0.1:${addr.port}`); } finally { await app.close(); }
};

// The client always appends `options` before the (potentially huge) file so the
// route can reject a bad destination without reading the upload.
const uploadForm = (options: object, bytes = new Uint8Array([1, 2, 3])) => {
    const form = new FormData();
    form.append('options', JSON.stringify(options));
    form.append('file', new Blob([bytes]), 'render.bin');
    return form;
};

describe('upload routes', () => {
    it('exists endpoint reports a taken and a free key', async () => {
        await withApp(async (base) => {
            const taken = await (await fetch(`${base}/api/upload/exists?subfolder=shots&name=taken&ext=png`)).json();
            expect(taken).toEqual({ exists: true });
            const free = await (await fetch(`${base}/api/upload/exists?name=fresh&ext=mp4`)).json();
            expect(free).toEqual({ exists: false });
        });
    });

    it('exists endpoint rejects an unsafe name and a missing name', async () => {
        await withApp(async (base) => {
            expect((await fetch(`${base}/api/upload/exists?name=../evil&ext=png`)).status).toBe(400);
            expect((await fetch(`${base}/api/upload/exists?ext=png`)).status).toBe(400);
        });
    });

    // A public bucket serving an uploaded .html would run as a page on the
    // storage origin; only the formats the render dialogs can produce are
    // accepted.
    it('rejects an extension the render dialogs cannot produce', async () => {
        await withApp(async (base) => {
            expect((await fetch(`${base}/api/upload/exists?name=x&ext=html`)).status).toBe(400);
            const res = await fetch(`${base}/api/upload`, { method: 'POST', body: uploadForm({ name: 'x', ext: 'html', public: true, overwrite: true }) });
            expect(res.status).toBe(400);
        });
    });

    // A rejected destination must never reach the job machinery, or the client
    // would get a jobId for work that will not happen.
    it('rejects before creating a job', async () => {
        uploaded.calls.length = 0;
        await withApp(async (base) => {
            await fetch(`${base}/api/upload`, { method: 'POST', body: uploadForm({ name: 'taken', ext: 'png', public: false, overwrite: false }) });
        });
        expect(uploaded.calls).toHaveLength(0);
    });

    it('rejects an unsafe name on upload', async () => {
        await withApp(async (base) => {
            const res = await fetch(`${base}/api/upload`, { method: 'POST', body: uploadForm({ name: '../evil', ext: 'png', public: false, overwrite: true }) });
            expect(res.status).toBe(400);
        });
    });

    it('409 when the object exists and overwrite is not set', async () => {
        await withApp(async (base) => {
            const res = await fetch(`${base}/api/upload`, { method: 'POST', body: uploadForm({ name: 'taken', ext: 'png', public: false, overwrite: false }) });
            expect(res.status).toBe(409);
        });
    });

    it('overwrite:true bypasses the 409', async () => {
        await withApp(async (base) => {
            const res = await fetch(`${base}/api/upload`, { method: 'POST', body: uploadForm({ name: 'taken', ext: 'png', public: false, overwrite: true }) });
            expect(res.status).toBe(202);
        });
    });

    // The POST returns as soon as the body is on disk; the S3 PutObject runs as
    // a job so its progress is observable. The client cannot see that phase from
    // xhr.upload -- the upload is already finished by then.
    it('accepts the upload as a job and streams the result on the events route', async () => {
        uploaded.calls.length = 0;
        await withApp(async (base) => {
            const res = await fetch(`${base}/api/upload`, { method: 'POST', body: uploadForm({ subfolder: 'shots/2026', name: 'my-render', ext: 'mp4', public: true, overwrite: false }) });
            expect(res.status).toBe(202);
            const { jobId } = await res.json();
            expect(jobId).toBeTruthy();

            const text = await (await fetch(`${base}/api/upload/${jobId}/events`)).text();
            expect(text).toContain('"kind":"done"');
            expect(text).toContain('https://cdn/shots/2026/my-render.mp4');
            expect(text).toContain('"key":"shots/2026/my-render.mp4"');
        });
        expect(uploaded.calls).toHaveLength(1);
        expect(uploaded.calls[0].key).toBe('shots/2026/my-render.mp4');
        expect(uploaded.calls[0].public).toBe(true);
    });

    it('streams store progress before the done event', async () => {
        await withApp(async (base) => {
            const res = await fetch(`${base}/api/upload`, { method: 'POST', body: uploadForm({ name: 'shot', ext: 'png', public: false, overwrite: true }) });
            const { jobId } = await res.json();
            const text = await (await fetch(`${base}/api/upload/${jobId}/events`)).text();
            expect(text).toContain('"kind":"progress"');
            expect(text).toContain('"value":50');
            expect(text.indexOf('"value":50')).toBeLessThan(text.indexOf('"kind":"done"'));
        });
    });

    it('omits the url for a private upload', async () => {
        await withApp(async (base) => {
            const res = await fetch(`${base}/api/upload`, { method: 'POST', body: uploadForm({ name: 'shot', ext: 'png', public: false, overwrite: true }) });
            const { jobId } = await res.json();
            const text = await (await fetch(`${base}/api/upload/${jobId}/events`)).text();
            expect(text).toContain('"key":"shot.png"');
            expect(text).not.toContain('"url"');
        });
    });

    it('503 when S3 is not configured', async () => {
        s3state.configured = false;
        try {
            await withApp(async (base) => {
                expect((await fetch(`${base}/api/upload/exists?name=x&ext=png`)).status).toBe(503);
                const res = await fetch(`${base}/api/upload`, { method: 'POST', body: uploadForm({ name: 'x', ext: 'png', public: false, overwrite: true }) });
                expect(res.status).toBe(503);
            });
        } finally {
            s3state.configured = true;
        }
    });
});
