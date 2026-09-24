import { describe, it, expect } from 'vitest';

import { buildLoadingBarInjection } from '../src/viewer-companion/loading-bar';

// The companion ships as a stringified runtime, so the only honest test is to
// run the exact string the exporter emits against a fake that reproduces the
// viewer's observable surface:
//
//   - app.systems.gsplat fires 'frame:ready' EVERY frame from the very first
//     one (GSplatManager.fireFrameReadyEvent); the viewer only registers its
//     own listener at the ready gate, which is what makes the bar late.
//   - global.state is an observe() Proxy that fires '<prop>:changed' ONLY when
//     the value actually changes.
//   - initUI registers the bar painter (and the poster unblur) on
//     'progress:changed' inside createViewer(), which runs synchronously right
//     after window.__supersplatViewer is published (the engine patch publishes
//     the handle immediately before initUI runs, with no await between them).
//     So by the time this companion's poll ever sees the handle, the viewer's
//     painter is already registered, and the companion always gets the last
//     word.
//
// The host therefore registers a painter up front and records everything it
// paints: that array is "what the user sees".

type Bus = {
    on: (n: string, f: (...a: any[]) => void) => void;
    off: (n: string, f: (...a: any[]) => void) => void;
    fire: (n: string, ...a: any[]) => void;
    count: (n: string) => number;
};

const makeBus = (): Bus => {
    const listeners: Record<string, ((...a: any[]) => void)[]> = {};
    return {
        on: (n, f) => {
            (listeners[n] ??= []).push(f);
        },
        off: (n, f) => {
            listeners[n] = (listeners[n] ?? []).filter(x => x !== f);
        },
        fire: (n, ...a) => {
            [...(listeners[n] ?? [])].forEach(f => f(...a));
        },
        count: n => (listeners[n] ?? []).length
    };
};

const makeHost = (search = '') => {
    const href = `https://export.test/index.html${search}`;
    const gsplat = makeBus();
    const events = makeBus();

    // observe(): fires only on an actual change, synchronously, inside the set
    const target = { progress: 0 };
    const state = new Proxy(target, {
        set(t: any, prop: string, value: any) {
            if (t[prop] !== value) {
                const prev = t[prop];
                t[prop] = value;
                events.fire(`${prop}:changed`, value, prev);
            }
            return true;
        }
    });

    // The viewer's own painter, registered by initUI BEFORE the handle is
    // published. Everything it records is what the user sees.
    const painted: number[] = [];
    events.on('progress:changed', (p: number) => painted.push(p));

    const app = { systems: { gsplat } };

    const styles: { textContent: string }[] = [];
    const doc: any = {
        head: { appendChild: (el: any) => styles.push(el) },
        documentElement: {},
        createElement: (tag: string) => ({ tagName: tag, textContent: '' })
    };

    const win: any = {};

    let queue: (() => void)[] = [];
    const requestAnimationFrame = (fn: () => void) => {
        queue.push(fn);
    };
    const flushRaf = () => {
        const q = queue;
        queue = [];
        q.forEach(fn => fn());
    };

    return {
        win,
        app,
        gsplat,
        events,
        state,
        painted,
        styles,
        doc,
        requestAnimationFrame,
        flushRaf,
        pendingRaf: () => queue.length,
        location: { href, search },
        // what the user is currently looking at
        displayed: () => (painted.length ? painted[painted.length - 1] : null),
        publishViewer(viewer?: any) {
            win.__supersplatViewer = viewer ?? { global: { app, state, events } };
        },
        // one frame's worth of the engine reporting streaming state
        frameReady(loading: number, ready = false) {
            gsplat.fire('frame:ready', null, null, ready, loading);
        }
    };
};

const runCompanion = (host: ReturnType<typeof makeHost>) => {
    const script = buildLoadingBarInjection().match(/<script>([\s\S]*?)<\/script>/)[1];
    const consoleStub = { info: () => {}, warn: () => {}, error: () => {} };
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'requestAnimationFrame', 'location', 'console', script)(
        host.win, host.doc, host.requestAnimationFrame, host.location, consoleStub
    );
};

// Attach the companion to a published viewer and settle its startup poll.
const attach = (host: ReturnType<typeof makeHost>) => {
    runCompanion(host);
    host.publishViewer();
    host.flushRaf();
};

