# Runtime Brand Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator's other application switch a published viewer between operator and client brand (and change the client name, icon and logo) by rewriting three `<meta>` elements in `index.html` only.

**Architecture:** The brand rules move into one pure, self-contained module (`brand-rules.ts`) that the export core uses for the static `<title>`/favicon and that is injected via `Function.toString()` into a synchronous inline `<head>` script of every branded page. That script reads the client metas, resolves against the operator brand baked into it, sets the title and favicon before first paint, and leaves the badge/panel markup fragments in `window.__brandUi`. `index.js` carries no brand values at all: each brand anchor in its `uiHtml` literal becomes a `__brandPart("key","stock")` call that returns the fragment, or the stock markup when there is none.

**Tech Stack:** TypeScript, Vitest (Node environment), Fastify export server, `@playcanvas/splat-transform` viewer bundle.

**Spec:** `docs/superpowers/specs/2026-10-09-runtime-brand-switch-design.md`

## Global Constraints

- Never write the operator's real company name anywhere (code, tests, docs, commit messages, regexes). Use `Acme` (operator) and `Client Co` (client).
- Client meta names, exactly: `brand-client-name`, `brand-client-icon`, `brand-client-logo`. Empty or missing = not set.
- Client icon/logo URLs are honoured at runtime only when absolute `https:` without credentials; anything else is ignored with a `console.warn`.
- `resolveBrandView` and `brandFragments` are injected with `Function.toString()`: self-contained (no imports, no module-level references), **no backslash escapes and no backticks** in their bodies. The brand runtime script template has no backslashes or backticks either, other than its `${…}` injections.
- Never `String.replace` with brand text as the replacement (a `$` is read as a pattern). Use `slice`/`split`/`join`.
- No operator or client value is ever written into `index.js`.
- Branding only applies when the operator brand or the client brand has a name, icon or logo; otherwise the export stays the untouched stock viewer.
- Run npm/npx/vitest/tsc through the **PowerShell** tool, in the foreground, redirected to a file in `$env:TEMP`, then read the file. Never pipe vitest output. git/grep/sed stay on Bash.
- Rollup reports TypeScript errors as warnings: after `npm run build`, gate on zero `plugin typescript` lines, never on the exit code.
- Server tests load the shared core from `dist-shared/`: `npm --prefix server test` rebuilds it (`pretest`); a bare vitest run in `server/` does not.
- Work on branch `feature/runtime-brand-switch` (already created, holds the spec commit). One commit per task; the branch is squashed into one commit when finished.

## Review Focus

1. **An operator name containing `</script>` or `<!--`** (env values are free text) must not close or comment out the inline runtime script; the page still renders that exact name. Test: Task 3, "operator JSON cannot close the script element".
2. **Hostile or malformed client metas written by the other app** (markup in the name, `javascript:`/`http:`/relative URLs) must be escaped or ignored, never executed or rendered raw. Tests: Task 1 (https filter, escaping), Task 3 (hostile name, non-https icon).
3. **A meta deleted outright, or left whitespace-only**, must behave as "not set" (operator mode), not crash the script. Tests: Task 3.
4. **A switch that needs the favicon link created or removed** (operator brand without an icon) must leave exactly one correct link, or none. Tests: Task 3.
5. **Re-running the injectors on an already-branded page or `index.js`** must be a no-op (no double script, no double splice). Tests: Task 2 and Task 3 idempotency.

---

### Task 1: Pure brand rules (`brand-rules.ts`)

**Files:**
- Create: `src/viewer-companion/brand-rules.ts`
- Test: `test/brand-rules.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (exact):
  ```ts
  export type BrandOperator = { name?: string; iconHref?: string; iconMime?: string; logoHref?: string; url?: string };
  export type BrandClient = { name?: string; iconUrl?: string; logoUrl?: string };
  export type BrandView = { name: string; iconHref: string; iconMime: string; logoHref: string; panelHref: string; badgeLink: boolean; poweredBy: { name: string; href: string } | null };
  export type BrandFragments = { badgeOpen: string; badgeIcon?: string; badgeClose: string; panelOpen: string; panelLogo?: string; panelLabel?: string; panelClose: string; attribution: string };
  export const resolveBrandView: (operator: BrandOperator, client: BrandClient) => BrandView | null;
  export const brandFragments: (view: BrandView) => BrandFragments;
  ```
  In `BrandView`, `''` means absent. In `BrandFragments`, an absent optional key means "keep the stock markup"; a present key (even `''`) replaces it.

- [ ] **Step 1: Write the failing test**

Create `test/brand-rules.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

import { brandFragments, resolveBrandView, type BrandOperator } from '../src/viewer-companion/brand-rules';

const OP: BrandOperator = { name: 'Acme', iconHref: './brand-icon.png', iconMime: 'image/png', logoHref: './brand-logo.svg', url: 'https://acme.example/' };
const C_ICON = 'https://cdn.example/client/icon.png';
const C_LOGO = 'https://cdn.example/client/logo.png';
const EXTERNAL = ' target="_blank" rel="noopener noreferrer"';
const BASED_ON = `Based on <a href="https://superspl.at/"${EXTERNAL}>PlayCanvas SuperSplat Viewer</a>`;

// The page gets both functions through Function.toString(), so every case also
// runs against a copy re-created from its source text: a reference to anything
// outside the function body fails there.
const fromSource = <T>(fn: T): T => new Function(`return ${String(fn)}`)() as T;
const variants: [string, typeof resolveBrandView, typeof brandFragments][] = [
    ['imported', resolveBrandView, brandFragments],
    ['from toString()', fromSource(resolveBrandView), fromSource(brandFragments)]
];

