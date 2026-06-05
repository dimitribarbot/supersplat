# Annotations with Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user author text annotations (title + body, optional clickable link) anchored to points on a 3DGS in the SuperSplat Editor, persist them in the project file, and render them — including a working link — in the exported/published viewer.

**Architecture:** A self-contained editor module (`src/annotations.ts`) owns the annotation data, exposes it via `events`, persists into the project document, and is read at export time. Markers are drawn by an editor-only gizmo `Element`. A click-to-place tool sets positions. The link is delivered by injecting a small companion (JS + CSS + link table) into the exported HTML — the upstream `supersplat-viewer` is not modified.

**Tech Stack:** TypeScript, PlayCanvas, `@playcanvas/pcui`, `@playcanvas/splat-transform` (`writeHtml`/`FileSystem`), Rollup, ESLint, i18next.

**Spec:** `docs/superpowers/specs/2026-06-04-annotations-with-links-design.md`

**Project test posture:** This repo has **no test framework** (only `npm run lint`), consistent with `docs/superpowers/plans/2026-05-27-export-viewer-settings.md`. Each task therefore uses `npm run lint` + a concrete manual browser check instead of automated tests.

---

## Assumptions & risks (read before starting)

1. **Marker interaction = select + reposition (not free 3D drag).** The spec mentions "see/select/move" markers. To stay within YAGNI and avoid building a full 3D drag gizmo, this plan implements: add via click-to-place, select via the panel list (or click), and **reposition** by selecting an annotation then clicking a new point with the place tool. If true drag is required, raise it before Task 5.
2. **Companion DOM coupling (Approach 1).** The companion must locate the viewer's per-annotation tooltip DOM and its label to append the link. The exact tooltip DOM structure is **not** fully known from source; **Task 9 Step 1 is a mandatory inspection** of a real exported viewer's DOM, after which the matching selector is finalized. The companion degrades gracefully (warns once, text still shows) if the structure isn't found.
3. **`camera.getPose`** returns `{ position: Vec3, target: Vec3, fov: number }` (used by `src/camera-poses.ts:59`). This plan relies on it for capturing an annotation's fly-to camera.

---

## File Structure

Files created:
- `src/annotations.ts` — annotation data manager + edit ops + serialize/export functions.
- `src/annotation-gizmos.ts` — editor-only marker rendering `Element`.
- `src/tools/annotation-tool.ts` — click-to-place / reposition tool.
- `src/ui/annotations-panel.ts` — PCUI side panel (list + edit fields + buttons).
- `src/viewer-companion/annotation-links.ts` — builds the injected companion HTML string.

Files modified:
- `src/main.ts` — register the module and the tool.
- `src/scene.ts` — instantiate the marker gizmo.
- `src/doc.ts` — serialize/deserialize annotations into the project file.
- `src/ui/editor.ts` — mount the annotations panel.
- `src/splat-export-core.ts` — inject the companion into all three viewer export types.
- `src/ui/export-popup.ts` — populate `annotations` instead of `[]`.
- `src/ui/publish-settings-dialog.ts` — populate `annotations` instead of `[]`.
- `static/locales/*.json` (9 files) — UI strings.

**Milestones:** After Task 6 you have working, persistable, exportable **text** annotations (link absent). Tasks 7–9 add the **link** in the exported viewer.

---

## Task 1: Annotation data manager — `src/annotations.ts`

**Files:**
- Create: `src/annotations.ts`

- [ ] **Step 1: Create the module**

Create `src/annotations.ts` with this exact content:

```ts
import { Events } from './events';

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
    camera: AnnotationCamera
};

// Export-shaped annotation matching splat-serialize.ts `Annotation`. The link
// rides in `extras`, which the viewer transports but ignores.
type AnnotationExport = {
    position: [number, number, number],
    title: string,
    text: string,
    camera: { initial: { position: [number, number, number], target: [number, number, number], fov: number } },
    extras: { url?: string, newTab?: boolean }
};

const registerAnnotationsEvents = (events: Events) => {
    const annotations: AnnotationData[] = [];
    let nextId = 0;
    let selectedId: string | null = null;

    const genId = () => `annotation_${nextId++}`;

    const fireChanged = () => events.fire('annotations.changed');

    // --- queries ---

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

    events.on('annotations.updateRaw', (id: string, patch: Partial<AnnotationData>) => {
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

    events.function('annotations.export', (): AnnotationExport[] => {
        return annotations.map(a => ({
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
            extras: { url: a.url || undefined, newTab: a.url ? a.newTab : undefined }
        }));
    });

    // --- document serialization ---

    events.function('docSerialize.annotations', (): AnnotationData[] => {
        return annotations.map(a => ({
            id: a.id,
            position: [a.position[0], a.position[1], a.position[2]],
            title: a.title,
            text: a.text,
            url: a.url,
            newTab: a.newTab,
            camera: {
                position: [a.camera.position[0], a.camera.position[1], a.camera.position[2]],
                target: [a.camera.target[0], a.camera.target[1], a.camera.target[2]],
                fov: a.camera.fov
            }
        }));
    });

    events.function('docDeserialize.annotations', (data: AnnotationData[]) => {
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
                    camera: d.camera
                });
                // keep the counter ahead of any numeric id we loaded
                const m = /^annotation_(\d+)$/.exec(d.id ?? '');
                if (m) {
                    nextId = Math.max(nextId, parseInt(m[1], 10) + 1);
                }
            });
        }
        events.fire('annotations.selectionChanged', null);
        events.fire('annotations.changed');
    });
};

export { registerAnnotationsEvents, AnnotationData, AnnotationCamera, AnnotationExport };
```

- [ ] **Step 2: Wire the module into startup**