describe('loading-bar companion: paint immediately', () => {
    it('injects a stylesheet that fills the bar at 0% before any JS progress arrives', () => {
        const host = makeHost();
        runCompanion(host);

        const css = host.styles.map(s => s.textContent).join('');
        expect(css).toContain('.sse-viewer .sse-loadingWrap > .sse-loadingBar');
        expect(css).toContain('background-image');
        expect(css).toContain('.sse-viewer .sse-loadingWrap > .sse-loadingText:empty::after');
        expect(css).toContain('0%');
    });

    it('uses no !important, so the viewer inline style writes still win', () => {
        const host = makeHost();
        runCompanion(host);

        expect(host.styles.map(s => s.textContent).join('')).not.toContain('!important');
    });

    it('stands down entirely under ?noui, which hides the whole UI', () => {
        const host = makeHost('?noui');
        runCompanion(host);
        host.publishViewer();
        host.flushRaf();

        expect(host.styles).toHaveLength(0);
        expect(host.pendingRaf()).toBe(0);
        expect(host.gsplat.count('frame:ready')).toBe(0);
    });
});

describe('loading-bar companion: gsplat gauge', () => {
    it('paints progress from frame:ready long before the viewer reaches its ready gate', () => {
        const host = makeHost();
        attach(host);

        host.frameReady(8);   // octree resolved, coarse blocks queued
        host.frameReady(6);
        host.frameReady(4);

        // the viewer's own readyHandler does not exist yet, so every one of
        // these came from the companion
        expect(host.painted).toEqual([25, 50]);
    });

    it('paints 75 when three of four blocks have drained, with no collision term', () => {
        const host = makeHost();
        attach(host);

        host.frameReady(4);
        host.frameReady(1);

        expect(host.state.progress).toBe(75);
    });

    it('shows nothing above zero until the octree has queued its first work', () => {
        const host = makeHost();
        attach(host);

        host.frameReady(0);   // no octree instances yet: 0 of 0 is not "done"
        host.frameReady(0);

        expect(host.painted).toEqual([]);
    });

    it('caps its own gauge below 100 so the reveal owns the last step', () => {
        const host = makeHost();
        attach(host);

        host.frameReady(4);
        host.frameReady(0);   // every block landed, but the gate has not opened

        expect(host.displayed()).toBe(99);
    });

    it('reaches the gsplat event handler through global.app.systems.gsplat', () => {
        const host = makeHost();
        runCompanion(host);
        // a handle whose global lacks the app must read as "not ready yet"
        host.publishViewer({ global: { state: host.state, events: host.events } });
        host.flushRaf();

        expect(host.gsplat.count('frame:ready')).toBe(0);
        expect(host.pendingRaf()).toBeGreaterThan(0);

        host.publishViewer();
        host.flushRaf();
        host.frameReady(4);
        host.frameReady(2);

        expect(host.displayed()).toBe(50);
    });

    it('gives up polling after a bounded number of frames when the handle never appears', () => {
        const host = makeHost();
        runCompanion(host);

        let frames = 0;
        while (host.pendingRaf() > 0 && frames < 40000) {
            host.flushRaf();
            frames++;
        }

        expect(host.pendingRaf()).toBe(0);
        expect(frames).toBeLessThan(40000);
    });
});

