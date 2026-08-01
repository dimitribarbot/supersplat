# Annotation Image Galleries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an annotation carry an ordered set of embedded images, and have the exported ZIP viewer show a chip that opens a modal carousel of them.

**Architecture:** A new `linkType` field on the annotation record selects between an external link and an image gallery, so the two are mutually exclusive by construction. Image *metadata* rides on the annotation record (cheap to snapshot into the undo stack); image *bytes* live in a session-scoped store keyed by id, are persisted as their own `.ssproj` ZIP entries, and are emitted into the export ZIP as `annotations/<imageId>.<ext>`. The exported viewer's existing annotation-link companion keeps ownership of the single tooltip chip and now opens a carousel modal (a new sibling companion module) when the activated annotation carries images.

**Tech Stack:** TypeScript, PlayCanvas + PCUI, Rollup, Vitest (node environment), Fastify (export server), `@playcanvas/splat-transform`.

**Spec:** `docs/superpowers/specs/2026-07-31-annotation-image-gallery-design.md`

## Global Constraints

- Long-edge ceiling for a stored image is **2048 px**; JPEG re-encode quality is **0.85**. Both are constants in `src/annotation-images.ts`.
- Passthrough (kept verbatim) source types are exactly `image/jpeg`, `image/png`, `image/webp`. Everything else is re-encoded to JPEG.
- Export path for image files is always `annotations/<imageId>.<ext>`, relative to `index.html`. The same path is the `.ssproj` ZIP entry name.
- `imageId` format is `annimg_<n>`.
- Images ship in **Package (ZIP)** and **Streaming (ZIP)** exports (local and server-side) and in S3 publish. The single-file **HTML** export drops them and warns.
- **No backslash escapes inside `src/viewer-companion/*` template literals** — they are eaten at build time (`\d` becomes `d`). Use `\\uXXXX` for non-ASCII, and no regex literals inside runtime strings.
- User text baked into an injected `<script>` is escaped for `<`, `>`, `&`, U+2028, U+2029 (mirror `buildAnnotationLinksInjection`). User text written into the DOM uses `textContent`, never `innerHTML`.
- Every new user-facing string gets a key in all 9 locale files under `static/locales/`: `en, de, es, fr, ja, ko, pt-BR, ru, zh-CN`.
- Run commands plainly from the repo root in Git Bash (no `cd`, no `--prefix` at cwd). Server commands run from `server/`.
- Vitest gates run in the **foreground** with output redirected to a file — never backgrounded, never piped to `grep` (it hangs).
- ESLint is pinned to v10 and crashes on `import/order` autofix. Match surrounding import order by hand; do not reorder imports.

---

### Task 1: Image byte store and import pipeline

**Files:**
- Create: `src/annotation-images.ts`
- Create: `test/annotation-images.test.ts`
- Modify: `src/main.ts` (register the new events beside `registerAnnotationsEvents`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `registerAnnotationImageEvents(events: Events): void`
  - `planEncoding(mime: string, width: number, height: number): { reencode: boolean, mime: string, ext: string }`
  - `encodeAnnotationImage(file: File): Promise<{ data: Uint8Array, mime: string, ext: string }>`
  - Event bus surface: `annotationImages.newId` (function → `string`), `annotationImages.get` (function, `(imageId: string) => Uint8Array | null`), `annotationImages.has` (function → `boolean`), `annotationImages.put` (event, `(imageId: string, data: Uint8Array)`).

- [ ] **Step 1: Write the failing test**

Create `test/annotation-images.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import { planEncoding, registerAnnotationImageEvents } from '../src/annotation-images';

// Minimal Events double: function/invoke registry + on/fire listeners.
// (Same shape as test/annotations.test.ts.)
const makeEvents = () => {
    const fns = new Map<string, (...args: any[]) => any>();
    const listeners = new Map<string, ((...args: any[]) => void)[]>();
    return {
        function(name: string, fn: (...args: any[]) => any) { fns.set(name, fn); },
        invoke(name: string, ...args: any[]) { return fns.get(name)?.(...args); },
        on(name: string, fn: (...args: any[]) => void) {
            const arr = listeners.get(name) ?? [];
            arr.push(fn);
            listeners.set(name, arr);
        },
        fire(name: string, ...args: any[]) { (listeners.get(name) ?? []).forEach(fn => fn(...args)); }
    } as any;
};

describe('planEncoding', () => {
    it('keeps a small jpeg verbatim', () => {
        expect(planEncoding('image/jpeg', 1600, 900)).toEqual({ reencode: false, mime: 'image/jpeg', ext: 'jpg' });
    });

    it('keeps a small png verbatim so alpha survives', () => {
        expect(planEncoding('image/png', 512, 512)).toEqual({ reencode: false, mime: 'image/png', ext: 'png' });
    });

    it('re-encodes an oversized png to jpeg', () => {
        expect(planEncoding('image/png', 4032, 3024)).toEqual({ reencode: true, mime: 'image/jpeg', ext: 'jpg' });
    });

    it('measures the long edge, not the width', () => {
        expect(planEncoding('image/jpeg', 1000, 3000).reencode).toBe(true);
    });

    it('re-encodes an unsupported type even when small', () => {
        expect(planEncoding('image/heic', 800, 600)).toEqual({ reencode: true, mime: 'image/jpeg', ext: 'jpg' });
    });

    it('does not treat a prototype key as a known type', () => {
        expect(planEncoding('constructor', 100, 100).reencode).toBe(true);
    });
});

describe('annotation image store', () => {
    it('mints unique ids', () => {
        const events = makeEvents();
        registerAnnotationImageEvents(events);
        expect(events.invoke('annotationImages.newId')).toBe('annimg_0');
        expect(events.invoke('annotationImages.newId')).toBe('annimg_1');
    });

    it('stores and returns bytes', () => {
        const events = makeEvents();
        registerAnnotationImageEvents(events);
        events.fire('annotationImages.put', 'annimg_7', new Uint8Array([1, 2, 3]));
        expect(events.invoke('annotationImages.has', 'annimg_7')).toBe(true);
        expect(Array.from(events.invoke('annotationImages.get', 'annimg_7'))).toEqual([1, 2, 3]);
    });

    it('returns null for an unknown id', () => {
        const events = makeEvents();
        registerAnnotationImageEvents(events);
        expect(events.invoke('annotationImages.get', 'annimg_9')).toBeNull();
    });

    // A loaded document supplies its own ids; the counter must not later remint one.
    it('keeps the id counter ahead of ids put by a document load', () => {
        const events = makeEvents();
        registerAnnotationImageEvents(events);
        events.fire('annotationImages.put', 'annimg_4', new Uint8Array([0]));
        expect(events.invoke('annotationImages.newId')).toBe('annimg_5');
    });

    it('clears on scene.clear', () => {
        const events = makeEvents();
        registerAnnotationImageEvents(events);
        events.fire('annotationImages.put', 'annimg_0', new Uint8Array([1]));
        events.fire('scene.clear');
        expect(events.invoke('annotationImages.has', 'annimg_0')).toBe(false);
        expect(events.invoke('annotationImages.newId')).toBe('annimg_0');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/annotation-images.test.ts > /tmp/t1.log 2>&1; tail -30 /tmp/t1.log`
Expected: FAIL — cannot resolve `../src/annotation-images`.

- [ ] **Step 3: Write the implementation**

Create `src/annotation-images.ts`:

```ts
import { Events } from './events';

// Long-edge ceiling for a stored image. Anything larger is redrawn to fit and
// re-encoded: a 12 MP phone photo is ~6 MB, and ten of them would otherwise be
// carried by both the project file and every export.
const MAX_EDGE = 2048;
const JPEG_QUALITY = 0.85;

// Source types we are willing to ship verbatim, mapped to their stored
// extension. Anything else is re-encoded to JPEG so the exported viewer can
// display it without a decoder of its own.
const PASSTHROUGH_MIME: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp'
};

// Own-property lookup: `mime` comes from a File the user picked, so a
// prototype-chain key like "constructor" must not read as a known type.
const hasOwn = (obj: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

type EncodingPlan = { reencode: boolean, mime: string, ext: string };

// The pure decision half of the import pipeline: given the source type and
// pixel dimensions, decide whether the original bytes can be kept and what the
// stored mime/extension will be. Split out from encodeAnnotationImage because
// the encode half needs a browser (ImageBitmap + canvas) and this half is the
// part worth pinning in tests.
const planEncoding = (mime: string, width: number, height: number): EncodingPlan => {
    const passthrough = hasOwn(PASSTHROUGH_MIME, mime);
    const oversized = Math.max(width, height) > MAX_EDGE;
    if (passthrough && !oversized) {
        return { reencode: false, mime, ext: PASSTHROUGH_MIME[mime] };
    }
    return { reencode: true, mime: 'image/jpeg', ext: 'jpg' };
};

// Decode a picked file, downscale/re-encode it if planEncoding says so, and
// return the bytes to store. Browser-only (uses createImageBitmap + canvas).
const encodeAnnotationImage = async (file: File): Promise<{ data: Uint8Array, mime: string, ext: string }> => {
    const bitmap = await createImageBitmap(file);
    try {
        const plan = planEncoding(file.type, bitmap.width, bitmap.height);
        if (!plan.reencode) {
            return { data: new Uint8Array(await file.arrayBuffer()), mime: plan.mime, ext: plan.ext };
        }
        const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            throw new Error('could not acquire a 2d canvas context');
        }
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob | null>((resolve) => {
            canvas.toBlob(resolve, plan.mime, JPEG_QUALITY);
        });
        if (!blob) {
            throw new Error('canvas encoding produced no data');
        }
        return { data: new Uint8Array(await blob.arrayBuffer()), mime: plan.mime, ext: plan.ext };
    } finally {
        bitmap.close();
    }
};

// Session-scoped store for annotation image bytes, keyed by imageId.
//
// Bytes deliberately live OUTSIDE AnnotationData: UpdateAnnotationOp snapshots
// old and new values into the undo stack, so multi-MB buffers there would make
// every caption edit clone the payload. The store is never pruned mid-session,
// which is what makes undoing an image removal restore a working image; only
// images still referenced by a live annotation are written on save or export.
const registerAnnotationImageEvents = (events: Events) => {
    const store = new Map<string, Uint8Array>();
    let nextId = 0;

    events.function('annotationImages.newId', () => `annimg_${nextId++}`);

    events.function('annotationImages.get', (imageId: string) => store.get(imageId) ?? null);

    events.function('annotationImages.has', (imageId: string) => store.has(imageId));

    events.on('annotationImages.put', (imageId: string, data: Uint8Array) => {
        store.set(imageId, data);
        // a loaded document supplies its own ids; keep the counter ahead so a
        // later attach cannot remint an id that is already in use
        const m = /^annimg_(\d+)$/.exec(imageId);
        if (m) {
            nextId = Math.max(nextId, parseInt(m[1], 10) + 1);
        }
    });

    events.on('scene.clear', () => {
        store.clear();
        nextId = 0;
    });
};

export { registerAnnotationImageEvents, encodeAnnotationImage, planEncoding };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/annotation-images.test.ts > /tmp/t1.log 2>&1; tail -30 /tmp/t1.log`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Register on the event bus**

In `src/main.ts`, add the import next to the existing annotations import (line ~6):

```ts
import { registerAnnotationImageEvents } from './annotation-images';
```

and the registration immediately after `registerAnnotationsEvents(events);` (line ~126):

```ts
    registerAnnotationImageEvents(events);
```

- [ ] **Step 6: Lint**

Run: `npm run lint > /tmp/lint.log 2>&1; tail -20 /tmp/lint.log`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/annotation-images.ts test/annotation-images.test.ts src/main.ts
git commit -m "feat(annotations): image byte store and import pipeline"
```

---

### Task 2: Data model — linkType, images, export shape, document round-trip

**Files:**
- Modify: `src/annotations.ts`
- Modify: `test/annotations.test.ts`

**Interfaces:**
- Consumes: Task 1's `annimg_<n>` id format (only as a value; no import).
- Produces:
  - `type AnnotationImage = { imageId: string, ext: string, mime: string, caption: string }`
  - `AnnotationData` gains `linkType: 'none' | 'url' | 'images'` and `images: AnnotationImage[]`
  - Event bus: `annotations.imageRefs` (function → `AnnotationImage[]`, deduplicated by `imageId`, live annotations only)
  - `annotations.export` emits `extras.images?: { src: string, caption: string }[]`

- [ ] **Step 1: Write the failing tests**

Append to `test/annotations.test.ts`. Note the shared `annotation()` factory at the top of that file needs the two new fields — update it first:

```ts
const annotation = (over: Partial<AnnotationData> = {}): AnnotationData => ({
    id: 'annotation_0',
    position: [1, 2, 3],
    title: 'T',
    text: 'X',
    url: '',
    newTab: false,
    linkType: 'none',
    images: [],
    sceneUid: null,
    camera: { position: [0, 0, 0], target: [0, 0, 1], fov: 60 },
    ...over
});

const image = (over: Partial<AnnotationImage> = {}): AnnotationImage => ({
    imageId: 'annimg_0', ext: 'jpg', mime: 'image/jpeg', caption: '', ...over
});
```

and add `AnnotationImage` to the import at the top of the file. Then append:

```ts
describe('annotations.export link exclusivity', () => {
    it('emits url and newTab only when linkType is url', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation({
            linkType: 'url', url: 'https://a.test', newTab: true
        })).do();
        const out = events.invoke('annotations.export');
        expect(out[0].extras.url).toBe('https://a.test');
        expect(out[0].extras.newTab).toBe(true);
        expect(out[0].extras.images).toBeUndefined();
    });

    // The record retains a url while linkType is 'images' so switching modes
    // back and forth loses nothing -- but the export must not leak it.
    it('drops a retained url when linkType is images', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation({
            linkType: 'images', url: 'https://a.test', newTab: true, images: [image()]
        })).do();
        const out = events.invoke('annotations.export');
        expect(out[0].extras.url).toBeUndefined();
        expect(out[0].extras.newTab).toBeUndefined();
        expect(out[0].extras.images).toEqual([{ src: 'annotations/annimg_0.jpg', caption: '' }]);
    });

    it('emits neither when linkType is none', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation({ linkType: 'none', url: 'https://a.test' })).do();
        const out = events.invoke('annotations.export');
        expect(out[0].extras.url).toBeUndefined();
        expect(out[0].extras.images).toBeUndefined();
    });

    // An annotation left in 'images' mode with nothing attached must export as
    // 'none' does -- never falling back to the retained url.
    it('omits images entirely when the list is empty', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation({ linkType: 'images', url: 'https://a.test', images: [] })).do();
        const out = events.invoke('annotations.export');
        expect(out[0].extras.images).toBeUndefined();
        expect(out[0].extras.url).toBeUndefined();
    });

    it('preserves image order and captions', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation({
            linkType: 'images',
            images: [
                image({ imageId: 'annimg_2', ext: 'png', caption: 'second' }),
                image({ imageId: 'annimg_1', caption: 'first' })
            ]
        })).do();
        const out = events.invoke('annotations.export');
        expect(out[0].extras.images).toEqual([
            { src: 'annotations/annimg_2.png', caption: 'second' },
            { src: 'annotations/annimg_1.jpg', caption: 'first' }
        ]);
    });
});

