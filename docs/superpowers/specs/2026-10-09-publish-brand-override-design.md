# Per-publish brand override for S3-published viewers — design

Date: 2026-10-09
Status: approved (design), not yet implemented

## Problem

The export server can already rebrand ZIP viewer exports from its environment (`VIEWER_BRAND_NAME`,
`VIEWER_BRAND_ICON_URL`, `VIEWER_BRAND_FONT_*`, plus `VIEWER_FAVICON_URL`). That brand belongs to the
**operator** running the deployment.

The operator now publishes scenes on behalf of **clients** who want the viewer to carry *their* brand
and who should see as little of the operator's brand as possible. Clients manage their name, icon
and logo in a separate operator application, which stores the images in an S3 bucket under stable
URLs. When a client changes an image there, every scene already published for that client must
pick up the change **without republishing**.

Along the way, two shortcomings of the current env brand are addressed:

- The brand font never worked in practice (a CSS stylesheet URL such as Google Fonts' `css2?family=`
  is not a font file), so the badge label it was meant to style is dropped and the font support is
  removed.
- The info panel header always links to the upstream GitHub repository, and there is no way to show
  a wide logo instead of icon + name.

## Scope

In scope:

- **`POST /api/publish`** (S3/Spaces) gains an optional per-publish client brand, entered in the S3
  publish dialog.
- **All ZIP viewer exports** (`packageViewer`, plain and streaming, including publish) get the
  reworked env brand described below.

Out of scope, unchanged:

- Local (in-browser) exports and single-file HTML exports — never branded, as today.
- "Export on server" ZIP downloads never receive a client brand: only the S3 publish dialog offers it.
- A tool to re-patch already-published scenes. That lives in the operator's other application; this
  feature only guarantees a stable patch target (see "In-place rename contract").

## Configuration

### Environment (export server)

| Variable | Status | Meaning |
| --- | --- | --- |
| `VIEWER_BRAND_NAME` | kept | Operator brand name |
| `VIEWER_BRAND_ICON_URL` | kept, extended | Operator icon: badge, info panel fallback, **and favicon** |
| `VIEWER_BRAND_LOGO_URL` | **new** | Operator logo shown in the info panel header instead of icon + name |
| `VIEWER_BRAND_URL` | **new** | Operator website: target of the info panel header (env-only) and of the "Powered by" link (client mode) |
| `VIEWER_FAVICON_URL` | **removed** | Superseded by `VIEWER_BRAND_ICON_URL` |
| `VIEWER_BRAND_FONT_NAME`, `VIEWER_BRAND_FONT_URL` | **removed** | Never worked; removed with their code |

Env icon and logo are **fetched and embedded** by the server, exactly as today (`fetchAsset`:
timeout, streaming size cap, MIME allow-list), stored beside `index.html` as `brand-icon.<ext>` and
`brand-logo.<ext>`. ZIP downloads therefore stay self-contained. Each asset that cannot be fetched
drops out on its own, with a warning; the export never fails because of branding.

`VIEWER_BRAND_URL` must be an absolute `https:` URL; anything else is ignored with a warning.

The env brand is applied when at least one of name, icon or logo is configured (and loaded).
`VIEWER_BRAND_URL` alone changes nothing.

### Client brand (S3 publish dialog)

Three new optional text fields: **Brand name**, **Icon URL**, **Logo URL**. Their values are kept
between openings of the dialog within a session (not reset on each `show`), since a client brand is
typically reused across several publishes.

They travel in the publish `options` JSON as `brandOverride: { name?, iconUrl?, logoUrl? }`. Empty
strings are treated as absent.

The server validates them (it has no auth, so the client cannot be trusted):

- `iconUrl`, `logoUrl`: parse with `new URL()`, protocol must be `https:`, at most 2048 characters.
- `name`: trimmed, at most 100 characters, no control characters.
- Any violation → `400` with a descriptive error; nothing is published.

