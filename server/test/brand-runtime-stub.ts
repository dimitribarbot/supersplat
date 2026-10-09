// Copy of test/brand-runtime-stub.ts (the server suite does not import root tests).
// Runs the brand runtime script injected into an exported page's <head>
// (src/viewer-companion/brand.ts) against a minimal stand-in document built
// from that page's own head, the way the browser runs it during head parsing.
// Returns what the script leaves behind: the title, the favicon link's
// attributes (null when there is none) and window.__brandUi.

const unescapeHtml = (text: string): string => text
.replace(/&quot;/g, '"')
.replace(/&#39;/g, '\'')
.replace(/&lt;/g, '<')
.replace(/&gt;/g, '>')
.replace(/&amp;/g, '&');

const escapeAttr = (text: string): string => text
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;');

export type BrandRuntimeResult = {
    title: string;
    favicon: Record<string, string> | null;
    ui: Record<string, string> | null;
    warnings: unknown[][];
};

export const extractBrandScript = (html: string): string => {
    const open = '<script id="brandRuntime">';
    const at = html.indexOf(open);
    if (at < 0) {
        throw new Error('no brand runtime script in the page');
    }
    return html.slice(at + open.length, html.indexOf('</script>', at));
};

// What the other application does: rewrite one client meta's content.
export const rewriteClientMeta = (html: string, name: string, value: string): string => {
    const open = `<meta name="${name}" content="`;
    const at = html.indexOf(open);
    if (at < 0) {
        throw new Error(`no ${name} meta in the page`);
    }
    const end = html.indexOf('">', at + open.length);
    return html.slice(0, at + open.length) + escapeAttr(value) + html.slice(end);
};

export const runBrandRuntime = (html: string, opts: { breakDocument?: boolean } = {}): BrandRuntimeResult => {
    const head = html.slice(0, html.indexOf('</head>'));

    const metas = new Map<string, string>();
    for (const m of head.matchAll(/<meta name="([^"]+)" content="([^"]*)">/g)) {
        metas.set(m[1], unescapeHtml(m[2]));
    }

    let favicon: Record<string, string> | null = null;
    const iconTag = /<link rel="icon"([^>]*)>/.exec(head);
    if (iconTag) {
        favicon = { rel: 'icon' };
        for (const a of iconTag[1].matchAll(/([a-z]+)="([^"]*)"/g)) {
            favicon[a[1]] = unescapeHtml(a[2]);
        }
    }

    const linkElement = (attrs: Record<string, string>) => ({
        attrs,
        setAttribute: (name: string, value: string) => {
            attrs[name] = value;
        },
        removeAttribute: (name: string) => {
            delete attrs[name];
        },
        parentNode: {
            removeChild: () => {
                favicon = null;
            }
        }
    });

    const titleMatch = /<title>([^<]*)<\/title>/.exec(head);
    const document = {
        title: titleMatch ? unescapeHtml(titleMatch[1]) : '',
        head: {
            appendChild: (el: { attrs: Record<string, string> }) => {
                favicon = el.attrs;
            }
        },
        createElement: () => linkElement({}),
        querySelector: (selector: string) => {
            if (opts.breakDocument) {
                throw new Error('broken document');
            }
            const meta = /^meta\[name="([^"]+)"\]$/.exec(selector);
            if (meta) {
                const content = metas.get(meta[1]);
                return content === undefined ? null : { getAttribute: (n: string) => (n === 'content' ? content : null) };
            }
            if (selector === 'link[rel="icon"]') {
                return favicon ? linkElement(favicon) : null;
            }
            throw new Error(`unexpected selector: ${selector}`);
        }
    };

    const window: Record<string, unknown> = {};
    const warnings: unknown[][] = [];
    const console = { warn: (...args: unknown[]) => warnings.push(args) };
    new Function('document', 'window', 'console', extractBrandScript(html))(document, window, console);

    return { title: document.title, favicon, ui: (window.__brandUi as Record<string, string>) ?? null, warnings };
};