describe('annotations.imageRefs', () => {
    it('collects refs from image-mode annotations only', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation({ id: 'a0', linkType: 'images', images: [image({ imageId: 'annimg_0' })] })).do();
        new AddAnnotationOp(events, annotation({ id: 'a1', linkType: 'url', images: [image({ imageId: 'annimg_9' })] })).do();
        expect(events.invoke('annotations.imageRefs').map((r: AnnotationImage) => r.imageId)).toEqual(['annimg_0']);
    });

    it('deduplicates by imageId', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation({ id: 'a0', linkType: 'images', images: [image(), image()] })).do();
        expect(events.invoke('annotations.imageRefs')).toHaveLength(1);
    });
});

describe('annotations document round-trip', () => {
    it('round-trips linkType and images', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation({
            linkType: 'images', images: [image({ caption: 'hi' })]
        })).do();
        const doc = events.invoke('docSerialize.annotations');
        events.fire('scene.clear');
        events.invoke('docDeserialize.annotations', doc);
        const back = events.invoke('annotations.list')[0];
        expect(back.linkType).toBe('images');
        expect(back.images).toEqual([{ imageId: 'annimg_0', ext: 'jpg', mime: 'image/jpeg', caption: 'hi' }]);
    });

    // Documents written before this feature have neither field.
    it('infers linkType url for a legacy record carrying a url', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        events.invoke('docDeserialize.annotations', [{
            id: 'annotation_0', position: [0, 0, 0], title: 'T', text: '',
            url: 'https://legacy.test', newTab: true,
            camera: { position: [0, 0, 0], target: [0, 0, 1], fov: 60 }
        }]);
        const back = events.invoke('annotations.list')[0];
        expect(back.linkType).toBe('url');
        expect(back.images).toEqual([]);
    });

    it('infers linkType none for a legacy record with no url', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        events.invoke('docDeserialize.annotations', [{
            id: 'annotation_0', position: [0, 0, 0], title: 'T', text: '', url: '', newTab: false,
            camera: { position: [0, 0, 0], target: [0, 0, 1], fov: 60 }
        }]);
        expect(events.invoke('annotations.list')[0].linkType).toBe('none');
    });

    // The serialized images must not alias the live record, or a later edit
    // would mutate the document snapshot in place.
    it('deep-copies images on serialize', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation({ linkType: 'images', images: [image({ caption: 'a' })] })).do();
        const doc = events.invoke('docSerialize.annotations');
        events.fire('annotations.updateRaw', 'annotation_0', { images: [image({ caption: 'b' })] });
        expect(doc[0].images[0].caption).toBe('a');
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/annotations.test.ts > /tmp/t2.log 2>&1; tail -40 /tmp/t2.log`
Expected: FAIL — `AnnotationImage` is not exported, and the new expectations are unmet.

- [ ] **Step 3: Extend the types in `src/annotations.ts`**

Add above `AnnotationData` (after the `AnnotationCamera` type):

```ts
// One attached image. Metadata only: the bytes live in the session store in
// annotation-images.ts, keyed by imageId, because this record is snapshotted
// into the undo stack by UpdateAnnotationOp.
type AnnotationImage = {
    imageId: string,
    ext: string,
    mime: string,
    caption: string     // visible caption AND alt text; may be empty
};
```

Add the two fields to `AnnotationData`, after `newTab`:

```ts
    // Which action this annotation offers in the viewer. `url`/`newTab` and
    // `images` are both retained across a mode switch (so flipping back and
    // forth loses nothing); this field decides which one is live, which is
    // what makes "link or gallery, never both" a property of the data rather
    // than a rule the UI has to police.
    linkType: 'none' | 'url' | 'images',
    images: AnnotationImage[],
```

Extend the export type's `extras`:

```ts
type AnnotationExport = {
    position: [number, number, number],
    title: string,
    text: string,
    camera: { initial: { position: [number, number, number], target: [number, number, number], fov: number } },
    extras: {
        url?: string,
        newTab?: boolean,
        images?: { src: string, caption: string }[],
        scene?: number,
        id?: string
    }
};
```

- [ ] **Step 4: Implement the export shape**

Replace the body of the `annotations.export` map callback's `extras` construction:

```ts
    events.function('annotations.export', (sceneUids?: number[]): AnnotationExport[] => {
        return annotations.map((a) => {
            const scene = resolveAnnotationSceneIndex(a.sceneUid, sceneUids);
            // Emit ONLY the live action. An annotation in 'images' mode with an
            // empty list exports exactly as 'none' does -- it must never fall
            // back to the url the record still carries.
            const isUrl = a.linkType === 'url' && !!a.url;
            const images = (a.linkType === 'images') ?
                a.images.map(img => ({ src: `annotations/${img.imageId}.${img.ext}`, caption: img.caption })) :
                [];
            return {
                position: [a.position[0], a.position[1], a.position[2]],
                title: a.title,
                text: a.text,
                camera: {
                    initial: {
                        position: [a.camera.position[0], a.camera.position[1], a.camera.position[2]],
                        target: [a.camera.target[0], a.camera.target[1], a.camera.target[2]],
                        fov: a.camera.fov
                    }
                },
                extras: {
                    url: isUrl ? a.url : undefined,
                    newTab: isUrl ? a.newTab : undefined,
                    images: images.length ? images : undefined,
                    scene: scene ?? undefined,
                    id: a.id
                }
            };
        });
    });
```

- [ ] **Step 5: Add `annotations.imageRefs`**

Add immediately after the `annotations.export` registration:

```ts
    // Every image still referenced by a live annotation, deduplicated. Used by
    // document save and by the export popups to decide which bytes to emit --
    // images orphaned by an edit are simply never written.
    events.function('annotations.imageRefs', (): AnnotationImage[] => {
        const seen = new Set<string>();
        const refs: AnnotationImage[] = [];
        annotations.forEach((a) => {
            if (a.linkType !== 'images') {
                return;
            }
            a.images.forEach((img) => {
                if (!seen.has(img.imageId)) {
                    seen.add(img.imageId);
                    refs.push(img);
                }
            });
        });
        return refs;
    });
```

- [ ] **Step 6: Extend document serialization**

In `AnnotationDocData`, nothing changes (it spreads `AnnotationData`). In `docSerialize.annotations`, add to the `doc` object literal after `newTab: a.newTab,`:

```ts
                linkType: a.linkType,
                images: a.images.map(img => ({ ...img })),
```

In `docDeserialize.annotations`, add to the pushed record after `newTab: d.newTab ?? false,`:

```ts
                    // legacy documents have neither field: a record carrying a
                    // url was, by definition, a link annotation
                    linkType: d.linkType ?? (d.url ? 'url' : 'none'),
                    images: Array.isArray(d.images) ? d.images.map(img => ({ ...img })) : [],
```

- [ ] **Step 7: Export the new type**

Add `AnnotationImage` to the export list at the bottom of `src/annotations.ts`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/annotations.test.ts > /tmp/t2.log 2>&1; tail -40 /tmp/t2.log`
Expected: PASS, all tests including the pre-existing scene-index suite.

- [ ] **Step 9: Fix the remaining construction site**

`src/tools/annotation-tool.ts` builds an `AnnotationData` literal in `pointerup` and will no longer typecheck. Add the two fields after `newTab: false,`:

```ts
                linkType: 'none',
                images: [],
```

Run: `npx tsc --noEmit > /tmp/tsc.log 2>&1; tail -20 /tmp/tsc.log`
Expected: no errors mentioning `annotations.ts` or `annotation-tool.ts`.

- [ ] **Step 10: Commit**

