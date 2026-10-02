import { describe, it, expect } from 'vitest';

import { stripHtmlGalleries } from '../src/splat-export-core';
import { buildAnnotationLinksInjection, buildLinkTable } from '../src/viewer-companion/annotation-links';

// The companion ships as a stringified runtime, so the only honest way to test
// it is to run the string the exporter actually emits. These fakes cover just
// the DOM/viewer surface the companion touches -- enough to reproduce the
// exported viewer's *shared tooltip*, which is the whole source of the bug this
// suite pins: one .sse-annotation element is reused for every annotation, so
// anything appended to it survives until something removes it.

class FakeEl {
    children: FakeEl[] = [];
    parent: FakeEl = null;
    className = '';
    textContent = '';
    href = '';
    target = '';
    rel = '';
    src = '';
    alt = '';
    tabIndex = 0;
    disabled = false;
    style: Record<string, string> = {};
    listeners: Record<string, ((e: any) => void)[]> = {};
    focused = false;
    private attrs: Record<string, string> = {};

    constructor(public tagName: string) {}

    dispatch(name: string, e: any = {}) {
        const ev = { stopPropagation: () => {}, preventDefault: () => {}, target: this, ...e };
        (this.listeners[name] ?? []).forEach(fn => fn(ev));
    }

    focus() {
        this.focused = true;
    }

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

    // only the '.class' form the companion uses
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

    setAttribute(k: string, v: string) {
        this.attrs[k] = v;
    }
    getAttribute(k: string) {
        return this.attrs[k] ?? null;
    }
}

// Mirrors the exported viewer (supersplat-viewer >= 1.37): one shared tooltip
// that a selection change hides at once (Annotations' update -> hideTooltip,
// registered before any companion) and that is only rewritten and shown --
// class 'sse-visible' -- once the camera has nearly landed (revealTooltip).
const makeViewer = (annotations: any[] = []) => {
    const root = new FakeEl('div');
    const host = new FakeEl('div');
    host.className = 'annotations';
    const tooltip = new FakeEl('div');
    tooltip.className = 'sse-annotation';
    host.appendChild(tooltip);
    root.appendChild(host);

    const handlers: Record<string, ((...args: any[]) => void)[]> = {};
    const observers: (() => void)[] = [];
    const events = {
        on: (name: string, fn: (...args: any[]) => void) => {
            (handlers[name] ??= []).push(fn);
        },
        fire: (name: string, ...args: any[]) => {
            (handlers[name] ?? []).forEach(fn => fn(...args));
        }
    };

    // every element the companion creates, attached or not: the gallery
    // preloads each image in a detached <img>
    const created: FakeEl[] = [];
    const document = {
        readyState: 'complete',
        body: root,
        getElementById: (id: string) => (id === 'annotations' ? host : null),
        querySelector: (s: string) => root.querySelector(s),
        querySelectorAll: (s: string) => root.querySelectorAll(s),
        createElement: (tag: string) => {
            const el = new FakeEl(tag);
            created.push(el);
            return el;
        },
        addEventListener: () => {}
    };

    const window = {
        __supersplatAnnotationLinks: [] as any[],
        __supersplatViewer: { global: { events, settings: { annotations } } },
        location: { href: 'https://viewer.test/index.html' }
    };

    // the viewer's own selection listener, registered before the companion's
    events.on('selectedAnnotation:changed', () => {
        tooltip.className = 'sse-annotation';
    });

    return { root, host, tooltip, events, observers, created, document, window };
};

// Pull the runtime out of the emitted fragment and execute it against the fakes.
// Bare globals are passed as parameters so they shadow the real ones.
const runCompanion = (annotations: any[], viewer: ReturnType<typeof makeViewer>) => {
    const injection = buildAnnotationLinksInjection(annotations);
    if (injection === '') {
        return false;
    }
    const scripts = [...injection.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    viewer.window.__ssLang = 'en';
    viewer.window.__supersplatAnnotationLinks = buildLinkTable(annotations);
    const MutationObserver = class {
        constructor(private cb: () => void) {}
        observe(target: FakeEl) {
            if (target === viewer.tooltip) {
                viewer.observers.push(() => this.cb());
            }
        }
    };
    const requestAnimationFrame = (fn: () => void) => fn();
    // the last script is the runtime; the first only assigns the link table
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'navigator', 'MutationObserver', 'requestAnimationFrame', scripts[scripts.length - 1])(
        viewer.window, viewer.document, { language: 'en' }, MutationObserver, requestAnimationFrame
    );
    return true;
};

