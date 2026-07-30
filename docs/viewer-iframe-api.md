# Exported viewer iframe API

Every SuperSplat HTML export (single-file HTML, ZIP package, streaming ZIP,
server export and S3 publish) carries a small `postMessage` bridge. A page that
embeds the viewer in an `<iframe>` can use it to jump the camera to an
annotation, the way an anchor link jumps to a section of a document.

The jump happens inside the running viewer: nothing reloads, and in a multi-scene
portal export an already-loaded scene swaps instantly.

## Quick start

```html
<iframe id="viewer" src="scene/index.html"></iframe>
<button data-goto="Bedroom">Bedroom</button>

<script>
  const frame = document.getElementById('viewer');

  document.querySelectorAll('[data-goto]').forEach((b) => {
      b.onclick = () => frame.contentWindow.postMessage(
          { type: 'supersplat:annotation.goto', name: b.dataset.goto }, '*');
  });

  addEventListener('message', (e) => {
      if (e.source !== frame.contentWindow) return;
      if (e.data?.type === 'supersplat:annotation.activated') {
          console.log('now showing', e.data.title);
      }
  });
</script>
```

Replace the `'*'` target origin with the viewer's own origin once you know it.
The bridge cannot enforce that from inside the frame — it is the host page's
responsibility.

## Messages the viewer accepts

Every message is an object with a `type` string. Anything else is ignored, so the
bridge will not clash with other `postMessage` traffic on your page.

### `supersplat:annotation.goto`

Fly the camera to an annotation.

| field | type | meaning |
| --- | --- | --- |
| `name` | string | Match the annotation title, ignoring case and surrounding whitespace |
| `id` | string | Match the stable annotation id (`annotation_0`, `annotation_1`, …) |
| `index` | number | Match by position in the annotation list, 0-based |
| `requestId` | any | Optional; echoed back on the reply so you can await a specific call |

Supply at least one of `name`, `id`, `index`. If you supply several, the first
one that matches wins, tried in the order `id`, `index`, `name`. Duplicate titles
are allowed in the editor; `name` resolves to the first annotation with that
title.

Reply — `supersplat:annotation.goto.result`:

```js
{ type: 'supersplat:annotation.goto.result', requestId, ok: true,
  annotation: { index, id, title, text, scene } }

{ type: 'supersplat:annotation.goto.result', requestId, ok: false,
  reason: 'not-found' | 'bad-request' | 'unavailable' }
```

- `not-found` — you supplied a reference, but nothing matched it.
- `bad-request` — you supplied no usable `name`, `id` or `index`.
- `unavailable` — the viewer has no working annotation navigator to fire into:
  either this export was built with `noui` (which never builds one), or
  `supersplat:ready` was reached through the bounded loading-timeout fallback
  before the scene's annotations were ready. A `goto` sent before
  `supersplat:ready` is queued, not rejected — see "Clicks during loading are
  not lost" below.

### `supersplat:annotation.list`

Ask for every annotation, so the host page can build its buttons from the scene
rather than hardcoding them.

Reply — `supersplat:annotation.list.result`:

```js
{ type: 'supersplat:annotation.list.result', requestId,
  annotations: [ { index, id, title, text, scene }, ... ] }
```

`scene` is the portal scene index the annotation belongs to, or `null` in a
single-scene export.

### `supersplat:ping`

Ask whether the viewer is ready. Replies with `supersplat:ready` (carrying your
`requestId`, if you sent one). Useful when your page mounted after the viewer
finished loading and missed the broadcast.

## Messages the viewer sends

### `supersplat:ready`

Broadcast to the parent window once, when the viewer finishes its initial load.
Carries no data. Also sent as the reply to `supersplat:ping`, so a single
`ready` branch covers both.

### `supersplat:annotation.activated`

```js
{ type: 'supersplat:annotation.activated', index, id, title, scene }
```

Sent whenever an annotation is shown — by your `goto`, by a visitor clicking the
hotspot in the scene, or by the viewer's own previous/next arrows. Use it to keep
the matching button highlighted.

### `supersplat:annotation.deactivated`

Sent when the tooltip closes. Carries no data.

Notifications go only to windows that have sent the viewer at least one message.
Send a `supersplat:ping` on startup to subscribe.

## Behaviour notes

- **Clicks during loading are not lost.** A `goto` sent before the viewer is
  ready is held and applied as soon as it finishes loading. If several arrive,
  the last one wins.
- **Cross-scene jumps work.** In a portal export, jumping to an annotation in
  another scene swaps the scene. If that scene is already resident the swap is
  instant; otherwise the usual loading overlay appears while it streams in.
- **Navigating switches the camera to orbit mode**, matching what the viewer's
  own annotation hotspots do.
- **`noui` exports report ready immediately, not on load completion.** A
  `noui` export never builds an annotation navigator at all, so there is
  nothing to wait for; `supersplat:ready`/`supersplat:ping` still answer (and
  `supersplat:annotation.list` still returns the baked table) but every `goto`
  replies `unavailable` for the lifetime of that page.
- **Any parent may drive the viewer.** There is no origin allowlist: the API
  only moves the camera and shows a tooltip. Replies are addressed to the
  sender's own origin.
- **Annotation content is not private, even behind a private URL.** Because
  there is no origin allowlist, this is not limited to pages that deliberately
  embed the viewer in an `<iframe>`: any window that can obtain a handle to it —
  including one opened with `window.open(viewerUrl)` by a page that merely
  knows the URL — can send `supersplat:annotation.list` and read back every
  annotation title and body text, regardless of its own origin. If the viewer
  is reachable at all (a signed S3 URL, an IP-restricted server export, a page
  behind authentication that an attacker's tab can still open), the same-origin
  policy will not stop that read. Do not treat annotation content as private in
  a deployment that relies on URL secrecy or network restrictions alone.
