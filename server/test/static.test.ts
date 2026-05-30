import { mkdtemp, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/index.js';

describe('static file serving', () => {
    let dir: string;
    const html = '<!doctype html><title>supersplat</title><body>hello</body>';

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'ss-static-'));
        await fsWriteFile(join(dir, 'index.html'), html);
        await fsWriteFile(join(dir, 'index.js'), 'console.log(1);');
        process.env.STATIC_ROOT = dir;
    });

    afterAll(async () => {
        delete process.env.STATIC_ROOT;
        await rm(dir, { recursive: true, force: true });
    });

    it('serves index.html at /', async () => {
        const app = await buildApp();
        try {
            const res = await app.inject({ method: 'GET', url: '/' });
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toContain('text/html');
            expect(res.body).toContain('hello');
        } finally {
            await app.close();
        }
    });

    it('serves built assets by path', async () => {
        const app = await buildApp();
        try {
            const res = await app.inject({ method: 'GET', url: '/index.js' });
            expect(res.statusCode).toBe(200);
            expect(res.body).toContain('console.log(1);');
        } finally {
            await app.close();
        }
    });

    it('still serves the API alongside static files', async () => {
        const app = await buildApp();
        try {
            const res = await app.inject({ method: 'GET', url: '/api/export/capabilities' });
            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.body);
            expect(body.enabled).toBe(true);
            expect(Array.isArray(body.formats)).toBe(true);
        } finally {
            await app.close();
        }
    });
});
