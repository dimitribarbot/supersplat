import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { gunzipSync, zipSync } from 'fflate';

// Capture the commands sent to the mocked S3 client.
const sent: any[] = [];
const clientConfigs: any[] = [];
vi.mock('@aws-sdk/client-s3', () => {
    class S3Client {
        constructor(config: any) {
            clientConfigs.push(config);
        }

        async send(cmd: any) {
            sent.push(cmd);
            // uploadFile streams its body from disk; drain it the way the real
            // SDK would so the byte-counting progress wrapper actually runs.
            if (cmd.__type === 'PutObject' && typeof cmd.input.Body?.[Symbol.asyncIterator] === 'function') {
                for await (const _chunk of cmd.input.Body) { /* drain */ }
            }
            if (cmd.__type === 'ListObjectsV2') return { KeyCount: cmd.input.Prefix.includes('exists') ? 1 : 0 };
            if (cmd.__type === 'HeadObject') {
                if (cmd.input.Key.includes('exists')) return {};
                // shape of a real S3 404 from HeadObject (no body, name NotFound)
                const err: any = new Error('NotFound');
                err.name = 'NotFound';
                err.$metadata = { httpStatusCode: 404 };
                throw err;
            }
            return {};
        }
    }
    class PutObjectCommand {
        __type = 'PutObject';
        constructor(public input: any) {}
    }
    class ListObjectsV2Command { __type = 'ListObjectsV2'; constructor(public input: any) {} }
    class HeadObjectCommand { __type = 'HeadObject'; constructor(public input: any) {} }
    return { S3Client, PutObjectCommand, ListObjectsV2Command, HeadObjectCommand };
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

beforeEach(() => { sent.length = 0; clientConfigs.length = 0; clearEnv(); vi.resetModules(); });
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
            '0_0/0.webp': new Uint8Array([1, 2, 3]),
            'favicon.png': new Uint8Array([4, 5, 6]),
            'poster.jpg': new Uint8Array([7, 8, 9])
        });
        const onProgress = vi.fn();
        const res = await s3.publishZip(zip, { prefix: 'sub/scene', public: true }, onProgress);
        const puts = sent.filter(c => c.__type === 'PutObject');
        expect(puts).toHaveLength(5);
        const byKey = Object.fromEntries(puts.map(p => [p.input.Key, p.input]));
        expect(byKey['sub/scene/index.html'].ContentType).toBe('text/html');
        expect(byKey['sub/scene/index.html'].ACL).toBe('public-read');
        expect(byKey['sub/scene/0_0/meta.json'].ContentType).toBe('application/json');
        expect(byKey['sub/scene/0_0/0.webp'].ContentType).toBe('image/webp');
        expect(byKey['sub/scene/favicon.png'].ContentType).toBe('image/png');
        expect(byKey['sub/scene/poster.jpg'].ContentType).toBe('image/jpeg');
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

    // The collision binary is the only large object the CDN will not compress on
    // the fly (it is served as application/octet-stream), and the exported viewer
    // cannot show its loading bar until the whole file has arrived -- see
    // loadVoxelCollision, which the viewer's Promise.all gate waits on.
    it('uploads .voxel.bin entries gzip-compressed with a gzip content-encoding', async () => {
        setEnv();
        const s3 = await import('../src/s3.js');
        // Repetitive payload so gzip is meaningfully smaller than the original.
        const original = new Uint8Array(64 * 1024).fill(7);
        const zip = zipSync({
            'index.voxel.bin': original,
            'scenes/2/scene.voxel.bin': original
        });
        await s3.publishZip(zip, { prefix: 'x', public: false }, () => {});
        const puts = sent.filter(c => c.__type === 'PutObject');
        const byKey = Object.fromEntries(puts.map(p => [p.input.Key, p.input]));
        for (const key of ['x/index.voxel.bin', 'x/scenes/2/scene.voxel.bin']) {
            expect(byKey[key].ContentEncoding).toBe('gzip');
            expect(byKey[key].Body.length).toBeLessThan(original.length);
            expect(gunzipSync(byKey[key].Body)).toEqual(original);
        }
    });

    it('leaves entries the CDN already compresses untouched and without a content-encoding', async () => {
        setEnv();
        const s3 = await import('../src/s3.js');
        const json = new TextEncoder().encode('{"a":1}');
        const webp = new Uint8Array([1, 2, 3]);
        const zip = zipSync({ 'lod-meta.json': json, '0_0/0.webp': webp });
        await s3.publishZip(zip, { prefix: 'x', public: false }, () => {});
        const puts = sent.filter(c => c.__type === 'PutObject');
        const byKey = Object.fromEntries(puts.map(p => [p.input.Key, p.input]));
        expect(byKey['x/lod-meta.json'].ContentEncoding).toBeUndefined();
        expect(byKey['x/lod-meta.json'].Body).toEqual(json);
        expect(byKey['x/0_0/0.webp'].ContentEncoding).toBeUndefined();
        expect(byKey['x/0_0/0.webp'].Body).toEqual(webp);
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

describe('objectExists', () => {
    // A rendered image/video is a single object, not a folder of them, so the
    // overwrite check is an exact-key HeadObject -- a prefix listing would also
    // match `shot.png.bak` and report a collision that isn't one.
    it('is true for a present key and false on a 404', async () => {
        setEnv();
        const s3 = await import('../src/s3.js');
        expect(await s3.objectExists('shots/exists.png')).toBe(true);
        expect(await s3.objectExists('shots/fresh.png')).toBe(false);
        const head = sent.find(c => c.__type === 'HeadObject');
        expect(head.input.Key).toBe('shots/exists.png');
    });
});

describe('uploadFile', () => {
    const withTempFile = async (bytes: Uint8Array, fn: (path: string) => Promise<void>) => {
        const dir = await mkdtemp(join(tmpdir(), 'ss-upload-test-'));
        const file = join(dir, 'render.bin');
        await writeFile(file, bytes);
        try { await fn(file); } finally { await rm(dir, { recursive: true, force: true }); }
    };

    it('puts the file at the key with its media type, a public ACL and the object url', async () => {
        setEnv({ S3_PUBLIC_BASE_URL: 'https://cdn.example.com' });
        const s3 = await import('../src/s3.js');
        await withTempFile(new Uint8Array([1, 2, 3, 4]), async (path) => {
            const res = await s3.uploadFile(path, 'shots/2026/my-render.mp4', true);
            const put = sent.find(c => c.__type === 'PutObject');
            expect(put.input.Key).toBe('shots/2026/my-render.mp4');
            expect(put.input.ContentType).toBe('video/mp4');
            expect(put.input.ContentLength).toBe(4);
            expect(put.input.ACL).toBe('public-read');
            expect(res).toEqual({ url: 'https://cdn.example.com/shots/2026/my-render.mp4', key: 'shots/2026/my-render.mp4' });
        });
    });

    it('omits ACL and url when private', async () => {
        setEnv();
        const s3 = await import('../src/s3.js');
        await withTempFile(new Uint8Array([1]), async (path) => {
            const res = await s3.uploadFile(path, 'my-render.png', false);
            const put = sent.find(c => c.__type === 'PutObject');
            expect(put.input.ContentType).toBe('image/png');
            expect(put.input.ACL).toBeUndefined();
            expect(res).toEqual({ url: undefined, key: 'my-render.png' });
        });
    });

    // The SDK buffers a stream body ONLY to compute a checksum from it, which is
    // what made byte-counting the read stream measure buffering instead of
    // upload. Supplying the value up front means there is nothing to compute:
    // the body streams AND S3 still validates what it received, rejecting a
    // corrupted PUT with BadDigest rather than storing it.
    //
    // Measured against a deliberately slow endpoint, 21 MB body: SDK-computed
    // checksum drained the body at 37 ms while the receiver finished at 970 ms;
    // precomputed, 905 ms vs 946 ms.
    it('sends a precomputed CRC32 so S3 validates the bytes it received', async () => {
        setEnv();
        const s3 = await import('../src/s3.js');
        // 0xCBF43926 is the standard CRC-32 check value for "123456789", so this
        // pins the encoding (big-endian, base64) against a known constant rather
        // than against another call to the same hash function
        await withTempFile(new TextEncoder().encode('123456789'), async (path) => {
            await s3.uploadFile(path, 'clip.mp4', false);
            expect(sent.find(c => c.__type === 'PutObject').input.ChecksumCRC32).toBe('y/Q5Jg==');
        });
    });

    // No client-level override any more: we hand over the value instead of
    // switching the SDK's checksumming off.
    it('leaves the SDK checksum configuration at its default', async () => {
        setEnv();
        const s3 = await import('../src/s3.js');
        await withTempFile(new Uint8Array([1]), async (path) => {
            await s3.uploadFile(path, 'clip.mp4', false);
        });
        expect(clientConfigs.at(-1).requestChecksumCalculation).toBeUndefined();
    });

    it('leaves the publish path\'s checksum behaviour untouched', async () => {
        setEnv();
        const s3 = await import('../src/s3.js');
        await s3.publishZip(zipSync({ 'index.html': new TextEncoder().encode('x') }), { prefix: 'p', public: false }, () => {});
        expect(clientConfigs.at(-1).requestChecksumCalculation).toBeUndefined();
    });

    // The client's xhr.upload progress ends when the last byte reaches the
    // server; the PutObject that follows is invisible to it. Reporting bytes as
    // the body is read off disk is what makes that phase observable.
    it('reports store progress as the body is read, ending at 100', async () => {
        setEnv();
        const s3 = await import('../src/s3.js');
        // larger than the 64 KB default read chunk, so progress arrives in steps
        await withTempFile(new Uint8Array(200 * 1024).fill(3), async (path) => {
            const seen: number[] = [];
            await s3.uploadFile(path, 'clip.mp4', false, pct => seen.push(pct));
            expect(seen.length).toBeGreaterThan(1);
            expect(seen[seen.length - 1]).toBe(100);
            // monotonic and within range
            expect(seen).toEqual([...seen].sort((a, b) => a - b));
            expect(Math.min(...seen)).toBeGreaterThan(0);
            expect(Math.max(...seen)).toBeLessThanOrEqual(100);
        });
    });

    // Render output types the publish path never produced. Without these a
    // browser opening the public url downloads the file instead of playing it.
    it.each([
        ['clip.webm', 'video/webm'],
        ['clip.mov', 'video/quicktime'],
        ['clip.mkv', 'video/x-matroska'],
        ['shot.jpg', 'image/jpeg'],
        ['shot.webp', 'image/webp']
    ])('serves %s as %s', async (name, expected) => {
        setEnv();
        const s3 = await import('../src/s3.js');
        await withTempFile(new Uint8Array([1]), async (path) => {
            await s3.uploadFile(path, name, false);
            expect(sent.find(c => c.__type === 'PutObject').input.ContentType).toBe(expected);
        });
    });
});
