import { describe, it, expect } from 'vitest';

import { buildEarlyLodClampInjection } from '../src/viewer-companion/early-lod-clamp';

// The companion ships as a stringified runtime whose whole purpose is TIMING --
// it has to write the gsplat component's lodRange before the engine's first LOD
// selection -- so the only honest test is to run the string the exporter emits
// against a fake that reproduces the engine's frame order.
//
// The engine's App.tick fires 'frameupdate', then updates, then fires
// 'framerender'; GSplatComponentSystem listens on 'framerender' and that is
// where LOD selection queues block downloads. The fake records the component's
// lodRange at every 'framerender', so a test can assert exactly what the
// selection would have seen on each frame.

type FakeComp = {
    type: string;
    lodRangeMin: number;
    lodRangeMax: number;
    resource: any;
};

// A gsplat component as the engine builds it: the stock defaults are
// _lodRangeMin = 0 / _lodRangeMax = 99, which is what makes the unclamped
// viewer request the whole pyramid.
const makeComp = (lodLevels: number | null, resourceResolved = true): FakeComp => ({
    type: 'gsplat',
    lodRangeMin: 0,
    lodRangeMax: 99,
    resource: resourceResolved ? { octree: lodLevels === null ? null : { lodLevels } } : null
});

const makeApp = () => {
    const listeners: Record<string, ((...args: any[]) => void)[]> = {};
    const comps: FakeComp[] = [];
    // one entry per framerender: the lodRange the engine's LOD selection would
    // have read for each component present, in order
    const selections: [number, number][][] = [];

    const app = {
        root: {
            findComponent: (name: string) => comps.find(c => c.type === name) ?? null
        },
        on(name: string, fn: (...args: any[]) => void) {
            (listeners[name] ??= []).push(fn);
        },
        off(name: string, fn: (...args: any[]) => void) {
            listeners[name] = (listeners[name] ?? []).filter(f => f !== fn);
        },
        fire(name: string, ...args: any[]) {
            [...(listeners[name] ?? [])].forEach(fn => fn(...args));
        },
        // the asset 'load' callback -- an HTTP macrotask, so always BETWEEN ticks
        addComp(c: FakeComp) {
            comps.push(c);
        },
        tick() {
            app.fire('frameupdate', 16);
            app.fire('framerender');
        },
        comps,
        selections,
        listenerCount: (name: string) => (listeners[name] ?? []).length
    };
    // Stand in for GSplatComponentSystem, which hooks 'framerender' in its own
    // constructor -- during app creation, so before any companion could. That
    // ordering is what makes these tests discriminate: a companion that hooked
    // 'framerender' instead of 'frameupdate' would run AFTER this recorder and
    // the selection would read the unclamped range, exactly as in the engine.
    app.on('framerender', () => {
        selections.push(comps.map(c => [c.lodRangeMin, c.lodRangeMax] as [number, number]));
    });
    return app;
};

const makeHost = (search = '') => {
    // The companion reads the query the way the viewer itself does --
    // new URL(location.href).searchParams -- so the stub needs a parseable
    // absolute href, not just a search string.
    const href = `https://export.test/index.html${search}`;
    const app = makeApp();
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
        app,
        win,
        requestAnimationFrame,
        flushRaf,
        pendingRaf: () => queue.length,
        location: { href, search },
        // The companion's own rAF callback is registered at PARSE time, before
        // app.start() registers the engine tick, so within a frame ours runs
        // first. frame() models that ordering; tickOnly() models the pessimistic
        // case where only the engine ticks.
        frame() {
            flushRaf();
            app.tick();
        },
        publishViewer(viewer?: any) {
            win.__supersplatViewer = viewer ?? { global: { app } };
        }
    };
};

const runCompanion = (host: ReturnType<typeof makeHost>) => {
    const script = buildEarlyLodClampInjection().match(/<script>([\s\S]*?)<\/script>/)[1];
    const consoleStub = { info: () => {}, warn: () => {} };
    // eslint-disable-next-line no-new-func
    new Function('window', 'requestAnimationFrame', 'location', 'console', script)(
        host.win, host.requestAnimationFrame, host.location, consoleStub
    );
};

