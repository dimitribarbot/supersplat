// Packs the operator brand (brand.ts, from env) and an optional per-publish
// client brand (S3 publish dialog) for the shared export core. It applies no
// brand rules: the exported page does, on every load
// (src/viewer-companion/brand-rules.ts), from client metas the operator's
// other application may rewrite later. So every configured operator asset is
// embedded, client mode included, for a published scene to be able to switch
// back to operator mode. Pure: no env, no network. See
// docs/superpowers/specs/2026-10-09-runtime-brand-switch-design.md.
//
// Client URLs are hotlinked, never fetched here or anywhere on the server.

import type { BrandAsset, EnvBrand } from './brand.js';

export type BrandOverride = { name?: string; iconUrl?: string; logoUrl?: string };

// Mirrors the `brand` option of writeViewerCore (src/splat-export-core.ts). The
// server reaches that function through an untyped dynamic import of
// dist-shared, so nothing type-checks this boundary: keep the two in step.
export type ResolvedBrand = {
    files: { filename: string; data: Uint8Array }[];
    operator: { name?: string; iconHref?: string; iconMime?: string; logoHref?: string; url?: string };
    client: BrandOverride;
};

const embed = (asset: BrandAsset, files: ResolvedBrand['files']): string => {
    files.push({ filename: asset.filename, data: asset.data });
    return `./${asset.filename}`;
};

// null when neither brand has a name, icon or logo: the export then keeps the
// stock viewer (VIEWER_BRAND_URL alone brands nothing).
export const resolveBrand = (env: EnvBrand | null, override?: BrandOverride): ResolvedBrand | null => {
    const e: EnvBrand = env ?? { name: null, icon: null, logo: null, url: null };
    const client: BrandOverride = { ...(override ?? {}) };
    const files: ResolvedBrand['files'] = [];
    const operator: ResolvedBrand['operator'] = {};
    if (e.name) {
        operator.name = e.name;
    }
    if (e.icon) {
        operator.iconHref = embed(e.icon, files);
        operator.iconMime = e.icon.mime;
    }
    if (e.logo) {
        operator.logoHref = embed(e.logo, files);
    }
    if (e.url) {
        operator.url = e.url;
    }

    if (!operator.name && !operator.iconHref && !operator.logoHref && !client.name && !client.iconUrl && !client.logoUrl) {
        return null;
    }
    return { files, operator, client };
};

const NAME_MAX = 100;
const URL_MAX = 2048;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

type Validation = { ok: true; value: BrandOverride | undefined } | { ok: false; error: string };

// The server has no auth, so the publish request's brand is untrusted input.
// Empty strings mean "not provided"; anything malformed is a 400, never a
// silent drop, so the publisher learns why their brand did not apply.
export const validateBrandOverride = (raw: unknown): Validation => {
    if (raw === undefined || raw === null) {
        return { ok: true, value: undefined };
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, error: 'brandOverride must be an object' };
    }
    const input = raw as Record<string, unknown>;
    const value: BrandOverride = {};

    const text = (key: string): { ok: true; text: string } | { ok: false; error: string } => {
        const v = input[key];
        if (v === undefined || v === null) {
            return { ok: true, text: '' };
        }
        if (typeof v !== 'string') {
            return { ok: false, error: `brandOverride.${key} must be a string` };
        }
        return { ok: true, text: v.trim() };
    };

    const name = text('name');
    if (!name.ok) {
        return name;
    }
    if (name.text) {
        if (name.text.length > NAME_MAX || CONTROL_CHARS.test(name.text)) {
            return { ok: false, error: `brandOverride.name must be at most ${NAME_MAX} characters, with no control characters` };
        }
        value.name = name.text;
    }

    for (const key of ['iconUrl', 'logoUrl'] as const) {
        const url = text(key);
        if (!url.ok) {
            return url;
        }
        if (!url.text) {
            continue;
        }
        let parsed: URL | null = null;
        try {
            parsed = new URL(url.text);
        } catch {
            parsed = null;
        }
        if (url.text.length > URL_MAX || !parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password) {
            return { ok: false, error: `brandOverride.${key} must be an absolute https URL without credentials, of at most ${URL_MAX} characters` };
        }
        value[key] = parsed.href;
    }

    return { ok: true, value: Object.keys(value).length ? value : undefined };
};
