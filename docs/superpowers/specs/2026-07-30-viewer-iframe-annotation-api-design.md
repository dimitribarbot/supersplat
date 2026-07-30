# Exported viewer: iframe annotation-navigation API

**Date:** 2026-07-30
**Status:** design approved, not yet implemented

## Problem

The exported viewer (single-file HTML, ZIP, server ZIP, S3 publish) is often embedded
in a host page via an `<iframe>`. Integrators want to drive it from outside the frame:
a host-page button labelled "Bedroom" should fly the viewer camera to the "Bedroom"
annotation, the way an anchor link jumps to a section of a document.

Reloading the iframe (or re-pointing its `src`) would reload the whole scene, which
defeats the purpose. The jump must happen inside the already-running viewer.

## What already exists

The exported viewer needs no new navigation machinery. Three facts, verified against
`@playcanvas/splat-transform` 3.1.7's bundled viewer and this fork's companions:

1. `window.__supersplatViewer` is published from the viewer bootstrap by an idempotent
   soft-replace in `src/splat-export-core.ts` (see `injectDeviceFallback`,
   `injectOffLimitsZones`, `injectPortals`). `injectDeviceFallback` is unconditional,
   so the handle is present on every export.
2. `viewer.global.events.fire('annotation.navigate', ann)` resolves `ann` through the
   viewer's internal `scriptMap` and calls `showTooltip()`, which fires
   `annotation.activate`. The camera manager listens for that event, switches
   `cameraMode` to `orbit`, and flies to `annotation.camera.initial`. This is the same
   path the viewer's own prev/next chevrons use.
   The `ann` argument must be **object-identical** to an entry of
   `viewer.global.settings.annotations` — `scriptMap` is keyed by object identity.
3. `src/viewer-companion/portals.ts:719` already listens for `annotation.activate` and
   dispatches a portal scene crossing to `ann.extras.scene`, reusing the normal loading
   overlay only when the target scene is not yet resident. Cross-scene annotation jumps
   therefore work today, and an already-loaded scene swaps with no reload and no overlay.

The only missing piece is a way to trigger (2) from outside the iframe.

## Decisions

| Question | Decision |
|---|---|
| API scope | Navigate + discovery + notifications. Not a general remote-control API. |
| Annotation identity | By `name` (title), with stable `id` and numeric `index` also accepted. |
| Origin policy | Accept from any parent. Replies aimed at `event.origin`, never `'*'`. |
| Gating | Always injected, in every HTML export path. No export-dialog toggle. |
| Pre-ready requests | Queued and flushed on ready; latest `goto` wins. |

Rationale for the identity choice: the annotation title is already a human-meaningful
name the user types in the editor, so "Bedroom" needs no new UI, no new document-schema
field and no locale work. `id` and `index` are accepted as escape hatches for hosts that
prefer an unambiguous key.

Rationale for the origin policy: the capability granted is "move this camera / show this
tooltip". There is no write path and no data the host cannot already see by looking at
the viewer. An export-time allowlist would add UI and doc schema, and a wrong entry
would silently break the integration only after deployment.

## Architecture

New companion `src/viewer-companion/iframe-api.ts`, shaped exactly like the existing
`annotation-links.ts`:

- Pure, exported, unit-testable TypeScript builders.
- A stringified runtime injected verbatim into the exported HTML.
- A `buildIframeApiInjection()` entry point returning the `<script>` fragment.

Injected by a new `injectIframeApi(html, viewerSettingsJson)` in
`src/splat-export-core.ts`, added to the existing injector chain at all three of its
call sites inside `writeViewerCore`:

- streaming viewer ZIP (`src/splat-export-core.ts:785`),
- single-file bundled HTML (`src/splat-export-core.ts:880`),
- unbundled package ZIP (`src/splat-export-core.ts:926`).

That covers every export path. The export server produces its ZIPs by calling the same
`writeViewerCore` through `dist-shared`, and S3 publish uploads a PLY for the server to
turn into a viewer, so both inherit the bridge without per-path work.

It does not need its own bootstrap soft-replace: `injectDeviceFallback` is applied
unconditionally at all three sites and always publishes `window.__supersplatViewer`.
Chain position is therefore irrelevant — the runtime polls for the handle rather than
depending on injection order.

