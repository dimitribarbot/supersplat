# Server-side Favicon for Exported Viewers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a self-hosted export server embed its own favicon into every ZIP viewer export (`packageViewer`, both the plain and the streaming sub-path, including the S3 publish that reuses it), configured by a single URL in `server/.env.local`.

**Architecture:** The server reads a new `VIEWER_FAVICON_URL` env var, fetches the icon once per export (5 s timeout, 1 MiB cap, six-entry MIME allow-list) and hands the *bytes* down to the shared export core as a new trailing optional parameter — exactly how `posterBytes` already travels. The core writes `favicon.<ext>` into the in-memory FS that becomes the ZIP and injects `<link rel="icon" …>` before `</head>`. The browser call site is untouched, so local exports are unaffected *by construction*, not by a flag. Any fetch failure warns and exports without an icon.

**Tech Stack:** TypeScript, Node 20+ (`fetch`, `AbortSignal.timeout`), Fastify export server, `@playcanvas/splat-transform` writers, Vitest (root + `server/`).

**Design spec:** `docs/superpowers/specs/2026-07-25-server-favicon-exported-viewer-design.md` — read it first.

## Global Constraints

- **Never fail an export over the icon.** Every failure path (unset, malformed URL, non-http, 404, timeout, wrong type, oversize, empty, missing `</head>`) is a `console.warn` + carry on. `loadFavicon` never throws.
- **Env var name, verbatim:** `VIEWER_FAVICON_URL`. Absolute `http`/`https` URL.
- **Fetch limits, verbatim:** timeout `5000` ms; max size `1024 * 1024` bytes.
- **MIME allow-list, verbatim and exhaustive:** `image/png`→`png`, `image/x-icon`→`ico`, `image/vnd.microsoft.icon`→`ico`, `image/svg+xml`→`svg`, `image/jpeg`→`jpg`, `image/webp`→`webp`, `image/gif`→`gif`. Nothing else is ever emitted.
- **The configured URL is never interpolated into HTML.** The `href` is always the derived `./favicon.<ext>`.
- **Unset var ⇒ zero behaviour change** on every path: local exports, `htmlViewer`, `sog`, `ply`, `compressedPly`, `splat`.
- **`src/viewer-companion/*` and `src/splat-export-core.ts` stay environment-agnostic** — no `process`, no `fetch`, no Node imports. They compile to `dist-shared/` for the server *and* into the browser bundle.
- **Import style:** inside `src/`, relative imports carry **no** `.js` extension (`scripts/build-shared.mjs` appends it). Inside `server/src/` and `server/test/`, they **do** (`'./favicon.js'`).
- **Code style:** 4-space indent, arrow-function consts, explanatory comment header at the top of each new module (see `src/viewer-companion/poster.ts` for the house style). Do not reorder imports anywhere — ESLint 10 crashes on `import/order` autofix (project memory).
- **Running tests:** run test commands in the **foreground**, never backgrounded or piped into `grep` (vitest hangs under a pipe — project memory). Root tests run from the repo root; server tests run from `server/` (its `pretest` rebuilds `dist-shared/`).

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/viewer-companion/favicon.ts` (create) | Pure string injector: put a `<link rel="icon">` before `</head>`. Environment-agnostic, unit-testable. | 1 |
| `test/favicon-injection.test.ts` (create) | Unit tests for the injector (no GPU, no build). | 1 |
| `server/src/favicon.ts` (create) | The only module that knows the env var and the network: read, fetch, validate, name. | 2 |
| `server/test/favicon.test.ts` (create) | Unit tests for `loadFavicon` with a stubbed `fetch`. | 2 |
| `src/splat-export-core.ts` (modify) | Thread `favicon` into both ZIP paths; write the file into `memFs`; call the injector. | 3 |
| `server/src/run-export.ts` (modify) | Call `loadFavicon()` in the `packageViewer` branch and pass it down. | 3 |
| `server/test/favicon-zip.gpu.test.ts` (create) | GPU integration: a real package ZIP *and* a real streaming ZIP contain `favicon.png` + the link. | 3 |
| `server/src/s3.ts` (modify) | Teach the publish upload the new content types (`ico`, `svg`, `gif`, `jpg`, `jpeg`). | 4 |
| `server/test/s3.test.ts` (modify) | Assert the new content types. | 4 |
| `server/README.md`, `server/.env.local.example` (modify) | Document the var. | 5 |

**One refinement of the spec, decided while planning:** the spec placed the `<head>` string work in `src/viewer-companion/favicon.ts` and the `memFs` write in a private `applyFavicon` inside `src/splat-export-core.ts`. That split is kept exactly — it mirrors `injectPoster` (pure, in `viewer-companion/`) versus `applyPoster` (`memFs`-aware, in the core, `splat-export-core.ts:71`). Do not move the `memFs` write into `viewer-companion/`: those modules are pure string builders.

---

### Task 1: Pure favicon `<head>` injector

**Files:**
- Create: `src/viewer-companion/favicon.ts`
- Test: `test/favicon-injection.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `injectFaviconLink(html: string, href: string, mime: string): string` — returns `html` with `<link rel="icon" type="<mime>" href="<href>">` inserted immediately before the first `</head>`. Returns the input unchanged (plus a `console.warn`) when there is no `</head>`, or when the document already contains a `rel="icon"` link.

