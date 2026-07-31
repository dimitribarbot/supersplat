import { Events } from './events';
import { InfiniteEdges } from './portal-geom';

// Editor-internal portal record: a rectangle (width x height) centered at
// `position`, oriented by `rotation` (quaternion [x,y,z,w]). The +Z side of the
// rectangle shows `frontUid`, the -Z side shows `backUid` (splat uids). Packed
// arrays so serialization is a straight copy (mirrors off-limits-zones.ts).
type PortalData = {
    id: string,
    position: [number, number, number],
    rotation: [number, number, number, number],
    width: number,
    height: number,
    frontUid: number | null,
    backUid: number | null,
    infinite?: InfiniteEdges,
    // Play the exported viewer's tile transition when this portal is crossed.
    // ABSENT MEANS ENABLED - only an explicit false disables it, so existing
    // documents need no migration.
    transition?: boolean
};

// On-disk portal record: PortalData plus stable splat references as indices
// into the document's splat array (uids are session-scoped and NOT stable
// across loads; the uid fields are kept only for rollback to older builds).
type PortalDocData = PortalData & {
    frontIndex?: number | null,
    backIndex?: number | null
};

class AddPortalOp {
    name = 'addPortal';
    events: Events;
    data: PortalData;
    constructor(events: Events, data: PortalData) {
        this.events = events;
        this.data = data;
    }
    do() {
        this.events.fire('portals.insertRaw', this.data);
        this.events.fire('portals.select', this.data.id);
    }
    undo() {
        this.events.fire('portals.removeRaw', this.data.id);
    }
    destroy() {
        this.events = null;
        this.data = null;
    }
}

class RemovePortalOp {
    name = 'removePortal';
    events: Events;
    data: PortalData;
    index: number;
    constructor(events: Events, data: PortalData, index: number) {
        this.events = events;
        this.data = data;
        this.index = index;
    }
    do() {
        this.events.fire('portals.removeRaw', this.data.id);
    }
    undo() {
        this.events.fire('portals.insertRaw', this.data, this.index);
    }
    destroy() {
        this.events = null;
        this.data = null;
    }
}

class UpdatePortalOp {
    name = 'updatePortal';
    events: Events;
    id: string;
    oldValues: Partial<PortalData>;
    newValues: Partial<PortalData>;
    constructor(events: Events, id: string, oldValues: Partial<PortalData>, newValues: Partial<PortalData>) {
        this.events = events;
        this.id = id;
        this.oldValues = oldValues;
        this.newValues = newValues;
    }
    do() {
        this.events.fire('portals.updateRaw', this.id, this.newValues);
    }
    undo() {
        this.events.fire('portals.updateRaw', this.id, this.oldValues);
    }
    destroy() {
        this.events = null;
        this.oldValues = null;
        this.newValues = null;
    }
}

class SetStartSplatOp {
    name = 'setPortalStartSplat';
    events: Events;
    oldUid: number | null;
    newUid: number | null;
    constructor(events: Events, oldUid: number | null, newUid: number | null) {
        this.events = events;
        this.oldUid = oldUid;
        this.newUid = newUid;
    }
    do() {
        this.events.fire('portals.setStartRaw', this.newUid);
    }
    undo() {
        this.events.fire('portals.setStartRaw', this.oldUid);
    }
    destroy() {
        this.events = null;
    }
}

class UpdatePortalEntrypointOp {
    name = 'updatePortalEntrypoint';
    events: Events;
    uid: number;
    oldPos: [number, number, number] | null;
    newPos: [number, number, number] | null;
    constructor(events: Events, uid: number, oldPos: [number, number, number] | null, newPos: [number, number, number] | null) {
        this.events = events;
        this.uid = uid;
        this.oldPos = oldPos;
        this.newPos = newPos;
    }
    do() {
        this.events.fire('portals.setEntrypointRaw', this.uid, this.newPos);
    }
    undo() {
        this.events.fire('portals.setEntrypointRaw', this.uid, this.oldPos);
    }
    destroy() {
        this.events = null;
    }
}

