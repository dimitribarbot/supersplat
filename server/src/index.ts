import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { probeGpu } from './gpu.js';
import { createJob, getJob, subscribe } from './jobs.js';

const PORT = Number(process.env.PORT ?? 3334);
const ALL_FORMATS = ['ply', 'compressedPly', 'splat', 'sog', 'htmlViewer', 'packageViewer'];
const GPU_FORMATS = new Set(['sog', 'htmlViewer', 'packageViewer']);

export const buildApp = async () => {
    const app = Fastify({ logger: true });
    await app.register(cors, { origin: true });
    await app.register(multipart, {
        limits: { fileSize: Number(process.env.MAX_UPLOAD ?? 1024 * 1024 * 1024) }
    });

    // Serve the built web app (repo-root `dist/`) so the API and the static site
    // share one origin — the client probes `${location.origin}/api/export/*`, so
    // serving both here lets the server-export option appear without a reverse
    // proxy. `STATIC_ROOT` overrides the location (used by tests). If the build
    // output is missing, serve the API only rather than failing to start.
    const staticRoot = process.env.STATIC_ROOT ?? fileURLToPath(new URL('../../dist', import.meta.url));
    if (existsSync(staticRoot)) {
        await app.register(fastifyStatic, { root: staticRoot });
    } else {
        app.log.warn(`static root ${staticRoot} not found; serving API only (run \`npm run build\` in the repo root to enable static serving)`);
    }

    const { gpu } = await probeGpu();

    app.get('/api/export/capabilities', async () => {
        const formats = ALL_FORMATS.filter(f => gpu || !GPU_FORMATS.has(f));
        return { enabled: true, gpu, formats };
    });

    app.post('/api/export', async (req, reply) => {
        let plyGz: Buffer | null = null;
        let options: any = null;
        for await (const part of req.parts()) {
            if (part.type === 'file' && part.fieldname === 'ply') {
                plyGz = await part.toBuffer();
            } else if (part.type === 'field' && part.fieldname === 'options') {
                try {
                    options = JSON.parse(part.value as string);
                } catch {
                    return reply.code(400).send({ error: 'options is not valid JSON' });
                }
            }
        }
        if (!plyGz || !options || typeof options.fileType !== 'string' || typeof options.filename !== 'string') {
            return reply.code(400).send({ error: 'missing ply file or options { fileType, filename }' });
        }
        const filenameOk = /^[A-Za-z0-9._-]+$/.test(options.filename) && !options.filename.includes('..');
        if (!filenameOk) {
            return reply.code(400).send({ error: 'invalid filename: use only letters, digits, dot, underscore, hyphen' });
        }
        const id = createJob(plyGz, options);
        return reply.code(202).send({ jobId: id });
    });

    app.get('/api/export/:id/events', (req, reply) => {
        const { id } = req.params as { id: string };
        if (!getJob(id)) {
            return reply.code(404).send({ error: 'no such job' });
        }
        reply.hijack();
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });
        const send = (e: any) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
        // `unsub` may be invoked synchronously during subscribe() when the job
        // already finished (buffered events replay immediately), so declare it
        // first to avoid a temporal-dead-zone reference in the listener.
        let unsub = () => {};
        unsub = subscribe(id, (e) => {
            send(e);
            if (e.kind === 'done' || e.kind === 'error') {
                unsub();
                reply.raw.end();
            }
        });
        req.raw.on('close', unsub);
    });

    app.get('/api/export/:id/result', async (req, reply) => {
        const { id } = req.params as { id: string };
        const job = getJob(id);
        if (!job || job.state !== 'done' || !job.result) {
            return reply.code(404).send({ error: 'result not ready' });
        }
        const file = job.result[0];
        const isZip = file.name.endsWith('.zip');
        reply.header('Content-Type', isZip ? 'application/zip' : 'application/octet-stream');
        const safeName = file.name.replace(/[\r\n"\\]/g, '_');
        reply.header('Content-Disposition', `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`);
        return reply.send(Buffer.from(file.data));
    });

    return app;
};

const start = async () => {
    const app = await buildApp();
    await app.listen({ port: PORT, host: '0.0.0.0' });
};

// Only auto-start when run directly (`node dist/index.js`), not when imported
// (e.g. tests importing `buildApp`). Importing must not boot a real listener —
// it would collide with a running server on PORT.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    start().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('Failed to start export server:', err);
        process.exit(1);
    });
}
