import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';

// Minimal multipart body builder — the repo has no multipart test helper and
// this needs only two parts.
const multipart = (options: unknown, master: Buffer) => {
    const b = '----ssvcTestBoundary';
    const head = Buffer.from(
        `--${b}\r\nContent-Disposition: form-data; name="options"\r\n\r\n${JSON.stringify(options)}\r\n` +
        `--${b}\r\nContent-Disposition: form-data; name="master"; filename="m.mp4"\r\n` +
        'Content-Type: video/mp4\r\n\r\n'
    );
    const tail = Buffer.from(`\r\n--${b}--\r\n`);
    return {
        payload: Buffer.concat([head, master, tail]),
        headers: { 'content-type': `multipart/form-data; boundary=${b}` }
    };
};

const post = async (app: any, options: unknown, master = Buffer.from('fake master bytes')) => {
    const { payload, headers } = multipart(options, master);
    return app.inject({ method: 'POST', url: '/api/video/compress', payload, headers });
};

describe('POST /api/video/compress', () => {
    it('accepts a valid request and returns a job id', async () => {
        const app = await buildApp();
        const res = await post(app, { targetMB: 6, frameRate: 30, frames: 1801 });

        expect(res.statusCode).toBe(202);
        expect(res.json().jobId).toMatch(/^job_[0-9a-f]{32}$/);

        await app.close();
    });

    it('rejects a missing master file', async () => {
        const app = await buildApp();
        const b = '----ssvcTestBoundary';
        const res = await app.inject({
            method: 'POST',
            url: '/api/video/compress',
            payload: Buffer.from(
                `--${b}\r\nContent-Disposition: form-data; name="options"\r\n\r\n` +
                `${JSON.stringify({ targetMB: 6, frameRate: 30, frames: 1801 })}\r\n--${b}--\r\n`
            ),
            headers: { 'content-type': `multipart/form-data; boundary=${b}` }
        });

        expect(res.statusCode).toBe(400);
        await app.close();
    });

    it.each([
        ['missing options', undefined],
        ['zero target', { targetMB: 0, frameRate: 30, frames: 1801 }],
        ['negative target', { targetMB: -1, frameRate: 30, frames: 1801 }],
        ['absurd target', { targetMB: 99999, frameRate: 30, frames: 1801 }],
        ['zero frame rate', { targetMB: 6, frameRate: 0, frames: 1801 }],
        ['absurd frame rate', { targetMB: 6, frameRate: 1000, frames: 1801 }],
        ['zero frames', { targetMB: 6, frameRate: 30, frames: 0 }],
        ['absurd frames', { targetMB: 6, frameRate: 30, frames: 9999999 }],
        ['non-numeric target', { targetMB: '6', frameRate: 30, frames: 1801 }]
    ])('rejects %s with 400', async (_label, options) => {
        const app = await buildApp();
        const res = await post(app, options ?? {});

        expect(res.statusCode).toBe(400);
        await app.close();
    });
});
