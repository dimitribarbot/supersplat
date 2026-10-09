# Runtime brand switch for published viewers — design

Date: 2026-10-09
Status: approved (design), not yet implemented
Builds on: `2026-10-09-publish-brand-override-design.md` (historical record, not updated)

## Problem

Since `e29f7c9`, a branded viewer export resolves its brand **at export time**: the server merges the
operator brand (`VIEWER_BRAND_*`) with an optional per-publish client brand and bakes the result into
`index.html` (title, favicon) and `index.js` (`uiHtml`: badge, info panel header, attribution). Only
the name is written once (`<title data-brand-name>`) and read back at runtime. Icon and logo URLs
appear in up to four places (favicon link, badge icon, panel icon, panel logo), and the mode itself
(operator vs client) is frozen into the markup.

The operator's other application manages client brands for published scenes. It must be able to:

- change a scene's client name, icon URL and logo URL by rewriting **one place per value**;
- switch a published scene **between modes**: from operator mode (no client brand) to client mode
  (name, icon and logo set) and back, by rewriting `index.html` only, without republishing and
  without knowing anything about the operator brand.

## Decisions

| Question | Decision |
| --- | --- |
| Where do client values live? | Three `<meta>` elements in `index.html`; empty `content` = not set |
| What does the other app write? | Only the client values. The operator brand is baked by the server and never touched by the app |
| Who applies the brand rules? | The page, at runtime, with the same rules as today |
| Title and favicon after a switch | Set at runtime by a synchronous inline `<head>` script, before first paint (no flash) |
| No operator brand configured and no client brand | Unchanged: stock viewer, nothing injected, not switchable |
| `data-brand-name` | Removed. The `<title>` becomes a plain export-time value |

## Scope

In scope: every branded ZIP viewer export (`packageViewer`, plain and streaming), i.e. `/api/export`
ZIP downloads (operator brand only, empty client metas) and `/api/publish` S3 publishes (operator
brand plus optional client brand).

Out of scope, unchanged: local (in-browser) and single-file HTML exports (never branded); the S3
publish dialog and `/api/publish` validation; `/api/export` stripping `brandOverride`; the
`VIEWER_BRAND_*` env variables and how operator assets are fetched and embedded.

**Breaking change:** scenes published with `e29f7c9` keep their old format (name read from
`<title data-brand-name>`, no metas, mode frozen). They must be republished before the other app can
switch them. No migration is provided.

## Published-file contract

`index.html` head of a branded export:

```html
<title>Acme</title>
<link rel="icon" type="image/png" href="./brand-icon.png">
<meta name="brand-client-name" content="">
<meta name="brand-client-icon" content="">
<meta name="brand-client-logo" content="">
<script>/* brand runtime, see below */</script>
```

- **The three metas are the contract with the other app.** It may rewrite their `content` at any time.
  Empty or missing = not set. Icon and logo must be absolute `https:` URLs; anything else is ignored
  by the page (with a console warning).
- `<title>` and the favicon `<link>` hold the brand **resolved at export time**. The page corrects
  both at runtime; consumers that read the static HTML without running scripts (link previews,
  crawlers) keep seeing the export-time values. Accepted.
- The favicon link precedes the metas and the script, so the script finds it rather than adding a
  second one.
- **Operator files ship with every branded export**: `brand-icon.<ext>` and `brand-logo.<ext>` are
  embedded whenever the env configures them, client mode included, so switching back to operator
  mode always has its images.

## Brand rules (unchanged, now evaluated at runtime)

Inputs: operator `{ name, iconHref, iconMime, logoHref, url }` (baked), client `{ name, iconUrl,
logoUrl }` (from the metas, trimmed, non-https URLs dropped).

- **Pair:** `clientPair = client.name && client.iconUrl`.
- **Client mode:** `clientPair || client.logoUrl`.
- **Name:** client name if `clientPair`, else operator name.
- **Icon** (badge, panel fallback, favicon): client icon if `clientPair`, else operator icon (with
  its MIME type; a hotlinked client icon has none).
- **Logo:** client logo; else, when not `clientPair`, the operator logo.
- **Panel header:** the logo alone if any; else icon + name.
- **Links:** operator mode links the badge and links the panel header to `operator.url` (no link when
  unset). Client mode links neither, and adds "Powered by `<operator.name>`" (name linked to
  `operator.url` when set) under the attribution.
- **Empty view** (no name, icon or logo resolved): stock surfaces everywhere, title
  `SuperSplat Viewer`, no favicon link.

## Components

### `src/viewer-companion/brand-rules.ts` (new, pure)

The rules live here, once. No imports, no closures over module state, no backslashes or backticks
(the functions are injected with `Function.toString()`, see the companion-template trap).

