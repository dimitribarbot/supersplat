// Shared loader for the small, optional, deployment-configured assets that get
// baked into ZIP viewer exports: the favicon (VIEWER_FAVICON_URL) and the brand
// icon / brand font (VIEWER_BRAND_ICON_URL, VIEWER_BRAND_FONT_URL).
//
// Fetch-and-embed rather than link-to-remote: the exported ZIP stays
// self-contained (works offline, behind a firewall, and after the source URL
// dies). A cosmetic asset must never cost the user a multi-minute GPU export,
// so every failure is a warning plus `null` — this function never throws.

export type FetchedAsset = { mime: string; ext: string; data: Uint8Array };

export type AssetSpec = {
    // Named in the warnings so a misconfiguration points at the var that caused it.
    envVar: string;
    // Prefix on every warning line, e.g. "favicon", "brand icon".
    label: string;
    // What the operator loses, e.g. "exporting without a favicon".
    consequence: string;
    // Accepted content types, each mapped to the file extension it is stored under.
    mimeExt: Record<string, string>;
    // The same allow-list keyed by URL extension: used to recover the type when
    // the host sends no usable Content-Type.
    extMime: Record<string, string>;
    maxBytes: number;
};

const TIMEOUT_MS = 5000;

// Own-property lookup: mimeExt/extMime are plain object literals, so a hostile
// or misbehaving header/extension value like "__proto__", "constructor" or
// "__defineGetter__" is truthy via the prototype chain even though it was never
// one of the allow-listed entries. Every lookup into either table must go
// through this guard.
const hasOwn = (obj: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

export const fetchAsset = async (configured: string, spec: AssetSpec): Promise<FetchedAsset | null> => {
    const skip = (reason: string): null => {
        console.warn(`${spec.label}: ${reason} (${configured}) - ${spec.consequence}`);
        return null;
    };

    try {
        let parsed: URL;
        try {
            parsed = new URL(configured);
        } catch {
            return skip(`${spec.envVar} is not a valid URL`);
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return skip(`unsupported protocol "${parsed.protocol}" (use http or https)`);
        }

        const res = await fetch(configured, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) {
            return skip(`fetch failed: ${res.status} ${res.statusText}`);
        }

        // Check the advertised size before reading any of the body: this is
        // only an early-out (skip a fetch we already know is too big), not
        // the memory bound itself. `Number(header)` on a missing header is
        // `Number(null)` = `0` and on garbage is `NaN`; neither is `>
        // maxBytes`, so both fall through to the real bound below rather
        // than being (wrongly) treated as a pass. A huge value like "1e400"
        // parses to `Infinity`, which correctly is `> maxBytes`.
        const advertised = Number(res.headers.get('content-length'));
        if (advertised > spec.maxBytes) {
            return skip(`advertised size is ${advertised} bytes, over the ${spec.maxBytes} byte limit`);
        }

        // The actual memory bound: read the body incrementally and abort as
        // soon as the running total is over the cap, instead of buffering the
        // whole response first (a chunked or gzip-encoded response carries no
        // usable Content-Length, so the check above alone would not bound
        // memory - `arrayBuffer()` would still allocate the full payload
        // before any post-read check could reject it).
        if (!res.body) {
            return skip('fetched file is empty');
        }
        const reader = res.body.getReader();
        let total = 0;
        const chunks: Uint8Array[] = [];
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > spec.maxBytes) {
                await reader.cancel();
                return skip(`fetched file exceeds the ${spec.maxBytes} byte limit`);
            }
            chunks.push(value);
        }
        if (total === 0) {
            return skip('fetched file is empty');
        }
        const data = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            data.set(chunk, offset);
            offset += chunk.length;
        }

        // Content-Type decides; the URL's own extension is the fallback for
        // hosts that serve these as octet-stream or send no type at all.
        const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        let mime = hasOwn(spec.mimeExt, contentType) ? contentType : undefined;
        if (!mime) {
            // Reads the *configured* URL's path, not `res.url`: a redirect to
            // a hashed/rewritten path combined with an unusable Content-Type
            // is a known false negative here, whose failure mode is simply
            // "no asset".
            const path = parsed.pathname;
            const dot = path.lastIndexOf('.');
            const ext = dot < 0 ? '' : path.slice(dot + 1).toLowerCase();
            mime = hasOwn(spec.extMime, ext) ? spec.extMime[ext] : undefined;
        }
        if (!mime) {
            return skip(`unsupported file type (content-type "${contentType || 'none'}")`);
        }

        return { mime, ext: spec.mimeExt[mime], data };
    } catch (err) {
        return skip(`fetch failed: ${(err as Error).message}`);
    }
};