```bash
git add src/annotations.ts src/tools/annotation-tool.ts test/annotations.test.ts
git commit -m "feat(annotations): linkType selector and image metadata on the annotation record"
```

---

### Task 3: Images dialog

**Files:**
- Create: `src/ui/annotation-images-dialog.ts`
- Modify: `src/ui/editor.ts` (construct + append, beside the other dialogs)
- Modify: `src/ui/scss/annotation-overlay.scss` (dialog-specific rows)
- Modify: `static/locales/en.json` and the other 8 locale files

**Interfaces:**
- Consumes: `AnnotationImage`, `UpdateAnnotationOp` (Task 2); `encodeAnnotationImage`, `annotationImages.newId`, `annotationImages.put`, `annotationImages.get` (Task 1).
- Produces: event `annotation.images.edit` (fired with an annotation id) opens the dialog. The dialog commits a single `UpdateAnnotationOp` on `images`.

- [ ] **Step 1: Add the locale keys**

In `static/locales/en.json`, after `"panel.annotations.scene-none"`:

```json
    "panel.annotations.link-type": "Link Type",
    "panel.annotations.link-type-none": "None",
    "panel.annotations.link-type-url": "External Link",
    "panel.annotations.link-type-images": "Images",
    "panel.annotations.images-edit": "{{count}} images — Edit…",
    "popup.annotation-images.header": "Annotation Images",
    "popup.annotation-images.add": "Add Images…",
    "popup.annotation-images.caption": "Description",
    "popup.annotation-images.caption-placeholder": "Shown under the image; also its alt text",
    "popup.annotation-images.empty": "No images attached yet.",
    "popup.annotation-images.total-size": "Total: {{size}}",
    "popup.annotation-images.decode-failed": "Could not read these files: {{files}}",
    "popup.annotation-images.missing": "missing",
    "tooltip.annotation-images.remove": "Remove",
    "tooltip.annotation-images.move-up": "Move up",
    "tooltip.annotation-images.move-down": "Move down",
    "export.annotation-images-html-warning": "{{count}} annotation galleries will be omitted — use Package (ZIP) to include them.",
```

Add the same keys to `de.json`, `es.json`, `fr.json`, `ja.json`, `ko.json`, `pt-BR.json`, `ru.json`, `zh-CN.json` with translations. French reference values:

```json
    "panel.annotations.link-type": "Type de lien",
    "panel.annotations.link-type-none": "Aucun",
    "panel.annotations.link-type-url": "Lien externe",
    "panel.annotations.link-type-images": "Images",
    "panel.annotations.images-edit": "{{count}} images — Modifier…",
    "popup.annotation-images.header": "Images de l'annotation",
    "popup.annotation-images.add": "Ajouter des images…",
    "popup.annotation-images.caption": "Description",
    "popup.annotation-images.caption-placeholder": "Affichée sous l'image ; sert aussi de texte alternatif",
    "popup.annotation-images.empty": "Aucune image attachée pour l'instant.",
    "popup.annotation-images.total-size": "Total : {{size}}",
    "popup.annotation-images.decode-failed": "Impossible de lire ces fichiers : {{files}}",
    "popup.annotation-images.missing": "manquante",
    "tooltip.annotation-images.remove": "Supprimer",
    "tooltip.annotation-images.move-up": "Monter",
    "tooltip.annotation-images.move-down": "Descendre",
    "export.annotation-images-html-warning": "{{count}} galeries d'annotation seront omises — utilisez le format Package (ZIP) pour les inclure.",
```

Keep each file's existing key ordering style; insert the `panel.*` keys beside the other `panel.annotations.*` keys and the `popup.*`/`export.*` keys beside their own groups.

- [ ] **Step 2: Write the dialog**

Create `src/ui/annotation-images-dialog.ts`:

```ts
import { Button, Container, Label, TextInput } from '@playcanvas/pcui';

import { AnnotationData, AnnotationImage, UpdateAnnotationOp } from '../annotations';
import { encodeAnnotationImage } from '../annotation-images';
import { Events } from '../events';
import { i18n } from './localization';

const formatSize = (bytes: number): string => {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(0)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// Modal editor for one annotation's image list. Edits a working COPY: the whole
// session (adds, caption edits, reorders, removals) commits as a single
// UpdateAnnotationOp, so it is one undo step rather than one per keystroke.
class AnnotationImagesDialog extends Container {
    show: (id: string) => void;
    hide: () => void;

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'annotation-images-dialog',
            class: ['settings-dialog', 'blocks-shortcuts'],
            hidden: true,
            tabIndex: -1
        };

        super(args);

        const dialog = new Container({ id: 'dialog' });

        const headerText = new Label({ id: 'text' });
        i18n.bindText(headerText, 'popup.annotation-images.header');
        const header = new Container({ id: 'header' });
        header.append(headerText);

        const list = new Container({ class: 'annotation-images-list' });
        const emptyLabel = new Label({ class: 'annotation-images-empty' });
        i18n.bindText(emptyLabel, 'popup.annotation-images.empty');

        const totalLabel = new Label({ class: 'annotation-images-total' });

        const addButton = new Button({ class: 'annotation-images-add' });
        i18n.bindText(addButton, 'popup.annotation-images.add');

        // persistent UI strings are bound, never assigned literally (see the
        // note at the top of ui/localization.ts); popup.ok / popup.cancel are
        // the existing generic keys
        const okButton = new Button({ class: 'button' });
        i18n.bindText(okButton, 'popup.ok');
        const cancelButton = new Button({ class: 'button' });
        i18n.bindText(cancelButton, 'popup.cancel');
        const footer = new Container({ id: 'footer' });
        footer.append(cancelButton);
        footer.append(okButton);

        dialog.append(header);
        dialog.append(list);
        dialog.append(emptyLabel);
        dialog.append(addButton);
        dialog.append(totalLabel);
        dialog.append(footer);
        this.append(dialog);

        // --- working state ---

        let annotationId: string | null = null;
        let working: AnnotationImage[] = [];
        // object URLs minted for the row thumbnails; revoked on close so the
        // dialog does not leak a blob per open
        let objectUrls: string[] = [];

        const releaseThumbnails = () => {
            objectUrls.forEach(url => URL.revokeObjectURL(url));
            objectUrls = [];
        };

        const bytesOf = (imageId: string): Uint8Array | null => {
            return events.invoke('annotationImages.get', imageId) as Uint8Array | null;
        };

        const rebuild = () => {
            releaseThumbnails();
            list.clear();

            let total = 0;
            working.forEach((img, index) => {
                const row = new Container({ class: 'annotation-images-row' });

                const data = bytesOf(img.imageId);
                total += data?.length ?? 0;

                const thumb = new Label({ class: 'annotation-images-thumb' });
                if (data) {
                    const url = URL.createObjectURL(new Blob([data as BlobPart], { type: img.mime }));
                    objectUrls.push(url);
                    thumb.dom.style.backgroundImage = `url(${url})`;
                } else {
                    // the document referenced an image whose bytes were not in
                    // the archive: show the row rather than dropping it silently
                    thumb.text = i18n.t('popup.annotation-images.missing');
                }

                const caption = new TextInput({
                    class: 'annotation-images-caption',
                    value: img.caption,
                    placeholder: i18n.t('popup.annotation-images.caption-placeholder')
                });
                caption.on('change', (v: string) => {
                    working[index].caption = v;
                });

                const up = new Button({ class: 'annotation-images-move', text: '▲' });
                up.dom.title = i18n.t('tooltip.annotation-images.move-up');
                up.enabled = index > 0;
                up.on('click', () => {
                    const [moved] = working.splice(index, 1);
                    working.splice(index - 1, 0, moved);
                    rebuild();
                });

                const down = new Button({ class: 'annotation-images-move', text: '▼' });
                down.dom.title = i18n.t('tooltip.annotation-images.move-down');
                down.enabled = index < working.length - 1;
                down.on('click', () => {
                    const [moved] = working.splice(index, 1);
                    working.splice(index + 1, 0, moved);
                    rebuild();
                });

                const remove = new Button({ class: 'annotation-images-remove', text: '✕' });
                remove.dom.title = i18n.t('tooltip.annotation-images.remove');
                remove.on('click', () => {
                    working.splice(index, 1);
                    rebuild();
                });

                row.append(thumb);
                row.append(caption);
                row.append(up);
                row.append(down);
                row.append(remove);
                list.append(row);
            });

            emptyLabel.hidden = working.length > 0;
            totalLabel.text = i18n.t('popup.annotation-images.total-size', { size: formatSize(total) });
        };

        const addFiles = async (files: FileList) => {
            const failed: string[] = [];
            for (const file of Array.from(files)) {
                try {
                    const encoded = await encodeAnnotationImage(file);
                    const imageId = events.invoke('annotationImages.newId') as string;
                    events.fire('annotationImages.put', imageId, encoded.data);
                    working.push({ imageId, ext: encoded.ext, mime: encoded.mime, caption: '' });
                } catch (err) {
                    console.warn(`annotation image import failed for ${file.name}:`, err);
                    failed.push(file.name);
                }
            }
            rebuild();
            if (failed.length > 0) {
                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('popup.annotation-images.header'),
                    message: i18n.t('popup.annotation-images.decode-failed', { files: failed.join(', ') })
                });
            }
        };

        addButton.on('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.multiple = true;
            input.addEventListener('change', () => {
                if (input.files && input.files.length > 0) {
                    addFiles(input.files);
                }
            });
            input.click();
        });

        // --- open / close ---

        this.show = (id: string) => {
            const a = events.invoke('annotations.byId', id) as AnnotationData | null;
            if (!a) {
                return;
            }
            annotationId = id;
            working = a.images.map(img => ({ ...img }));
            rebuild();
            this.hidden = false;
            this.dom.focus();
        };

        this.hide = () => {
            releaseThumbnails();
            this.hidden = true;
            annotationId = null;
        };

        cancelButton.on('click', () => this.hide());

        okButton.on('click', () => {
            const a = annotationId ? (events.invoke('annotations.byId', annotationId) as AnnotationData | null) : null;
            if (a) {
                events.fire('edit.add', new UpdateAnnotationOp(
                    events,
                    a.id,
                    { images: a.images.map(img => ({ ...img })) },
                    { images: working.map(img => ({ ...img })) }
                ));
            }
            this.hide();
        });

        this.dom.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                this.hide();
            }
        });

        events.on('annotation.images.edit', (id: string) => this.show(id));
    }
}

export { AnnotationImagesDialog };
```

- [ ] **Step 3: Style the rows**

Append to `src/ui/scss/annotation-overlay.scss`:

```scss
#annotation-images-dialog {
    .annotation-images-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        max-height: 320px;
        overflow-y: auto;
    }

    .annotation-images-row {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 6px;
    }

    .annotation-images-thumb {
        width: 56px;
        height: 40px;
        flex-shrink: 0;
        border-radius: 2px;
        background-color: #1e1e1e;
        background-size: cover;
        background-position: center;
        text-align: center;
    }

    .annotation-images-caption {
        flex-grow: 1;
    }

    .annotation-images-empty,
    .annotation-images-total {
        display: block;
        margin: 6px 0;
        opacity: 0.7;
    }
}
```

- [ ] **Step 4: Construct and append the dialog**

In `src/ui/editor.ts`, add the import beside the other dialog imports:

```ts
import { AnnotationImagesDialog } from './annotation-images-dialog';
```

after the `videoSettingsDialog` construction (line ~168):

```ts
        // annotation images
        const annotationImagesDialog = new AnnotationImagesDialog(events);
```

