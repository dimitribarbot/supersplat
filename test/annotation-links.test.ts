import { describe, it, expect } from 'vitest';

import { buildAnnotationLinksInjection, buildLinkTable } from '../src/viewer-companion/annotation-links';

// The companion ships as a stringified runtime, so the only honest way to test
// it is to run the string the exporter actually emits. These fakes cover just
// the DOM/viewer surface the companion touches -- enough to reproduce the
// exported viewer's *shared tooltip*, which is the whole source of the bug this
// suite pins: one .pc-annotation element is reused for every annotation, so
// anything appended to it survives until something removes it.

class FakeEl {
    children: FakeEl[] = [];
    parent: FakeEl = null;
    className = '';
    textContent = '';
    href = '';
    target = '';
    rel = '';
    private attrs: Record<string, string> = {};

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

    addEventListener() {}
    setAttribute(k: string, v: string) {
        this.attrs[k] = v;
    }
    getAttribute(k: string) {
        return this.attrs[k] ?? null;
    }
}

// Mirrors the exported viewer: one shared tooltip whose title/text are rewritten
// on every activation (see Annotation.showTooltip, which writes textContent on
// the title/text children and then fires 'show').
const makeViewer = () => {
    const root = new FakeEl('div');
    const host = new FakeEl('div');
    host.className = 'annotations';
    const tooltip = new FakeEl('div');
    tooltip.className = 'pc-annotation';
    host.appendChild(tooltip);
    root.appendChild(host);

    const handlers: Record<string, ((...args: any[]) => void)[]> = {};
    const events = {
        on: (name: string, fn: (...args: any[]) => void) => {
            (handlers[name] ??= []).push(fn);
        },
        fire: (name: string, ...args: any[]) => {
            (handlers[name] ?? []).forEach(fn => fn(...args));
        }
    };

    const document = {
        readyState: 'complete',
        body: root,
        getElementById: (id: string) => (id === 'annotations' ? host : null),
        querySelector: (s: string) => root.querySelector(s),
        querySelectorAll: (s: string) => root.querySelectorAll(s),
        createElement: (tag: string) => new FakeEl(tag),
        addEventListener: () => {}
    };

    const window = {
        __supersplatAnnotationLinks: [] as any[],
        __supersplatViewer: { global: { events } },
        location: { href: 'https://viewer.test/index.html' }
    };

    return { root, host, tooltip, events, document, window };
};

// Pull the runtime out of the emitted fragment and execute it against the fakes.
// Bare globals are passed as parameters so they shadow the real ones.
const runCompanion = (annotations: any[], viewer: ReturnType<typeof makeViewer>) => {
    const injection = buildAnnotationLinksInjection(annotations);
    if (injection === '') {
        return false;
    }
    const scripts = [...injection.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    viewer.window.__supersplatAnnotationLinks = buildLinkTable(annotations);
    const MutationObserver = class {
        constructor(_cb: any) {}
        observe() {}
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
        const viewer = makeViewer();
        expect(runCompanion(annotations, viewer)).toBe(true);

        viewer.events.fire('annotation.activate', annotations[0]);

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
        const viewer = makeViewer();
        runCompanion(annotations, viewer);

        viewer.events.fire('annotation.activate', annotations[0]);
        expect(linkIn(viewer)).not.toBeNull();
        viewer.events.fire('annotation.activate', annotations[1]);

        expect(linkIn(viewer)).toBeNull();
    });

    it('never stacks two links in the shared tooltip', () => {
        const viewer = makeViewer();
        runCompanion(annotations, viewer);

        viewer.events.fire('annotation.activate', annotations[0]);
        viewer.events.fire('annotation.activate', annotations[0]);

        expect(viewer.tooltip.querySelectorAll('.ss-annotation-link')).toHaveLength(1);
    });

    it('rejects a non-http(s) url rather than injecting it', () => {
        const hostile = [{ title: 'x', extras: { url: 'javascript:alert(1)' } }];
        const viewer = makeViewer();
        expect(runCompanion(hostile, viewer)).toBe(true);

        viewer.events.fire('annotation.activate', hostile[0]);

        expect(linkIn(viewer)).toBeNull();
    });

    it('is not injected at all when no annotation has a url', () => {
        expect(buildAnnotationLinksInjection([{ title: 'a', extras: {} }])).toBe('');
    });
});