const linkIn = (viewer: ReturnType<typeof makeViewer>) => viewer.tooltip.querySelector('.ss-annotation-link');

// supersplat-viewer >= 1.32 selection: fired with the index (null = none).
const select = (viewer: ReturnType<typeof makeViewer>, index: number | null) =>
    viewer.events.fire('selectedAnnotation:changed', index, null);

// The camera has (nearly) landed: the viewer shows the tooltip. It re-adds the
// class on every rendered frame, so the observer fires repeatedly.
const reveal = (viewer: ReturnType<typeof makeViewer>) => {
    viewer.tooltip.className = 'sse-annotation sse-visible';
    viewer.observers.forEach(fn => fn());
};

const show = (viewer: ReturnType<typeof makeViewer>, index: number) => {
    select(viewer, index);
    reveal(viewer);
};

describe('buildLinkTable', () => {
    it('emits one 1-based entry per annotation carrying a url', () => {
        expect(buildLinkTable([
            { title: 'a', extras: { url: 'https://a.test' } },
            { title: 'b' },
            { title: 'c', extras: { url: 'https://c.test', newTab: true } }
        ])).toEqual([
            { label: 1, url: 'https://a.test', newTab: false },
            { label: 3, url: 'https://c.test', newTab: true }
        ]);
    });

    it('emits nothing when no annotation has a url', () => {
        expect(buildLinkTable([{ title: 'a' }, { title: 'b', extras: {} }])).toEqual([]);
    });
});

describe('annotation link companion runtime', () => {
    const annotations = [
        { title: 'Entrée', text: '', extras: { url: 'https://entree.test', newTab: true } },
        { title: 'Toilettes', text: '', extras: {} }
    ];

    it('injects the link when an annotation carrying a url is activated', () => {
        const viewer = makeViewer(annotations);
        expect(runCompanion(annotations, viewer)).toBe(true);

        show(viewer, 0);

        const link = linkIn(viewer);
        expect(link).not.toBeNull();
        expect(link.href).toBe('https://entree.test/');
        expect(link.target).toBe('_blank');
    });

    // The bug: the shared tooltip is reused, so a link left over from the
    // previous annotation reads as if it belonged to this one. Navigating with
    // the nav chevrons never fires a hotspot click, which was the only thing
    // that used to clear it.
    it('clears the link when an annotation with no url is activated next', () => {
        const viewer = makeViewer(annotations);
        runCompanion(annotations, viewer);

        show(viewer, 0);
        expect(linkIn(viewer)).not.toBeNull();
        show(viewer, 1);

        expect(linkIn(viewer)).toBeNull();
    });

    it('never stacks two links in the shared tooltip', () => {
        const viewer = makeViewer(annotations);
        runCompanion(annotations, viewer);

        show(viewer, 0);
        show(viewer, 0);

        expect(viewer.tooltip.querySelectorAll('.ss-annotation-link')).toHaveLength(1);
    });

    it('rejects a non-http(s) url rather than injecting it', () => {
        const hostile = [{ title: 'x', extras: { url: 'javascript:alert(1)' } }];
        const viewer = makeViewer(hostile);
        expect(runCompanion(hostile, viewer)).toBe(true);

        show(viewer, 0);

        expect(linkIn(viewer)).toBeNull();
    });

    it('clears the chip when the selection is cleared', () => {
        const annotations = [{ title: 'A', extras: { url: 'https://a.test/' } }];
        const viewer = makeViewer(annotations);
        runCompanion(annotations, viewer);
        show(viewer, 0);
        expect(linkIn(viewer)).not.toBeNull();
        select(viewer, null);
        expect(linkIn(viewer)).toBeNull();
    });

    // supersplat-viewer 1.37 rewrites the shared tooltip only once the camera
    // has nearly landed. A chip injected on selection would sit, for the fade,
    // inside the PREVIOUS annotation's tooltip, and open the new one's link.
    it('waits for the tooltip to be revealed before injecting the chip', () => {
        const viewer = makeViewer(annotations);
        runCompanion(annotations, viewer);

        select(viewer, 0);
        expect(linkIn(viewer)).toBeNull();

        reveal(viewer);
        expect(linkIn(viewer)).not.toBeNull();
    });

    it('drops the previous chip at once when another annotation is selected', () => {
        const two = [
            { title: 'A', text: '', extras: { url: 'https://a.test/' } },
            { title: 'B', text: '', extras: { url: 'https://b.test/' } }
        ];
        const viewer = makeViewer(two);
        runCompanion(two, viewer);
        show(viewer, 0);

        select(viewer, 1);
        expect(linkIn(viewer)).toBeNull();

        reveal(viewer);
        expect(linkIn(viewer).href).toBe('https://b.test/');
    });

    it('does not re-inject on every frame the viewer re-shows the tooltip', () => {
        const viewer = makeViewer(annotations);
        runCompanion(annotations, viewer);
        show(viewer, 0);
        const chip = linkIn(viewer);

        reveal(viewer);
        reveal(viewer);

        expect(viewer.tooltip.querySelectorAll('.ss-annotation-link')).toHaveLength(1);
        expect(linkIn(viewer)).toBe(chip);
    });

    it('is not injected at all when no annotation has a url', () => {
        expect(buildAnnotationLinksInjection([{ title: 'a', extras: {} }])).toBe('');
    });
});