and append it beside the others (after `topContainer.append(s3PublishDialog);` and its neighbours):

```ts
        topContainer.append(annotationImagesDialog);
```

- [ ] **Step 5: Verify by hand**

Run: `npm run develop`, open http://localhost:3333, load any splat, place an annotation with the annotation tool, then in the browser console:

```js
window.scene.events.fire('annotation.images.edit', 'annotation_0');
```

(If `window.scene` is not exposed in this build, temporarily invoke it from the annotation tool instead — Task 4 wires the button properly.)

Expected: dialog opens; `Add Images…` accepts a multi-selection; rows show thumbnails; `▲`/`▼` reorder; `✕` removes; the total updates; OK closes it and a subsequent re-open shows the committed list; Ctrl+Z reverts the whole edit in one step.

- [ ] **Step 6: Lint**

Run: `npm run lint > /tmp/lint.log 2>&1; tail -20 /tmp/lint.log`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/ui/annotation-images-dialog.ts src/ui/editor.ts src/ui/scss/annotation-overlay.scss static/locales
git commit -m "feat(annotations): image attachment dialog"
```

---

### Task 4: Toolbar link-type selector

**Files:**
- Modify: `src/tools/annotation-tool.ts`
- Modify: `src/ui/scss/annotation-overlay.scss`

**Interfaces:**
- Consumes: `linkType`/`images` (Task 2), event `annotation.images.edit` (Task 3), locale keys `panel.annotations.link-type*` and `panel.annotations.images-edit` (Task 3).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the controls**

In `src/tools/annotation-tool.ts`, add `Button` to the pcui import (keep the existing alphabetical order within that import):

```ts
import { BooleanInput, Button, Container, Label, SelectInput, TextInput } from '@playcanvas/pcui';
```

Replace the control construction block (currently `urlLabel` through `sceneInput`) with:

```ts
        const linkTypeLabel = new Label({ text: i18n.t('panel.annotations.link-type') });
        const linkTypeInput = new SelectInput({
            type: 'string',
            width: 130,
            options: [
                { v: 'none', t: i18n.t('panel.annotations.link-type-none') },
                { v: 'url', t: i18n.t('panel.annotations.link-type-url') },
                { v: 'images', t: i18n.t('panel.annotations.link-type-images') }
            ]
        });
        const urlLabel = new Label({ text: i18n.t('panel.annotations.url') });
        const urlInput = new TextInput({ class: 'annotations-toolbar-input', placeholder: 'https://' });
        const newTabLabel = new Label({ text: i18n.t('panel.annotations.new-tab') });
        const newTabInput = new BooleanInput({ type: 'toggle' });
        const imagesButton = new Button({ class: 'annotations-toolbar-button' });
        const sceneLabel = new Label({ text: i18n.t('panel.annotations.scene') });
        const sceneInput = new SelectInput({ type: 'number', options: [], width: 140 });
```

Replace the append block with:

```ts
        bar.append(titleLabel);
        bar.append(titleInput);
        bar.append(textLabel);
        bar.append(textInput);
        bar.append(linkTypeLabel);
        bar.append(linkTypeInput);
        bar.append(urlLabel);
        bar.append(urlInput);
        bar.append(newTabLabel);
        bar.append(newTabInput);
        bar.append(imagesButton);
        bar.append(sceneLabel);
        bar.append(sceneInput);
        canvasContainer.append(bar);
```

- [ ] **Step 2: Drive visibility from linkType**

In `refreshBar`, after `newTabInput.value = a.newTab;` insert:

```ts
            const linkType = a.linkType ?? 'none';
            linkTypeInput.value = linkType;
            // exactly one action is live at a time: the selector swaps the tail
            // of the bar rather than the two ever being visible together
            urlLabel.hidden = linkType !== 'url';
            urlInput.hidden = linkType !== 'url';
            newTabLabel.hidden = linkType !== 'url';
            newTabInput.hidden = linkType !== 'url';
            imagesButton.hidden = linkType !== 'images';
            imagesButton.text = i18n.t('panel.annotations.images-edit', { count: a.images.length });
```

- [ ] **Step 3: Wire the handlers**

Add beside the other input handlers:

```ts
        linkTypeInput.on('change', (v: string) => commit('linkType', v));
        imagesButton.on('click', () => {
            const a = selected();
            if (a) {
                events.fire('annotation.images.edit', a.id);
            }
        });
```

- [ ] **Step 4: Style the button**

In `src/ui/scss/annotation-overlay.scss`, inside the existing `.annotations-toolbar` block, after the `.annotations-toolbar-input` rule:

```scss
    .annotations-toolbar-button {
        white-space: nowrap;
    }
```

- [ ] **Step 5: Verify by hand**

Run: `npm run develop`, open http://localhost:3333, load a splat, activate the annotation tool, place an annotation.

Expected: the bar shows `Link Type [None]` and no URL field. Selecting `External Link` reveals URL + Open in New Tab; typing a URL and switching to `Images` hides them and shows `0 images — Edit…`; the button opens the dialog; adding two images makes the button read `2 images — Edit…`; switching back to `External Link` shows the URL still there. Ctrl+Z steps back through each change.

- [ ] **Step 6: Lint**

Run: `npm run lint > /tmp/lint.log 2>&1; tail -20 /tmp/lint.log`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/tools/annotation-tool.ts src/ui/scss/annotation-overlay.scss
git commit -m "feat(annotations): link-type selector in the annotation toolbar"
```

---

### Task 5: Project persistence

**Files:**
- Modify: `src/doc.ts`

**Interfaces:**
- Consumes: `annotations.imageRefs` (Task 2), `annotationImages.get` / `annotationImages.put` (Task 1).
- Produces: `.ssproj` entries at `annotations/<imageId>.<ext>`.

- [ ] **Step 1: Write image entries on save**

In `saveDocument`, after the splat PLY loop and before `await zipFs.close();`:

```ts
            // Attached annotation images, one ZIP entry each. Only images still
            // referenced by a live annotation are written -- the session store
            // keeps orphans alive purely so undo can bring them back.
            const imageRefs = events.invoke('annotations.imageRefs') ?? [];
            for (const ref of imageRefs) {
                const data = events.invoke('annotationImages.get', ref.imageId) as Uint8Array | null;
                if (!data) {
                    continue;
                }
                const imageWriter = await zipFs.createWriter(`annotations/${ref.imageId}.${ref.ext}`);
                await imageWriter.write(data);
                await imageWriter.close();
            }
```

- [ ] **Step 2: Read image entries on load**

In `loadDocument`, immediately after the `docDeserialize.annotations` invocation:

```ts
            // Attached annotation images. The metadata came back with the
            // annotations above, so imageRefs now lists exactly what to read.
            // A missing entry is not fatal: the dialog shows the row as missing
            // and export skips it, which beats failing the whole load.
            for (const ref of (events.invoke('annotations.imageRefs') ?? [])) {
                const entry = `annotations/${ref.imageId}.${ref.ext}`;
                try {
                    const imageSource = await zipFs.createSource(entry);
                    const imageData = await imageSource.read().readAll();
                    imageSource.close();
                    events.fire('annotationImages.put', ref.imageId, imageData);
                } catch (err) {
                    console.warn(`annotation image ${entry} is missing from the document:`, err);
                }
            }
```

- [ ] **Step 3: Verify by hand**

Run: `npm run develop`, load a splat, attach 2 images with captions to an annotation, save the project, then use `File > New` and re-open the saved `.ssproj`.

Expected: the annotation still reads `2 images — Edit…`, the dialog shows both thumbnails in order with their captions. Unzipping the `.ssproj` shows `annotations/annimg_0.jpg` and `annotations/annimg_1.jpg`.

- [ ] **Step 4: Confirm orphans are not written**

In the same session, remove one image, save to a new file, and unzip it.
Expected: only the remaining image's entry is present.

- [ ] **Step 5: Lint**

Run: `npm run lint > /tmp/lint.log 2>&1; tail -20 /tmp/lint.log`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/doc.ts
git commit -m "feat(annotations): persist attached images in the project archive"
```

---

### Task 6: Viewer carousel companion

**Files:**
- Create: `src/viewer-companion/annotation-gallery.ts`
- Create: `test/annotation-gallery.test.ts`

**Interfaces:**
- Consumes: the export shape `extras.images: { src, caption }[]` (Task 2).
- Produces:
  - `galleryStyle: string` — CSS text for the modal.
  - `galleryRuntime: string` — JS source defining `openGallery(images, returnFocusEl)` and `closeGallery()`, intended to be interpolated INSIDE the annotation-links IIFE (Task 7).
  - `hasGallery(annotations: AnyAnnotation[]): boolean`.

- [ ] **Step 1: Write the failing test**

Create `test/annotation-gallery.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import { galleryRuntime, galleryStyle, hasGallery } from '../src/viewer-companion/annotation-gallery';

describe('hasGallery', () => {
    it('is true when any annotation carries images', () => {
        expect(hasGallery([{ extras: {} }, { extras: { images: [{ src: 'a.jpg', caption: '' }] } }])).toBe(true);
    });

    it('is false for an empty image list', () => {
        expect(hasGallery([{ extras: { images: [] } }])).toBe(false);
    });

    it('is false when no annotation has images', () => {
        expect(hasGallery([{ extras: { url: 'https://a.test' } }, {}])).toBe(false);
    });
});

// The runtime ships as a string, so the honest test is to run it. These fakes
// cover only the DOM surface openGallery touches.
class FakeEl {
    children: FakeEl[] = [];
    parent: FakeEl = null;
    className = '';
    textContent = '';
    src = '';
    alt = '';
    tabIndex = 0;
    disabled = false;
    hidden = false;
    style: Record<string, string> = {};
    listeners: Record<string, ((e: any) => void)[]> = {};
    private attrs: Record<string, string> = {};
    focused = false;

    constructor(public tagName: string) {}

    appendChild(child: FakeEl) {
        child.parent = this;
        this.children.push(child);
        return child;
    }

    remove() {
        const i = this.parent?.children.indexOf(this) ?? -1;
        if (i >= 0) {
            this.parent.children.splice(i, 1);
            this.parent = null;
        }
    }

    matches(selector: string) {
        return this.className.split(/\s+/).includes(selector.replace(/^\./, ''));
    }

    findAll(selector: string): FakeEl[] {
        const out: FakeEl[] = [];
        for (const child of this.children) {
            if (child.matches(selector)) {
                out.push(child);
            }
            out.push(...child.findAll(selector));
        }
        return out;
    }

    querySelector(selector: string) {
        return this.findAll(selector)[0] ?? null;
    }

    querySelectorAll(selector: string) {
        return this.findAll(selector);
    }

    addEventListener(name: string, fn: (e: any) => void) {
        (this.listeners[name] ??= []).push(fn);
    }

    dispatch(name: string, e: any = {}) {
        const ev = { stopPropagation: () => {}, preventDefault: () => {}, target: this, ...e };
        (this.listeners[name] ?? []).forEach(fn => fn(ev));
    }

    focus() {
        this.focused = true;
    }

    setAttribute(k: string, v: string) {
        this.attrs[k] = v;
    }

    getAttribute(k: string) {
        return this.attrs[k] ?? null;
    }
}

// Execute the runtime and hand back its openGallery/closeGallery.
const loadRuntime = () => {
    const body = new FakeEl('body');
    const document = {
        body,
        createElement: (tag: string) => new FakeEl(tag),
        addEventListener: () => {}
    };
    // eslint-disable-next-line no-new-func
    const factory = new Function('document', 'navigator', `${galleryRuntime}\nreturn { openGallery: openGallery, closeGallery: closeGallery };`);
    return { body, ...factory(document, { language: 'en' }) };
};

