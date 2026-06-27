import { describe, it, expect } from 'vitest';

import { AddZoneOp, RemoveZoneOp, UpdateZoneOp, SetMessageOp, ZoneData, registerOffLimitsZonesEvents } from '../src/off-limits-zones';

// Minimal Events double (function/invoke registry + on/fire listeners),
// matching the subset of src/events.ts the model uses. Avoids importing
// playcanvas in a node-env test.
const makeEvents = () => {
    const fns: Map<string, (...a: any[]) => any> = new Map();
    const listeners: Map<string, ((...a: any[]) => void)[]> = new Map();
    const ev = {
        function(name: string, fn: (...a: any[]) => any) {
            fns.set(name, fn);
        },
        invoke(name: string, ...args: any[]) {
            return fns.get(name)?.(...args);
        },
        on(name: string, cb: (...a: any[]) => void) {
            const l = listeners.get(name) ?? [];
            l.push(cb);
            listeners.set(name, l);
        },
        fire(name: string, ...args: any[]) {
            (listeners.get(name) ?? []).forEach(cb => cb(...args));
        }
    };
    return ev as any;
};

const zone = (over: Partial<ZoneData> = {}): ZoneData => ({
    id: over.id ?? 'zone_0',
    position: over.position ?? [1, 2, 3],
    rotation: over.rotation ?? [0, 0, 0, 1],
    width: over.width ?? 2,
    height: over.height ?? 3,
    infinite: over.infinite
});