Client URLs are **hotlinked**, never fetched by the server: the viewer references them directly.
This is what makes image updates propagate without republishing (the client's application
overwrites the image at its stable URL), and it means the server never requests a user-supplied
URL (no SSRF surface).

## Resolution rules

Name and icon form a **pair**: the client pair is used only when the client supplied *both*;
otherwise the env pair is used for every surface that shows a name or an icon.

```
clientPair = client.name && client.iconUrl
name       = clientPair ? client.name    : env.name
icon       = clientPair ? client.iconUrl : env.icon
clientMode = clientPair || !!client.logoUrl
panel      = client.logoUrl            → client logo alone
           : clientPair                → client icon + client name
           : env.logo                  → env logo alone
           : (env.icon or env.name)    → env icon + env name (whichever exist)
           : stock header
```

`clientMode` is true only when a client value is actually used. A client that supplies only a name
(or only an icon) falls back entirely to the env brand and is rendered exactly like an env-only
publish.

## Surfaces

| Surface | Env-only | Client mode |
| --- | --- | --- |
| `<title>` | `name` | `name` |
| Favicon | `icon` | `icon` |
| Overlay badge (top-left) | `icon` only, `name` as its tooltip (`title` attribute); keeps the link to the hosted viewer's own URL | `icon` only, `name` as tooltip; **not a link** |
| Info panel header | `panel` (see rules); links to `VIEWER_BRAND_URL` if set, otherwise not a link | `panel`; **never a link** |
| Panel version suffix | kept | kept |
| Attribution line | "Based on PlayCanvas SuperSplat Viewer" | the same, plus "Powered by *X*", where *X* is `VIEWER_BRAND_NAME` and only *X* links to `VIEWER_BRAND_URL` (plain text if unset). The "Powered by" part is omitted when `VIEWER_BRAND_NAME` is unset. |

Notes:

- The badge is only ever revealed by the viewer when it is embedded in a cross-origin iframe
  (upstream behaviour, unchanged). The viewer's runtime sets the badge's `href` to its own URL; in
  client mode the badge is rendered as a non-link element so that assignment has no effect, and the
  hosted URL is never offered to the visitor.
- "Not a link" means the element carries no `href` and gets no pointer cursor or hover effect.
- The badge no longer shows a text label in any branded export (env or client): icon only.
- A surface whose input is missing keeps its stock content (e.g. no `name` → stock `<title>`, no
  tooltip; no `icon` → stock badge logo, no favicon).
- Examples in tests and docs: operator brand "Acme" (via `VIEWER_BRAND_NAME`), client brand
  "Client Co".

## In-place rename contract

Image changes propagate on their own (hotlinked stable URLs). A **name** change requires the
operator's application to patch each published scene. To keep that patch trivial:

- The name is written **once**, in `index.html`, as `<title data-brand-name>Client Co</title>`.
- In `index.js`, the badge tooltip and the info panel label do not carry a copy: the injected
  markup reads the name from `document.title` (HTML-escaped) when the viewer's UI template is
  evaluated.
- Renaming a published scene is therefore: rewrite the `<title data-brand-name>…</title>` element in
  its `index.html` and re-upload it with the same `Content-Type` and ACL. Nothing else.

Why this works: the viewer builds its UI with `root.innerHTML = uiHtml`, where `uiHtml` is a
module-level string in `index.js`, a deferred module script, so the document `<title>` has already
been parsed when it is evaluated. The viewer never writes `document.title` itself (verified against
the shipped bundle).

`index.html` keeps the CDN's default caching; a patched title may take the CDN's default lifetime
to appear. Accepted.

## Architecture

- **`server/src/brand.ts`** — `loadBrand()` loads the env brand (name, icon, logo, url; font and
  favicon code removed). New pure `resolveBrand(envBrand, override)` applies the rules above and
  returns the final injection input. New pure `validateBrandOverride(raw)` for the publish route.
