import { describe, it, expect } from 'vitest';

import { AddAnnotationOp, AnnotationData, registerAnnotationsEvents } from '../src/annotations';

// Minimal Events double: function/invoke registry + on/fire listeners.
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

const annotation = (over: Partial<AnnotationData> = {}): AnnotationData => ({
    id: 'annotation_0',
    position: [1, 2, 3],
    title: 'T',
    text: 'X',
    url: '',
    newTab: false,
    sceneUid: null,
    camera: { position: [0, 0, 0], target: [0, 0, 1], fov: 60 },
    ...over
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
        new AddAnnotationOp(events, annotation({ url: 'https://x.test', newTab: true, sceneUid: 10 })).do();
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
