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
    private _disabled = false;
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

    // Real bubbling: walk the parent chain, invoking listeners at each level,
    // and stop only when a handler calls stopPropagation -- so a test can
    // observe whether an event that started inside the modal actually reaches
    // a document-level listener, which is the real mechanism the runtime
    // relies on to keep the viewer's camera from moving under the modal.
    dispatch(name: string, e: any = {}) {
        let stopped = false;
        const ev = { stopPropagation: () => { stopped = true; }, preventDefault: () => {}, target: this, ...e };
        let node: FakeEl = this;
        while (node) {
            (node.listeners[name] ?? []).forEach(fn => fn(ev));
            if (stopped) {
                break;
            }
            node = node.parent;
        }
    }

    // The root of the tree this node currently hangs off. For an overlay that
    // has not been appended yet this is the overlay itself; once appended it is
    // the document node.
    root(): FakeEl {
        let node: FakeEl = this;
        while (node.parent) {
            node = node.parent;
        }
        return node;
    }

    contains(el: FakeEl) {
        let node = el;
        while (node) {
            if (node === this) {
                return true;
            }
            node = node.parent;
        }
        return false;
    }

    focus() {
        this.focused = true;
        const doc = this.root() as FakeEl & { activeElement?: FakeEl };
        if (doc.body) {
            doc.activeElement = this;
        }
    }

    // Real browsers blur a focused element the instant it becomes disabled,
    // handing focus to document.body. That is modelled here rather than
    // assumed, because it is the entire mechanism behind the arrow-key bug:
    // the carousel's keydown listener lives on the overlay, so as soon as
    // focus lands on body the arrow keys bubble to the viewer's camera
    // instead of moving through the gallery.
    get disabled() {
        return this._disabled;
    }

    set disabled(value: boolean) {
        this._disabled = value;
        if (!value) {
            return;
        }
        const doc = this.root() as FakeEl & { activeElement?: FakeEl };
        if (doc.body && doc.activeElement === this) {
            doc.activeElement = doc.body;
        }
    }

    setAttribute(k: string, v: string) {
        this.attrs[k] = v;
    }

    getAttribute(k: string) {
        return this.attrs[k] ?? null;
    }
}