In `src/main.ts`, add the import next to the other early-registration imports (the `registerCameraPosesEvents` import is at `src/main.ts:4`):

```ts
import { registerAnnotationsEvents } from './annotations';
```

Then, in the early registration block (currently `src/main.ts:103-109`, right after `registerCameraPosesEvents(events);`), add:

```ts
registerAnnotationsEvents(events);
```

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/annotations.ts src/main.ts
git commit -m "feat(annotations): add annotation data manager module"
```

---

## Task 2: Persist annotations in the project file — `src/doc.ts`

**Files:**
- Modify: `src/doc.ts:124` (deserialize), `src/doc.ts:160` (serialize)

- [ ] **Step 1: Add to serialize**

In `saveDocument` (`src/doc.ts:156-163`), the `document` object literal currently is:

```ts
const document = {
    version: 0,
    camera: scene.camera.docSerialize(),
    view: events.invoke('docSerialize.view'),
    poseSets: events.invoke('docSerialize.poseSets'),
    timeline: events.invoke('docSerialize.timeline'),
    splats: splats.map(s => s.docSerialize())
};
```

Add an `annotations` line after `timeline`:

```ts
const document = {
    version: 0,
    camera: scene.camera.docSerialize(),
    view: events.invoke('docSerialize.view'),
    poseSets: events.invoke('docSerialize.poseSets'),
    timeline: events.invoke('docSerialize.timeline'),
    annotations: events.invoke('docSerialize.annotations'),
    splats: splats.map(s => s.docSerialize())
};
```

- [ ] **Step 2: Add to deserialize**

In `loadDocument`, after the existing `docDeserialize.*` calls (`src/doc.ts:123-125`), add a line. The block currently is:

```ts
events.invoke('docDeserialize.timeline', document.timeline);
events.invoke('docDeserialize.poseSets', document.poseSets, document.camera?.fov);
events.invoke('docDeserialize.view', document.view);
```

Make it:

```ts
events.invoke('docDeserialize.timeline', document.timeline);
events.invoke('docDeserialize.poseSets', document.poseSets, document.camera?.fov);
events.invoke('docDeserialize.annotations', document.annotations);
events.invoke('docDeserialize.view', document.view);
```

(Old documents have `document.annotations === undefined`; `docDeserialize.annotations` handles that by clearing to empty.)

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/doc.ts
git commit -m "feat(annotations): persist annotations in the project document"
```

---

## Task 3: Undoable edit ops — `src/annotations.ts`

**Files:**
- Modify: `src/annotations.ts`

EditOps implement the interface from `src/edit-ops.ts:11-16` (`name`, `do()`, `undo()`, optional `destroy()`) and are pushed via `events.fire('edit.add', op)` (`src/edit-history.ts:32`). They mutate via the raw events defined in Task 1.

- [ ] **Step 1: Add the edit op classes**

In `src/annotations.ts`, immediately before `const registerAnnotationsEvents`, add:

```ts
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
```

- [ ] **Step 2: Export the ops**

Change the export line at the bottom of `src/annotations.ts` to include the ops:

```ts
export {
    registerAnnotationsEvents,
    AddAnnotationOp,
    RemoveAnnotationOp,
    UpdateAnnotationOp,
    AnnotationData,
    AnnotationCamera,
    AnnotationExport
};
```

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/annotations.ts
git commit -m "feat(annotations): add undoable add/remove/update edit ops"
```

---

## Task 4: Marker gizmo — `src/annotation-gizmos.ts`

**Files:**
- Create: `src/annotation-gizmos.ts`
- Modify: `src/scene.ts:226` (instantiate)

Modelled on `src/camera-pose-gizmos.ts`. Draws a small 3D diamond (line list) at each annotation position; the selected annotation is drawn in a highlight color. Reuses the existing debug-line shader (`src/shaders/debug-shader.ts`).

- [ ] **Step 1: Create the gizmo**

Create `src/annotation-gizmos.ts`:

```ts
import {
    PRIMITIVE_LINES,
    Entity,
    Mesh,
    MeshInstance,
    ShaderMaterial,
    Vec3
} from 'playcanvas';

import { Element, ElementType } from './element';
import { vertexShader, fragmentShader } from './shaders/debug-shader';

// 3 axis-aligned line segments (a small "jack") per marker = 3 lines = 6 verts.
const LINES_PER_MARKER = 3;
const VERTS_PER_MARKER = LINES_PER_MARKER * 2;
const MARKER_SIZE = 0.05;

type Annotation = { id: string, position: [number, number, number] };

class AnnotationGizmos extends Element {
    entity: Entity;
    mesh: Mesh;
    material: ShaderMaterial;
    meshInstance: MeshInstance;
    dirty = true;

    constructor() {
        super(ElementType.debug);
    }

    add() {
        const scene = this.scene;
        const device = scene.graphicsDevice;

        this.material = new ShaderMaterial({
            uniqueName: 'annotationGizmoMaterial',
            vertexGLSL: vertexShader,
            fragmentGLSL: fragmentShader
        });
        this.material.depthWrite = true;
        this.material.depthTest = true;
        this.material.update();

        this.mesh = new Mesh(device);
        this.mesh.primitive[0] = {
            baseVertex: 0,
            type: PRIMITIVE_LINES,
            base: 0,
            count: 0
        };

        this.meshInstance = new MeshInstance(this.mesh, this.material, null);
        this.meshInstance.cull = false;

        this.entity = new Entity('annotationGizmos');
        this.entity.addComponent('render', {
            meshInstances: [this.meshInstance],
            layers: [scene.worldLayer.id]
        });

        scene.app.root.addChild(this.entity);

        const markDirty = () => {
            this.dirty = true;
            scene.forceRender = true;
        };
        const { events } = scene;
        events.on('annotations.changed', markDirty);
        events.on('annotations.selectionChanged', markDirty);
        events.on('scene.boundChanged', markDirty);
    }

