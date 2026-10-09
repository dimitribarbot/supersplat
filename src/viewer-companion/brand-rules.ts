// Brand rules for exported viewers, evaluated in two places: by the export
// core (the static <title> and favicon written at export time) and by the
// brand runtime script in the exported page's <head> (brand.ts), which
// resolves again on every load from the page's client metas. That second
// evaluation is what lets the operator's other application switch a published
// scene between operator and client mode by rewriting index.html alone. See
// docs/superpowers/specs/2026-10-09-runtime-brand-switch-design.md.
//
// Rules:
//   - Name and icon form a pair: the client pair is used only when the client
//     supplied both; otherwise the operator pair is used everywhere.
//   - Panel header: client logo, else the client pair, else operator logo,
//     else the operator pair.
//   - Client mode = a client value is actually used (a client logo or a
//     complete client pair): no links on the badge or the panel header, plus
//     "Powered by <operator>".
//
// BUILD TRAP: both functions are injected into the page via
// Function.toString(), so each must stay self-contained (no imports, no
// module-level references, helpers declared inside) and use no backslash
// escapes and no backticks.
/* eslint-disable prefer-template -- backticks are banned in the injected bodies, so string concatenation is required */

// Baked by the export server from its VIEWER_BRAND_* env. Trusted.
export type BrandOperator = {
    name?: string;
    iconHref?: string;                  // ./brand-icon.<ext>
    iconMime?: string;
    logoHref?: string;                  // ./brand-logo.<ext>
    url?: string;
};

// From the page's client metas, rewritten by the other application without
// any server validation: untrusted.
export type BrandClient = {
    name?: string;
    iconUrl?: string;
    logoUrl?: string;
};

// '' means absent.
export type BrandView = {
    name: string;
    iconHref: string;
    iconMime: string;
    logoHref: string;
    panelHref: string;
    badgeLink: boolean;
    poweredBy: { name: string; href: string } | null;
};

// Markup for each uiHtml surface brand.ts splices. An absent optional key keeps
// the stock markup; a present one, even '', replaces it.
export type BrandFragments = {
    badgeOpen: string;
    badgeIcon?: string;
    badgeClose: string;
    panelOpen: string;
    panelLogo?: string;
    panelLabel?: string;
    panelClose: string;
    attribution: string;
};

// null when nothing resolves: the page then keeps the stock viewer.
export const resolveBrandView = (operator: BrandOperator, client: BrandClient): BrandView | null => {
    const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
    const httpsUrl = (value: unknown, what: string): string => {
        const raw = text(value);
        if (!raw) {
            return '';
        }
        try {
            const url = new URL(raw);
            if (url.protocol === 'https:' && !url.username && !url.password) {
                return url.href;
            }
        } catch {
            // not a URL at all
        }
        console.warn('brand: ignoring the client ' + what + ' URL (absolute https only): ' + raw);
        return '';
    };

    const op = operator || {};
    const cl = client || {};
    const clientName = text(cl.name);
    const clientIcon = httpsUrl(cl.iconUrl, 'icon');
    const clientLogo = httpsUrl(cl.logoUrl, 'logo');
    const pair = !!(clientName && clientIcon);
    const clientMode = pair || !!clientLogo;
    const operatorName = text(op.name);
    const operatorUrl = text(op.url);

    const name = pair ? clientName : operatorName;
    const iconHref = pair ? clientIcon : text(op.iconHref);
    const logoHref = clientLogo || (pair ? '' : text(op.logoHref));
    if (!name && !iconHref && !logoHref) {
        return null;
    }
    return {
        name,
        iconHref,
        iconMime: pair || !iconHref ? '' : text(op.iconMime),
        logoHref,
        panelHref: clientMode ? '' : operatorUrl,
        badgeLink: !clientMode,
        poweredBy: clientMode && operatorName ? { name: operatorName, href: operatorUrl } : null
    };
};

export const brandFragments = (view: BrandView): BrandFragments => {
    const esc = (value: string): string => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
    const external = ' target="_blank" rel="noopener noreferrer"';
    const tooltip = view.name ? ' title="' + esc(view.name) + '"' : '';

    let powered = '';
    if (view.poweredBy) {
        const label = esc(view.poweredBy.name);
        powered = '<br />Powered by ' + (view.poweredBy.href ? '<a href="' + esc(view.poweredBy.href) + '"' + external + '>' + label + '</a>' : label);
    }

    const fragments: BrandFragments = {
        // Overlay badge: icon only, the name as its tooltip, a link only
        // outside client mode (the viewer sets its href at runtime).
        badgeOpen: view.badgeLink ?
            '<a class="sse-viewerBranding sse-hidden"' + tooltip + external + '>' :
            '<div class="sse-viewerBranding sse-hidden"' + tooltip + '>',
        badgeClose: view.badgeLink ? '</a>' : '</div>',
        // Info panel header: the operator URL or no link at all, never
        // upstream's repository.
        panelOpen: view.panelHref ?
            '<a class="sse-viewerTitle" href="' + esc(view.panelHref) + '"' + external + '>' :
            '<div class="sse-viewerTitle">',
        panelClose: view.panelHref ? '</a>' : '</div>',
        attribution: '<div id="brandAttribution">Based on <a href="https://superspl.at/"' + external + '>PlayCanvas SuperSplat Viewer</a>' + powered + '</div>'
    };
    if (view.iconHref) {
        fragments.badgeIcon = '<img id="brandBadgeIcon" src="' + esc(view.iconHref) + '" alt="" />';
    }
    // The logo alone, or the icon and the name.
    if (view.logoHref) {
        fragments.panelLogo = '<img id="brandTitleLogo" src="' + esc(view.logoHref) + '" alt="' + esc(view.name) + '" />';
        fragments.panelLabel = '';
    } else {
        if (view.iconHref) {
            fragments.panelLogo = '<img id="brandTitleIcon" src="' + esc(view.iconHref) + '" alt="" />';
        }
        if (view.name) {
            fragments.panelLabel = '<span class="sse-title-name">' + esc(view.name) + '</span>';
        }
    }
    return fragments;
};