- `resolveBrandView(operator, client)` → `{ name, iconHref, iconMime, logoHref, panelHref,
  badgeLink, poweredBy }` (today's `BrandInjection` shape), or an empty view.
- `brandFragments(view)` → escaped HTML strings for every spliced `uiHtml` surface: badge open,
  badge close, badge icon, panel open, panel close, panel logo, panel label, attribution. A surface
  the view leaves stock has no fragment.

Used by the export core (static title and favicon) and injected into the page (runtime).

### `src/viewer-companion/brand.ts` (reworked)

- `injectBrand(html, brand)`: replaces the stock `<title>` with the export-time name, then inserts
  before `</head>`: the marker, the `<style>` block (as today), the favicon link when an icon
  resolves, the three metas pre-filled with the publish's client values, and the brand runtime
  script.
- **Brand runtime script** (classic, synchronous, inline): baked operator JSON +
  `resolveBrandView` + `brandFragments`. During head parsing it reads the metas, resolves, sets
  `document.title`, sets/creates/removes the favicon link (dropping `type` for a hotlinked icon), and
  stores the fragments in `window.__brandUi` (left unset for an empty view). Wrapped in try/catch.
- `injectBrandJs(js, brand)`: declares, right before `var uiHtml =`,
  `var __brandUi = (typeof window !== "undefined" && window.__brandUi) || {};`, then replaces each
  `uiHtml` anchor with a splice of the form `"+(__brandUi.badgeOpen||"<stock markup>")+"`. The stock
  fallback is the anchor's original markup, so a missing fragment (empty view, script failure)
  renders exactly the stock viewer. No operator value is baked into `index.js`.
- Anchor lists (`BRAND_HTML_ANCHORS`, `BRAND_JS_ANCHORS`) and the soft-skip warnings stay.
- `__brandNameHtml` and the `document.title` read in `index.js` are removed.

### `src/viewer-companion/favicon.ts`

The static favicon link is emitted by `injectBrand` (ordering constraint above). `injectFaviconLink`
is folded in or reused by it; the separate call in `applyBrand` goes away.

### `src/splat-export-core.ts`

The `Brand` option becomes `{ files, operator, client }`. `applyBrand` embeds `files` and passes the
brand to both injectors.

### `server/src/brand-resolve.ts`

`resolveBrand(env, override)` stops applying rules. It embeds every configured operator asset and
returns `{ files, operator: { name, iconHref, iconMime, logoHref, url }, client: { name, iconUrl,
logoUrl } }`, or `null` when neither brand has a name, icon or logo. `validateBrandOverride` is
unchanged. `ResolvedBrand` stays in step with the export core's `Brand`.

## Error handling

| Case | Behaviour |
| --- | --- |
| Meta missing | Treated as empty |
| Client URL not absolute `https:` / unparseable | Ignored, `console.warn` |
| Name with markup | HTML-escaped in fragments; `document.title` assigned as text |
| Brand runtime script throws | Caught; `window.__brandUi` unset; every splice falls back to stock |
| `index.js` evaluated without `window` | `__brandUi` is `{}`; stock |
| Bundle anchor missing | Soft skip with a warning (as today); drift guard fails in tests |
| Injected twice | No-op (head marker in `index.html`; the `__brandUi` declaration in `index.js`) |

## Testing

- `test/brand-rules.test.ts` (new): today's rule cases ported from `server/test/brand-resolve.test.ts`
  (pair, panel priority, client mode, "Powered by", empty view), the https filter, fragment escaping.
  Every case also runs against a `new Function('return ' + fn.toString())()` copy of each function.
- Runtime simulation (new): runs the injected head script under a stubbed `document` (metas, title,
  head links), then renders the patched `uiHtml` with the resulting `window.__brandUi`. Covers
  operator mode, full client pair, client logo only, **operator → client → operator by rewriting only
  the metas**, favicon create / swap / remove, hostile meta values, script failure → stock.
- `test/ui-html.ts` (and its server twin): the tokenizer learns the `(__brandUi.key||"…")` splice
  form, given a fragments object, and drops `__brandNameHtml`.
- `test/brand-injection.test.ts`: rewritten for the new head (title, favicon, metas, script) and the
  splices; idempotency; `$` safety.
- `test/favicon-injection.test.ts`: adjusted to wherever the favicon link is now emitted.
- `test/viewer-html-anchors.test.ts`: against the real bundle, anchors still occur once, and the
  patched real `uiHtml` renders correctly for operator and client views.
- Server: `brand-resolve.test.ts` for the new shape (all operator assets embedded even in client
  mode, `null` cases); `brand-zip.gpu.test.ts` asserts a client-branded ZIP carries the operator
  files and the filled metas; `publish-routes.test.ts` as needed.

### Manual E2E (operator)

1. Publish to S3 in operator mode. Edit the three metas in the bucket by hand (as the other app
   would), reload: client mode (title, favicon, badge not linked, panel logo, "Powered by").
2. Empty the metas, reload: operator mode again, operator images load.
3. Network tab, Chrome and Firefox: confirm no request for the previous favicon after a switch
   (browser favicon-fetch timing is the one unverified assumption of this design).

## Documentation

- `server/README.md`: the brand section is rewritten as the contract the other app relies on (three
  metas, empty = not set, https only, export-time title/favicon, republish needed for scenes
  published before this change).
- Code comments in `brand.ts` / `brand-rules.ts` replace the "name written once in the title" notes.
