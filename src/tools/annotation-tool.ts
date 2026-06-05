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
                // ignore a grab-and-release with no movement (avoids an empty undo entry)
                if (pos.x === dragStart.x && pos.y === dragStart.y && pos.z === dragStart.z) {
                    return;
                }
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
            // drop the selection when leaving annotation mode so no marker stays highlighted
            events.fire('annotations.select', null);
            bar.hidden = true;
            gizmo.detach();
        };
    }
}

export { AnnotationTool };
