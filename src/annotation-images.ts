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

export { registerAnnotationImageEvents, encodeAnnotationImage, planEncoding, collectAnnotationImages };