- [ ] **Step 1: Write the failing test**

Create `test/favicon-injection.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

import { injectFaviconLink } from '../src/viewer-companion/favicon';

// Minimal stand-in for the exported viewer's <head> as writeHtml emits it:
// a title, no icon link of any kind (which is the whole reason this exists).
const HTML = `<html>
    <head>
        <title>SuperSplat Viewer</title>
        <meta charset="UTF-8">
        <link rel="stylesheet" href="./index.css">
    </head><body><div id="poster"></div></body></html>`;

describe('injectFaviconLink', () => {
    it('injects the icon link before </head>', () => {
        const out = injectFaviconLink(HTML, './favicon.png', 'image/png');
        expect(out).toContain('<link rel="icon" type="image/png" href="./favicon.png">');
        expect(out.indexOf('rel="icon"')).toBeLessThan(out.indexOf('</head>'));
    });

    it('leaves the rest of the document intact', () => {
        const out = injectFaviconLink(HTML, './favicon.svg', 'image/svg+xml');
        expect(out).toContain('<title>SuperSplat Viewer</title>');
        expect(out).toContain('<link rel="stylesheet" href="./index.css">');
        expect(out).toContain('type="image/svg+xml"');
        expect(out).toContain('<body><div id="poster"></div></body>');
    });

    it('is idempotent (a second pass adds no second link)', () => {
        const once = injectFaviconLink(HTML, './favicon.png', 'image/png');
        const twice = injectFaviconLink(once, './favicon.ico', 'image/x-icon');
        expect(twice).toBe(once);
        expect(twice.match(/rel="icon"/g)).toHaveLength(1);
    });

    it('returns HTML without </head> unchanged (soft no-op on upstream drift)', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const html = '<html><body>no head here</body></html>';
        expect(injectFaviconLink(html, './favicon.png', 'image/png')).toBe(html);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from the repo root:

```bash
npx vitest run test/favicon-injection.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/viewer-companion/favicon"`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/viewer-companion/favicon.ts`:

```typescript
// Favicon injection for the exported viewer.
//
// The stock viewer's <head> (from splat-transform's writeHtml) carries a title
// and no icon link at all, so a browser showing an exported viewer asks the
// hosting origin for /favicon.ico and falls back to a blank tab icon. When the
// export server is configured with VIEWER_FAVICON_URL it fetches that icon,
// embeds a copy beside index.html in the ZIP, and injects the link below.
//
// The href is always an export-derived relative filename (favicon.<ext>, from a
// fixed MIME allow-list) — never the configured URL — so no operator- or
// network-supplied string is interpolated into the document.
//
// Environment-agnostic (compiled for the export server via dist-shared):
// string operations only.

const HEAD_CLOSE = '</head>';

// Injecting twice would produce two competing icon links; the marker makes the
// injection idempotent (mirrors the other companions' soft no-op posture).
const ICON_MARKER = 'rel="icon"';

export const injectFaviconLink = (html: string, href: string, mime: string): string => {
    if (html.includes(ICON_MARKER)) {
        return html;
    }
    if (!html.includes(HEAD_CLOSE)) {
        console.warn('favicon: exported viewer HTML has no </head>; skipping the icon link');
        return html;
    }
    const tag = `<link rel="icon" type="${mime}" href="${href}">`;
    // Function replacement: a literal one would treat $-sequences in the tag as
    // capture references. Replaces the first </head> only, which is the head's.
    return html.replace(HEAD_CLOSE, () => `        ${tag}\n    ${HEAD_CLOSE}`);
};
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run test/favicon-injection.test.ts
```

Expected: PASS — 4 passed.

- [ ] **Step 5: Lint**

```bash
npm run lint
```

Expected: exit 0, no output. (If ESLint reports `import/order`, leave the order alone — do not autofix; see Global Constraints.)

