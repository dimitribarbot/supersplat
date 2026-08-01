import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gzipSync } from 'node:zlib';

// Route-level coverage for the two multipart call sites (/api/export and
// /api/publish) that reattach `annotationImage` parts onto
// `options.viewerExportSettings.annotationImages`. `safeAnnotationImageName`
// itself is unit-tested exhaustively in annotation-images.test.ts; the gap
// this file closes is that nothing exercised the two hand-written call sites,
// so a refactor touching one route and not the other (or dropping the
// validation) would previously pass the whole suite.
//
// Mock the worker host so no worker thread / GPU is needed, and capture the
// `options` object each route hands off -- this is what a deleted validation
// check would corrupt (an unsafe path landing in annotationImages, or a
// wrongly-shaped call).
//
// Hostile-filename vector: `@fastify/multipart` (busboy) already applies
// `path.basename()` to `part.filename` before either route sees it, so a
// traversal payload like `../evil.jpg` arrives at the handler as plain
// `evil.jpg` and would (correctly) pass the whitelist -- confirmed against
// this fastify/multipart version with a standalone probe. The vector that
// actually reaches `safeAnnotationImageName` unmodified and gets rejected is
// an active-content extension (`evil.html`), which is the scenario the
// whitelist's own doc comment calls out (html/js/svg must not be creatable
// this way). Using that instead exercises the real per-route call site.
const captured: any[] = [];
vi.mock('../src/run-export-worker-host.js', () => ({
    runExportViaWorker: ({ options }: any) => {
        captured.push(options);
        return {
            promise: Promise.resolve({ files: [{ name: 'output.zip', data: new Uint8Array([1, 2, 3]) }] }),
            cancel: () => {}
        };
    }
}));

// /api/publish 503s outright when S3 isn't configured (see the 503 test in
// publish-routes.test.ts); mock it configured so the whitelist rejection path
// itself is under test here, not the unrelated "not configured" 503.
vi.mock('../src/s3.js', () => ({
    isConfigured: () => true,
    listPrefix: async () => ({ count: 0 }),
    publishZip: async (_bytes: Uint8Array, dest: any) => ({ url: dest.public ? `https://cdn/${dest.prefix}/index.html` : undefined, prefix: dest.prefix })
}));

const { buildApp } = await import('../src/index.js');

const tinyPlyGz = () => Buffer.from(gzipSync(Buffer.from('ply')));

const withApp = async (fn: (base: string) => Promise<void>) => {
    const app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as any;
    try { await fn(`http://127.0.0.1:${addr.port}`); } finally { await app.close(); }
};

// Waits for the job's SSE stream to reach a terminal event, so the mocked
// runExportViaWorker (and therefore the `captured` push) has definitely run
// before assertions inspect it.
const awaitDone = async (base: string, eventsPath: string, jobId: string) => {
    const text = await (await fetch(`${base}${eventsPath}/${jobId}/events`)).text();
    expect(text).toContain('"kind":"done"');
};

beforeEach(() => {
    captured.length = 0;
});

describe('annotation image whitelist enforced at the route level', () => {
    describe('POST /api/export', () => {
        it('accepts a well-formed annotation image part and attaches it under annotations/', async () => {
            await withApp(async (base) => {
                const bytes = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3, 4, 5]);
                const form = new FormData();
                form.append('ply', new Blob([new Uint8Array(tinyPlyGz())]), 'scene.ply.gz');
                form.append('options', JSON.stringify({
                    fileType: 'packageViewer',
                    filename: 'out.zip',
                    viewerExportSettings: { type: 'zip', experienceSettings: {} }
                }));
                form.append('annotationImage', new Blob([bytes]), 'annimg_0.jpg');

                const startRes = await fetch(`${base}/api/export`, { method: 'POST', body: form });
                expect(startRes.status).toBe(202);
                const { jobId } = await startRes.json();
                await awaitDone(base, '/api/export', jobId);

                expect(captured).toHaveLength(1);
                const images = captured[0].viewerExportSettings.annotationImages;
                expect(images).toHaveLength(1);
                expect(images[0].path).toBe('annotations/annimg_0.jpg');
                expect(Array.from(images[0].data as Uint8Array)).toEqual(Array.from(bytes));
            });
        }, 15000);

        it('rejects a hostile filename (active-content extension) with 400 for the whitelist reason and creates no job', async () => {
            await withApp(async (base) => {
                const form = new FormData();
                form.append('ply', new Blob([new Uint8Array(tinyPlyGz())]), 'scene.ply.gz');
                form.append('options', JSON.stringify({
                    fileType: 'packageViewer',
                    filename: 'out.zip',
                    viewerExportSettings: { type: 'zip', experienceSettings: {} }
                }));
                form.append('annotationImage', new Blob([new Uint8Array([1, 2, 3])]), 'evil.html');

                const res = await fetch(`${base}/api/export`, { method: 'POST', body: form });
                expect(res.status).toBe(400);
                const body = await res.json();
                expect(body.error).toBe('invalid annotation image filename');
                expect(body.jobId).toBeUndefined();
                expect(captured).toHaveLength(0);
            });
        }, 15000);
    });

    describe('POST /api/publish', () => {
        it('accepts a well-formed annotation image part and attaches it under annotations/', async () => {
            await withApp(async (base) => {
                const bytes = new Uint8Array([0xff, 0xd8, 0xff, 6, 7, 8, 9]);
                const form = new FormData();
                form.append('ply', new Blob([new Uint8Array(tinyPlyGz())]), 'scene.ply.gz');
                form.append('options', JSON.stringify({
                    name: 'scene',
                    public: false,
                    overwrite: true,
                    viewerExportSettings: { type: 'zip', experienceSettings: {} }
                }));
                form.append('annotationImage', new Blob([bytes]), 'annimg_0.jpg');

                const startRes = await fetch(`${base}/api/publish`, { method: 'POST', body: form });
                expect(startRes.status).toBe(202);
                const { jobId } = await startRes.json();
                await awaitDone(base, '/api/publish', jobId);

                expect(captured).toHaveLength(1);
                const images = captured[0].viewerExportSettings.annotationImages;
                expect(images).toHaveLength(1);
                expect(images[0].path).toBe('annotations/annimg_0.jpg');
                expect(Array.from(images[0].data as Uint8Array)).toEqual(Array.from(bytes));
            });
        }, 15000);

        it('rejects a hostile filename (active-content extension) with 400 for the whitelist reason (not the 503 unconfigured path) and creates no job', async () => {
            await withApp(async (base) => {
                const form = new FormData();
                form.append('ply', new Blob([new Uint8Array(tinyPlyGz())]), 'scene.ply.gz');
                form.append('options', JSON.stringify({
                    name: 'scene',
                    public: false,
                    overwrite: true,
                    viewerExportSettings: { type: 'zip', experienceSettings: {} }
                }));
                form.append('annotationImage', new Blob([new Uint8Array([1, 2, 3])]), 'evil.html');

                const res = await fetch(`${base}/api/publish`, { method: 'POST', body: form });
                expect(res.status).toBe(400);
                const body = await res.json();
                expect(body.error).toBe('invalid annotation image filename');
                expect(body.jobId).toBeUndefined();
                expect(captured).toHaveLength(0);
            });
        }, 15000);
    });
});