describe.each(variants)('brand rules (%s)', (_label, resolve, fragments) => {
    const operatorView = {
        name: 'Acme',
        iconHref: './brand-icon.png',
        iconMime: 'image/png',
        logoHref: './brand-logo.svg',
        panelHref: 'https://acme.example/',
        badgeLink: true,
        poweredBy: null
    };

    describe('resolveBrandView', () => {
        it('resolves nothing without a name, icon or logo', () => {
            expect(resolve({}, {})).toBeNull();
            expect(resolve({ url: 'https://acme.example/' }, {})).toBeNull();
            expect(resolve(undefined as any, undefined as any)).toBeNull();
        });

        it('operator only: operator values, links on', () => {
            expect(resolve(OP, {})).toEqual(operatorView);
        });

        it('operator without a URL: the panel header is not a link', () => {
            expect(resolve({ ...OP, url: undefined }, {})!.panelHref).toBe('');
        });

        it('full client brand: client values, client mode', () => {
            expect(resolve(OP, { name: 'Client Co', iconUrl: C_ICON, logoUrl: C_LOGO })).toEqual({
                name: 'Client Co',
                iconHref: C_ICON,
                iconMime: '',
                logoHref: C_LOGO,
                panelHref: '',
                badgeLink: false,
                poweredBy: { name: 'Acme', href: 'https://acme.example/' }
            });
        });

        it('a complete client pair beats the operator logo', () => {
            const view = resolve(OP, { name: 'Client Co', iconUrl: C_ICON })!;
            expect(view.logoHref).toBe('');
            expect(view.iconHref).toBe(C_ICON);
            expect(view.badgeLink).toBe(false);
        });

        it('a client name or icon alone falls back entirely to the operator', () => {
            expect(resolve(OP, { name: 'Client Co' })).toEqual(operatorView);
            expect(resolve(OP, { iconUrl: C_ICON })).toEqual(operatorView);
        });

        it('a client logo alone: operator pair, client logo, client mode', () => {
            expect(resolve(OP, { logoUrl: C_LOGO })).toEqual({
                name: 'Acme',
                iconHref: './brand-icon.png',
                iconMime: 'image/png',
                logoHref: C_LOGO,
                panelHref: '',
                badgeLink: false,
                poweredBy: { name: 'Acme', href: 'https://acme.example/' }
            });
        });

        it('a client logo and name without an icon: operator pair, client logo', () => {
            const view = resolve(OP, { name: 'Client Co', logoUrl: C_LOGO })!;
            expect(view.name).toBe('Acme');
            expect(view.iconHref).toBe('./brand-icon.png');
            expect(view.logoHref).toBe(C_LOGO);
        });

        it('client mode without an operator name has no "Powered by"', () => {
            expect(resolve({}, { name: 'Client Co', iconUrl: C_ICON })!.poweredBy).toBeNull();
        });

        it('client mode with an operator name but no URL: "Powered by" unlinked', () => {
            expect(resolve({ ...OP, url: undefined }, { logoUrl: C_LOGO })!.poweredBy).toEqual({ name: 'Acme', href: '' });
        });

        it('a client logo with no operator brand at all', () => {
            expect(resolve({}, { logoUrl: C_LOGO })).toEqual({
                name: '', iconHref: '', iconMime: '', logoHref: C_LOGO, panelHref: '', badgeLink: false, poweredBy: null
            });
        });

        it('trims values and treats whitespace-only as unset', () => {
            expect(resolve(OP, { name: '  ', iconUrl: ` ${C_ICON} ` })).toEqual(operatorView);
            expect(resolve(OP, { name: ' Client Co ', iconUrl: ` ${C_ICON} ` })!.name).toBe('Client Co');
        });

        it('ignores non-string client values', () => {
            expect(resolve(OP, { name: 3 as any, iconUrl: {} as any, logoUrl: null as any })).toEqual(operatorView);
        });

        it('ignores client URLs that are not absolute https, with a warning', () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            for (const bad of ['http://cdn.example/i.png', 'javascript:alert(1)', 'https://u:p@cdn.example/i.png', '/relative.png', 'not a url', 'data:image/png;base64,AAAA']) {
                expect(resolve(OP, { name: 'Client Co', iconUrl: bad, logoUrl: bad }), bad).toEqual(operatorView);
            }
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('brand: ignoring the client'));
            warn.mockRestore();
        });

        it('normalises a client URL the way the server does', () => {
            expect(resolve(OP, { logoUrl: 'https://CDN.example/a b.png' })!.logoHref).toBe('https://cdn.example/a%20b.png');
        });
    });

    describe('brandFragments', () => {
        it('operator view: linked badge and header, logo alone, attribution only', () => {
            expect(fragments(resolve(OP, {})!)).toEqual({
                badgeOpen: `<a class="sse-viewerBranding sse-hidden" title="Acme"${EXTERNAL}>`,
                badgeIcon: '<img id="brandBadgeIcon" src="./brand-icon.png" alt="" />',
                badgeClose: '</a>',
                panelOpen: `<a class="sse-viewerTitle" href="https://acme.example/"${EXTERNAL}>`,
                panelLogo: '<img id="brandTitleLogo" src="./brand-logo.svg" alt="Acme" />',
                panelLabel: '',
                panelClose: '</a>',
                attribution: `<div id="brandAttribution">${BASED_ON}</div>`
            });
        });

        it('client pair: non-link badge and header, icon and name, "Powered by"', () => {
            expect(fragments(resolve(OP, { name: 'Client Co', iconUrl: C_ICON })!)).toEqual({
                badgeOpen: '<div class="sse-viewerBranding sse-hidden" title="Client Co">',
                badgeIcon: `<img id="brandBadgeIcon" src="${C_ICON}" alt="" />`,
                badgeClose: '</div>',
                panelOpen: '<div class="sse-viewerTitle">',
                panelLogo: `<img id="brandTitleIcon" src="${C_ICON}" alt="" />`,
                panelLabel: '<span class="sse-title-name">Client Co</span>',
                panelClose: '</div>',
                attribution: `<div id="brandAttribution">${BASED_ON}<br />Powered by <a href="https://acme.example/"${EXTERNAL}>Acme</a></div>`
            });
        });

        it('leaves the stock badge logo and label when there is no icon and no name', () => {
            const f = fragments(resolve({}, { logoUrl: C_LOGO })!);
            expect(f.badgeIcon).toBeUndefined();
            expect(f.badgeOpen).toBe('<div class="sse-viewerBranding sse-hidden">');
            expect(f.panelLogo).toBe(`<img id="brandTitleLogo" src="${C_LOGO}" alt="" />`);
            expect(f.panelLabel).toBe('');
        });

        it('keeps the stock panel logo and label when a name-less view has no icon or logo', () => {
            const f = fragments({ ...resolve(OP, {})!, iconHref: '', logoHref: '', name: '' });
            expect('panelLogo' in f).toBe(false);
            expect('panelLabel' in f).toBe(false);
        });

        it('leaves "Powered by" unlinked without an operator URL', () => {
            const f = fragments(resolve({ name: 'Acme' }, { logoUrl: C_LOGO })!);
            expect(f.attribution).toBe(`<div id="brandAttribution">${BASED_ON}<br />Powered by Acme</div>`);
        });

        it('escapes names and URLs, and keeps a $ literal', () => {
            const f = fragments(resolve({ name: '$& <"Labs">', iconHref: './i.png?a=1&b="x"' }, {})!);
            expect(f.badgeOpen).toContain('title="$&amp; &lt;&quot;Labs&quot;&gt;"');
            expect(f.badgeIcon).toBe('<img id="brandBadgeIcon" src="./i.png?a=1&amp;b=&quot;x&quot;" alt="" />');
            expect(f.panelLabel).toBe('<span class="sse-title-name">$&amp; &lt;&quot;Labs&quot;&gt;</span>');
        });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (PowerShell): `npx vitest run test/brand-rules.test.ts > $env:TEMP\brand-rules.txt 2>&1`, then read the file.
Expected: FAIL, cannot resolve `../src/viewer-companion/brand-rules`.

- [ ] **Step 3: Write the implementation**

Create `src/viewer-companion/brand-rules.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run (PowerShell): `npx vitest run test/brand-rules.test.ts > $env:TEMP\brand-rules.txt 2>&1`, then read the file.
Expected: PASS, both variants. If only the `from toString()` variant fails with a `ReferenceError`, a function body references something outside itself: move it inside.

Then (Bash) confirm the build trap: `sed -n '/^export const resolveBrandView/,$p' src/viewer-companion/brand-rules.ts | grep -c '[\\`]'` must print `0`.

- [ ] **Step 5: Commit**

```bash
git add src/viewer-companion/brand-rules.ts test/brand-rules.test.ts
git commit -m "Add pure brand rules for runtime brand resolution"
```

---

### Task 2: `index.js` half — `__brandPart` splices, no baked brand

**Files:**
- Modify: `src/viewer-companion/brand.ts` (the uiHtml half: constants from `const NAME_VAR` through `const NAME_SPLICE`, `toJs`, `ATTRIBUTION_URL`, `replaceSvg`, `injectBrandJs`)
- Modify: `src/splat-export-core.ts:127` (the `injectBrandJs` call)
- Modify: `test/ui-html.ts` (tokenizer)
- Modify: `test/brand-injection.test.ts` (the `describe('injectBrandJs (uiHtml half)', …)` block and imports)
- Modify: `test/viewer-html-anchors.test.ts` (the three brand tests at the end and imports)

**Interfaces:**
- Consumes: `resolveBrandView`, `brandFragments`, `BrandFragments` from Task 1 (tests only).
- Produces:
  - `export const injectBrandJs: (js: string) => string` (no brand argument any more).
  - `index.js` contract: `var __brandPart = function (key, stock) {…}` declared on one line right before `var uiHtml = `, reading `window.__brandUi` (a `BrandFragments`-shaped object). Fragment keys spliced: `badgeOpen`, `badgeIcon`, `badgeClose`, `panelOpen`, `panelLogo`, `panelLabel`, `panelClose`, `attribution`.
  - `test/ui-html.ts`: `export const renderUiHtml: (js: string, ui?: Record<string, string> | null) => string`. Task 3 and Task 4 rely on this signature.

- [ ] **Step 1: Update the tokenizer test helper**

Replace the whole of `test/ui-html.ts` with:

```ts
// Renders index.js's `var uiHtml = …;` the way the browser would, given the
// fragments the brand runtime script left in window.__brandUi (null: none, so
// every surface keeps its stock markup). The brand override turns that
// initializer into string literals joined by `+` around
// `__brandPart("key","stock")` calls (see src/viewer-companion/brand.ts); this
// walks those tokens and decodes each literal with JSON.parse, so nothing from
// the bundle is ever executed.

const BACKSLASH = String.fromCharCode(92);
const DECL = 'var uiHtml = ';
const PART = '__brandPart(';

// Decodes the double-quoted literal starting at `i`; returns it and the index
// just past its closing quote.
const readLiteral = (js: string, i: number): [string, number] => {
    if (js[i] !== '"') {
        throw new Error(`expected a string literal in uiHtml at ${i}: ${js.slice(i, i + 20)}`);
    }
    let j = i + 1;
    while (js[j] !== '"') {
        j += js[j] === BACKSLASH ? 2 : 1;
    }
    return [JSON.parse(js.slice(i, j + 1)) as string, j + 1];
};

export const renderUiHtml = (js: string, ui: Record<string, string> | null = null): string => {
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
            const [text, next] = readLiteral(js, i);
            out += text;
            i = next;
        } else if (js.startsWith(PART, i)) {
            const [key, afterKey] = readLiteral(js, i + PART.length);
            if (js[afterKey] !== ',') {
                throw new Error(`expected , in __brandPart at ${afterKey}`);
            }
            const [stock, afterStock] = readLiteral(js, afterKey + 1);
            if (js[afterStock] !== ')') {
                throw new Error(`expected ) in __brandPart at ${afterStock}`);
            }
            // same semantics as the injected __brandPart
            out += ui && typeof ui[key] === 'string' ? ui[key] : stock;
            i = afterStock + 1;
        } else if (js[i] === ';') {
            return out;
        } else {
            throw new Error(`unexpected token in uiHtml at ${i}: ${js.slice(i, i + 20)}`);
        }
    }
};
```

- [ ] **Step 2: Write the failing tests**

In `test/brand-injection.test.ts`:

1. Add, below the existing imports:

```ts
import { brandFragments, resolveBrandView } from '../src/viewer-companion/brand-rules';
```

2. Replace the entire `describe('injectBrandJs (uiHtml half)', () => { … });` block (from that line to the end of the file) with:

```ts
describe('injectBrandJs (uiHtml half)', () => {
    const OPERATOR_VIEW = resolveBrandView({ name: 'Acme', iconHref: './brand-icon.png', iconMime: 'image/png', url: 'https://acme.example/' }, {})!;
    const CLIENT_VIEW = resolveBrandView({ name: 'Acme', url: 'https://acme.example/' }, { name: 'Client Co', iconUrl: 'https://cdn.example/client/icon.png' })!;
    const js = injectBrandJs(JS);

    it('renders the exact stock uiHtml when the brand runtime left no fragments', () => {
        expect(renderUiHtml(js)).toBe(UI);
        expect(renderUiHtml(js, {})).toBe(UI);
    });

    it('declares __brandPart right before uiHtml, on one line', () => {
        const at = js.indexOf('var __brandPart = ');
        expect(at).toBeGreaterThan(-1);
        expect(js.indexOf('var uiHtml = ')).toBe(js.indexOf('\n', at) + 1);
    });

    it('__brandPart returns a fragment string (even empty), else the stock markup', () => {
        const at = js.indexOf('var __brandPart = ');
        const decl = js.slice(at, js.indexOf('\n', at));
        const part = (win: unknown) => new Function('window', `${decl}\nreturn __brandPart;`)(win) as (key: string, stock: string) => string;
        expect(part(undefined)('k', 'stock')).toBe('stock');
        expect(part({})('k', 'stock')).toBe('stock');
        expect(part({ __brandUi: { k: 'x' } })('k', 'stock')).toBe('x');
        expect(part({ __brandUi: { k: '' } })('k', 'stock')).toBe('');
        expect(part({ __brandUi: { k: 3 } })('k', 'stock')).toBe('stock');
    });

    describe('operator view', () => {
        const ui = renderUiHtml(js, brandFragments(OPERATOR_VIEW));

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
            expect(ui).toContain(`<div id="brandAttribution">${BASED_ON}</div><div class="sse-infoGpu">`);
            expect(ui).not.toContain('Powered by');
        });
    });

    describe('client view', () => {
        const ui = renderUiHtml(js, brandFragments(CLIENT_VIEW));

        it('renders the badge and the panel header as non-link elements', () => {
            expect(ui).toContain(
                '<div class="sse-viewerBranding sse-hidden" title="Client Co">\n' +
                '        <img id="brandBadgeIcon" src="https://cdn.example/client/icon.png" alt="" />\n' +
                '        </div>'
            );
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

        it('shows a logo alone in the panel (the label fragment is an empty string)', () => {
            const withLogo = renderUiHtml(js, brandFragments({ ...CLIENT_VIEW, logoHref: 'https://cdn.example/client/logo.png' }));
            expect(withLogo).toContain(
                '<div class="sse-viewerTitle">\n' +
                '                <img id="brandTitleLogo" src="https://cdn.example/client/logo.png" alt="Client Co" />\n' +
                '                \n' +
                `                ${VERSION}\n`
            );
            expect(withLogo).not.toContain('sse-title-name');
        });
    });

    it('keeps the stock badge logo when the view has a name but no icon', () => {
        const ui = renderUiHtml(js, brandFragments(resolveBrandView({ name: 'Acme' }, {})!));
        expect(ui).toContain('title="Acme"');
        expect(ui).toContain('aria-label="SuperSplat"');
        expect(ui).not.toContain('<span>SuperSplat</span>');
        expect(ui).toContain('<span class="sse-title-name">Acme</span>');
    });

    it('is idempotent', () => {
        expect(injectBrandJs(js)).toBe(js);
    });

    it('leaves index.js untouched, with a warning, when the uiHtml declaration has moved', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const moved = JS.replace('var uiHtml = ', 'let uiHtml = ');
        expect(injectBrandJs(moved)).toBe(moved);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('ui template'));
        warn.mockRestore();
    });

    it('splices what it can when an anchor is missing, with a warning', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const noBadge = JS.replace('sse-viewerBranding sse-hidden', 'sse-somethingElse');
        const ui = renderUiHtml(injectBrandJs(noBadge), brandFragments(OPERATOR_VIEW));
        expect(ui).toContain('<span class="sse-title-name">Acme</span>');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('overlay badge'));
        warn.mockRestore();
    });
});
```

3. Change the attribution-related constant usage nowhere else; `VERSION`, `BASED_ON`, `HTML`, `UI`, `JS`, `ENV`, `CLIENT` stay (the page-half block still uses `ENV`/`CLIENT` until Task 3).

In `test/viewer-html-anchors.test.ts`:

1. Change the brand import line to:

```ts
import { BRAND_HTML_ANCHORS, BRAND_JS_ANCHORS, injectBrandJs } from '../src/viewer-companion/brand';
import { brandFragments, resolveBrandView } from '../src/viewer-companion/brand-rules';
```

2. Replace the three tests `'never writes document.title (the brand name is read back from it)'`, `'leaves one deliberate SuperSplat mention in the UI once an env brand is applied'` and `'renders both brand elements as non-links in client mode'` with:

```ts
    it('never writes document.title (the brand runtime script owns it)', () => {
        expect(jsSource).not.toContain('document.title');
    });

    it('renders the exact stock uiHtml when the brand runtime left no fragments', () => {
        expect(renderUiHtml(injectBrandJs(jsSource))).toBe(renderUiHtml(jsSource));
    });

    it('leaves one deliberate SuperSplat mention in the UI under an operator brand', () => {
        const view = resolveBrandView({ name: 'Acme', iconHref: './brand-icon.png', iconMime: 'image/png', url: 'https://acme.example/' }, {})!;
        const ui = renderUiHtml(injectBrandJs(jsSource), brandFragments(view));
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
        const view = resolveBrandView(
            { name: 'Acme', url: 'https://acme.example/' },
            { name: 'Client Co', iconUrl: 'https://cdn.example/client/icon.png', logoUrl: 'https://cdn.example/client/logo.png' }
        )!;
        const ui = renderUiHtml(injectBrandJs(jsSource), brandFragments(view));
        expect(ui).toContain('<div class="sse-viewerBranding sse-hidden" title="Client Co">');
        expect(ui).toContain('<div class="sse-viewerTitle">');
        expect(ui).toContain('<img id="brandTitleLogo" src="https://cdn.example/client/logo.png" alt="Client Co" />');
        expect(ui).toContain('Powered by <a href="https://acme.example/" target="_blank" rel="noopener noreferrer">Acme</a>');
        expect(ui).not.toContain('github.com/playcanvas/supersplat-viewer');
    });
