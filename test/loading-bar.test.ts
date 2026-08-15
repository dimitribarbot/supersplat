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
//     'progress:changed' INSIDE main(), while window.__supersplatViewer is
//     published only after main() resolves. So the viewer's painter is always
//     registered first and the companion always gets the last word.
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

// A response whose chunks the test delivers by hand, so a download can be
// advanced one chunk at a time and the gauge inspected in between.
//
// It models the browser's DISTURBED-BODY rules on purpose. That is the property
// the companion's correctness hangs on: reading `response.body` directly marks
// the body used, so a companion that skipped clone() would make the viewer's own
// arrayBuffer() reject -- collisionLoad rejects, the Promise.all rejects, and
// the viewer NEVER REVEALS. A fake that let both branches share one body would
// pass every test while the real export was bricked.
type Branch = { pending: ((v: any) => void)[]; queue: any[] };

const makeStreamedResponse = (ok = true) => {
    const branches: Branch[] = [];
    let disturbed = false;

    const newBranch = () => {
        const b: Branch = { pending: [], queue: [] };
        branches.push(b);
        return {
            getReader: () => ({
                read: () => new Promise<any>((resolve) => {
                    if (b.queue.length) {
                        resolve(b.queue.shift());
                    } else {
                        b.pending.push(resolve);
                    }
                })
            })
        };
    };

    const deliver = (item: any) => {
        branches.forEach((b) => {
            const waiter = b.pending.shift();
            if (waiter) {
                waiter(item);
            } else {
                b.queue.push(item);
            }
        });
    };

    const response: any = {
        ok,
        get body() {
            const branch = newBranch();
            return {
                getReader: () => {
                    disturbed = true;
                    return branch.getReader();
                }
            };
        },
        clone: () => {
            if (disturbed) {
                throw new TypeError('Failed to execute clone: body is already used');
            }
            return { ok, body: newBranch() };
        },
        // what loadVoxelCollision actually calls on the response it was handed;
        // resolves with the byte count it managed to read
        arrayBuffer: () => {
            if (disturbed) {
                return Promise.reject(new TypeError('body is already used'));
            }
            disturbed = true;
            const reader = newBranch().getReader();
            let total = 0;
            const pump = (): Promise<number> => reader.read().then((chunk: any) => {
                if (chunk.done) {
                    return total;
                }
                total += chunk.value.length;
                return pump();
            });
            return pump();
        }
    };

    return {
        response,
        push: (bytes: number) => deliver({ done: false, value: new Uint8Array(bytes) }),
        end: () => deliver({ done: true })
    };
};

const flush = async () => {
    for (let i = 0; i < 10; i++) {
        await Promise.resolve();
    }
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

    // The viewer's real fetch, and a record of exactly how it was called --
    // arguments AND receiver, so the wrapper's pass-through can be asserted.
    const requested: string[] = [];
    const calls: { input: any; init: any; self: any }[] = [];
    const responses = new Map<string, any>();
    const baseFetch = function (this: any, input: any, init?: any) {
        const url = typeof input === 'string' ? input : input?.url ?? String(input);
        requested.push(url);
        calls.push({ input, init, self: this });
        return Promise.resolve(responses.get(url) ?? { ok: true, body: null, clone: () => ({}) });
    };

    const win: any = { fetch: baseFetch };

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
        requested,
        calls,
        responses,
        baseFetch,
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

const runCompanion = (host: ReturnType<typeof makeHost>, collisionBytes = 0) => {
    const script = buildLoadingBarInjection(collisionBytes).match(/<script>([\s\S]*?)<\/script>/)[1];
    const consoleStub = { info: () => {}, warn: () => {}, error: () => {} };
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'requestAnimationFrame', 'location', 'console', script)(
        host.win, host.doc, host.requestAnimationFrame, host.location, consoleStub
    );
};

// Attach the companion to a published viewer and settle its startup poll.
const attach = (host: ReturnType<typeof makeHost>, collisionBytes = 0) => {
    runCompanion(host, collisionBytes);
    host.publishViewer();
    host.flushRaf();
};

