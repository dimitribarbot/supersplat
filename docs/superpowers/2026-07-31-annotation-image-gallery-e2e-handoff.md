# Annotation image galleries — E2E hand-off

Date: 2026-07-31
Branch: `annotation-image-gallery` — **not merged, not pushed**
HEAD at hand-off: `7c31297`
Status: code-complete, fully reviewed, all automated gates green, **never exercised in a browser**

## What this feature does

An annotation can carry an ordered set of embedded images. In an exported ZIP
viewer, such an annotation shows a chip in its tooltip — `🖼 View images (N)` —
that opens a modal carousel: one image at a time, each with a description that
is both the visible caption and the image's `alt` text, with previous/next
navigation. A single attached image shows no navigation affordances at all.

An annotation offers **either** an external link **or** an image gallery, never
both. A `linkType` field (`none` | `url` | `images`) selects which is live;
both sets of data are retained across a mode switch, so flipping back and forth
loses nothing.

- Spec: `docs/superpowers/specs/2026-07-31-annotation-image-gallery-design.md`
- Plan: `docs/superpowers/plans/2026-07-31-annotation-image-gallery.md`

## Where things stand

18 commits on top of `main` (`307fcfb..7c31297`). Twelve planned tasks, each
implemented by a fresh subagent and reviewed; then a whole-branch review, a fix
wave, and a scoped re-review.

Gates at `7c31297`, all run and confirmed:

- front-end suite: **571/571 passing** (49 files)
- server suite: **88/88 passing** (20 files)
- `npm run lint`: exit 0
- `npx tsc --noEmit`: exit 0
- release build (`npm run build`): exit 0, and the `ss-gallery` marker is
  present in `dist/index.js` — minification did not eat the stringified
  companion runtime

**What has never been verified: anything requiring a browser.** Every
implementer ran headless. That is the entire remaining risk surface, and it is
what this memo exists to close.

## Running it

```bash
npm run develop      # debug build + static server on http://localhost:3333
npm run build        # release build -> dist/  (see the release-build note below)
npm run dev --prefix server   # export server on http://localhost:3334 (also serves dist/)
```

**Do the main pass against a RELEASE build, not `npm run develop`.** The
exported viewer's companion code ships as *stringified runtimes*, and this repo
has previously been bitten by minification changing their behaviour in release
builds specifically. A debug-only pass would not prove the exported viewer
works.

For the server-side export and S3 publish steps, run the export server and load
the app from **http://localhost:3334** (same-origin is required for the "Export
on server" toggle to appear at all).

## The checklist

### A. Editor

- [ ] Load a splat. With the annotation tool, place three annotations:
      one with **3 images** (give all three captions), one with **1 image**,
      one with an **external link**.