describe('loading-bar companion: never goes backwards', () => {
    // The viewer's gauge is drain-from-peak over a LIVE pending count, not
    // loaded/total, so any work queued after the peak drops the percentage --
    // field-reported on mobile as "80% -> 60% -> 100%".
    it('repaints at the high-water mark when the viewer reports a lower value', () => {
        const host = makeHost();
        attach(host);
        host.frameReady(4);
        host.frameReady(2);
        expect(host.displayed()).toBe(50);

        // the viewer's readyHandler, registered at the gate with a fresh
        // watermark, computes 0
        host.state.progress = 0;

        expect(host.displayed()).toBe(50);
    });

    // The companion's OWN gauge (show(), fed by update()) is drain-from-peak
    // too, so a requeue past the previous peak recomputes 0 just like the
    // viewer's does -- this is the exact field-reported "80% -> 60%" defect,
    // reproduced entirely within frame:ready with no viewer write involved.
    // show()'s own high-water guard (if (p <= shown) return) is what absorbs
    // it; deleting that guard is invisible to every other surviving test here
    // (the other never-goes-backwards cases go through onProgress, which has
    // its own clamp, or the NaN case, which returns before reaching show()).
    it('holds its own high-water mark across a requeue past the previous peak', () => {
        const host = makeHost();
        attach(host);
        host.frameReady(4);
        host.frameReady(2);
        expect(host.displayed()).toBe(50);

        host.frameReady(6);   // new work queued: peak rises to 6, blocks -> 0
        expect(host.displayed()).toBe(50);

        host.frameReady(0);   // everything drained against the new peak of 6
        expect(host.displayed()).toBe(99);
    });

    it('lets a rising viewer value through untouched', () => {
        const host = makeHost();
        attach(host);
        host.frameReady(4);
        host.frameReady(2);

        host.state.progress = 80;

        expect(host.displayed()).toBe(80);
        expect(host.painted).toEqual([50, 80]);
    });

    // On SOG/package exports there is a SECOND upstream writer: loadGsplat's
    // asset 'progress' callback, which downloadArrayBuffer drives to 100 as soon
    // as the content bundle lands -- while the reveal still waits on the skybox
    // (Promise.all([gsplatLoad, skyboxLoad])). Left alone, the running-max clamp
    // would pin the bar at a finished-looking 100% for that whole window, which
    // reads as a hang. The display is therefore held below 100 until the scene
    // is actually revealed; at that moment .sse-loadingWrap gains .sse-hidden
    // anyway, so nothing is lost.
    it('holds the display below 100 until the scene is actually revealed', () => {
        const host = makeHost();
        attach(host);

        host.state.progress = 100;

        expect(host.displayed()).toBe(99);
    });

    it('lets 100 through once the reveal has happened', () => {
        const host = makeHost();
        attach(host);
        host.state.progress = 100;

        host.events.fire('loaded:changed', true);
        host.state.progress = 100;

        expect(host.displayed()).toBe(100);
    });

    it('ignores a non-numeric pending count instead of poisoning the gauge', () => {
        const host = makeHost();
        attach(host);
        host.frameReady(4);
        host.frameReady(2);

        host.frameReady(NaN);

        expect(host.displayed()).toBe(50);
        host.frameReady(1);
        expect(host.displayed()).toBe(75);
    });

    it('holds the viewer high-water mark too, not just its own', () => {
        const host = makeHost();
        attach(host);
        host.state.progress = 80;

        host.state.progress = 60;

        expect(host.displayed()).toBe(80);
    });
});

describe('loading-bar companion: teardown', () => {
    it('detaches from frame:ready once the scene is revealed', () => {
        const host = makeHost();
        attach(host);
        host.frameReady(4);
        expect(host.gsplat.count('frame:ready')).toBe(1);

        host.events.fire('loaded:changed', true);

        expect(host.gsplat.count('frame:ready')).toBe(0);
    });

    it('stops polling once attached, since frame:ready and progress:changed take over', () => {
        const host = makeHost();
        attach(host);

        expect(host.pendingRaf()).toBe(0);
    });
});

describe('buildLoadingBarInjection', () => {
    it('carries no collision term: supersplat-viewer >= 1.32 reveals without waiting for collision', () => {
        const out = buildLoadingBarInjection();
        expect(out).not.toContain('COLLISION_BYTES');
        expect(out).not.toContain('voxel.bin');
        expect(out).not.toContain('window.fetch');
    });

    it('emits the runtime as a script tag', () => {
        const out = buildLoadingBarInjection();
        expect(out.startsWith('<script>')).toBe(true);
        expect(out.endsWith('</script>')).toBe(true);
    });

    it('is template-cooking safe: ES5 only, no backslash escapes at all', () => {
        const out = buildLoadingBarInjection();
        // companion templates cook backslash escapes away at build time
        expect(out).not.toMatch(/\\/);
        expect(out).not.toContain('=>');
        expect(out).not.toContain('const ');
        expect(out).not.toContain('let ');
        expect(out).not.toContain('`');
    });
});
