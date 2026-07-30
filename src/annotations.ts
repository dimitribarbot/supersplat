import { Events } from './events';
import { resolveAnnotationSceneIndex } from './portal-export';

// Camera fly-to view stored per annotation (packed arrays for serialization).
type AnnotationCamera = {
    position: [number, number, number],
    target: [number, number, number],
    fov: number
};

// Editor-internal annotation record. Positions/cameras are packed arrays so
// serialization is a straight copy (mirrors camera-poses.ts packing style).
type AnnotationData = {
    id: string,
    position: [number, number, number],
    title: string,
    text: string,
    url: string,
    newTab: boolean,
    // Editor splat this annotation belongs to (session-scoped uid), or null.
    // Resolved to an export scene index at export time; persisted by document
    // splat index (see docSerialize.annotations) because uids are not stable.
    sceneUid: number | null,
    camera: AnnotationCamera
};

// On-disk annotation record: AnnotationData plus a stable splat reference as an
// index into the document's splat array (uids are session-scoped and NOT stable
// across loads; the sceneUid field is kept only for rollback to older builds).
type AnnotationDocData = AnnotationData & {
    sceneIndex?: number | null
};

// Export-shaped annotation matching splat-serialize.ts `Annotation`. The link
// rides in `extras`, which the viewer transports but ignores.
type AnnotationExport = {
    position: [number, number, number],
    title: string,
    text: string,
    camera: { initial: { position: [number, number, number], target: [number, number, number], fov: number } },
    extras: { url?: string, newTab?: boolean, scene?: number }
};

class AddAnnotationOp {
    name = 'addAnnotation';
    events: Events;
    data: AnnotationData;

    constructor(events: Events, data: AnnotationData) {
        this.events = events;
        this.data = data;
    }

    do() {
        this.events.fire('annotations.insertRaw', this.data);
        this.events.fire('annotations.select', this.data.id);
    }

    undo() {
        this.events.fire('annotations.removeRaw', this.data.id);
    }

    destroy() {
        this.events = null;
        this.data = null;
    }
}

class RemoveAnnotationOp {
    name = 'removeAnnotation';
    events: Events;
    data: AnnotationData;
    index: number;

    constructor(events: Events, data: AnnotationData, index: number) {
        this.events = events;
        this.data = data;
        this.index = index;
    }

    do() {
        this.events.fire('annotations.removeRaw', this.data.id);
    }

    undo() {
        this.events.fire('annotations.insertRaw', this.data, this.index);
    }

    destroy() {
        this.events = null;
        this.data = null;
    }
}

class UpdateAnnotationOp {
    name = 'updateAnnotation';
    events: Events;
    id: string;
    oldValues: Partial<AnnotationData>;
    newValues: Partial<AnnotationData>;

    constructor(events: Events, id: string, oldValues: Partial<AnnotationData>, newValues: Partial<AnnotationData>) {
        this.events = events;
        this.id = id;
        this.oldValues = oldValues;
        this.newValues = newValues;
    }

    do() {
        this.events.fire('annotations.updateRaw', this.id, this.newValues);
    }

    undo() {
        this.events.fire('annotations.updateRaw', this.id, this.oldValues);
    }

    destroy() {
        this.events = null;
        this.oldValues = null;
        this.newValues = null;
    }
}

