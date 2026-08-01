import { describe, it, expect } from 'vitest';

import { AddAnnotationOp, AnnotationData, AnnotationImage, registerAnnotationsEvents } from '../src/annotations';

// Minimal Events double: function/invoke registry + on/fire listeners.
//
// `hasImage` stands in for the annotation image store (annotation-images.ts),
// which the export path asks whether an image's bytes are actually present. It
// defaults to "every image is present" so the cases that are not about missing
// bytes read as they would in the app, where the store is always registered.
const makeEvents = (hasImage: (imageId: string) => boolean = () => true) => {
    const fns = new Map<string, (...args: any[]) => any>();
    const listeners = new Map<string, ((...args: any[]) => void)[]>();
    fns.set('annotationImages.has', (imageId: string) => hasImage(imageId));
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

describe('annotations.export scene index', () => {
    it('bakes extras.scene from the splat uid via the portal bundle', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation({ id: 'annotation_0', sceneUid: 20 })).do();
        const out = events.invoke('annotations.export', [10, 20]);
        expect(out[0].extras.scene).toBe(1);
    });

    it('omits extras.scene when the annotation has no scene', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation({ sceneUid: null })).do();
        const out = events.invoke('annotations.export', [10, 20]);
        expect(out[0].extras.scene).toBeUndefined();
    });

    it('omits extras.scene when no bundle is passed (single-scene export)', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation({ sceneUid: 20 })).do();
        const out = events.invoke('annotations.export');
        expect(out[0].extras.scene).toBeUndefined();
    });

    it('omits extras.scene for a splat that is not a portal scene', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation({ sceneUid: 99 })).do();
        const out = events.invoke('annotations.export', [10, 20]);
        expect(out[0].extras.scene).toBeUndefined();
    });

    it('still carries the link extras alongside the scene', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation({ linkType: 'url', url: 'https://x.test', newTab: true, sceneUid: 10 })).do();
        const out = events.invoke('annotations.export', [10, 20]);
        expect(out[0].extras).toEqual({ url: 'https://x.test', newTab: true, scene: 0, id: 'annotation_0' });
    });
});

describe('annotations document serialization', () => {
    it('writes the splat reference as a document index', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation({ sceneUid: 77 })).do();
        const out = events.invoke('docSerialize.annotations', new Map([[77, 2]]));
        expect(out[0].sceneIndex).toBe(2);
        expect(out[0].sceneUid).toBe(77);
    });

    it('writes null (never undefined) for an unassociated annotation', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation({ sceneUid: null })).do();
        const out = events.invoke('docSerialize.annotations', new Map([[77, 2]]));
        expect(out[0].sceneIndex).toBeNull();
        expect(JSON.parse(JSON.stringify(out))[0]).toHaveProperty('sceneIndex');
    });

    it('writes null for a splat missing from the document', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation({ sceneUid: 99 })).do();
        const out = events.invoke('docSerialize.annotations', new Map([[77, 2]]));
        expect(out[0].sceneIndex).toBeNull();
    });

    it('restores the uid from the index (index is authoritative)', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        // stale uid 77 from the saving session; index 2 maps to live uid 500
        events.invoke('docDeserialize.annotations',
            [{ ...annotation({ sceneUid: 77 }), sceneIndex: 2 }],
            { indexToUid: [100, 200, 500] });
        expect((events.invoke('annotations.list') as AnnotationData[])[0].sceneUid).toBe(500);
    });

    it('resolves a dangling index to null', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        events.invoke('docDeserialize.annotations',
            [{ ...annotation({ sceneUid: 77 }), sceneIndex: 9 }],
            { indexToUid: [100, 200] });
        expect((events.invoke('annotations.list') as AnnotationData[])[0].sceneUid).toBeNull();
    });

    it('a legacy record with no sceneIndex loads as unassociated', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        const legacy: any = annotation();
        delete legacy.sceneUid;
        events.invoke('docDeserialize.annotations', [legacy], { indexToUid: [100, 200] });
        expect((events.invoke('annotations.list') as AnnotationData[])[0].sceneUid).toBeNull();
    });
});

