# Distance-style Annotation Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework annotation authoring to mirror the Distance (measure) tool — a bottom-toolbar button, a floating editor bar, click-to-place/select, a `TranslateGizmo` for moving, numbered on-screen markers, and an exported-viewer hover preview — while keeping the annotation data model, persistence, and export untouched.

**Architecture:** Split into (1) a persistent, tool-independent overlay (`src/annotation-overlay.ts`, replacing the 3D-jack `src/annotation-gizmos.ts`) that draws numbered SVG markers and a hover preview whenever overlays are on, and (2) a rewritten active-only tool (`src/tools/annotation-tool.ts`, modeled on `src/tools/measure-tool.ts`) that owns placement, selection, the move gizmo, the floating editor bar, and delete. The right-side panel and right-toolbar button are removed.

**Tech Stack:** TypeScript, PlayCanvas (`TranslateGizmo`, `Entity`, `Vec3`), `@playcanvas/pcui` (`Container`, `Label`, `TextInput`, `BooleanInput`), SCSS, i18next, Rollup, ESLint.

**Testing reality:** This repo has **no unit-test framework** (verified: only `npm run lint` + `npm run build` + manual browser checks, per the spec's "Testing / verification posture"). Each task therefore verifies with `npm run lint`, `npm run build`, and explicit manual steps, then commits — instead of TDD red/green.

**Reference design:** `docs/superpowers/specs/2026-06-04-annotations-distance-style-tool-design.md`

---

## File Structure

- **Create** `src/annotation-overlay.ts` — persistent numbered-marker SVG overlay + hover preview tooltip.
- **Create** `src/ui/scss/annotation-overlay.scss` — marker dot/badge styles + `.pc-annotation`-style preview.
- **Rewrite** `src/tools/annotation-tool.ts` — active-only tool (bar + click + gizmo + delete).
- **Modify** `src/ui/bottom-toolbar.ts` — add the Annotations tool button next to Measure.
- **Modify** `src/scene.ts` — drop `AnnotationGizmos`.
- **Modify** `src/main.ts` — construct `AnnotationOverlay`.
- **Modify** `src/editor.ts` — extend the delete guard to the `annotation` tool.
- **Modify** `src/ui/scss/style.scss` — swap SCSS `@use`s.
- **Modify** `src/ui/right-toolbar.ts`, `src/ui/editor.ts`, `src/ui/color-panel.ts`, `src/ui/view-panel.ts` — remove panel/right-toolbar wiring.
- **Delete** `src/ui/annotations-panel.ts`, `src/ui/scss/annotations-panel.scss`, `src/annotation-gizmos.ts`.
- **Modify** `static/locales/*.json` — drop panel-only keys, add the bottom-toolbar tooltip key.

---

## Task 1: Remove the right-side panel, right-toolbar button, and mutual-exclusion wiring

After this task the annotation tool is temporarily unreachable from the UI (the bottom-toolbar button arrives in Task 3) but the app builds and runs.

**Files:**
- Delete: `src/ui/annotations-panel.ts`
- Delete: `src/ui/scss/annotations-panel.scss`
- Modify: `src/ui/scss/style.scss` (remove the `@use` line)
- Modify: `src/ui/editor.ts` (remove import, construction, append)
- Modify: `src/ui/right-toolbar.ts` (remove button + wiring)
- Modify: `src/ui/color-panel.ts:438-442` (remove listener)
- Modify: `src/ui/view-panel.ts:385-389` (remove listener)

- [ ] **Step 1: Delete the panel file and its SCSS**

```bash
git rm src/ui/annotations-panel.ts src/ui/scss/annotations-panel.scss
```

- [ ] **Step 2: Remove the SCSS `@use` for the deleted partial**

In `src/ui/scss/style.scss`, delete this line (added earlier; it sits right after the color-panel use):

```scss
@use 'annotations-panel.scss';
```

- [ ] **Step 3: Remove the panel from the UI editor**

In `src/ui/editor.ts`:
- Delete the import at the top:
```ts
import { AnnotationsPanel } from './annotations-panel';
```
- Delete the construction line (currently `src/ui/editor.ts:127`):
```ts
        const annotationsPanel = new AnnotationsPanel(events);
```
- Delete the append line (currently `src/ui/editor.ts:140`):
```ts
        canvasContainer.append(annotationsPanel);
```

- [ ] **Step 4: Remove the right-toolbar Annotations button and its wiring**

In `src/ui/right-toolbar.ts`, delete each of these:
- The import (line 6):
```ts
import annotationsSvg from './svg/annotations.svg';
```
- The button declaration (lines 70-73):
```ts
        const annotations = new Button({
            id: 'right-toolbar-annotations',
            class: 'right-toolbar-toggle'
        });
```
- The SVG append (line 93):
```ts
        annotations.dom.appendChild(createSvg(annotationsSvg));
```
- The toolbar append (line 105):
```ts
        this.append(annotations);
```
- The tooltip registration (line 128):
```ts
        tooltips.register(annotations, tooltip('tooltip.right-toolbar.annotations'), 'left');
```
- The click handler (line 143):
```ts
        annotations.on('click', () => events.fire('annotationsPanel.toggleVisible'));
```
- The active-state listener (lines 165-167):
```ts
        events.on('annotationsPanel.visible', (visible: boolean) => {
            annotations.class[visible ? 'add' : 'remove']('active');
        });
```

- [ ] **Step 5: Remove the mutual-exclusion listeners in color-panel and view-panel**

In `src/ui/color-panel.ts`, delete (lines 438-442):
```ts
        events.on('annotationsPanel.visible', (visible: boolean) => {
            if (visible) {
                setVisible(false);
            }
        });
```

In `src/ui/view-panel.ts`, delete (lines 385-389):
```ts
        events.on('annotationsPanel.visible', (visible: boolean) => {
            if (visible) {
                setVisible(false);
            }
        });
```

- [ ] **Step 6: Verify lint and build**

Run: `npm run lint`
Expected: PASS (no errors). If lint flags an unused `annotationsSvg`/`AnnotationsPanel` import, it means a deletion in Steps 3-4 was missed — remove it.

Run: `npm run build`
Expected: `created dist` with no TypeScript errors.

- [ ] **Step 7: Manual check**

Launch `npm run develop`, open the editor. Expected: no Annotations button in the right toolbar; Color and View panels still open/close normally; no console errors.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(annotations): remove right-side panel and right-toolbar button"
```

---

## Task 2: Replace the 3D jack marker with a numbered SVG overlay

Adds the persistent overlay drawing numbered dots for every annotation (selected one highlighted). Hover preview comes in Task 5.

**Files:**
- Create: `src/annotation-overlay.ts`
- Create: `src/ui/scss/annotation-overlay.scss`
- Modify: `src/ui/scss/style.scss` (add `@use`)
- Modify: `src/scene.ts` (remove `AnnotationGizmos`)
- Modify: `src/main.ts` (construct `AnnotationOverlay`)
- Delete: `src/annotation-gizmos.ts`

- [ ] **Step 1: Create the overlay component (markers only)**

Create `src/annotation-overlay.ts`:

```ts
import { Container } from '@playcanvas/pcui';
import { Vec3 } from 'playcanvas';

import type { AnnotationData } from './annotations';
import { Events } from './events';
import { Scene } from './scene';

const p = new Vec3();

// Persistent, tool-independent overlay. Draws a numbered on-screen marker for
// every annotation whenever scene overlays are visible, regardless of which tool
// is active. Replaces the old 3D "jack" marker (annotation-gizmos.ts).
//
// Known limitation (matches the Distance tool): markers for points behind the
// camera can project to mirrored positions, because camera.worldToScreen does
// not expose clip-w for a reliable cull.
class AnnotationOverlay {
    constructor(events: Events, scene: Scene, canvasContainer: Container) {
        const parent = canvasContainer.dom;

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.id = 'annotation-overlay-svg';
        svg.classList.add('annotation-overlay-svg');
        parent.appendChild(svg);
        const ns = svg.namespaceURI;

        // per-annotation marker pool: a dot + its number badge
        const markers: { circle: SVGCircleElement, label: SVGTextElement }[] = [];

        const ensurePool = (n: number) => {
            while (markers.length < n) {
                const circle = document.createElementNS(ns, 'circle') as SVGCircleElement;
                circle.classList.add('annotation-marker-dot');
                const label = document.createElementNS(ns, 'text') as SVGTextElement;
                label.classList.add('annotation-marker-label');
                svg.appendChild(circle);
                svg.appendChild(label);
                markers.push({ circle, label });
            }
            while (markers.length > n) {
                const m = markers.pop();
                m.circle.remove();
                m.label.remove();
            }
        };

        // project a world position to pixel coords within the canvas
        const project = (pos: [number, number, number], out: Vec3) => {
            p.set(pos[0], pos[1], pos[2]);
            scene.camera.worldToScreen(p, out);
            out.x *= parent.clientWidth;
            out.y *= parent.clientHeight;
        };

        const draw = () => {
            const showing = scene.camera.renderOverlays;
            const annotations = showing ? (events.invoke('annotations.list') as AnnotationData[]) : [];
            const selectedId = events.invoke('annotations.selected') as string | null;

            ensurePool(annotations.length);

            annotations.forEach((a, i) => {
                const { circle, label } = markers[i];
                project(a.position, p);
                circle.setAttribute('cx', `${p.x}`);
                circle.setAttribute('cy', `${p.y}`);
                circle.classList.toggle('selected', a.id === selectedId);
                // number badge at the upper-left of the dot
                label.setAttribute('x', `${p.x - 8}`);
                label.setAttribute('y', `${p.y - 8}`);
                label.textContent = `${i + 1}`;
            });
        };

        events.on('postrender', draw);

        const markDirty = () => {
            scene.forceRender = true;
        };
        events.on('annotations.changed', markDirty);
        events.on('annotations.selectionChanged', markDirty);
    }
}

export { AnnotationOverlay };
```

- [ ] **Step 2: Create the overlay SCSS (marker styles)**

Create `src/ui/scss/annotation-overlay.scss`:

```scss
@use 'colors.scss' as *;

.annotation-overlay-svg {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    overflow: visible;

    .annotation-marker-dot {
        fill: white;
        stroke: black;
        stroke-width: 2;
        r: 5;

        &.selected {
            fill: #ffd700;
        }
    }

    .annotation-marker-label {
        fill: white;
        stroke: black;
        stroke-width: 0.5px;
        paint-order: stroke;
        font-size: 11px;
        font-weight: bold;
        text-anchor: end;
        dominant-baseline: text-after-edge;
        user-select: none;
    }
}
```

- [ ] **Step 3: Register the SCSS partial**

In `src/ui/scss/style.scss`, add after `@use 'color-panel.scss';`:

```scss
@use 'annotation-overlay.scss';
```

- [ ] **Step 4: Remove the old 3D marker from the scene**

In `src/scene.ts`:
- Delete the import (line 16):
```ts
import { AnnotationGizmos } from './annotation-gizmos';
```
- Delete the field declaration (line 98):
```ts
    annotationGizmos: AnnotationGizmos;
```
- Delete the construction + add (lines 228-229):
```ts
        this.annotationGizmos = new AnnotationGizmos();
        this.add(this.annotationGizmos);
```

- [ ] **Step 5: Delete the old marker file**

```bash
git rm src/annotation-gizmos.ts
```

- [ ] **Step 6: Construct the overlay in main**

In `src/main.ts`:
- Add an import near the other top-level imports (e.g. after the `registerAnnotationsEvents` import on line 4):
```ts
import { AnnotationOverlay } from './annotation-overlay';
```
- Immediately after the annotation tool is registered (currently `src/main.ts:247`):
```ts
    toolManager.register('annotation', new AnnotationTool(events, scene, editorUI.canvasContainer));
```
add:
```ts
    /* eslint-disable no-new */
    new AnnotationOverlay(events, scene, editorUI.canvasContainer);
    /* eslint-enable no-new */
```

(The overlay wires itself through `events`; no reference needs to be retained. The `no-new` guard avoids an ESLint complaint about a constructor call used for side effects — remove the guards if the repo's ESLint config does not enable that rule.)

- [ ] **Step 7: Verify lint and build**

Run: `npm run lint`
Expected: PASS.

Run: `npm run build`
Expected: `created dist`, no TypeScript errors (note: `scene.ts` no longer references `AnnotationGizmos`; `main.ts` references `AnnotationOverlay`).

- [ ] **Step 8: Manual check**

`npm run develop`. There is currently no way to place an annotation (button arrives in Task 3), so to verify the overlay, temporarily load a project that already contains annotations (e.g. a `.ssproj` saved before this branch), OR defer this manual check to after Task 3. Expected once annotations exist: each shows a white dot with a black outline and a number badge (1, 2, …) at its upper-left; dots track the camera as you orbit; toggling the show/hide-splats overlay hides/shows the dots.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(annotations): numbered SVG marker overlay (replaces 3D jack)"
```

---

## Task 3: Add the Annotations button to the bottom toolbar

**Files:**
- Modify: `src/ui/bottom-toolbar.ts`
- Modify: `static/locales/*.json` (add `tooltip.bottom-toolbar.annotations`)

- [ ] **Step 1: Import the annotation icon**

In `src/ui/bottom-toolbar.ts`, add to the icon imports (the SVGs are imported at the top, e.g. after `import boxSvg from './svg/show-hide-splats.svg';` on line 14):

```ts
import annotationsSvg from './svg/annotations.svg';
```

- [ ] **Step 2: Create the button**

In `src/ui/bottom-toolbar.ts`, after the `measure` button declaration (lines 112-116):

```ts
        const measure = new Button({
            id: 'bottom-toolbar-measure',
            class: 'bottom-toolbar-tool',
            icon: 'E358'
        });
```

add:

```ts
        const annotation = new Button({
            id: 'bottom-toolbar-annotation',
            class: 'bottom-toolbar-tool'
        });
```

- [ ] **Step 3: Attach the SVG icon**

In `src/ui/bottom-toolbar.ts`, after `eyedropper.dom.appendChild(createSvg(eyedropperSvg));` (line 139):

```ts
        annotation.dom.appendChild(createSvg(annotationsSvg));
```

- [ ] **Step 4: Append the button to the toolbar**

In `src/ui/bottom-toolbar.ts`, change the measure append (line 160) so the annotation button follows it:

```ts
        this.append(measure);
        this.append(annotation);
        this.append(coordSpace);
        this.append(origin);
```

(Replace the existing `this.append(measure);` / `this.append(coordSpace);` / `this.append(origin);` block at lines 160-162 with the four lines above.)

- [ ] **Step 5: Wire the click to activate the tool**

In `src/ui/bottom-toolbar.ts`, after `measure.dom.addEventListener('click', () => events.fire('tool.measure'));` (line 177):

```ts
        annotation.dom.addEventListener('click', () => events.fire('tool.annotation'));
```

- [ ] **Step 6: Add the active-state highlight**

In `src/ui/bottom-toolbar.ts`, inside the `events.on('tool.activated', ...)` handler (lines 188-201), after the `measure.class[...]` line (line 199):

```ts
            annotation.class[toolName === 'annotation' ? 'add' : 'remove']('active');
```

- [ ] **Step 7: Register the tooltip**

In `src/ui/bottom-toolbar.ts`, after `tooltips.register(measure, tooltip('tooltip.bottom-toolbar.measure'));` (line 237):

```ts
        tooltips.register(annotation, tooltip('tooltip.bottom-toolbar.annotations'));
```

- [ ] **Step 8: Add the locale string**

In each `static/locales/*.json`, add a `tooltip.bottom-toolbar.annotations` entry next to `tooltip.bottom-toolbar.measure`. Use the value already present for that file's `tooltip.right-toolbar.annotations` key (it is the word "Annotations" already translated per language). For `static/locales/en.json`:

```json
    "tooltip.bottom-toolbar.annotations": "Annotations",
```

Apply the same key in `de.json`, `es.json`, `fr.json`, `ja.json`, `ko.json`, `pt-BR.json`, `ru.json`, `zh-CN.json`, copying that file's existing `tooltip.right-toolbar.annotations` value.

- [ ] **Step 9: Verify lint and build**

Run: `npm run lint`
Expected: PASS.

Run: `npm run build`
Expected: `created dist`, no errors.

- [ ] **Step 10: Manual check**

`npm run develop`. Expected: an Annotations button appears in the bottom toolbar just right of the Measure button; clicking it shows the active highlight (and fires `tool.annotation`). Placement/editing is wired in Task 4; for now clicking the splat may still use the *old* `annotation-tool.ts` behavior — that's expected until Task 4 replaces it.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(annotations): add bottom-toolbar annotation tool button"
```

---

## Task 4: Rewrite the annotation tool (floating bar + click select/place + move gizmo + delete)

**Files:**
- Rewrite: `src/tools/annotation-tool.ts`
- Modify: `src/editor.ts:534-538` (delete guard)
- Modify: `src/ui/scss/style.scss` is unchanged here; bar styling reuses the existing `.select-toolbar` class plus a new `annotations-toolbar` modifier added to `src/ui/scss/annotation-overlay.scss`.
- Modify: `src/ui/scss/annotation-overlay.scss` (append bar layout rules)
- Modify: `static/locales/*.json` (remove panel-only keys)

- [ ] **Step 1: Rewrite the tool**

Replace the entire contents of `src/tools/annotation-tool.ts` with:

```ts
import { BooleanInput, Container, Label, TextInput } from '@playcanvas/pcui';
import { Entity, TranslateGizmo, Vec3 } from 'playcanvas';

import { AddAnnotationOp, AnnotationData, RemoveAnnotationOp, UpdateAnnotationOp } from '../annotations';
import { Events } from '../events';
import { Scene } from '../scene';
import { localize } from '../ui/localization';

const p = new Vec3();
const screen = new Vec3();

class AnnotationTool {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, scene: Scene, canvasContainer: Container) {
        let active = false;

        // --- floating editor bar (shown only while active + something selected) ---

        const bar = new Container({
            class: ['select-toolbar', 'annotations-toolbar'],
            hidden: true
        });
        bar.dom.addEventListener('pointerdown', e => e.stopPropagation());

        const titleLabel = new Label({ text: localize('panel.annotations.title') });
        const titleInput = new TextInput({ class: 'annotations-toolbar-input' });
        const textLabel = new Label({ text: localize('panel.annotations.text') });
        const textInput = new TextInput({ class: 'annotations-toolbar-input' });
        const urlLabel = new Label({ text: localize('panel.annotations.url') });
        const urlInput = new TextInput({ class: 'annotations-toolbar-input', placeholder: 'https://' });
        const newTabLabel = new Label({ text: localize('panel.annotations.new-tab') });
        const newTabInput = new BooleanInput({ type: 'toggle' });

        bar.append(titleLabel);
        bar.append(titleInput);
        bar.append(textLabel);
        bar.append(textInput);
        bar.append(urlLabel);
        bar.append(urlInput);
        bar.append(newTabLabel);
        bar.append(newTabInput);
        canvasContainer.append(bar);

        // --- selection helpers ---

        const selected = (): AnnotationData | null => {
            const id = events.invoke('annotations.selected') as string | null;
            return id ? (events.invoke('annotations.byId', id) as AnnotationData) : null;
        };

        let suppress = false;
        const refreshBar = () => {
            const a = selected();
            bar.hidden = !active || !a;
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

        const commit = (field: keyof AnnotationData, value: string | boolean) => {
            if (suppress) {
                return;
            }
            const a = selected();
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

        // --- move gizmo ---

        const gizmo = new TranslateGizmo(scene.camera.camera, scene.gizmoLayer);
        const pivot = new Entity('annotationGizmoPivot');
        const dragStart = new Vec3();

        const updateGizmo = () => {
            gizmo.detach();
            const a = active ? selected() : null;
            if (a) {
                pivot.setLocalPosition(a.position[0], a.position[1], a.position[2]);
                gizmo.attach(pivot);
            }
        };

        gizmo.on('render:update', () => {
            scene.forceRender = true;
        });
        gizmo.on('transform:start', () => {
            dragStart.copy(pivot.getLocalPosition());
        });
        gizmo.on('transform:move', () => {
            const a = selected();
            if (a) {
                const pos = pivot.getLocalPosition();
                // Mutate live so the overlay marker tracks the drag. The overlay
                // re-reads positions every postrender, so do NOT fire
                // 'annotations.changed' here — that would re-run updateGizmo and
                // detach/reattach the gizmo mid-drag.
                a.position = [pos.x, pos.y, pos.z];
            }
            scene.forceRender = true;
        });
        gizmo.on('transform:end', () => {
            const a = selected();
            if (a) {
                const pos = pivot.getLocalPosition();
                // restore the pre-drag value, then commit the move as one undoable op
                a.position = [dragStart.x, dragStart.y, dragStart.z];
                events.fire('edit.add', new UpdateAnnotationOp(
                    events,
                    a.id,
                    { position: [dragStart.x, dragStart.y, dragStart.z] },
                    { position: [pos.x, pos.y, pos.z] }
                ));
            }
        });

        const updateGizmoSize = () => {
            const { camera, canvas } = scene;
            if (camera.ortho) {
                gizmo.size = 1125 / canvas.clientHeight;
            } else {
                gizmo.size = 1200 / Math.max(canvas.clientWidth, canvas.clientHeight);
            }
        };
        updateGizmoSize();
        events.on('camera.resize', updateGizmoSize);
        events.on('camera.ortho', updateGizmoSize);

        // --- click to select existing / place new ---

        const isPrimary = (e: PointerEvent) => {
            return e.pointerType === 'mouse' ? e.button === 0 : e.isPrimary;
        };

        const markerAt = (offsetX: number, offsetY: number): AnnotationData | null => {
            const annotations = events.invoke('annotations.list') as AnnotationData[];
            for (let i = 0; i < annotations.length; i++) {
                const a = annotations[i];
                p.set(a.position[0], a.position[1], a.position[2]);
                scene.camera.worldToScreen(p, screen);
                screen.x *= canvasContainer.dom.clientWidth;
                screen.y *= canvasContainer.dom.clientHeight;
                if (Math.abs(screen.x - offsetX) < 8 && Math.abs(screen.y - offsetY) < 8) {
                    return a;
                }
            }
            return null;
        };

        let clicked = false;
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

            // 1) click near an existing marker -> select it
            const hit = markerAt(e.offsetX, e.offsetY);
            if (hit) {
                events.fire('annotations.select', hit.id);
                e.preventDefault();
                e.stopPropagation();
                return;
            }

            // 2) otherwise raycast the splat -> place a new annotation
            const nx = e.offsetX / canvasContainer.dom.clientWidth;
            const ny = e.offsetY / canvasContainer.dom.clientHeight;
            const result = await scene.camera.intersect(nx, ny);
            if (!result || !active) {
                return;
            }
            const pose = events.invoke('camera.getPose');
            const data: AnnotationData = {
                id: events.invoke('annotations.newId') as string,
                position: [result.position.x, result.position.y, result.position.z],
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
            e.preventDefault();
            e.stopPropagation();
        };

        // --- delete selected annotation via Delete/Backspace ---

        events.on('select.delete', () => {
            if (!active) {
                return;
            }
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

        // --- keep bar + gizmo in sync with selection/data ---

        events.on('annotations.changed', () => {
            refreshBar();
            updateGizmo();
        });
        events.on('annotations.selectionChanged', () => {
            refreshBar();
            updateGizmo();
        });

        this.activate = () => {
            active = true;
            canvasContainer.dom.addEventListener('pointerdown', pointerdown);
            canvasContainer.dom.addEventListener('pointermove', pointermove);
            canvasContainer.dom.addEventListener('pointerup', pointerup, true);
            refreshBar();
            updateGizmo();
        };

        this.deactivate = () => {
            active = false;
            canvasContainer.dom.removeEventListener('pointerdown', pointerdown);
            canvasContainer.dom.removeEventListener('pointermove', pointermove);
            canvasContainer.dom.removeEventListener('pointerup', pointerup, true);
            bar.hidden = true;
            gizmo.detach();
        };
    }
}

export { AnnotationTool };
```

(The `transform:move` handler writes the live position and fires `annotations.changed` so the overlay marker tracks the drag; `transform:end` rewinds and commits a single undoable `UpdateAnnotationOp`. `main.ts` already constructs the tool as `new AnnotationTool(events, scene, editorUI.canvasContainer)` — no registration change needed.)

- [ ] **Step 2: Extend the splat-delete guard**

In `src/editor.ts`, change the guard at lines 535-538 from:

```ts
        // Don't delete gaussians when measure tool is active (backspace deletes measure points instead)
        if (events.invoke('tool.active') === 'measure') {
            return;
        }
```

to:

```ts
        // Don't delete gaussians when the measure or annotation tool is active
        // (Delete/Backspace removes the active measure point / annotation instead)
        const activeTool = events.invoke('tool.active');
        if (activeTool === 'measure' || activeTool === 'annotation') {
            return;
        }
```

- [ ] **Step 3: Add the floating-bar layout styles**

Append to `src/ui/scss/annotation-overlay.scss`:

```scss
.annotations-toolbar {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 6px;

    &.pcui-hidden {
        display: none;
    }

    .annotations-toolbar-input {
        width: 160px;
    }
}
```

(The base `.select-toolbar` class already positions the bar centered above the bottom toolbar; this only sets the row layout and input width. Verify the centered placement visually in Step 6 — if the bar is not positioned, inspect `src/ui/scss/select-toolbar.scss` and mirror its positioning under `.annotations-toolbar`.)

- [ ] **Step 4: Remove panel-only locale keys**

In each `static/locales/*.json`, delete these keys (they were only used by the removed panel):

```json
    "panel.annotations": "...",
    "panel.annotations.add": "...",
    "panel.annotations.recapture": "...",
    "panel.annotations.delete": "...",
    "panel.annotations.untitled": "...",
    "tooltip.right-toolbar.annotations": "...",
```

Keep `panel.annotations.title`, `panel.annotations.text`, `panel.annotations.url`, and `panel.annotations.new-tab` — the floating bar reuses them. (In `en.json` these are lines 60-68 and 268; remove the six keys listed, leave the four field-label keys.)

- [ ] **Step 5: Verify lint and build**

Run: `npm run lint`
Expected: PASS.

Run: `npm run build`
Expected: `created dist`, no errors. (If the build complains about an unused `localize` import or similar, reconcile imports.)

- [ ] **Step 6: Manual check**

`npm run develop`:
1. Click the bottom-toolbar Annotations button → active highlight.
2. Click on the splat → a numbered marker appears and the floating bar shows above the bottom toolbar with Title/Text/URL/New-tab.
3. Type a title/text/URL → values stick; `Ctrl+Z` undoes the last field edit.
4. Click near the marker → it becomes selected (highlighted) and a TranslateGizmo appears; drag an axis → the marker moves; `Ctrl+Z` reverts the move as one step.
5. Press `Delete` → the selected annotation is removed; confirm no splats were deleted.
6. Place a second annotation → badge reads `2`; clicking near each selects the right one.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(annotations): Distance-style placement, move gizmo, and floating editor bar"
```

---

## Task 5: Add the exported-viewer hover preview

Extends the overlay so hovering a non-selected marker shows a tooltip styled like the exported viewer's `.pc-annotation` hotspot.

**Files:**
- Modify: `src/annotation-overlay.ts`
- Modify: `src/ui/scss/annotation-overlay.scss`

- [ ] **Step 1: Add the preview tooltip DOM + hover logic**

In `src/annotation-overlay.ts`, inside the constructor, after the `svg` is appended to `parent` and before the `markers` pool declaration, add the tooltip element:

```ts
        // HTML preview tooltip mirroring the exported viewer's .pc-annotation look
        const preview = document.createElement('div');
        preview.classList.add('annotation-preview', 'hidden');
        const previewTitle = document.createElement('div');
        previewTitle.classList.add('annotation-preview-title');
        const previewText = document.createElement('div');
        previewText.classList.add('annotation-preview-text');
        const previewLink = document.createElement('a');
        previewLink.classList.add('annotation-preview-link');
        previewLink.textContent = 'Open link ↗';
        preview.appendChild(previewTitle);
        preview.appendChild(previewText);
        preview.appendChild(previewLink);
        parent.appendChild(preview);
```

Then, after the `events.on('annotations.selectionChanged', markDirty);` line at the end of the constructor, add the hover handler:

```ts
        // hover preview — skip the selected annotation (its move gizmo is active)
        const onPointerMove = (e: PointerEvent) => {
            if (!scene.camera.renderOverlays) {
                preview.classList.add('hidden');
                return;
            }
            const annotations = events.invoke('annotations.list') as AnnotationData[];
            const selectedId = events.invoke('annotations.selected') as string | null;
            let hit: AnnotationData | null = null;
            for (let i = 0; i < annotations.length; i++) {
                const a = annotations[i];
                if (a.id === selectedId) {
                    continue;
                }
                project(a.position, p);
                if (Math.abs(p.x - e.offsetX) < 8 && Math.abs(p.y - e.offsetY) < 8) {
                    hit = a;
                    break;
                }
            }
            if (!hit) {
                preview.classList.add('hidden');
                return;
            }
            previewTitle.textContent = hit.title || '';
            previewTitle.style.display = hit.title ? 'block' : 'none';
            previewText.textContent = hit.text || '';
            previewText.style.display = hit.text ? 'block' : 'none';
            previewLink.style.display = hit.url ? 'inline-block' : 'none';
            project(hit.position, p);
            preview.style.left = `${p.x + 12}px`;
            preview.style.top = `${p.y + 12}px`;
            preview.classList.remove('hidden');
        };
        parent.addEventListener('pointermove', onPointerMove);
```

(`project` and `p` are already defined earlier in the constructor; the handler reuses them.)

- [ ] **Step 2: Add the preview styles (matching the viewer)**

Append to `src/ui/scss/annotation-overlay.scss`:

```scss
.annotation-preview {
    position: absolute;
    pointer-events: none;
    max-width: 260px;
    padding: 8px;
    border-radius: 4px;
    background-color: rgba(0, 0, 0, 0.8);
    color: white;
    font-size: 14px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    z-index: 10;

    &.hidden {
        display: none;
    }

    .annotation-preview-title {
        font-weight: bold;
        margin-bottom: 4px;
    }

    .annotation-preview-link {
        display: inline-block;
        margin-top: 8px;
        padding: 4px 8px;
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.15);
        color: #fff;
        text-decoration: none;
        font-size: 13px;
    }
}
```

- [ ] **Step 3: Verify lint and build**

Run: `npm run lint`
Expected: PASS.

Run: `npm run build`
Expected: `created dist`, no errors.

- [ ] **Step 4: Manual check**

`npm run develop`:
1. With the Annotations tool active and at least two annotations placed, hover over a **non-selected** marker → a dark rounded tooltip appears with the bold title, the body text, and (if a URL is set) an "Open link ↗" button — resembling the exported viewer.
2. Hover the **selected** marker → no preview (its gizmo is active).
3. Move the pointer off markers → preview hides.
4. Toggle the show/hide-splats overlay off → no markers and no preview.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(annotations): exported-viewer hover preview on markers"
```

---

## Self-Review

**Spec coverage:**
- Bottom-toolbar button next to Distance → Task 3. ✓
- Floating inline editor bar (Title/Text/URL/New-tab) → Task 4 Step 1/3. ✓
- Click near marker → select; click splat → add → Task 4 Step 1. ✓
- TranslateGizmo move, undoable → Task 4 Step 1. ✓
- Delete via key, guard splats → Task 4 Steps 1-2. ✓
- Numbered SVG markers, selected highlighted, visible whenever overlays on → Task 2. ✓
- Hover preview matching viewer, selected excluded → Task 5. ✓
- Remove right panel/button + mutual-exclusion + 3D jack → Tasks 1-2. ✓
- Data model / persistence / export untouched → no task modifies `annotations.ts`, `doc.ts`, `splat-export-core.ts`, or `annotation-links.ts`. ✓
- i18n: drop panel-only keys, add bottom-toolbar tooltip → Tasks 3-4. ✓

**Placeholder scan:** No TBD/TODO; all code steps contain full code; locale steps name exact keys.

**Type consistency:** `AnnotationData` fields (`id`, `position`, `title`, `text`, `url`, `newTab`, `camera`) and ops (`AddAnnotationOp(events, data)`, `RemoveAnnotationOp(events, data, index)`, `UpdateAnnotationOp(events, id, old, new)`) match `src/annotations.ts`. `annotations.list/selected/byId/newId` and `camera.getPose`/`camera.intersect`/`camera.worldToScreen` match existing usage in `annotation-tool.ts`/`measure-tool.ts`. Tool constructor signature unchanged, so `main.ts:247` stays valid. `AnnotationOverlay(events, scene, canvasContainer)` matches its construction in Task 2 Step 6.

**Known limitation carried from spec:** markers/preview for points behind the camera may project to mirrored positions (same as Distance) — documented in `annotation-overlay.ts` and the spec.
