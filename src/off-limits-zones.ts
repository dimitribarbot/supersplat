import { Events } from './events';

// Editor-internal off-limits zone record. A zone is a thin vertical wall: a
// rectangle (width x height) centered at `position`, oriented by `rotation`
// (quaternion [x, y, z, w]). Packed arrays so serialization is a straight copy
// (mirrors annotations.ts).
type ZoneData = {
    id: string,
    position: [number, number, number],
    rotation: [number, number, number, number],
    width: number,
    height: number
};

// Export-shaped zone consumed by the viewer companion (no id needed).
type ZoneExport = {
    position: [number, number, number],
    rotation: [number, number, number, number],
    width: number,
    height: number
};

class AddZoneOp {
    name = 'addOffLimitsZone';
    events: Events;
    data: ZoneData;

    constructor(events: Events, data: ZoneData) {
        this.events = events;
        this.data = data;
    }

    do() {
        this.events.fire('offLimitsZones.insertRaw', this.data);
        this.events.fire('offLimitsZones.select', this.data.id);
    }

    undo() {
        this.events.fire('offLimitsZones.removeRaw', this.data.id);
    }

    destroy() {
        this.events = null;
        this.data = null;
    }
}

class RemoveZoneOp {
    name = 'removeOffLimitsZone';
    events: Events;
    data: ZoneData;
    index: number;

    constructor(events: Events, data: ZoneData, index: number) {
        this.events = events;
        this.data = data;
        this.index = index;
    }

    do() {
        this.events.fire('offLimitsZones.removeRaw', this.data.id);
    }

    undo() {
        this.events.fire('offLimitsZones.insertRaw', this.data, this.index);
    }

    destroy() {
        this.events = null;
        this.data = null;
    }
}

class UpdateZoneOp {
    name = 'updateOffLimitsZone';
    events: Events;
    id: string;
    oldValues: Partial<ZoneData>;
    newValues: Partial<ZoneData>;

    constructor(events: Events, id: string, oldValues: Partial<ZoneData>, newValues: Partial<ZoneData>) {
        this.events = events;
        this.id = id;
        this.oldValues = oldValues;
        this.newValues = newValues;
    }

    do() {
        this.events.fire('offLimitsZones.updateRaw', this.id, this.newValues);
    }

    undo() {
        this.events.fire('offLimitsZones.updateRaw', this.id, this.oldValues);
    }

    destroy() {
        this.events = null;
        this.oldValues = null;
        this.newValues = null;
    }
}

class SetMessageOp {
    name = 'setOffLimitsMessage';
    events: Events;
    oldValue: string;
    newValue: string;

    constructor(events: Events, oldValue: string, newValue: string) {
        this.events = events;
        this.oldValue = oldValue;
        this.newValue = newValue;
    }

    do() {
        this.events.fire('offLimitsZones.setMessageRaw', this.newValue);
    }

    undo() {
        this.events.fire('offLimitsZones.setMessageRaw', this.oldValue);
    }

    destroy() {
        this.events = null;
    }
}

const registerOffLimitsZonesEvents = (events: Events) => {
    const zones: ZoneData[] = [];
    let message = '';
    let nextId = 0;
    let selectedId: string | null = null;

    const genId = () => `zone_${nextId++}`;
    const fireChanged = () => events.fire('offLimitsZones.changed');

    // --- queries ---

    // Returns the live internal array — callers read it but must not mutate it.
    events.function('offLimitsZones.list', () => zones);
    events.function('offLimitsZones.byId', (id: string) => zones.find(z => z.id === id) ?? null);
    events.function('offLimitsZones.selected', () => selectedId);
    events.function('offLimitsZones.newId', () => genId());
    events.function('offLimitsZones.message', () => message);

    // --- low-level mutators (called by edit ops; fire change events) ---

    events.on('offLimitsZones.insertRaw', (data: ZoneData, index?: number) => {
        if (typeof index === 'number' && index >= 0 && index <= zones.length) {
            zones.splice(index, 0, data);
        } else {
            zones.push(data);
        }
        fireChanged();
    });

    events.on('offLimitsZones.removeRaw', (id: string) => {
        const i = zones.findIndex(z => z.id === id);
        if (i >= 0) {
            zones.splice(i, 1);
            if (selectedId === id) {
                selectedId = null;
                events.fire('offLimitsZones.selectionChanged', null);
            }
            fireChanged();
        }
    });

    events.on('offLimitsZones.updateRaw', (id: string, patch: Partial<Omit<ZoneData, 'id'>>) => {
        const z = zones.find(x => x.id === id);
        if (z) {
            Object.assign(z, patch);
            fireChanged();
        }
    });

    events.on('offLimitsZones.setMessageRaw', (value: string) => {
        message = value ?? '';
        fireChanged();
    });

    // --- selection ---

    events.on('offLimitsZones.select', (id: string | null) => {
        if (selectedId !== id) {
            selectedId = id;
            events.fire('offLimitsZones.selectionChanged', id);
        }
    });

    // --- reset on scene clear ---

    events.on('scene.clear', () => {
        zones.length = 0;
        message = '';
        nextId = 0;
        selectedId = null;
        events.fire('offLimitsZones.selectionChanged', null);
        fireChanged();
    });

    // --- export shape (read by the export popups) ---

    events.function('offLimitsZones.export', (): ZoneExport[] => {
        return zones.map(z => ({
            position: [z.position[0], z.position[1], z.position[2]],
            rotation: [z.rotation[0], z.rotation[1], z.rotation[2], z.rotation[3]],
            width: z.width,
            height: z.height
        }));
    });

    // --- document serialization ---

    events.function('docSerialize.offLimitsZones', (): ZoneData[] => {
        return zones.map(z => ({
            id: z.id,
            position: [z.position[0], z.position[1], z.position[2]],
            rotation: [z.rotation[0], z.rotation[1], z.rotation[2], z.rotation[3]],
            width: z.width,
            height: z.height
        }));
    });

    events.function('docDeserialize.offLimitsZones', (data: ZoneData[], msg?: string) => {
        zones.length = 0;
        nextId = 0;
        selectedId = null;
        message = msg ?? '';
        if (Array.isArray(data)) {
            data.forEach((d) => {
                zones.push({
                    id: d.id ?? genId(),
                    position: d.position,
                    rotation: d.rotation ?? [0, 0, 0, 1],
                    width: d.width ?? 1,
                    height: d.height ?? 1
                });
                // keep the counter ahead of any numeric id we loaded
                const m = /^zone_(\d+)$/.exec(d.id ?? '');
                if (m) {
                    nextId = Math.max(nextId, parseInt(m[1], 10) + 1);
                }
            });
        }
        events.fire('offLimitsZones.selectionChanged', null);
        fireChanged();
    });
};

export {
    registerOffLimitsZonesEvents,
    AddZoneOp,
    RemoveZoneOp,
    UpdateZoneOp,
    SetMessageOp,
    ZoneData,
    ZoneExport
};