```

- [ ] **Step 3: Run tests to verify they fail**

Run (PowerShell): `npx vitest run test/brand-injection.test.ts test/viewer-html-anchors.test.ts > $env:TEMP\brand-js.txt 2>&1`, then read the file.
Expected: FAIL in the `injectBrandJs` blocks (old implementation still bakes `__brandNameHtml` and needs a brand argument; `renderUiHtml` now rejects the `__brandNameHtml` token).

- [ ] **Step 4: Implement the uiHtml half**

In `src/viewer-companion/brand.ts`:

1. Delete these declarations and their comments: `ATTRIBUTION_URL`, `NAME_VAR`, `NAME_DECL`, `NAME_TOKEN`, `NAME_SPLICE`, and the `toJs` function.

2. Insert, right after the `const SVG_CLOSE = '</svg>';` line:

```ts
// The uiHtml surfaces the brand runtime can replace. Each anchor becomes a
// __brandPart call returning window.__brandUi[key] when the page's brand
// runtime script set it (an empty string included) and the anchor's stock
// markup otherwise, so a page whose runtime resolved nothing, or failed,
// renders exactly the stock viewer. Nothing brand-specific is ever written
// into index.js: the same file serves every mode.
const UI_PART = '__brandPart';
const UI_PART_DECL = `var ${UI_PART} = function (key, stock) { var ui = typeof window === "undefined" ? null : window.__brandUi; return ui && typeof ui[key] === "string" ? ui[key] : stock; };\n`;

