// Optional favicon for ZIP viewer exports. See
// docs/superpowers/specs/2026-07-25-server-favicon-exported-viewer-design.md.
//
// The icon belongs to the deployment, not to a capture or an editing session,
// so it is configured once here (VIEWER_FAVICON_URL) rather than chosen per
// export in the editor: nothing about it crosses the client -> server boundary,
// so it cannot be set or spoofed per request.
//
// Fetch-and-embed rather than link-to-remote: the exported ZIP stays
// self-contained (works offline, behind a firewall, and after the source URL
// dies). A cosmetic asset must never cost the user a multi-minute GPU export,
// so every failure is a warning plus `null` — this function never throws.

export type Favicon = { filename: string; mime: string; data: Uint8Array };

const TIMEOUT_MS = 5000;
const MAX_BYTES = 1024 * 1024;

// The only icon types ever emitted, and the file extension each one gets.
const MIME_EXT: Record<string, string> = {
    'image/png': 'png',
    'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico',
    'image/svg+xml': 'svg',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif'
};

// Same allow-list, keyed by URL extension: used to recover the type when the
// icon host sends no usable Content-Type.
const EXT_MIME: Record<string, string> = {
    png: 'image/png',
    ico: 'image/x-icon',
    svg: 'image/svg+xml',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif'
};

const skip = (url: string, reason: string): null => {
    console.warn(`favicon: ${reason} (${url}) - exporting without a favicon`);
    return null;
};

// Own-property lookup: MIME_EXT/EXT_MIME are plain object literals, so a
// hostile or misbehaving header/extension value like "__proto__",
// "constructor" or "__defineGetter__" is truthy via the prototype chain even
// though it was never one of our six entries. Every lookup into either table
// must go through this guard.
const hasOwn = (obj: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

export const loadFavicon = async (): Promise<Favicon | null> => {
    const configured = process.env.VIEWER_FAVICON_URL?.trim();
    if (!configured) {
        return null;                    // not configured: the default, silent
    }
    try {
        let parsed: URL;
        try {
            parsed = new URL(configured);
        } catch {
            return skip(configured, 'VIEWER_FAVICON_URL is not a valid URL');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return skip(configured, `unsupported protocol "${parsed.protocol}" (use http or https)`);
        }

        const res = await fetch(configured, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) {
            return skip(configured, `fetch failed: ${res.status} ${res.statusText}`);
        }

        // Check the advertised size before reading any of the body: this is
        // only an early-out (skip a fetch we already know is too big), not
        // the memory bound itself. `Number(header)` on a missing header is
        // `Number(null)` = `0` and on garbage is `NaN`; neither is `>
        // MAX_BYTES`, so both fall through to the real bound below rather
        // than being (wrongly) treated as a pass. A huge value like "1e400"
        // parses to `Infinity`, which correctly is `> MAX_BYTES`.
        const advertised = Number(res.headers.get('content-length'));
        if (advertised > MAX_BYTES) {
            return skip(configured, `advertised icon size is ${advertised} bytes, over the ${MAX_BYTES} byte limit`);
        }

        // The actual memory bound: read the body incrementally and abort as
        // soon as the running total is over the cap, instead of buffering the
        // whole response first (a chunked or gzip-encoded response carries no
        // usable Content-Length, so the check above alone would not bound
        // memory - `arrayBuffer()` would still allocate the full payload
        // before any post-read check could reject it).
        if (!res.body) {
            return skip(configured, 'fetched icon is empty');
        }
        const reader = res.body.getReader();
        let total = 0;
        const chunks: Uint8Array[] = [];
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > MAX_BYTES) {
                await reader.cancel();
                return skip(configured, `fetched icon exceeds the ${MAX_BYTES} byte limit`);
            }
            chunks.push(value);
        }
        if (total === 0) {
            return skip(configured, 'fetched icon is empty');
        }
        const data = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            data.set(chunk, offset);
            offset += chunk.length;
        }

        // Content-Type decides; the URL's own extension is the fallback for
        // hosts that serve icons as octet-stream or send no type at all.
        const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        let mime = hasOwn(MIME_EXT, contentType) ? contentType : undefined;
        if (!mime) {
            // Reads the *configured* URL's path, not `res.url`: a redirect to
            // a hashed/rewritten path combined with an unusable Content-Type
            // is a known false negative here, whose failure mode is simply
            // "no icon".
            const path = parsed.pathname;
            const dot = path.lastIndexOf('.');
            const ext = dot < 0 ? '' : path.slice(dot + 1).toLowerCase();
            mime = hasOwn(EXT_MIME, ext) ? EXT_MIME[ext] : undefined;
        }
        if (!mime) {
            return skip(configured, `unsupported image type (content-type "${contentType || 'none'}")`);
        }

        return { filename: `favicon.${MIME_EXT[mime]}`, mime, data };
    } catch (err) {
        return skip(configured, `fetch failed: ${(err as Error).message}`);
    }
};
