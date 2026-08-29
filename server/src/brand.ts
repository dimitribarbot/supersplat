// Optional brand override for ZIP viewer exports. See
// docs/superpowers/specs/2026-08-29-viewer-brand-override-design.md.
//
// The brand belongs to the deployment, not to a capture or an editing session,
// so it is configured once here rather than chosen per export in the editor:
// nothing about it crosses the client -> server boundary, so it cannot be set
// or spoofed per request. This mirrors VIEWER_FAVICON_URL exactly, and like the
// favicon it applies to ZIP exports only (plain and streaming, including the S3
// publish that reuses them) — never to a single-file HTML export.
//
//   VIEWER_BRAND_NAME       replaces the SuperSplat name in the document title,
//                           the overlay badge and the info panel header
//   VIEWER_BRAND_ICON_URL   replaces both SuperSplat logos
//   VIEWER_BRAND_FONT_NAME  the family the two brand labels are set in
//   VIEWER_BRAND_FONT_URL   the file that family is loaded from
//
// The three overrides are independent: a fetch failure costs you that one
// piece, not the export and not the other two. Nothing here throws.

import { fetchAsset } from './fetch-asset.js';

export type BrandAsset = { filename: string; mime: string; data: Uint8Array };

export type Brand = {
    name: string | null;
    icon: BrandAsset | null;
    font: { family: string; format: string; asset: BrandAsset } | null;
};

const ICON_MAX_BYTES = 1024 * 1024;
// Roomier than the icon's cap: a woff2 is usually well under 100 KB, but a
// font with full CJK or a large glyph set legitimately runs to a few MB.
const FONT_MAX_BYTES = 4 * 1024 * 1024;

// The only logo types ever emitted, and the file extension each one gets.
const ICON_MIME_EXT: Record<string, string> = {
    'image/png': 'png',
    'image/svg+xml': 'svg',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif'
};

const ICON_EXT_MIME: Record<string, string> = {
    png: 'image/png',
    svg: 'image/svg+xml',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif'
};

const FONT_MIME_EXT: Record<string, string> = {
    'font/woff2': 'woff2',
    'font/woff': 'woff',
    'font/ttf': 'ttf',
    'font/otf': 'otf',
    // Legacy types still served by some CDNs for the same four files.
    'application/font-woff': 'woff',
    'application/x-font-ttf': 'ttf',
    'application/x-font-otf': 'otf'
};

const FONT_EXT_MIME: Record<string, string> = {
    woff2: 'font/woff2',
    woff: 'font/woff',
    ttf: 'font/ttf',
    otf: 'font/otf'
};

// The `format()` keyword each extension takes inside an @font-face src. Note
// these are NOT the extensions: ttf is "truetype" and otf is "opentype".
const FONT_FORMAT: Record<string, string> = {
    woff2: 'woff2',
    woff: 'woff',
    ttf: 'truetype',
    otf: 'opentype'
};

const env = (name: string): string => (process.env[name] ?? '').trim();

export const loadBrand = async (): Promise<Brand | null> => {
    const name = env('VIEWER_BRAND_NAME');
    const iconUrl = env('VIEWER_BRAND_ICON_URL');
    const fontFamily = env('VIEWER_BRAND_FONT_NAME');
    const fontUrl = env('VIEWER_BRAND_FONT_URL');

    if (!name && !iconUrl && !fontFamily && !fontUrl) {
        return null;                    // not configured: the default, silent
    }

    let icon: BrandAsset | null = null;
    if (iconUrl) {
        const fetched = await fetchAsset(iconUrl, {
            envVar: 'VIEWER_BRAND_ICON_URL',
            label: 'brand icon',
            consequence: 'keeping the stock logo',
            mimeExt: ICON_MIME_EXT,
            extMime: ICON_EXT_MIME,
            maxBytes: ICON_MAX_BYTES
        });
        if (fetched) {
            icon = { filename: `brand-icon.${fetched.ext}`, mime: fetched.mime, data: fetched.data };
        }
    }

    // A face rule needs both halves. Half a configuration would either name a
    // family nothing loads or load a file nothing references, and in both cases
    // the viewer would silently fall back to the stock font — so say so instead.
    let font: Brand['font'] = null;
    if (fontFamily && !fontUrl) {
        console.warn('brand font: VIEWER_BRAND_FONT_NAME is set but VIEWER_BRAND_FONT_URL is not - keeping the stock font');
    } else if (fontUrl && !fontFamily) {
        console.warn('brand font: VIEWER_BRAND_FONT_URL is set but VIEWER_BRAND_FONT_NAME is not - keeping the stock font');
    } else if (fontFamily && fontUrl) {
        const fetched = await fetchAsset(fontUrl, {
            envVar: 'VIEWER_BRAND_FONT_URL',
            label: 'brand font',
            consequence: 'keeping the stock font',
            mimeExt: FONT_MIME_EXT,
            extMime: FONT_EXT_MIME,
            maxBytes: FONT_MAX_BYTES
        });
        if (fetched) {
            font = {
                family: fontFamily,
                format: FONT_FORMAT[fetched.ext],
                asset: { filename: `brand-font.${fetched.ext}`, mime: fetched.mime, data: fetched.data }
            };
        }
    }

    // Everything configured failed to load: report nothing rather than a brand
    // that would change none of the three surfaces.
    if (!name && !icon && !font) {
        return null;
    }
    return { name: name || null, icon, font };
};