// Closes the uiHtml string literal, calls __brandPart, reopens it. `stockJs` is
// already in its escaped string-literal form.
const part = (key: string, stockJs: string): string => `"+${UI_PART}("${key}","${stockJs}")+"`;
```

3. Replace the `replaceSvg` function with:

```ts
// Replaces a whole <svg>...</svg> element, located by its (unique) opening
// tag; `replace` receives the element's text as it stands in the input.
const replaceSvg = (text: string, openTag: string, replace: (svg: string) => string, what: string): string => {
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
    const end = close + SVG_CLOSE.length;
    return text.slice(0, at) + replace(text.slice(at, end)) + text.slice(end);
};
```

4. Replace the whole `injectBrandJs` function (and its leading comment) with:

```ts
// The uiHtml half of the override, applied to index.js: every brand surface
// becomes a __brandPart splice. Idempotent by the declaration it adds.
export const injectBrandJs = (js: string): string => {
    if (js.includes(UI_PART)) {
        return js;
    }
    // A splice without the declaration in uiHtml's scope would throw and break
    // the viewer, so without the anchor nothing is spliced at all.
    if (!js.includes(UI_HTML_DECL)) {
        skip('the ui template');
        return js;
    }

    let out = replaceOnce(js, UI_HTML_DECL, UI_PART_DECL + UI_HTML_DECL, 'the ui template');
    out = replaceOnce(out, jsString(BADGE_OPEN), part('badgeOpen', jsString(BADGE_OPEN)), 'the overlay badge');
    out = replaceSvg(out, jsString(BADGE_LOGO_OPEN), svg => part('badgeIcon', svg), 'the overlay badge logo');
    out = replaceOnce(out, jsString(BADGE_CLOSE), part('badgeClose', jsString(BADGE_CLOSE)), 'the overlay badge label');
    out = replaceOnce(out, jsString(PANEL_OPEN), part('panelOpen', jsString(PANEL_OPEN)), 'the info panel header');
    out = replaceSvg(out, jsString(PANEL_LOGO_OPEN), svg => part('panelLogo', svg), 'the info panel logo');
    out = replaceOnce(out, jsString(PANEL_LABEL), part('panelLabel', jsString(PANEL_LABEL)), 'the info panel label');
    out = replaceOnce(out, jsString(PANEL_CLOSE), jsString(PANEL_VERSION) + part('panelClose', jsString('</a>')), 'the info panel header end');
    out = replaceOnce(out, jsString(PANEL_SECTIONS), part('attribution', '') + jsString(PANEL_SECTIONS), 'the info panel sections');
    return out;
};
```

5. Leave `injectBrand`, `BrandInjection`, `hasBrand`, `STYLE`, `escapeHtml` untouched (Task 3 reworks them). Confirm (Bash) `grep -n "NAME_\|toJs\|ATTRIBUTION_URL" src/viewer-companion/brand.ts` prints nothing.

In `src/splat-export-core.ts`, change the `injectBrandJs` call inside `applyBrand` to:

```ts
        memFs.results.set('index.js', new TextEncoder().encode(injectBrandJs(new TextDecoder().decode(rawJs))));
```

- [ ] **Step 5: Run tests to verify they pass**

Run (PowerShell): `npx vitest run test/brand-injection.test.ts test/viewer-html-anchors.test.ts test/brand-rules.test.ts > $env:TEMP\brand-js.txt 2>&1`, then read the file.
Expected: PASS (the page-half `injectBrand` tests are unchanged and still pass).

- [ ] **Step 6: Commit**

```bash
git add src/viewer-companion/brand.ts src/splat-export-core.ts test/ui-html.ts test/brand-injection.test.ts test/viewer-html-anchors.test.ts
git commit -m "Splice index.js brand surfaces from window.__brandUi"
```

---

### Task 3: Page half — client metas, inline brand runtime, export core wiring

**Files:**
- Create: `test/brand-runtime-stub.ts` (test helper)
- Create: `test/brand-runtime.test.ts`
- Modify: `src/viewer-companion/brand.ts` (header comment, `BrandInjection` → `BrandInput`, `hasBrand`, `injectBrand`, new runtime script)
- Modify: `src/viewer-companion/favicon.ts` (`injectFaviconLink` → `faviconLinkTag`)
- Modify: `src/splat-export-core.ts` (imports, `Brand` type, `applyBrand`)
- Modify: `test/brand-injection.test.ts` (the `describe('injectBrand (page half)', …)` block, fixtures)
- Modify: `test/favicon-injection.test.ts`
- Modify: `test/viewer-html-anchors.test.ts` (one new test)

**Interfaces:**
- Consumes: `resolveBrandView`, `brandFragments`, `BrandOperator`, `BrandClient` (Task 1); `injectBrandJs(js)`, `renderUiHtml(js, ui)` (Task 2).
- Produces:
  - `export type BrandInput = { operator: BrandOperator; client: BrandClient }` and `export const injectBrand: (html: string, brand: BrandInput) => string` in `brand.ts`.
  - `export const BRAND_CLIENT_METAS = { name: 'brand-client-name', icon: 'brand-client-icon', logo: 'brand-client-logo' } as const` in `brand.ts`.
  - `export const faviconLinkTag: (href: string, mime?: string) => string` in `favicon.ts`.
  - Export core `brand` option shape: `{ files: { filename: string; data: Uint8Array }[]; operator: BrandOperator; client: BrandClient }` (Task 4's server `ResolvedBrand` must match it).
  - `test/brand-runtime-stub.ts`: `runBrandRuntime(html, opts?) => { title: string; favicon: Record<string, string> | null; ui: Record<string, string> | null; warnings: unknown[][] }` and `rewriteClientMeta(html, name, value) => string`. Task 4 copies this file to the server suite.
  - Page head order before `</head>`: marker, `<style id="brandStyle">`, favicon link (when an icon resolves at export), the three metas, `<script id="brandRuntime">`.

- [ ] **Step 1: Write the runtime stub helper**

Create `test/brand-runtime-stub.ts`:

```ts
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
```

- [ ] **Step 2: Write the failing tests**

Create `test/brand-runtime.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import { injectBrand } from '../src/viewer-companion/brand';
import type { BrandClient, BrandOperator } from '../src/viewer-companion/brand-rules';
import { rewriteClientMeta, runBrandRuntime } from './brand-runtime-stub';

// Stand-in for the exported viewer's page (head shape of supersplat-viewer 1.35).
const HTML = `<!doctype html>
<html lang="en">
    <head>
        <title>SuperSplat Viewer</title>
        <link rel="stylesheet" href="./index.css" />
    </head>
    <body></body>
</html>
`;

const OPERATOR: BrandOperator = { name: 'Acme', iconHref: './brand-icon.png', iconMime: 'image/png', logoHref: './brand-logo.png', url: 'https://acme.example/' };
const C_ICON = 'https://cdn.example/client/icon.png';
const C_LOGO = 'https://cdn.example/client/logo.png';

const publish = (client: BrandClient = {}, operator: BrandOperator = OPERATOR) => injectBrand(HTML, { operator, client });

const setClient = (html: string, name: string, icon: string, logo: string) => {
    let out = rewriteClientMeta(html, 'brand-client-name', name);
    out = rewriteClientMeta(out, 'brand-client-icon', icon);
    return rewriteClientMeta(out, 'brand-client-logo', logo);
};

