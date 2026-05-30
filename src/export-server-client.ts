type Capabilities = { enabled: boolean; gpu: boolean; formats: string[] };

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
    onProgress: (p: ServerProgress) => void
): Promise<Blob> => {
    const form = new FormData();
    form.append('ply', plyGz, 'scene.ply.gz');
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
