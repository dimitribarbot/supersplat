import { Mat4 } from 'playcanvas';
import { describe, it, expect } from 'vitest';

import { registerPortalsRuntime } from '../src/portals-runtime';

// Minimal Events double (pattern: test/portals.test.ts): function/invoke
// registry + on/fire listeners, plus an invoke counter so tests can assert how
// often 'portals.list' is queried.
const makeEvents = () => {
    const fns = new Map<string, (...args: any[]) => any>();
    const listeners = new Map<string, ((...args: any[]) => void)[]>();
    const invokeCounts = new Map<string, number>();
    return {
        function(name: string, fn: (...args: any[]) => any) { fns.set(name, fn); },
        invoke(name: string, ...args: any[]) {
            invokeCounts.set(name, (invokeCounts.get(name) ?? 0) + 1);
            return fns.get(name)?.(...args);
        },
        on(name: string, fn: (...args: any[]) => void) {
            const arr = listeners.get(name) ?? [];
            arr.push(fn);
            listeners.set(name, arr);
        },
        fire(name: string, ...args: any[]) { (listeners.get(name) ?? []).forEach(fn => fn(...args)); },
        invokeCounts
    } as any;
};

// registerPortalsRuntime only calls scene.getElementsByType and reads
// splat.uid / writes splat.visible, so a plain object double suffices.
const makeScene = (splats: { uid: number, visible: boolean }[]) => ({
    getElementsByType: () => splats
}) as any;

const camAt = (x: number, y: number, z: number) => new Mat4().setTranslate(x, y, z);

const portalData = () => [{
    id: 'portal_0',
    position: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0, 1] as [number, number, number, number],
    width: 4,
    height: 4,
    frontUid: 1,
    backUid: 2
}];

describe('portals-runtime walkthrough preview', () => {
    it('swaps the visible splat when the camera crosses a portal', () => {
        const events = makeEvents();
        const splats = [{ uid: 1, visible: true }, { uid: 2, visible: true }];
        registerPortalsRuntime(events, makeScene(splats));
        events.function('portals.list', () => portalData());
        events.function('portals.startSplat', () => 2);
        events.fire('portals.walkthrough', true);
        expect(splats[0].visible).toBe(false);
        expect(splats[1].visible).toBe(true);
        events.fire('prerender', camAt(0, 0, -1));   // primes prev
        events.fire('prerender', camAt(0, 0, 1));    // crosses to the front side -> uid 1
        expect(splats[0].visible).toBe(true);
        expect(splats[1].visible).toBe(false);
    });

    it('does not invoke portals.list per prerender frame (cached rects)', () => {
        const events = makeEvents();
        const splats = [{ uid: 1, visible: true }, { uid: 2, visible: true }];
        registerPortalsRuntime(events, makeScene(splats));
        events.function('portals.list', () => portalData());
        events.function('portals.startSplat', () => 2);
        events.fire('portals.walkthrough', true);
        const after = events.invokeCounts.get('portals.list') ?? 0;
        for (let i = 0; i < 10; i++) {
            events.fire('prerender', camAt(0, 0, -1 + i * 0.01));
        }
        expect(events.invokeCounts.get('portals.list') ?? 0).toBe(after);
    });

    it('rebuilds the cached rects on portals.changed', () => {
        const events = makeEvents();
        const splats = [{ uid: 1, visible: true }, { uid: 2, visible: true }];
        registerPortalsRuntime(events, makeScene(splats));
        let data = portalData();
        events.function('portals.list', () => data);
        events.function('portals.startSplat', () => 2);
        events.fire('portals.walkthrough', true);
        // move the portal out of the camera's path, then notify
        data = [{ ...portalData()[0], position: [100, 0, 0] as [number, number, number] }];
        events.fire('portals.changed');
        events.fire('prerender', camAt(0, 0, -1));
        events.fire('prerender', camAt(0, 0, 1));    // no longer crosses anything
        expect(splats[1].visible).toBe(true);        // still the start splat
        expect(splats[0].visible).toBe(false);
    });
});