- [ ] **Step 6: Commit**

```bash
git add src/viewer-companion/favicon.ts test/favicon-injection.test.ts
git commit -m "feat: pure <head> favicon link injector for exported viewers"
```

---

### Task 2: Server-side favicon loader (`VIEWER_FAVICON_URL`)

**Files:**
- Create: `server/src/favicon.ts`
- Test: `server/test/favicon.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (independent).
- Produces:
  - `export type Favicon = { filename: string; mime: string; data: Uint8Array }`
  - `export const loadFavicon = async (): Promise<Favicon | null>` — reads `process.env.VIEWER_FAVICON_URL` **at call time** (not at module load, so tests just set/delete the var), returns the fetched icon or `null`. Never throws.

- [ ] **Step 1: Write the failing test**

Create `server/test/favicon.test.ts`:

```typescript
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { loadFavicon } from '../src/favicon.js';

const URL_PNG = 'https://icons.example.com/brand.png';
const ICON = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

// Minimal Response stand-in: loadFavicon only touches ok/status/statusText/
// headers.get('content-type')/arrayBuffer().
const response = (opts: { ok?: boolean; status?: number; statusText?: string; contentType?: string | null; body?: Uint8Array } = {}) => ({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.statusText ?? 'OK',
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? (opts.contentType ?? null) : null) },
    arrayBuffer: async () => {
        const b = opts.body ?? ICON;
        return b.slice().buffer;
    }
});

const stubFetch = (impl: (url: string) => any) => {
    const fn = vi.fn(async (url: any) => impl(String(url)));
    vi.stubGlobal('fetch', fn);
    return fn;
};

beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    delete process.env.VIEWER_FAVICON_URL;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('loadFavicon', () => {
    it('returns null and never fetches when the var is unset', async () => {
        const fetchFn = stubFetch(() => response());
        expect(await loadFavicon()).toBeNull();
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('returns null when the var is empty or whitespace', async () => {
        process.env.VIEWER_FAVICON_URL = '   ';
        const fetchFn = stubFetch(() => response());
        expect(await loadFavicon()).toBeNull();
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('fetches and names the icon from its content type', async () => {
        process.env.VIEWER_FAVICON_URL = URL_PNG;
        stubFetch(() => response({ contentType: 'image/png' }));
        expect(await loadFavicon()).toEqual({ filename: 'favicon.png', mime: 'image/png', data: ICON });
    });

    it('tolerates a charset parameter and odd casing in the content type', async () => {
        process.env.VIEWER_FAVICON_URL = URL_PNG;
        stubFetch(() => response({ contentType: 'IMAGE/PNG; charset=binary' }));
        expect((await loadFavicon())!.filename).toBe('favicon.png');
    });

    it('maps the Microsoft icon type to a .ico filename', async () => {
        process.env.VIEWER_FAVICON_URL = 'https://icons.example.com/brand.icon';
        stubFetch(() => response({ contentType: 'image/vnd.microsoft.icon' }));
        const fav = await loadFavicon();
        expect(fav!.filename).toBe('favicon.ico');
        expect(fav!.mime).toBe('image/vnd.microsoft.icon');
    });

    it('falls back to the URL extension when no content type is sent', async () => {
        process.env.VIEWER_FAVICON_URL = 'https://icons.example.com/brand.svg?v=2';
        stubFetch(() => response({ contentType: null }));
        expect(await loadFavicon()).toEqual({ filename: 'favicon.svg', mime: 'image/svg+xml', data: ICON });
    });

    it('returns null on a non-2xx response', async () => {
        process.env.VIEWER_FAVICON_URL = URL_PNG;
        stubFetch(() => response({ ok: false, status: 404, statusText: 'Not Found' }));
        expect(await loadFavicon()).toBeNull();
    });

    it('returns null for a non-image type with no usable URL extension', async () => {
        process.env.VIEWER_FAVICON_URL = 'https://icons.example.com/brand';
        stubFetch(() => response({ contentType: 'text/html' }));
        expect(await loadFavicon()).toBeNull();
    });

    it('returns null when the icon exceeds the 1 MiB cap', async () => {
        process.env.VIEWER_FAVICON_URL = URL_PNG;
        stubFetch(() => response({ contentType: 'image/png', body: new Uint8Array(1024 * 1024 + 1) }));
        expect(await loadFavicon()).toBeNull();
    });

    it('returns null on an empty body', async () => {
        process.env.VIEWER_FAVICON_URL = URL_PNG;
        stubFetch(() => response({ contentType: 'image/png', body: new Uint8Array(0) }));
        expect(await loadFavicon()).toBeNull();
    });

    it('returns null (without fetching) for a non-http URL', async () => {
        process.env.VIEWER_FAVICON_URL = 'file:///C:/icons/brand.png';
        const fetchFn = stubFetch(() => response({ contentType: 'image/png' }));
        expect(await loadFavicon()).toBeNull();
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('returns null (without fetching) for a malformed URL', async () => {
        process.env.VIEWER_FAVICON_URL = 'not a url';
        const fetchFn = stubFetch(() => response({ contentType: 'image/png' }));
        expect(await loadFavicon()).toBeNull();
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('returns null when the fetch rejects (timeout, DNS failure)', async () => {
        process.env.VIEWER_FAVICON_URL = URL_PNG;
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('The operation was aborted due to timeout'); }));
        expect(await loadFavicon()).toBeNull();
    });

    it('warns on every failure so a misconfiguration is visible in the log', async () => {
        process.env.VIEWER_FAVICON_URL = URL_PNG;
        stubFetch(() => response({ ok: false, status: 500, statusText: 'Server Error' }));
        await loadFavicon();
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(URL_PNG));
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `server/`:

```bash
npm test -- favicon
```

Expected: FAIL — cannot resolve `../src/favicon.js`.

(`npm test` triggers `pretest` → `build:shared`; that is expected and takes a few seconds. The `-- favicon` filters to matching test files.)

- [ ] **Step 3: Write the minimal implementation**

Create `server/src/favicon.ts`:

```typescript
// Optional favicon for ZIP viewer exports. See
// docs/superpowers/specs/2026-07-25-server-favicon-exported-viewer-design.md.
//
// The icon belongs to the deployment, not to a capture or an editing session,
// so it is configured once here (VIEWER_FAVICON_URL) rather than chosen per
// export in the editor: nothing about it crosses the client -> server boundary,
// so it cannot be set or spoofed per request.
//
// Fetch-and-embed rather than link-to-remote: the exported ZIP stays
// self-contained (works offline, behind a firewall, and after the source URL
// dies). A cosmetic asset must never cost the user a multi-minute GPU export,
// so every failure is a warning plus `null` — this function never throws.

export type Favicon = { filename: string; mime: string; data: Uint8Array };

const TIMEOUT_MS = 5000;
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

const skip = (url: string, reason: string): null => {
    console.warn(`favicon: ${reason} (${url}) - exporting without a favicon`);
    return null;
};

export const loadFavicon = async (): Promise<Favicon | null> => {
    const configured = process.env.VIEWER_FAVICON_URL?.trim();
    if (!configured) {
        return null;                    // not configured: the default, silent
    }
    try {
        let parsed: URL;
        try {
            parsed = new URL(configured);
        } catch {
            return skip(configured, 'VIEWER_FAVICON_URL is not a valid URL');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return skip(configured, `unsupported protocol "${parsed.protocol}" (use http or https)`);
        }

        const res = await fetch(configured, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) {
            return skip(configured, `fetch failed: ${res.status} ${res.statusText}`);
        }
        const data = new Uint8Array(await res.arrayBuffer());
        if (data.length === 0) {
            return skip(configured, 'fetched icon is empty');
        }
        if (data.length > MAX_BYTES) {
            return skip(configured, `fetched icon is ${data.length} bytes, over the ${MAX_BYTES} byte limit`);
        }

        // Content-Type decides; the URL's own extension is the fallback for
        // hosts that serve icons as octet-stream or send no type at all.
        const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        let mime = MIME_EXT[contentType] ? contentType : undefined;
        if (!mime) {
            const path = parsed.pathname;
            const dot = path.lastIndexOf('.');
            mime = dot < 0 ? undefined : EXT_MIME[path.slice(dot + 1).toLowerCase()];
        }
        if (!mime) {
            return skip(configured, `unsupported image type (content-type "${contentType || 'none'}")`);
        }

        return { filename: `favicon.${MIME_EXT[mime]}`, mime, data };
    } catch (err) {
        return skip(configured, `fetch failed: ${(err as Error).message}`);
    }
};
```

- [ ] **Step 4: Run the test to verify it passes**

From `server/`:

```bash
npm test -- favicon
```

Expected: PASS — 14 passed.

- [ ] **Step 5: Type-check the server**

From `server/`:

```bash
npx tsc --noEmit
```

Expected: exit 0, no output.

- [ ] **Step 6: Commit**

```bash
git add server/src/favicon.ts server/test/favicon.test.ts
git commit -m "feat: server-side VIEWER_FAVICON_URL loader for viewer exports"
```

---

### Task 3: Thread the favicon into both ZIP export paths

**Files:**
- Modify: `src/splat-export-core.ts` (import near `:28`; helper after `:85`; `writeStreamingViewerCore` signature `:639-650`; its injection chain `:760-764`; `writeViewerCore` signature `:809-821`; its streaming call `:868`; its package injection chain `:903-905`)
- Modify: `server/src/run-export.ts` (imports near `:13`; `packageViewer` branch `:218-223`)
- Test: `server/test/favicon-zip.gpu.test.ts` (create)

**Interfaces:**
- Consumes: `injectFaviconLink(html, href, mime)` from Task 1; `loadFavicon(): Promise<Favicon | null>` and `type Favicon = { filename: string; mime: string; data: Uint8Array }` from Task 2.
- Produces: `writeViewerCore(dataTable, viewerSettingsJson, viewerType, createDevice, fs, events?, onLog?, shouldCancel?, collision?, extraScenes?, posterBytes?, favicon?)` — one new trailing optional parameter, `favicon?: Favicon`. Same trailing parameter on the module-private `writeStreamingViewerCore`. No other signature changes.

**Note on line numbers:** they refer to the tree at plan time. Anchor your edits on the quoted code, not the numbers.

- [ ] **Step 1: Write the failing GPU integration test**

This is the test that proves the wiring end-to-end: a real export, a real ZIP, both sub-paths. Create `server/test/favicon-zip.gpu.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { probeGpu, createGpuSession } from '../src/gpu.js';
import { runExport, type RunResult } from '../src/run-export.js';
import { makePlyGz, zipEntryNames, zipReadEntry, experienceSettings } from './zip-helpers.js';

const ICON_URL = 'https://icons.example.com/brand.png';
const ICON = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);

describe('runExport packageViewer favicon (GPU)', () => {
    let gpu = false;
    let pkg: RunResult | undefined;
    let streaming: RunResult | undefined;

    beforeAll(async () => {
        gpu = (await probeGpu()).gpu;
        if (!gpu) return;
        process.env.VIEWER_FAVICON_URL = ICON_URL;
        // Serve the icon from a stub, but let any other fetch through: the
        // export pipeline must not be starved of a real fetch by this stub.
        const realFetch = globalThis.fetch;
        vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => {
            if (String(url) !== ICON_URL) return realFetch(url, init);
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'image/png' : null) },
                arrayBuffer: async () => ICON.slice().buffer
            };
        }));

        const plyGz = await makePlyGz(2048);
        const session = createGpuSession();
        try {
            const run = (streamingMode: boolean) => runExport({
                plyGz,
                options: {
                    fileType: 'packageViewer',
                    filename: 'out.zip',
                    viewerExportSettings: { type: 'zip', streaming: streamingMode, experienceSettings }
                },
                sink: { emit: () => {} },
                getDeviceCreator: session.getDeviceCreator
            });
            pkg = await run(false);
            streaming = await run(true);
        } finally {
            await session.dispose();
        }
    }, 300000);

    afterAll(() => {
        delete process.env.VIEWER_FAVICON_URL;
        vi.unstubAllGlobals();
    });

    const expectFavicon = (res: RunResult | undefined) => {
        const zip = Buffer.from(res!.files[0].data);
        expect(zipEntryNames(zip)).toContain('favicon.png');
        expect(Uint8Array.from(zipReadEntry(zip, 'favicon.png'))).toEqual(ICON);
        const html = zipReadEntry(zip, 'index.html').toString('utf8');
        expect(html).toContain('<link rel="icon" type="image/png" href="./favicon.png">');
        expect(html.indexOf('rel="icon"')).toBeLessThan(html.indexOf('</head>'));
    };

    it('embeds and links the favicon in a package ZIP', () => {
        if (!gpu) { console.warn('No GPU available; skipping favicon GPU test'); return; }
        expectFavicon(pkg);
    });

    it('embeds and links the favicon in a streaming ZIP', () => {
        if (!gpu) return;
        expectFavicon(streaming);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

From `server/`:

```bash
npm test -- favicon-zip
```

Expected: FAIL — both tests fail on `expect(zipEntryNames(zip)).toContain('favicon.png')` (the ZIP has no icon yet).

If the machine has no GPU, both tests pass vacuously with a `No GPU available` warning. That means this step cannot gate the task here — say so explicitly in the task report and rely on Step 8's manual E2E instead.

- [ ] **Step 3: Add the import and the `applyFavicon` helper to the shared core**

In `src/splat-export-core.ts`, next to the existing companion import (`:28`):

```typescript
import { injectPoster } from './viewer-companion/poster';
import { injectFaviconLink } from './viewer-companion/favicon';
```

Then, immediately after `applyPoster` ends (`:85`, the line `};` before the `injectAnnotationLinks` comment), insert:

```typescript
// Optional favicon for ZIP exports: the export server fetched the bytes from
// its VIEWER_FAVICON_URL and handed them down (the browser never does, so local
// exports carry no icon). Emit the file beside the viewer and point the injected
// <head> link at it. Mirrors applyPoster's memFs handling — every memFs entry is
// zipped by the callers below.
type Favicon = { filename: string; mime: string; data: Uint8Array };

const applyFavicon = (
    html: string,
    favicon: Favicon | undefined,
    memFs: { results: Map<string, Uint8Array> }
): string => {
    if (!favicon) {
        return html;
    }
    memFs.results.set(favicon.filename, favicon.data);
    return injectFaviconLink(html, `./${favicon.filename}`, favicon.mime);
};
```

- [ ] **Step 4: Thread the parameter through the streaming path**

In `src/splat-export-core.ts`, extend `writeStreamingViewerCore`'s parameter list (`:649`) — from:

```typescript
    extraScenes?: ExtraPortalScene[],
    posterBytes?: Uint8Array
): Promise<void> => {
```

to:

```typescript
    extraScenes?: ExtraPortalScene[],
    posterBytes?: Uint8Array,
    favicon?: Favicon
): Promise<void> => {
```

Then, in the same function's injection chain (`:764`), change:

```typescript
    memFs.results.set('index.html', new TextEncoder().encode(injectDeviceFallback(withPortals)));
```

to:

```typescript
    memFs.results.set('index.html', new TextEncoder().encode(applyFavicon(injectDeviceFallback(withPortals), favicon, memFs)));
```

- [ ] **Step 5: Thread the parameter through `writeViewerCore` and the package path**

In `src/splat-export-core.ts`, extend `writeViewerCore`'s parameter list (`:820`) — from:

```typescript
    extraScenes?: ExtraPortalScene[],
    posterBytes?: Uint8Array
): Promise<void> => {
```

to:

```typescript
    extraScenes?: ExtraPortalScene[],
    posterBytes?: Uint8Array,
    favicon?: Favicon
): Promise<void> => {
```

Forward it on the streaming delegation (`:868`) — from:

```typescript
            await writeStreamingViewerCore(dataTable, viewerSettingsJson, createDevice, fs, events, onLog, shouldCancel, collision, extraScenes, posterBytes);
```

to:

```typescript
            await writeStreamingViewerCore(dataTable, viewerSettingsJson, createDevice, fs, events, onLog, shouldCancel, collision, extraScenes, posterBytes, favicon);
```

And in the package branch (`:905`) — from:

```typescript
            memFs.results.set('index.html', new TextEncoder().encode(injected));
```

to:

```typescript
            memFs.results.set('index.html', new TextEncoder().encode(applyFavicon(injected, favicon, memFs)));
```

Leave the `html` branch (`:842-866`) alone: the single-file HTML export gets no favicon (out of scope), and `src/splat-serialize.ts:1502` — the browser's call — stays exactly as it is, which is what keeps local exports unchanged.

- [ ] **Step 6: Call the loader from the server's `packageViewer` branch**

In `server/src/run-export.ts`, add the import below the existing `progress.js` type import (`:13`):

```typescript
import { loadFavicon } from './favicon.js';
```

Then change the `packageViewer` tail (`:218-223`) — from:

```typescript
    // packageViewer
    const viewerType = options.viewerExportSettings!.streaming ? 'streaming' : 'package';
    const extraScenes = buildExtraScenes();
    await writeViewerCore(dataTable, options.viewerExportSettings!.experienceSettings, viewerType, createDevice, memFs, events, onLog, isCancelled, options.viewerExportSettings!.collision, extraScenes, posterBytes);
```

to:

```typescript
    // packageViewer
    const viewerType = options.viewerExportSettings!.streaming ? 'streaming' : 'package';
    const extraScenes = buildExtraScenes();
    // Deployment-configured favicon (VIEWER_FAVICON_URL), ZIP exports only:
    // null when unset or unreachable, in which case the export is unchanged.
    const favicon = await loadFavicon();
    await writeViewerCore(dataTable, options.viewerExportSettings!.experienceSettings, viewerType, createDevice, memFs, events, onLog, isCancelled, options.viewerExportSettings!.collision, extraScenes, posterBytes, favicon ?? undefined);
```

Do not touch the `htmlViewer` branch (`:210-216`).

- [ ] **Step 7: Run the GPU test to verify it passes, then the full suites**

From `server/` (the `pretest` rebuild of `dist-shared/` is what makes the core edits visible to the server):

```bash
npm test -- favicon-zip
```

Expected: PASS — 2 passed (or 2 passed with the `No GPU available` warning on a GPU-less machine, which proves nothing; see Step 2).

Then the full gates — from `server/`:

```bash
npm test
```

Expected: PASS. No previously-passing test regresses; with `VIEWER_FAVICON_URL` unset, every other export test sees byte-identical output to before.

From the repo root:

```bash
npx tsc --noEmit
npm run lint
npm run test
```

Expected: all three exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/splat-export-core.ts server/src/run-export.ts server/test/favicon-zip.gpu.test.ts
git commit -m "feat: embed the server's favicon in package and streaming ZIP exports"
```

---

### Task 4: Correct content types on the S3 publish path

**Files:**
- Modify: `server/src/s3.ts:28-36`
- Test: `server/test/s3.test.ts:53-75`

**Interfaces:**
- Consumes: nothing (the publish path already uploads every ZIP entry).
- Produces: no API change — `contentType(name)` simply recognises more extensions.

- [ ] **Step 1: Extend the existing content-type test**

In `server/test/s3.test.ts`, in the test `'uploads each unzipped entry with correct key, content-type and public ACL, returns CDN url'`, add the two new files to the ZIP fixture — from:

```typescript
        const zip = zipSync({
            'index.html': new TextEncoder().encode('<html></html>'),
            '0_0/meta.json': new TextEncoder().encode('{}'),
            '0_0/0.webp': new Uint8Array([1, 2, 3])
        });
```

to:

```typescript
        const zip = zipSync({
            'index.html': new TextEncoder().encode('<html></html>'),
            '0_0/meta.json': new TextEncoder().encode('{}'),
            '0_0/0.webp': new Uint8Array([1, 2, 3]),
            'favicon.png': new Uint8Array([4, 5, 6]),
            'poster.jpg': new Uint8Array([7, 8, 9])
        });
```

Update the count assertion — from `expect(puts).toHaveLength(3);` to:

```typescript
        expect(puts).toHaveLength(5);
```

And add two assertions after the `0_0/0.webp` one:

```typescript
        expect(byKey['sub/scene/favicon.png'].ContentType).toBe('image/png');
        expect(byKey['sub/scene/poster.jpg'].ContentType).toBe('image/jpeg');
```

- [ ] **Step 2: Run the test to verify it fails**

From `server/`:

```bash
npm test -- s3
```

Expected: FAIL — `expected 'application/octet-stream' to be 'image/jpeg'` on the `poster.jpg` assertion. (`favicon.png` already passes: `png` is in the map.)

- [ ] **Step 3: Add the missing extensions**

In `server/src/s3.ts`, extend `CONTENT_TYPES` (`:28`) — from:

```typescript
const CONTENT_TYPES: Record<string, string> = {
    html: 'text/html',
    js: 'text/javascript',
    css: 'text/css',
    json: 'application/json',
    wasm: 'application/wasm',
    webp: 'image/webp',
    png: 'image/png'
};
```

to:

```typescript
// Keep in sync with the favicon allow-list in favicon.ts: a published viewer's
// icon (and its poster) must be served with a real image type, not
// octet-stream, or browsers refuse to render it.
const CONTENT_TYPES: Record<string, string> = {
    html: 'text/html',
    js: 'text/javascript',
    css: 'text/css',
    json: 'application/json',
    wasm: 'application/wasm',
    webp: 'image/webp',
    png: 'image/png',
    ico: 'image/x-icon',
    svg: 'image/svg+xml',
    gif: 'image/gif',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg'
};
```

- [ ] **Step 4: Run the test to verify it passes**

From `server/`:

```bash
npm test -- s3
```

Expected: PASS — all `s3.test.ts` tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/s3.ts server/test/s3.test.ts
git commit -m "fix: serve published icons and posters with real image content types"
```

---

### Task 5: Document the env var

**Files:**
- Modify: `server/README.md` (the `## Environment variables` list, `:59-73`)
- Modify: `server/.env.local.example`

**Interfaces:**
- Consumes: the `VIEWER_FAVICON_URL` contract from Task 2.
- Produces: nothing consumed by code.

**Permission note:** `.env*` paths are blocked for the Read/Write/Grep tools in this project, and a Bash command that so much as mentions `server/.env.local.example` may be denied. Try the Bash append in Step 2; if it is denied, **stop and ask Dimitri to paste the two lines in himself** — do not work around the block, and do not skip the README (Step 1), which is not blocked.

- [ ] **Step 1: Add the var to `server/README.md`**

In the `## Environment variables` list, insert after the `MAX_UPLOAD` bullet and before the `S3_ENDPOINT…` bullet:

```markdown
- `VIEWER_FAVICON_URL` — absolute `http(s)` URL of a favicon to embed in **ZIP viewer
  exports** (`packageViewer`, plain and streaming, including the S3 publish that reuses
  them). The server fetches it once per export and stores a copy as `favicon.<ext>` beside
  `index.html`, so the exported archive stays self-contained. Accepted types: PNG, ICO,
  SVG, JPEG, WebP, GIF; 1 MiB maximum; 5 s fetch timeout. If unset, or if the fetch fails
  for any reason, the export completes normally without an icon (a warning is logged).
  Single-file HTML exports and local in-browser exports are unaffected.
```

- [ ] **Step 2: Add the var to `server/.env.local.example`**

Append a commented example. From the repo root:

```bash
printf '\n# Optional: favicon embedded in ZIP viewer exports (PNG/ICO/SVG/JPEG/WebP/GIF, max 1 MiB).\n# VIEWER_FAVICON_URL=https://cdn.example.com/favicon.png\n' >> server/.env.local.example
```

Expected: no output, exit 0. If the command is denied, see the permission note above.

- [ ] **Step 3: Verify the file changed as intended**

```bash
git diff --stat server/.env.local.example server/README.md
```

Expected: both files listed with a small insertion count. (`git diff` on the example file is a diff of a tracked file, not a read of a secret — if even this is denied, ask Dimitri to confirm the content.)

- [ ] **Step 4: Commit**

```bash
git add server/README.md server/.env.local.example
git commit -m "docs: document VIEWER_FAVICON_URL for ZIP viewer exports"
```

---

## Manual E2E (Dimitri, after Task 5)

Automated tests cannot cover the real browser tab. Run this once the plan is complete:

1. Put a real icon URL in `server/.env.local`: `VIEWER_FAVICON_URL=https://…/favicon.png`.
2. From the repo root: `npm run build`. From `server/`: `npm run dev` (serves the app and the API on http://localhost:3334 — the same origin, which is what makes the "Export on server" toggle appear).
3. Load a splat, export **Viewer package (ZIP)** with **Export on server** on, once with streaming **off** and once **on**.
4. Unzip each: `favicon.png` sits beside `index.html`, and `index.html`'s `<head>` has `<link rel="icon" …>`. Serve the folder and confirm the browser tab shows the icon.
5. Publish to the Space and open the returned URL: the tab shows the icon there too (this is the leg that needs Task 4's content type).
6. Break the URL on purpose (e.g. append `x`), re-export: the export still succeeds, the server logs `favicon: fetch failed: 404 … - exporting without a favicon`, and the ZIP has no icon.
7. Comment the var out, re-export: identical to a pre-feature export — no `favicon.*` entry, no `rel="icon"`.
8. Export a **single-file HTML** on the server and a **ZIP locally** (toggle off): neither has an icon.

## Self-Review

**Spec coverage:** configuration → Task 5 (+ Task 2 reads it); `server/src/favicon.ts` → Task 2; `run-export.ts` wiring and worker env inheritance → Task 3 Step 6; `src/viewer-companion/favicon.ts` → Task 1; shared-core `applyFavicon` + both ZIP call sites → Task 3 Steps 3-5; `s3.ts` content types (incl. the approved `poster.jpg` fix) → Task 4; the spec's three test groups → Tasks 1, 2, 4, plus the GPU integration test the spec listed as manual-only (Task 3 promotes it to automated where a GPU exists, and keeps the manual pass); risks → covered by the constraints and by the E2E's steps 6-8.

**Placeholders:** none — every code step carries complete code, every command an expected result.

**Type consistency:** `Favicon = { filename: string; mime: string; data: Uint8Array }` is declared twice on purpose — exported from `server/src/favicon.ts` (Task 2) and re-declared structurally in `src/splat-export-core.ts` (Task 3), because the shared core must not import from `server/`, and the server loads the core through an untyped dynamic `import()`. The two shapes are identical; keep them so. `injectFaviconLink(html, href, mime)` is used with exactly that argument order in Task 1's tests and Task 3's helper. `loadFavicon()` returns `Favicon | null`, and Task 3 passes `favicon ?? undefined` because the core's parameter is optional (`favicon?: Favicon`), not nullable.