- [ ] The toolbar's `Link Type` dropdown swaps the tail of the bar: `External
      Link` shows URL + Open in New Tab; `Images` shows `N images — Edit…`;
      `None` shows neither. The bar stays **one row**.
- [ ] Type a URL, switch to `Images`, switch back — the URL is still there.
- [ ] In the images dialog: add several images at once, reorder with ▲/▼,
      remove one, edit captions. Each row shows a thumbnail, a "Description"
      label and its caption field.
- [ ] Close the dialog with OK, then press **Ctrl+Z once** — the entire dialog
      session should undo as a single step, and the toolbar count should follow.
- [ ] Check the label reads **"1 image — Edit…"** (not "1 images") with one
      image attached. This was a real bug; it is fixed but has never been seen
      rendered in the app.

### B. Project round-trip

- [ ] Save the `.ssproj`, then `File > New`, then reload it. Images, their
      order and their captions all survive.
- [ ] Unzip the `.ssproj` and confirm entries at `annotations/annimg_*.jpg`.
- [ ] Remove one image, save to a new file, unzip: the orphaned image is
      **not** written.

### C. Package (ZIP) export — the main event

- [ ] Export as Package (ZIP). Unzip and confirm `annotations/annimg_*.jpg`
      sit beside `index.html`.
- [ ] Serve the unzipped folder and open it. On the 3-image annotation:
  - [ ] the chip reads `View images (3)`
  - [ ] arrows, the `N / M` counter and the page dots are all present
  - [ ] click navigation works; dots jump directly to an image
  - [ ] ← / → keyboard navigation works
  - [ ] arrows **disable at the ends** (navigation does not wrap)
  - [ ] Esc closes; clicking the backdrop closes; ✕ closes
  - [ ] **the camera does not move while the modal is open** — try dragging,
        scrolling and right-dragging over the image
  - [ ] Tab cycles within the modal rather than escaping it
- [ ] The 1-image annotation shows **no** arrows, **no** counter, **no** dots.
- [ ] The link annotation still shows `Open link ↗` and navigates.
- [ ] Captions display under each image, and the images carry them as `alt`.
- [ ] Repeat the whole export with **Streaming** enabled.

### D. HTML export — regression test for the critical bug

- [ ] With a gallery annotation present, switch the export format to **HTML**.
      The omission warning appears: "*N annotation galleries will be omitted —
      use Package (ZIP) to include them.*"
- [ ] Export it and open the resulting `.html`. **The gallery chip must be
      completely absent** — no `View images (N)`.

      This is the regression test for the one Critical bug the whole-branch
      review found: the HTML export used to ship the chip pointing at image
      files that are not in the document, while the popup claimed the galleries
      had been omitted. Fixed in `writeViewerCore` via `stripHtmlGalleries`,
      but **no automated test pins that `writeViewerCore` actually calls it**
      (testing that needs a GPU device), so this manual check is the only guard.

### E. Server paths

- [ ] With the export server running and the app loaded from :3334, enable
      "Export on server" and export a Package (ZIP). Same carousel checks as C.
- [ ] If you have `S3_*` configured: publish, and confirm the published prefix
      contains `annotations/annimg_*.jpg` served as `image/jpeg`, with a
      working carousel. (Never exercised — no credentials in the build
      environment.)

### F. Import pipeline

- [ ] Attach one **12 MP photo** and one **small PNG with alpha**. The photo
      should be downscaled and re-encoded to JPEG (long edge 2048, q0.85); the
      small PNG should pass through verbatim with transparency intact. The
      dialog's total-size readout makes the first easy to spot.

## Known residuals (not blockers, but know them)

- **7 of 9 locale translations are machine-authored** (de, es, ja, ko, pt-BR,
  ru, zh-CN) and await the usual native review pass. Specifically flagged:
  the **Russian** plural forms in `panel.annotations.images-edit` and
  `export.annotation-images-html-warning` were pattern-matched from the
  existing translation, not natively verified. They render
  изображение / изображения / изображений for 1 / 3 / 5, which is the standard
  pattern, but a native eye is worth having.
- No automated test pins that `writeViewerCore` calls `stripHtmlGalleries`
  (see D above) — it needs a GPU device.
- `annotations.export` fails **closed and silently** if `annotationImages.has`
  were ever unregistered: every image would be dropped rather than erroring.
  Safe today (both modules register unconditionally in `main.ts`).
- The HTML omission warning counts annotations from the records, while export
  counts only images whose bytes are present — so an annotation whose bytes
  are all missing warns about a gallery that would not have exported anyway.
- A full list of deferred minors, parked rulings and per-task verification gaps
  is in the SDD ledger: `.superpowers/sdd/2026-07-31-annotation-image-gallery/progress.md`
  (git-ignored, so it lives only on this machine — read it before deleting the
  workspace).

## Decisions already made (do not re-litigate)

- Local files embedded, not remote URLs — the exported viewer stays offline-capable.
- Downscale + re-encode on attach at 2048 px / JPEG q0.85; lossy by design.
- ZIP and S3 publish only; single-file HTML deliberately drops images and warns.
- Toolbar: a `Link Type` dropdown swapping the bar's tail (option A of three mockups).
- Carousel: caption **below** the frame, arrows outside the image, page dots
  (option A of three mockups) — because the caption is also the alt text and
  must stay legible.
- Two findings were escalated mid-flight and ruled on by the user: render the
  caption label (rather than delete the unused key), and share
  `collectAnnotationImages` via `src/annotation-images.ts` (rather than keep the
  duplication or export it between dialogs).

## When E2E passes

Invoke `superpowers:finishing-a-development-branch`. Per this project's
convention, the feature should be **squashed into a single commit** summarising
all changes including documentation, then merged to `main`.

If E2E fails, the failure is almost certainly in browser-only behaviour — the
dialog's layout, the carousel's interaction handling, or the import pipeline —
since every pure-logic path is covered by the 571 front-end tests. Start with
`superpowers:systematic-debugging`.
