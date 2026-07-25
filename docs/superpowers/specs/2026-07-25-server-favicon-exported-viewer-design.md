# Server-side favicon for exported viewers — design

Date: 2026-07-25
Status: approved (design), not yet implemented

## Problem

The exported viewer's `<head>` (from `@playcanvas/splat-transform`'s `writeHtml`) carries a
`<title>SuperSplat Viewer</title>` and **no icon link at all**, so a browser showing an exported
viewer requests `/favicon.ico` from whatever host serves it and falls back to a blank tab icon.
Deployments that publish many viewers under one brand want their own icon in the tab.

The icon is a property of the *deployment*, not of a capture or of an editing session — so it is
configured once on the export server rather than chosen per export in the editor UI.

## Scope

In scope — **server mode, ZIP exports only**:

- `POST /api/export` with `fileType: 'packageViewer'`, both sub-paths (`package` and `streaming`).
- `POST /api/publish` (S3/Spaces), which runs the very same `packageViewer` export and uploads the
  unpacked entries.

Out of scope, deliberately:

- **Local (in-browser) exports** — unchanged. The browser has no access to server env, and this stays
  server-only *by construction* (the browser call site simply never passes a favicon), not via a flag.
- **Single-file HTML export** (`fileType: 'htmlViewer'`) — unchanged. It has no ZIP to carry a
  sibling file; supporting it would mean inlining a `data:` URI. Not requested.
- CPU formats (`ply`, `compressedPly`, `splat`) and `sog` — no HTML involved.
- The viewer `<title>`, and any per-export icon override. Not requested (YAGNI).

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Remote `<link>` to the configured URL, or fetch-and-embed? | **Fetch and embed** a copy in the ZIP | The archive stays self-contained: it works offline, behind a firewall, and after the source URL dies. Costs one small HTTP request per export, negligible beside a GPU export. |
| Where does the fetch happen? | **Server side** (`server/src/favicon.ts`) | Only the server can read `.env`; `src/splat-export-core.ts` and `src/viewer-companion/` are deliberately environment-agnostic (they compile to `dist-shared/` *and* into the browser bundle). Bytes are handed down; the URL never crosses into shared code. |
| Where is the file added to the archive? | **Inside the shared core**, into the in-memory FS before the ZIP is written | The alternative — post-processing the finished archive in the server — means unzip + rezip of a potentially multi-GB ZIP in memory. |
| Fetch fails (404, timeout, non-image, oversize)? | **Warn on the server, export without a favicon** | A cosmetic asset must never cost the user minutes of GPU work. The viewer is still complete and correct. |

## Configuration

New env var, read from `server/.env.local` (already loaded by `dotenv` at `server/src/index.ts:13`):

- `VIEWER_FAVICON_URL` — absolute `http`/`https` URL of the icon to embed in ZIP viewer exports.
  Unset or empty ⇒ **output is byte-identical to today**, on every path.

Documented in `server/.env.local.example` and in the environment-variable list in
`server/README.md` (§ Environment variables).

## Components

### 1. `server/src/favicon.ts` (new)

The only module that knows about the env var and the network.

```ts
export type Favicon = { filename: string; mime: string; data: Uint8Array };
export const loadFavicon = async (): Promise<Favicon | null>;
```

Behaviour:

1. Read `process.env.VIEWER_FAVICON_URL`. Unset/empty ⇒ return `null` silently (the default).
2. Parse it. Not a valid URL, or not `http:`/`https:` ⇒ warn, return `null`.
3. `fetch(url, { signal: AbortSignal.timeout(5000) })`. Non-2xx or network error ⇒ warn, `null`.
4. Read the body. Larger than **1 MiB** ⇒ warn, `null` (a favicon that big is a misconfiguration,
   and the cap bounds what an export can be made to embed).
5. Resolve the MIME type and extension from a fixed allow-list:

   | `Content-Type` | extension |
   | --- | --- |
   | `image/png` | `png` |
   | `image/x-icon`, `image/vnd.microsoft.icon` | `ico` |
   | `image/svg+xml` | `svg` |
   | `image/jpeg` | `jpg` |
   | `image/webp` | `webp` |
   | `image/gif` | `gif` |

   A missing or unrecognised `Content-Type` falls back to the URL path's own extension when that
   extension is in the table (mapped back to its canonical MIME); otherwise warn and return `null`.
   Only these six types are ever emitted.
6. Return `{ filename: 'favicon.<ext>', mime, data }`.

Every failure path is a single `console.warn` naming the URL, the reason, and
"exporting without a favicon". `loadFavicon` **never throws** — the whole body is guarded so a
surprise (e.g. a DNS failure shape we did not anticipate) cannot fail an export.

The emitted filename is always derived from the allow-list, never from the configured URL, so the
env value is never interpolated into the HTML. There is no HTML-injection surface.

### 2. `server/src/run-export.ts`

- `ExportOptions` gains **nothing**: no new field crosses the client→server boundary, so a favicon
  cannot be requested, spoofed or overridden per request. It is purely a deployment setting.
- In the `packageViewer` branch only (`run-export.ts:218-223`, after the `sog` and `htmlViewer`
  returns), call `await loadFavicon()` and pass the result to `writeViewerCore`.
- The `htmlViewer` branch (`:210-216`) passes nothing.

Env visibility in the worker: `runExport` executes on the export worker thread, spawned as
`new Worker(workerUrl, workerOptions)` at `run-export-worker-host.ts:30` with **no `env` option**,
so the thread inherits a copy of `process.env` as populated by `dotenv` in the main process.

### 3. `src/viewer-companion/favicon.ts` (new)