    destroy() {
        this.entity?.destroy();
    }

    onPreRender() {
        const { scene } = this;
        const visible = scene.camera.renderOverlays;

        this.entity.enabled = visible;

        if (visible && this.dirty) {
            this.dirty = false;
            this.rebuildMesh();
        }
    }

    private rebuildMesh() {
        const annotations = this.scene.events.invoke('annotations.list') as Annotation[];
        const selectedId = this.scene.events.invoke('annotations.selected') as string | null;

        if (!annotations || annotations.length === 0) {
            this.mesh.primitive[0].count = 0;
            this.mesh.update(PRIMITIVE_LINES);
            return;
        }

        const numVerts = annotations.length * VERTS_PER_MARKER;
        const positions: number[] = [];
        const colors = new Uint8Array(numVerts * 4);

        const p = new Vec3();
        let vi = 0;
        const pushVert = (x: number, y: number, z: number, sel: boolean) => {
            positions.push(x, y, z);
            const off = vi * 4;
            // selected = yellow, otherwise cyan
            colors[off] = sel ? 255 : 0;
            colors[off + 1] = 255;
            colors[off + 2] = sel ? 0 : 255;
            colors[off + 3] = 255;
            vi++;
        };

        for (const ann of annotations) {
            const sel = ann.id === selectedId;
            p.set(ann.position[0], ann.position[1], ann.position[2]);
            // three axis-aligned segments through the point
            pushVert(p.x - MARKER_SIZE, p.y, p.z, sel);
            pushVert(p.x + MARKER_SIZE, p.y, p.z, sel);
            pushVert(p.x, p.y - MARKER_SIZE, p.z, sel);
            pushVert(p.x, p.y + MARKER_SIZE, p.z, sel);
            pushVert(p.x, p.y, p.z - MARKER_SIZE, sel);
            pushVert(p.x, p.y, p.z + MARKER_SIZE, sel);
        }

        this.mesh.setPositions(positions);
        this.mesh.setColors32(colors);
        this.mesh.update(PRIMITIVE_LINES);
    }
}

export { AnnotationGizmos };
```

- [ ] **Step 2: Register the gizmo in the scene**

In `src/scene.ts`, add the import near the `CameraPoseGizmos` import (search for `camera-pose-gizmos`):

```ts
import { AnnotationGizmos } from './annotation-gizmos';
```

Then, in the Scene constructor right after the `cameraPoseGizmos` registration (`src/scene.ts:226-227`):

```ts
this.cameraPoseGizmos = new CameraPoseGizmos();
this.add(this.cameraPoseGizmos);
```

add:

```ts
this.annotationGizmos = new AnnotationGizmos();
this.add(this.annotationGizmos);
```

Also declare the field on the Scene class. Find where `cameraPoseGizmos` is declared as a class member (search `cameraPoseGizmos:` in `src/scene.ts`) and add an adjacent declaration:

```ts
annotationGizmos: AnnotationGizmos;
```

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no new errors. (If `scene.forceRender` or `scene.worldLayer` types complain, confirm the exact names against `src/camera-pose-gizmos.ts:42,66,95` — they are used identically there.)

- [ ] **Step 4: Commit**

```bash
git add src/annotation-gizmos.ts src/scene.ts
git commit -m "feat(annotations): render editor-only marker gizmos"
```

---

## Task 5: Click-to-place tool — `src/tools/annotation-tool.ts`

**Files:**
- Create: `src/tools/annotation-tool.ts`
- Modify: `src/main.ts` (register tool)

Implements the `Tool` interface (`src/tools/tool-manager.ts:3-6`: `activate()`, `deactivate()`). On a primary click it raycasts via `scene.camera.intersect(...)` (`src/camera.ts:675`), captures the current camera pose via `events.invoke('camera.getPose')`, and pushes an `AddAnnotationOp`. If an annotation is currently selected, the click **repositions** it (via `UpdateAnnotationOp`) instead of adding a new one.

- [ ] **Step 1: Create the tool**

Create `src/tools/annotation-tool.ts`:

```ts
import { Events } from '../events';
import { Scene } from '../scene';
import { AddAnnotationOp, UpdateAnnotationOp, AnnotationData } from '../annotations';

class AnnotationTool {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, scene: Scene, canvasContainer: { dom: HTMLElement }) {
        let active = false;
        let clicked = false;

        const isPrimary = (e: PointerEvent) => {
            return e.pointerType === 'mouse' ? e.button === 0 : e.isPrimary;
        };

        const pointerdown = (e: PointerEvent) => {
            if (!clicked && isPrimary(e)) {
                clicked = true;
            }
        };

        const pointermove = () => {
            clicked = false;
        };

        const pointerup = async (e: PointerEvent) => {
            if (!active || !clicked || !isPrimary(e)) {
                return;
            }
            clicked = false;

            const nx = e.offsetX / canvasContainer.dom.clientWidth;
            const ny = e.offsetY / canvasContainer.dom.clientHeight;
            const result = await scene.camera.intersect(nx, ny);
            if (!result) {
                return;
            }

            const pos: [number, number, number] = [
                result.position.x, result.position.y, result.position.z
            ];

            const selectedId = events.invoke('annotations.selected') as string | null;

            if (selectedId) {
                // reposition the selected annotation
                const existing = events.invoke('annotations.byId', selectedId) as AnnotationData;
                if (existing) {
                    events.fire('edit.add', new UpdateAnnotationOp(
                        events,
                        selectedId,
                        { position: existing.position },
                        { position: pos }
                    ));
                }
            } else {
                // add a new annotation, capturing the current camera as its fly-to view
                const pose = events.invoke('camera.getPose');
                const data: AnnotationData = {
                    id: events.invoke('annotations.newId') as string,
                    position: pos,
                    title: '',
                    text: '',
                    url: '',
                    newTab: false,
                    camera: {
                        position: [pose.position.x, pose.position.y, pose.position.z],
                        target: [pose.target.x, pose.target.y, pose.target.z],
                        fov: pose.fov
                    }
                };
                events.fire('edit.add', new AddAnnotationOp(events, data));
            }

            e.preventDefault();
            e.stopPropagation();
        };