const registerAnnotationsEvents = (events: Events) => {
    const annotations: AnnotationData[] = [];
    let nextId = 0;
    let selectedId: string | null = null;

    const genId = () => `annotation_${nextId++}`;

    const fireChanged = () => events.fire('annotations.changed');

    // --- queries ---

    // Returns the live internal array — callers read it (e.g. each frame) but must not mutate it.
    events.function('annotations.list', () => annotations);

    events.function('annotations.byId', (id: string) => annotations.find(a => a.id === id) ?? null);

    events.function('annotations.selected', () => selectedId);

    // Build a fresh id without inserting (used by the add edit op).
    events.function('annotations.newId', () => genId());

    // --- low-level mutators (called by edit ops; fire change events) ---

    events.on('annotations.insertRaw', (data: AnnotationData, index?: number) => {
        if (typeof index === 'number' && index >= 0 && index <= annotations.length) {
            annotations.splice(index, 0, data);
        } else {
            annotations.push(data);
        }
        fireChanged();
    });

    events.on('annotations.removeRaw', (id: string) => {
        const i = annotations.findIndex(a => a.id === id);
        if (i >= 0) {
            annotations.splice(i, 1);
            if (selectedId === id) {
                selectedId = null;
                events.fire('annotations.selectionChanged', null);
            }
            fireChanged();
        }
    });

    events.on('annotations.updateRaw', (id: string, patch: Partial<Omit<AnnotationData, 'id'>>) => {
        const a = annotations.find(x => x.id === id);
        if (a) {
            Object.assign(a, patch);
            fireChanged();
        }
    });

    // --- selection ---

    events.on('annotations.select', (id: string | null) => {
        if (selectedId !== id) {
            selectedId = id;
            events.fire('annotations.selectionChanged', id);
        }
    });

    // --- reset on scene clear ---

    events.on('scene.clear', () => {
        annotations.length = 0;
        nextId = 0;
        selectedId = null;
        events.fire('annotations.selectionChanged', null);
        fireChanged();
    });

    // --- export shape (read by the export popups) ---

    // `sceneUids` is the portal bundle's scene ordering (index 0 = start scene);
    // absent on non-portal export paths, in which case no annotation gets a scene.
    events.function('annotations.export', (sceneUids?: number[]): AnnotationExport[] => {
        return annotations.map((a) => {
            const scene = resolveAnnotationSceneIndex(a.sceneUid, sceneUids);
            return {
                position: [a.position[0], a.position[1], a.position[2]],
                title: a.title,
                text: a.text,
                camera: {
                    initial: {
                        position: [a.camera.position[0], a.camera.position[1], a.camera.position[2]],
                        target: [a.camera.target[0], a.camera.target[1], a.camera.target[2]],
                        fov: a.camera.fov
                    }
                },
                extras: {
                    url: a.url || undefined,
                    newTab: a.url ? a.newTab : undefined,
                    scene: scene ?? undefined
                }
            };
        });
    });

    // --- document serialization ---

    events.function('docSerialize.annotations', (uidToIndex?: Map<number, number>): AnnotationDocData[] => {
        return annotations.map((a) => {
            const doc: AnnotationDocData = {
                id: a.id,
                position: [a.position[0], a.position[1], a.position[2]],
                title: a.title,
                text: a.text,
                url: a.url,
                newTab: a.newTab,
                sceneUid: a.sceneUid,
                camera: {
                    position: [a.camera.position[0], a.camera.position[1], a.camera.position[2]],
                    target: [a.camera.target[0], a.camera.target[1], a.camera.target[2]],
                    fov: a.camera.fov
                }
            };
            if (uidToIndex) {
                // always write a value (null, never undefined) so the field
                // survives JSON.stringify and marks the record as new-format
                const i = (a.sceneUid === null) ? undefined : uidToIndex.get(a.sceneUid);
                doc.sceneIndex = (typeof i === 'number') ? i : null;
            }
            return doc;
        });
    });

    events.function('docDeserialize.annotations', (data: AnnotationDocData[], remap?: { indexToUid: number[] }) => {
        // the index field is authoritative when present (uids are session-scoped
        // and only valid in the session that saved them); legacy documents
        // without it simply have no association
        const indexToUid = (remap && Array.isArray(remap.indexToUid)) ? remap.indexToUid : null;
        const fromIndex = (index: number | null | undefined): number | null => {
            if (!indexToUid || typeof index !== 'number') {
                return null;
            }
            const uid = indexToUid[index];
            return (typeof uid === 'number') ? uid : null;
        };

        annotations.length = 0;
        nextId = 0;
        selectedId = null;
        if (Array.isArray(data)) {
            data.forEach((d) => {
                annotations.push({
                    id: d.id ?? genId(),
                    position: d.position,
                    title: d.title ?? '',
                    text: d.text ?? '',
                    url: d.url ?? '',
                    newTab: d.newTab ?? false,
                    sceneUid: indexToUid ? fromIndex(d.sceneIndex) : (d.sceneUid ?? null),
                    camera: d.camera ?? { position: [0, 0, 0], target: [0, 0, 1], fov: 60 }
                });
                // keep the counter ahead of any numeric id we loaded
                const m = /^annotation_(\d+)$/.exec(d.id ?? '');
                if (m) {
                    nextId = Math.max(nextId, parseInt(m[1], 10) + 1);
                }
            });
        }
        events.fire('annotations.selectionChanged', null);
        fireChanged();
    });
};

export {
    registerAnnotationsEvents,
    AddAnnotationOp,
    RemoveAnnotationOp,
    UpdateAnnotationOp,
    AnnotationData,
    AnnotationDocData,
    AnnotationCamera,
    AnnotationExport
};
