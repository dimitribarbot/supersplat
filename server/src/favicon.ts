// Optional favicon for ZIP viewer exports. See
// docs/superpowers/specs/2026-07-25-server-favicon-exported-viewer-design.md.
//
// The icon belongs to the deployment, not to a capture or an editing session,
// so it is configured once here (VIEWER_FAVICON_URL) rather than chosen per
// export in the editor: nothing about it crosses the client -> server boundary,
// so it cannot be set or spoofed per request.
//
// The fetch itself — timeout, size cap, type allow-list, never-throw posture —
// lives in fetch-asset.ts, shared with the brand icon and brand font.

import { fetchAsset } from './fetch-asset.js';

export type Favicon = { filename: string; mime: string; data: Uint8Array };

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

export const loadFavicon = async (): Promise<Favicon | null> => {
    const configured = process.env.VIEWER_FAVICON_URL?.trim();
    if (!configured) {
        return null;                    // not configured: the default, silent
    }
    const fetched = await fetchAsset(configured, {
        envVar: 'VIEWER_FAVICON_URL',
        label: 'favicon',
        consequence: 'exporting without a favicon',
        mimeExt: MIME_EXT,
        extMime: EXT_MIME,
        maxBytes: MAX_BYTES
    });
    if (!fetched) {
        return null;
    }
    return { filename: `favicon.${fetched.ext}`, mime: fetched.mime, data: fetched.data };
};