        this.activate = () => {
            active = true;
            canvasContainer.dom.addEventListener('pointerdown', pointerdown);
            canvasContainer.dom.addEventListener('pointermove', pointermove);
            canvasContainer.dom.addEventListener('pointerup', pointerup, true);
        };

        this.deactivate = () => {
            active = false;
            canvasContainer.dom.removeEventListener('pointerdown', pointerdown);
            canvasContainer.dom.removeEventListener('pointermove', pointermove);
            canvasContainer.dom.removeEventListener('pointerup', pointerup, true);
        };
    }
}

export { AnnotationTool };
```

- [ ] **Step 2: Register the tool**

In `src/main.ts`, add the import next to the other tool imports (search for `MeasureTool`):

```ts
import { AnnotationTool } from './tools/annotation-tool';
```

Then in the tool registration block (after the `measure` registration at `src/main.ts:243`):

```ts
toolManager.register('annotation', new AnnotationTool(events, scene, editorUI.canvasContainer));
```

(Activating/deactivating is done via `events.fire('tool.annotation')`, wired from the panel in Task 6. `editorUI.canvasContainer` is the same object passed to `MeasureTool` at `src/main.ts:243`.)

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no new errors.

- [ ] **Step 4: Manual check**

Run: `npm run develop`, open `http://localhost:3000`, load a small splat. In the browser console run `editor` is not exposed, so instead trigger the tool from the console via the global events if available; otherwise defer the manual check to Task 6 (where the panel button activates the tool). For now confirm the build compiles and the page loads without console errors.

- [ ] **Step 5: Commit**

```bash
git add src/tools/annotation-tool.ts src/main.ts
git commit -m "feat(annotations): add click-to-place / reposition tool"
```

---

## Task 6: Annotations side panel — `src/ui/annotations-panel.ts`

**Files:**
- Create: `src/ui/annotations-panel.ts`
- Modify: `src/ui/editor.ts:125` (instantiate + append)
- Modify: `static/locales/en.json` (keys; other locales in Task 10)

Built with PCUI, mirroring `src/ui/color-panel.ts` / `src/ui/view-panel.ts` (header + rows, `stopPropagation` on pointer events, hidden by default). Contains: an **Add** button (toggles `tool.annotation`), a list of annotations, and an editor for the selected annotation (title, text, URL, "open in new tab", **delete**, **re-capture camera**).

- [ ] **Step 1: Create the panel**

Create `src/ui/annotations-panel.ts`:

