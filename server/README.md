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
