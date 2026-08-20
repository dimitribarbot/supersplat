type Capabilities = { enabled: boolean; gpu: boolean; formats: string[]; publish?: boolean; video?: boolean; maxUpload?: number };

let cached: Capabilities | null | undefined;

export const probeExportCapabilities = async (): Promise<Capabilities | null> => {
    if (cached !== undefined) return cached;
    try {
        const res = await fetch(`${location.origin}/api/export/capabilities`);
        if (res.ok) {
            cached = await res.json() as Capabilities;
        } else {
            cached = null;   // server explicitly responded that export is unavailable — cache it
        }
    } catch {
        // transient error (network/parse): do not cache, allow the next call to retry
    }
    return cached ?? null;
};

// `loc` (when present) is the structured, localizable form of the progress line
// forwarded from the server's shared export core; the caller passes it straight to
// the editor's progressUpdate handler, which localizes it. `message` is the English
// fallback. Shape mirrors server ProgressLoc.
export type ServerProgress = {
    message?: string;
    value?: number;
    loc?: { segments?: { key: string; params?: Record<string, string | number> }[]; counter?: { index: number; total: number }; name?: string; nameKey?: string };
    collision?: { index: number; bytes: number };
};

// POST gzipped ply + options, follow SSE, then fetch the result as a Blob.
export const runServerExport = async (
    plyGz: Blob,
    options: object & { fileType: string; filename: string },
    onProgress: (p: ServerProgress) => void,
    extraPlyGz?: Blob[],
    poster?: Blob,
    annotationImages?: { name: string; data: Uint8Array }[]
): Promise<Blob> => {
    const form = new FormData();
    form.append('ply', plyGz, 'scene.ply.gz');
    (extraPlyGz ?? []).forEach((b, i) => form.append('extraPly', b, `scene-${i + 1}.ply.gz`));
    if (poster) form.append('poster', poster, 'poster.jpg');
    (annotationImages ?? []).forEach(img => form.append('annotationImage', new Blob([img.data as BlobPart]), img.name));
    form.append('options', JSON.stringify(options));
    const startRes = await fetch(`${location.origin}/api/export`, { method: 'POST', body: form });
    if (!startRes.ok) throw new Error(`server export failed to start (${startRes.status})`);
    const { jobId } = await startRes.json();
    if (!jobId) throw new Error('server did not return a job id');

    await new Promise<void>((resolve, reject) => {
        const es = new EventSource(`${location.origin}/api/export/${jobId}/events`);
        es.onmessage = (ev) => {
            let e;
            try {
                e = JSON.parse(ev.data);
            } catch (err) {
                es.close();
                reject(new Error(`unexpected SSE data: ${ev.data}`));
                return;
            }
            if (e.kind === 'progress') {
                onProgress({ message: e.message, value: e.value, loc: e.loc, collision: e.collision });
            } else if (e.kind === 'done') {
                es.close();
                resolve();
            } else if (e.kind === 'error') {
                es.close();
                reject(new Error(e.message));
            }
        };
        es.onerror = () => {
            es.close();
            reject(new Error('progress stream error'));
        };
    });

    const resultRes = await fetch(`${location.origin}/api/export/${jobId}/result`);
    if (!resultRes.ok) throw new Error(`server export result unavailable (${resultRes.status})`);
    return resultRes.blob();
};

export type PublishResult = { url?: string; prefix: string };

// Thrown when the destination prefix already has objects and overwrite wasn't set.
export class PublishExistsError extends Error {
    count: number;
    constructor(count: number) {
        super('destination already exists');
        this.name = 'PublishExistsError';
        this.count = count;
    }
}

export const checkPublishExists = async (subfolder: string, name: string): Promise<{ exists: boolean; count: number }> => {
    const qs = new URLSearchParams();
    if (subfolder) qs.set('subfolder', subfolder);
    qs.set('name', name);
    const res = await fetch(`${location.origin}/api/publish/exists?${qs.toString()}`);
    if (!res.ok) throw new Error(`publish-exists check failed (${res.status})`);
    return res.json();
};