```ts
import { BooleanInput, Button, Container, Label, TextInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { localize } from './localization';
import { RemoveAnnotationOp, UpdateAnnotationOp, AnnotationData } from '../annotations';

class AnnotationsPanel extends Container {
    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'annotations-panel',
            class: 'panel',
            hidden: true
        };

        super(args);

        // stop pointer events bubbling to the canvas
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        // header
        const header = new Container({ class: 'panel-header' });
        const icon = new Label({ class: 'panel-header-icon', text: '' });
        const label = new Label({ class: 'panel-header-label', text: localize('panel.annotations') });
        header.append(icon);
        header.append(label);

        // add button -> activates the click-to-place tool
        const addButton = new Button({
            class: 'annotations-add',
            text: localize('panel.annotations.add')
        });
        addButton.on('click', () => {
            events.fire('tool.annotation');
        });

        // list of annotations
        const list = new Container({ class: 'annotations-list' });

        // editor for the selected annotation
        const editor = new Container({ class: 'annotations-editor', hidden: true });

        const titleRow = new Container({ class: 'annotations-row' });
        const titleLabel = new Label({ class: 'annotations-row-label', text: localize('panel.annotations.title') });
        const titleInput = new TextInput({ class: 'annotations-row-input' });
        titleRow.append(titleLabel);
        titleRow.append(titleInput);

        const textRow = new Container({ class: 'annotations-row' });
        const textLabel = new Label({ class: 'annotations-row-label', text: localize('panel.annotations.text') });
        const textInput = new TextInput({ class: 'annotations-row-input' });
        textRow.append(textLabel);
        textRow.append(textInput);

        const urlRow = new Container({ class: 'annotations-row' });
        const urlLabel = new Label({ class: 'annotations-row-label', text: localize('panel.annotations.url') });
        const urlInput = new TextInput({ class: 'annotations-row-input', placeholder: 'https://' });
        urlRow.append(urlLabel);
        urlRow.append(urlInput);

        const newTabRow = new Container({ class: 'annotations-row' });
        const newTabLabel = new Label({ class: 'annotations-row-label', text: localize('panel.annotations.new-tab') });
        const newTabInput = new BooleanInput({ class: 'annotations-row-toggle', type: 'toggle' });
        newTabRow.append(newTabLabel);
        newTabRow.append(newTabInput);

        const buttonRow = new Container({ class: 'annotations-row' });
        const recaptureButton = new Button({ class: 'annotations-recapture', text: localize('panel.annotations.recapture') });
        const deleteButton = new Button({ class: 'annotations-delete', text: localize('panel.annotations.delete') });
        buttonRow.append(recaptureButton);
        buttonRow.append(deleteButton);

        editor.append(titleRow);
        editor.append(textRow);
        editor.append(urlRow);
        editor.append(newTabRow);
        editor.append(buttonRow);

        this.append(header);
        this.append(addButton);
        this.append(list);
        this.append(editor);

        // --- state / rendering ---

        let suppress = false;

        const selectedAnnotation = (): AnnotationData | null => {
            const id = events.invoke('annotations.selected') as string | null;
            return id ? (events.invoke('annotations.byId', id) as AnnotationData) : null;
        };

        const rebuildList = () => {
            list.clear();
            const annotations = events.invoke('annotations.list') as AnnotationData[];
            const selectedId = events.invoke('annotations.selected') as string | null;
            annotations.forEach((a, i) => {
                const row = new Label({
                    class: a.id === selectedId ? 'annotations-list-item selected' : 'annotations-list-item',
                    text: a.title || `${localize('panel.annotations.untitled')} ${i + 1}`
                });
                row.dom.addEventListener('click', () => {
                    events.fire('annotations.select', a.id);
                });
                list.append(row);
            });
        };

        const refreshEditor = () => {
            const a = selectedAnnotation();
            editor.hidden = !a;
            if (!a) {
                return;
            }
            suppress = true;
            titleInput.value = a.title;
            textInput.value = a.text;
            urlInput.value = a.url;
            newTabInput.value = a.newTab;
            suppress = false;
        };

        // commit a field change as an undoable op
        const commit = (field: keyof AnnotationData, value: string | boolean) => {
            if (suppress) {
                return;
            }
            const a = selectedAnnotation();
            if (!a || a[field] === value) {
                return;
            }
            events.fire('edit.add', new UpdateAnnotationOp(
                events,
                a.id,
                { [field]: a[field] } as Partial<AnnotationData>,
                { [field]: value } as Partial<AnnotationData>
            ));
        };

        titleInput.on('change', (v: string) => commit('title', v));
        textInput.on('change', (v: string) => commit('text', v));
        urlInput.on('change', (v: string) => commit('url', v));
        newTabInput.on('change', (v: boolean) => commit('newTab', v));

        recaptureButton.on('click', () => {
            const a = selectedAnnotation();
            if (!a) {
                return;
            }
            const pose = events.invoke('camera.getPose');
            const newCamera = {
                position: [pose.position.x, pose.position.y, pose.position.z] as [number, number, number],
                target: [pose.target.x, pose.target.y, pose.target.z] as [number, number, number],
                fov: pose.fov
            };
            events.fire('edit.add', new UpdateAnnotationOp(
                events,
                a.id,
                { camera: a.camera },
                { camera: newCamera }
            ));
        });

        deleteButton.on('click', () => {
            const id = events.invoke('annotations.selected') as string | null;
            if (!id) {
                return;
            }
            const annotations = events.invoke('annotations.list') as AnnotationData[];
            const index = annotations.findIndex(x => x.id === id);
            const data = annotations[index];
            if (data) {
                events.fire('edit.add', new RemoveAnnotationOp(events, data, index));
            }
        });

        events.on('annotations.changed', () => {
            rebuildList();
            refreshEditor();
        });
        events.on('annotations.selectionChanged', () => {
            rebuildList();
            refreshEditor();
        });

        rebuildList();
        refreshEditor();
    }
}

export { AnnotationsPanel };
```

- [ ] **Step 2: Mount the panel**

In `src/ui/editor.ts`, add the import next to the other panel imports (search for `ColorPanel`):

```ts
import { AnnotationsPanel } from './annotations-panel';
```

Then, where panels are constructed (`src/ui/editor.ts:123-127`, near `const colorPanel = new ColorPanel(events, tooltips);`), add:

```ts
const annotationsPanel = new AnnotationsPanel(events);
```

And where panels are appended to `canvasContainer` (`src/ui/editor.ts:135-140`, near `canvasContainer.append(colorPanel);`), add:

```ts
canvasContainer.append(annotationsPanel);
```

(The panel is `hidden: true` by default. Toggling its visibility from a toolbar/menu is out of scope for this plan — to verify, temporarily flip `hidden` to `false` in Step 4, or unhide it from the console. A toolbar toggle can follow as a separate change.)

- [ ] **Step 3: Add English locale keys**

In `static/locales/en.json`, add these keys (anywhere among the `panel.*` keys, keeping valid JSON / trailing commas):

```json
    "panel.annotations": "Annotations",
    "panel.annotations.add": "Add Annotation",
    "panel.annotations.title": "Title",
    "panel.annotations.text": "Text",
    "panel.annotations.url": "Link URL",
    "panel.annotations.new-tab": "Open in New Tab",
    "panel.annotations.recapture": "Recapture View",
    "panel.annotations.delete": "Delete",
    "panel.annotations.untitled": "Annotation",
```

- [ ] **Step 4: Manual check (core feature end-to-end)**

Run: `npm run develop`, open `http://localhost:3000`, load a small splat. Temporarily set the panel `hidden: false` (Step 2) so it shows.
Verify:
1. Click **Add Annotation** → cursor click on the splat drops a marker (cyan jack) and a list entry appears, selected (yellow).
2. Edit Title/Text/URL/New-tab → list label updates; `Ctrl+Z` undoes the edit; `Ctrl+Y`/`Ctrl+Shift+Z` redoes.
3. With an annotation selected, click another point → the marker moves (reposition); undo restores it.
4. **Delete** removes it; undo restores it.
5. **Save** the project (`.ssproj`), reload it → annotations come back with all fields.