describe('stripHtmlGalleries', () => {
    const gallery = [{ src: 'annotations/annimg_0.jpg', caption: 'one' }];

    it('drops extras.images from a gallery annotation', () => {
        const out = stripHtmlGalleries({ annotations: [{ title: 'a', extras: { images: gallery, scene: 1 } }] });
        expect(out.annotations[0].extras.images).toBeUndefined();
        // the rest of extras is untouched
        expect(out.annotations[0].extras.scene).toBe(1);
        expect(out.annotations[0].title).toBe('a');
    });

    it('leaves a link annotation untouched', () => {
        const input = { annotations: [{ title: 'a', extras: { url: 'https://a.test', newTab: true } }] };
        const out = stripHtmlGalleries(input);
        expect(out.annotations[0].extras).toEqual({ url: 'https://a.test', newTab: true });
    });

    it('does not mutate the caller settings object', () => {
        const input = { annotations: [{ title: 'a', extras: { images: gallery } }] };
        stripHtmlGalleries(input);
        expect(input.annotations[0].extras.images).toEqual(gallery);
    });

    it('passes settings with no annotations straight through', () => {
        const input = { annotations: [] as any[] };
        expect(stripHtmlGalleries(input)).toBe(input);
        expect(stripHtmlGalleries(undefined)).toBeUndefined();
    });
});

