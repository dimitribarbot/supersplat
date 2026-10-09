# Per-publish Brand Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an S3 publish carry a per-publish client brand (name, icon URL, logo URL, hotlinked) on top of a reworked operator env brand (name, icon = favicon, logo, url), with the brand name written once in `<title data-brand-name>` so published scenes can be renamed in place.

**Architecture:** The server loads the operator brand from env (`loadBrand`, fetch-and-embed as today), merges it with the validated client override (`resolveBrand`, pure) into one `ResolvedBrand` = files to embed + a `BrandInjection`, and hands it to the shared export core. The shared injectors (`src/viewer-companion/brand.ts`) patch `index.html` (title, style, favicon) and `index.js`'s `uiHtml` literal (badge, panel header, attribution), splicing a runtime read of `document.title` wherever the name is shown.

**Tech Stack:** TypeScript, Vitest, Fastify (server), PCUI (dialog), i18next locales.

**Spec:** `docs/superpowers/specs/2026-10-09-publish-brand-override-design.md`

## Global Constraints

- Never write the operator's real company name anywhere committed (code, tests, comments, docs, commit messages). Examples: operator brand **"Acme"** (`VIEWER_BRAND_NAME`), client brand **"Client Co"**, operator site `https://acme.example/`, client images under `https://cdn.example/client/`.
- Client override: `iconUrl` / `logoUrl` must parse with `new URL()`, protocol `https:`, at most 2048 characters; `name` trimmed, at most 100 characters, no control characters; empty strings mean absent; any violation → HTTP 400.
- Client URLs are hotlinked: the server never fetches them.
- `VIEWER_BRAND_URL` must be an absolute `https:` URL, otherwise ignored with a warning.
- Removed env vars: `VIEWER_FAVICON_URL`, `VIEWER_BRAND_FONT_NAME`, `VIEWER_BRAND_FONT_URL`.
- Run node/npm/npx through the **PowerShell** tool (npm via Git Bash hangs here); git/grep/sed stay on Bash. Run Vitest in the foreground with output redirected to a file in the scratchpad, then read the file. Never pipe Vitest into grep.
- Server tests import the shared core from `dist-shared/`. `npm --prefix server test` rebuilds it (`pretest`); a bare `npx vitest --root server` does not.
- Rollup reports TypeScript errors as warnings: after `npm run build`, gate on the output containing **zero** `plugin typescript` lines, never on the exit code.
- Do not reorder imports (ESLint's `import/order` autofix is known to crash here); add new imports where they fit alphabetically by hand.
- `server/.env.local` and `server/.env.local.example` cannot be edited by tooling; Task 7 hands the lines to the user.
- Edit locale JSON files with the Edit tool (scripted edits have injected bare LF before).
- Commit after each task. The branch is squashed into one commit when finished.

## Review Focus

1. **A published scene renamed by rewriting its `<title data-brand-name>`** — the badge tooltip and the panel label must show the new name with no other file touched. Pinned in Task 1 ("reads the name from document.title at runtime") and the manual E2E in Task 7.
2. **Client fields that are blank or whitespace-only** — must behave exactly like an env-only publish (no 400, no client mode). Pinned in Task 4 (`validateBrandOverride` blank cases) and Task 6 (dialog only sends non-empty values).
3. **A client URL with a query string, `&` or quotes** — must stay a valid HTML attribute and a valid JS string literal inside `uiHtml`. Pinned in Task 1 (URL escaping test) and Task 2 (favicon href escaping).
4. **A client brand with a name but no icon (or the reverse)** — falls back entirely to the env brand, is not client mode, and adds no "Powered by". Pinned in Task 4 (`resolveBrand` incomplete-pair tests).
5. **A caller sending `brandOverride` to `/api/export`** — must be ignored (ZIP downloads never carry a client brand). Pinned in Task 5 (route test).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/viewer-companion/brand.ts` (rewrite) | Shared injectors: page half (`injectBrand`) and `uiHtml` half (`injectBrandJs`); exported anchors |
| `src/viewer-companion/favicon.ts` (modify) | `<link rel="icon">` injector; `mime` optional, href escaped |
| `src/splat-export-core.ts` (modify) | `Brand` option = files + injection; `applyBrand` emits files, runs both injectors and the favicon; `favicon` option removed |
| `src/splat-serialize.ts` (comment only) | Local export passes no brand |
| `server/src/brand.ts` (rewrite) | `loadBrand()` env loader (name, icon, logo, url); `warnRemovedBrandEnv()` |
| `server/src/brand-resolve.ts` (create) | Pure `resolveBrand(env, override)` and `validateBrandOverride(raw)` |
| `server/src/favicon.ts` (delete) | Superseded by the brand icon |
| `server/src/run-export.ts` (modify) | `ExportOptions.brandOverride`; resolve and pass `brand` |
| `server/src/index.ts` (modify) | Validate on `/api/publish`, strip on `/api/export`, warn at start |
| `server/src/fetch-asset.ts`, `server/src/s3.ts` (comments) | Stale favicon/font references |
| `src/ui/s3-publish-dialog.ts`, `src/s3-publish.ts`, `src/export-server-client.ts` (modify) | Three fields, `brandOverride` forwarded, server error message surfaced |
| `static/locales/*.json` (9 files) | Three labels |
| `test/ui-html.ts`, `server/test/ui-html.ts` (create) | Test helper: render `uiHtml` with a given document title, without executing bundle code |
| `test/brand-injection.test.ts` (rewrite), `test/favicon-injection.test.ts`, `test/viewer-html-anchors.test.ts` | Shared injector tests and real-bundle drift guard |
| `server/test/brand.test.ts` (rewrite), `server/test/brand-icon.test.ts` (renamed from `favicon.test.ts`), `server/test/brand-resolve.test.ts` (create), `server/test/publish-routes.test.ts`, `server/test/brand-zip.gpu.test.ts` (rewrite), `server/test/favicon-zip.gpu.test.ts` (delete) | Server tests |
| `server/README.md` | Env documentation |

---

### Task 1: Rewrite the shared brand injectors

**Files:**
- Rewrite: `src/viewer-companion/brand.ts`
- Create: `test/ui-html.ts`
- Rewrite: `test/brand-injection.test.ts`
- Modify: `test/viewer-html-anchors.test.ts`

**Interfaces:**
- Produces (used by Task 2 and, structurally, Task 4):

```ts
export type BrandInjection = {
    name?: string;
    iconHref?: string;
    iconMime?: string;
    logoHref?: string;
    panelHref?: string;
    badgeLink?: boolean;          // undefined → true
    poweredBy?: { name: string; href?: string };
};
export const injectBrand: (html: string, brand: BrandInjection) => string;
export const injectBrandJs: (js: string, brand: BrandInjection) => string;
export const BRAND_HTML_ANCHORS: string[];
export const BRAND_JS_ANCHORS: string[];
```

- Produces (test helper, used by Task 1 and copied in Task 5): `renderUiHtml(js: string, title?: string): string` in `test/ui-html.ts`.

- [ ] **Step 1: Create the test helper `test/ui-html.ts`**

```ts
// Renders index.js's `var uiHtml = …;` the way the browser would, for a given
// document title. The brand override turns that initializer into string
// literals joined by `+` around the __brandNameHtml variable (see
// src/viewer-companion/brand.ts); this walks those tokens and decodes each
// literal with JSON.parse, so nothing from the bundle is ever executed.

const BACKSLASH = String.fromCharCode(92);
const DECL = 'var uiHtml = ';
const NAME_VAR = '__brandNameHtml';

const escapeName = (title: string): string => title
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;');

export const renderUiHtml = (js: string, title = 'SuperSplat Viewer'): string => {
    const start = js.indexOf(DECL);
    if (start < 0) {
        throw new Error('no `var uiHtml = ` in index.js');
    }
    let i = start + DECL.length;
    let out = '';
    for (;;) {
        while (js[i] === ' ' || js[i] === '+') {
            i++;
        }
        if (js[i] === '"') {
            let j = i + 1;
            while (js[j] !== '"') {
                j += js[j] === BACKSLASH ? 2 : 1;
            }
            out += JSON.parse(js.slice(i, j + 1)) as string;
            i = j + 1;
        } else if (js.startsWith(NAME_VAR, i)) {
            out += escapeName(title);
            i += NAME_VAR.length;
        } else if (js[i] === ';') {
            return out;
        } else {
            throw new Error(`unexpected token in uiHtml at ${i}: ${js.slice(i, i + 20)}`);
        }
    }
};
```

- [ ] **Step 2: Write the failing tests — replace `test/brand-injection.test.ts` entirely**

```ts
import { describe, it, expect, vi } from 'vitest';

import { injectBrand, injectBrandJs } from '../src/viewer-companion/brand';
import { renderUiHtml } from './ui-html';

// Stand-in for the exported viewer's page (1.35 shape: the badge/title/panel
// markup lives in index.js's uiHtml, not in the page itself).
const HTML = `<!doctype html>
<html lang="en">
    <head>
        <title>SuperSplat Viewer</title>
        <link rel="stylesheet" href="./index.css" />
    </head>
    <body>
        <script type="module">createViewer({ container: document.body });</script>
    </body>
</html>
`;

// Stand-in for index.js's uiHtml, carrying every anchor the override reaches
// for with the exact whitespace supersplat-viewer ships (pinned against the
// real bundle by test/viewer-html-anchors.test.ts).
const UI = '\n<div class="sse-ui">\n' +
    '    <a class="sse-viewerBranding sse-hidden" target="_blank" rel="noopener noreferrer">\n' +
    '        <svg xmlns="http://www.w3.org/2000/svg" viewBox="64 64 384 384" role="img" aria-label="SuperSplat">\n' +
    '            <path fill="#F26722" d="M1,2Z"/>\n' +
    '        </svg>\n' +
    '        <span>SuperSplat</span>\n' +
    '    </a>\n' +
    '            <a\n' +
    '                class="sse-viewerTitle"\n' +
    '                href="https://github.com/playcanvas/supersplat-viewer"\n' +
    '                target="_blank"\n' +
    '                rel="noopener noreferrer"\n' +
    '            >\n' +
    '                <svg class="sse-viewerLogo" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">\n' +
    '                    <use href="#supersplatIcon" />\n' +
    '                </svg>\n' +
    '                <span class="sse-title-name">SuperSplat Viewer</span>\n' +
    '                <span class="sse-title-version">v<span class="sse-appVersionLabel"></span></span>\n' +
    '            </a>\n' +
    '            <div class="sse-infoGpu">\n' +
    '</div>\n';
// index.js carries it as `var uiHtml = "<escaped>";`
const JS = `const a = 1;\nvar uiHtml = ${JSON.stringify(UI)};\nconst b = 2;\n`;

const VERSION = '<span class="sse-title-version">v<span class="sse-appVersionLabel"></span></span>';
const BASED_ON = 'Based on <a href="https://superspl.at/" target="_blank" rel="noopener noreferrer">PlayCanvas SuperSplat Viewer</a>';

const ENV = { name: 'Acme', iconHref: './brand-icon.png', iconMime: 'image/png', panelHref: 'https://acme.example/', badgeLink: true };
const CLIENT = {
    name: 'Client Co',
    iconHref: 'https://cdn.example/client/icon.png',
    badgeLink: false,
    poweredBy: { name: 'Acme', href: 'https://acme.example/' }
};

describe('injectBrand (page half)', () => {
    it('returns the document unchanged when there is nothing to brand', () => {
        expect(injectBrand(HTML, {})).toBe(HTML);
        expect(injectBrand(HTML, { panelHref: 'https://acme.example/', badgeLink: false })).toBe(HTML);
    });

    it('writes the name once, into a marked <title>', () => {
        expect(injectBrand(HTML, { name: 'Acme' })).toContain('<title data-brand-name>Acme</title>');
    });

    it('escapes HTML metacharacters in the name', () => {
        const out = injectBrand(HTML, { name: 'A&B <"Labs">' });
        expect(out).toContain('<title data-brand-name>A&amp;B &lt;&quot;Labs&quot;&gt;</title>');
    });

    it('keeps a $ in the name literal (never a replacement pattern)', () => {
        expect(injectBrand(HTML, { name: '$& Co' })).toContain('<title data-brand-name>$&amp; Co</title>');
    });

    it('leaves the stock title when only images are configured', () => {
        const out = injectBrand(HTML, { iconHref: './brand-icon.png' });
        expect(out).toContain('<title>SuperSplat Viewer</title>');
        expect(out).toContain('<style id="brandStyle">');
    });

    it('styles the replacement images and the non-link variants', () => {
        const out = injectBrand(HTML, { logoHref: './brand-logo.png' });
        expect(out).toContain('.sse-viewer .sse-viewerBranding > img {\n    height: 16px;');
        expect(out).toContain('.sse-viewer div.sse-viewerBranding {\n    cursor: default;\n}');
        expect(out).toContain('    max-width: 100%;\n    object-fit: contain;');
        expect(out).toContain('div.sse-viewerTitle:hover {\n    opacity: 1;\n}');
        expect(out).toContain('#brandAttribution {');
    });

    it('lands the style block after the stylesheet link, before </head>', () => {
        const out = injectBrand(HTML, ENV);
        const style = out.indexOf('<style id="brandStyle">');
        expect(style).toBeGreaterThan(out.indexOf('./index.css'));
        expect(style).toBeLessThan(out.indexOf('</head>'));
    });

    it('is idempotent', () => {
        const once = injectBrand(HTML, ENV);
        expect(injectBrand(once, ENV)).toBe(once);
    });

    it('is a soft no-op without </head>', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const html = '<html><body>no head</body></html>';
        expect(injectBrand(html, ENV)).toBe(html);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it('warns but still styles when the stock title has moved', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const out = injectBrand(HTML.replace('<title>SuperSplat Viewer</title>', '<title>Other</title>'), ENV);
        expect(out).toContain('<title>Other</title>');
        expect(out).toContain('<style id="brandStyle">');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('document title'));
        warn.mockRestore();
    });
});

describe('injectBrandJs (uiHtml half)', () => {
    it('returns index.js unchanged when there is nothing to brand', () => {
        expect(injectBrandJs(JS, {})).toBe(JS);
        expect(injectBrandJs(JS, { panelHref: 'https://acme.example/' })).toBe(JS);
    });

    describe('env-only brand', () => {
        const ui = renderUiHtml(injectBrandJs(JS, ENV), 'Acme');

        it('keeps the badge a link, icon only, with the name as its tooltip', () => {
            expect(ui).toContain(
                '<a class="sse-viewerBranding sse-hidden" title="Acme" target="_blank" rel="noopener noreferrer">\n' +
                '        <img id="brandBadgeIcon" src="./brand-icon.png" alt="" />\n' +
                '        </a>'
            );
            expect(ui).not.toContain('<span>SuperSplat</span>');
        });

        it('links the panel header to the operator URL, with icon and name', () => {
            expect(ui).toContain(
                '<a class="sse-viewerTitle" href="https://acme.example/" target="_blank" rel="noopener noreferrer">\n' +
                '                <img id="brandTitleIcon" src="./brand-icon.png" alt="" />\n' +
                '                <span class="sse-title-name">Acme</span>\n' +
                `                ${VERSION}\n` +
                '            </a>'
            );
            expect(ui).not.toContain('github.com');
        });

        it('adds the PlayCanvas attribution only, right before the GPU row', () => {
            expect(ui).toContain(`<div id="brandAttribution">${BASED_ON}</div>\n            <div class="sse-infoGpu">`);
            expect(ui).not.toContain('Powered by');
        });

        it('drops the panel link when no operator URL is configured', () => {
            const plain = renderUiHtml(injectBrandJs(JS, { ...ENV, panelHref: undefined }), 'Acme');
            expect(plain).toContain('<div class="sse-viewerTitle">\n');
            expect(plain).toContain(`${VERSION}\n            </div>`);
        });
    });

    describe('client mode', () => {
        const ui = renderUiHtml(injectBrandJs(JS, CLIENT), 'Client Co');

        it('renders the badge as a non-link element', () => {
            expect(ui).toContain(
                '<div class="sse-viewerBranding sse-hidden" title="Client Co">\n' +
                '        <img id="brandBadgeIcon" src="https://cdn.example/client/icon.png" alt="" />\n' +
                '        </div>'
            );
        });

        it('renders the panel header as a non-link element', () => {
            expect(ui).toContain(
                '<div class="sse-viewerTitle">\n' +
                '                <img id="brandTitleIcon" src="https://cdn.example/client/icon.png" alt="" />\n' +
                '                <span class="sse-title-name">Client Co</span>\n' +
                `                ${VERSION}\n` +
                '            </div>'
            );
        });

        it('adds "Powered by" with only the operator name linked', () => {
            expect(ui).toContain(
                `<div id="brandAttribution">${BASED_ON}<br />Powered by <a href="https://acme.example/" target="_blank" rel="noopener noreferrer">Acme</a></div>`
            );
        });

        it('leaves the operator name unlinked when no operator URL is configured', () => {
            const plain = renderUiHtml(injectBrandJs(JS, { ...CLIENT, poweredBy: { name: 'Acme' } }), 'Client Co');
            expect(plain).toContain('<br />Powered by Acme</div>');
        });

        it('shows the client logo alone in the panel when one is given', () => {
            const withLogo = renderUiHtml(injectBrandJs(JS, { ...CLIENT, logoHref: 'https://cdn.example/client/logo.png' }), 'Client Co');
            expect(withLogo).toContain(
                '<div class="sse-viewerTitle">\n' +
                '                <img id="brandTitleLogo" src="https://cdn.example/client/logo.png" alt="" />\n' +
                '                \n' +
                `                ${VERSION}\n`
            );
            expect(withLogo).not.toContain('brandTitleIcon');
            expect(withLogo).not.toContain('sse-title-name');
            // the badge keeps the icon
            expect(withLogo).toContain('<img id="brandBadgeIcon" src="https://cdn.example/client/icon.png" alt="" />');
        });
    });

    describe('the name', () => {
        it('is not baked into index.js: it is read from document.title at runtime', () => {
            const js = injectBrandJs(JS, CLIENT);
            expect(js).not.toContain('Client Co');
            const renamed = renderUiHtml(js, 'Renamed Co');
            expect(renamed).toContain('title="Renamed Co"');
            expect(renamed).toContain('<span class="sse-title-name">Renamed Co</span>');
        });

        it('is HTML-escaped by the injected runtime read', () => {
            const js = injectBrandJs(JS, ENV);
            const at = js.indexOf('var __brandNameHtml = ');
            expect(at).toBeGreaterThan(-1);
            expect(at).toBeLessThan(js.indexOf('var uiHtml = '));
            const decl = js.slice(at, js.indexOf(';\n', at) + 1);
            // our own injected declaration, evaluated against a fake document
            const read = new Function('document', `${decl}\nreturn __brandNameHtml;`) as (doc: { title: string }) => string;
            expect(read({ title: 'A&B <"x">' })).toBe('A&amp;B &lt;&quot;x&quot;&gt;');
        });

        it('is not referenced at all when there is no name', () => {
            const js = injectBrandJs(JS, { iconHref: './brand-icon.png', badgeLink: true });
            expect(js).not.toContain('__brandNameHtml');
            const ui = renderUiHtml(js);
            expect(ui).toContain('<a class="sse-viewerBranding sse-hidden" target="_blank" rel="noopener noreferrer">');
            expect(ui).toContain('<span class="sse-title-name">SuperSplat Viewer</span>');
        });

        it('keeps the stock badge logo when there is a name but no icon', () => {
            const ui = renderUiHtml(injectBrandJs(JS, { name: 'Acme', badgeLink: true }), 'Acme');
            expect(ui).toContain('title="Acme"');
            expect(ui).toContain('aria-label="SuperSplat"');
            expect(ui).not.toContain('<span>SuperSplat</span>');
            expect(ui).toContain('<span class="sse-title-name">Acme</span>');
        });

        it('is skipped, with a warning, when the uiHtml declaration has moved', () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const out = injectBrandJs(JS.replace('var uiHtml = ', 'let uiHtml = '), ENV);
            expect(out).not.toContain('__brandNameHtml');
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('ui template'));
            warn.mockRestore();
        });
    });

    it('escapes URLs for the attribute and the JS string literal', () => {
        const href = 'https://cdn.example/i.png?a=1&b="x"';
        const js = injectBrandJs(JS, { ...CLIENT, iconHref: href });
        const ui = renderUiHtml(js, 'Client Co');
        expect(ui).toContain('src="https://cdn.example/i.png?a=1&amp;b=&quot;x&quot;"');
    });

    it('keeps a $ in the operator name literal', () => {
        const ui = renderUiHtml(injectBrandJs(JS, { ...CLIENT, poweredBy: { name: '$& Co' } }), 'Client Co');
        expect(ui).toContain('Powered by $&amp; Co</div>');
    });

    it('is idempotent', () => {
        const once = injectBrandJs(JS, CLIENT);
        expect(injectBrandJs(once, CLIENT)).toBe(once);
    });

    it('brands what it can when an anchor is missing, with a warning', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const noBadge = JS.replace('sse-viewerBranding sse-hidden', 'sse-somethingElse');
        const ui = renderUiHtml(injectBrandJs(noBadge, ENV), 'Acme');
        expect(ui).toContain('<span class="sse-title-name">Acme</span>');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('overlay badge'));
        warn.mockRestore();
    });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run (PowerShell): `npx vitest run test/brand-injection.test.ts > $env:TEMP\brand-inj.txt 2>&1`, then read the file.
Expected: FAIL — e.g. no `data-brand-name`, no `__brandNameHtml`, old `badgeLink`-less behaviour.

- [ ] **Step 4: Replace `src/viewer-companion/brand.ts` entirely**

```ts
// Optional brand override for the exported viewer.
//
// The stock viewer identifies itself as SuperSplat in three places: the
// document <title>, the overlay badge (`.sse-viewerBranding`, only revealed
// when the viewer is embedded cross-origin) and the info panel's header
// (`.sse-viewerTitle`). The export server resolves the operator brand
// (VIEWER_BRAND_*) and, for an S3 publish, an optional per-publish client
// brand into one BrandInjection (server/src/brand-resolve.ts), and this file
// swaps the surfaces. See
// docs/superpowers/specs/2026-10-09-publish-brand-override-design.md.
//
// supersplat-viewer >= 1.32 builds its badge and info-panel markup from a JS
// string (`var uiHtml = "…"` in index.js) rather than baking it into the page,
// so the override has two halves: injectBrand patches the page (the <title>
// and the injected <style>), injectBrandJs patches index.js's uiHtml literal.
//
// The name is written exactly once, into `<title data-brand-name>`. The badge
// tooltip and the panel label read it back from document.title when uiHtml is
// evaluated (index.js is a deferred module, so the head is parsed by then, and
// the viewer never writes document.title itself), so renaming a published
// scene only means rewriting that one element in its index.html.
//
// Environment-agnostic (compiled for the export server via dist-shared):
// string operations only.

const HEAD_CLOSE = '</head>';

// Injecting twice would double the style block and re-run replacements against
// an already-branded document; the marker makes the injection idempotent
// (mirrors the other companions' soft no-op posture).
const MARKER = '<!-- viewer brand applied -->';

// The <title> is the one brand surface left in the page itself.
const DOC_TITLE = '<title>SuperSplat Viewer</title>';

// uiHtml anchors. Written in HTML form for readability; the JS pass searches
// for their jsString() form, which is how they appear in index.js.
const UI_HTML_DECL = 'var uiHtml = ';
const BADGE_OPEN = '<a class="sse-viewerBranding sse-hidden" target="_blank" rel="noopener noreferrer">';
const BADGE_LOGO_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="64 64 384 384" role="img" aria-label="SuperSplat">';
const BADGE_CLOSE = '<span>SuperSplat</span>\n    </a>';
const PANEL_OPEN = '<a\n                class="sse-viewerTitle"\n                href="https://github.com/playcanvas/supersplat-viewer"\n                target="_blank"\n                rel="noopener noreferrer"\n            >';
const PANEL_LOGO_OPEN = '<svg class="sse-viewerLogo" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">';
const PANEL_LABEL = '<span class="sse-title-name">SuperSplat Viewer</span>';
const PANEL_VERSION = '<span class="sse-title-version">v<span class="sse-appVersionLabel"></span></span>\n            ';
const PANEL_CLOSE = `${PANEL_VERSION}</a>`;
const PANEL_SECTIONS = '<div class="sse-infoGpu">';

const SVG_CLOSE = '</svg>';

// Attribution shown under the rebranded panel header. Placed in the info panel
// because that is where a viewer looks to find out what they are looking at,
// and it stays reachable in a standalone export -- unlike the overlay badge,
// which only ever appears inside a cross-origin iframe.
const ATTRIBUTION_URL = 'https://superspl.at/';

// Runtime read of the brand name, declared right before uiHtml (same module
// scope). HTML-escaped because it is concatenated into markup, including a
// double-quoted attribute.
const NAME_VAR = '__brandNameHtml';
const NAME_DECL = `var ${NAME_VAR} = (typeof document === "undefined" ? "" : document.title).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");\n`;

// Placeholder for the runtime name inside an HTML fragment. NUL cannot occur in
// any input (the server rejects control characters in names, URL parsing
// percent-encodes them, and env values cannot carry NUL), and jsString leaves
// it untouched, so toJs can swap it for the splice after escaping.
const NAME_TOKEN = String.fromCharCode(0);

// Closes the uiHtml string literal, concatenates the name, reopens it.
const NAME_SPLICE = `"+${NAME_VAR}+"`;

export type BrandInjection = {
    // Operator or client brand name. Escaped into the <title>; read back at
    // runtime for the badge tooltip and the panel label.
    name?: string;
    // Export-derived relative filenames (./brand-icon.png) for operator assets,
    // or validated https: URLs for a client's hotlinked images. Escaped at
    // every interpolation site.
    iconHref?: string;
    // The favicon link's type attribute; absent for a hotlinked icon.
    iconMime?: string;
    // When set, the panel header shows this logo alone (no icon, no name).
    logoHref?: string;
    // Panel header link target; absent renders the header as a non-link.
    panelHref?: string;
    // false renders the badge as a non-link element, so the viewer's own
    // runtime `href` assignment has no effect (client mode). Default true.
    badgeLink?: boolean;
    // Client mode only: "Powered by <name>", only the name linked to href.
    poweredBy?: { name: string; href?: string };
};

const escapeHtml = (text: string): string => text
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;')
.replace(/'/g, '&#39;');

// Built by code point so no backslash escape appears in this file's source.
const BACKSLASH = String.fromCharCode(92);

// Escape an HTML fragment for a double-quoted JS string literal, exactly as the
// bundler wrote uiHtml: backslash, double quote, and every character that is a
// JS LineTerminator (LF, CR, U+2028, U+2029) -- any of these, left raw, would
// break the string literal (a pre-ES2019 engine even treats a raw U+2028/2029
// as a syntax error). split/join, not String.replace, so a `$` in brand text
// is never read as a pattern.
const jsString = (html: string): string => html
.split(BACKSLASH).join(BACKSLASH + BACKSLASH)
.split('"').join(`${BACKSLASH}"`)
.split('\n').join(`${BACKSLASH}n`)
.split('\r').join(`${BACKSLASH}r`)
.split(String.fromCharCode(0x2028)).join(`${BACKSLASH}u2028`)
.split(String.fromCharCode(0x2029)).join(`${BACKSLASH}u2029`);

// jsString, then the runtime name wherever the fragment carries NAME_TOKEN.
const toJs = (html: string): string => jsString(html).split(NAME_TOKEN).join(NAME_SPLICE);

const skip = (what: string): void => {
    console.warn(`brand: ${what} not found in the exported viewer; leaving it unbranded`);
};

// Never String.replace: a `$` in the replacement (a brand name is free text)
// would be read as a substitution pattern and corrupt the export.
const replaceOnce = (text: string, needle: string, replacement: string, what: string): string => {
    const at = text.indexOf(needle);
    if (at < 0) {
        skip(what);
        return text;
    }
    return text.slice(0, at) + replacement + text.slice(at + needle.length);
};

// Replaces a whole <svg>...</svg> element, located by its (unique) opening tag.
const replaceSvg = (text: string, openTag: string, replacement: string, what: string): string => {
    const at = text.indexOf(openTag);
    if (at < 0) {
        skip(what);
        return text;
    }
    const close = text.indexOf(SVG_CLOSE, at);
    if (close < 0) {
        skip(what);
        return text;
    }
    return text.slice(0, at) + replacement + text.slice(close + SVG_CLOSE.length);
};

// The stock rules size `.sse-viewerBranding > svg` (16px badge on its dark
// rounded backdrop) and `.sse-viewerLogo` (56px, in the info panel's column
// layout); once those elements are <img>, nothing styles them, so restate the
// same metrics. object-fit keeps a wide logo's aspect once max-width clamps it.
// The div.* rules undo the stock pointer cursor and hover fade on the non-link
// variants. Rules for elements a given export lacks are inert.
const STYLE = [
    '<style id="brandStyle">',
    '.sse-viewer .sse-viewerBranding > img {',
    '    height: 16px;',
    '    width: auto;',
    '    flex-shrink: 0;',
    '    padding: 8px;',
    '    border-radius: 6px;',
    '    background-color: rgba(0, 0, 0, 0.3);',
    '}',
    '.sse-viewer div.sse-viewerBranding {',
    '    cursor: default;',
    '}',
    '.sse-viewer .sse-infoPanel > .sse-infoPanelContent > .sse-viewerTitle > img {',
    '    height: 56px;',
    '    width: auto;',
    '    max-width: 100%;',
    '    object-fit: contain;',
    '    margin-bottom: 6px;',
    '}',
    '.sse-viewer .sse-infoPanel > .sse-infoPanelContent > div.sse-viewerTitle:hover {',
    '    opacity: 1;',
    '}',
    '#brandAttribution {',
    '    padding: 10px 16px 0;',
    '    text-align: center;',
    '    font-size: 11px;',
    '    line-height: 1.4;',
    '    color: #e0dcdd;',
    '    opacity: 0.55;',
    '}',
    '#brandAttribution > a {',
    '    color: inherit;',
    '}',
    '</style>'
].join('\n');

const hasBrand = (brand: BrandInjection): boolean => !!((brand.name ?? '').trim() || (brand.iconHref ?? '').trim() || (brand.logoHref ?? '').trim());

// The page half of the override: the <title> and the injected <style>. The
// badge and info-panel markup live in index.js's uiHtml (see injectBrandJs);
// the favicon link is added by the export core (viewer-companion/favicon.ts).
export const injectBrand = (html: string, brand: BrandInjection): string => {
    if (!hasBrand(brand)) {
        return html;                    // not configured: the default, silent
    }

    const headEnd = html.indexOf(HEAD_CLOSE);
    if (headEnd < 0) {
        console.warn('brand: exported viewer html has no </head>; skipping the brand override');
        return html;
    }
    // Scan only the head, not the whole document: the companions' script blobs
    // already landed in the body by the time this runs, so a whole-document
    // scan could false-positive on one whose text happens to carry the marker.
    if (html.slice(0, headEnd).includes(MARKER)) {
        return html;
    }

    let out = html;
    const name = (brand.name ?? '').trim();
    if (name) {
        out = replaceOnce(out, DOC_TITLE, `<title data-brand-name>${escapeHtml(name)}</title>`, 'the document title');
    }

    // Last, so the block lands after the viewer's own ./index.css link and
    // wins the cascade at equal specificity. Re-read </head>: the replacement
    // above may have moved it.
    const end = out.indexOf(HEAD_CLOSE);
    return `${out.slice(0, end)}        ${MARKER}\n        ${STYLE}\n    ${out.slice(end)}`;
};

// The uiHtml half of the override, applied to index.js. Idempotent by the
// attribution id, which every branded pass inserts.
export const injectBrandJs = (js: string, brand: BrandInjection): string => {
    if (!hasBrand(brand)) {
        return js;
    }
    if (js.includes('brandAttribution')) {
        return js;
    }

    const name = (brand.name ?? '').trim();
    const iconHref = (brand.iconHref ?? '').trim();
    const logoHref = (brand.logoHref ?? '').trim();
    const panelHref = (brand.panelHref ?? '').trim();
    const badgeLink = brand.badgeLink !== false;

    let out = js;

    // The runtime name needs its declaration in uiHtml's scope; without the
    // anchor, a splice would reference an undeclared variable and break the
    // viewer, so fall back to no runtime name at all.
    let runtimeName = false;
    if (name) {
        if (out.includes(UI_HTML_DECL)) {
            out = replaceOnce(out, UI_HTML_DECL, NAME_DECL + UI_HTML_DECL, 'the ui template');
            runtimeName = true;
        } else {
            skip('the ui template');
        }
    }

    // Overlay badge: icon only, the name as its tooltip, a link only outside
    // client mode (the viewer sets its href to its own URL at runtime).
    const tooltip = runtimeName ? ` title="${NAME_TOKEN}"` : '';
    const badgeOpen = badgeLink ?
        `<a class="sse-viewerBranding sse-hidden"${tooltip} target="_blank" rel="noopener noreferrer">` :
        `<div class="sse-viewerBranding sse-hidden"${tooltip}>`;
    out = replaceOnce(out, jsString(BADGE_OPEN), toJs(badgeOpen), 'the overlay badge');
    out = replaceOnce(out, jsString(BADGE_CLOSE), toJs(badgeLink ? '</a>' : '</div>'), 'the overlay badge label');
    if (iconHref) {
        out = replaceSvg(out, jsString(BADGE_LOGO_OPEN), toJs(`<img id="brandBadgeIcon" src="${escapeHtml(iconHref)}" alt="" />`), 'the overlay badge logo');
    }

    // Info panel header: the operator URL or no link at all, never upstream's
    // repository; the logo alone, or the icon and the name.
    const panelOpen = panelHref ?
        `<a class="sse-viewerTitle" href="${escapeHtml(panelHref)}" target="_blank" rel="noopener noreferrer">` :
        '<div class="sse-viewerTitle">';
    out = replaceOnce(out, jsString(PANEL_OPEN), toJs(panelOpen), 'the info panel header');
    out = replaceOnce(out, jsString(PANEL_CLOSE), toJs(PANEL_VERSION + (panelHref ? '</a>' : '</div>')), 'the info panel header end');
    if (logoHref) {
        out = replaceSvg(out, jsString(PANEL_LOGO_OPEN), toJs(`<img id="brandTitleLogo" src="${escapeHtml(logoHref)}" alt="" />`), 'the info panel logo');
        out = replaceOnce(out, jsString(PANEL_LABEL), '', 'the info panel label');
    } else {
        if (iconHref) {
            out = replaceSvg(out, jsString(PANEL_LOGO_OPEN), toJs(`<img id="brandTitleIcon" src="${escapeHtml(iconHref)}" alt="" />`), 'the info panel logo');
        }
        if (runtimeName) {
            out = replaceOnce(out, jsString(PANEL_LABEL), toJs(`<span class="sse-title-name">${NAME_TOKEN}</span>`), 'the info panel label');
        }
    }

    // Attribution, plus "Powered by" in client mode with only the name linked.
    let powered = '';
    const poweredName = (brand.poweredBy?.name ?? '').trim();
    if (poweredName) {
        const label = escapeHtml(poweredName);
        const href = (brand.poweredBy?.href ?? '').trim();
        powered = `<br />Powered by ${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label}`;
    }
    const markup = `<div id="brandAttribution">Based on <a href="${ATTRIBUTION_URL}" target="_blank" rel="noopener noreferrer">PlayCanvas SuperSplat Viewer</a>${powered}</div>\n            `;
    out = replaceOnce(out, jsString(PANEL_SECTIONS), toJs(markup + PANEL_SECTIONS), 'the info panel sections');
    return out;
};

// Every literal the override reaches into the exported viewer for.
// test/viewer-html-anchors.test.ts asserts each still occurs exactly once in the
// viewer splat-transform ships: the html one in the page, the rest in index.js.
export const BRAND_HTML_ANCHORS = [DOC_TITLE];
export const BRAND_JS_ANCHORS = [UI_HTML_DECL, BADGE_OPEN, BADGE_LOGO_OPEN, BADGE_CLOSE, PANEL_OPEN, PANEL_LOGO_OPEN, PANEL_LABEL, PANEL_CLOSE, PANEL_SECTIONS].map(jsString);
```

- [ ] **Step 5: Run the injector tests to verify they pass**

Run (PowerShell): `npx vitest run test/brand-injection.test.ts > $env:TEMP\brand-inj.txt 2>&1`, then read the file.
Expected: PASS, all tests.

- [ ] **Step 6: Update the real-bundle drift guard `test/viewer-html-anchors.test.ts`**

1. Add the helper import next to the brand import (keep existing order otherwise):

```ts
import { BRAND_HTML_ANCHORS, BRAND_JS_ANCHORS, injectBrand, injectBrandJs } from '../src/viewer-companion/brand';
import { renderUiHtml } from './ui-html';
```

2. Delete the `uiHtmlOf` helper (its only caller is the brand test replaced below; keep `BACKSLASH`, which `extractLiteralAround` still uses).

3. Replace the test `'leaves one deliberate SuperSplat mention in the UI once a full brand is applied'` with:

```ts
    it('renders the stock uiHtml through the test helper', () => {
        expect(renderUiHtml(jsSource)).toContain('<span>SuperSplat</span>');
    });

    it('never writes document.title (the brand name is read back from it)', () => {
        expect(jsSource).not.toContain('document.title');
    });

    it('leaves one deliberate SuperSplat mention in the UI once an env brand is applied', () => {
        const brand = { name: 'Acme', iconHref: './brand-icon.png', panelHref: 'https://acme.example/', badgeLink: true };
        expect(injectBrand(htmlSource, brand)).toContain('<title data-brand-name>Acme</title>');
        const ui = renderUiHtml(injectBrandJs(jsSource, brand), 'Acme');
        expect(ui).toContain('<a class="sse-viewerBranding sse-hidden" title="Acme" target="_blank" rel="noopener noreferrer">');
        expect(ui).toContain('<img id="brandBadgeIcon" src="./brand-icon.png" alt="" />');
        expect(ui).toContain('<a class="sse-viewerTitle" href="https://acme.example/" target="_blank" rel="noopener noreferrer">');
        expect(ui).toContain('<img id="brandTitleIcon" src="./brand-icon.png" alt="" />');
        expect(ui).toContain('<span class="sse-title-name">Acme</span>');
        expect(ui).toContain('PlayCanvas SuperSplat Viewer</a>');
        expect(ui).not.toContain('github.com/playcanvas/supersplat-viewer');
        // Only the attribution line still says SuperSplat inside the UI markup.
        // (The <symbol id="supersplatIcon"> id is an identifier, not branding.)
        expect(occurrences(ui.split('id="supersplatIcon"').join(''), 'SuperSplat')).toBe(1);
    });

    it('renders both brand elements as non-links in client mode', () => {
        const brand = { name: 'Client Co', iconHref: 'https://cdn.example/client/icon.png', logoHref: 'https://cdn.example/client/logo.png', badgeLink: false, poweredBy: { name: 'Acme', href: 'https://acme.example/' } };
        const ui = renderUiHtml(injectBrandJs(jsSource, brand), 'Client Co');
        expect(ui).toContain('<div class="sse-viewerBranding sse-hidden" title="Client Co">');
        expect(ui).toContain('<div class="sse-viewerTitle">');
        expect(ui).toContain('<img id="brandTitleLogo" src="https://cdn.example/client/logo.png" alt="" />');
        expect(ui).toContain('Powered by <a href="https://acme.example/" target="_blank" rel="noopener noreferrer">Acme</a>');
        expect(ui).not.toContain('github.com/playcanvas/supersplat-viewer');
    });
```

- [ ] **Step 7: Run the drift guard and the full root suite**

Run (PowerShell): `npx vitest run test/viewer-html-anchors.test.ts > $env:TEMP\anchors.txt 2>&1`, read it; then `npm run test > $env:TEMP\root-tests.txt 2>&1`, read it.
Expected: PASS. If an anchor count is not 1 (`'keeps every brand surface the override rewrites'`), decode the real markup (the `extractLiteralAround` + `renderUiHtml` pair in this test file shows it) and fix the anchor's whitespace in `brand.ts` — never loosen the test. `test/favicon-injection.test.ts` is untouched by this task and must still pass.

- [ ] **Step 8: Lint and commit**

Run (PowerShell): `npm run lint > $env:TEMP\lint.txt 2>&1`, read it. Expected: no errors.

```bash
git add src/viewer-companion/brand.ts test/ui-html.ts test/brand-injection.test.ts test/viewer-html-anchors.test.ts
git commit -m "Rework viewer brand injectors: icon-only badge, logo panel, runtime name, client mode"
```

---

### Task 2: Wire the new brand shape into the export core

**Files:**
- Modify: `src/viewer-companion/favicon.ts`
- Modify: `src/splat-export-core.ts:26-29,95-160,835-870,976,1025,1118`
- Modify: `src/splat-serialize.ts:795-796` (comment)
- Test: `test/favicon-injection.test.ts`

**Interfaces:**
- Consumes: `BrandInjection`, `injectBrand`, `injectBrandJs` (Task 1).
- Produces (the `brand` option of `writeViewerCore`, which Task 4's `ResolvedBrand` must match field for field — the server reaches it through an untyped dynamic import):

```ts
type Brand = {
    files: { filename: string; data: Uint8Array }[];
    injection: BrandInjection;
};
// ViewerCoreOptions: `brand?: Brand;` — the `favicon` field is removed.
export const injectFaviconLink: (html: string, href: string, mime?: string) => string;
```

- [ ] **Step 1: Write the failing favicon tests — append to `test/favicon-injection.test.ts` inside the `describe`**

```ts
    it('omits the type attribute when the mime is unknown (hotlinked icon)', () => {
        const out = injectFaviconLink(HTML, 'https://cdn.example/client/icon.png');
        expect(out).toContain('<link rel="icon" href="https://cdn.example/client/icon.png">');
    });

    it('escapes the href', () => {
        const out = injectFaviconLink(HTML, 'https://cdn.example/i.png?a=1&b="x"');
        expect(out).toContain('href="https://cdn.example/i.png?a=1&amp;b=&quot;x&quot;"');
    });
```

- [ ] **Step 2: Run to verify they fail**

Run (PowerShell): `npx vitest run test/favicon-injection.test.ts > $env:TEMP\fav.txt 2>&1`, read it.
Expected: FAIL (`type="undefined"`, unescaped href).

- [ ] **Step 3: Update `src/viewer-companion/favicon.ts`**

Replace the header comment's second paragraph and the function so that:

```ts
// Favicon injection for the exported viewer.
//
// The exported viewer's <head> has a <title> and no icon link at all, so a
// browser showing an exported viewer asks the hosting origin for /favicon.ico
// and falls back to a blank tab icon. The brand icon (VIEWER_BRAND_ICON_URL,
// or a client's icon URL on an S3 publish) doubles as the favicon: the export
// core calls this with the resolved icon href.
//
// The href is either an export-derived relative filename (./brand-icon.<ext>)
// or a validated https: URL for a hotlinked client icon, whose type is not
// known, so `mime` is optional. Both are escaped.
//
// Environment-agnostic (compiled for the export server via dist-shared):
// string operations only.

const HEAD_CLOSE = '</head>';

// Injecting twice would produce two competing icon links; the marker makes the
// injection idempotent (mirrors the other companions' soft no-op posture).
const ICON_MARKER = 'rel="icon"';

const escapeAttr = (text: string): string => text
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;');

export const injectFaviconLink = (html: string, href: string, mime?: string): string => {
    const headEnd = html.indexOf(HEAD_CLOSE);
    if (headEnd < 0) {
        console.warn('favicon: exported viewer HTML has no </head>; skipping the icon link');
        return html;
    }
    // Scan only the head (everything before the first </head>), not the whole
    // document: the favicon link is injected last, after the portals /
    // off-limits / device-fallback / annotation script blobs already landed
    // in the body, so a whole-document scan could false-positive on a future
    // companion whose script text happens to contain this literal.
    if (html.slice(0, headEnd).includes(ICON_MARKER)) {
        return html;
    }
    const type = mime ? ` type="${escapeAttr(mime)}"` : '';
    const tag = `<link rel="icon"${type} href="${escapeAttr(href)}">`;
    return `${html.slice(0, headEnd)}        ${tag}\n    ${html.slice(headEnd)}`;
};
```

- [ ] **Step 4: Run the favicon tests to verify they pass**

Run (PowerShell): `npx vitest run test/favicon-injection.test.ts > $env:TEMP\fav.txt 2>&1`, read it. Expected: PASS (the four existing tests too).

- [ ] **Step 5: Update `src/splat-export-core.ts`**

1. Replace the `Favicon` type, `applyFavicon`, the old `Brand` type and `applyBrand` (currently lines ~98-160) with:

```ts
// Optional brand for ZIP exports, resolved by the export server from its
// VIEWER_BRAND_* env and, for an S3 publish, a per-publish client brand
// (server/src/brand-resolve.ts). The browser never passes one, so local
// exports keep the stock SuperSplat branding. `files` are the operator assets
// the brand uses (embedded beside index.html); client images are hotlinked
// URLs inside `injection`. Every memFs entry is zipped by the callers below,
// and the S3 publish path uploads every ZIP entry, so this one insertion point
// serves package, streaming and publish alike.
//
// The server reaches writeViewerCore through an untyped dynamic import of
// dist-shared: keep this shape in step with ResolvedBrand there.
type Brand = {
    files: { filename: string; data: Uint8Array }[];
    injection: BrandInjection;
};

const applyBrand = (
    html: string,
    brand: Brand | undefined,
    memFs: { results: Map<string, Uint8Array> }
): string => {
    if (!brand) {
        return html;
    }
    for (const file of brand.files) {
        memFs.results.set(file.filename, file.data);
    }
    const rawJs = memFs.results.get('index.js');
    if (rawJs) {
        memFs.results.set('index.js', new TextEncoder().encode(injectBrandJs(new TextDecoder().decode(rawJs), brand.injection)));
    } else {
        console.warn('brand: no index.js in the export; the badge and info panel keep the stock branding');
    }
    const page = injectBrand(html, brand.injection);
    // The brand icon doubles as the favicon.
    return brand.injection.iconHref ? injectFaviconLink(page, brand.injection.iconHref, brand.injection.iconMime) : page;
};
```

2. Change the import line to also bring in the type:

```ts
import { injectBrand, injectBrandJs, type BrandInjection } from './viewer-companion/brand';
```

3. In `ViewerCoreOptions`, replace:

```ts
    // Server-only: the browser never fetches these, so a local export keeps the
    // stock favicon-less head and the stock SuperSplat branding.
    favicon?: Favicon;
    brand?: Brand;
```

with:

```ts
    // Server-only: the browser never passes a brand, so a local export keeps
    // the stock favicon-less head and the stock SuperSplat branding.
    brand?: Brand;
```

4. In both destructurings (`writeStreamingViewerCore` ~line 865, `writeViewerCore` ~line 1025) delete `favicon, ` from the list.

5. Replace both call sites:

`applyBrand(applyFavicon(withApi, favicon, memFs), brand, memFs)` → `applyBrand(withApi, brand, memFs)`

`applyBrand(applyFavicon(injected, favicon, memFs), brand, memFs)` → `applyBrand(injected, brand, memFs)`

6. Verify no stale reference remains:

Run (Bash): `grep -n "applyFavicon\|Favicon\b\|favicon?" src/splat-export-core.ts`
Expected: no output.

- [ ] **Step 6: Update the comment in `src/splat-serialize.ts` (~line 795)**

```ts
        // no brand: it is server-only (VIEWER_BRAND_* and the S3 publish's
        // client brand), so a local browser export keeps the stock viewer.
```

- [ ] **Step 7: Verify build, shared build, lint, tests**

Run (PowerShell), reading each output file:
- `npm run build > $env:TEMP\build.txt 2>&1` → then (Bash) `grep -c "plugin typescript" "$TEMP/build.txt"` must print `0`.
- `node scripts/build-shared.mjs > $env:TEMP\shared.txt 2>&1` → no errors.
- `npm run lint > $env:TEMP\lint.txt 2>&1` → no errors.
- `npm run test > $env:TEMP\root-tests.txt 2>&1` → PASS.

(The server still passes `favicon` and the old brand shape until Tasks 3–5; server tests are not run in this task.)

- [ ] **Step 8: Commit**

```bash
git add src/viewer-companion/favicon.ts src/splat-export-core.ts src/splat-serialize.ts test/favicon-injection.test.ts
git commit -m "Export core: brand carries its files and injection, icon doubles as favicon"
```

---

### Task 3: Rework the server env brand loader

**Files:**
- Rewrite: `server/src/brand.ts`
- Delete: `server/src/favicon.ts`
- Rename + modify: `server/test/favicon.test.ts` → `server/test/brand-icon.test.ts`
- Rewrite: `server/test/brand.test.ts`
- Modify (comments): `server/src/fetch-asset.ts:1-3,15-17`, `server/src/s3.ts:32,56`

**Interfaces:**
- Produces (used by Tasks 4 and 5):

```ts
export type BrandAsset = { filename: string; mime: string; data: Uint8Array };
export type EnvBrand = { name: string | null; icon: BrandAsset | null; logo: BrandAsset | null; url: string | null };
export const loadBrand: () => Promise<EnvBrand | null>;
export const warnRemovedBrandEnv: () => void;
```

- [ ] **Step 1: Move the favicon fetch tests onto the brand icon**

Run (Bash):

```bash
git mv server/test/favicon.test.ts server/test/brand-icon.test.ts
sed -i \
  -e "s#import { loadFavicon } from '../src/favicon.js';#import { loadBrand } from '../src/brand.js';\n\n// The brand icon is also the favicon: these pin fetchAsset's limits (types,\n// caps, streaming, prototype-chain guards) through the loader that uses it.\nconst loadIcon = async () => (await loadBrand())?.icon ?? null;#" \
  -e "s/loadFavicon()/loadIcon()/g" \
  -e "s/VIEWER_FAVICON_URL/VIEWER_BRAND_ICON_URL/g" \
  -e "s/'favicon\./'brand-icon./g" \
  -e "s/describe('loadFavicon'/describe('loadBrand icon'/" \
  -e "s/loadFavicon only touches/the loader only touches/; s/in loadFavicon can/in fetchAsset can/" \
  server/test/brand-icon.test.ts
grep -n "favicon\|Favicon" server/test/brand-icon.test.ts
```

Expected: the last grep prints nothing. If it prints a remaining comment, edit it by hand to say "brand icon".

- [ ] **Step 2: Write the failing loader tests — replace `server/test/brand.test.ts` entirely**

```ts
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { loadBrand, warnRemovedBrandEnv } from '../src/brand.js';
import { makeResponse, stubFetch } from './fetch-stub.js';

const ICON_URL = 'https://brand.example.com/icon.png';
const LOGO_URL = 'https://brand.example.com/logo.png';
const BYTES = new Uint8Array([1, 2, 3, 4]);

const response = makeResponse(BYTES);

const VARS = [
    'VIEWER_BRAND_NAME', 'VIEWER_BRAND_ICON_URL', 'VIEWER_BRAND_LOGO_URL', 'VIEWER_BRAND_URL',
    'VIEWER_FAVICON_URL', 'VIEWER_BRAND_FONT_NAME', 'VIEWER_BRAND_FONT_URL'
];

const setEnv = (env: Record<string, string>) => {
    for (const [k, v] of Object.entries(env)) {
        process.env[k] = v;
    }
};

beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    for (const k of VARS) {
        delete process.env[k];
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('loadBrand', () => {
    describe('when nothing is configured', () => {
        it('returns null and never fetches', async () => {
            const fetchFn = stubFetch(() => response());
            expect(await loadBrand()).toBeNull();
            expect(fetchFn).not.toHaveBeenCalled();
        });

        it('treats whitespace-only values as unset', async () => {
            setEnv({ VIEWER_BRAND_NAME: '  ', VIEWER_BRAND_ICON_URL: '   ', VIEWER_BRAND_LOGO_URL: ' ' });
            const fetchFn = stubFetch(() => response());
            expect(await loadBrand()).toBeNull();
            expect(fetchFn).not.toHaveBeenCalled();
        });

        it('returns null when only the URL is set (it brands nothing on its own)', async () => {
            setEnv({ VIEWER_BRAND_URL: 'https://acme.example/' });
            expect(await loadBrand()).toBeNull();
        });
    });

    it('returns the name trimmed, with no fetch', async () => {
        setEnv({ VIEWER_BRAND_NAME: '  Acme  ' });
        const fetchFn = stubFetch(() => response());
        expect(await loadBrand()).toEqual({ name: 'Acme', icon: null, logo: null, url: null });
        expect(fetchFn).not.toHaveBeenCalled();
    });

    describe('logo', () => {
        it('is fetched and named from its content type', async () => {
            setEnv({ VIEWER_BRAND_LOGO_URL: LOGO_URL });
            stubFetch(() => response({ contentType: 'image/png' }));
            expect((await loadBrand())!.logo).toEqual({ filename: 'brand-logo.png', mime: 'image/png', data: BYTES });
        });

        it('drops out on a failed fetch, leaving the rest of the brand intact', async () => {
            setEnv({ VIEWER_BRAND_NAME: 'Acme', VIEWER_BRAND_LOGO_URL: LOGO_URL });
            stubFetch(() => response({ ok: false, status: 404, statusText: 'Not Found' }));
            expect(await loadBrand()).toEqual({ name: 'Acme', icon: null, logo: null, url: null });
            expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(LOGO_URL));
        });
    });

    describe('url', () => {
        it('is kept, normalised, when it is an absolute https URL', async () => {
            setEnv({ VIEWER_BRAND_NAME: 'Acme', VIEWER_BRAND_URL: 'https://ACME.example' });
            expect((await loadBrand())!.url).toBe('https://acme.example/');
        });

        it('is ignored, with a warning, when it is not https', async () => {
            setEnv({ VIEWER_BRAND_NAME: 'Acme', VIEWER_BRAND_URL: 'http://acme.example/' });
            expect((await loadBrand())!.url).toBeNull();
            expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('VIEWER_BRAND_URL'));
        });

        it('is ignored, with a warning, when it is malformed', async () => {
            setEnv({ VIEWER_BRAND_NAME: 'Acme', VIEWER_BRAND_URL: 'not a url' });
            expect((await loadBrand())!.url).toBeNull();
            expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('VIEWER_BRAND_URL'));
        });
    });

    describe('the whole brand', () => {
        it('fetches the icon and the logo and returns all four parts', async () => {
            setEnv({ VIEWER_BRAND_NAME: 'Acme', VIEWER_BRAND_ICON_URL: ICON_URL, VIEWER_BRAND_LOGO_URL: LOGO_URL, VIEWER_BRAND_URL: 'https://acme.example/' });
            stubFetch(url => (url === ICON_URL ? response({ contentType: 'image/png' }) : response({ contentType: 'image/svg+xml' })));
            const brand = await loadBrand();
            expect(brand!.name).toBe('Acme');
            expect(brand!.icon!.filename).toBe('brand-icon.png');
            expect(brand!.logo!.filename).toBe('brand-logo.svg');
            expect(brand!.url).toBe('https://acme.example/');
        });

        it('returns null when every configured asset failed and there is no name', async () => {
            setEnv({ VIEWER_BRAND_ICON_URL: ICON_URL, VIEWER_BRAND_LOGO_URL: LOGO_URL });
            stubFetch(() => response({ ok: false, status: 500, statusText: 'Server Error' }));
            expect(await loadBrand()).toBeNull();
        });

        it('no longer reads the removed font variables', async () => {
            setEnv({ VIEWER_BRAND_FONT_NAME: 'Acme Sans', VIEWER_BRAND_FONT_URL: 'https://brand.example.com/acme.woff2' });
            const fetchFn = stubFetch(() => response());
            expect(await loadBrand()).toBeNull();
            expect(fetchFn).not.toHaveBeenCalled();
        });
    });
});

describe('warnRemovedBrandEnv', () => {
    it('is silent when no removed variable is set', () => {
        warnRemovedBrandEnv();
        expect(console.warn).not.toHaveBeenCalled();
    });

    it('names each removed variable that is still set', () => {
        setEnv({ VIEWER_FAVICON_URL: 'https://x.example/f.png', VIEWER_BRAND_FONT_NAME: 'A', VIEWER_BRAND_FONT_URL: 'https://x.example/a.woff2' });
        warnRemovedBrandEnv();
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('VIEWER_FAVICON_URL'));
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('VIEWER_BRAND_ICON_URL is now also the favicon'));
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('VIEWER_BRAND_FONT_NAME'));
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('VIEWER_BRAND_FONT_URL'));
    });
});
```

- [ ] **Step 3: Run to verify they fail**

Run (PowerShell): `npm --prefix server test -- test/brand.test.ts test/brand-icon.test.ts > $env:TEMP\srv-brand.txt 2>&1`, read it.
Expected: FAIL (`warnRemovedBrandEnv` not exported, no `logo`/`url`, `.ico` not accepted, `brand-icon` filenames).

- [ ] **Step 4: Replace `server/src/brand.ts` entirely**

```ts
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
```

- [ ] **Step 5: Delete the favicon loader and fix stale comments**

Run (Bash): `git rm server/src/favicon.ts`

In `server/src/fetch-asset.ts`, replace the first three comment lines with:

```ts
// Shared loader for the small, optional, deployment-configured images that get
// baked into ZIP viewer exports: the brand icon and the brand logo
// (VIEWER_BRAND_ICON_URL, VIEWER_BRAND_LOGO_URL).
```

and the two field comments:

```ts
    // Prefix on every warning line, e.g. "brand icon".
    label: string;
    // What the operator loses, e.g. "exporting without the brand icon".
```

In `server/src/s3.ts`, line ~32: `// Keep in sync with the favicon allow-list in favicon.ts: a published viewer's` → `// Keep in sync with the image allow-list in brand.ts: a published viewer's`; line ~56: `// Own-property lookup, matching favicon.ts's MIME_EXT/EXT_MIME guard: entry` → `// Own-property lookup, matching fetch-asset.ts's MIME table guard: entry`.

(`server/src/run-export.ts` still imports `favicon.js` and is fixed in Task 5; the server does not compile until then. Tests below import only `brand.js`.)

- [ ] **Step 6: Run the loader tests to verify they pass**

Run (PowerShell): `npm --prefix server test -- test/brand.test.ts test/brand-icon.test.ts > $env:TEMP\srv-brand.txt 2>&1`, read it.
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/brand.ts server/src/fetch-asset.ts server/src/s3.ts server/test/brand.test.ts server/test/brand-icon.test.ts
git commit -m "Server env brand: add logo and url, icon doubles as favicon, drop font and favicon loaders"
```

---

### Task 4: Resolve and validate the client brand

**Files:**
- Create: `server/src/brand-resolve.ts`
- Create: `server/test/brand-resolve.test.ts`

**Interfaces:**
- Consumes: `EnvBrand`, `BrandAsset` (Task 3).
- Produces (used by Task 5):

```ts
export type BrandOverride = { name?: string; iconUrl?: string; logoUrl?: string };
export type ResolvedBrand = {
    files: { filename: string; data: Uint8Array }[];
    injection: {
        name?: string; iconHref?: string; iconMime?: string; logoHref?: string;
        panelHref?: string; badgeLink: boolean; poweredBy?: { name: string; href?: string };
    };
};
export const resolveBrand: (env: EnvBrand | null, override?: BrandOverride) => ResolvedBrand | null;
export const validateBrandOverride: (raw: unknown) => { ok: true; value: BrandOverride | undefined } | { ok: false; error: string };
```

- [ ] **Step 1: Write the failing tests — create `server/test/brand-resolve.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { resolveBrand, validateBrandOverride } from '../src/brand-resolve.js';
import type { EnvBrand } from '../src/brand.js';

const ICON = { filename: 'brand-icon.png', mime: 'image/png', data: new Uint8Array([1]) };
const LOGO = { filename: 'brand-logo.svg', mime: 'image/svg+xml', data: new Uint8Array([2]) };
const ENV: EnvBrand = { name: 'Acme', icon: ICON, logo: LOGO, url: 'https://acme.example/' };

const C_ICON = 'https://cdn.example/client/icon.png';
const C_LOGO = 'https://cdn.example/client/logo.png';

describe('resolveBrand', () => {
    it('returns null with no env brand and no override', () => {
        expect(resolveBrand(null)).toBeNull();
        expect(resolveBrand(null, {})).toBeNull();
    });

    it('env only: embeds the operator assets and links to the operator URL', () => {
        expect(resolveBrand(ENV)).toEqual({
            files: [{ filename: 'brand-icon.png', data: ICON.data }, { filename: 'brand-logo.svg', data: LOGO.data }],
            injection: {
                name: 'Acme',
                iconHref: './brand-icon.png',
                iconMime: 'image/png',
                logoHref: './brand-logo.svg',
                panelHref: 'https://acme.example/',
                badgeLink: true,
                poweredBy: undefined
            }
        });
    });

    it('env only without a URL: the panel header is not a link', () => {
        expect(resolveBrand({ ...ENV, url: null })!.injection.panelHref).toBeUndefined();
    });

    it('full client brand: hotlinks everything, embeds nothing, client mode', () => {
        expect(resolveBrand(ENV, { name: 'Client Co', iconUrl: C_ICON, logoUrl: C_LOGO })).toEqual({
            files: [],
            injection: {
                name: 'Client Co',
                iconHref: C_ICON,
                iconMime: undefined,
                logoHref: C_LOGO,
                panelHref: undefined,
                badgeLink: false,
                poweredBy: { name: 'Acme', href: 'https://acme.example/' }
            }
        });
    });

    it('a complete client pair beats the env logo in the panel', () => {
        const r = resolveBrand(ENV, { name: 'Client Co', iconUrl: C_ICON })!;
        expect(r.injection.logoHref).toBeUndefined();
        expect(r.injection.iconHref).toBe(C_ICON);
        expect(r.files).toEqual([]);
        expect(r.injection.badgeLink).toBe(false);
    });

    it('a client name alone falls back entirely to the env brand (not client mode)', () => {
        expect(resolveBrand(ENV, { name: 'Client Co' })).toEqual(resolveBrand(ENV));
    });

    it('a client icon alone falls back entirely to the env brand (not client mode)', () => {
        expect(resolveBrand(ENV, { iconUrl: C_ICON })).toEqual(resolveBrand(ENV));
    });

    it('a client logo alone: env name and icon, client logo, client mode', () => {
        const r = resolveBrand(ENV, { logoUrl: C_LOGO })!;
        expect(r.injection).toEqual({
            name: 'Acme',
            iconHref: './brand-icon.png',
            iconMime: 'image/png',
            logoHref: C_LOGO,
            panelHref: undefined,
            badgeLink: false,
            poweredBy: { name: 'Acme', href: 'https://acme.example/' }
        });
        expect(r.files).toEqual([{ filename: 'brand-icon.png', data: ICON.data }]);
    });

    it('a client logo and name without an icon: env pair, client logo', () => {
        const r = resolveBrand(ENV, { name: 'Client Co', logoUrl: C_LOGO })!;
        expect(r.injection.name).toBe('Acme');
        expect(r.injection.iconHref).toBe('./brand-icon.png');
        expect(r.injection.logoHref).toBe(C_LOGO);
        expect(r.injection.badgeLink).toBe(false);
    });

    it('client mode without an env name adds no "Powered by"', () => {
        const r = resolveBrand(null, { name: 'Client Co', iconUrl: C_ICON })!;
        expect(r.injection.poweredBy).toBeUndefined();
        expect(r.injection.badgeLink).toBe(false);
        expect(r.files).toEqual([]);
    });

    it('client mode with an env name but no URL: "Powered by" unlinked', () => {
        const r = resolveBrand({ ...ENV, url: null }, { logoUrl: C_LOGO })!;
        expect(r.injection.poweredBy).toEqual({ name: 'Acme', href: undefined });
    });

    it('a client logo with no env brand at all', () => {
        expect(resolveBrand(null, { logoUrl: C_LOGO })!.injection).toEqual({
            name: undefined,
            iconHref: undefined,
            iconMime: undefined,
            logoHref: C_LOGO,
            panelHref: undefined,
            badgeLink: false,
            poweredBy: undefined
        });
    });
});

describe('validateBrandOverride', () => {
    const ok = (raw: unknown) => {
        const r = validateBrandOverride(raw);
        expect(r.ok).toBe(true);
        return (r as { ok: true; value: unknown }).value;
    };
    const bad = (raw: unknown) => {
        const r = validateBrandOverride(raw);
        expect(r.ok).toBe(false);
        return (r as { ok: false; error: string }).error;
    };

    it('accepts an absent override', () => {
        expect(ok(undefined)).toBeUndefined();
        expect(ok(null)).toBeUndefined();
    });

    it('treats blank and whitespace-only fields as absent', () => {
        expect(ok({ name: '', iconUrl: '  ', logoUrl: '' })).toBeUndefined();
        expect(ok({ name: '  Client Co ', iconUrl: ' ' })).toEqual({ name: 'Client Co' });
    });

    it('returns only the fields provided, URLs normalised', () => {
        expect(ok({ iconUrl: 'https://CDN.example/a b.png' })).toEqual({ iconUrl: 'https://cdn.example/a%20b.png' });
        expect(ok({ name: 'Client Co', iconUrl: C_ICON, logoUrl: C_LOGO })).toEqual({ name: 'Client Co', iconUrl: C_ICON, logoUrl: C_LOGO });
    });

    it('rejects a non-object', () => {
        expect(bad('x')).toContain('brandOverride');
        expect(bad([])).toContain('brandOverride');
    });

    it('rejects a non-string field', () => {
        expect(bad({ name: 3 })).toContain('name');
        expect(bad({ logoUrl: {} })).toContain('logoUrl');
    });

    it('rejects a name over 100 characters or with control characters', () => {
        expect(bad({ name: 'x'.repeat(101) })).toContain('name');
        expect(bad({ name: `a${String.fromCharCode(7)}b` })).toContain('name');
        expect(ok({ name: 'x'.repeat(100) })).toEqual({ name: 'x'.repeat(100) });
    });

    it('rejects anything but an absolute https URL', () => {
        expect(bad({ iconUrl: 'http://cdn.example/i.png' })).toContain('iconUrl');
        expect(bad({ iconUrl: 'javascript:alert(1)' })).toContain('iconUrl');
        expect(bad({ logoUrl: 'data:image/png;base64,AAAA' })).toContain('logoUrl');
        expect(bad({ logoUrl: 'not a url' })).toContain('logoUrl');
        expect(bad({ logoUrl: '/relative.png' })).toContain('logoUrl');
    });

    it('rejects a URL over 2048 characters', () => {
        expect(bad({ iconUrl: `https://cdn.example/${'a'.repeat(2048)}` })).toContain('iconUrl');
    });
});
```

- [ ] **Step 2: Run to verify they fail**

Run (PowerShell): `npm --prefix server test -- test/brand-resolve.test.ts > $env:TEMP\srv-resolve.txt 2>&1`, read it.
Expected: FAIL (module not found).

- [ ] **Step 3: Create `server/src/brand-resolve.ts`**

```ts
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
        if (url.text.length > URL_MAX || !parsed || parsed.protocol !== 'https:') {
            return { ok: false, error: `brandOverride.${key} must be an absolute https URL of at most ${URL_MAX} characters` };
        }
        value[key] = parsed.href;
    }

    return { ok: true, value: Object.keys(value).length ? value : undefined };
};
```

- [ ] **Step 4: Run to verify they pass**

Run (PowerShell): `npm --prefix server test -- test/brand-resolve.test.ts > $env:TEMP\srv-resolve.txt 2>&1`, read it.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/brand-resolve.ts server/test/brand-resolve.test.ts
git commit -m "Server: resolve the client brand over the env brand, validate publish input"
```

---

### Task 5: Wire the brand through the export server

**Files:**
- Modify: `server/src/run-export.ts:14-25,283-304`
- Modify: `server/src/index.ts` (imports, `/api/export` ~line 97, `/api/publish` ~line 323-337, `start()` ~line 344)
- Modify: `server/test/publish-routes.test.ts`
- Create: `server/test/ui-html.ts` (copy of `test/ui-html.ts`)
- Rewrite: `server/test/brand-zip.gpu.test.ts`
- Delete: `server/test/favicon-zip.gpu.test.ts`

**Interfaces:**
- Consumes: `loadBrand`, `warnRemovedBrandEnv` (Task 3); `resolveBrand`, `validateBrandOverride`, `BrandOverride` (Task 4); `writeViewerCore({ brand })` shape (Task 2).
- Produces: `ExportOptions.brandOverride?: BrandOverride` (set only by `/api/publish`).

- [ ] **Step 1: Write the failing route tests in `server/test/publish-routes.test.ts`**

Replace the worker-host mock so it records the options it receives:

```ts
// Mock the worker host so no GPU is needed: return a tiny fake zip, and record
// the options each job ran with.
const captured = vi.hoisted(() => ({ options: null as any }));
vi.mock('../src/run-export-worker-host.js', () => ({
    runExportViaWorker: ({ options }: any) => {
        captured.options = options;
        return {
            promise: Promise.resolve({ files: [{ name: 'output.zip', data: new Uint8Array([1, 2, 3]) }] }),
            cancel: () => {}
        };
    }
}));
```

Append inside `describe('publish routes', ...)`:

```ts
    it('passes a validated client brand through to the export', async () => {
        await withApp(async (base) => {
            const form = new FormData();
            form.append('ply', new Blob([new Uint8Array(tinyPlyGz())]), 'scene.ply.gz');
            form.append('options', JSON.stringify({
                name: 'branded', public: false, overwrite: false,
                brandOverride: { name: ' Client Co ', iconUrl: 'https://CDN.example/icon.png', logoUrl: '' },
                viewerExportSettings: { type: 'zip', experienceSettings: {} }
            }));
            const res = await fetch(`${base}/api/publish`, { method: 'POST', body: form });
            expect(res.status).toBe(202);
            const { jobId } = await res.json();
            await (await fetch(`${base}/api/publish/${jobId}/events`)).text();
            expect(captured.options.brandOverride).toEqual({ name: 'Client Co', iconUrl: 'https://cdn.example/icon.png' });
        });
    });

    it('rejects a non-https client brand URL with a descriptive 400', async () => {
        await withApp(async (base) => {
            const form = new FormData();
            form.append('ply', new Blob([new Uint8Array(tinyPlyGz())]), 'scene.ply.gz');
            form.append('options', JSON.stringify({
                name: 'branded', public: false, overwrite: false,
                brandOverride: { iconUrl: 'http://cdn.example/icon.png' },
                viewerExportSettings: { type: 'zip', experienceSettings: {} }
            }));
            const res = await fetch(`${base}/api/publish`, { method: 'POST', body: form });
            expect(res.status).toBe(400);
            expect((await res.json()).error).toContain('iconUrl');
        });
    });

    it('ignores a client brand sent to the plain export route', async () => {
        await withApp(async (base) => {
            const form = new FormData();
            form.append('ply', new Blob([new Uint8Array(tinyPlyGz())]), 'scene.ply.gz');
            form.append('options', JSON.stringify({
                fileType: 'packageViewer', filename: 'out.zip',
                brandOverride: { name: 'Client Co', iconUrl: 'https://cdn.example/icon.png' },
                viewerExportSettings: { type: 'zip', experienceSettings: {} }
            }));
            const res = await fetch(`${base}/api/export`, { method: 'POST', body: form });
            expect(res.status).toBe(202);
            const { jobId } = await res.json();
            await (await fetch(`${base}/api/export/${jobId}/events`)).text();
            expect(captured.options.fileType).toBe('packageViewer');
            expect(captured.options.brandOverride).toBeUndefined();
        });
    });
```

- [ ] **Step 2: Run to verify they fail**

Run (PowerShell): `npm --prefix server test -- test/publish-routes.test.ts > $env:TEMP\srv-routes.txt 2>&1`, read it.
Expected: FAIL (brandOverride not forwarded / not rejected / not stripped). If the suite fails to load because `run-export.ts` still imports `./favicon.js`, that is the same root cause and Step 3 fixes it.

- [ ] **Step 3: Update `server/src/run-export.ts`**

Imports (replace the two brand/favicon lines):

```ts
import { loadBrand } from './brand.js';
import { resolveBrand, type BrandOverride } from './brand-resolve.js';
```

`ExportOptions` — add after `portalExtras`:

```ts
    // Per-publish client brand, already validated by /api/publish. Never set
    // for /api/export: a ZIP download carries the operator's env brand alone.
    brandOverride?: BrandOverride;
```

Replace the favicon + brand loading block before the `packageViewer` `writeViewerCore` call:

```ts
    // Operator brand (VIEWER_BRAND_*) merged with the S3 publish's client brand,
    // ZIP exports only: null when nothing is configured, in which case the
    // export keeps the stock viewer. Each operator asset that cannot be fetched
    // drops out on its own.
    const brand = resolveBrand(await loadBrand(), options.brandOverride);
```

and in the call, delete `favicon: favicon ?? undefined,` (keep `brand: brand ?? undefined,`).

- [ ] **Step 4: Update `server/src/index.ts`**

Imports (place alphabetically among the existing local imports):

```ts
import { warnRemovedBrandEnv } from './brand.js';
import { validateBrandOverride } from './brand-resolve.js';
```

In `/api/export`, immediately before `const id = createJob(plyGz, options, ...)`:

```ts
        // A client brand is only ever offered by the S3 publish dialog; a ZIP
        // download carries the operator's env brand alone.
        delete options.brandOverride;
```

In `/api/publish`, right after `if (!prefix) return reply.code(400).send({ error: 'invalid subfolder or name' });`:

```ts
        const brand = validateBrandOverride(options.brandOverride);
        if (!brand.ok) return reply.code(400).send({ error: brand.error });
```

and add to `exportOptions`:

```ts
            portalExtras: options.portalExtras,
            brandOverride: brand.value
```

In `start()`, before `await app.listen(...)`:

```ts
    warnRemovedBrandEnv();
```

- [ ] **Step 5: Run the route tests and type-check the server**

Run (PowerShell): `npm --prefix server test -- test/publish-routes.test.ts > $env:TEMP\srv-routes.txt 2>&1`, read it. Expected: PASS.
Run (PowerShell): `npm --prefix server run build > $env:TEMP\srv-build.txt 2>&1`, read it. Expected: no `tsc` errors.
Run (Bash): `grep -rn "favicon" server/src` — expected: no output.

- [ ] **Step 6: Copy the test helper and rewrite the GPU ZIP test**

Run (Bash): `cp test/ui-html.ts server/test/ui-html.ts` and add one line to its header comment: `// Copy of test/ui-html.ts (the server suite does not import root tests).`

Run (Bash): `git rm server/test/favicon-zip.gpu.test.ts`

Replace `server/test/brand-zip.gpu.test.ts` entirely:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { probeGpu, createGpuSession } from '../src/gpu.js';
import { runExport, type RunResult } from '../src/run-export.js';
import { renderUiHtml } from './ui-html.js';
import { makePlyGz, zipEntryNames, zipReadEntry, experienceSettings } from './zip-helpers.js';

const ICON_URL = 'https://brand.example.com/icon.png';
const LOGO_URL = 'https://brand.example.com/logo.png';
const ICON = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
const LOGO = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 1, 1, 1]);
const CLIENT = { name: 'Client Co', iconUrl: 'https://cdn.example/client/icon.png', logoUrl: 'https://cdn.example/client/logo.png' };

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('runExport packageViewer brand (GPU)', () => {
    let gpu = false;
    let pkg: RunResult | undefined;
    let streaming: RunResult | undefined;
    let client: RunResult | undefined;
    const fetched: string[] = [];

    beforeAll(async () => {
        gpu = (await probeGpu()).gpu;
        if (!gpu) return;
        process.env.VIEWER_BRAND_NAME = 'Acme';
        process.env.VIEWER_BRAND_ICON_URL = ICON_URL;
        process.env.VIEWER_BRAND_LOGO_URL = LOGO_URL;
        process.env.VIEWER_BRAND_URL = 'https://acme.example/';
        // Serve the two operator assets from a stub, but let any other fetch
        // through: the export pipeline must not be starved of a real fetch.
        const realFetch = globalThis.fetch;
        const serve = (bytes: Uint8Array) => {
            let delivered = false;
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'image/png' : null) },
                body: {
                    getReader: () => ({
                        read: async () => {
                            if (delivered) return { done: true, value: undefined };
                            delivered = true;
                            return { done: false, value: bytes.slice() };
                        },
                        cancel: async () => {}
                    })
                }
            };
        };
        vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => {
            fetched.push(String(url));
            if (String(url) === ICON_URL) return serve(ICON);
            if (String(url) === LOGO_URL) return serve(LOGO);
            return realFetch(url, init);
        }));

        const plyGz = await makePlyGz(2048);
        const session = createGpuSession();
        try {
            const run = (streamingMode: boolean, brandOverride?: typeof CLIENT) => runExport({
                plyGz,
                options: {
                    fileType: 'packageViewer',
                    filename: 'out.zip',
                    viewerExportSettings: { type: 'zip', streaming: streamingMode, experienceSettings },
                    brandOverride
                },
                sink: { emit: () => {} },
                getDeviceCreator: session.getDeviceCreator
            });
            pkg = await run(false);
            streaming = await run(true);
            client = await run(false, CLIENT);
        } finally {
            await session.dispose();
        }
    }, 300000);

    afterAll(() => {
        delete process.env.VIEWER_BRAND_NAME;
        delete process.env.VIEWER_BRAND_ICON_URL;
        delete process.env.VIEWER_BRAND_LOGO_URL;
        delete process.env.VIEWER_BRAND_URL;
        vi.unstubAllGlobals();
    });

    const expectEnvBrand = (res: RunResult | undefined) => {
        const zip = Buffer.from(res!.files[0].data);
        const names = zipEntryNames(zip);
        expect(Uint8Array.from(zipReadEntry(zip, 'brand-icon.png'))).toEqual(ICON);
        expect(Uint8Array.from(zipReadEntry(zip, 'brand-logo.png'))).toEqual(LOGO);
        expect(names).not.toContain('favicon.png');

        const html = zipReadEntry(zip, 'index.html').toString('utf8');
        expect(html).toContain('<title data-brand-name>Acme</title>');
        expect(html).toContain('<link rel="icon" type="image/png" href="./brand-icon.png">');
        expect(html).toContain('<style id="brandStyle">');

        const js = zipReadEntry(zip, 'index.js').toString('utf8');
        // Proves the handle-publish patch (viewer-engine-patch.ts) ran AFTER
        // branding on the same memFs 'index.js' entry.
        expect(js).toContain('window.__supersplatViewer = viewer;');
        expect(js).toContain('var __brandNameHtml = ');

        const ui = renderUiHtml(js, 'Acme');
        expect(ui).toContain('<a class="sse-viewerBranding sse-hidden" title="Acme" target="_blank" rel="noopener noreferrer">');
        expect(ui).toContain('<img id="brandBadgeIcon" src="./brand-icon.png" alt="" />');
        expect(ui).toContain('<a class="sse-viewerTitle" href="https://acme.example/" target="_blank" rel="noopener noreferrer">');
        expect(ui).toContain('<img id="brandTitleLogo" src="./brand-logo.png" alt="" />');
        expect(ui).not.toContain('sse-title-name');
        expect(ui).not.toContain('Powered by');
        const attributionAt = ui.indexOf('id="brandAttribution"');
        expect(attributionAt).toBeGreaterThan(-1);
        expect(ui.indexOf('<div class="sse-infoGpu">')).toBeGreaterThan(attributionAt);
        expect(occurrences(ui.split('id="supersplatIcon"').join(''), 'SuperSplat')).toBe(1);
    };

    it('bakes the env brand into a package ZIP', () => {
        if (!gpu) { console.warn('No GPU available; skipping brand GPU test'); return; }
        expectEnvBrand(pkg);
    });

    it('bakes the env brand into a streaming ZIP', () => {
        if (!gpu) return;
        expectEnvBrand(streaming);
    });

    it('hotlinks a client brand and drops every link to the host', () => {
        if (!gpu) return;
        const zip = Buffer.from(client!.files[0].data);
        const names = zipEntryNames(zip);
        // the client pair and logo replace both operator assets: neither is embedded
        expect(names).not.toContain('brand-icon.png');
        expect(names).not.toContain('brand-logo.png');
        // client URLs are never fetched by the server
        expect(fetched).not.toContain(CLIENT.iconUrl);
        expect(fetched).not.toContain(CLIENT.logoUrl);

        const html = zipReadEntry(zip, 'index.html').toString('utf8');
        expect(html).toContain('<title data-brand-name>Client Co</title>');
        expect(html).toContain('<link rel="icon" href="https://cdn.example/client/icon.png">');

        const ui = renderUiHtml(zipReadEntry(zip, 'index.js').toString('utf8'), 'Client Co');
        expect(ui).toContain('<div class="sse-viewerBranding sse-hidden" title="Client Co">');
        expect(ui).toContain('<img id="brandBadgeIcon" src="https://cdn.example/client/icon.png" alt="" />');
        expect(ui).toContain('<div class="sse-viewerTitle">');
        expect(ui).toContain('<img id="brandTitleLogo" src="https://cdn.example/client/logo.png" alt="" />');
        expect(ui).toContain('Powered by <a href="https://acme.example/" target="_blank" rel="noopener noreferrer">Acme</a>');
        expect(ui).not.toContain('github.com/playcanvas/supersplat-viewer');
    });
});
```

- [ ] **Step 7: Run the full server suite (includes GPU tests when a GPU is present)**

Make sure no AI image server or other GPU-heavy process is running. Run (PowerShell): `npm --prefix server test > $env:TEMP\srv-all.txt 2>&1`, read it.
Expected: PASS, including the byte-parity test. If the GPU tests report "No GPU available; skipping", say so explicitly in the task report — they did not run.

- [ ] **Step 8: Commit**

```bash
git add server/src/run-export.ts server/src/index.ts server/test/publish-routes.test.ts server/test/ui-html.ts server/test/brand-zip.gpu.test.ts
git commit -m "Export server: carry the validated client brand on publish, ignore it on export"
```

---

### Task 6: Client brand fields in the S3 publish dialog

**Files:**
- Modify: `src/ui/s3-publish-dialog.ts:22-34,78-103,230-245`
- Modify: `src/s3-publish.ts:68-78`
- Modify: `src/export-server-client.ts:125`
- Modify: `static/locales/{de,en,es,fr,ja,ko,pt-BR,ru,zh-CN}.json` (after `popup.publish.s3.public`)

**Interfaces:**
- Consumes: the `/api/publish` contract from Task 5 (`options.brandOverride`, 400 `{ error }`).
- Produces: `S3PublishOptions.brandOverride?: { name?: string; iconUrl?: string; logoUrl?: string }`.

There is no unit-test harness for PCUI dialogs in this repo; this task is verified by build, lint, locale check and the manual E2E in Task 7.

- [ ] **Step 1: Extend `S3PublishOptions` in `src/ui/s3-publish-dialog.ts`**

```ts
export type S3PublishOptions = {
    subfolder: string;
    name: string;
    public: boolean;
    serializeSettings: { maxSHBands: number };
    viewerExportSettings: {
        type: 'zip';
        streaming: boolean;
        collision?: { environment: 'indoor' | 'outdoor'; radius: number; voxelSize: number };
        experienceSettings: ExperienceSettings;
        annotationImages?: { path: string; data: Uint8Array }[];
    };
    // Client brand for this publish; only non-empty fields are sent. The server
    // validates them (https URLs) and hotlinks the images.
    brandOverride?: { name?: string; iconUrl?: string; logoUrl?: string };
};
```

- [ ] **Step 2: Add the three inputs and rows**

After `const isPublic = new BooleanInput(...)`:

```ts
        // Client brand. Kept across openings (never reset in show): a client's
        // brand is typically reused for several publishes in a row.
        const brandName = new TextInput({ class: 'text-input' });
        const brandIconUrl = new TextInput({ class: 'text-input', placeholder: 'https://' });
        const brandLogoUrl = new TextInput({ class: 'text-input', placeholder: 'https://' });
```

After `const publicRow = row('popup.publish.s3.public', isPublic);`:

```ts
        const brandNameRow = row('popup.publish.s3.brand-name', brandName);
        const brandIconRow = row('popup.publish.s3.brand-icon-url', brandIconUrl);
        const brandLogoRow = row('popup.publish.s3.brand-logo-url', brandLogoUrl);
```

Extend the second append list:

```ts
        [radiusRow, voxelRow, animationRow, loopRow, colorRow, fovRow, bandsRow, subfolderRow, nameRow, publicRow, brandNameRow, brandIconRow, brandLogoRow]
        .forEach(r => content.append(r.c));
```

Do not add anything for these three inputs to the `// reset` block in `show`.

- [ ] **Step 3: Send the brand from `assemble()`**

Inside `assemble`, before `return {`:

```ts
                const brand = {
                    name: brandName.value.trim(),
                    iconUrl: brandIconUrl.value.trim(),
                    logoUrl: brandLogoUrl.value.trim()
                };
                const brandOverride = Object.fromEntries(Object.entries(brand).filter(([, v]) => v));
```

and add as the last property of the returned object (after `viewerExportSettings: {...}`):

```ts
                    ...(Object.keys(brandOverride).length ? { brandOverride } : {})
```

- [ ] **Step 4: Forward it in `src/s3-publish.ts`**

In `publishOptions`, after `...(upload ? { portalExtras: upload.portalExtras } : {})`:

```ts
                ...(options.brandOverride ? { brandOverride: options.brandOverride } : {})
```

(add a comma after the preceding spread).

- [ ] **Step 5: Surface the server's error message in `src/export-server-client.ts`**

Replace `if (!startRes.ok) throw new Error(\`server publish failed to start (${startRes.status})\`);` with:

```ts
    if (!startRes.ok) {
        // A 400 carries the reason (e.g. an invalid brand URL); show it rather
        // than a bare status code.
        const body = await startRes.json().catch(() => ({}));
        throw new Error(body.error ? `server publish failed to start: ${body.error}` : `server publish failed to start (${startRes.status})`);
    }
```

- [ ] **Step 6: Add the locale strings (Edit tool, one insertion per file, right after the `"popup.publish.s3.public"` line)**

| File | `brand-name` | `brand-icon-url` | `brand-logo-url` |
| --- | --- | --- | --- |
| en | Brand name (optional) | Brand icon URL (optional) | Brand logo URL (optional) |
| de | Markenname (optional) | URL des Markensymbols (optional) | URL des Markenlogos (optional) |
| es | Nombre de la marca (opcional) | URL del icono de la marca (opcional) | URL del logotipo de la marca (opcional) |
| fr | Nom de la marque (facultatif) | URL de l'icône de la marque (facultatif) | URL du logo de la marque (facultatif) |
| ja | ブランド名 (任意) | ブランドアイコンの URL (任意) | ブランドロゴの URL (任意) |
| ko | 브랜드 이름 (선택 사항) | 브랜드 아이콘 URL (선택 사항) | 브랜드 로고 URL (선택 사항) |
| pt-BR | Nome da marca (opcional) | URL do ícone da marca (opcional) | URL do logotipo da marca (opcional) |
| ru | Название бренда (необязательно) | URL значка бренда (необязательно) | URL логотипа бренда (необязательно) |
| zh-CN | 品牌名称（可选） | 品牌图标 URL（可选） | 品牌徽标 URL（可选） |

English example of the inserted lines (same keys in every file, 4-space indent, trailing commas):

```json
    "popup.publish.s3.brand-name": "Brand name (optional)",
    "popup.publish.s3.brand-icon-url": "Brand icon URL (optional)",
    "popup.publish.s3.brand-logo-url": "Brand logo URL (optional)",
```

- [ ] **Step 7: Verify**

Run (PowerShell), reading each output:
- `npm run lint:locales > $env:TEMP\locales.txt 2>&1` → no missing/extra keys.
- `npm run lint > $env:TEMP\lint.txt 2>&1` → no errors.
- `npm run build > $env:TEMP\build.txt 2>&1` → then (Bash) `grep -c "plugin typescript" "$TEMP/build.txt"` prints `0`.
- `npm run test > $env:TEMP\root-tests.txt 2>&1` → PASS.

- [ ] **Step 8: Commit**

```bash
git add src/ui/s3-publish-dialog.ts src/s3-publish.ts src/export-server-client.ts static/locales
git commit -m "S3 publish dialog: optional client brand name, icon URL and logo URL"
```

---

### Task 7: Documentation, full verification, E2E hand-off

**Files:**
- Modify: `server/README.md:65-100` (the `VIEWER_FAVICON_URL` and `VIEWER_BRAND_*` bullets)

- [ ] **Step 1: Replace the two README bullets (`VIEWER_FAVICON_URL …` and `VIEWER_BRAND_NAME, …`) with**

```markdown
- `VIEWER_BRAND_NAME`, `VIEWER_BRAND_ICON_URL`, `VIEWER_BRAND_LOGO_URL`, `VIEWER_BRAND_URL` —
  the operator brand, replacing the viewer's SuperSplat branding in **ZIP viewer exports**
  (`packageViewer`, plain and streaming, including the S3 publish that reuses them).
  Single-file HTML and local in-browser exports are unaffected.
  - `VIEWER_BRAND_NAME` becomes the document title (`<title data-brand-name>Acme</title>`),
    the overlay badge's tooltip and, unless a logo is shown, the info panel label (which
    keeps its version suffix).
  - `VIEWER_BRAND_ICON_URL` is the overlay badge (icon only, top-left, which the viewer only
    reveals when embedded in a cross-origin iframe), the info panel icon, and the
    **favicon**. Stored as `brand-icon.<ext>` beside `index.html`.
  - `VIEWER_BRAND_LOGO_URL`, when set, is shown alone in the info panel header instead of
    the icon and the name. Stored as `brand-logo.<ext>`.
  - `VIEWER_BRAND_URL` (absolute `https` only, otherwise ignored with a warning) is the
    target of the info panel header; unset, the header is not a link. The badge keeps
    linking to the viewer's own URL.

  Icon and logo are fetched once per export (5 s timeout, 1 MiB maximum; PNG, ICO, SVG,
  JPEG, WebP, GIF) and embedded, so the archive stays self-contained. Prefer PNG or ICO
  for the icon: an SVG is served as a document from the publish origin and can execute
  embedded scripts, so only use an image host you control. Each asset that cannot be
  fetched is dropped with a warning; the export always completes. With none set, exports
  keep the stock branding silently. Whenever a brand is applied, the info panel gains a
  small "Based on [PlayCanvas SuperSplat Viewer](https://superspl.at/)" line.

  `VIEWER_FAVICON_URL`, `VIEWER_BRAND_FONT_NAME` and `VIEWER_BRAND_FONT_URL` are no longer
  supported; the server logs a notice at startup if they are still set.

- **Per-publish client brand (S3 publish only).** The publish dialog has three optional
  fields — brand name, icon URL, logo URL — sent as `brandOverride` and validated by
  `/api/publish` (absolute `https` URLs of at most 2048 characters; a name of at most 100
  characters without control characters; anything else is a 400). Client images are
  **hotlinked, never fetched by the server**, so updating an image at its URL updates
  every scene published with it. Rules:
  - Name and icon form a pair: the client's are used only when both are given; otherwise
    the operator's name and icon are used.
  - Info panel header: client logo, else client icon + name, else operator logo, else
    operator icon + name.
  - When a client logo or a complete client pair is used, neither the badge nor the panel
    header is a link, and the info panel adds "Powered by *operator*" (only the operator
    name links to `VIEWER_BRAND_URL`).
  - The name lives only in `<title data-brand-name>` of each published `index.html`; the
    badge tooltip and panel label read it at runtime. To rename published scenes, rewrite
    that element and re-upload `index.html` with the same content type and ACL.
  - `/api/export` (ZIP download) ignores `brandOverride`.
```

- [ ] **Step 2: Final sweep for removed names and the operator brand**

Run (Bash):

```bash
git grep -n "VIEWER_FAVICON_URL\|VIEWER_BRAND_FONT" -- ':!docs/superpowers' ':!server/README.md' ':!server/src/brand.ts' ':!server/test/brand.test.ts'
git grep -n -i "<operator-name-pattern>" ; git log main..HEAD --format=%B | grep -i -c "<operator-name-pattern>"   # pattern supplied by the operator; never committed
```

Expected: first command no output; second command no output and the count `0`.

- [ ] **Step 3: Full verification**

Run (PowerShell), reading each output:
- `npm run lint > $env:TEMP\lint.txt 2>&1` → no errors.
- `npm run lint:locales > $env:TEMP\locales.txt 2>&1` → clean.
- `npm run test > $env:TEMP\root-tests.txt 2>&1` → PASS.
- `npm run build > $env:TEMP\build.txt 2>&1` → (Bash) `grep -c "plugin typescript" "$TEMP/build.txt"` prints `0`.
- `npm --prefix server run build > $env:TEMP\srv-build.txt 2>&1` → no errors.
- `npm --prefix server test > $env:TEMP\srv-all.txt 2>&1` → PASS (report whether GPU tests ran or skipped).

- [ ] **Step 4: Commit**

```bash
git add server/README.md
git commit -m "Document the operator and per-publish client brand"
```

- [ ] **Step 5: Hand the user the env lines (tooling cannot edit env files)**

For `server/.env.local.example` (and their own `server/.env.local`): remove `VIEWER_FAVICON_URL`, `VIEWER_BRAND_FONT_NAME`, `VIEWER_BRAND_FONT_URL`; add:

```
# Operator brand logo, shown alone in the info panel header (https URL, optional)
VIEWER_BRAND_LOGO_URL=
# Operator website: info panel header link, and "Powered by" link on client-branded publishes (https, optional)
VIEWER_BRAND_URL=
```

- [ ] **Step 6: Manual E2E checklist for the user (release build, Chrome)**

1. Restart the server with the env brand set; confirm no removed-variable notice (or the expected one).
2. "Export on server" ZIP: favicon = operator icon; badge (in a cross-origin iframe) = icon only, tooltip = name, click opens the viewer URL; panel = operator logo (or icon + name), header links to `VIEWER_BRAND_URL` or is not a link; no "Powered by".
3. S3 publish with a full client brand: favicon and badge = client icon, badge not clickable, panel = client logo, header not clickable, "Powered by *operator*" with only the name linked; no `brand-icon.*`/`brand-logo.*` in the published folder.
4. Publish again: the three fields still hold the previous values.
5. Publish with only a client name: looks exactly like the env-only publish.
6. Publish with an `http://` icon URL: the error popup names `iconUrl`.
7. Edit a published `index.html`'s `<title data-brand-name>` to another name, re-upload it, reload: badge tooltip and panel label show the new name.
8. Overwrite a client image at its URL, reload (after CDN expiry): the new image shows without republishing.
```
