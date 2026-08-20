import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { crc32 } from 'node:zlib';
import { gzip, unzipSync } from 'fflate';
import { HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
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
    jpeg: 'image/jpeg',
    // rendered image/video uploads (uploadFile). A public url served as
    // octet-stream downloads instead of rendering or playing in the browser.
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska'
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

const objectUrl = (c: ReturnType<typeof cfg>, key: string): string => {
    const base = (c.publicBase ?? `${c.endpoint}/${c.bucket}`).replace(/\/+$/, '');
    return `${base}/${key}`;
};

const publicUrl = (c: ReturnType<typeof cfg>, prefix: string): string => objectUrl(c, `${prefix}/index.html`);

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

// CRC32 of a file, base64-encoded big-endian — the form S3 expects in
// `x-amz-checksum-crc32`. Folded chunk by chunk so a multi-hundred-MB render is
// never held in memory just to be hashed.
const crc32Base64 = async (filePath: string): Promise<string> => {
    let crc = 0;
    for await (const chunk of createReadStream(filePath)) {
        crc = crc32(chunk as Buffer, crc);
    }
    const out = Buffer.alloc(4);
    out.writeUInt32BE(crc >>> 0);
    return out.toString('base64');
};

// Whether one exact object already exists. A rendered image or video is a
// single object rather than a folder of them, so the overwrite check is a
// HeadObject on the exact key -- listPrefix would also match `shot.png.bak`
// and report a collision that isn't one.
export const objectExists = async (key: string): Promise<boolean> => {
    const c = cfg();
    const client = makeClient(c);
    try {
        await client.send(new HeadObjectCommand({ Bucket: c.bucket, Key: key }));
        return true;
    } catch (err: any) {
        if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return false;
        throw err;
    }
};

export type UploadResult = { url?: string; key: string };

// Upload one already-encoded file (a rendered image or video) to `key`.
//
// Streams from disk rather than buffering: a rendered video is routinely
// hundreds of MB. PutObject needs the length up front when the body is a
// stream, which is exactly why the route stages the upload in a temp file
// instead of piping the multipart part straight through.
//
// No gzip pass here (unlike publishZip): these payloads are already compressed
// formats, so gzipping them costs CPU and grows the object.
//
// `onProgress` receives 0..100 as the body is read off disk. This is the only
// window the browser has onto this phase: its xhr.upload progress ended when
// the last byte reached us, and everything after that is invisible to it.
export const uploadFile = async (
    filePath: string,
    key: string,
    isPublic: boolean,
    onProgress?: (percent: number) => void
): Promise<UploadResult> => {
    const c = cfg();
    const client = makeClient(c);
    const { size } = await stat(filePath);

    // Hand the SDK a precomputed checksum rather than letting it derive one.
    //
    // The SDK buffers a stream body ONLY so it can checksum it, and that
    // buffering is what made the progress below meaningless: against a slow
    // endpoint with a 21 MB body it drained the body at 37 ms while the receiver
    // only finished at 970 ms, so the bar hit 100% in 4% of the transfer and
    // then stalled. Supplying the value leaves nothing to compute — measured
    // 905 ms vs 946 ms, i.e. the read tracks the network — while S3 still
    // verifies what it received and rejects a corrupted PUT with BadDigest
    // instead of storing it.
    //
    // Costs one extra sequential read of the (local) file. It cannot share the
    // progress pass below: the checksum travels as a request header, so it has
    // to be known before the first byte goes out.
    const checksum = await crc32Base64(filePath);

    // Count through a Transform, not a 'data' listener on the read stream:
    // attaching one would switch the stream to flowing mode and drain the body
    // before the SDK ever saw it.
    let sentBytes = 0;
    const source = createReadStream(filePath);
    const body = source.pipe(new Transform({
        transform(chunk, _encoding, callback) {
            sentBytes += chunk.length;
            onProgress?.(size > 0 ? 100 * sentBytes / size : 100);
            callback(null, chunk);
        }
    }));
    // .pipe() does not forward errors, so a read failure would otherwise leave
    // the SDK waiting on a stream that never ends.
    source.on('error', err => body.destroy(err));

    await client.send(new PutObjectCommand({
        Bucket: c.bucket,
        Key: key,
        Body: body,
        ContentLength: size,
        ContentType: contentType(key),
        ChecksumCRC32: checksum,
        ...(isPublic ? { ACL: 'public-read' as const } : {})
    }));
    return { url: isPublic ? objectUrl(c, key) : undefined, key };
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
    // `loc` is the structured form the editor localizes; `message` stays English
    // for the server log and as a fallback. Same contract the shared export core
    // and video-compress already use — without it these two lines were the only
    // untranslated text in a publish.
    onProgress({
        kind: 'progress',
        message: 'Uploading to Storage',
        value: 0,
        loc: { segments: [{ key: 'export.progress.uploading-storage' }] }
    });
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
        onProgress({
            kind: 'progress',
            message: `Uploaded ${done}/${entries.length}`,
            value: 100 * done / entries.length,
            loc: { segments: [{ key: 'export.progress.uploaded' }], counter: { index: done, total: entries.length } }
        });
    }
    return { url: dest.public ? publicUrl(c, dest.prefix) : undefined, prefix: dest.prefix };
};