const IMAGES = [
    { src: 'annotations/annimg_0.jpg', caption: 'first' },
    { src: 'annotations/annimg_1.jpg', caption: 'second' },
    { src: 'annotations/annimg_2.jpg', caption: 'third' }
];

const overlayIn = (body: FakeEl) => body.querySelector('.ss-gallery');

describe('gallery runtime', () => {
    it('mounts an overlay on the body showing the first image', () => {
        const { body, openGallery } = loadRuntime();
        openGallery(IMAGES, null);
        const overlay = overlayIn(body);
        expect(overlay).not.toBeNull();
        expect(overlay.querySelector('.ss-gallery-img').src).toBe('annotations/annimg_0.jpg');
        expect(overlay.querySelector('.ss-gallery-caption').textContent).toBe('first');
    });

    it('uses the caption as alt text', () => {
        const { body, openGallery } = loadRuntime();
        openGallery(IMAGES, null);
        expect(overlayIn(body).querySelector('.ss-gallery-img').alt).toBe('first');
    });

    it('advances and rewinds without wrapping', () => {
        const { body, openGallery } = loadRuntime();
        openGallery(IMAGES, null);
        const overlay = overlayIn(body);
        const next = overlay.querySelector('.ss-gallery-next');
        const prev = overlay.querySelector('.ss-gallery-prev');

        expect(prev.disabled).toBe(true);
        next.dispatch('click');
        expect(overlay.querySelector('.ss-gallery-img').src).toBe('annotations/annimg_1.jpg');
        expect(overlay.querySelector('.ss-gallery-counter').textContent).toBe('2 / 3');
        next.dispatch('click');
        expect(next.disabled).toBe(true);
        next.dispatch('click');
        expect(overlay.querySelector('.ss-gallery-img').src).toBe('annotations/annimg_2.jpg');
        prev.dispatch('click');
        expect(overlay.querySelector('.ss-gallery-img').src).toBe('annotations/annimg_1.jpg');
    });

    it('navigates with the arrow keys', () => {
        const { body, openGallery } = loadRuntime();
        openGallery(IMAGES, null);
        const overlay = overlayIn(body);
        overlay.dispatch('keydown', { key: 'ArrowRight' });
        expect(overlay.querySelector('.ss-gallery-img').src).toBe('annotations/annimg_1.jpg');
        overlay.dispatch('keydown', { key: 'ArrowLeft' });
        expect(overlay.querySelector('.ss-gallery-img').src).toBe('annotations/annimg_0.jpg');
    });

    it('omits navigation entirely for a single image', () => {
        const { body, openGallery } = loadRuntime();
        openGallery([IMAGES[0]], null);
        const overlay = overlayIn(body);
        expect(overlay.querySelector('.ss-gallery-next')).toBeNull();
        expect(overlay.querySelector('.ss-gallery-prev')).toBeNull();
        expect(overlay.querySelector('.ss-gallery-counter')).toBeNull();
        expect(overlay.querySelectorAll('.ss-gallery-dot')).toHaveLength(0);
    });

    it('renders one dot per image and marks the active one', () => {
        const { body, openGallery } = loadRuntime();
        openGallery(IMAGES, null);
        const overlay = overlayIn(body);
        const dots = overlay.querySelectorAll('.ss-gallery-dot');
        expect(dots).toHaveLength(3);
        expect(dots[0].className).toContain('ss-gallery-dot-on');
        dots[2].dispatch('click');
        expect(overlay.querySelector('.ss-gallery-img').src).toBe('annotations/annimg_2.jpg');
    });

    it('closes on Escape and restores focus', () => {
        const chip = new FakeEl('a');
        const { body, openGallery } = loadRuntime();
        openGallery(IMAGES, chip);
        overlayIn(body).dispatch('keydown', { key: 'Escape' });
        expect(overlayIn(body)).toBeNull();
        expect(chip.focused).toBe(true);
    });

    it('closes on a backdrop click but not on a click inside the frame', () => {
        const { body, openGallery } = loadRuntime();
        openGallery(IMAGES, null);
        const overlay = overlayIn(body);
        overlay.dispatch('click', { target: overlay.querySelector('.ss-gallery-frame') });
        expect(overlayIn(body)).not.toBeNull();
        overlay.dispatch('click', { target: overlay });
        expect(overlayIn(body)).toBeNull();
    });

    it('closes on the close button', () => {
        const { body, openGallery } = loadRuntime();
        openGallery(IMAGES, null);
        overlayIn(body).querySelector('.ss-gallery-close').dispatch('click');
        expect(overlayIn(body)).toBeNull();
    });

    it('never stacks two overlays', () => {
        const { body, openGallery } = loadRuntime();
        openGallery(IMAGES, null);
        openGallery(IMAGES, null);
        expect(body.querySelectorAll('.ss-gallery')).toHaveLength(1);
    });

    it('closeGallery is a no-op when nothing is open', () => {
        const { body, closeGallery } = loadRuntime();
        expect(() => closeGallery()).not.toThrow();
        expect(overlayIn(body)).toBeNull();
    });

    // Build-time trap: template literals in this directory eat backslash
    // escapes, so a regex literal or a "\n" in the runtime would ship broken.
    it('contains no backslash escapes that the build would eat', () => {
        expect(galleryRuntime.includes('\\')).toBe(false);
    });
});

