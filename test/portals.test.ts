import { describe, it, expect } from 'vitest';

import { AddPortalOp, RemovePortalOp, SetStartSplatOp, PortalData, registerPortalsEvents, UpdatePortalEntrypointOp } from '../src/portals';

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

const portal = (over: Partial<PortalData> = {}): PortalData => ({
    id: 'portal_0',
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    width: 2,
    height: 2,
    frontUid: 1,
    backUid: 2,
    ...over
});

describe('portals events', () => {
    it('adds, lists, and selects a portal', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        const p = portal();
        new AddPortalOp(events, p).do();
        expect(events.invoke('portals.list')).toEqual([p]);
        expect(events.invoke('portals.selected')).toBe('portal_0');
        expect(events.invoke('portals.count')).toBe(1);
    });

    it('add op undo removes the portal', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        const op = new AddPortalOp(events, portal());
        op.do();
        op.undo();
        expect(events.invoke('portals.list')).toEqual([]);
    });

    it('remove op undo restores at the original index', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        new AddPortalOp(events, portal({ id: 'portal_0' })).do();
        new AddPortalOp(events, portal({ id: 'portal_1' })).do();
        const remove = new RemovePortalOp(events, events.invoke('portals.byId', 'portal_0'), 0);
        remove.do();
        expect((events.invoke('portals.list') as PortalData[]).map(p => p.id)).toEqual(['portal_1']);
        remove.undo();
        expect((events.invoke('portals.list') as PortalData[]).map(p => p.id)).toEqual(['portal_0', 'portal_1']);
    });

    it('serializes and deserializes including the start splat', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        new AddPortalOp(events, portal({ id: 'portal_5' })).do();
        new SetStartSplatOp(events, null, 7).do();
        const serialized = events.invoke('docSerialize.portals');
        const start = events.invoke('portals.startSplat');

        const events2 = makeEvents();
        registerPortalsEvents(events2);
        events2.invoke('docDeserialize.portals', serialized, start);
        expect(events2.invoke('portals.list')).toEqual([portal({ id: 'portal_5' })]);
        expect(events2.invoke('portals.startSplat')).toBe(7);
        expect(events2.invoke('portals.newId')).toBe('portal_6');
    });

    it('deserialize fills missing rotation/size/uid defaults', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        events.invoke('docDeserialize.portals', [{ id: 'portal_0', position: [0, 0, 0] }], undefined);
        expect(events.invoke('portals.byId', 'portal_0')).toEqual({
            id: 'portal_0', position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 1, height: 1, frontUid: null, backUid: null
        });
        expect(events.invoke('portals.startSplat')).toBeNull();
    });

    it('round-trips the infinite-edges flags through serialize/deserialize', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        const inf = { top: true, right: false, bottom: false, left: true };
        new AddPortalOp(events, portal({ id: 'portal_0', infinite: inf })).do();
        const serialized = events.invoke('docSerialize.portals');
        expect(serialized[0].infinite).toEqual(inf);

        const events2 = makeEvents();
        registerPortalsEvents(events2);
        events2.invoke('docDeserialize.portals', serialized, null);
        expect((events2.invoke('portals.list') as PortalData[])[0].infinite).toEqual(inf);
    });

    it('portals.export includes the infinite-edges flags', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        const inf = { top: false, right: true, bottom: false, left: false };
        new AddPortalOp(events, portal({ infinite: inf })).do();
        expect((events.invoke('portals.export') as any[])[0].infinite).toEqual(inf);
    });
});

describe('portal entrypoints', () => {
    it('set + query a per-scene entrypoint', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        new UpdatePortalEntrypointOp(events, 7, null, [1, 2, 3]).do();
        expect(events.invoke('portals.entrypoint', 7)).toEqual([1, 2, 3]);
        expect(events.invoke('portals.entrypoint', 8)).toBeNull();
    });

    it('clearing (newPos null) removes the entrypoint', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        new UpdatePortalEntrypointOp(events, 7, null, [1, 2, 3]).do();
        new UpdatePortalEntrypointOp(events, 7, [1, 2, 3], null).do();
        expect(events.invoke('portals.entrypoint', 7)).toBeNull();
    });

    it('undo restores the previous entrypoint value', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        const op = new UpdatePortalEntrypointOp(events, 7, null, [1, 2, 3]);
        op.do();
        op.undo();
        expect(events.invoke('portals.entrypoint', 7)).toBeNull();
    });

    it('exportEntrypoints returns a uid->position record', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        new UpdatePortalEntrypointOp(events, 7, null, [1, 2, 3]).do();
        expect(events.invoke('portals.exportEntrypoints')).toEqual({ '7': [1, 2, 3] });
    });

    it('deserialize restores entrypoints from the 3rd arg', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        events.invoke('docDeserialize.portals', [], null, { '7': [4, 5, 6] });
        expect(events.invoke('portals.entrypoint', 7)).toEqual([4, 5, 6]);
    });

    it('scene.clear wipes entrypoints', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        new UpdatePortalEntrypointOp(events, 7, null, [1, 2, 3]).do();
        events.fire('scene.clear');
        expect(events.invoke('portals.entrypoint', 7)).toBeNull();
    });
});