Following this repo's established convention (`buildLinkTable` in
`annotation-links.ts`), **all resolution data is baked at export time** into a plain
table, and the injected runtime only does trivial lookups over it. This keeps the
untestable string blob as dumb as possible.

Baked table entry: `{ index, id, title, titleLower, scene }`.

`index` is the join key back to the live viewer array: the baked table is built from
the same `viewerSettingsJson.annotations` array the viewer itself consumes, in order,
so `settings.annotations[index]` is the object-identical annotation that
`annotation.navigate` requires.

### Data flow

```
host page                    injected bridge                 viewer
  postMessage ─────────────►  resolve ref → index
                              index → global.settings.annotations[i]
                              events.fire('annotation.navigate', ann)  ──►  tooltip + camera fly
                                                                            └─► portals companion swaps scene if needed
              ◄───────────── reply to event.source @ event.origin
```

### Editor-side change

`annotations.export` (`src/annotations.ts:199`) currently emits
`extras: { url, newTab, scene }`. Add `id: a.id` so the `{id: ...}` lookup form has
something to match. Ids are already generated as `annotation_0`, `annotation_1`, ...
(`genId`, `src/annotations.ts:129`) and are persisted in the document, so they are
stable across reorders and reloads.

No other editor change. No new UI, no new locale strings.

## Protocol

Every message is a plain object whose `type` is a string beginning with `supersplat:`.
Anything else is ignored silently, so the bridge cannot clash with other postMessage
traffic on the host page (HMR, analytics, other SDKs).

### Host to viewer

| `type` | payload | reply |
|---|---|---|
| `supersplat:annotation.goto` | `{name?, id?, index?, requestId?}` | `supersplat:annotation.goto.result` `{requestId, ok, annotation?, reason?}` |
| `supersplat:annotation.list` | `{requestId?}` | `supersplat:annotation.list.result` `{requestId, annotations}` |
| `supersplat:ping` | `{requestId?}` | `supersplat:ready` `{requestId}` |

`annotations` in the list reply is an array of `{index, id, title, text, scene}`.
`annotation` on a successful `goto` reply is a single entry of that same shape — the
annotation that was navigated to.

`reason` on a failed `goto`:

- `not-found` — no annotation matched the reference.
- `bad-request` — none of `name`, `id`, `index` was supplied (or `index` was not a finite number).
- `unavailable` — `viewer.global.settings.annotations` is not reachable.

`requestId` is echoed back verbatim when supplied, so a host can await a specific call.
It is optional; the bridge assigns no meaning to its value.

`supersplat:ping` exists so a host page that mounted after the viewer finished loading
can obtain readiness on demand rather than waiting forever for a broadcast it missed.
Its reply reuses the `supersplat:ready` type, so a host needs only one branch: a
`ready` message means "ready", whether it arrived as the broadcast or as a ping reply.
The only difference is that the ping reply carries the `requestId` if one was supplied.

### Viewer to host

- `supersplat:ready` — broadcast to `window.parent` exactly once, on the viewer's
  `firstFrame` event. Payload-free by design: a broadcast has no `event.origin` to aim
  at and must use `'*'`, and annotation titles should not go to an unknown ancestor.
- `supersplat:annotation.activated` `{index, id, title, scene}` — fired on every
  `annotation.activate`, whatever the cause: a host `goto`, a hotspot click, or the
  viewer's own prev/next chevrons. Lets host UI keep the correct button highlighted.
- `supersplat:annotation.deactivated` — fired on `annotation.deactivate`.

Notifications are sent only to *subscribers*: any window that has sent at least one
valid `supersplat:` message, each addressed to its own origin. First contact
subscribes. This avoids broadcasting annotation titles to `'*'` with no configuration
burden on the integrator.

If an `activated` event carries an annotation that is not in the baked table (should
not happen, but the viewer owns the event), the notification is skipped rather than
sent with partial fields.

### Reply targeting

Replies use `source.postMessage(reply, event.origin)`. For a sandboxed or `file://`
host, `event.origin` is the string `"null"`, which is not a legal `targetOrigin` and
throws a `SyntaxError`. That call is wrapped in a try/catch falling back to `'*'`.
This is not theoretical: a ZIP opened straight off disk hits exactly this path.

### Resolution rules

Precedence, first hit wins:

