# Annotation image galleries — design

Date: 2026-07-31
Status: approved (brainstorming), ready for implementation planning

## Goal

Let an annotation carry an ordered set of attached images. In an exported ZIP
viewer, such an annotation shows a chip in its tooltip that opens a modal
carousel: one image at a time, each with a description that is both the visible
caption and the image's `alt` text, with previous/next navigation. A single
attached image shows no navigation affordances at all.

An annotation has **either** an external link **or** an image gallery, never
both.

## Scope

In scope:

- Editor: attaching, ordering, captioning and removing images on an annotation.
- Project persistence (`.ssproj`).
- Export: Package (ZIP) and Streaming (ZIP), both the local (browser) and the
  server-side export paths.
- S3 / Spaces publish.
- Exported-viewer runtime: chip + modal carousel.

Out of scope:

- Single-file HTML export carries no images (the export popup warns instead).
- Remote image URLs. Images are always local files embedded at attach time.
- The iframe API (`src/viewer-companion/iframe-api.ts`) gains no gallery surface.
- The editor's own annotation overlay/preview shows no gallery indicator.

## Decisions and rationale

| Decision | Rationale |
|---|---|
| Local files, embedded | The exported viewer stays self-contained and works offline; a remote URL rots. |
| Downscale + re-encode on attach | A 12 MP phone photo is ~6 MB; ten of them would add ~60 MB to both the project and every export. |
| ZIP + S3 publish only | `publishZip` already uploads and content-types every ZIP entry, so publish is free once images are ZIP entries. A single-file HTML export would base64-inflate an already-huge file. |
| `linkType` selector rather than validation | Exclusivity becomes a property of the data model, not a rule to police in the UI. |
| Bytes stored outside `AnnotationData` | `UpdateAnnotationOp` snapshots old/new values into the undo stack; multi-MB buffers there would make every caption edit clone the payload. |
| One companion owns the tooltip chip | Link and gallery are mutually exclusive and share one DOM slot; two companions appending to the same shared tooltip would race. |

## 1. Data model

`AnnotationData` (`src/annotations.ts`) gains:

```ts
linkType: 'none' | 'url' | 'images';
images: AnnotationImage[];      // ordered; metadata only, no bytes
```

```ts
type AnnotationImage = {
    imageId: string;   // unique within the document, e.g. `annimg_<n>`
    ext: string;       // 'jpg' | 'png' | 'webp'
    mime: string;      // 'image/jpeg' | 'image/png' | 'image/webp'
    caption: string;   // visible caption AND alt text; may be empty
};
```

`url` and `newTab` are unchanged and are retained when `linkType` is not
`'url'`, so switching modes back and forth loses nothing and stays undoable.

**Image bytes** live in a session-scoped store — a module-level
`Map<imageId, Uint8Array>` in its own module, `src/annotation-images.ts` (which
also owns the import/re-encode pipeline), exposed as:

- `annotationImages.get` (function) → `Uint8Array | null`
- `annotationImages.put` (event) → store bytes under an id
- `annotationImages.newId` (function) → mint an id
- `annotationImages.clear` (event) → wired to `scene.clear`

The store is never pruned mid-session, so undoing a removal restores a working
image. Only images referenced by a live annotation are written on save or
export.

### Legacy documents

`docDeserialize.annotations` defaults `linkType` to `d.linkType ?? (d.url ? 'url' : 'none')`
and `images` to `d.images ?? []`. No migration pass, no version bump.

## 2. Import pipeline

Triggered from the images dialog via `<input type="file" accept="image/*" multiple>`.

Per selected file:

1. Decode to an `ImageBitmap`.
2. If the long edge exceeds **2048 px**, or the source type is not one of
   `image/jpeg` / `image/png` / `image/webp`, draw to a canvas scaled to fit
   2048 px and re-encode as `image/jpeg`, quality **0.85**.
3. Otherwise keep the original bytes verbatim (this is what preserves alpha in
   already-small PNG/WebP files).
4. Mint an `imageId`, put the bytes in the store, append an `AnnotationImage`
   with an empty caption.

A file that fails to decode is skipped with a user-visible error listing the
filename; the remaining files still import.

## 3. Editor UI

### 3.1 Toolbar (`src/tools/annotation-tool.ts`)

The floating bar stays a single row. The bare `Link URL` field is replaced by a
`Link type` `SelectInput` with options None / External link / Images, whose value
swaps the controls that follow it:

| `linkType` | Controls shown after the selector |
|---|---|
| `none` | — |
| `url` | `URL [ https://… ]` `New tab [toggle]` (the existing controls, unmoved) |
| `images` | `🖼 N images — Edit…` button |

