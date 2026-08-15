import { gzip, unzipSync } from 'fflate';
import { ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { ProgressEvent } from './progress.js';

const REQUIRED = ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const;

export const isConfigured = (): boolean => REQUIRED.every(k => !!process.env[k]);

const cfg = () => ({
    endpoint: process.env.S3_ENDPOINT!,
    region: process.env.S3_REGION!,
    bucket: process.env.S3_BUCKET!,
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    publicBase: process.env.S3_PUBLIC_BASE_URL,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true'
});

// A fresh client per call keeps the module env-driven and test-friendly; the
// publish path is low-frequency so there is no pooling concern.
const makeClient = (c: ReturnType<typeof cfg>) => new S3Client({
    endpoint: c.endpoint,
    region: c.region,
    forcePathStyle: c.forcePathStyle,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey }
});

// Keep in sync with the favicon allow-list in favicon.ts: a published viewer's
// icon (and its poster) must be served with a real image type, not
// octet-stream, or browsers refuse to render it.
const CONTENT_TYPES: Record<string, string> = {
    html: 'text/html',
    js: 'text/javascript',
    css: 'text/css',
    json: 'application/json',
    wasm: 'application/wasm',
    webp: 'image/webp',
    png: 'image/png',
    ico: 'image/x-icon',
    svg: 'image/svg+xml',
    gif: 'image/gif',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg'
};

// Own-property lookup, matching favicon.ts's MIME_EXT/EXT_MIME guard: entry
// names come from our own exporters today, so a prototype-chain key like
// "constructor" is unreachable in practice, but the two maps are documented
// as siblings and should not diverge in style.
const hasOwn = (obj: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

const contentType = (name: string): string => {
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    return hasOwn(CONTENT_TYPES, ext) ? CONTENT_TYPES[ext] : 'application/octet-stream';
};

// Extensions uploaded gzip-compressed with a matching Content-Encoding.
//
// The CDN compresses text types (html/js/css/json) on the fly but serves
// application/octet-stream as-is, so the collision binary is the one large
// object that arrives uncompressed -- and the exported viewer cannot show its
// loading bar until the whole file has landed, because loadVoxelCollision sits
// inside the Promise.all the viewer gates its progress handler on. Measured on
// a real published export: 3.68 MB -> 1.38 MB (2.7x). Covers the start scene's
// index.voxel.bin and each portal scene's scenes/<n>/scene.voxel.bin.
//
// Publish-only by construction: a ZIP that is downloaded and served statically
// has nothing to set the Content-Encoding header, so those bytes must stay raw.
const GZIP_EXTS = new Set(['bin']);

const shouldGzip = (name: string): boolean => GZIP_EXTS.has(name.slice(name.lastIndexOf('.') + 1).toLowerCase());

// fflate's async gzip runs off the main thread, so a 39 MB collision binary does
// not stall the job runner's progress stream while it compresses.
const gzipAsync = (data: Uint8Array): Promise<Uint8Array> => new Promise((resolve, reject) => {
    gzip(data, { level: 6 }, (err, out) => (err ? reject(err) : resolve(out)));
});

const publicUrl = (c: ReturnType<typeof cfg>, prefix: string): string => {
    const base = (c.publicBase ?? `${c.endpoint}/${c.bucket}`).replace(/\/+$/, '');
    return `${base}/${prefix}/index.html`;
};

export type PublishDest = { prefix: string; public: boolean };
export type PublishResult = { url?: string; prefix: string };

// Check whether any object already exists under `<prefix>/`.
export const listPrefix = async (prefix: string): Promise<{ count: number }> => {
    const c = cfg();
    const client = makeClient(c);
    const res = await client.send(new ListObjectsV2Command({
        Bucket: c.bucket,
        Prefix: `${prefix}/`,
        MaxKeys: 1
    }));
    return { count: res.KeyCount ?? 0 };
};

// Unzip the produced viewer ZIP and upload every entry under `<prefix>/`.
export const publishZip = async (
    zipBytes: Uint8Array,
    dest: PublishDest,
    onProgress: (e: ProgressEvent) => void
): Promise<PublishResult> => {
    const c = cfg();
    const client = makeClient(c);
    const bucket = c.bucket;
    const files = unzipSync(zipBytes);
    const entries = Object.entries(files).filter(([name]) => !name.endsWith('/'));
    let done = 0;
    onProgress({ kind: 'progress', message: 'Uploading to Storage', value: 0 });
    for (const [name, data] of entries) {
        const gzipped = shouldGzip(name);
        await client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: `${dest.prefix}/${name}`,
            Body: gzipped ? await gzipAsync(data) : data,
            ContentType: contentType(name),
            ...(gzipped ? { ContentEncoding: 'gzip' as const } : {}),
            ...(dest.public ? { ACL: 'public-read' as const } : {})
        }));
        done++;
        onProgress({ kind: 'progress', message: `Uploaded ${done}/${entries.length}`, value: 100 * done / entries.length });
    }
    return { url: dest.public ? publicUrl(c, dest.prefix) : undefined, prefix: dest.prefix };
};
