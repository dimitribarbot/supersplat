import { unzipSync } from 'fflate';
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

const CONTENT_TYPES: Record<string, string> = {
    html: 'text/html',
    js: 'text/javascript',
    css: 'text/css',
    json: 'application/json',
    wasm: 'application/wasm',
    webp: 'image/webp',
    png: 'image/png'
};

const contentType = (name: string): string => {
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    return CONTENT_TYPES[ext] ?? 'application/octet-stream';
};

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
        await client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: `${dest.prefix}/${name}`,
            Body: data,
            ContentType: contentType(name),
            ...(dest.public ? { ACL: 'public-read' as const } : {})
        }));
        done++;
        onProgress({ kind: 'progress', message: `Uploaded ${done}/${entries.length}`, value: 100 * done / entries.length });
    }
    return { url: dest.public ? publicUrl(c, dest.prefix) : undefined, prefix: dest.prefix };
};