`Scene` remains the last item and is unaffected. Changing `Link type` commits as
an `UpdateAnnotationOp` on `linkType` alone.

### 3.2 Images dialog (`src/ui/annotation-images-dialog.ts`)

Modelled on `src/ui/publish-settings-dialog.ts` (a `Container` with
`class: ['settings-dialog', 'blocks-shortcuts']`, `show()`/`hide()` returning a
promise). Contents:

- A vertical list, one row per image: thumbnail (object URL) · caption
  `TextInput` · `▲` · `▼` · `✕`.
- `Add images…` button.
- A total-size readout for the annotation's images.
- OK / Cancel.

Reordering is `▲`/`▼` buttons, not drag-and-drop — same outcome, far less code.

The dialog edits a working copy. Accepting commits **one** `UpdateAnnotationOp`
on `images`, so an entire editing session (adds, caption edits, reorders,
removals) is a single undo step. Cancelling discards the working copy; any bytes
already put in the store are simply left unreferenced.

### 3.3 Localization

New `en.json` keys, mirrored into the other 8 locales:

- `panel.annotations.link-type`, `.link-type-none`, `.link-type-url`, `.link-type-images`
- `panel.annotations.images-edit` (`"{{count}} images — Edit…"`)
- `popup.annotation-images.header`, `.add`, `.caption`, `.remove`, `.move-up`,
  `.move-down`, `.total-size`, `.decode-failed`
- `export.annotation-images-html-warning`

## 4. Project persistence

`.ssproj` is already a ZIP (`document.json` + `splat_<i>.ply`).

**Save** (`src/doc.ts` `saveDocument`): after the splat PLYs, write each image
referenced by a live annotation as `annotations/<imageId>.<ext>`.
`document.json`'s `annotations` array carries `linkType` and the `images`
metadata only.

**Load** (`loadDocument`): after `docDeserialize.annotations`, read each
referenced `annotations/<imageId>.<ext>` entry back into the store via the
existing `zipFs.createSource`. A missing entry leaves that image absent: the
dialog shows a broken-image placeholder for the row and export skips it, rather
than failing the load.

## 5. Export

### 5.1 Export shape

`annotations.export` emits only the live action for each annotation:

```ts
// linkType === 'url'
extras: { url, newTab, scene?, id }
// linkType === 'images'
extras: { images: [{ src: 'annotations/<imageId>.<ext>', caption }], scene?, id }
// linkType === 'none'
extras: { scene?, id }
```

`src` is relative to `index.html`, matching how the poster and favicon are
referenced.

`images` is omitted entirely when the list is empty, so an annotation left in
`linkType === 'images'` with nothing attached exports as `linkType === 'none'`
does and shows no chip. It never falls back to a retained `url`.

### 5.2 Getting bytes to the writer

`ViewerExportSettings` (`src/splat-serialize.ts`) gains:

```ts
annotationImages?: { path: string; data: Uint8Array }[];
```

populated by `src/ui/export-popup.ts` and `src/ui/s3-publish-dialog.ts` from the
store, for the live images of every annotation with `linkType === 'images'`.

`writeViewerCore` / `writeStreamingViewerCore` (`src/splat-export-core.ts`) take
it as a new trailing parameter and, on the Package and Streaming paths only, do:

```ts
for (const img of annotationImages ?? []) memFs.results.set(img.path, img.data);
```

— the same shape as `applyFavicon`. Every `memFs` entry is already written into
the ZIP by the existing loops, so ZIP, Streaming and (via `publishZip`) S3
publish all follow from this one insertion point. `server/src/s3.ts`'s
`CONTENT_TYPES` already maps `jpg`/`jpeg`/`png`/`webp`, so published images are
served with a real image type.

The HTML path ignores the parameter.

### 5.3 Server-side export

The images ride as repeated multipart `annotationImage` file parts, mirroring
the existing `poster` part, in both `/api/export` and `/api/publish`
(`server/src/index.ts`). Each part's `filename` is the image basename.

The server rebuilds the path as `annotations/<basename>` after whitelisting the
basename against `^[A-Za-z0-9_-]+\.[a-z0-9]+$`. A part filename is
attacker-controllable in principle and becomes a ZIP entry name, so a
non-matching part is rejected outright rather than sanitized-and-kept.
`ExportOptions` in `server/src/run-export.ts` carries the assembled list through
to `writeViewerCore`.

### 5.4 HTML export warning