describe('off-limits zones model', () => {
    it('adds and lists a zone, and selects it', () => {
        const events = makeEvents();
        registerOffLimitsZonesEvents(events);
        const z = zone();
        new AddZoneOp(events, z).do();
        expect(events.invoke('offLimitsZones.list')).toHaveLength(1);
        expect(events.invoke('offLimitsZones.byId', 'zone_0')).toEqual(z);
        expect(events.invoke('offLimitsZones.selected')).toBe('zone_0');
    });

    it('add op undo removes the zone', () => {
        const events = makeEvents();
        registerOffLimitsZonesEvents(events);
        const op = new AddZoneOp(events, zone());
        op.do();
        op.undo();
        expect(events.invoke('offLimitsZones.list')).toHaveLength(0);
    });

    it('remove op undo restores at the original index', () => {
        const events = makeEvents();
        registerOffLimitsZonesEvents(events);
        new AddZoneOp(events, zone({ id: 'zone_0' })).do();
        new AddZoneOp(events, zone({ id: 'zone_1' })).do();
        const remove = new RemoveZoneOp(events, events.invoke('offLimitsZones.byId', 'zone_0'), 0);
        remove.do();
        expect(events.invoke('offLimitsZones.list').map((z: ZoneData) => z.id)).toEqual(['zone_1']);
        remove.undo();
        expect(events.invoke('offLimitsZones.list').map((z: ZoneData) => z.id)).toEqual(['zone_0', 'zone_1']);
    });

    it('update op sets and reverts fields', () => {
        const events = makeEvents();
        registerOffLimitsZonesEvents(events);
        new AddZoneOp(events, zone()).do();
        const op = new UpdateZoneOp(events, 'zone_0', { width: 2 }, { width: 9 });
        op.do();
        expect(events.invoke('offLimitsZones.byId', 'zone_0').width).toBe(9);
        op.undo();
        expect(events.invoke('offLimitsZones.byId', 'zone_0').width).toBe(2);
    });

    it('message defaults to empty and is set/undone by SetMessageOp', () => {
        const events = makeEvents();
        registerOffLimitsZonesEvents(events);
        expect(events.invoke('offLimitsZones.message')).toBe('');
        const op = new SetMessageOp(events, '', 'No entry');
        op.do();
        expect(events.invoke('offLimitsZones.message')).toBe('No entry');
        op.undo();
        expect(events.invoke('offLimitsZones.message')).toBe('');
    });

    it('export drops the id', () => {
        const events = makeEvents();
        registerOffLimitsZonesEvents(events);
        new AddZoneOp(events, zone()).do();
        expect(events.invoke('offLimitsZones.export')).toEqual([
            { position: [1, 2, 3], rotation: [0, 0, 0, 1], width: 2, height: 3 }
        ]);
    });

    it('export carries infinite edges when set', () => {
        const events = makeEvents();
        registerOffLimitsZonesEvents(events);
        const inf = { top: true, right: false, bottom: false, left: true };
        new AddZoneOp(events, zone({ infinite: inf })).do();
        expect(events.invoke('offLimitsZones.export')).toEqual([
            { position: [1, 2, 3], rotation: [0, 0, 0, 1], width: 2, height: 3, infinite: inf }
        ]);
    });

    it('serialize -> deserialize round-trips infinite edges', () => {
        const events = makeEvents();
        registerOffLimitsZonesEvents(events);
        const inf = { top: false, right: true, bottom: true, left: false };
        new AddZoneOp(events, zone({ id: 'zone_0', infinite: inf })).do();
        const serialized = events.invoke('docSerialize.offLimitsZones');

        const events2 = makeEvents();
        registerOffLimitsZonesEvents(events2);
        events2.invoke('docDeserialize.offLimitsZones', serialized, '');
        expect(events2.invoke('offLimitsZones.byId', 'zone_0').infinite).toEqual(inf);
    });

    it('deserialize leaves infinite undefined when absent', () => {
        const events = makeEvents();
        registerOffLimitsZonesEvents(events);
        events.invoke('docDeserialize.offLimitsZones', [{ id: 'zone_0', position: [0, 0, 0] }], undefined);
        expect(events.invoke('offLimitsZones.byId', 'zone_0').infinite).toBeUndefined();
    });

    it('serialize -> deserialize round-trips zones + message and keeps ids ahead', () => {
        const events = makeEvents();
        registerOffLimitsZonesEvents(events);
        new AddZoneOp(events, zone({ id: 'zone_5' })).do();
        new SetMessageOp(events, '', 'Custom').do();
        const serialized = events.invoke('docSerialize.offLimitsZones');
        const message = events.invoke('offLimitsZones.message');

        const events2 = makeEvents();
        registerOffLimitsZonesEvents(events2);
        events2.invoke('docDeserialize.offLimitsZones', serialized, message);
        expect(events2.invoke('offLimitsZones.list')).toEqual([zone({ id: 'zone_5' })]);
        expect(events2.invoke('offLimitsZones.message')).toBe('Custom');
        expect(events2.invoke('offLimitsZones.newId')).toBe('zone_6');
    });

    it('deserialize fills missing rotation/size defaults', () => {
        const events = makeEvents();
        registerOffLimitsZonesEvents(events);
        events.invoke('docDeserialize.offLimitsZones', [{ id: 'zone_0', position: [0, 0, 0] }], undefined);
        expect(events.invoke('offLimitsZones.byId', 'zone_0')).toEqual({
            id: 'zone_0', position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 1, height: 1
        });
        expect(events.invoke('offLimitsZones.message')).toBe('');
    });

    it('removing the selected zone clears selection and fires selectionChanged(null)', () => {
        const events = makeEvents();
        registerOffLimitsZonesEvents(events);
        new AddZoneOp(events, zone()).do();
        expect(events.invoke('offLimitsZones.selected')).toBe('zone_0');

        let lastSelection: string | null | undefined;
        let fired = false;
        events.on('offLimitsZones.selectionChanged', (id: string | null) => {
            fired = true;
            lastSelection = id;
        });

        new RemoveZoneOp(events, events.invoke('offLimitsZones.byId', 'zone_0'), 0).do();

        expect(events.invoke('offLimitsZones.selected')).toBeNull();
        expect(fired).toBe(true);
        expect(lastSelection).toBeNull();
    });
});
