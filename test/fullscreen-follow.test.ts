import { describe, it, expect } from 'vitest';

import { followFullscreen } from '../src/viewer-companion/fullscreen-follow';

// Minimal DOM double: parent links, appendChild re-parenting, and a document
// that fires 'fullscreenchange' to its listeners.
class FakeEl {
    children: FakeEl[] = [];
    parentNode: FakeEl = null;

    constructor(public name: string) {}

    appendChild(child: FakeEl) {
        if (child.parentNode) {
            const siblings = child.parentNode.children;
            siblings.splice(siblings.indexOf(child), 1);
        }
        child.parentNode = this;
        this.children.push(child);
        return child;
    }
}

const makeDocument = () => {
    const body = new FakeEl('body');
    const root = body.appendChild(new FakeEl('sse-viewer'));
    const listeners: Record<string, (() => void)[]> = {};
    const doc = {
        body,
        fullscreenElement: null as FakeEl,
        addEventListener(name: string, fn: () => void) {
            (listeners[name] ??= []).push(fn);
        },
        enterFullscreen(el: FakeEl) {
            doc.fullscreenElement = el;
            (listeners.fullscreenchange ?? []).forEach((fn) => fn());
        },
        exitFullscreen() {
            doc.fullscreenElement = null;
            (listeners.fullscreenchange ?? []).forEach((fn) => fn());
        }
    };
    return { doc, body, root };
};

// The viewer fullscreens its own root (.sse-viewer), and a fullscreen page
// draws only that element's subtree: an overlay left on body is not drawn.
describe('followFullscreen', () => {
    it('moves mounted overlays into the fullscreen element, and back to body on exit', () => {
        const { doc, body, root } = makeDocument();
        const a = body.appendChild(new FakeEl('a'));
        const b = body.appendChild(new FakeEl('b'));
        followFullscreen(doc as any, () => [a, b] as any);

        doc.enterFullscreen(root);
        expect(a.parentNode).toBe(root);
        expect(b.parentNode).toBe(root);
        // after the viewer's own ui, so they keep stacking above it
        expect(root.children.slice(-2)).toEqual([a, b]);

        doc.exitFullscreen();
        expect(a.parentNode).toBe(body);
        expect(b.parentNode).toBe(body);
    });

    it('leaves overlays that were never mounted alone', () => {
        const { doc, root } = makeDocument();
        const unmounted = new FakeEl('later');
        followFullscreen(doc as any, () => [unmounted, null] as any);
        doc.enterFullscreen(root);
        expect(unmounted.parentNode).toBeNull();
    });

    it('places an overlay mounted while already fullscreen', () => {
        const { doc, body, root } = makeDocument();
        let late: FakeEl = null;
        const place = followFullscreen(doc as any, () => [late] as any);
        doc.enterFullscreen(root);
        late = body.appendChild(new FakeEl('late'));
        place();
        expect(late.parentNode).toBe(root);
    });

    it('is injectable verbatim: no backslash escapes for the companion templates to eat', () => {
        expect(followFullscreen.toString()).not.toContain(String.fromCharCode(92));
    });
});