Restore `hidden: true` after verifying.

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/ui/annotations-panel.ts src/ui/editor.ts static/locales/en.json
git commit -m "feat(annotations): add authoring side panel"
```

---

## Task 7: Populate annotations on export

**Files:**
- Modify: `src/ui/export-popup.ts:576`
- Modify: `src/ui/publish-settings-dialog.ts:375`

- [ ] **Step 1: Export popup**

In `src/ui/export-popup.ts`, the experience settings object currently sets `annotations: []` (`src/ui/export-popup.ts:576`). Replace that single line:

```ts
                    annotations: [],
```

with:

```ts
                    annotations: events.invoke('annotations.export') ?? [],
```

Confirm `events` is in scope at that location (this file already uses `events` extensively; if the symbol differs, use the same events reference the surrounding code uses).

- [ ] **Step 2: Publish settings dialog**

In `src/ui/publish-settings-dialog.ts`, replace the `annotations: []` line (`src/ui/publish-settings-dialog.ts:375`):

```ts
                        annotations: [],
```

with:

```ts
                        annotations: events.invoke('annotations.export') ?? [],
```

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no new errors.

- [ ] **Step 4: Manual check**

Run the dev server, place an annotation with a title + text (no URL needed yet), then export **Viewer App (HTML)**. Open the exported `.html`, search for your annotation title — it should appear inside the embedded `viewerSettingsJson`. Open the HTML in a browser → the annotation hotspot shows the title/text (link not expected until Task 9).

- [ ] **Step 5: Commit**

```bash
git add src/ui/export-popup.ts src/ui/publish-settings-dialog.ts
git commit -m "feat(annotations): include annotations in viewer export settings"
```

---

## Task 8: Companion builder — `src/viewer-companion/annotation-links.ts`

**Files:**
- Create: `src/viewer-companion/annotation-links.ts`

A pure string builder: given the export `annotations`, produce the `<style> + <script>` HTML to inject (or `''` when no annotation has a URL). Has no editor/PlayCanvas imports, so it's safe to import from `src/splat-export-core.ts` without circular dependencies.

> **Note on the matching selector:** Step 1 below ships a best-effort selector. The real per-annotation tooltip DOM is finalized in **Task 9 Step 1** after inspecting an exported viewer. Update the `decorate`/selector logic there.

- [ ] **Step 1: Create the builder**

Create `src/viewer-companion/annotation-links.ts`:

```ts
type AnyAnnotation = {
    title?: string,
    text?: string,
    extras?: { url?: string, newTab?: boolean }
};

// Build the link table the runtime companion consumes. label is 1-based to
// match the viewer's auto-generated annotation label (index + 1).
const buildLinkTable = (annotations: AnyAnnotation[]): { label: number, url: string, newTab: boolean }[] => {
    const table: { label: number, url: string, newTab: boolean }[] = [];
    annotations.forEach((a, i) => {
        const url = a.extras?.url;
        if (url) {
            table.push({ label: i + 1, url, newTab: !!a.extras?.newTab });
        }
    });
    return table;
};

// The runtime companion. Kept as a plain string so it is injected verbatim.
// It: (1) reads the link table, (2) sanitises URLs to http(s)/relative only,
// (3) appends a clickable link to each annotation tooltip that has a URL,
// using a MutationObserver so it works regardless of when the viewer builds
// the annotation DOM. Selector specifics are finalized in Task 9.
const companionRuntime = `
(function () {
  var links = window.__supersplatAnnotationLinks || [];
  if (!links.length) return;

  var byLabel = {};
  links.forEach(function (l) { byLabel[String(l.label)] = l; });

  function safeHref(url) {
    try {
      var u = new URL(url, window.location.href);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
    } catch (e) {}
    return null;
  }

  var warned = false;
  function warnOnce() {
    if (!warned) { warned = true; console.warn('[supersplat] annotation link companion: could not locate annotation tooltips'); }
  }

  // Append a link to a tooltip node that we have matched to a label.
  function decorate(tooltipNode, link) {
    if (tooltipNode.querySelector('.ss-annotation-link')) return; // already done
    var href = safeHref(link.url);
    if (!href) return;
    var a = document.createElement('a');
    a.className = 'ss-annotation-link';
    a.href = href;
    a.textContent = 'Open link \\u2197';
    if (link.newTab) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    tooltipNode.appendChild(a);
  }

  // Match a tooltip node to a label. FINALIZE in Task 9 after inspecting the
  // exported viewer DOM. The default heuristic: each annotation root carries a
  // visible numeric label; read it and match byLabel.
  function labelOf(node) {
    var el = node.querySelector('[data-label]');
    if (el) return el.getAttribute('data-label');
    return null;
  }

  function scan(root) {
    var container = document.getElementById('annotations');
    if (!container) return false;
    var nodes = container.children;
    var matchedAny = false;
    for (var i = 0; i < nodes.length; i++) {
      var label = labelOf(nodes[i]);
      if (label && byLabel[label]) { decorate(nodes[i], byLabel[label]); matchedAny = true; }
    }
    return matchedAny;
  }

  function start() {
    if (!scan()) {
      // container/tooltips not present yet; observe for them
      var obs = new MutationObserver(function () { scan(); });
      obs.observe(document.body, { childList: true, subtree: true });
      // give up the warning only after a grace period
      setTimeout(function () { if (!scan()) warnOnce(); }, 4000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
`;

const companionStyle = `
.ss-annotation-link {
  display: inline-block;
  margin-top: 8px;
  padding: 4px 8px;
  border-radius: 4px;
  background: rgba(255,255,255,0.15);
  color: #fff;
  text-decoration: none;
  font-size: 13px;
  cursor: pointer;
}
.ss-annotation-link:hover { background: rgba(255,255,255,0.3); }
`;

