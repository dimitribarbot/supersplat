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
