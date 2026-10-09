# SuperSplat Export Server

GPU-accelerated server-side export for SuperSplat. This Node + Fastify service runs the
[`@playcanvas/splat-transform`](https://www.npmjs.com/package/@playcanvas/splat-transform)
writers on the host GPU, so that exports requiring WebGPU (SOG, HTML viewer, package viewer)
can be produced server-side rather than in the browser.

## Requirements

- Node >= 20.19
- A GPU with working WebGPU/Dawn (provided by the native [`webgpu`](https://www.npmjs.com/package/webgpu) package).
  If no usable GPU is available, the capabilities endpoint reports `gpu: false` and the
  GPU-only formats are omitted from the advertised format list.

## Install

```
cd server && npm install
```

The `webgpu` package is a native Dawn binding and may take a while to install.

## Run

Development (watch mode), from the `server/` directory:

```
npm run dev
```

Production:

```
npm run build && npm start
```

## Serving the web app (single-origin)

The browser client probes `${location.origin}/api/export/capabilities` and only shows
the "Export on server" option when that succeeds — i.e. the page and the API must be on
the **same origin**. This server therefore also serves the built web app (the repo-root
`dist/` folder) for any non-`/api/export*` route, so no reverse proxy is needed for local
testing.

To test server-side export locally:

1. Build the web app from the repo root: `npm run build` (or `npm run watch` to rebuild on
   save — refresh the browser to pick up changes; there is no HMR in either case).
2. Start this server: from `server/`, `npm run dev` (watch) or `npm run build && npm start`.
3. Browse **http://localhost:3334/** (the server's port — *not* 3333). The page is served
   from `dist/` and `/api/export*` is same-origin, so the export modal shows the toggle.

The repo-root `npm run develop` (static server on 3333) is unchanged and has no API, so the
server option does not appear there — use it for pure front-end work.

If `dist/` has not been built, the server logs a warning and serves the API only (non-API
routes return 404 until you build).

## Environment variables

- `PORT` — port to listen on (default `3334`).
- `STATIC_ROOT` — directory to serve the web app from (default: the repo-root `dist/`,
  resolved relative to the server module).
- `MAX_UPLOAD` — maximum accepted upload size in bytes for the gzipped PLY (default `1073741824`, i.e. 1 GiB). Uploads above this are rejected by the multipart parser.
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
  for the icon and the logo: an SVG is served as a document from the publish origin and can execute
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
    that element and re-upload `index.html` with the same content type and ACL. When only
    a client logo is used (no complete client name + icon pair), `<title data-brand-name>`
    holds the operator name, so a rename tool must only rewrite scenes published with a
    full client pair (or know which brand each scene used).
  - `/api/export` (ZIP download) ignores `brandOverride`.
- `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` —
  S3-compatible (DigitalOcean Spaces) credentials. When all five are present, the
  capabilities endpoint reports `publish: true` and the client's Publish menu
  targets the Space.
- `S3_PUBLIC_BASE_URL` — base URL for returned public links; set to your CDN
  endpoint. Falls back to `${S3_ENDPOINT}/${S3_BUCKET}` if unset.
- `S3_FORCE_PATH_STYLE` — `true`/`false` (default `false`).

Configure these in `server/.env.local` (git-ignored); see `server/.env.local.example`.

## Endpoints

### `GET /api/export/capabilities`

Reports whether the server is enabled, whether a GPU device was successfully probed, and
which export formats are available:

```json
{ "enabled": true, "gpu": true, "formats": ["ply", "compressedPly", "splat", "sog", "htmlViewer", "packageViewer"] }
```

CPU formats (`ply`, `compressedPly`, `splat`) are always available. GPU formats
(`sog`, `htmlViewer`, `packageViewer`) are only listed when a GPU device is available.

## Reverse proxy

When deployed alongside the SuperSplat web app, route `/api/export*` to this server and
serve the built static app (`dist/`) for everything else.

## Parity guarantee

The browser does the quality-critical preparation (gaussian filtering, SH-band truncation,
`Transform.PLY` tagging) and ships an uncompressed float32 PLY. The server reads that PLY
back into a `DataTable` (bit-exact — the float columns survive the round-trip) and runs the
**same** `@playcanvas/splat-transform` writers the browser would have used. Because both feed
the writers identical data, a server-produced file is byte-for-byte equivalent to the
corresponding local export. This is locked down by `test/parity-compressed.test.ts`
(`compressedPly` is asserted byte-identical to a direct `writeCompressedPly` on the same
readback table).

## Security

This server has **no built-in authentication** — it is meant to be self-hosted and deployed
independently. Place it behind your deployment's own access controls (reverse-proxy auth,
network ACLs, etc.). Job ids are generated with a CSPRNG and upload filenames are
validated/sanitized, but the endpoints themselves are otherwise open.

## Publish to a Space

When the `S3_*` env vars are configured, the server exposes:

- `GET /api/export/capabilities` → includes `publish: true`.
- `GET /api/publish/exists?subfolder=&name=` → `{ exists, count }` overwrite check.
- `POST /api/publish` (multipart: gzipped PLY + viewer options + `{ subfolder?, name, public, overwrite }`)
  → `{ jobId }`. Progress streams over `GET /api/publish/:id/events`; the terminal
  `done` event carries `{ url?, prefix }`.

The server runs the same viewer package (ZIP) export, unpacks it, and uploads each
file under `<bucket>/<subfolder>/<name>/…` (with `public-read` ACL when requested),
so streaming and collision data are reachable by URL.
