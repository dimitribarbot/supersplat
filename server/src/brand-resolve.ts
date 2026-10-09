// Merges the operator brand (brand.ts, from env) with an optional per-publish
// client brand (S3 publish dialog) into what the shared export core injects.
// Pure: no env, no network. See
// docs/superpowers/specs/2026-10-09-publish-brand-override-design.md.
//
// Rules:
//   - Name and icon form a pair: the client pair is used only when the client
//     supplied both; otherwise the env pair is used everywhere.
//   - Panel header: client logo, else the client pair, else env logo, else
//     the env pair (the injector shows the logo alone whenever logoHref is set).
//   - Client mode = a client value is actually used (a client logo or a
//     complete client pair): no links on the badge or the panel header, plus
//     "Powered by <operator>".
//
// Client URLs are hotlinked, never fetched here or anywhere on the server.

import type { BrandAsset, EnvBrand } from './brand.js';

export type BrandOverride = { name?: string; iconUrl?: string; logoUrl?: string };

// Mirrors the `brand` option of writeViewerCore (src/splat-export-core.ts). The
// server reaches that function through an untyped dynamic import of
// dist-shared, so nothing type-checks this boundary: keep the two in step.
export type ResolvedBrand = {
    files: { filename: string; data: Uint8Array }[];
    injection: {
        name?: string;
        iconHref?: string;
        iconMime?: string;
        logoHref?: string;
        panelHref?: string;
        badgeLink: boolean;
        poweredBy?: { name: string; href?: string };
    };
};

const embed = (asset: BrandAsset, files: ResolvedBrand['files']): string => {
    files.push({ filename: asset.filename, data: asset.data });
    return `./${asset.filename}`;
};

export const resolveBrand = (env: EnvBrand | null, override?: BrandOverride): ResolvedBrand | null => {
    const e: EnvBrand = env ?? { name: null, icon: null, logo: null, url: null };
    const o = override ?? {};
    const clientPair = !!(o.name && o.iconUrl);
    const clientMode = clientPair || !!o.logoUrl;
    const files: ResolvedBrand['files'] = [];

    const name = clientPair ? o.name : (e.name ?? undefined);

    let iconHref: string | undefined;
    let iconMime: string | undefined;
    if (clientPair) {
        iconHref = o.iconUrl;
    } else if (e.icon) {
        iconHref = embed(e.icon, files);
        iconMime = e.icon.mime;
    }

    let logoHref: string | undefined;
    if (o.logoUrl) {
        logoHref = o.logoUrl;
    } else if (!clientPair && e.logo) {
        logoHref = embed(e.logo, files);
    }

    if (!name && !iconHref && !logoHref) {
        return null;
    }

    return {
        files,
        injection: {
            name,
            iconHref,
            iconMime,
            logoHref,
            panelHref: clientMode ? undefined : (e.url ?? undefined),
            badgeLink: !clientMode,
            poweredBy: clientMode && e.name ? { name: e.name, href: e.url ?? undefined } : undefined
        }
    };
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