// Produce the full HTML fragment to inject before </body>, or '' if no links.
const buildAnnotationLinksInjection = (annotations: AnyAnnotation[]): string => {
    const table = buildLinkTable(annotations || []);
    if (table.length === 0) {
        return '';
    }
    const tableJson = JSON.stringify(table);
    return `<style>${companionStyle}</style>` +
        `<script>window.__supersplatAnnotationLinks = ${tableJson};</script>` +
        `<script>${companionRuntime}</script>`;
};

export { buildAnnotationLinksInjection, buildLinkTable };
```

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/viewer-companion/annotation-links.ts
git commit -m "feat(annotations): add viewer link companion builder"
```

---

## Task 9: Inject the companion into all viewer exports — `src/splat-export-core.ts`

**Files:**
- Modify: `src/splat-export-core.ts` (import + the three viewer write paths)

The companion HTML must be injected into the produced `index.html`/`output.html` before `</body>`, for `html`, `package`, and `streaming` exports. The link table is derived from `viewerSettingsJson.annotations`.

- [ ] **Step 1: Inspect the real exported viewer DOM (MANDATORY)**

Run: `npm run develop`. Place an annotation **with a URL** and a title. Export **Viewer App (HTML)**. Open the exported HTML in Chrome, click the hotspot to show the tooltip, then in DevTools inspect the `#annotations` container and the per-annotation tooltip node.
Record: the container id (expected `annotations`), the per-annotation element, where the **label number** lives (attribute or text), and the element that holds the title/text (so the link can be appended in a sensible place).