// POST gzipped ply + options, follow SSE, resolve with the publish result from
// the terminal `done` event. Throws PublishExistsError on a 409.
export const runServerPublish = async (
    plyGz: Blob,
    options: object & { name: string; public: boolean; overwrite: boolean },
    onProgress: (p: ServerProgress) => void,
    extraPlyGz?: Blob[],
    poster?: Blob,
    annotationImages?: { name: string; data: Uint8Array }[]
): Promise<PublishResult> => {
    const form = new FormData();
    form.append('ply', plyGz, 'scene.ply.gz');
    (extraPlyGz ?? []).forEach((b, i) => form.append('extraPly', b, `scene-${i + 1}.ply.gz`));
    if (poster) form.append('poster', poster, 'poster.jpg');
    (annotationImages ?? []).forEach(img => form.append('annotationImage', new Blob([img.data as BlobPart]), img.name));
    form.append('options', JSON.stringify(options));
    const startRes = await fetch(`${location.origin}/api/publish`, { method: 'POST', body: form });
    if (startRes.status === 409) {
        const body = await startRes.json().catch(() => ({ count: 0 }));
        throw new PublishExistsError(body.count ?? 0);
    }
    if (!startRes.ok) throw new Error(`server publish failed to start (${startRes.status})`);
    const { jobId } = await startRes.json();
    if (!jobId) throw new Error('server did not return a job id');

    return new Promise<PublishResult>((resolve, reject) => {
        const es = new EventSource(`${location.origin}/api/publish/${jobId}/events`);
        es.onmessage = (ev) => {
            let e;
            try {
                e = JSON.parse(ev.data);
            } catch (err) {
                es.close();
                reject(new Error(`unexpected SSE data: ${ev.data}`));
                return;
            }
            if (e.kind === 'progress') {
                onProgress({ message: e.message, value: e.value, loc: e.loc, collision: e.collision });
            } else if (e.kind === 'done') {
                es.close();
                resolve({ url: e.url, prefix: e.prefix });
            } else if (e.kind === 'error') {
                es.close();
                reject(new Error(e.message));
            }
        };
        es.onerror = () => {
            es.close();
            reject(new Error('progress stream error'));
        };
    });
};

// --- rendered image / video upload -------------------------------------------
//
// A render is a single object (`<subfolder>/<name>.<ext>`), not a folder of
// viewer files, so it uses its own routes rather than the publish job pipeline:
// the bytes already exist client-side and there is nothing for the server to
// build, so there is no job and no SSE stream.

export type UploadResult = { url?: string; key: string };

export type UploadOptions = {
    subfolder: string;
    name: string;
    ext: string;
    public: boolean;
    overwrite: boolean;
};

// Thrown when the destination object already exists and overwrite wasn't set.
export class UploadExistsError extends Error {
    constructor() {
        super('destination already exists');
        this.name = 'UploadExistsError';
    }
}

export const checkUploadExists = async (subfolder: string, name: string, ext: string): Promise<boolean> => {
    const qs = new URLSearchParams();
    if (subfolder) qs.set('subfolder', subfolder);
    qs.set('name', name);
    qs.set('ext', ext);
    const res = await fetch(`${location.origin}/api/upload/exists?${qs.toString()}`);
    if (!res.ok) {
        // a hand-typed name outside [A-Za-z0-9._-] lands here; surface the
        // server's reason rather than a bare status code, since this check is
        // what stops the render before it starts
        let detail = '';
        try {
            detail = (await res.json())?.error ?? '';
        } catch {
            // non-JSON error body (e.g. a proxy's HTML page)
        }
        throw new Error(detail || `upload-exists check failed (${res.status})`);
    }
    const { exists } = await res.json();
    return !!exists;
};

// Fraction of the reported progress owned by the browser→server transfer; the
// rest belongs to the server→S3 PutObject that follows it. Both legs move
// roughly the same bytes, so they split the bar evenly.
const UPLOAD_SHARE = 0.5;

