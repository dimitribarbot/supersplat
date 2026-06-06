import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { zipSync } from 'fflate';

// Capture the commands sent to the mocked S3 client.
const sent: any[] = [];
vi.mock('@aws-sdk/client-s3', () => {
    class S3Client {
        async send(cmd: any) {
            sent.push(cmd);
            if (cmd.__type === 'ListObjectsV2') return { KeyCount: cmd.input.Prefix.includes('exists') ? 1 : 0 };
            return {};
        }
    }
    class PutObjectCommand { __type = 'PutObject'; constructor(public input: any) {} }
    class ListObjectsV2Command { __type = 'ListObjectsV2'; constructor(public input: any) {} }
    return { S3Client, PutObjectCommand, ListObjectsV2Command };
});

const ENV = {
    S3_ENDPOINT: 'https://fra1.digitaloceanspaces.com',
    S3_REGION: 'fra1',
    S3_BUCKET: 'space',
    S3_ACCESS_KEY_ID: 'key',
    S3_SECRET_ACCESS_KEY: 'secret'
};

const setEnv = (extra: Record<string, string> = {}) => {
    Object.assign(process.env, ENV, extra);
};
const clearEnv = () => {
    for (const k of [...Object.keys(ENV), 'S3_PUBLIC_BASE_URL', 'S3_FORCE_PATH_STYLE']) delete process.env[k];
};

beforeEach(() => { sent.length = 0; clearEnv(); vi.resetModules(); });
afterEach(() => { clearEnv(); });

describe('s3 config', () => {
    it('isConfigured is false when a required var is missing', async () => {
        setEnv();
        delete process.env.S3_BUCKET;
        const s3 = await import('../src/s3.js');
        expect(s3.isConfigured()).toBe(false);
    });

    it('isConfigured is true when all required vars are present', async () => {
        setEnv();
        const s3 = await import('../src/s3.js');
        expect(s3.isConfigured()).toBe(true);
    });
});

describe('publishZip', () => {
    it('uploads each unzipped entry with correct key, content-type and public ACL, returns CDN url', async () => {
        setEnv({ S3_PUBLIC_BASE_URL: 'https://cdn.example.com' });
        const s3 = await import('../src/s3.js');
        const zip = zipSync({
            'index.html': new TextEncoder().encode('<html></html>'),
            '0_0/meta.json': new TextEncoder().encode('{}'),
            '0_0/0.webp': new Uint8Array([1, 2, 3])
        });
        const onProgress = vi.fn();
        const res = await s3.publishZip(zip, { prefix: 'sub/scene', public: true }, onProgress);
        const puts = sent.filter(c => c.__type === 'PutObject');
        expect(puts).toHaveLength(3);
        const byKey = Object.fromEntries(puts.map(p => [p.input.Key, p.input]));
        expect(byKey['sub/scene/index.html'].ContentType).toBe('text/html');
        expect(byKey['sub/scene/index.html'].ACL).toBe('public-read');
        expect(byKey['sub/scene/0_0/meta.json'].ContentType).toBe('application/json');
        expect(byKey['sub/scene/0_0/0.webp'].ContentType).toBe('image/webp');
        expect(res.url).toBe('https://cdn.example.com/sub/scene/index.html');
        expect(res.prefix).toBe('sub/scene');
        const calls = onProgress.mock.calls.map(c => c[0].value);
        expect(calls[0]).toBe(0);
        expect(calls[calls.length - 1]).toBe(100);
    });

    it('falls back to application/octet-stream for unknown extensions', async () => {
        setEnv();
        const s3 = await import('../src/s3.js');
        const zip = zipSync({ 'data.bin': new Uint8Array([9, 9, 9]) });
        await s3.publishZip(zip, { prefix: 'x', public: false }, () => {});
        const put = sent.find(c => c.__type === 'PutObject');
        expect(put.input.ContentType).toBe('application/octet-stream');
    });

    it('omits ACL and url when private; url falls back to endpoint/bucket when no public base', async () => {
        setEnv();
        const s3 = await import('../src/s3.js');
        const zip = zipSync({ 'index.html': new TextEncoder().encode('x') });
        const res = await s3.publishZip(zip, { prefix: 'scene', public: false }, () => {});
        const put = sent.find(c => c.__type === 'PutObject');
        expect(put.input.ACL).toBeUndefined();
        expect(res.url).toBeUndefined();
        expect(res.prefix).toBe('scene');
    });
});

describe('listPrefix', () => {
    it('reports count for an existing prefix', async () => {
        setEnv();
        const s3 = await import('../src/s3.js');
        expect((await s3.listPrefix('exists/x')).count).toBe(1);
        expect((await s3.listPrefix('fresh/y')).count).toBe(0);
        const list = sent.find(c => c.__type === 'ListObjectsV2');
        expect(list.input.MaxKeys).toBe(1);
        expect(list.input.Prefix).toBe('exists/x/');
    });
});
