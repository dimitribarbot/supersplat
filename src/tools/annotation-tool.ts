import { BooleanInput, Button, Container, Label, SelectInput, TextInput } from '@playcanvas/pcui';
import { Entity, TranslateGizmo, Vec3 } from 'playcanvas';

import { AddAnnotationOp, AnnotationCamera, AnnotationData, MoveAnnotationOp, RemoveAnnotationOp, UpdateAnnotationOp } from '../annotations';
import { ElementType } from '../element';
import { Events } from '../events';
import { Scene } from '../scene';
import { Splat } from '../splat';
import { i18n } from '../ui/localization';

const p = new Vec3();
const screen = new Vec3();

// The Scene dropdown is a numeric SelectInput, so "no scene" needs a numeric
// stand-in; -1 can never collide with a splat uid (uids are monotonic from 0).
const NO_SCENE = -1;

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

        const titleLabel = new Label({ text: i18n.t('panel.annotations.title') });
        const titleInput = new TextInput({ class: 'annotations-toolbar-input' });
        const textLabel = new Label({ text: i18n.t('panel.annotations.text') });
        const textInput = new TextInput({ class: 'annotations-toolbar-input' });
        const linkTypeLabel = new Label({ text: i18n.t('panel.annotations.link-type') });
        const linkTypeInput = new SelectInput({
            type: 'string',
            width: 130,
            options: [
                { v: 'none', t: i18n.t('panel.annotations.link-type-none') },
                { v: 'url', t: i18n.t('panel.annotations.link-type-url') },
                { v: 'images', t: i18n.t('panel.annotations.link-type-images') }
            ]
        });
        const urlLabel = new Label({ text: i18n.t('panel.annotations.url') });
        const urlInput = new TextInput({ class: 'annotations-toolbar-input', placeholder: 'https://' });
        const newTabLabel = new Label({ text: i18n.t('panel.annotations.new-tab') });
        const newTabInput = new BooleanInput({ type: 'toggle' });
        const imagesButton = new Button({ class: 'annotations-toolbar-button' });
        const sceneLabel = new Label({ text: i18n.t('panel.annotations.scene') });
        const sceneInput = new SelectInput({ type: 'number', options: [], width: 140 });
        const glyphClass = ['select-toolbar-button', 'annotations-toolbar-glyph'];
        const viewButton = new Button({ text: '⊙', class: glyphClass });
        viewButton.dom.title = i18n.t('panel.annotations.set-view');
        const upButton = new Button({ text: '↑', class: glyphClass });
        upButton.dom.title = i18n.t('panel.annotations.move-earlier');
        const downButton = new Button({ text: '↓', class: glyphClass });
        downButton.dom.title = i18n.t('panel.annotations.move-later');

        bar.append(titleLabel);
        bar.append(titleInput);
        bar.append(textLabel);
        bar.append(textInput);
        bar.append(linkTypeLabel);
        bar.append(linkTypeInput);
        bar.append(urlLabel);
        bar.append(urlInput);
        bar.append(newTabLabel);
        bar.append(newTabInput);
        bar.append(imagesButton);
        bar.append(sceneLabel);
        bar.append(sceneInput);
        bar.append(viewButton);
        bar.append(upButton);
        bar.append(downButton);
        canvasContainer.append(bar);

        // --- selection helpers ---

        const selected = (): AnnotationData | null => {
            const id = events.invoke('annotations.selected') as string | null;
            return id ? (events.invoke('annotations.byId', id) as AnnotationData) : null;
        };

        // Scene options are every loaded splat (not just portal-referenced ones):
        // placement auto-assigns whichever splat was clicked, which may not be
        // wired into a portal yet. Mirrors portal-tool.ts's option construction.
        const splatList = () => scene.getElementsByType(ElementType.splat) as Splat[];
        const splatName = (splat: Splat) => {
            const filename = splat.name ?? (splat.asset.file as any)?.filename ?? `Splat ${splat.uid}`;
            return `${splat.uid}: ${filename}`;
        };
        const refreshSceneOptions = () => {
            sceneInput.options = [
                { v: NO_SCENE, t: i18n.t('panel.annotations.scene-none') },
                ...splatList().map(splat => ({ v: splat.uid, t: splatName(splat) }))
            ];
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
            const linkType = a.linkType ?? 'none';
            linkTypeInput.value = linkType;
            // exactly one action is live at a time: the selector swaps the tail
            // of the bar rather than the two ever being visible together
            urlLabel.hidden = linkType !== 'url';
            urlInput.hidden = linkType !== 'url';
            newTabLabel.hidden = linkType !== 'url';
            newTabInput.hidden = linkType !== 'url';
            imagesButton.hidden = linkType !== 'images';
            imagesButton.text = i18n.t('panel.annotations.images-edit', { count: a.images.length });
            // the scene association is meaningless without portals: no portals
            // means no exported scene indices and so nothing to switch between
            const hasPortals = ((events.invoke('portals.count') as number) ?? 0) > 0;
            sceneLabel.hidden = !hasPortals;
            sceneInput.hidden = !hasPortals;
            if (hasPortals) {
                refreshSceneOptions();
                const options = sceneInput.options as { v: number, t: string }[];
                // a splat deleted since assignment leaves a dangling uid -> show "None"
                sceneInput.value = options.some(o => o.v === a.sceneUid) ? a.sceneUid : NO_SCENE;
            }
            // the ends are dead rather than silently no-op
            const list = events.invoke('annotations.list') as AnnotationData[];
            const index = list.indexOf(a);
            upButton.enabled = index > 0;
            downButton.enabled = index < list.length - 1;
            suppress = false;
        };

        const commit = (field: keyof AnnotationData, value: string | boolean | number | null) => {
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
        linkTypeInput.on('change', (v: string) => commit('linkType', v));
        urlInput.on('change', (v: string) => commit('url', v));
        newTabInput.on('change', (v: boolean) => commit('newTab', v));
        imagesButton.on('click', () => {
            const a = selected();
            if (a) {
                events.fire('annotation.images.edit', a.id);
            }
        });
        sceneInput.on('change', (v: number) => commit('sceneUid', v === NO_SCENE ? null : v));

        // The stored pose is a plain object, so the generic commit() helper's
        // `a[field] === value` test can never be true for it -- comparing
        // component-wise here is what keeps a repeated click from pushing an
        // empty entry onto the undo stack.
        const samePose = (c: AnnotationCamera, pose: { position: { x: number, y: number, z: number }, target: { x: number, y: number, z: number }, fov: number }) => {
            return c.position[0] === pose.position.x &&
                   c.position[1] === pose.position.y &&
                   c.position[2] === pose.position.z &&
                   c.target[0] === pose.target.x &&
                   c.target[1] === pose.target.y &&
                   c.target[2] === pose.target.z &&
                   c.fov === pose.fov;
        };

        // pointerdown + stopPropagation (as in portal-tool.ts) so a press on the
        // bar never falls through to the canvas and places a new annotation
        viewButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            const a = selected();
            if (!active || !a) {
                return;
            }
            const pose = events.invoke('camera.getPose');
            if (!pose || samePose(a.camera, pose)) {
                return;
            }
            events.fire('edit.add', new UpdateAnnotationOp(
                events,
                a.id,
                { camera: {
                    position: [a.camera.position[0], a.camera.position[1], a.camera.position[2]],
                    target: [a.camera.target[0], a.camera.target[1], a.camera.target[2]],
                    fov: a.camera.fov
                } },
                { camera: {
                    position: [pose.position.x, pose.position.y, pose.position.z],
                    target: [pose.target.x, pose.target.y, pose.target.z],
                    fov: pose.fov
                } }
            ));
        });

        // A disabled PCUI button can still receive a raw dom pointerdown, so the
        // bounds check here is the real guard, not the enabled flag.
        const move = (delta: number) => {
            const a = selected();
            if (!active || !a) {
                return;
            }
            const list = events.invoke('annotations.list') as AnnotationData[];
            const index = list.indexOf(a);
            const to = index + delta;
            if (index < 0 || to < 0 || to >= list.length) {
                return;
            }
            events.fire('edit.add', new MoveAnnotationOp(events, a.id, index, to));
        };

        upButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            move(-1);
        });

        downButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            move(1);
        });

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
                // skip annotations behind the camera (mirrored projection)
                if (!scene.camera.worldToScreen(p, screen)) {
                    continue;
                }
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
                linkType: 'none',
                images: [],
                // the splat under the cursor is the scene this annotation belongs to
                sceneUid: result.splat?.uid ?? null,
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
        // adding or removing the project's first/last portal shows or hides the
        // Scene row while the annotation tool is active
        events.on('portals.changed', () => {
            refreshBar();
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