// Execute the runtime and hand back its openGallery/closeGallery. `document`
// is itself a FakeEl (tagName 'document') so that a real event dispatched
// deep inside the modal bubbles, via the same parent chain as the DOM, all
// the way up to a document-level listener -- unless something along the way
// calls stopPropagation, exactly as in the real exported viewer.
const loadRuntime = () => {
    const documentNode = new FakeEl('document');
    const body = new FakeEl('body');
    body.parent = documentNode;
    const document = Object.assign(documentNode, {
        body,
        activeElement: body,
        createElement: (tag: string) => new FakeEl(tag)
    });
    // eslint-disable-next-line no-new-func
    const factory = new Function('document', 'navigator', `${galleryRuntime}\nreturn { openGallery: openGallery, closeGallery: closeGallery };`);
    return { body, document, ...factory(document, { language: 'en' }) };
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

// The modal binds seven listeners (click, keydown, keyup, pointerdown,
// pointerup, wheel, contextmenu) that each call stopPropagation(). That is
// the entire mechanism keeping the exported viewer's document-level input
// handlers -- which drive the camera -- from firing while the modal is open.
// These tests dispatch a real event from inside the modal and assert it
// never reaches a document-level listener, so a future refactor that drops
// stopPropagation() from any one of the seven handlers is caught.
describe('event containment', () => {
    // Sanity check on the fake itself: without this, a broken document/body
    // wiring could make every "did not reach document" assertion below pass
    // vacuously, for the wrong reason.
    it('sanity: a document-level listener does fire for an event dispatched on document', () => {
        const { document } = loadRuntime();
        let reached = false;
        document.addEventListener('click', () => { reached = true; });
        document.dispatch('click');
        expect(reached).toBe(true);
    });

    // click/pointerdown/pointerup/wheel/contextmenu can originate from any
    // element inside the modal (e.g. the image), which have no listeners of
    // their own -- so the event must genuinely bubble through the frame up to
    // the overlay's catch-all handler to be contained.
    const pointerishTypes = ['click', 'pointerdown', 'pointerup', 'wheel', 'contextmenu'];
    pointerishTypes.forEach((type) => {
        it(`stops a bubbled "${type}" from reaching a document-level listener`, () => {
            const { body, document, openGallery } = loadRuntime();
            openGallery(IMAGES, null);
            const overlay = overlayIn(body);
            const img = overlay.querySelector('.ss-gallery-img');
            let reachedDocument = false;
            document.addEventListener(type, () => { reachedDocument = true; });
            img.dispatch(type);
            expect(reachedDocument).toBe(false);
        });
    });

    // Keyboard events target whatever is focused; openGallery focuses the
    // overlay itself (see the arrow-key navigation test above), so dispatch
    // there directly. A neutral key is used so this exercises the handler's
    // baseline containment, not a specific Escape/ArrowLeft/ArrowRight branch.
    const keyTypes = ['keydown', 'keyup'];
    keyTypes.forEach((type) => {
        it(`stops a "${type}" from reaching a document-level listener`, () => {
            const { body, document, openGallery } = loadRuntime();
            openGallery(IMAGES, null);
            const overlay = overlayIn(body);
            let reachedDocument = false;
            document.addEventListener(type, () => { reachedDocument = true; });
            overlay.dispatch(type, { key: 'a' });
            expect(reachedDocument).toBe(false);
        });
    });
});

// Regression test for a bug found in E2E: clicking a nav arrow through to the
// first or last image disabled that arrow while it still held focus. The
// browser then hands focus to document.body, which is OUTSIDE the overlay --
// and since every key handler is bound to the overlay, the arrow keys stopped
// navigating the carousel and drove the viewer's camera instead. Reaching the
// same image with a dot or a keypress never triggered it, because focus never
// sat on the button that went disabled.
describe('focus survives a nav button going disabled', () => {
    const lastIndex = IMAGES.length - 1;

    const clickTo = (el: FakeEl) => {
        el.focus();
        el.dispatch('click');
    };

    it('sanity: the fake blurs a focused element to body when it is disabled', () => {
        const { body, document, openGallery } = loadRuntime();
        openGallery(IMAGES, null);
        const next = body.querySelector('.ss-gallery-next');
        next.focus();
        expect(document.activeElement).toBe(next);
        next.disabled = true;
        expect(document.activeElement).toBe(body);
    });

    it('keeps focus inside the overlay after clicking next to the last image', () => {
        const { body, document, openGallery } = loadRuntime();
        openGallery(IMAGES, null);
        const overlay = overlayIn(body);
        const next = body.querySelector('.ss-gallery-next');
        for (let i = 0; i < lastIndex; i++) {
            clickTo(next);
        }
        expect(next.disabled).toBe(true);
        expect(overlay.contains(document.activeElement)).toBe(true);
    });

    it('keeps focus inside the overlay after clicking prev back to the first image', () => {
        const { body, document, openGallery } = loadRuntime();
        openGallery(IMAGES, null);
        const overlay = overlayIn(body);
        const next = body.querySelector('.ss-gallery-next');
        const prev = body.querySelector('.ss-gallery-prev');
        clickTo(next);
        clickTo(prev);
        expect(prev.disabled).toBe(true);
        expect(overlay.contains(document.activeElement)).toBe(true);
    });

    // The invariant above is only worth holding because of this: a key pressed
    // once focus has escaped reaches the viewer and moves the camera.
    it('still swallows arrow keys at the last image instead of letting them reach the viewer', () => {
        const { body, document, openGallery } = loadRuntime();
        openGallery(IMAGES, null);
        const next = body.querySelector('.ss-gallery-next');
        for (let i = 0; i < lastIndex; i++) {
            clickTo(next);
        }
        let reachedDocument = false;
        document.addEventListener('keydown', () => { reachedDocument = true; });
        (document.activeElement as FakeEl).dispatch('keydown', { key: 'ArrowLeft' });
        expect(reachedDocument).toBe(false);
        expect(body.querySelector('.ss-gallery-img').src).toBe(IMAGES[lastIndex - 1].src);
    });
});

describe('galleryStyle', () => {
    it('styles the overlay above the viewer UI', () => {
        expect(galleryStyle).toContain('.ss-gallery');
        expect(galleryStyle).toContain('z-index');
    });
});