When the chosen format is HTML and at least one annotation has
`linkType === 'images'`, the export popup shows an inline note
(`export.annotation-images-html-warning`): *"N annotation galleries will be
omitted — use Package (ZIP) to include them."* Export proceeds; the chip is
simply absent from the output.

## 6. Exported-viewer runtime

### 6.1 Ownership

`src/viewer-companion/annotation-links.ts` keeps ownership of the single tooltip
chip and of the `annotation.activate` / `annotation.deactivate` lifecycle. It
now chooses, from the activated annotation's own `extras`:

- `extras.images?.length` → chip `🖼 View images (N)`, opens the carousel
- else `extras.url` → chip `Open link ↗` (today's behaviour, unchanged)
- else → no chip

The injection gate widens from "any annotation has a url" to "any annotation has
a url **or** images".

The carousel itself — modal markup, CSS, keyboard handling — lives in a new
sibling module `src/viewer-companion/annotation-gallery.ts`, exporting its
runtime and style strings, which `annotation-links.ts` composes into its
injection. One activation handler, one chip, no two companions racing over the
same shared tooltip.

### 6.2 Modal behaviour

The modal is appended to `document.body`, **not** to the tooltip: `.pc-annotation`
is `pointer-events:none` and its contents are rewritten on every activation.

Layout (approved mockup): dimmed backdrop; image centred; the caption is a line
of text **below** the frame (never overlaid on the photo, because it is also the
alt text and must stay legible); counter `N / M` top-left; close `✕` top-right;
`‹` `›` outside the image; page dots under the caption.

- Close on backdrop click, `✕`, or `Esc`.
- `←` / `→` navigate. Navigation does not wrap.
- With exactly one image: no arrows, no counter, no dots.
- `img.alt` = caption; captions are written with `textContent`, never `innerHTML`.
- Focus moves into the dialog on open (`role="dialog"`, `aria-modal="true"`) and
  is restored to the chip on close.
- Key and pointer events inside the modal are stopped so they never reach the
  viewer's camera controls.
- Images are plain `<img>` elements whose `src` is swapped on navigation; the
  browser cache handles repeat views. No preloading.

### 6.3 Localization

Same pattern as the existing `openLinkLabels` table: an inline 9-locale map
keyed off `navigator.language` (primary subtag, falling back to English) for the
chip label and the Close / Previous / Next `aria-label`s. The counter is
rendered as `N / M`, which needs no translation.

### 6.4 Codebase-specific traps to respect

- **No backslash escapes inside the companion template literal.** They are eaten
  at build time (`\d` → `d`). Accented labels use `\\uXXXX`; no regex literals in
  the runtime string.
- **Escape the baked JSON** exactly as `buildLinkTable`'s injection does
  (`<`, `>`, `&`, U+2028, U+2029) — captions are user text and could otherwise
  break out of the `<script>` tag.
- **Injection uses `insertBeforeBodyClose`**, which already avoids the
  `String.replace` `$`-substitution corruption.

## 7. Testing

New `test/annotation-gallery.test.ts` (Vitest, node environment — these are pure
string builders, no DOM required):

- Empty gate: no urls and no images → `''`.
- Chip precedence: an annotation carrying both `url` and `images` in `extras`
  (a hand-built record; the editor cannot produce one) resolves to the gallery.
- A caption containing `</script>` and `$&` survives escaping intact.
- A single-image annotation's baked payload is distinguishable from a
  multi-image one (arrows suppressed at runtime by length).
- `src` values are the expected `annotations/<id>.<ext>` shape.

Extend `test/annotation-links.test.ts`:

- `annotations.export` emits `url`/`newTab` only for `linkType === 'url'` and
  `images` only for `linkType === 'images'`.

Server (`server/vitest.config.ts`):

- Basename whitelisting accepts `annimg_3.jpg` and rejects `../evil.html`,
  `a/b.jpg`, `.htaccess`.

Manual E2E (release build):

1. Export a ZIP containing one 3-image annotation, one 1-image annotation and
   one external-link annotation.
2. Open it: 3-image shows arrows/counter/dots and navigates by click and by
   keyboard; 1-image shows none of them; link annotation is unchanged.
3. Save and reload the `.ssproj`; images and captions survive.
4. Repeat the export through the export server, and through S3 publish.

## Open risks

- Re-encoding is lossy and the exported image is not byte-identical to the file
  picked. Accepted deliberately; the threshold (2048 px / q0.85) is a constant in
  one place if it needs tuning.
- Project and export size still grow with the number of attachments. The dialog's
  total-size readout is the only guardrail; no hard cap is imposed.