1. `id` — exact string match against the baked `id`.
2. `index` — finite number, within `[0, table.length)`.
3. `name` — `String(name).trim().toLowerCase()` compared against the baked `titleLower`.

Duplicate titles are legal in the editor. The first match wins; this is documented
rather than defended against.

## Lifecycle

The injected script installs its `message` listener at parse time, before the viewer's
deferred module bootstrap runs, so no message can be missed.

It then rAF-polls for `window.__supersplatViewer.global.events` (the pattern
`portals.ts` and `off-limits-zones.ts` already use). Once found it subscribes to
`firstFrame` to mark itself ready, and additionally treats `global.state.loaded === true`
observed on a poll tick as ready, covering the case where `firstFrame` fired before the
listener attached.

On ready, in order: broadcast `supersplat:ready`; answer queued `list` requests; flush
the single pending `goto`.

Queued state before ready:

- `goto` — one pending reference, latest wins. A user pressing three buttons during the
  loading bar lands on the third.
- `list` — queued per requester and all answered on ready.
- `ping` — answered on ready like `list`.

The subscriber list is deduped by source window and capped at 8 entries, oldest dropped.
Without a cap, a parent spawning frames would grow an unbounded array of window
references.

## Error handling

The entire message handler runs inside a try/catch. A `message` listener that throws is
invisible to the host and can disrupt unrelated listeners on the same page.

If `viewer.global.settings.annotations` ever stops existing because upstream reshapes
the viewer, every request answers `unavailable` and the viewer behaves exactly as it
does today. This matches the soft-fail philosophy of the existing companions: degrade
to inert, never corrupt the export.

## Build constraint

The companion runtime lives inside a TypeScript template literal, which consumes
backslash escapes at build time (see the `companion-template-no-backslash-escapes`
note). The runtime body must use string operations only: no regex literals, no `\n`
escapes, no backticks.

Non-ASCII characters, if any are ever needed, must be written as pre-escaped
`\\uXXXX` sequences the way `annotation-links.ts` writes its localized labels.

## Testing

New `test/viewer-iframe-api.test.ts`, mirroring `test/annotation-links.test.ts`:

- `buildAnnotationIndex(annotations)` — id/title/scene extraction; annotations with no
  `extras`; empty, missing and non-string titles.
- `resolveAnnotationRef(table, ref)` — precedence `id` then `index` then `name`; case
  and surrounding-whitespace insensitivity; duplicate titles resolve to the first
  entry; out-of-range, negative and non-finite index; empty ref yields `bad-request`.
- `buildIframeApiInjection(...)` — emits a `<script>` carrying the table; HTML-escapes
  `<`, `>`, `&`, U+2028 and U+2029 in the JSON exactly as `annotation-links.ts` does;
  the emitted runtime contains no backslash sequences.

One case added to `test/annotations.test.ts`: `annotations.export` bakes `extras.id`.

### Manual E2E

Against a **release** build (`npm run build`) — debug builds hide minification bugs in
stringified helpers — using a portal export with annotations in at least two scenes,
driven from `docs/examples/iframe-annotations.html`:

1. Jump to an annotation in the currently active scene.
2. Jump into an already-resident scene: instant, no loading overlay, no reload.
3. Jump into a not-yet-loaded scene: loading overlay appears, then arrival.
4. Press a host button during the initial load: the viewer lands on that annotation.
5. `annotation.activated` fires for host `goto`, hotspot clicks and viewer chevrons.
6. `annotation.list` returns every annotation with the right `scene` values.
7. Repeat 1-3 against a server-produced ZIP. The server bakes from `dist-shared`, so it
   needs `npm run build` of the shared output and a restart of the 3334 server.

## Documentation

`docs/viewer-iframe-api.md` — protocol reference plus a copy-pasteable host snippet.
It notes that a host should tighten its own outgoing `targetOrigin` from `'*'` to the
viewer's origin; the bridge cannot enforce that from inside the frame.

`docs/examples/iframe-annotations.html` — a working host page that doubles as the E2E
harness.

## Out of scope

- Camera or scene remote control (mode switching, reset, animation play/pause).
- URL-hash deep-linking on initial load.
- An export-time origin allowlist.
- An export-dialog toggle.
- Any editor UI change beyond baking `extras.id`.