- **`server/src/favicon.ts`** — removed; the favicon comes from the resolved icon.
- **`server/src/index.ts`** — `/api/publish` validates `options.brandOverride` and passes it into
  the job's export options. `/api/export` never passes one.
- **`server/src/run-export.ts`** — loads the env brand, resolves it with the (optional) override,
  passes the result to `writeViewerCore` as `brand`; the separate `favicon` option is dropped.
- **`src/splat-export-core.ts`** — `applyBrand` emits embedded env assets into the memFs, calls the
  page and `index.js` injectors, and injects the favicon link. `ViewerCoreOptions.favicon` is
  removed.
- **`src/viewer-companion/brand.ts`** — the injectors take resolved hrefs (relative embedded
  filenames or validated client `https:` URLs), the name flag, the panel mode, the link targets and
  the client-mode flag. All URLs are HTML-attribute-escaped, then JS-string-escaped when they land
  in `uiHtml`. Font code removed. Anchors stay exported for the drift-guard test.
- **`src/viewer-companion/favicon.ts`** — kept; `mime` becomes optional (unknown for a hotlinked
  icon, so the `type` attribute is omitted).
- **`src/ui/s3-publish-dialog.ts`**, **`src/s3-publish.ts`** — the three fields, the
  `brandOverride` option, forwarded to the server. Locale strings for the three labels in all
  locales under `static/locales/`.
- **`server/README.md`** — env documentation updated. `server/.env.local.example` is updated by the
  operator (env files are not editable by tooling here).

## Error handling

- Env asset fetch failure: warn, that asset drops out, export continues (unchanged posture).
- Invalid `VIEWER_BRAND_URL`: warn, treated as unset.
- Invalid client override: `400` before any job is created; the dialog's existing publish error
  path shows the message.
- A client image URL that later breaks (404) shows a broken image in the viewer; this is the
  accepted cost of hotlinking.
- Missing injector anchor (upstream drift): warn and leave that surface stock (unchanged posture),
  caught in CI by the anchor drift guard.

## Testing

- `resolveBrand` unit tests: every row of the rules, including the incomplete-pair fallbacks
  (name only, icon only, logo only, logo + name, full client, no env).
- `validateBrandOverride` unit tests: protocols (`http:`, `javascript:`, `data:`), lengths, control
  characters, empty strings.
- `loadBrand` tests updated: logo, url, font removal, favicon removal.
- Injector tests (`test/brand-injection.test.ts`): each surface in env-only and client mode, link
  presence and absence, tooltip, `data-brand-name`, the `document.title` read in `uiHtml`,
  escaping of URLs and names (including `$`, quotes, `</script>`), idempotence, missing anchors.
- `test/viewer-html-anchors.test.ts`: drift guard extended to any new anchor (badge closing tag,
  panel header attributes).
- `server/test/brand-zip.gpu.test.ts`: real package and streaming ZIPs with env brand (icon used as
  favicon, logo embedded) and with a client override (hotlinked URLs, no badge link).
- Manual E2E: publish with and without a client brand, view the result directly and inside a
  cross-origin iframe, then patch the `<title>` of a published `index.html` and confirm the badge
  tooltip and panel label follow.

## Risks

| Risk | Mitigation |
| --- | --- |
| The `document.title` read relies on `uiHtml` being evaluated after the document head is parsed | True for a module-level string in a deferred module script; covered by the GPU ZIP test and the manual E2E. An upstream change to how the template is built would fail the anchor drift guard. |
| Hotlinked client images depend on the client bucket staying reachable | Accepted: same infrastructure as the published scenes. |
| The operator's brand can still appear in client mode (incomplete client pair, "Powered by") | Deliberate, per the rules above. |
| Removing `VIEWER_FAVICON_URL` / `VIEWER_BRAND_FONT_*` silently changes deployments that set them | Documented in the README; the server logs a one-line notice at startup when a removed variable is still set. |
