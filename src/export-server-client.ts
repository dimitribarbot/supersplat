type Capabilities = { enabled: boolean; gpu: boolean; formats: string[]; publish?: boolean };

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

export type ServerProgress = { message?: string; value?: number };

// POST gzipped ply + options, follow SSE, then fetch the result as a Blob.
export const runServerExport = async (
    plyGz: Blob,
    options: object & { fileType: string; filename: string },
    onProgress: (p: ServerProgress) => void,
    extraPlyGz?: Blob[]
): Promise<Blob> => {
    const form = new FormData();
    form.append('ply', plyGz, 'scene.ply.gz');
    (extraPlyGz ?? []).forEach((b, i) => form.append('extraPly', b, `scene-${i + 1}.ply.gz`));
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
                onProgress({ message: e.message, value: e.value });
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
    extraPlyGz?: Blob[]
): Promise<PublishResult> => {
    const form = new FormData();
    form.append('ply', plyGz, 'scene.ply.gz');
    (extraPlyGz ?? []).forEach((b, i) => form.append('extraPly', b, `scene-${i + 1}.ply.gz`));
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
                onProgress({ message: e.message, value: e.value });
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