describe('early LOD clamp companion', () => {
    it('clamps the start scene to its coarsest level before the first framerender that could select blocks', () => {
        const host = makeHost();
        runCompanion(host);
        host.frame();                       // viewer handle not published yet
        host.publishViewer();
        host.flushRaf();                    // handle found -> hook frameupdate
        host.app.addComp(makeComp(4));      // asset load callback, between ticks

        host.app.tick();                    // engine tick alone: frameupdate must win

        expect(host.app.selections.at(-1)).toEqual([[3, 3]]);
    });

    it('clamps from its own frame poll when that runs ahead of the engine tick', () => {
        const host = makeHost();
        runCompanion(host);
        host.frame();
        host.publishViewer();
        host.app.addComp(makeComp(4));

        host.frame();                       // poll runs before the tick

        expect(host.app.selections.at(-1)).toEqual([[3, 3]]);
    });

    it('never lets a framerender see the stock 0..99 range once the component exists', () => {
        const host = makeHost();
        runCompanion(host);
        host.frame();
        host.publishViewer();
        host.flushRaf();
        host.app.addComp(makeComp(4));

        host.frame();
        host.frame();

        expect(host.app.selections.every(s => s.every(([min, max]) => max !== 99))).toBe(true);
    });

    it('detaches after clamping so the viewer reveal can reopen the range', () => {
        const host = makeHost();
        runCompanion(host);
        host.frame();
        host.publishViewer();
        host.flushRaf();
        host.app.addComp(makeComp(4));
        host.frame();

        expect(host.app.listenerCount('frameupdate')).toBe(0);
        host.flushRaf();
        expect(host.pendingRaf()).toBe(0);

        // the viewer's applyPerfSettings at the ready gate
        host.app.comps[0].lodRangeMin = 0;
        host.app.comps[0].lodRangeMax = 1000;
        host.frame();

        expect(host.app.selections.at(-1)).toEqual([[0, 1000]]);
    });

    it('leaves a non-streaming component alone and stops polling', () => {
        const host = makeHost();
        runCompanion(host);
        host.publishViewer();
        host.flushRaf();
        host.app.addComp(makeComp(null));   // SOG/PLY export: no octree

        host.frame();

        expect(host.app.selections.at(-1)).toEqual([[0, 99]]);
        expect(host.app.listenerCount('frameupdate')).toBe(0);
        host.flushRaf();
        expect(host.pendingRaf()).toBe(0);
    });

    it('keeps waiting while the component exists but its resource has not resolved', () => {
        const host = makeHost();
        runCompanion(host);
        host.publishViewer();
        host.flushRaf();
        const comp = makeComp(4, false);
        host.app.addComp(comp);

        host.frame();
        expect(host.app.selections.at(-1)).toEqual([[0, 99]]);

        comp.resource = { octree: { lodLevels: 4 } };
        host.frame();

        expect(host.app.selections.at(-1)).toEqual([[3, 3]]);
    });

    it('ignores portal scenes that load after the start scene', () => {
        const host = makeHost();
        runCompanion(host);
        host.publishViewer();
        host.flushRaf();
        host.app.addComp(makeComp(4));
        host.frame();

        host.app.addComp(makeComp(5));      // portals companion loads scene 1
        host.frame();

        expect(host.app.selections.at(-1)).toEqual([[3, 3], [0, 99]]);
    });

    it('reaches the app through global.app, not the ready-gated debugPanel/navCursor', () => {
        const host = makeHost();
        runCompanion(host);
        // debugPanel and navCursor are both built inside the very Promise.all
        // this companion exists to get ahead of, so a viewer that exposes only
        // those must read as "not ready yet" -- never as a usable app.
        host.publishViewer({ debugPanel: { _global: { app: host.app } }, navCursor: { app: host.app } });
        host.flushRaf();
        host.app.addComp(makeComp(4));

        host.frame();

        expect(host.app.selections.at(-1)).toEqual([[0, 99]]);
    });

    it('gives up after a bounded number of frames when no gsplat ever appears', () => {
        const host = makeHost();
        runCompanion(host);
        host.publishViewer();

        let frames = 0;
        while (host.pendingRaf() > 0 && frames < 40000) {
            host.flushRaf();
            frames++;
        }

        expect(host.pendingRaf()).toBe(0);
        expect(frames).toBeLessThan(40000);
        expect(host.app.listenerCount('frameupdate')).toBe(0);
    });

    it('does not clamp under ?fullload, which deliberately loads everything before the reveal', () => {
        const host = makeHost('?fullload');
        runCompanion(host);
        host.publishViewer();
        host.flushRaf();
        host.app.addComp(makeComp(4));

        host.frame();

        expect(host.app.selections.at(-1)).toEqual([[0, 99]]);
        expect(host.pendingRaf()).toBe(0);
    });

    // Matches the param the way the viewer does (url.searchParams.has), not by
    // substring: another param whose NAME or VALUE merely contains the word
    // must not switch the clamp off and quietly restore the slow load.
    it('clamps normally when another param merely contains the word fullload', () => {
        const host = makeHost('?content=fullload.json&myfullload=1');
        runCompanion(host);
        host.publishViewer();
        host.flushRaf();
        host.app.addComp(makeComp(4));

        host.frame();

        expect(host.app.selections.at(-1)).toEqual([[3, 3]]);
    });

    it('stands down for ?fullload=0, which the viewer also reads as present', () => {
        const host = makeHost('?fullload=0');
        runCompanion(host);
        host.publishViewer();
        host.flushRaf();
        host.app.addComp(makeComp(4));

        host.frame();

        expect(host.app.selections.at(-1)).toEqual([[0, 99]]);
    });
});

describe('buildEarlyLodClampInjection', () => {
    it('emits the clamp runtime as a script tag', () => {
        const out = buildEarlyLodClampInjection();
        expect(out.startsWith('<script>')).toBe(true);
        expect(out).toContain('__supersplatViewer');
        expect(out).toContain("findComponent('gsplat')");
        expect(out).toContain('lodLevels');
    });

    it('is template-cooking safe: ES5 only, no backslash escapes at all', () => {
        const out = buildEarlyLodClampInjection();
        // companion templates cook backslash escapes away at build time
        expect(out).not.toMatch(/\\/);
        expect(out).not.toContain('=>');
        expect(out).not.toContain('const ');
        expect(out).not.toContain('let ');
        expect(out).not.toContain('`');
    });
});