describe('annotations.export id', () => {
    it('bakes the stable annotation id into extras', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation({ id: 'annotation_7' })).do();
        const out = events.invoke('annotations.export');
        expect(out[0].extras.id).toBe('annotation_7');
    });
});

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

    // A document loaded from an archive that lacked the entry leaves the
    // metadata behind with no bytes. collectAnnotationImages already skips
    // those bytes, so emitting the src anyway would give the viewer a slide it
    // counts ("2 / 3") but cannot load.
    it('skips an image whose bytes are missing from the store', () => {
        const events = makeEvents(id => id !== 'annimg_1');
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation({
            linkType: 'images',
            images: [image({ imageId: 'annimg_0' }), image({ imageId: 'annimg_1' }), image({ imageId: 'annimg_2' })]
        })).do();
        const out = events.invoke('annotations.export');
        expect(out[0].extras.images).toEqual([
            { src: 'annotations/annimg_0.jpg', caption: '' },
            { src: 'annotations/annimg_2.jpg', caption: '' }
        ]);
    });

    it('omits images entirely when none of the bytes are present', () => {
        const events = makeEvents(() => false);
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation({ linkType: 'images', url: 'https://a.test', images: [image()] })).do();
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

    // imageId and ext are concatenated into a ZIP entry name on save
    // (annotations/<imageId>.<ext>) and into extras.images[].src on export, and
    // a .ssproj is as attacker-controllable as a multipart filename is, so a
    // hostile record must be dropped on the way in rather than repaired at
    // either sink.
    const deserializeOne = (images: any[]) => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        events.invoke('docDeserialize.annotations', [{
            id: 'annotation_0', position: [0, 0, 0], title: 'T', text: '', url: '', newTab: false,
            linkType: 'images', images,
            camera: { position: [0, 0, 0], target: [0, 0, 1], fov: 60 }
        }]);
        return events.invoke('annotations.list')[0].images;
    };

    it('drops an image whose imageId is not an exporter-minted id', () => {
        expect(deserializeOne([
            { imageId: '../../../evil', ext: 'jpg', mime: 'image/jpeg', caption: '' },
            { imageId: 'annimg_0/x', ext: 'jpg', mime: 'image/jpeg', caption: '' },
            { imageId: 'annimg_', ext: 'jpg', mime: 'image/jpeg', caption: '' },
            { imageId: 42, ext: 'jpg', mime: 'image/jpeg', caption: '' }
        ])).toEqual([]);
    });

    it('drops an image whose ext is not an image extension', () => {
        expect(deserializeOne([
            { imageId: 'annimg_0', ext: 'html', mime: 'image/jpeg', caption: '' },
            { imageId: 'annimg_1', ext: 'js', mime: 'image/jpeg', caption: '' },
            { imageId: 'annimg_2', ext: 'svg', mime: 'image/jpeg', caption: '' },
            { imageId: 'annimg_3', ext: 'JPG', mime: 'image/jpeg', caption: '' },
            { imageId: 'annimg_4', caption: '' }
        ])).toEqual([]);
    });

    it('keeps valid records alongside rejected ones', () => {
        expect(deserializeOne([
            { imageId: 'annimg_0', ext: 'jpg', mime: 'image/jpeg', caption: 'ok' },
            { imageId: '../evil', ext: 'html', mime: 'image/jpeg', caption: 'bad' },
            { imageId: 'annimg_1', ext: 'webp', mime: 'image/webp', caption: 'also ok' }
        ])).toEqual([
            { imageId: 'annimg_0', ext: 'jpg', mime: 'image/jpeg', caption: 'ok' },
            { imageId: 'annimg_1', ext: 'webp', mime: 'image/webp', caption: 'also ok' }
        ]);
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
