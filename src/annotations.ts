import { Events } from './events';
import { resolveAnnotationSceneIndex } from './portal-export';

// Camera fly-to view stored per annotation (packed arrays for serialization).
type AnnotationCamera = {
    position: [number, number, number],
    target: [number, number, number],
    fov: number
};

// One attached image. Metadata only: the bytes live in the session store in
// annotation-images.ts, keyed by imageId, because this record is snapshotted
// into the undo stack by UpdateAnnotationOp.
type AnnotationImage = {
    imageId: string,
    ext: string,
    mime: string,
    caption: string     // visible caption AND alt text; may be empty
};

// An image record read out of a project file is untrusted input: `imageId` and
// `ext` are concatenated into a ZIP entry name (annotations/<imageId>.<ext>) on
// save and into extras.images[].src on export, so a hand-crafted .ssproj
// carrying imageId '../../../evil' with ext 'html' would write outside
// annotations/ and point the exported viewer at an active document. This is the
// same statement server/src/annotation-images.ts makes about an attacker-
// controllable multipart filename; validating here, at the only door untrusted
// records come through, keeps a bad value out of BOTH sinks. Records that fail
// are dropped, never repaired.
const IMAGE_ID_RE = /^annimg_\d+$/;
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp'];

const isSafeImageRecord = (img: any): boolean => {
    return !!img &&
        typeof img.imageId === 'string' && IMAGE_ID_RE.test(img.imageId) &&
        typeof img.ext === 'string' && IMAGE_EXTS.includes(img.ext);
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
    // Which action this annotation offers in the viewer. `url`/`newTab` and
    // `images` are both retained across a mode switch (so flipping back and
    // forth loses nothing); this field decides which one is live, which is
    // what makes "link or gallery, never both" a property of the data rather
    // than a rule the UI has to police.
    linkType: 'none' | 'url' | 'images',
    images: AnnotationImage[],
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
    extras: {
        url?: string,
        newTab?: boolean,
        images?: { src: string, caption: string }[],
        scene?: number,
        id?: string
    }
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

// Reordering an annotation is a move of its slot in the array, which IS the
// annotation order (badge numbers, export order, the exported viewer's iframe
// api index). A single move is its own inverse, so from/to round-trip exactly.
class MoveAnnotationOp {
    name = 'moveAnnotation';
    events: Events;
    id: string;
    fromIndex: number;
    toIndex: number;

    constructor(events: Events, id: string, fromIndex: number, toIndex: number) {
        this.events = events;
        this.id = id;
        this.fromIndex = fromIndex;
        this.toIndex = toIndex;
    }

    do() {
        this.events.fire('annotations.moveRaw', this.id, this.toIndex);
    }

    undo() {
        this.events.fire('annotations.moveRaw', this.id, this.fromIndex);
    }

    destroy() {
        this.events = null;
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

    // Splices in place rather than remove+insert: removeRaw clears the
    // selection (see above), which would close the annotation toolbar on every
    // click of a move button.
    events.on('annotations.moveRaw', (id: string, toIndex: number) => {
        const from = annotations.findIndex(a => a.id === id);
        if (from < 0) {
            return;
        }
        const to = Math.max(0, Math.min(annotations.length - 1, toIndex));
        if (to === from) {
            return;
        }
        const [a] = annotations.splice(from, 1);
        annotations.splice(to, 0, a);
        fireChanged();
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
            // Emit ONLY the live action. An annotation in 'images' mode with an
            // empty list exports exactly as 'none' does -- it must never fall
            // back to the url the record still carries.
            const isUrl = a.linkType === 'url' && !!a.url;
            // An image whose bytes are not in the session store (a document
            // loaded from an archive that lacked the entry) is skipped here for
            // the same reason collectAnnotationImages skips its bytes: emitting
            // the src anyway would give the viewer a broken slide it still
            // counts ("2 / 3"). Asked over the event bus rather than by
            // importing annotation-images.ts, which owns the store.
            const images = (a.linkType === 'images') ?
                a.images
                .filter(img => events.invoke('annotationImages.has', img.imageId))
                .map(img => ({ src: `annotations/${img.imageId}.${img.ext}`, caption: img.caption })) :
                [];
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
                    url: isUrl ? a.url : undefined,
                    newTab: isUrl ? a.newTab : undefined,
                    images: images.length ? images : undefined,
                    scene: scene ?? undefined,
                    id: a.id
                }
            };
        });
    });

    // Every image still referenced by a live annotation, deduplicated. Used by
    // document save and by the export popups to decide which bytes to emit --
    // images orphaned by an edit are simply never written.
    events.function('annotations.imageRefs', (): AnnotationImage[] => {
        const seen = new Set<string>();
        const refs: AnnotationImage[] = [];
        annotations.forEach((a) => {
            if (a.linkType !== 'images') {
                return;
            }
            a.images.forEach((img) => {
                if (!seen.has(img.imageId)) {
                    seen.add(img.imageId);
                    refs.push(img);
                }
            });
        });
        return refs;
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
                linkType: a.linkType,
                images: a.images.map(img => ({ ...img })),
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
                    // legacy documents have neither field: a record carrying a
                    // url was, by definition, a link annotation
                    linkType: d.linkType ?? (d.url ? 'url' : 'none'),
                    images: Array.isArray(d.images) ? d.images.filter(isSafeImageRecord).map(img => ({ ...img })) : [],
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
    MoveAnnotationOp,
    AnnotationData,
    AnnotationDocData,
    AnnotationCamera,
    AnnotationExport,
    AnnotationImage
};