describe('brand runtime script', () => {
    it('operator mode: title, favicon and linked UI from the baked operator brand', () => {
        const r = runBrandRuntime(publish());
        expect(r.title).toBe('Acme');
        expect(r.favicon).toEqual({ rel: 'icon', type: 'image/png', href: './brand-icon.png' });
        expect(r.ui!.badgeOpen).toContain('<a class="sse-viewerBranding sse-hidden" title="Acme"');
        expect(r.ui!.panelLogo).toBe('<img id="brandTitleLogo" src="./brand-logo.png" alt="Acme" />');
        expect(r.ui!.attribution).not.toContain('Powered by');
        expect(r.warnings).toEqual([]);
    });

    it('switches operator -> client -> operator by rewriting only the metas', () => {
        const operatorPage = publish();
        const clientPage = setClient(operatorPage, 'Client Co', C_ICON, C_LOGO);

        const client = runBrandRuntime(clientPage);
        expect(client.title).toBe('Client Co');
        expect(client.favicon).toEqual({ rel: 'icon', href: C_ICON });
        expect(client.ui!.badgeOpen).toBe('<div class="sse-viewerBranding sse-hidden" title="Client Co">');
        expect(client.ui!.panelOpen).toBe('<div class="sse-viewerTitle">');
        expect(client.ui!.panelLogo).toBe(`<img id="brandTitleLogo" src="${C_LOGO}" alt="Client Co" />`);
        expect(client.ui!.attribution).toContain('Powered by <a href="https://acme.example/" target="_blank" rel="noopener noreferrer">Acme</a>');

        const back = runBrandRuntime(setClient(clientPage, '', '', ''));
        expect(back).toEqual(runBrandRuntime(operatorPage));
    });

    it('creates the favicon link when a switch brings the first icon', () => {
        const page = publish({}, { name: 'Acme' });
        expect(runBrandRuntime(page).favicon).toBeNull();
        const r = runBrandRuntime(setClient(page, 'Client Co', C_ICON, ''));
        expect(r.favicon).toEqual({ rel: 'icon', href: C_ICON });
    });

    it('removes the favicon link when a switch leaves no icon', () => {
        const page = publish({ name: 'Client Co', iconUrl: C_ICON }, { name: 'Acme' });
        expect(runBrandRuntime(page).favicon).toEqual({ rel: 'icon', href: C_ICON });
        const r = runBrandRuntime(setClient(page, '', '', ''));
        expect(r.favicon).toBeNull();
        expect(r.title).toBe('Acme');
    });

    it('falls back to the stock viewer when nothing resolves', () => {
        const page = publish({ name: 'Client Co', iconUrl: C_ICON }, {});
        const r = runBrandRuntime(setClient(page, '', '', ''));
        expect(r.title).toBe('SuperSplat Viewer');
        expect(r.favicon).toBeNull();
        expect(r.ui).toBeNull();
    });

    it('ignores a non-https client URL, with a warning', () => {
        const r = runBrandRuntime(setClient(publish(), 'Client Co', 'javascript:alert(1)', 'http://cdn.example/logo.png'));
        expect(r.title).toBe('Acme');
        expect(r.favicon!.href).toBe('./brand-icon.png');
        expect(r.warnings.length).toBeGreaterThan(0);
    });

    it('escapes a hostile client name in the fragments and sets the title as text', () => {
        const hostile = '"><script>alert(1)</script>';
        const r = runBrandRuntime(setClient(publish(), hostile, C_ICON, ''));
        expect(r.title).toBe(hostile);
        expect(r.ui!.badgeOpen).toContain('title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
        for (const fragment of Object.values(r.ui!)) {
            expect(fragment).not.toContain('<script');
        }
    });

    it('treats a deleted meta as unset', () => {
        const page = setClient(publish(), 'Client Co', C_ICON, '');
        const withoutName = page.replace(/<meta name="brand-client-name" content="[^"]*">/, '');
        expect(runBrandRuntime(withoutName).title).toBe('Acme');
    });

    it('treats whitespace-only values as unset', () => {
        expect(runBrandRuntime(setClient(publish(), '  ', `  ${C_ICON}`, ' ')).title).toBe('Acme');
    });

    it('keeps the stock UI, with a warning, when the runtime throws', () => {
        const r = runBrandRuntime(publish(), { breakDocument: true });
        expect(r.ui).toBeNull();
        expect(r.warnings[0][0]).toContain('brand: runtime failed');
    });
});
```

In `test/brand-injection.test.ts`:

1. Replace the `ENV` and `CLIENT` constants with:

```ts
const OPERATOR = { name: 'Acme', iconHref: './brand-icon.png', iconMime: 'image/png', logoHref: './brand-logo.png', url: 'https://acme.example/' };
const ENV = { operator: OPERATOR, client: {} };
const CLIENT = { operator: OPERATOR, client: { name: 'Client Co', iconUrl: 'https://cdn.example/client/icon.png', logoUrl: 'https://cdn.example/client/logo.png' } };
```

2. Add to the imports:

```ts
import { extractBrandScript, runBrandRuntime } from './brand-runtime-stub';
```

3. Replace the whole `describe('injectBrand (page half)', () => { … });` block with:

```ts
describe('injectBrand (page half)', () => {
    it('returns the document unchanged when there is nothing to brand', () => {
        expect(injectBrand(HTML, { operator: {}, client: {} })).toBe(HTML);
        expect(injectBrand(HTML, { operator: { url: 'https://acme.example/' }, client: {} })).toBe(HTML);
    });

    it('writes the export-time name into a plain <title>', () => {
        const out = injectBrand(HTML, ENV);
        expect(out).toContain('<title>Acme</title>');
        expect(out).not.toContain('data-brand-name');
        expect(injectBrand(HTML, CLIENT)).toContain('<title>Client Co</title>');
    });

    it('escapes HTML metacharacters in the name and keeps a $ literal', () => {
        expect(injectBrand(HTML, { operator: { name: 'A&B <"Labs">' }, client: {} })).toContain('<title>A&amp;B &lt;&quot;Labs&quot;&gt;</title>');
        expect(injectBrand(HTML, { operator: { name: '$& Co' }, client: {} })).toContain('<title>$&amp; Co</title>');
    });

    it('leaves the stock title when no name resolves', () => {
        const out = injectBrand(HTML, { operator: { iconHref: './brand-icon.png' }, client: {} });
        expect(out).toContain('<title>SuperSplat Viewer</title>');
        expect(out).toContain('<style id="brandStyle">');
    });

    it('links the export-time icon as the favicon', () => {
        expect(injectBrand(HTML, ENV)).toContain('<link rel="icon" type="image/png" href="./brand-icon.png">');
        expect(injectBrand(HTML, CLIENT)).toContain('<link rel="icon" href="https://cdn.example/client/icon.png">');
        // `<link rel="icon"`, not `rel="icon"`: the runtime script's own source
        // carries the selector link[rel="icon"]
        expect(injectBrand(HTML, { operator: { name: 'Acme' }, client: {} })).not.toContain('<link rel="icon"');
    });

    it('pre-fills the three client metas, escaped, empty when unset', () => {
        const env = injectBrand(HTML, ENV);
        expect(env).toContain('<meta name="brand-client-name" content="">');
        expect(env).toContain('<meta name="brand-client-icon" content="">');
        expect(env).toContain('<meta name="brand-client-logo" content="">');
        const client = injectBrand(HTML, { operator: OPERATOR, client: { name: 'A"B', iconUrl: 'https://cdn.example/i.png?a=1&b=2' } });
        expect(client).toContain('<meta name="brand-client-name" content="A&quot;B">');
        expect(client).toContain('<meta name="brand-client-icon" content="https://cdn.example/i.png?a=1&amp;b=2">');
    });

    it('orders the head: stylesheet, style, favicon, metas, runtime script, </head>', () => {
        const out = injectBrand(HTML, ENV);
        const order = ['./index.css', '<style id="brandStyle">', '<link rel="icon"', 'name="brand-client-name"', '<script id="brandRuntime">', '</head>'].map(s => out.indexOf(s));
        expect(order.every(i => i > -1)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it('bakes only the operator into the runtime script', () => {
        const script = extractBrandScript(injectBrand(HTML, CLIENT));
        expect(script).toContain('"Acme"');
        expect(script).not.toContain('Client Co');
    });

    it('operator JSON cannot close the script element', () => {
        const name = 'Acme</script><!--';
        const out = injectBrand(HTML, { operator: { name }, client: {} });
        expect(out.split('</script>').length - 1).toBe(HTML.split('</script>').length);
        expect(runBrandRuntime(out).title).toBe(name);
    });

    it('styles the replacement images and the non-link variants', () => {
        const out = injectBrand(HTML, ENV);
        expect(out).toContain('.sse-viewer .sse-viewerBranding > img {\n    height: 16px;');
        expect(out).toContain('.sse-viewer div.sse-viewerBranding {\n    cursor: default;\n}');
        expect(out).toContain('    max-width: 100%;\n    object-fit: contain;');
        expect(out).toContain('div.sse-viewerTitle:hover {\n    opacity: 1;\n}');
        expect(out).toContain('#brandAttribution {');
    });

    it('sizes the panel logo to the icon + margin + name block it replaces (56 + 6 + 6 + 18 = 86px)', () => {
        const out = injectBrand(HTML, ENV);
        expect(out).toContain('.sse-viewer .sse-infoPanel > .sse-infoPanelContent > .sse-viewerTitle > #brandTitleLogo {\n    height: 86px;\n    margin-bottom: 0;\n}');
        expect(out.indexOf('> #brandTitleLogo {')).toBeGreaterThan(out.indexOf('.sse-viewerTitle > img {'));
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

    it('warns but still brands when the stock title has moved', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const out = injectBrand(HTML.replace('<title>SuperSplat Viewer</title>', '<title>Other</title>'), ENV);
        expect(out).toContain('<title>Other</title>');
        expect(out).toContain('<script id="brandRuntime">');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('document title'));
        warn.mockRestore();
    });
});
```

Replace the whole of `test/favicon-injection.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';

import { faviconLinkTag } from '../src/viewer-companion/favicon';

describe('faviconLinkTag', () => {
    it('builds the icon link with its type', () => {
        expect(faviconLinkTag('./brand-icon.png', 'image/png')).toBe('<link rel="icon" type="image/png" href="./brand-icon.png">');
    });

    it('omits the type attribute when the mime is unknown (hotlinked icon)', () => {
        expect(faviconLinkTag('https://cdn.example/client/icon.png')).toBe('<link rel="icon" href="https://cdn.example/client/icon.png">');
    });

    it('escapes the href', () => {
        expect(faviconLinkTag('https://cdn.example/i.png?a=1&b="x"')).toContain('href="https://cdn.example/i.png?a=1&amp;b=&quot;x&quot;"');
    });
});
```

In `test/viewer-html-anchors.test.ts`:

1. Change the brand import to also import `injectBrand`, and add the stub import:

```ts
import { BRAND_HTML_ANCHORS, BRAND_JS_ANCHORS, injectBrand, injectBrandJs } from '../src/viewer-companion/brand';
import { runBrandRuntime } from './brand-runtime-stub';
```

2. Add after the `'renders both brand elements as non-links in client mode'` test:

```ts
    it('brands the real page and resolves it at runtime into the real uiHtml', () => {
        const operator = { name: 'Acme', iconHref: './brand-icon.png', iconMime: 'image/png', url: 'https://acme.example/' };
        const page = injectBrand(htmlSource, { operator, client: { name: 'Client Co', iconUrl: 'https://cdn.example/client/icon.png' } });
        expect(page).toContain('<title>Client Co</title>');
        const r = runBrandRuntime(page);
        expect(r.title).toBe('Client Co');
        expect(r.favicon).toEqual({ rel: 'icon', href: 'https://cdn.example/client/icon.png' });
        const ui = renderUiHtml(injectBrandJs(jsSource), r.ui);
        expect(ui).toContain('<div class="sse-viewerBranding sse-hidden" title="Client Co">');
        expect(ui).toContain('<span class="sse-title-name">Client Co</span>');
    });
```

- [ ] **Step 3: Run tests to verify they fail**

Run (PowerShell): `npx vitest run test/brand-runtime.test.ts test/brand-injection.test.ts test/favicon-injection.test.ts test/viewer-html-anchors.test.ts > $env:TEMP\brand-page.txt 2>&1`, then read the file.
Expected: FAIL (no `faviconLinkTag`, no `<script id="brandRuntime">`, old `injectBrand` signature).

- [ ] **Step 4: Implement `faviconLinkTag`**

Replace the whole of `src/viewer-companion/favicon.ts` with:

```ts
// Favicon link for branded exported viewers.
//
// The exported viewer's <head> has no icon link at all, so a browser asks the
// hosting origin for /favicon.ico and falls back to a blank tab icon. The
// brand icon doubles as the favicon: brand.ts writes this link for the icon
// resolved at export time, and the page's brand runtime script corrects it on
// every load.
//
// The href is either an export-derived relative filename (./brand-icon.<ext>)
// or a validated https: URL for a hotlinked client icon, whose type is not
// known, so `mime` is optional. Both are escaped.
//
// Environment-agnostic (compiled for the export server via dist-shared):
// string operations only.

const escapeAttr = (text: string): string => text
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;');

export const faviconLinkTag = (href: string, mime?: string): string => {
    const type = mime ? ` type="${escapeAttr(mime)}"` : '';
    return `<link rel="icon"${type} href="${escapeAttr(href)}">`;
};
```

- [ ] **Step 5: Implement the page half in `brand.ts`**

1. Replace the file's header comment (everything above `const HEAD_CLOSE = '</head>';`) with:

```ts
// Optional brand override for the exported viewer.
//
// The stock viewer identifies itself as SuperSplat in four places: the
// document <title>, the overlay badge (`.sse-viewerBranding`, only revealed
// when the viewer is embedded cross-origin), the info panel's header
// (`.sse-viewerTitle`) and, by omission, a missing favicon. The export server
// passes the operator brand (VIEWER_BRAND_*) and, for an S3 publish, a client
// brand; the brand RULES (brand-rules.ts) are applied by the page itself on
// every load, so the operator's other application can rename a published
// scene, change its images, or switch it between operator and client mode by
// rewriting the three client metas in its index.html. See
// docs/superpowers/specs/2026-10-09-runtime-brand-switch-design.md.
//
// Two halves:
//   - injectBrand patches the page: the export-time <title>, the <style>
//     block, the export-time favicon link, the three client metas, and the
//     brand runtime script: a synchronous inline script that, during head
//     parsing, resolves the operator brand baked into it against the metas,
//     sets document.title and the favicon, and leaves the badge and panel
//     markup in window.__brandUi.
//   - injectBrandJs patches index.js (supersplat-viewer >= 1.32 builds that
//     markup from `var uiHtml = "…"`): each brand surface becomes a
//     __brandPart splice reading window.__brandUi. No brand value is ever
//     written into index.js.
//
// Environment-agnostic (compiled for the export server via dist-shared):
// string operations only.

import { brandFragments, resolveBrandView, type BrandClient, type BrandOperator } from './brand-rules';
import { faviconLinkTag } from './favicon';
```

2. Replace the `DOC_TITLE` comment and constant with:

```ts
// The stock <title>, replaced by the name resolved at export time. Link
// previews and crawlers that do not run scripts keep seeing that value.
const STOCK_NAME = 'SuperSplat Viewer';
const DOC_TITLE = `<title>${STOCK_NAME}</title>`;

// The contract with the operator's other application: it may rewrite these
// metas' content at any time; empty or missing means not set.
export const BRAND_CLIENT_METAS = {
    name: 'brand-client-name',
    icon: 'brand-client-icon',
    logo: 'brand-client-logo'
} as const;
```

3. Replace the `BrandInjection` type (and its comments) with:

```ts
export type BrandInput = {
    // Baked into the page's runtime script; never rewritten after export.
    operator: BrandOperator;
    // Pre-filled into the client metas.
    client: BrandClient;
};
```

4. Replace `hasBrand` and the whole `injectBrand` function (and its leading comment) with:

```ts
const hasBrand = (brand: BrandInput): boolean => {
    const operator = brand.operator || {};
    const client = brand.client || {};
    return [operator.name, operator.iconHref, operator.logoHref, client.name, client.iconUrl, client.logoUrl]
    .some(value => !!(value ?? '').trim());
};

// The operator brand as a JS object literal for an inline <script>. JSON is
// valid JS; `<` is escaped so no value (a name is free text) can close the
// script element or open an HTML comment.
const scriptJson = (value: unknown): string => JSON.stringify(value).split('<').join(`${BACKSLASH}u003c`);

// The brand runtime script. Classic and synchronous, so it runs during head
// parsing, before first paint and before the deferred index.js evaluates
// uiHtml. Wrapped in try/catch: on any failure window.__brandUi stays unset and
// every __brandPart splice renders its stock markup.
//
// BUILD TRAP: no backslash escapes and no backticks in this template other
// than the ${} injections.
const runtimeScript = (operator: BrandOperator): string => `
(function () {
  try {
    var resolveBrandView = ${resolveBrandView.toString()};
    var brandFragments = ${brandFragments.toString()};
    var operator = ${scriptJson(operator || {})};
    var meta = function (name) {
      var el = document.querySelector('meta[name="' + name + '"]');
      return el ? el.getAttribute('content') || '' : '';
    };
    var view = resolveBrandView(operator, {
      name: meta(${JSON.stringify(BRAND_CLIENT_METAS.name)}),
      iconUrl: meta(${JSON.stringify(BRAND_CLIENT_METAS.icon)}),
      logoUrl: meta(${JSON.stringify(BRAND_CLIENT_METAS.logo)})
    });
    document.title = view && view.name ? view.name : ${JSON.stringify(STOCK_NAME)};
    var link = document.querySelector('link[rel="icon"]');
    if (view && view.iconHref) {
      if (!link) {
        link = document.createElement('link');
        link.setAttribute('rel', 'icon');
        document.head.appendChild(link);
      }
      link.setAttribute('href', view.iconHref);
      if (view.iconMime) {
        link.setAttribute('type', view.iconMime);
      } else {
        link.removeAttribute('type');
      }
    } else if (link) {
      link.parentNode.removeChild(link);
    }
    if (view) {
      window.__brandUi = brandFragments(view);
    }
  } catch (e) {
    console.warn('brand: runtime failed; the viewer keeps its stock branding', e);
  }
})();
`;

// The page half of the override.
export const injectBrand = (html: string, brand: BrandInput): string => {
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

    // The export-time view: what the page shows before (and, for clients that
    // do not run scripts, instead of) the runtime script's own resolution.
    const view = resolveBrandView(brand.operator, brand.client);
    let out = html;
    if (view && view.name) {
        out = replaceOnce(out, DOC_TITLE, `<title>${escapeHtml(view.name)}</title>`, 'the document title');
    }

    const client = brand.client || {};
    const metas = [
        [BRAND_CLIENT_METAS.name, client.name],
        [BRAND_CLIENT_METAS.icon, client.iconUrl],
        [BRAND_CLIENT_METAS.logo, client.logoUrl]
    ].map(([name, value]) => `<meta name="${name}" content="${escapeHtml((value ?? '').trim())}">`);

    // The favicon link comes before the runtime script so the script finds it
    // rather than adding a second one. The style block lands after the
    // viewer's own ./index.css link and wins the cascade at equal specificity.
    const block = [
        MARKER,
        STYLE,
        ...(view && view.iconHref ? [faviconLinkTag(view.iconHref, view.iconMime || undefined)] : []),
        ...metas,
        `<script id="brandRuntime">${runtimeScript(brand.operator)}</script>`
    ].join('\n        ');

    // Re-read </head>: the title replacement may have moved it.
    const end = out.indexOf(HEAD_CLOSE);
    return `${out.slice(0, end)}        ${block}\n    ${out.slice(end)}`;
};
```

5. Confirm nothing else in `brand.ts` still references `BrandInjection`, `NAME_`, or `injectFaviconLink` (Bash): `grep -n "BrandInjection\|NAME_TOKEN\|NAME_VAR\|injectFaviconLink" src/viewer-companion/brand.ts` must print nothing.

- [ ] **Step 6: Wire the export core**

In `src/splat-export-core.ts`:

1. Replace the two import lines

```ts
import { injectBrand, injectBrandJs, type BrandInjection } from './viewer-companion/brand';
```
and
```ts
import { injectFaviconLink } from './viewer-companion/favicon';
```
with

```ts
import { injectBrand, injectBrandJs, type BrandInput } from './viewer-companion/brand';
```

2. Replace the comment block above `type Brand`, the `type Brand`, and `applyBrand` with:

```ts
// Optional brand for ZIP exports, from the export server: the operator brand
// (VIEWER_BRAND_*; its icon and logo are `files`, embedded beside index.html,
// and ship with every branded export so a published scene can always switch
// back to operator mode) and, for an S3 publish, the client brand (hotlinked
// URLs), pre-filled into the page's client metas. The page applies the brand
// rules itself on every load (viewer-companion/brand-rules.ts). The browser
// never passes a brand, so local exports keep the stock SuperSplat branding.
// Every memFs entry is zipped by the callers below, and the S3 publish path
// uploads every ZIP entry, so this one insertion point serves package,
// streaming and publish alike.
//
// The server reaches writeViewerCore through an untyped dynamic import of
// dist-shared: keep this shape in step with ResolvedBrand there.
type Brand = BrandInput & {
    files: { filename: string; data: Uint8Array }[];
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
        memFs.results.set('index.js', new TextEncoder().encode(injectBrandJs(new TextDecoder().decode(rawJs))));
    } else {
        console.warn('brand: no index.js in the export; the badge and info panel keep the stock branding');
    }
    return injectBrand(html, brand);
};
```

- [ ] **Step 7: Run tests to verify they pass**

Run (PowerShell): `npx vitest run test/brand-runtime.test.ts test/brand-injection.test.ts test/favicon-injection.test.ts test/viewer-html-anchors.test.ts test/brand-rules.test.ts > $env:TEMP\brand-page.txt 2>&1`, then read the file.
Expected: PASS.

Then (Bash) the build trap check on the runtime template: `sed -n '/^const runtimeScript/,/^})();$/p' src/viewer-companion/brand.ts | grep -c '\\'` must print `0`.

Then (PowerShell): `node scripts/build-shared.mjs > $env:TEMP\shared.txt 2>&1`, read it. Expected: no errors (tsc over the shared core, which now includes `brand-rules.ts`).

Note: the server's GPU brand tests and `brand-resolve.test.ts` now fail against the new core shape until Task 4. Do not run the server suite here.

- [ ] **Step 8: Commit**

```bash
git add src/viewer-companion/brand.ts src/viewer-companion/favicon.ts src/splat-export-core.ts test/brand-runtime-stub.ts test/brand-runtime.test.ts test/brand-injection.test.ts test/favicon-injection.test.ts test/viewer-html-anchors.test.ts
git commit -m "Resolve the brand in the page from client metas at load time"
```

---

### Task 4: Server — pass operator + client through, ship operator files always; README; full gates

**Files:**
- Modify: `server/src/brand-resolve.ts` (header comment, `ResolvedBrand`, `resolveBrand`)
- Modify: `server/test/brand-resolve.test.ts` (the `describe('resolveBrand', …)` block)
- Modify: `server/test/ui-html.ts` (copy of the root helper)
- Create: `server/test/brand-runtime-stub.ts` (copy of the root helper)
- Modify: `server/test/brand-zip.gpu.test.ts`
- Modify: `server/README.md` (brand bullets)
- Modify: `server/src/run-export.ts:286-290` (comment only)

**Interfaces:**
- Consumes: the export core `brand` option `{ files, operator, client }` (Task 3); `renderUiHtml(js, ui)`, `runBrandRuntime`, `rewriteClientMeta` (Tasks 2-3 helpers, copied).
- Produces:
  ```ts
  export type ResolvedBrand = {
      files: { filename: string; data: Uint8Array }[];
      operator: { name?: string; iconHref?: string; iconMime?: string; logoHref?: string; url?: string };
      client: BrandOverride;
  };
  export const resolveBrand: (env: EnvBrand | null, override?: BrandOverride) => ResolvedBrand | null;
  ```

- [ ] **Step 1: Copy the test helpers into the server suite**

(Bash)

```bash
{ echo '// Copy of test/ui-html.ts (the server suite does not import root tests).'; cat test/ui-html.ts; } > server/test/ui-html.ts
{ echo '// Copy of test/brand-runtime-stub.ts (the server suite does not import root tests).'; cat test/brand-runtime-stub.ts; } > server/test/brand-runtime-stub.ts
```

- [ ] **Step 2: Write the failing tests**

In `server/test/brand-resolve.test.ts`, replace the whole `describe('resolveBrand', () => { … });` block with:

```ts
describe('resolveBrand', () => {
    const OPERATOR = { name: 'Acme', iconHref: './brand-icon.png', iconMime: 'image/png', logoHref: './brand-logo.svg', url: 'https://acme.example/' };
    const FILES = [{ filename: 'brand-icon.png', data: ICON.data }, { filename: 'brand-logo.svg', data: LOGO.data }];

    it('returns null with no brand anywhere', () => {
        expect(resolveBrand(null)).toBeNull();
        expect(resolveBrand(null, {})).toBeNull();
        expect(resolveBrand({ name: null, icon: null, logo: null, url: 'https://acme.example/' })).toBeNull();
    });

    it('env only: embeds the operator assets, passes the operator through, no client', () => {
        expect(resolveBrand(ENV)).toEqual({ files: FILES, operator: OPERATOR, client: {} });
    });

    it('a full client brand still embeds every operator asset (for the switch back)', () => {
        const client = { name: 'Client Co', iconUrl: C_ICON, logoUrl: C_LOGO };
        expect(resolveBrand(ENV, client)).toEqual({ files: FILES, operator: OPERATOR, client });
    });

    it('passes partial client brands through unresolved (the page applies the rules)', () => {
        expect(resolveBrand(ENV, { name: 'Client Co' })!.client).toEqual({ name: 'Client Co' });
        expect(resolveBrand(ENV, { logoUrl: C_LOGO })!.client).toEqual({ logoUrl: C_LOGO });
    });

    it('omits operator fields the env does not configure', () => {
        expect(resolveBrand({ ...ENV, logo: null, url: null })).toEqual({
            files: [{ filename: 'brand-icon.png', data: ICON.data }],
            operator: { name: 'Acme', iconHref: './brand-icon.png', iconMime: 'image/png' },
            client: {}
        });
    });

    it('a client brand with no env brand at all', () => {
        expect(resolveBrand(null, { logoUrl: C_LOGO })).toEqual({ files: [], operator: {}, client: { logoUrl: C_LOGO } });
    });
});
```

Replace the whole of `server/test/brand-zip.gpu.test.ts` with:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { probeGpu, createGpuSession } from '../src/gpu.js';
import { runExport, type RunResult } from '../src/run-export.js';
import { rewriteClientMeta, runBrandRuntime } from './brand-runtime-stub.js';
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
        expect(html).toContain('<title>Acme</title>');
        expect(html).not.toContain('data-brand-name');
        expect(html).toContain('<link rel="icon" type="image/png" href="./brand-icon.png">');
        expect(html).toContain('<style id="brandStyle">');
        expect(html).toContain('<meta name="brand-client-name" content="">');
        expect(html).toContain('<script id="brandRuntime">');

        const js = zipReadEntry(zip, 'index.js').toString('utf8');
        // Proves the handle-publish patch (viewer-engine-patch.ts) ran AFTER
        // branding on the same memFs 'index.js' entry.
        expect(js).toContain('window.__supersplatViewer = viewer;');
        expect(js).toContain('var __brandPart = ');
        expect(js).not.toContain('Acme');

        const r = runBrandRuntime(html);
        expect(r.title).toBe('Acme');
        const ui = renderUiHtml(js, r.ui);
        expect(ui).toContain('<a class="sse-viewerBranding sse-hidden" title="Acme" target="_blank" rel="noopener noreferrer">');
        expect(ui).toContain('<img id="brandBadgeIcon" src="./brand-icon.png" alt="" />');
        expect(ui).toContain('<a class="sse-viewerTitle" href="https://acme.example/" target="_blank" rel="noopener noreferrer">');
        expect(ui).toContain('<img id="brandTitleLogo" src="./brand-logo.png" alt="Acme" />');
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

    it('hotlinks a client brand, ships the operator files, and switches back via the metas', () => {
        if (!gpu) return;
        const zip = Buffer.from(client!.files[0].data);
        // operator files ship even in client mode, for the switch back
        expect(Uint8Array.from(zipReadEntry(zip, 'brand-icon.png'))).toEqual(ICON);
        expect(Uint8Array.from(zipReadEntry(zip, 'brand-logo.png'))).toEqual(LOGO);
        // client URLs are never fetched by the server
        expect(fetched).not.toContain(CLIENT.iconUrl);
        expect(fetched).not.toContain(CLIENT.logoUrl);

        const html = zipReadEntry(zip, 'index.html').toString('utf8');
        expect(html).toContain('<title>Client Co</title>');
        expect(html).toContain('<link rel="icon" href="https://cdn.example/client/icon.png">');
        expect(html).toContain('<meta name="brand-client-name" content="Client Co">');
        expect(html).toContain('<meta name="brand-client-icon" content="https://cdn.example/client/icon.png">');
        expect(html).toContain('<meta name="brand-client-logo" content="https://cdn.example/client/logo.png">');

        const js = zipReadEntry(zip, 'index.js').toString('utf8');
        expect(js).not.toContain('Client Co');

        const r = runBrandRuntime(html);
        expect(r.title).toBe('Client Co');
        const ui = renderUiHtml(js, r.ui);
        expect(ui).toContain('<div class="sse-viewerBranding sse-hidden" title="Client Co">');
        expect(ui).toContain('<img id="brandBadgeIcon" src="https://cdn.example/client/icon.png" alt="" />');
        expect(ui).toContain('<div class="sse-viewerTitle">');
        expect(ui).toContain('<img id="brandTitleLogo" src="https://cdn.example/client/logo.png" alt="Client Co" />');
        expect(ui).toContain('Powered by <a href="https://acme.example/" target="_blank" rel="noopener noreferrer">Acme</a>');
        expect(ui).not.toContain('github.com/playcanvas/supersplat-viewer');

        // What the other application does to switch the scene back.
        let back = rewriteClientMeta(html, 'brand-client-name', '');
        back = rewriteClientMeta(back, 'brand-client-icon', '');
        back = rewriteClientMeta(back, 'brand-client-logo', '');
        const b = runBrandRuntime(back);
        expect(b.title).toBe('Acme');
        expect(b.favicon).toEqual({ rel: 'icon', type: 'image/png', href: './brand-icon.png' });
        const backUi = renderUiHtml(js, b.ui);
        expect(backUi).toContain('<a class="sse-viewerTitle" href="https://acme.example/" target="_blank" rel="noopener noreferrer">');
        expect(backUi).toContain('<img id="brandTitleLogo" src="./brand-logo.png" alt="Acme" />');
        expect(backUi).not.toContain('Powered by');
    });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run (PowerShell): `npm --prefix server test -- test/brand-resolve.test.ts > $env:TEMP\srv-brand.txt 2>&1`, then read the file.
Expected: FAIL in `resolveBrand` (still returns `{ files, injection }`).

- [ ] **Step 4: Implement `resolveBrand`**

In `server/src/brand-resolve.ts`, replace everything from the top of the file through the end of `resolveBrand` (keep `NAME_MAX` onwards and `validateBrandOverride` unchanged) with:

```ts
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
```

In `server/src/run-export.ts`, replace the comment above `const brand = resolveBrand(…)` with:

```ts
    // Operator brand (VIEWER_BRAND_*) plus the S3 publish's client brand, ZIP
    // exports only: null when nothing is configured, in which case the export
    // keeps the stock viewer. The page applies the brand rules itself. Each
    // operator asset that cannot be fetched drops out on its own.
```

- [ ] **Step 5: Update the README**

In `server/README.md`:

1. In the `VIEWER_BRAND_NAME` bullet, replace `` becomes the document title (`<title data-brand-name>Acme</title>`), `` with `becomes the document title,`.

2. Replace the bullet that starts `  - The name lives only in \`<title data-brand-name>\`` (through `full client pair (or know which brand each scene used).`) with:

```markdown
  - The rules are applied **by the published page itself, on every load**, from three
    metas in its `index.html`, pre-filled from the publish dialog:

    ```html
    <meta name="brand-client-name" content="Client Co">
    <meta name="brand-client-icon" content="https://cdn.example/icon.png">
    <meta name="brand-client-logo" content="https://cdn.example/logo.png">
    ```

    To rename a published scene, change its images, or switch it between operator and
    client mode, rewrite their `content` (empty or missing = not set; icon and logo must be
    absolute `https` URLs, anything else is ignored) and re-upload `index.html` with the
    same content type and ACL. Nothing else needs rewriting: the operator brand is baked
    into the page, and its icon and logo files ship with every branded export, client mode
    included.
  - The page sets the tab title and the favicon itself, before first paint. The static
    `<title>` and favicon link keep the values resolved at publish time, so link previews
    and crawlers that do not run scripts show those.
  - Scenes published before this change (with `<title data-brand-name>`) carry no metas
    and must be republished to become switchable.
```

- [ ] **Step 6: Run the server tests**

Run (PowerShell): `npm --prefix server test > $env:TEMP\srv-tests.txt 2>&1`, then read the file (this rebuilds `dist-shared` first).
Expected: PASS, including `brand-resolve.test.ts`, `publish-routes.test.ts` and, on a machine with a GPU, `brand-zip.gpu.test.ts`. If the GPU tests are skipped ("No GPU available"), say so in the report: the wiring is then only covered by the root tests.

- [ ] **Step 7: Full gates**

Run each (PowerShell), reading every output file:
- `npm run test > $env:TEMP\root-tests.txt 2>&1` → all pass.
- `npm run lint > $env:TEMP\lint.txt 2>&1` → no errors.
- `npm --prefix server run build > $env:TEMP\srv-build.txt 2>&1` → no `tsc` errors.
- `npm run build > $env:TEMP\build.txt 2>&1` → then (Bash) `grep -c "plugin typescript" "$TEMP/build.txt"` prints `0`.

Then (Bash) the name guard: `git grep -n -i "data-brand-name" -- src server/src` prints nothing.

- [ ] **Step 8: Commit**

```bash
git add server/src/brand-resolve.ts server/src/run-export.ts server/test/brand-resolve.test.ts server/test/ui-html.ts server/test/brand-runtime-stub.ts server/test/brand-zip.gpu.test.ts server/README.md
git commit -m "Pass operator and client brands through for runtime resolution"
```

---

### Manual E2E (operator, after Task 4)

1. Start the export server (`npm --prefix server run dev`) with the `VIEWER_BRAND_*` env set, publish a scene to S3 with no client brand: operator title, favicon, linked panel header with the operator logo.
2. In the bucket, edit that scene's `index.html`: set the three `brand-client-*` metas to a client name, icon URL and logo URL; keep content type and ACL. Reload: client title and favicon, badge and header not linked, client logo, "Powered by".
3. Empty the three metas, reload: operator mode again, operator icon and logo load (from the files shipped with the publish).
4. Chrome and Firefox, Network tab, after each switch: no request for the previous favicon, and no visible flash of the old title. (Browser favicon-fetch timing is the one unverified assumption of the design.)