describe('galleryStyle', () => {
    it('styles the overlay above the viewer UI', () => {
        expect(galleryStyle).toContain('.ss-gallery');
        expect(galleryStyle).toContain('z-index');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/annotation-gallery.test.ts > /tmp/t6.log 2>&1; tail -30 /tmp/t6.log`
Expected: FAIL — cannot resolve `../src/viewer-companion/annotation-gallery`.

- [ ] **Step 3: Write the module**

Create `src/viewer-companion/annotation-gallery.ts`:

```ts
// Modal image carousel for the exported viewer.
//
// The chip that opens this lives in the shared annotation tooltip and is owned
// by annotation-links.ts; this module supplies only the modal. The runtime is
// written to be interpolated INSIDE that companion's IIFE, so it defines plain
// functions (openGallery / closeGallery) rather than an IIFE of its own.
//
// The modal mounts on document.body, NOT inside the tooltip: .pc-annotation is
// pointer-events:none and its contents are rewritten on every activation.
//
// BUILD TRAP: template literals in this directory have their backslash escapes
// eaten at build time, so the runtime below contains no regex literals and no
// backslash escapes of any kind -- including in strings. Unicode glyphs are
// written literally.

type AnyAnnotation = {
    extras?: { images?: { src: string, caption: string }[] }
};

// Does any annotation carry a non-empty gallery? Half of the injection gate in
// annotation-links.ts (the other half being "any annotation carries a url").
const hasGallery = (annotations: AnyAnnotation[]): boolean => {
    return (annotations || []).some(a => (a.extras?.images?.length ?? 0) > 0);
};

const galleryRuntime = `
  var galleryLabels = {
    en: { close: 'Close', prev: 'Previous image', next: 'Next image', gallery: 'Image gallery' },
    de: { close: 'Schließen', prev: 'Vorheriges Bild', next: 'Nächstes Bild', gallery: 'Bildergalerie' },
    es: { close: 'Cerrar', prev: 'Imagen anterior', next: 'Imagen siguiente', gallery: 'Galería de imágenes' },
    fr: { close: 'Fermer', prev: 'Image précédente', next: 'Image suivante', gallery: 'Galerie d’images' },
    ja: { close: '閉じる', prev: '前の画像', next: '次の画像', gallery: '画像ギャラリー' },
    ko: { close: '닫기', prev: '이전 이미지', next: '다음 이미지', gallery: '이미지 갤러리' },
    pt: { close: 'Fechar', prev: 'Imagem anterior', next: 'Próxima imagem', gallery: 'Galeria de imagens' },
    ru: { close: 'Закрыть', prev: 'Предыдущее изображение', next: 'Следующее изображение', gallery: 'Галерея изображений' },
    zh: { close: '关闭', prev: '上一张图片', next: '下一张图片', gallery: '图片库' }
  };
  var galleryLang = (navigator.language || 'en').toLowerCase();
  var galleryText = galleryLabels[galleryLang] || galleryLabels[galleryLang.split('-')[0]] || galleryLabels.en;

  // At most one modal at a time; also lets the companion close the gallery when
  // the annotation it belongs to is deactivated.
  var openOverlay = null;
  var openReturnFocus = null;

  function closeGallery() {
    if (!openOverlay) return;
    openOverlay.remove();
    openOverlay = null;
    if (openReturnFocus && openReturnFocus.focus) openReturnFocus.focus();
    openReturnFocus = null;
  }

  function makeButton(cls, glyph, label) {
    var b = document.createElement('button');
    b.className = cls;
    b.textContent = glyph;
    b.setAttribute('aria-label', label);
    return b;
  }

  function openGallery(images, returnFocusEl) {
    closeGallery();
    var index = 0;
    var multiple = images.length > 1;

    var overlay = document.createElement('div');
    overlay.className = 'ss-gallery';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', galleryText.gallery);
    overlay.tabIndex = -1;

    var close = makeButton('ss-gallery-close', '✕', galleryText.close);
    overlay.appendChild(close);

    var counter = null;
    if (multiple) {
      counter = document.createElement('div');
      counter.className = 'ss-gallery-counter';
      overlay.appendChild(counter);
    }

    var frame = document.createElement('div');
    frame.className = 'ss-gallery-frame';
    var img = document.createElement('img');
    img.className = 'ss-gallery-img';
    frame.appendChild(img);

    var prev = null;
    var next = null;
    if (multiple) {
      prev = makeButton('ss-gallery-nav ss-gallery-prev', '‹', galleryText.prev);
      next = makeButton('ss-gallery-nav ss-gallery-next', '›', galleryText.next);
      frame.appendChild(prev);
      frame.appendChild(next);
    }
    overlay.appendChild(frame);

    var caption = document.createElement('div');
    caption.className = 'ss-gallery-caption';
    overlay.appendChild(caption);

    var dots = [];
    if (multiple) {
      var dotRow = document.createElement('div');
      dotRow.className = 'ss-gallery-dots';
      for (var i = 0; i < images.length; i++) {
        var dot = document.createElement('button');
        dot.className = 'ss-gallery-dot';
        dot.setAttribute('aria-label', String(i + 1));
        dotRow.appendChild(dot);
        dots.push(dot);
      }
      overlay.appendChild(dotRow);
    }

    function show(i) {
      index = i;
      var entry = images[i] || {};
      img.src = entry.src || '';
      // caption doubles as alt text; textContent (never innerHTML) because it
      // is user-authored
      img.alt = entry.caption || '';
      caption.textContent = entry.caption || '';
      if (counter) counter.textContent = (i + 1) + ' / ' + images.length;
      if (prev) prev.disabled = i === 0;
      if (next) next.disabled = i === images.length - 1;
      for (var d = 0; d < dots.length; d++) {
        dots[d].className = (d === i) ? 'ss-gallery-dot ss-gallery-dot-on' : 'ss-gallery-dot';
      }
    }

    function step(delta) {
      var target = index + delta;
      if (target < 0 || target > images.length - 1) return;
      show(target);
    }

    close.addEventListener('click', function (e) { e.stopPropagation(); closeGallery(); });
    if (prev) prev.addEventListener('click', function (e) { e.stopPropagation(); step(-1); });
    if (next) next.addEventListener('click', function (e) { e.stopPropagation(); step(1); });
    for (var k = 0; k < dots.length; k++) {
      (function (target) {
        dots[target].addEventListener('click', function (e) { e.stopPropagation(); show(target); });
      })(k);
    }

    // Backdrop click closes; a click on the image or controls must not.
    overlay.addEventListener('click', function (e) {
      e.stopPropagation();
      if (e.target === overlay) closeGallery();
    });

    // The viewer drives its camera from document-level input, so every event
    // that starts inside the modal stops here.
    overlay.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Escape') { closeGallery(); return; }
      if (e.key === 'ArrowLeft') { step(-1); return; }
      if (e.key === 'ArrowRight') { step(1); }
    });
    overlay.addEventListener('keyup', function (e) { e.stopPropagation(); });
    overlay.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    overlay.addEventListener('pointerup', function (e) { e.stopPropagation(); });
    overlay.addEventListener('wheel', function (e) { e.stopPropagation(); });
    overlay.addEventListener('contextmenu', function (e) { e.stopPropagation(); });

    show(0);
    document.body.appendChild(overlay);
    openOverlay = overlay;
    openReturnFocus = returnFocusEl || null;
    overlay.focus();
  }
`;

const galleryStyle = `
.ss-gallery {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  background: rgba(0,0,0,0.82);
  pointer-events: auto;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
}
.ss-gallery-frame { position: relative; display: flex; align-items: center; justify-content: center; max-width: 90vw; }
.ss-gallery-img { max-width: 88vw; max-height: 70vh; border-radius: 3px; display: block; }
.ss-gallery-caption { color: #e8e8e8; font-size: 14px; line-height: 1.45; text-align: center; max-width: 70ch; }
.ss-gallery-counter { position: absolute; top: 14px; left: 16px; color: #fff; font-size: 13px; opacity: 0.7; }
.ss-gallery-close {
  position: absolute; top: 10px; right: 12px; width: 34px; height: 34px;
  border: none; border-radius: 50%; background: rgba(0,0,0,0.4);
  color: #fff; font-size: 17px; cursor: pointer;
}
.ss-gallery-nav {
  position: absolute; top: 50%; transform: translateY(-50%);
  width: 40px; height: 40px; border-radius: 50%;
  background: rgba(0,0,0,0.55); border: 1px solid rgba(255,255,255,0.25);
  color: #fff; font-size: 20px; line-height: 1; cursor: pointer;
}
.ss-gallery-nav:disabled { opacity: 0.25; cursor: default; }
.ss-gallery-prev { left: -52px; }
.ss-gallery-next { right: -52px; }
.ss-gallery-dots { display: flex; gap: 7px; }
.ss-gallery-dot {
  width: 8px; height: 8px; padding: 0; border: none; border-radius: 50%;
  background: rgba(255,255,255,0.3); cursor: pointer;
}
.ss-gallery-dot-on { background: #fff; }
@media (max-width: 720px) {
  .ss-gallery-prev { left: 6px; }
  .ss-gallery-next { right: 6px; }
  .ss-gallery-img { max-height: 60vh; }
}
`;

export { galleryRuntime, galleryStyle, hasGallery };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/annotation-gallery.test.ts > /tmp/t6.log 2>&1; tail -40 /tmp/t6.log`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Lint**

Run: `npm run lint > /tmp/lint.log 2>&1; tail -20 /tmp/lint.log`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/viewer-companion/annotation-gallery.ts test/annotation-gallery.test.ts
git commit -m "feat(viewer): image carousel modal for the exported viewer"
```

---

### Task 7: Tooltip chip precedence

**Files:**
- Modify: `src/viewer-companion/annotation-links.ts`
- Modify: `test/annotation-links.test.ts`

**Interfaces:**
- Consumes: `galleryRuntime`, `galleryStyle`, `hasGallery` (Task 6).
- Produces: `buildAnnotationLinksInjection` now emits when any annotation has a url **or** images; the chip opens the carousel for image annotations.

- [ ] **Step 1: Write the failing tests**

Append to `test/annotation-links.test.ts`. First extend the fake element class so the runtime's gallery code can run against it — add these members to `FakeEl`:

```ts
    src = '';
    alt = '';
    tabIndex = 0;
    disabled = false;
    style: Record<string, string> = {};
    listeners: Record<string, ((e: any) => void)[]> = {};
    focused = false;

    dispatch(name: string, e: any = {}) {
        const ev = { stopPropagation: () => {}, preventDefault: () => {}, target: this, ...e };
        (this.listeners[name] ?? []).forEach(fn => fn(ev));
    }

    focus() {
        this.focused = true;
    }
```

and replace the existing no-op `addEventListener() {}` with:

```ts
    addEventListener(name: string, fn: (e: any) => void) {
        (this.listeners[name] ??= []).push(fn);
    }
```

Then append the new suite:

```ts
describe('annotation chip precedence', () => {
    const gallery = [{ src: 'annotations/annimg_0.jpg', caption: 'one' }, { src: 'annotations/annimg_1.jpg', caption: 'two' }];

    it('is injected when an annotation has images but no url', () => {
        expect(buildAnnotationLinksInjection([{ title: 'a', extras: { images: gallery } }])).not.toBe('');
    });

    it('shows a gallery chip for an image annotation', () => {
        const annotations = [{ title: 'a', text: '', extras: { images: gallery } }];
        const viewer = makeViewer();
        expect(runCompanion(annotations, viewer)).toBe(true);

        viewer.events.fire('annotation.activate', annotations[0]);

        const chip = linkIn(viewer);
        expect(chip).not.toBeNull();
        expect(chip.textContent).toContain('2');
    });

    it('opens the carousel when the chip is clicked', () => {
        const annotations = [{ title: 'a', text: '', extras: { images: gallery } }];
        const viewer = makeViewer();
        runCompanion(annotations, viewer);
        viewer.events.fire('annotation.activate', annotations[0]);

        linkIn(viewer).dispatch('click');

        expect(viewer.root.querySelector('.ss-gallery')).not.toBeNull();
    });

    // Only the editor's linkType can produce one of these, but the runtime must
    // still resolve deterministically if a hand-edited export carries both.
    it('prefers the gallery when an annotation carries both', () => {
        const annotations = [{ title: 'a', text: '', extras: { url: 'https://a.test', images: gallery } }];
        const viewer = makeViewer();
        runCompanion(annotations, viewer);
        viewer.events.fire('annotation.activate', annotations[0]);

        linkIn(viewer).dispatch('click');

        expect(viewer.root.querySelector('.ss-gallery')).not.toBeNull();
    });

    it('closes an open carousel when the annotation is deactivated', () => {
        const annotations = [{ title: 'a', text: '', extras: { images: gallery } }];
        const viewer = makeViewer();
        runCompanion(annotations, viewer);
        viewer.events.fire('annotation.activate', annotations[0]);
        linkIn(viewer).dispatch('click');

        viewer.events.fire('annotation.deactivate');

        expect(viewer.root.querySelector('.ss-gallery')).toBeNull();
    });

    it('swaps a gallery chip for a link chip across activations', () => {
        const annotations = [
            { title: 'a', text: '', extras: { images: gallery } },
            { title: 'b', text: '', extras: { url: 'https://b.test' } }
        ];
        const viewer = makeViewer();
        runCompanion(annotations, viewer);

        viewer.events.fire('annotation.activate', annotations[0]);
        viewer.events.fire('annotation.activate', annotations[1]);

        expect(viewer.tooltip.querySelectorAll('.ss-annotation-link')).toHaveLength(1);
        expect(linkIn(viewer).href).toBe('https://b.test/');
    });

    // Captions ride in the viewer's settings JSON, not in this injection --
    // this pins that they never leak into it unescaped.
    it('never emits a raw script breakout from a hostile caption', () => {
        const injection = buildAnnotationLinksInjection([{
            title: 'a',
            extras: { images: [{ src: 'annotations/annimg_0.jpg', caption: '</script><b>$&' }] }
        }]);
        expect(injection).not.toContain('</script><b>');
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/annotation-links.test.ts > /tmp/t7.log 2>&1; tail -40 /tmp/t7.log`
Expected: FAIL — the gallery chip and `.ss-gallery` do not exist.

- [ ] **Step 3: Widen the injection gate and bake the gallery table**

In `src/viewer-companion/annotation-links.ts`, extend the local type and add the import:

```ts
import { galleryRuntime, galleryStyle, hasGallery } from './annotation-gallery';

type AnyAnnotation = {
    title?: string,
    text?: string,
    extras?: { url?: string, newTab?: boolean, images?: { src: string, caption: string }[] }
};
```

Replace `buildAnnotationLinksInjection` with:

```ts
const buildAnnotationLinksInjection = (annotations: AnyAnnotation[]): string => {
    const list = annotations || [];
    const table = buildLinkTable(list);
    // Gate on either action: a gallery-only export has an empty link table but
    // still needs the companion.
    if (table.length === 0 && !hasGallery(list)) {
        return '';
    }
    // LEAVE THE FIVE EXISTING .replace LINES BELOW EXACTLY AS THEY ARE IN THE
    // FILE — do not retype them. Two of them match the U+2028 / U+2029 line and
    // paragraph separators, which are trivially mangled into literal separator
    // characters when copied by hand. Only the gate above and the <style> line
    // below change in this step.
    const tableJson = JSON.stringify(table)
    ... (the five existing .replace lines, untouched) ...
    return `<style>${companionStyle}${galleryStyle}</style>` +
        `<script>window.__supersplatAnnotationLinks = ${tableJson};</script>` +
        `<script>${companionRuntime}</script>`;
};
```

Captions are deliberately NOT baked into this injection: they reach the runtime
through the viewer's own settings JSON, via each annotation's `extras`, which
writeHtml escapes. That is why the matching test below asserts only that no raw
`</script>` breakout appears in the injection.

- [ ] **Step 4: Rewrite the chip logic in the runtime**

In `companionRuntime`, interpolate the gallery runtime near the top (immediately after the `openLinkLabels`/`openLinkText` block) and add the gallery chip label table:

```js
  ${galleryRuntime}

  var viewImagesLabels = {
    en: 'View images', de: 'Bilder ansehen', es: 'Ver imágenes', fr: 'Voir les images',
    ja: '画像を見る', ko: '이미지 보기', pt: 'Ver imagens', ru: 'Смотреть изображения',
    zh: '查看图片'
  };
  var viewImagesText = viewImagesLabels[navLang] || viewImagesLabels[navLang.split('-')[0]] || viewImagesLabels.en;
```

Delete the early return `if (!links.length) return;` and replace it with a comment:

```js
  // No early return on an empty link table: a gallery-only export legitimately
  // has none. The build-time gate in buildAnnotationLinksInjection already
  // decided this companion was worth injecting.
```

Replace `injectLink` with a chip builder handling both actions:

```js
  // Inject (or refresh) the action chip inside the shared tooltip for the given
  // annotation. Passing null just clears any previously injected chip.
  function injectChip(ann) {
    var tip = document.querySelector('.pc-annotation');
    if (!tip) return;
    var existing = tip.querySelector('.ss-annotation-link');
    if (existing) existing.remove();
    if (!ann) return;
    var extras = ann.extras || {};
    var images = extras.images;
    if (images && images.length) {
      var chip = document.createElement('a');
      chip.className = 'ss-annotation-link';
      chip.href = '#';
      chip.textContent = viewImagesText + ' (' + images.length + ')';
      chip.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openGallery(images, chip);
      });
      tip.appendChild(chip);
      return;
    }
    var url = extras.url;
    var href = url ? safeHref(url) : null;
    if (!href) return;
    var a = document.createElement('a');
    a.className = 'ss-annotation-link';
    a.href = href;
    a.textContent = openLinkText;
    if (extras.newTab) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    // keep the tooltip open (the viewer closes it on document click) and let
    // the navigation proceed normally
    a.addEventListener('click', function (e) { e.stopPropagation(); });
    tip.appendChild(a);
  }
```

and update the two subscriptions in `start()`:

```js
    ev.on('annotation.activate', function (ann) {
      closeGallery();
      injectChip(ann);
    });
    ev.on('annotation.deactivate', function () {
      closeGallery();
      injectChip(null);
    });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/annotation-links.test.ts > /tmp/t7.log 2>&1; tail -40 /tmp/t7.log`
Expected: PASS, including all pre-existing link tests.

- [ ] **Step 6: Run the whole front-end suite**

Run: `npm run test > /tmp/all.log 2>&1; tail -30 /tmp/all.log`
Expected: all suites pass.

- [ ] **Step 7: Lint and commit**

```bash
npm run lint > /tmp/lint.log 2>&1; tail -20 /tmp/lint.log
git add src/viewer-companion/annotation-links.ts test/annotation-links.test.ts
git commit -m "feat(viewer): gallery chip in the annotation tooltip"
```

---

### Task 8: Local export plumbing

**Files:**
- Modify: `src/splat-export-core.ts`
- Modify: `src/splat-serialize.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks at runtime (pure plumbing).
- Produces:
  - `type AnnotationImageFile = { path: string; data: Uint8Array }` (exported from `src/splat-export-core.ts`)
  - `writeViewerCore(..., posterBytes?, favicon?, annotationImages?)` — a new 13th trailing parameter.
  - `ViewerExportSettings.annotationImages?: AnnotationImageFile[]`

- [ ] **Step 1: Add the emitter to `src/splat-export-core.ts`**

After `applyFavicon`, add:

```ts
// Attached annotation images for ZIP exports: emitted beside the viewer at the
// export-derived paths baked into each annotation's extras (annotations/<id>.<ext>).
// Mirrors applyFavicon -- every memFs entry is zipped by the callers below, and
// the S3 publish path uploads every ZIP entry, so this one insertion point
// serves package, streaming and publish alike. The single-file HTML path has
// nowhere to put them and ignores this.
type AnnotationImageFile = { path: string; data: Uint8Array };

const applyAnnotationImages = (
    annotationImages: AnnotationImageFile[] | undefined,
    memFs: { results: Map<string, Uint8Array> }
): void => {
    (annotationImages ?? []).forEach((img) => {
        memFs.results.set(img.path, img.data);
    });
};
```

- [ ] **Step 2: Thread the parameter**

Add `annotationImages?: AnnotationImageFile[]` as the last parameter of both `writeStreamingViewerCore` and `writeViewerCore`.

In `writeStreamingViewerCore`, call it just before the ZIP loop (after `patchEngineLoaderInMemFs(memFs);`):

```ts
    applyAnnotationImages(annotationImages, memFs);
```

In `writeViewerCore`'s package branch, add the same line after `patchEngineLoaderInMemFs(memFs);`, and forward the parameter on the streaming branch:

```ts
            await writeStreamingViewerCore(dataTable, viewerSettingsJson, createDevice, fs, events, onLog, shouldCancel, collision, extraScenes, posterBytes, favicon, annotationImages);
```

Add `AnnotationImageFile` to the module's export list.

- [ ] **Step 3: Extend `ViewerExportSettings`**

In `src/splat-serialize.ts`, add to `ViewerExportSettings` after `poster`:

```ts
    // attached annotation images, emitted beside the viewer in ZIP exports at
    // the paths baked into each annotation's extras (ZIP only: the single-file
    // HTML export drops them and the export popup warns)
    annotationImages?: { path: string; data: Uint8Array }[];
```

and forward it at the `writeViewerCore` call in `serializeViewer`:

```ts
    await writeViewerCore(dataTable, experienceSettings, viewerType, createGpuDevice, fs, events, undefined, undefined, collision, extraScenes, options.poster, undefined, options.annotationImages);
```

(Note the explicit `undefined` for `favicon` — the browser path never has one.)

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit > /tmp/tsc.log 2>&1; tail -20 /tmp/tsc.log`
Expected: no errors.

- [ ] **Step 5: Rebuild the shared bundle the server consumes**

Run: `node scripts/build-shared.mjs > /tmp/shared.log 2>&1; tail -10 /tmp/shared.log`
Expected: exit 0, `dist-shared/` refreshed.

- [ ] **Step 6: Lint and commit**

```bash
npm run lint > /tmp/lint.log 2>&1; tail -20 /tmp/lint.log
git add src/splat-export-core.ts src/splat-serialize.ts
git commit -m "feat(export): emit annotation images into ZIP viewer exports"
```

---

### Task 9: Export popup — collect images and warn on HTML

**Files:**
- Modify: `src/ui/export-popup.ts`

**Interfaces:**
- Consumes: `annotations.imageRefs` (Task 2), `annotationImages.get` (Task 1), `ViewerExportSettings.annotationImages` (Task 8), locale key `export.annotation-images-html-warning` (Task 3).
- Produces: `viewerExportSettings.annotationImages` populated for ZIP exports.

- [ ] **Step 1: Add a collector helper**

Near the top of the module (beside the other module-level helpers), add:

```ts
// Bytes for every image still referenced by an image-mode annotation, keyed by
// the same export path baked into that annotation's extras. Images whose bytes
// are missing (a document loaded from an archive that lacked the entry) are
// skipped: the annotation simply shows one fewer slide.
const collectAnnotationImages = (events: Events): { path: string; data: Uint8Array }[] => {
    const refs = (events.invoke('annotations.imageRefs') ?? []) as { imageId: string, ext: string }[];
    const out: { path: string; data: Uint8Array }[] = [];
    refs.forEach((ref) => {
        const data = events.invoke('annotationImages.get', ref.imageId) as Uint8Array | null;
        if (data) {
            out.push({ path: `annotations/${ref.imageId}.${ref.ext}`, data });
        }
    });
    return out;
};
```

- [ ] **Step 2: Populate it for ZIP exports**

In `assembleViewerOptions`, inside the returned `viewerExportSettings` object, after `experienceSettings`:

```ts
                        // ZIP only: the single-file HTML export has nowhere to
                        // put them (the warning below tells the user)
                        annotationImages: viewerTypeSelect.value === 'zip' ? collectAnnotationImages(events) : undefined
```

- [ ] **Step 3: Add the HTML warning label**

`viewerTypeRow` is built around line 90 and appended with `content.append(viewerTypeRow);` around line 456. Add the label right after the `viewerTypeRow` construction block:

```ts
        // Galleries cannot ride in a single-file HTML export; say so rather
        // than dropping them silently.
        const galleryWarning = new Label({ class: 'export-warning' });
        galleryWarning.hidden = true;

        const refreshGalleryWarning = () => {
            const count = ((events.invoke('annotations.list') ?? []) as { linkType?: string, images?: unknown[] }[])
            .filter(a => a.linkType === 'images' && (a.images?.length ?? 0) > 0).length;
            galleryWarning.hidden = !(currentExportType === 'viewer' && viewerTypeSelect.value === 'html' && count > 0);
            if (!galleryWarning.hidden) {
                galleryWarning.text = i18n.t('export.annotation-images-html-warning', { count });
            }
        };
```

Append it directly after the viewer-type row:

```ts
        content.append(viewerTypeRow);
        content.append(galleryWarning);
```

Add the refresh to the existing `viewerTypeSelect.on('change', ...)` handler (around line 572), after the `updateExtension(...)` call already there:

```ts
            refreshGalleryWarning();
```

and call it at the end of `reset(...)` (the per-show entry point, around line 590), so a freshly opened popup is correct:

```ts
            refreshGalleryWarning();
```

Note `currentExportType` is assigned at the top of `reset` — the guard keeps the warning hidden for non-viewer export types, whose rows do not include `viewerTypeRow`.

- [ ] **Step 4: Style the warning**

In `src/ui/scss/export-popup.scss`, add:

```scss
.export-warning {
    display: block;
    margin: 4px 0;
    color: #e0a030;
    font-size: 11px;
}
```

- [ ] **Step 5: Verify by hand**

Run: `npm run develop`, load a splat, attach 2 images to one annotation, open Export → Viewer.

Expected: with format `Package (ZIP)` there is no warning; switching to `HTML` shows "1 annotation galleries will be omitted — use Package (ZIP) to include them."; switching back hides it.

- [ ] **Step 6: Export and inspect the ZIP**

Export as Package (ZIP), then:

Run: `unzip -l ~/Downloads/<name>.zip | grep annotations`
Expected: `annotations/annimg_0.jpg` and `annotations/annimg_1.jpg` are listed.

- [ ] **Step 7: Open the exported viewer**

Unzip and serve it (`npx http-server` or the export server), open it, click the annotation.

Expected: the tooltip shows `View images (2)`; clicking opens the carousel; arrows, counter and dots work; Esc closes. A single-image annotation shows no arrows/counter/dots. A link annotation still shows `Open link ↗`.

- [ ] **Step 8: Lint and commit**

```bash
npm run lint > /tmp/lint.log 2>&1; tail -20 /tmp/lint.log
git add src/ui/export-popup.ts src/ui/scss
git commit -m "feat(export): ship annotation images with ZIP exports and warn on HTML"
```

---

### Task 10: Server-side export path

**Files:**
- Create: `server/src/annotation-images.ts`
- Create: `server/test/annotation-images.test.ts`
- Modify: `server/src/index.ts`
- Modify: `server/src/run-export.ts`
- Modify: `src/export-server-client.ts`
- Modify: `src/file-handler.ts`

**Interfaces:**
- Consumes: `ViewerExportSettings.annotationImages` (Task 8).
- Produces:
  - `safeAnnotationImageName(name: string | undefined): string | null` (server)
  - `runServerExport(plyGz, options, onProgress, extraPlyGz?, poster?, annotationImages?)` where `annotationImages` is `{ name: string; data: Uint8Array }[]`
  - Same trailing parameter on `runServerPublish` (used in Task 11).

- [ ] **Step 1: Write the failing sanitization test**

Create `server/test/annotation-images.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import { safeAnnotationImageName } from '../src/annotation-images.js';

describe('safeAnnotationImageName', () => {
    it('accepts an exporter-produced name', () => {
        expect(safeAnnotationImageName('annimg_3.jpg')).toBe('annimg_3.jpg');
        expect(safeAnnotationImageName('annimg_0.png')).toBe('annimg_0.png');
        expect(safeAnnotationImageName('annimg_12.webp')).toBe('annimg_12.webp');
        expect(safeAnnotationImageName('annimg_1.jpeg')).toBe('annimg_1.jpeg');
    });

    // A multipart part filename is attacker-controllable and becomes a ZIP
    // entry name, so anything that could escape annotations/ or be served as
    // an active document is rejected outright rather than repaired.
    it('rejects traversal and nested paths', () => {
        expect(safeAnnotationImageName('../evil.jpg')).toBeNull();
        expect(safeAnnotationImageName('a/b.jpg')).toBeNull();
        expect(safeAnnotationImageName('..')).toBeNull();
        expect(safeAnnotationImageName('/etc/passwd')).toBeNull();
    });

    it('rejects active-content extensions', () => {
        expect(safeAnnotationImageName('evil.html')).toBeNull();
        expect(safeAnnotationImageName('evil.js')).toBeNull();
        expect(safeAnnotationImageName('evil.svg')).toBeNull();
    });

    it('rejects dotfiles and missing names', () => {
        expect(safeAnnotationImageName('.htaccess')).toBeNull();
        expect(safeAnnotationImageName('')).toBeNull();
        expect(safeAnnotationImageName(undefined)).toBeNull();
    });

    it('rejects an uppercase extension rather than normalising it', () => {
        expect(safeAnnotationImageName('annimg_0.JPG')).toBeNull();
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run from `server/`: `npm test -- annotation-images > /tmp/s1.log 2>&1; tail -30 /tmp/s1.log`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

Create `server/src/annotation-images.ts`:

```ts
// Whitelist for an uploaded annotation-image part filename.
//
// The name arrives from a multipart part and becomes a ZIP entry name under
// annotations/, so it is validated, never repaired: a rejected part fails the
// request. The extension list is deliberately narrower than the browser's
// passthrough set is wide -- an entry that a publish origin would serve as an
// active document (html, js, svg) must not be creatable this way.
const NAME_RE = /^[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/;

export const safeAnnotationImageName = (name: string | undefined): string | null => {
    return (typeof name === 'string' && NAME_RE.test(name)) ? name : null;
};
```

- [ ] **Step 4: Run it to verify it passes**

Run from `server/`: `npm test -- annotation-images > /tmp/s1.log 2>&1; tail -30 /tmp/s1.log`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Parse the parts in both routes**

In `server/src/index.ts`, add the import beside the others:

```ts
import { safeAnnotationImageName } from './annotation-images.js';
```

In **both** `/api/export` and `/api/publish`, declare the accumulator beside `poster`:

```ts
        const annotationImages: { path: string; data: Uint8Array }[] = [];
```

add the part branch after the `poster` branch in each loop:

```ts
            } else if (part.type === 'file' && part.fieldname === 'annotationImage') {
                const data = await part.toBuffer();
                const name = safeAnnotationImageName(part.filename);
                if (!name) {
                    return reply.code(400).send({ error: 'invalid annotation image filename' });
                }
                annotationImages.push({ path: `annotations/${name}`, data: new Uint8Array(data) });
```

and reattach after the loop, beside the existing poster reattachment:

```ts
        // Image bytes travel as their own multipart parts, not inside the JSON
        // options (a Uint8Array does not survive JSON.stringify).
        if (annotationImages.length && options.viewerExportSettings) {
            options.viewerExportSettings.annotationImages = annotationImages;
        }
```

(In `/api/publish` the options variable is `options?` — use `options?.viewerExportSettings` there, matching the poster line above it.)

- [ ] **Step 6: Thread through `run-export.ts`**

Extend the `viewerExportSettings` inline type in `ExportOptions`:

```ts
    viewerExportSettings?: { type: 'html' | 'zip'; streaming?: boolean; experienceSettings: any; collision?: { environment: 'indoor' | 'outdoor'; radius: number; voxelSize: number }; poster?: Uint8Array; annotationImages?: { path: string; data: Uint8Array }[] };
```

Beside the poster normalisation, add:

```ts
    // Same structured-clone hop as the poster: normalise back to Uint8Array.
    const annotationImages = (options.viewerExportSettings?.annotationImages ?? [])
    .map(img => ({ path: img.path, data: new Uint8Array(img.data as any) }));
```

and pass it as the trailing argument on the `packageViewer` `writeViewerCore` call:

```ts
    await writeViewerCore(dataTable, options.viewerExportSettings!.experienceSettings, viewerType, createDevice, memFs, events, onLog, isCancelled, options.viewerExportSettings!.collision, extraScenes, posterBytes, favicon ?? undefined, annotationImages);
```

Leave the `htmlViewer` call unchanged — that path drops images by design.

- [ ] **Step 7: Send the parts from the browser**

In `src/export-server-client.ts`, add the parameter to `runServerExport` **and** `runServerPublish`:

```ts
    annotationImages?: { name: string; data: Uint8Array }[]
```

and in both function bodies, after the poster append:

```ts
    (annotationImages ?? []).forEach(img => form.append('annotationImage', new Blob([img.data as BlobPart]), img.name));
```

- [ ] **Step 8: Strip and forward in `file-handler.ts`**

In the server-export branch, replace the `posterBytes` / `wire` block with:

```ts
            // Poster and annotation image bytes travel as their own multipart
            // parts, not inside the JSON options (a Uint8Array does not survive
            // JSON.stringify).
            const posterBytes = options.viewerExportSettings?.poster;
            const annotationImages = options.viewerExportSettings?.annotationImages;
            const wire = {
                ...options,
                fileType,
                ...(options.viewerExportSettings ? { viewerExportSettings: { ...options.viewerExportSettings, poster: undefined, annotationImages: undefined } } : {})
            };
```

and extend the call:

```ts
            const result = await runServerExport(plyGz, wire, (p) => {
                if (!useSpinner) {
                    events.fire('progressUpdate', { text: p.message, progress: p.value, loc: p.loc });
                }
            }, extraPlyGz, posterBytes ? new Blob([posterBytes as BlobPart], { type: 'image/jpeg' }) : undefined,
            (annotationImages ?? []).map(img => ({ name: img.path.replace('annotations/', ''), data: img.data })));
```

- [ ] **Step 9: Run the server suite**

Run from `server/`: `npm test > /tmp/s2.log 2>&1; tail -30 /tmp/s2.log`
Expected: pass (GPU-tagged suites may skip without a GPU — that is the existing behaviour).

- [ ] **Step 10: Verify end to end**

Run from `server/`: `npm run dev`. Open http://localhost:3334, load a splat, attach 2 images, enable "Export on server", export as Package (ZIP).

Expected: the returned ZIP contains `annotations/annimg_*.jpg` and the opened viewer shows a working carousel.

- [ ] **Step 11: Lint and commit**

```bash
npm run lint > /tmp/lint.log 2>&1; tail -20 /tmp/lint.log
git add server/src/annotation-images.ts server/test/annotation-images.test.ts server/src/index.ts server/src/run-export.ts src/export-server-client.ts src/file-handler.ts
git commit -m "feat(server): carry annotation images through server-side export"
```

---

### Task 11: S3 publish path

**Files:**
- Modify: `src/s3-publish.ts`
- Modify: `src/ui/s3-publish-dialog.ts`

**Interfaces:**
- Consumes: `runServerPublish`'s `annotationImages` parameter (Task 10), `collectAnnotationImages` pattern (Task 9).
- Produces: nothing consumed later.

- [ ] **Step 1: Populate the setting in the dialog**

In `src/ui/s3-publish-dialog.ts`, the returned options object carries a `viewerExportSettings` whose last property is `experienceSettings` (around line 274). Add after it:

```ts
                        annotationImages: ((events.invoke('annotations.imageRefs') ?? []) as { imageId: string, ext: string }[])
                        .map(ref => ({ path: `annotations/${ref.imageId}.${ref.ext}`, data: events.invoke('annotationImages.get', ref.imageId) as Uint8Array | null }))
                        .filter(entry => !!entry.data) as { path: string; data: Uint8Array }[],
```

(Publish is always a ZIP export, so there is no format condition here.)

- [ ] **Step 2: Strip and forward in `s3-publish.ts`**

Replace the `publishOptions` construction and the `runServerPublish` call:

```ts
            const annotationImages = options.viewerExportSettings.annotationImages;
            const publishOptions = {
                subfolder: options.subfolder,
                name: options.name,
                public: options.public,
                overwrite: true,   // already confirmed (or didn't exist)
                serializeSettings: options.serializeSettings,
                // S3PublishOptions.viewerExportSettings never carries poster or
                // image bytes (they travel as their own multipart parts below)
                viewerExportSettings: { ...options.viewerExportSettings, annotationImages: undefined },
                ...(upload ? { portalExtras: upload.portalExtras } : {})
            };
            const result = await runServerPublish(
                plyGz,
                publishOptions,
                p => events.fire('progressUpdate', { text: p.message, progress: p.value, loc: p.loc }),
                upload?.extraPlyGz,
                posterBytes ? new Blob([posterBytes as BlobPart], { type: 'image/jpeg' }) : undefined,
                (annotationImages ?? []).map(img => ({ name: img.path.replace('annotations/', ''), data: img.data }))
            );
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit > /tmp/tsc.log 2>&1; tail -20 /tmp/tsc.log`
Expected: no errors.

- [ ] **Step 4: Verify by hand (requires S3 credentials configured on the server)**

With `S3_*` configured, run the server, attach images to an annotation, and publish.

Expected: the published prefix contains `annotations/annimg_*.jpg` objects served as `image/jpeg`, and the published viewer's carousel works. If no S3 destination is available, record that this step was not exercised rather than marking it done.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint > /tmp/lint.log 2>&1; tail -20 /tmp/lint.log
git add src/s3-publish.ts src/ui/s3-publish-dialog.ts
git commit -m "feat(publish): carry annotation images into S3 publish"
```

---

### Task 12: Full verification gate

**Files:** none modified (unless a defect is found).

- [ ] **Step 1: Front-end suite**

Run: `npm run test > /tmp/all.log 2>&1; tail -30 /tmp/all.log`
Expected: all suites pass.

- [ ] **Step 2: Server suite**

Run from `server/`: `npm test > /tmp/allserver.log 2>&1; tail -30 /tmp/allserver.log`
Expected: all non-GPU suites pass.

- [ ] **Step 3: Lint**

Run: `npm run lint > /tmp/lint.log 2>&1; tail -20 /tmp/lint.log`
Expected: exit 0.

- [ ] **Step 4: Release-build E2E**

The companion runtime ships as a stringified blob, so minification differences only show in a release build.

Run: `npm run build > /tmp/build.log 2>&1; tail -10 /tmp/build.log`

Then serve `dist/` and, in that build:

1. Load a splat, create three annotations: one with 3 images (captions on all three), one with 1 image, one with an external link.
2. Save the `.ssproj`, `File > New`, reload it — images, order and captions all survive.
3. Export as Package (ZIP). Open the result: 3-image annotation shows `View images (3)`, arrows/counter/dots present, click and keyboard navigation both work, arrows disable at the ends, Esc and backdrop close it, and the camera does not move while the modal is open.
4. The 1-image annotation shows no arrows, no counter, no dots.
5. The link annotation still shows `Open link ↗` and navigates.
6. Repeat step 3 with Streaming enabled.
7. Switch the export format to HTML and confirm the omission warning appears.

- [ ] **Step 5: Record the outcome**

Note which steps passed and any that could not be exercised (e.g. S3 without credentials). Do not claim completion for steps that were skipped.

---

## Notes for the implementer

- `src/main.ts` is the single wiring point; read it first to see how a subsystem is hooked up.
- Modules talk over the event bus (`events.fire` / `events.on`) and the function registry (`events.function` / `events.invoke`). Prefer registering events over importing modules directly.
- `src/viewer-companion/` is playcanvas-free by construction: it is compiled for the browser, baked into exported HTML, *and* compiled for the Node export server via `dist-shared/`. String operations only.
- After changing anything under `src/viewer-companion/` or `src/splat-export-core.ts`, re-run `node scripts/build-shared.mjs` before testing the server path, or the server will keep using the previous build.