Pure string work, in the same place and shape as the existing `poster.ts` injector — which is what
makes it unit-testable without a GPU or a build.

```ts
export const injectFaviconLink = (html: string, href: string, mime: string): string;
```

Inserts `<link rel="icon" type="<mime>" href="<href>">` immediately before `</head>`. If the html has
no `</head>` (i.e. `writeHtml`'s output format changed), warn and return the input unchanged — a soft
no-op, consistent with the "never fail an export over the icon" decision. Environment-agnostic:
string operations only, no backslash escapes (see the companion-template gotcha in project memory).

### 4. `src/splat-export-core.ts`

- `writeViewerCore(...)` and the module-private `writeStreamingViewerCore(...)` each gain one
  trailing optional parameter `favicon?: Favicon`, immediately after `posterBytes`.
  `writeViewerCore` forwards it to `writeStreamingViewerCore`.
- New module-private helper, mirroring `applyPoster` (`splat-export-core.ts:71`):

  ```ts
  const applyFavicon = (html: string, favicon: Favicon | undefined, memFs) : string
  ```

  No favicon ⇒ return `html` untouched. Otherwise write `favicon.<ext>` into `memFs.results` and
  return `injectFaviconLink(html, './favicon.<ext>', mime)`.
- Called as the last link of the existing injection chain in **both** ZIP paths — the package branch
  (`:903-905`) and the streaming path (`:760-764`). Ordering against the other injectors does not
  matter: they all anchor on `</body>`, this one on `</head>`.
- Both ZIP paths already ZIP every `memFs` entry, so the new file needs no packaging code and is
  reported through the existing `exportFile` event (it will show in the server log as
  `Created favicon.png (1.2 KB)`).
- `src/splat-serialize.ts:1502` — the browser call — is **not** touched.

`dist-shared/` picks up the new `viewer-companion/favicon.ts` automatically: it compiles
`splat-export-core.ts` plus its import graph.

### 5. `server/src/s3.ts`

`CONTENT_TYPES` (`s3.ts:28`) currently knows only `html`, `js`, `css`, `json`, `wasm`, `webp`, `png`;
anything else is uploaded as `application/octet-stream`. Add the extensions this feature can emit:
`ico`, `svg`, `gif`, `jpg`, `jpeg`.

Adding `jpg`/`jpeg` also fixes an existing latent bug on the publish path: **`poster.jpg` is
uploaded as `application/octet-stream` today**. Approved as an in-scope one-line fix because it is
the same map this feature depends on.

No other publish-path change is needed: the ZIP is unpacked and every entry uploaded under
`<prefix>/`, so `favicon.<ext>` lands beside `index.html` and the relative `./favicon.<ext>`
resolves. (The viewer template's `<base href="">` is a no-op, so relative hrefs resolve against the
document URL — same as the existing `./poster.jpg` and `./index.css`.)

## Data flow

```
server/.env.local: VIEWER_FAVICON_URL
        │  (dotenv, main process → inherited by worker thread)
        ▼
run-export.ts  packageViewer branch
   await loadFavicon()  ──fetch──▶ configured URL
        │ { filename, mime, data } | null
        ▼
writeViewerCore(..., posterBytes, favicon)
        ├── package  branch ─┐
        └── streaming path ──┤
                             ▼
        applyFavicon(html, favicon, memFs)
            memFs['favicon.png'] = data
            injectFaviconLink(html, './favicon.png', 'image/png')
                             ▼
        ZIP every memFs entry ──▶ output.zip
                             │
                             └──▶ (publish) unzip + upload each entry to S3
```

## Testing

- `test/favicon-injection.test.ts` (root Vitest, pure — no GPU, no build): the link is inserted
  before `</head>` with the right `rel`/`type`/`href`; html without `</head>` is returned unchanged;
  a document with an existing `</head>` gets exactly one link.
- `server/test/favicon.test.ts` (server Vitest, `fetch` stubbed, env set/restored per case): unset ⇒
  `null`; happy path ⇒ `filename`/`mime`/`data`; 404 ⇒ `null`, no throw; non-image `Content-Type` ⇒
  `null`; body over the cap ⇒ `null`; missing `Content-Type` with a known URL extension ⇒ resolved;
  unknown extension ⇒ `null`; `file:`/relative URL ⇒ `null`; fetch rejection ⇒ `null`.
- `server/test/s3.test.ts` — extend the existing content-type assertions to cover `favicon.png`
  (and `poster.jpg`).

Not automated (manual E2E, the user's pass): a real GPU ZIP export with `VIEWER_FAVICON_URL` set
contains `favicon.<ext>` and the `<link rel="icon">`, and the browser tab shows the icon — for both
the plain package and the streaming ZIP, plus one S3 publish.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| A slow or hanging icon host stalls every export | 5 s `AbortSignal.timeout`, then warn and continue. |
| A huge or hostile URL bloats the ZIP | 1 MiB cap; six-entry MIME allow-list; filename derived from the allow-list, never from the URL. |
| Upstream `writeHtml` changes its `<head>` | Injection soft no-ops with a warning; the export still succeeds. Same posture as `injectPoster`'s anchor. |
| Regression on paths that should not change | With the var unset, every code path returns `null`/`undefined` early — local exports, HTML export and CPU formats are structurally unreachable from this feature. |
| `image/svg+xml` is stored/served as a document, not a bitmap | A compromised icon host could ship an SVG with embedded script, executed when a browser loads the exported viewer (or the published copy) from your origin. Decision: document the caveat (README `VIEWER_FAVICON_URL` bullet — prefer PNG/ICO, only point at a host you control) rather than remove SVG from the allow-list. |