// Send the rendered file and resolve with its storage location.
//
// Two measured phases, because no single mechanism can see both:
//   1. browser → server, reported by xhr.upload (fetch reports no upload
//      progress at all, which is why this is XHR). Note this only works because
//      the service worker leaves non-GET requests alone — a request answered via
//      respondWith() is re-issued by the worker and fires no upload events. See
//      src/sw.ts.
//   2. server → S3, reported over SSE by the upload job. Invisible to phase 1:
//      by then the client has sent its last byte and is simply waiting.
//
// `onProgress` receives 0..1 spanning both; `onStoring` fires at the handover.
export const uploadRender = async (
    file: Blob,
    options: UploadOptions,
    onProgress: (fraction: number) => void,
    onStoring: () => void
): Promise<UploadResult> => {
    const form = new FormData();
    // options first so the server can reject a bad destination (or a collision)
    // before the body streams in — see the /api/upload handler
    form.append('options', JSON.stringify(options));
    form.append('file', file, `render.${options.ext}`);

    const jobId = await new Promise<string>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${location.origin}/api/upload`);

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && e.total > 0) onProgress(UPLOAD_SHARE * e.loaded / e.total);
        };
        xhr.upload.onload = () => {
            onProgress(UPLOAD_SHARE);
            onStoring();
        };

        xhr.onload = () => {
            if (xhr.status === 409) {
                reject(new UploadExistsError());
                return;
            }
            if (xhr.status < 200 || xhr.status >= 300) {
                let detail = '';
                try {
                    detail = JSON.parse(xhr.responseText)?.error ?? '';
                } catch {
                    // non-JSON error body (e.g. a proxy's HTML page)
                }
                reject(new Error(detail || `upload failed (${xhr.status})`));
                return;
            }
            try {
                resolve(JSON.parse(xhr.responseText).jobId);
            } catch {
                reject(new Error('server returned an unexpected upload result'));
            }
        };
        xhr.onerror = () => reject(new Error('upload failed'));
        xhr.onabort = () => reject(new Error('upload cancelled'));

        xhr.send(form);
    });

    if (!jobId) throw new Error('server did not return a job id');

    return new Promise<UploadResult>((resolve, reject) => {
        const es = new EventSource(`${location.origin}/api/upload/${jobId}/events`);
        es.onmessage = (ev) => {
            let e;
            try {
                e = JSON.parse(ev.data);
            } catch (err) {
                es.close();
                reject(new Error(`unexpected SSE data: ${ev.data}`));
                return;
            }
            if (e.kind === 'progress') {
                if (typeof e.value === 'number') {
                    onProgress(UPLOAD_SHARE + (1 - UPLOAD_SHARE) * e.value / 100);
                }
            } else if (e.kind === 'done') {
                es.close();
                onProgress(1);
                resolve({ url: e.url, key: e.key });
            } else if (e.kind === 'error') {
                es.close();
                reject(new Error(e.message));
            }
        };
        es.onerror = () => {
            es.close();
            reject(new Error('progress stream error'));
        };
    });
};

export type VideoCompressOptions = {
    targetMB: number;
    frameRate: number;
    frames: number;
};

// POST the rendered master, follow SSE, then fetch the compressed result.
// Reuses the export job's event and result routes verbatim — only the start
// endpoint differs.
export const runVideoCompress = async (
    master: Blob,
    options: VideoCompressOptions,
    onProgress: (p: ServerProgress) => void,
    signal?: AbortSignal
): Promise<Blob> => {
    const form = new FormData();
    // options first so the server has them before the (large) file streams in
    form.append('options', JSON.stringify(options));
    form.append('master', master, 'master.bin');

    const startRes = await fetch(`${location.origin}/api/video/compress`, { method: 'POST', body: form, signal });
    if (!startRes.ok) throw new Error(`video compression failed to start (${startRes.status})`);
    const { jobId } = await startRes.json();
    if (!jobId) throw new Error('server did not return a job id');

    await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error('cancelled'));
            return;
        }
        const es = new EventSource(`${location.origin}/api/export/${jobId}/events`);
        // Closing the stream is the cancel mechanism: the server's abandon
        // timer kills the job when its last subscriber disappears.
        const abort = () => {
            es.close();
            reject(new Error('cancelled'));
        };
        signal?.addEventListener('abort', abort, { once: true });

        es.onmessage = (ev) => {
            let e;
            try {
                e = JSON.parse(ev.data);
            } catch (err) {
                es.close();
                reject(new Error(`unexpected SSE data: ${ev.data}`));
                return;
            }
            if (e.kind === 'progress') {
                onProgress({ message: e.message, value: e.value, loc: e.loc });
            } else if (e.kind === 'done') {
                es.close();
                resolve();
            } else if (e.kind === 'error') {
                es.close();
                reject(new Error(e.message));
            }
        };
        es.onerror = () => {
            es.close();
            reject(new Error('progress stream error'));
        };
    });

    const resultRes = await fetch(`${location.origin}/api/export/${jobId}/result`);
    if (!resultRes.ok) throw new Error(`compressed video unavailable (${resultRes.status})`);
    return resultRes.blob();
};