Also check (this is the spec's "Approach 2" probe): in the DevTools console, inspect `window` for an exposed app/event-emitter (e.g. `window.app`, `window.viewer`, or any object with an `on('annotation.activate', ...)` API). If one exists and is reachable, prefer subscribing to `annotation.activate`/`deactivate` to place the link (cleaner than DOM-scraping). If nothing is exposed (the expected outcome — the viewer uses a private emitter), keep the Approach 1 DOM logic below.

**Update `labelOf()` and `decorate()` in `src/viewer-companion/annotation-links.ts`** to match the observed structure. Re-commit that file if changed:

```bash
git add src/viewer-companion/annotation-links.ts
git commit -m "fix(annotations): match companion selectors to exported viewer DOM"
```

- [ ] **Step 2: Add the injection import and helper**

In `src/splat-export-core.ts`, add the import after the existing imports (after `src/splat-export-core.ts:18`):

```ts
import { buildAnnotationLinksInjection } from './viewer-companion/annotation-links';
```

Then add a small helper near the top of the file (after the imports):

```ts
// Inject the annotation-link companion into an HTML string before </body>.
// No-op (returns the input) when there are no annotation links.
const injectAnnotationLinks = (html: string, viewerSettingsJson: any): string => {
    const injection = buildAnnotationLinksInjection(viewerSettingsJson?.annotations ?? []);
    if (!injection) {
        return html;
    }
    if (html.includes('</body>')) {
        return html.replace('</body>', `${injection}</body>`);
    }
    return html + injection;
};
```

- [ ] **Step 3: Inject for the `html` (bundled) export**

In `writeViewerCore` (`src/splat-export-core.ts:303-340`), the `html` branch currently is (`src/splat-export-core.ts:315-316`):

```ts
        if (viewerType === 'html') {
            await writeHtml({ filename: 'output.html', dataTable, viewerSettingsJson, bundle: true, iterations: 10, createDevice }, fs);
        } else if (viewerType === 'streaming') {
```

Replace the `html` branch so it writes to a `MemoryFileSystem`, injects, then writes to `fs`:

```ts
        if (viewerType === 'html') {
            const memFs = new MemoryFileSystem();
            await writeHtml({ filename: 'output.html', dataTable, viewerSettingsJson, bundle: true, iterations: 10, createDevice }, memFs);
            const raw = memFs.results.get('output.html');
            if (!raw) {
                throw new Error('HTML export failed: writeHtml did not produce output.html');
            }
            const injected = injectAnnotationLinks(new TextDecoder().decode(raw), viewerSettingsJson);
            const writer = await fs.createWriter('output.html');
            await writer.write(new TextEncoder().encode(injected));
            await writer.close();
        } else if (viewerType === 'streaming') {
```

(`MemoryFileSystem` is already imported at `src/splat-export-core.ts:6`.)

- [ ] **Step 4: Inject for the `package` (zip) export**

In the `else` (package) branch of `writeViewerCore` (`src/splat-export-core.ts:319-334`), after `writeHtml` populates `memFs` and before the files are zipped, inject into `index.html`. The branch currently is:

```ts
        } else {
            const memFs = new MemoryFileSystem();
            await writeHtml({ filename: 'index.html', dataTable, viewerSettingsJson, bundle: false, iterations: 10, createDevice }, memFs);
            const zipWriter = await fs.createWriter('output.zip');
```

Insert the injection between the `writeHtml` call and `const zipWriter`:

```ts
        } else {
            const memFs = new MemoryFileSystem();
            await writeHtml({ filename: 'index.html', dataTable, viewerSettingsJson, bundle: false, iterations: 10, createDevice }, memFs);
            const rawIndex = memFs.results.get('index.html');
            if (rawIndex) {
                const injected = injectAnnotationLinks(new TextDecoder().decode(rawIndex), viewerSettingsJson);
                memFs.results.set('index.html', new TextEncoder().encode(injected));
            }
            const zipWriter = await fs.createWriter('output.zip');
```

- [ ] **Step 5: Inject for the `streaming` export**

In `writeStreamingViewerCore`, the `index.html` is repointed and re-set at `src/splat-export-core.ts:269-273`:

```ts
    const repointed = repointedFetch.replace('./scene.sog', './lod-meta.json');
    if (repointed === repointedFetch) {
        throw new Error('Streaming export failed: could not repoint default content URL to lod-meta.json (writeHtml output format changed)');
    }
    memFs.results.set('index.html', new TextEncoder().encode(repointed));
```

Inject after repointing, before the `memFs.results.set`:

```ts
    const repointed = repointedFetch.replace('./scene.sog', './lod-meta.json');
    if (repointed === repointedFetch) {
        throw new Error('Streaming export failed: could not repoint default content URL to lod-meta.json (writeHtml output format changed)');
    }
    const withLinks = injectAnnotationLinks(repointed, viewerSettingsJson);
    memFs.results.set('index.html', new TextEncoder().encode(withLinks));
```

- [ ] **Step 6: Lint**

Run: `npm run lint`
Expected: no new errors.

- [ ] **Step 7: Manual check (the link, end-to-end)**

Run the dev server. Place two annotations: one with a URL + "open in new tab" checked, one with a same-viewer URL like `?content=other.sog` and new-tab unchecked.
- Export **Viewer App (HTML)**, open it, click each hotspot → an "Open link ↗" appears; the first opens a new tab; the second navigates in place.
- Export **Viewer App (package/zip)** and **streaming** (if available) → same behaviour after unzipping/serving.
- Export an annotation with **no** URL → confirm the exported HTML contains **no** `__supersplatAnnotationLinks` script (open the file and search).

- [ ] **Step 8: Commit**

```bash
git add src/splat-export-core.ts
git commit -m "feat(annotations): inject link companion into all viewer exports"
```

---

## Task 10: Localize the panel strings (remaining 8 locales)

**Files:**
- Modify: `static/locales/fr.json`, `de.json`, `es.json`, `pt-BR.json`, `ja.json`, `ko.json`, `ru.json`, `zh-CN.json`

Add the same nine `panel.annotations.*` keys added to `en.json` in Task 6 Step 3, with translated values. Keep valid JSON.

- [ ] **Step 1: Add keys to each locale**

Add this block (translated per column) into each file alongside the other `panel.*` keys:

| Key | fr | de | es | pt-BR | ja | ko | ru | zh-CN |
|-----|----|----|----|-------|----|----|----|-------|
| `panel.annotations` | Annotations | Anmerkungen | Anotaciones | Anotações | 注釈 | 주석 | Аннотации | 注释 |
| `panel.annotations.add` | Ajouter une annotation | Anmerkung hinzufügen | Añadir anotación | Adicionar anotação | 注釈を追加 | 주석 추가 | Добавить аннотацию | 添加注释 |
| `panel.annotations.title` | Titre | Titel | Título | Título | タイトル | 제목 | Заголовок | 标题 |
| `panel.annotations.text` | Texte | Text | Texto | Texto | テキスト | 텍스트 | Текст | 文本 |
| `panel.annotations.url` | URL du lien | Link-URL | URL del enlace | URL do link | リンクURL | 링크 URL | URL ссылки | 链接 URL |
| `panel.annotations.new-tab` | Ouvrir dans un nouvel onglet | In neuem Tab öffnen | Abrir en pestaña nueva | Abrir em nova aba | 新しいタブで開く | 새 탭에서 열기 | Открыть в новой вкладке | 在新标签页中打开 |
| `panel.annotations.recapture` | Recapturer la vue | Ansicht neu erfassen | Recapturar vista | Recapturar visão | ビューを再取得 | 보기 다시 캡처 | Перезахватить вид | 重新捕获视图 |
| `panel.annotations.delete` | Supprimer | Löschen | Eliminar | Excluir | 削除 | 삭제 | Удалить | 删除 |
| `panel.annotations.untitled` | Annotation | Anmerkung | Anotación | Anotação | 注釈 | 주석 | Аннотация | 注释 |

For example, in `static/locales/fr.json` add:

```json
    "panel.annotations": "Annotations",
    "panel.annotations.add": "Ajouter une annotation",
    "panel.annotations.title": "Titre",
    "panel.annotations.text": "Texte",
    "panel.annotations.url": "URL du lien",
    "panel.annotations.new-tab": "Ouvrir dans un nouvel onglet",
    "panel.annotations.recapture": "Recapturer la vue",
    "panel.annotations.delete": "Supprimer",
    "panel.annotations.untitled": "Annotation",
```

- [ ] **Step 2: Validate all locale JSON files parse**

Run:

```bash
node -e "['en','fr','de','es','pt-BR','ja','ko','ru','zh-CN'].forEach(l => { JSON.parse(require('fs').readFileSync('static/locales/'+l+'.json','utf8')); console.log(l+' OK'); })"
```

Expected: nine lines, each ending in `OK`.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add static/locales/fr.json static/locales/de.json static/locales/es.json static/locales/pt-BR.json static/locales/ja.json static/locales/ko.json static/locales/ru.json static/locales/zh-CN.json
git commit -m "i18n: add annotations panel strings"
```

---

## Done When

- All tasks committed; `npm run lint` reports no new errors; locale JSON all parses.
- Text annotations can be placed, edited (with undo/redo), deleted, persisted in `.ssproj`, and appear in the exported viewer (HTML, package, streaming).
- Annotations with a URL show a working "Open link" in the exported viewer; the new-tab toggle behaves; a same-viewer `?content=` link swaps content; exports with no URLs contain no injected companion.
- Marker gizmos appear only in the editor, never in exported artifacts.
```