describe('loading-bar companion: paint immediately', () => {
    it('injects a stylesheet that fills the bar at 0% before any JS progress arrives', () => {
        const host = makeHost();
        runCompanion(host);

        const css = host.styles.map(s => s.textContent).join('');
        expect(css).toContain('#loadingWrap > #loadingBar');
        expect(css).toContain('background-image');
        expect(css).toContain('#loadingWrap > #loadingText:empty::after');
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
        expect(host.win.fetch).toBe(host.baseFetch);
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
    // as the content bundle lands -- while the collision binary may still have
    // seconds to run. Left alone, the running-max clamp would pin the bar at a
    // finished-looking 100% for that whole window, which reads as a hang. The
    // display is therefore held below 100 until the scene is actually revealed;
    // at that moment #loadingWrap is hidden anyway, so nothing is lost.
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

describe('loading-bar companion: collision download', () => {
    const withBin = (host: ReturnType<typeof makeHost>, url = './index.voxel.bin') => {
        const bin = makeStreamedResponse();
        host.responses.set(url, bin.response);
        return bin;
    };

    // The exporter bakes the RAW byte length of index.voxel.bin. The browser
    // hands the stream back already decompressed, so counting stream bytes
    // against the raw size is correct whether or not the CDN gzipped it --
    // Content-Length would report the compressed size and skew the gauge 3.5x.
    it('advances the bar as the collision binary streams in', async () => {
        const host = makeHost();
        const bin = withBin(host);
        attach(host, 1000);

        host.win.fetch('./index.voxel.bin');
        await flush();
        bin.push(500);
        await flush();

        expect(host.displayed()).toBe(25);   // half of collision, none of gsplat
    });

    it('weights the collision download and the gsplat blocks equally', async () => {
        const host = makeHost();
        const bin = withBin(host);
        attach(host, 1000);
        host.win.fetch('./index.voxel.bin');
        await flush();

        bin.push(1000);
        await flush();
        expect(host.displayed()).toBe(50);   // collision done, gsplat untouched

        host.frameReady(4);
        host.frameReady(0);

        expect(host.displayed()).toBe(99);   // both done, still capped below 100
    });

    it('does not touch window.fetch at all when the export has no collision', () => {
        const host = makeHost();
        attach(host, 0);

        expect(host.win.fetch).toBe(host.baseFetch);
    });

    it('restores the original fetch as soon as the collision request is seen', async () => {
        const host = makeHost();
        withBin(host);
        attach(host, 1000);
        expect(host.win.fetch).not.toBe(host.baseFetch);

        host.win.fetch('./index.voxel.bin');

        expect(host.win.fetch).toBe(host.baseFetch);
    });

    it('passes unrelated requests straight through', async () => {
        const host = makeHost();
        const meta = { ok: true, body: null, clone: () => ({}) };
        host.responses.set('./lod-meta.json', meta);
        attach(host, 1000);

        const got = await host.win.fetch('./lod-meta.json');

        expect(got).toBe(meta);
        expect(host.requested).toEqual(['./lod-meta.json']);
    });

    // A ?collision= override points the viewer at a different voxel file, whose
    // size the exporter cannot know -- so the baked total would be wrong.
    it('drops the collision term when a ?collision override is present', () => {
        const host = makeHost('?collision=other.voxel.json');
        attach(host, 1000);

        expect(host.win.fetch).toBe(host.baseFetch);

        host.frameReady(4);
        host.frameReady(2);

        expect(host.displayed()).toBe(50);   // gsplat alone owns the whole range
    });

    // The single most dangerous regression available here: reading the response
    // the viewer was handed, instead of a clone(), disturbs its body. The
    // viewer's arrayBuffer() then rejects, collisionLoad rejects, the gating
    // Promise.all rejects -- and the scene never reveals at all.
    it('leaves the response body intact for the viewer to consume', async () => {
        const host = makeHost();
        const bin = withBin(host);
        attach(host, 1000);

        const fetched = await host.win.fetch('./index.voxel.bin');
        await flush();                       // companion clones here
        const consumed = fetched.arrayBuffer();   // loadVoxelCollision's own read

        bin.push(600);
        bin.push(400);
        bin.end();
        await flush();

        await expect(consumed).resolves.toBe(1000);
        expect(host.displayed()).toBe(50);   // and the companion still counted every byte
    });

    it('forwards every argument and the receiver to the original fetch', async () => {
        const host = makeHost();
        attach(host, 1000);
        const init = { headers: { 'x-test': '1' } };

        await host.win.fetch('./lod-meta.json', init);

        expect(host.calls).toEqual([{ input: './lod-meta.json', init, self: host.win }]);
    });

    it('recognises the collision request given a Request object', () => {
        const host = makeHost();
        attach(host, 1000);

        host.win.fetch({ url: './index.voxel.bin' });

        expect(host.win.fetch).toBe(host.baseFetch);
    });

    it('recognises the collision request given a URL object', () => {
        const host = makeHost();
        attach(host, 1000);

        host.win.fetch(new URL('https://export.test/index.voxel.bin'));

        expect(host.win.fetch).toBe(host.baseFetch);
    });

    it('keeps the gsplat gauge working when the collision request fails', async () => {
        const host = makeHost();
        host.responses.set('./index.voxel.bin', { ok: false, body: null, clone: () => ({}) });
        attach(host, 1000);
        host.win.fetch('./index.voxel.bin');
        await flush();

        host.frameReady(4);
        host.frameReady(0);

        expect(host.displayed()).toBe(50);   // gsplat half of the blend, collision stuck at 0
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

    it('restores fetch at the reveal even if the collision binary never arrived', () => {
        const host = makeHost();
        attach(host, 1000);
        expect(host.win.fetch).not.toBe(host.baseFetch);

        host.events.fire('loaded:changed', true);

        expect(host.win.fetch).toBe(host.baseFetch);
    });

    // A collision JSON that 404s means loadVoxelCollision throws before it ever
    // requests the .bin, so neither the request-sighting nor loaded:changed can
    // ever fire. The wrapper must still not outlive its usefulness.
    it('restores fetch after attaching when the collision request never comes', () => {
        const host = makeHost();
        attach(host, 1000);
        expect(host.win.fetch).not.toBe(host.baseFetch);

        let frames = 0;
        while (host.pendingRaf() > 0 && frames < 40000) {
            host.flushRaf();
            frames++;
        }

        expect(host.win.fetch).toBe(host.baseFetch);
        expect(frames).toBeLessThan(40000);
    });

    it('stops polling as soon as it has attached and handed fetch back', async () => {
        const host = makeHost();
        host.responses.set('./index.voxel.bin', makeStreamedResponse().response);
        attach(host, 1000);
        host.win.fetch('./index.voxel.bin');

        host.flushRaf();

        expect(host.pendingRaf()).toBe(0);
    });

    it('restores fetch when the viewer handle never appears at all', () => {
        const host = makeHost();
        runCompanion(host, 1000);
        expect(host.win.fetch).not.toBe(host.baseFetch);

        let frames = 0;
        while (host.pendingRaf() > 0 && frames < 40000) {
            host.flushRaf();
            frames++;
        }

        expect(host.win.fetch).toBe(host.baseFetch);
    });
});

describe('loading-bar companion: whole load', () => {
    // The two defects together: the bar must be paintable from the first frame
    // AND must never step backwards, including across the ready gate where the
    // viewer's own gauge restarts from a fresh watermark.
    it('never decreases across a full load, gate and post-peak requeue included', async () => {
        const host = makeHost();
        const bin = makeStreamedResponse();
        host.responses.set('./index.voxel.bin', bin.response);
        attach(host, 1000);
        host.win.fetch('./index.voxel.bin');
        await flush();

        const settled: number[] = [];
        const mark = () => settled.push(host.displayed() ?? 0);

        host.frameReady(0);       mark();   // nothing discovered yet
        bin.push(250);            await flush(); mark();
        host.frameReady(8);       mark();   // octree resolved, coarse blocks queued
        bin.push(250);            await flush(); mark();
        host.frameReady(4);       mark();
        bin.push(500);            await flush(); mark();   // collision complete
        host.frameReady(0);       mark();   // coarse level complete
        host.state.progress = 0;  mark();   // ready gate: viewer's fresh watermark
        host.frameReady(16, true);          // post-reveal refinement floods back in
        mark();
        host.state.progress = 100; mark();  // still gated: held at 99

        expect(Math.max(...settled)).toBeLessThanOrEqual(99);

        host.events.fire('loaded:changed', true);
        host.state.progress = 100; mark();

        expect(settled).toEqual([...settled].sort((a, b) => a - b));
        expect(settled[settled.length - 1]).toBe(100);
    });
});

describe('buildLoadingBarInjection', () => {
    it('emits the runtime as a script tag', () => {
        const out = buildLoadingBarInjection(0);
        expect(out.startsWith('<script>')).toBe(true);
        expect(out.endsWith('</script>')).toBe(true);
    });

    it('is template-cooking safe: ES5 only, no backslash escapes at all', () => {
        const out = buildLoadingBarInjection(1234);
        // companion templates cook backslash escapes away at build time
        expect(out).not.toMatch(/\\/);
        expect(out).not.toContain('=>');
        expect(out).not.toContain('const ');
        expect(out).not.toContain('let ');
        expect(out).not.toContain('`');
    });
});
