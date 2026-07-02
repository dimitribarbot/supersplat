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

describe('portal doc-index serialization', () => {
    it('docSerialize.portals writes frontIndex/backIndex from the uid->index map', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        new AddPortalOp(events, portal({ frontUid: 2, backUid: 3 })).do();
        const serialized = events.invoke('docSerialize.portals', new Map([[2, 0], [3, 1]]));
        expect(serialized[0].frontIndex).toBe(0);
        expect(serialized[0].backIndex).toBe(1);
        // legacy uid fields are still written alongside (rollback / old-build compat)
        expect(serialized[0].frontUid).toBe(2);
        expect(serialized[0].backUid).toBe(3);
    });

    it('docSerialize.portals writes null indices for null or unknown uids', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        new AddPortalOp(events, portal({ frontUid: null, backUid: 99 })).do();
        const serialized = events.invoke('docSerialize.portals', new Map([[2, 0]]));
        expect(serialized[0].frontIndex).toBeNull();
        expect(serialized[0].backIndex).toBeNull();
    });

    it('docSerialize.portals without a map omits index fields entirely', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        new AddPortalOp(events, portal()).do();
        const serialized = events.invoke('docSerialize.portals');
        expect(serialized[0]).not.toHaveProperty('frontIndex');
        expect(serialized[0]).not.toHaveProperty('backIndex');
    });

    it('docSerialize.portalsIndex maps start splat and entrypoints to indices', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        new SetStartSplatOp(events, null, 2).do();
        new UpdatePortalEntrypointOp(events, 3, null, [1, 2, 3]).do();
        const out = events.invoke('docSerialize.portalsIndex', new Map([[2, 0], [3, 1]]));
        expect(out).toEqual({ startSplatIndex: 0, entrypointsByIndex: { '1': [1, 2, 3] } });
    });

    it('docSerialize.portalsIndex drops stale uids (start -> null, entrypoint omitted)', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        new SetStartSplatOp(events, null, 99).do();
        new UpdatePortalEntrypointOp(events, 98, null, [1, 2, 3]).do();
        const out = events.invoke('docSerialize.portalsIndex', new Map([[2, 0]]));
        expect(out).toEqual({ startSplatIndex: null, entrypointsByIndex: {} });
    });

    it('round-trips splat refs across a uid drift via the index remap', () => {
        // session 1: the two splats have uids [2, 3]
        const s1 = makeEvents();
        registerPortalsEvents(s1);
        new AddPortalOp(s1, portal({ id: 'portal_0', frontUid: 2, backUid: 3 })).do();
        new SetStartSplatOp(s1, null, 2).do();
        new UpdatePortalEntrypointOp(s1, 3, null, [4, 5, 6]).do();
        const uidToIndex = new Map([[2, 0], [3, 1]]);
        // simulate the real .ssproj write/read (JSON drops undefined, keeps null)
        const doc = JSON.parse(JSON.stringify({
            portals: s1.invoke('docSerialize.portals', uidToIndex),
            portalsStartSplat: s1.invoke('portals.startSplat'),
            portalsEntrypoints: s1.invoke('portals.exportEntrypoints'),
            ...s1.invoke('docSerialize.portalsIndex', uidToIndex)
        }));

        // session 2: the same two splats (same document order) now have uids [7, 9]
        const s2 = makeEvents();
        registerPortalsEvents(s2);
        s2.invoke('docDeserialize.portals', doc.portals, doc.portalsStartSplat, doc.portalsEntrypoints, {
            indexToUid: [7, 9],
            startIndex: doc.startSplatIndex,
            entrypointsByIndex: doc.entrypointsByIndex
        });

        const p = (s2.invoke('portals.list') as PortalData[])[0];
        expect(p.frontUid).toBe(7);
        expect(p.backUid).toBe(9);
        expect(s2.invoke('portals.startSplat')).toBe(7);
        expect(s2.invoke('portals.entrypoint', 9)).toEqual([4, 5, 6]);
        expect(s2.invoke('portals.entrypoint', 3)).toBeNull();
    });

    it('legacy documents (uid fields only) still load via the raw-uid fallback', () => {
        // a pre-fix .ssproj payload: no frontIndex/backIndex/startIndex/entrypointsByIndex
        const legacyPortals = [{
            id: 'portal_0', position: [0, 0, 0], rotation: [0, 0, 0, 1],
            width: 2, height: 2, frontUid: 2, backUid: 3
        }];
        const events = makeEvents();
        registerPortalsEvents(events);
        // the loader always passes remap.indexToUid (splats were loaded), but a
        // legacy doc has no index fields, so the uid path must run verbatim
        events.invoke('docDeserialize.portals', legacyPortals, 2, { '3': [1, 2, 3] }, {
            indexToUid: [7, 9],
            startIndex: undefined,
            entrypointsByIndex: undefined
        });
        const p = (events.invoke('portals.list') as PortalData[])[0];
        expect(p.frontUid).toBe(2);
        expect(p.backUid).toBe(3);
        expect(events.invoke('portals.startSplat')).toBe(2);
        expect(events.invoke('portals.entrypoint', 3)).toEqual([1, 2, 3]);
    });

    it('null or out-of-range indices deserialize to null uids (index wins over legacy uid)', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        events.invoke('docDeserialize.portals', [{
            id: 'portal_0', position: [0, 0, 0], rotation: [0, 0, 0, 1],
            width: 2, height: 2, frontUid: 2, backUid: 3,
            frontIndex: null, backIndex: 5
        }], null, undefined, { indexToUid: [7, 9], startIndex: null, entrypointsByIndex: {} });
        const p = (events.invoke('portals.list') as PortalData[])[0];
        expect(p.frontUid).toBeNull();
        expect(p.backUid).toBeNull();
        expect(events.invoke('portals.startSplat')).toBeNull();
    });
});