const registerPortalsEvents = (events: Events) => {
    const portals: PortalData[] = [];
    let startUid: number | null = null;
    const entrypoints = new Map<number, [number, number, number]>();
    let nextId = 0;
    let selectedId: string | null = null;

    const genId = () => `portal_${nextId++}`;
    const fireChanged = () => events.fire('portals.changed');

    // --- queries ---
    events.function('portals.list', () => portals);
    events.function('portals.byId', (id: string) => portals.find(p => p.id === id) ?? null);
    events.function('portals.selected', () => selectedId);
    events.function('portals.newId', () => genId());
    events.function('portals.startSplat', () => startUid);
    events.function('portals.count', () => portals.length);
    events.function('portals.entrypoint', (uid: number) => entrypoints.get(uid) ?? null);
    events.function('portals.exportEntrypoints', () => {
        const out: Record<string, [number, number, number]> = {};
        entrypoints.forEach((pos, uid) => {
            out[String(uid)] = [pos[0], pos[1], pos[2]];
        });
        return out;
    });

    // --- low-level mutators (called by edit ops; fire change events) ---
    events.on('portals.insertRaw', (data: PortalData, index?: number) => {
        if (typeof index === 'number' && index >= 0 && index <= portals.length) {
            portals.splice(index, 0, data);
        } else {
            portals.push(data);
        }
        fireChanged();
    });

    events.on('portals.removeRaw', (id: string) => {
        const i = portals.findIndex(p => p.id === id);
        if (i >= 0) {
            portals.splice(i, 1);
            if (selectedId === id) {
                selectedId = null;
                events.fire('portals.selectionChanged', null);
            }
            fireChanged();
        }
    });

    events.on('portals.updateRaw', (id: string, patch: Partial<Omit<PortalData, 'id'>>) => {
        const p = portals.find(x => x.id === id);
        if (p) {
            Object.assign(p, patch);
            fireChanged();
        }
    });

    events.on('portals.setStartRaw', (uid: number | null) => {
        startUid = uid ?? null;
        fireChanged();
    });

    events.on('portals.setEntrypointRaw', (uid: number, pos: [number, number, number] | null) => {
        if (pos) {
            entrypoints.set(uid, [pos[0], pos[1], pos[2]]);
        } else {
            entrypoints.delete(uid);
        }
        fireChanged();
    });

    // --- selection ---
    events.on('portals.select', (id: string | null) => {
        if (selectedId !== id) {
            selectedId = id;
            events.fire('portals.selectionChanged', id);
        }
    });

    // --- reset on scene clear ---
    events.on('scene.clear', () => {
        portals.length = 0;
        startUid = null;
        entrypoints.clear();
        nextId = 0;
        selectedId = null;
        events.fire('portals.selectionChanged', null);
        fireChanged();
    });

    // --- export shape (read by the export popups in sub-project 2) ---
    events.function('portals.export', () => portals.map(p => ({
        position: [p.position[0], p.position[1], p.position[2]],
        rotation: [p.rotation[0], p.rotation[1], p.rotation[2], p.rotation[3]],
        width: p.width,
        height: p.height,
        frontUid: p.frontUid,
        backUid: p.backUid,
        infinite: p.infinite,
        transition: p.transition
    })));

    // --- document serialization ---
    events.function('docSerialize.portals', (uidToIndex?: Map<number, number>): PortalDocData[] => portals.map((p) => {
        const doc: PortalDocData = {
            id: p.id,
            position: [p.position[0], p.position[1], p.position[2]],
            rotation: [p.rotation[0], p.rotation[1], p.rotation[2], p.rotation[3]],
            width: p.width,
            height: p.height,
            frontUid: p.frontUid,
            backUid: p.backUid,
            infinite: p.infinite,
            transition: p.transition
        };
        if (uidToIndex) {
            // always write a value (null, never undefined) so the field
            // survives JSON.stringify and marks the record as new-format
            const toIndex = (uid: number | null) => {
                const i = (uid === null) ? undefined : uidToIndex.get(uid);
                return (typeof i === 'number') ? i : null;
            };
            doc.frontIndex = toIndex(p.frontUid);
            doc.backIndex = toIndex(p.backUid);
        }
        return doc;
    }));

    // start splat + entrypoints converted to document splat indices (stale
    // uids are dropped rather than written as dangling references)
    events.function('docSerialize.portalsIndex', (uidToIndex: Map<number, number>) => {
        const startSplatIndex = (startUid !== null && uidToIndex.has(startUid)) ? uidToIndex.get(startUid) : null;
        const entrypointsByIndex: Record<string, [number, number, number]> = {};
        entrypoints.forEach((pos, uid) => {
            const i = uidToIndex.get(uid);
            if (typeof i === 'number') {
                entrypointsByIndex[String(i)] = [pos[0], pos[1], pos[2]];
            }
        });
        return { startSplatIndex, entrypointsByIndex };
    });

    events.function('docDeserialize.portals', (data: PortalDocData[], start?: number | null, eps?: Record<string, [number, number, number]>, remap?: { indexToUid: number[], startIndex?: number | null, entrypointsByIndex?: Record<string, [number, number, number]> }) => {
        // index fields are authoritative when present (uids are session-scoped
        // and only valid in the session that saved them); legacy documents
        // without index fields keep the old raw-uid behavior verbatim
        const indexToUid = (remap && Array.isArray(remap.indexToUid)) ? remap.indexToUid : null;
        const fromIndex = (index: number | null): number | null => {
            if (!indexToUid || typeof index !== 'number') {
                return null;
            }
            const uid = indexToUid[index];
            return (typeof uid === 'number') ? uid : null;
        };

        portals.length = 0;
        nextId = 0;
        selectedId = null;

        if (indexToUid && remap.startIndex !== undefined) {
            startUid = fromIndex(remap.startIndex);
        } else {
            startUid = (typeof start === 'number') ? start : null;
        }

        entrypoints.clear();
        if (indexToUid && remap.entrypointsByIndex !== undefined) {
            const byIndex = remap.entrypointsByIndex;
            Object.keys(byIndex).forEach((k) => {
                const uid = fromIndex(parseInt(k, 10));
                const v = byIndex[k];
                if (uid !== null && Array.isArray(v) && v.length >= 3) {
                    entrypoints.set(uid, [v[0], v[1], v[2]]);
                }
            });
        } else if (eps && typeof eps === 'object') {
            Object.keys(eps).forEach((k) => {
                const v = eps[k];
                if (Array.isArray(v) && v.length >= 3) {
                    entrypoints.set(parseInt(k, 10), [v[0], v[1], v[2]]);
                }
            });
        }

        if (Array.isArray(data)) {
            data.forEach((d) => {
                const resolve = (index: number | null | undefined, legacyUid: number | null | undefined) => {
                    if (indexToUid && index !== undefined) {
                        return fromIndex(index);
                    }
                    return legacyUid ?? null;
                };
                portals.push({
                    id: d.id ?? genId(),
                    position: d.position,
                    rotation: d.rotation ?? [0, 0, 0, 1],
                    width: d.width ?? 1,
                    height: d.height ?? 1,
                    frontUid: resolve(d.frontIndex, d.frontUid),
                    backUid: resolve(d.backIndex, d.backUid),
                    infinite: d.infinite,
                    transition: d.transition
                });
                const m = /^portal_(\d+)$/.exec(d.id ?? '');
                if (m) {
                    nextId = Math.max(nextId, parseInt(m[1], 10) + 1);
                }
            });
        }
        events.fire('portals.selectionChanged', null);
        fireChanged();
    });
};

export {
    registerPortalsEvents,
    AddPortalOp,
    RemovePortalOp,
    UpdatePortalOp,
    SetStartSplatOp,
    UpdatePortalEntrypointOp,
    PortalData
};