describe('annotation chip precedence', () => {
    const gallery = [{ src: 'annotations/annimg_0.jpg', caption: 'one' }, { src: 'annotations/annimg_1.jpg', caption: 'two' }];

    it('is injected when an annotation has images but no url', () => {
        expect(buildAnnotationLinksInjection([{ title: 'a', extras: { images: gallery } }])).not.toBe('');
    });

    it('shows a gallery chip for an image annotation', () => {
        const annotations = [{ title: 'a', text: '', extras: { images: gallery } }];
        const viewer = makeViewer(annotations);
        expect(runCompanion(annotations, viewer)).toBe(true);

        show(viewer, 0);

        const chip = linkIn(viewer);
        expect(chip).not.toBeNull();
        expect(chip.textContent).toContain('2');
    });

    it('opens the carousel when the chip is clicked', () => {
        const annotations = [{ title: 'a', text: '', extras: { images: gallery } }];
        const viewer = makeViewer(annotations);
        runCompanion(annotations, viewer);
        show(viewer, 0);

        linkIn(viewer).dispatch('click');

        expect(viewer.root.querySelector('.ss-gallery')).not.toBeNull();
    });

    // Only the editor's linkType can produce one of these, but the runtime must
    // still resolve deterministically if a hand-edited export carries both.
    it('prefers the gallery when an annotation carries both', () => {
        const annotations = [{ title: 'a', text: '', extras: { url: 'https://a.test', images: gallery } }];
        const viewer = makeViewer(annotations);
        runCompanion(annotations, viewer);
        show(viewer, 0);

        linkIn(viewer).dispatch('click');

        expect(viewer.root.querySelector('.ss-gallery')).not.toBeNull();
    });

    it('closes an open carousel when the annotation is deactivated', () => {
        const annotations = [{ title: 'a', text: '', extras: { images: gallery } }];
        const viewer = makeViewer(annotations);
        runCompanion(annotations, viewer);
        show(viewer, 0);
        linkIn(viewer).dispatch('click');

        select(viewer, null);

        expect(viewer.root.querySelector('.ss-gallery')).toBeNull();
    });

    it('swaps a gallery chip for a link chip across activations', () => {
        const annotations = [
            { title: 'a', text: '', extras: { images: gallery } },
            { title: 'b', text: '', extras: { url: 'https://b.test' } }
        ];
        const viewer = makeViewer(annotations);
        runCompanion(annotations, viewer);

        show(viewer, 0);
        show(viewer, 1);

        expect(viewer.tooltip.querySelectorAll('.ss-annotation-link')).toHaveLength(1);
        expect(linkIn(viewer).href).toBe('https://b.test/');
    });

    // A single-file HTML export ships no image files, so writeViewerCore strips
    // the galleries out of the settings BEFORE writeHtml bakes them in -- the
    // chip reads its images from those baked settings, so a gate on the
    // injection alone would still render "View images (N)" over dead src paths.
    it('is not injected for the shape the HTML export produces', () => {
        const settings = stripHtmlGalleries({ annotations: [{ title: 'a', extras: { images: gallery } }] });
        expect(buildAnnotationLinksInjection(settings.annotations)).toBe('');
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

// The gallery loads each image in a detached <img> and only puts it on screen
// once it has arrived: while the scene streams, images can take seconds, and a
// reused <img> shows nothing at first and then the PREVIOUS image under the
// next one's caption until the next one lands.
describe('gallery image loading', () => {
    const gallery = [
        { src: 'annotations/annimg_0.jpg', caption: 'one' },
        { src: 'annotations/annimg_1.jpg', caption: 'two' }
    ];
    const annotations = [{ title: 'a', text: '', extras: { images: gallery } }];

    const openGalleryOf = () => {
        const viewer = makeViewer(annotations);
        runCompanion(annotations, viewer);
        show(viewer, 0);
        linkIn(viewer).dispatch('click');
        const frame = viewer.root.querySelector('.ss-gallery-frame');
        const img = viewer.root.querySelector('.ss-gallery-img');
        const loaderOf = (src: string) => viewer.created.filter(el => el.tagName === 'img' && el !== img && el.src === src).pop();
        const next = () => viewer.root.querySelector('.ss-gallery-next').dispatch('click');
        return { frame, img, loaderOf, next };
    };

    const isLoading = (frame: FakeEl) => frame.className.split(' ').includes('ss-gallery-loading');

    it('shows a loading state, not an empty frame, until the image arrives', () => {
        const { frame, img, loaderOf } = openGalleryOf();

        expect(isLoading(frame)).toBe(true);
        expect(img.src).toBe('');

        loaderOf(gallery[0].src).dispatch('load');

        expect(isLoading(frame)).toBe(false);
        expect(img.src).toBe(gallery[0].src);
    });

    it('never shows the previous image while the next one loads', () => {
        const { frame, img, loaderOf, next } = openGalleryOf();
        loaderOf(gallery[0].src).dispatch('load');

        next();

        expect(isLoading(frame)).toBe(true);

        loaderOf(gallery[1].src).dispatch('load');

        expect(isLoading(frame)).toBe(false);
        expect(img.src).toBe(gallery[1].src);
    });

    it('ignores a late load from an image the user has moved past', () => {
        const { frame, img, loaderOf, next } = openGalleryOf();

        next();
        loaderOf(gallery[0].src).dispatch('load');

        expect(isLoading(frame)).toBe(true);
        expect(img.src).not.toBe(gallery[0].src);
    });

    it('stops the loading state when an image fails', () => {
        const { frame, loaderOf } = openGalleryOf();

        loaderOf(gallery[0].src).dispatch('error');

        expect(isLoading(frame)).toBe(false);
        expect(frame.className.split(' ')).toContain('ss-gallery-error');
    });
});

describe('stripHtmlGalleries and translations', () => {
    it('drops translated captions along with the images', () => {
        const settings = {
            annotations: [{
                title: 'T',
                text: 'X',
                extras: {
                    images: [{ src: 'annotations/annimg_0.jpg', caption: 'North' }],
                    i18n: { fr: { title: 'Façade', captions: ['Mur nord'] } }
                }
            }]
        };
        const out = stripHtmlGalleries(settings);
        expect(out.annotations[0].extras.images).toBeUndefined();
        expect(out.annotations[0].extras.i18n).toEqual({ fr: { title: 'Façade' } });
    });

    it('removes a language entry left empty by dropping its captions', () => {
        const settings = {
            annotations: [{
                title: 'T',
                text: 'X',
                extras: {
                    images: [{ src: 'annotations/annimg_0.jpg', caption: 'North' }],
                    i18n: { fr: { captions: ['Mur nord'] } }
                }
            }]
        };
        expect(stripHtmlGalleries(settings).annotations[0].extras.i18n).toBeUndefined();
    });
});
