// Operator brand for ZIP viewer exports, configured on the export server. See
// docs/superpowers/specs/2026-10-09-publish-brand-override-design.md.
//
//   VIEWER_BRAND_NAME       the operator brand name
//   VIEWER_BRAND_ICON_URL   the operator icon: overlay badge, info panel
//                           fallback, and the favicon
//   VIEWER_BRAND_LOGO_URL   the operator logo, shown alone in the info panel
//                           header when set
//   VIEWER_BRAND_URL        the operator website (https only): target of the
//                           info panel header, and of the "Powered by" link
//                           when an S3 publish carries a client brand
//
// Icon and logo are fetched and embedded (fetch-asset.ts), so a ZIP stays
// self-contained; each one that cannot be fetched drops out on its own and the
// export never fails because of branding. Nothing here throws. A per-publish
// client brand is merged on top in brand-resolve.ts.

import { fetchAsset } from './fetch-asset.js';

export type BrandAsset = { filename: string; mime: string; data: Uint8Array };

export type EnvBrand = {
    name: string | null;
    icon: BrandAsset | null;
    logo: BrandAsset | null;
    url: string | null;
};

const IMAGE_MAX_BYTES = 1024 * 1024;

// The only image types ever embedded, and the file extension each one gets.
// Keep in sync with CONTENT_TYPES in s3.ts so a published copy is served with
// a real image type.
const IMAGE_MIME_EXT: Record<string, string> = {
    'image/png': 'png',
    'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico',
    'image/svg+xml': 'svg',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif'
};

const IMAGE_EXT_MIME: Record<string, string> = {
    png: 'image/png',
    ico: 'image/x-icon',
    svg: 'image/svg+xml',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif'
};

// Variables an older deployment may still set. Ignored, but said so once at
// startup, since their effect silently disappeared.
const REMOVED_VARS: Record<string, string> = {
    VIEWER_FAVICON_URL: ' - VIEWER_BRAND_ICON_URL is now also the favicon',
    VIEWER_BRAND_FONT_NAME: '',
    VIEWER_BRAND_FONT_URL: ''
};

const env = (name: string): string => (process.env[name] ?? '').trim();

export const warnRemovedBrandEnv = (): void => {
    for (const [name, hint] of Object.entries(REMOVED_VARS)) {
        if (env(name)) {
            console.warn(`${name} is no longer supported and is ignored${hint}`);
        }
    }
};

const loadImage = async (url: string, envVar: string, label: string, stem: string): Promise<BrandAsset | null> => {
    const fetched = await fetchAsset(url, {
        envVar,
        label,
        consequence: `exporting without the ${label}`,
        mimeExt: IMAGE_MIME_EXT,
        extMime: IMAGE_EXT_MIME,
        maxBytes: IMAGE_MAX_BYTES
    });
    return fetched ? { filename: `${stem}.${fetched.ext}`, mime: fetched.mime, data: fetched.data } : null;
};

const parseBrandUrl = (raw: string): string | null => {
    if (!raw) {
        return null;
    }
    try {
        const url = new URL(raw);
        if (url.protocol === 'https:') {
            return url.href;
        }
    } catch {
        // fall through to the warning
    }
    console.warn(`brand url: VIEWER_BRAND_URL must be an absolute https URL (${raw}) - ignoring it`);
    return null;
};

export const loadBrand = async (): Promise<EnvBrand | null> => {
    const name = env('VIEWER_BRAND_NAME');
    const iconUrl = env('VIEWER_BRAND_ICON_URL');
    const logoUrl = env('VIEWER_BRAND_LOGO_URL');

    // VIEWER_BRAND_URL alone brands nothing: it only targets links.
    if (!name && !iconUrl && !logoUrl) {
        return null;                    // not configured: the default, silent
    }

    const icon = iconUrl ? await loadImage(iconUrl, 'VIEWER_BRAND_ICON_URL', 'brand icon', 'brand-icon') : null;
    const logo = logoUrl ? await loadImage(logoUrl, 'VIEWER_BRAND_LOGO_URL', 'brand logo', 'brand-logo') : null;

    // Everything configured failed to load: report nothing rather than a brand
    // that would change no surface.
    if (!name && !icon && !logo) {
        return null;
    }
    return { name: name || null, icon, logo, url: parseBrandUrl(env('VIEWER_BRAND_URL')) };
};
