import { Button, Container, Label, NumericInput, SelectInput } from '@playcanvas/pcui';
import { Entity, Quat, RotateGizmo, TranslateGizmo, Vec3 } from 'playcanvas';

import { ElementType } from '../element';
import { Events } from '../events';
import { PortalShape } from '../portal-shape';
import { AddPortalOp, RemovePortalOp, SetStartSplatOp, UpdatePortalEntrypointOp, UpdatePortalOp, PortalData } from '../portals';
import { Scene } from '../scene';
import { Splat } from '../splat';
import { localize } from '../ui/localization';

// temps for projecting a portal's quad corners to screen (click-to-select)
const qrot = new Quat();
const lc = new Vec3();
const wc = [new Vec3(), new Vec3(), new Vec3(), new Vec3()];
const sc = [new Vec3(), new Vec3(), new Vec3(), new Vec3()];
const LOCAL_CORNERS = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];

// 2D point-in-triangle (sign test); orientation-agnostic.
const edgeSign = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
    return (px - bx) * (ay - by) - (ax - bx) * (py - by);
};
const pointInTri = (px: number, py: number, a: Vec3, b: Vec3, c: Vec3) => {
    const d1 = edgeSign(px, py, a.x, a.y, b.x, b.y);
    const d2 = edgeSign(px, py, b.x, b.y, c.x, c.y);
    const d3 = edgeSign(px, py, c.x, c.y, a.x, a.y);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
};

class PortalTool {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, scene: Scene, canvasContainer: Container) {
        let active = false;
        let selectedEntryUid: number | null = null;
        let entryGizmoArmed = false;
        // Below this camera→entrypoint distance the gizmo would attach coincident
        // with the camera (degenerate, never recovers), so the attach is deferred.
        const ENTRY_GIZMO_MIN_DIST = 0.5;

        // per-portal plane meshes, keyed by portal id
        const shapes = new Map<string, PortalShape>();

        // --- floating editor bar ---
        const bar = new Container({ class: ['select-toolbar', 'annotations-toolbar'], hidden: true });
        bar.dom.addEventListener('pointerdown', e => e.stopPropagation());

        const addButton = new Button({ text: localize('portals.add'), class: 'select-toolbar-button' });
        const moveButton = new Button({ text: localize('portals.move'), class: 'select-toolbar-button' });
        const rotateButton = new Button({ text: localize('portals.rotate'), class: 'select-toolbar-button' });
        const widthLabel = new Label({ text: localize('portals.width') });
        const widthInput = new NumericInput({ precision: 2, value: 2, width: 80, min: 0.01 });
        const heightLabel = new Label({ text: localize('portals.height') });
        const heightInput = new NumericInput({ precision: 2, value: 2, width: 80, min: 0.01 });
        const frontLabel = new Label({ text: localize('portals.front') });
        const frontInput = new SelectInput({ type: 'number', options: [], width: 140 });
        const backLabel = new Label({ text: localize('portals.back') });
        const backInput = new SelectInput({ type: 'number', options: [], width: 140 });
        const startLabel = new Label({ text: localize('portals.start') });
        const startInput = new SelectInput({ type: 'number', options: [], width: 140 });

        const entryLabel = new Label({ text: localize('portals.entrypoint') });
        const entrySceneInput = new SelectInput({ type: 'number', options: [], width: 140 });
        const entrySetButton = new Button({ text: localize('portals.entrypoint.set'), class: 'select-toolbar-button' });
        const entryClearButton = new Button({ text: localize('portals.entrypoint.clear'), class: 'select-toolbar-button' });

        const group = (...els: any[]) => {
            const c = new Container({ class: 'select-toolbar-group' });
            els.forEach(el => c.append(el));
            return c;
        };
        bar.append(addButton);
        bar.append(moveButton);
        bar.append(rotateButton);
        bar.append(group(widthLabel, widthInput));
        bar.append(group(heightLabel, heightInput));
        bar.append(group(frontLabel, frontInput));
        bar.append(group(backLabel, backInput));
        bar.append(group(startLabel, startInput));
        bar.append(group(entryLabel, entrySceneInput, entrySetButton, entryClearButton));
        canvasContainer.append(bar);

        // --- selection helpers ---
        const selected = (): PortalData | null => {
            const id = events.invoke('portals.selected') as string | null;
            return id ? (events.invoke('portals.byId', id) as PortalData) : null;
        };

        // --- scene dropdown helpers (mirrors alignment-panel.ts:111-133) ---
        const splatList = () => scene.getElementsByType(ElementType.splat) as Splat[];
        const splatName = (splat: Splat) => {
            const filename = (splat.asset.file as any)?.filename ?? splat.name ?? `Splat ${splat.uid}`;
            return `${splat.uid}: ${filename}`;
        };
        const refreshSceneOptions = () => {
            const options = splatList().map(splat => ({ v: splat.uid, t: splatName(splat) }));
            frontInput.options = options;
            backInput.options = options;
            startInput.options = options;

            // entrypoint dropdown lists only scenes referenced by a portal (the ones exported)
            const referenced = new Set<number>();
            (events.invoke('portals.list') as PortalData[]).forEach((p) => {
                if (p.frontUid !== null) referenced.add(p.frontUid);
                if (p.backUid !== null) referenced.add(p.backUid);
            });
            entrySceneInput.options = splatList()
                .filter(s => referenced.has(s.uid))
                .map(s => ({ v: s.uid, t: splatName(s) }));
        };

        let suppress = false;
        const refreshBar = () => {
            bar.hidden = !active;
            if (!active) {
                return;
            }
            suppress = true;
            const z = selected();
            widthInput.enabled = !!z;
            heightInput.enabled = !!z;
            if (z) {
                widthInput.value = z.width;
                heightInput.value = z.height;
            }
            refreshSceneOptions();
            frontInput.enabled = !!z;
            backInput.enabled = !!z;
            if (z) {
                frontInput.value = z.frontUid;
                backInput.value = z.backUid;
            }
            startInput.value = events.invoke('portals.startSplat') as number | null;
            // entrypoint: reconcile the authoritative selection against current options
            const epOptions = entrySceneInput.options as { v: number, t: string }[];
            if (selectedEntryUid != null && !epOptions.some(o => o.v === selectedEntryUid)) {
                selectedEntryUid = epOptions.length > 0 ? epOptions[0].v : null;
            } else if (selectedEntryUid == null && epOptions.length > 0) {
                selectedEntryUid = epOptions[0].v;
            }
            entrySceneInput.value = selectedEntryUid;
            const hasEp = selectedEntryUid != null && !!events.invoke('portals.entrypoint', selectedEntryUid);
            entryClearButton.enabled = hasEp;
            entrySetButton.enabled = selectedEntryUid != null;
            suppress = false;
            updateEntryGizmo();
        };

        const commitSize = (field: 'width' | 'height', value: number) => {
            if (suppress) {
                return;
            }
            const z = selected();
            if (!z || z[field] === value) {
                return;
            }
            events.fire('edit.add', new UpdatePortalOp(events, z.id, { [field]: z[field] }, { [field]: value }));
        };

        widthInput.on('change', (v: number) => commitSize('width', v));
        heightInput.on('change', (v: number) => commitSize('height', v));

        frontInput.on('change', (v: number) => {
            if (suppress) {
                return;
            }
            const z = selected();
            if (z && z.frontUid !== v) {
                events.fire('edit.add', new UpdatePortalOp(events, z.id, { frontUid: z.frontUid }, { frontUid: v }));
            }
        });
        backInput.on('change', (v: number) => {
            if (suppress) {
                return;
            }
            const z = selected();
            if (z && z.backUid !== v) {
                events.fire('edit.add', new UpdatePortalOp(events, z.id, { backUid: z.backUid }, { backUid: v }));
            }
        });
        startInput.on('change', (v: number) => {
            if (suppress) {
                return;
            }
            const current = events.invoke('portals.startSplat') as number | null;
            if (current !== v) {
                events.fire('edit.add', new SetStartSplatOp(events, current, v));
            }
        });

        entrySceneInput.on('change', () => {
            if (suppress) return;
            selectedEntryUid = entrySceneInput.value as number | null;
            refreshBar();
        });

        entrySetButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            if (!active || selectedEntryUid == null) return;
            const pose = events.invoke('camera.getPose');
            const p = pose?.position;
            if (!p) return;
            const old = events.invoke('portals.entrypoint', selectedEntryUid) as [number, number, number] | null;
            events.fire('edit.add', new UpdatePortalEntrypointOp(events, selectedEntryUid, old, [p.x, p.y, p.z]));
        });

        entryClearButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            if (!active || selectedEntryUid == null) return;
            const old = events.invoke('portals.entrypoint', selectedEntryUid) as [number, number, number] | null;
            if (old) events.fire('edit.add', new UpdatePortalEntrypointOp(events, selectedEntryUid, old, null));
        });

        // --- add a new portal at the current view target ---
        addButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            if (!active) {
                return;
            }
            const pose = events.invoke('camera.getPose');
            const t = pose?.target ?? { x: 0, y: 0, z: 0 };
            const cp = pose?.position ?? { x: 0, y: 0, z: 1 };
            // Spawn a vertical wall yawed so its face points back at the camera,
            // so a new portal appears face-on where the author is looking.
            const q = new Quat();
            q.setFromEulerAngles(0, Math.atan2(cp.x - t.x, cp.z - t.z) * 180 / Math.PI, 0);
            const splats = splatList();
            const data: PortalData = {
                id: events.invoke('portals.newId') as string,
                position: [t.x, t.y, t.z],
                rotation: [q.x, q.y, q.z, q.w],
                width: 2,
                height: 2,
                frontUid: splats[0]?.uid ?? null,
                backUid: splats[1]?.uid ?? null
            };
            events.fire('edit.add', new AddPortalOp(events, data));
        });

        // --- gizmos: one active at a time, switched via the Move/Rotate
        //     toggle (avoids overlapping translate + rotate gizmos). New portals
        //     spawn facing the camera; Rotate allows arbitrary re-orientation. ---
        const translateGizmo = new TranslateGizmo(scene.camera.camera, scene.gizmoLayer);
        const rotateGizmo = new RotateGizmo(scene.camera.camera, scene.gizmoLayer);
        const dragPos = new Vec3();
        const dragRot = new Quat();
        let dragging = false;
        let gizmoMode: 'move' | 'rotate' = 'move';

        const pivotOf = (id: string) => shapes.get(id)?.pivot ?? null;

        const updateGizmos = () => {
            translateGizmo.detach();
            rotateGizmo.detach();
            const z = active ? selected() : null;
            const pivot = z ? pivotOf(z.id) : null;
            if (pivot) {
                (gizmoMode === 'rotate' ? rotateGizmo : translateGizmo).attach(pivot);
            }
        };

        const refreshModeButtons = () => {
            moveButton.class[gizmoMode === 'move' ? 'add' : 'remove']('active');
            rotateButton.class[gizmoMode === 'rotate' ? 'add' : 'remove']('active');
        };
        const setMode = (mode: 'move' | 'rotate') => {
            gizmoMode = mode;
            refreshModeButtons();
            updateGizmos();
        };
        moveButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            setMode('move');
        });
        rotateButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            setMode('rotate');
        });
        refreshModeButtons();

        const onRender = () => {
            scene.forceRender = true;
        };
        translateGizmo.on('render:update', onRender);
        rotateGizmo.on('render:update', onRender);

        const onStart = () => {
            dragging = true;
            const z = selected();
            const pivot = z ? pivotOf(z.id) : null;
            if (pivot) {
                dragPos.copy(pivot.getPosition());
                dragRot.copy(pivot.getRotation());
            }
        };
        translateGizmo.on('transform:start', onStart);
        rotateGizmo.on('transform:start', onStart);

        const onEnd = () => {
            dragging = false;
            const z = selected();
            const pivot = z ? pivotOf(z.id) : null;
            if (!z || !pivot) {
                return;
            }
            const pos = pivot.getPosition();
            const rot = pivot.getRotation();
            const moved = pos.x !== dragPos.x || pos.y !== dragPos.y || pos.z !== dragPos.z;
            const rotated = rot.x !== dragRot.x || rot.y !== dragRot.y || rot.z !== dragRot.z || rot.w !== dragRot.w;
            if (!moved && !rotated) {
                return;
            }
            events.fire('edit.add', new UpdatePortalOp(
                events,
                z.id,
                { position: [dragPos.x, dragPos.y, dragPos.z], rotation: [dragRot.x, dragRot.y, dragRot.z, dragRot.w] },
                { position: [pos.x, pos.y, pos.z], rotation: [rot.x, rot.y, rot.z, rot.w] }
            ));
        };
        translateGizmo.on('transform:end', onEnd);
        rotateGizmo.on('transform:end', onEnd);

        // entryGizmo declared here so updateGizmoSize can reference it before the overlay section
        const entryGizmo = new TranslateGizmo(scene.camera.camera, scene.gizmoLayer);

        const updateGizmoSize = () => {
            const { camera, canvas } = scene;
            const size = camera.ortho ? 1125 / canvas.clientHeight : 1200 / Math.max(canvas.clientWidth, canvas.clientHeight);
            translateGizmo.size = size;
            rotateGizmo.size = size;
            entryGizmo.size = size;
        };
        updateGizmoSize();
        events.on('camera.resize', updateGizmoSize);
        events.on('camera.ortho', updateGizmoSize);

        // --- entrypoint dot overlay (SVG, never occluded) ---
        const epSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        epSvg.classList.add('portal-entrypoint-overlay');
        epSvg.style.position = 'absolute';
        epSvg.style.inset = '0';
        epSvg.style.width = '100%';
        epSvg.style.height = '100%';
        epSvg.style.pointerEvents = 'none';
        canvasContainer.dom.appendChild(epSvg);
        const epNs = epSvg.namespaceURI;
        const epDots: { circle: SVGCircleElement, label: SVGTextElement }[] = [];
        const epWorld = new Vec3();
        const epScreen = new Vec3();

        const drawEntrypoints = () => {
            const eps = active ? (events.invoke('portals.exportEntrypoints') as Record<string, [number, number, number]>) : {};
            const uids = Object.keys(eps);
            while (epDots.length < uids.length) {
                const circle = document.createElementNS(epNs, 'circle') as SVGCircleElement;
                circle.setAttribute('r', '6');
                circle.setAttribute('fill', '#00ccff');
                circle.setAttribute('stroke', '#003344');
                circle.setAttribute('stroke-width', '2');
                const label = document.createElementNS(epNs, 'text') as SVGTextElement;
                label.setAttribute('fill', '#ffffff');
                label.setAttribute('font-size', '11');
                epSvg.appendChild(circle);
                epSvg.appendChild(label);
                epDots.push({ circle, label });
            }
            while (epDots.length > uids.length) {
                const d = epDots.pop();
                d.circle.remove();
                d.label.remove();
            }
            const cw = canvasContainer.dom.clientWidth;
            const ch = canvasContainer.dom.clientHeight;
            uids.forEach((uid, i) => {
                const pos = eps[uid];
                epWorld.set(pos[0], pos[1], pos[2]);
                const inFront = scene.camera.worldToScreen(epWorld, epScreen);
                const { circle, label } = epDots[i];
                if (!inFront) {
                    circle.setAttribute('visibility', 'hidden');
                    label.setAttribute('visibility', 'hidden');
                    return;
                }
                const x = epScreen.x * cw;
                const y = epScreen.y * ch;
                const isSel = parseInt(uid, 10) === selectedEntryUid;
                circle.setAttribute('visibility', 'visible');
                label.setAttribute('visibility', 'visible');
                circle.setAttribute('cx', `${x}`);
                circle.setAttribute('cy', `${y}`);
                circle.setAttribute('stroke', isSel ? '#ffffff' : '#003344');
                circle.setAttribute('stroke-width', isSel ? '3' : '2');
                label.setAttribute('x', `${x + 9}`);
                label.setAttribute('y', `${y - 9}`);
                label.textContent = `⌂ ${uid}`;
            });
            // once the camera has moved clear of a just-set entrypoint, attach the
            // deferred gizmo (see updateEntryGizmo). Cheap: only runs while armed.
            if (entryGizmoArmed) {
                updateEntryGizmo();
            }
        };
        events.on('postrender', drawEntrypoints);

        // --- entrypoint translate gizmo ---
        const entryPivot = new Entity('portalEntrypointPivot');
        const entryDragStart = new Vec3();

        const updateEntryGizmo = () => {
            entryGizmo.detach();
            entryGizmoArmed = false;
            if (!active || selectedEntryUid == null) return;
            const pos = events.invoke('portals.entrypoint', selectedEntryUid) as [number, number, number] | null;
            if (!pos) return;
            // Defer the attach while the entrypoint is coincident with the camera
            // (e.g. right after "Set from camera", which captures the eye position):
            // a gizmo attached at ~zero distance renders degenerate and never
            // recovers. Arm it; the per-frame check in drawEntrypoints attaches it
            // once the camera has moved clear.
            const cp = events.invoke('camera.getPose')?.position;
            if (cp) {
                const dx = cp.x - pos[0], dy = cp.y - pos[1], dz = cp.z - pos[2];
                if (dx * dx + dy * dy + dz * dz < ENTRY_GIZMO_MIN_DIST * ENTRY_GIZMO_MIN_DIST) {
                    entryGizmoArmed = true;
                    return;
                }
            }
            entryPivot.setLocalPosition(pos[0], pos[1], pos[2]);
            entryGizmo.attach(entryPivot);
            scene.forceRender = true;
        };
        entryGizmo.on('render:update', () => { scene.forceRender = true; });
        entryGizmo.on('transform:start', () => {
            entryDragStart.copy(entryPivot.getLocalPosition());
        });
        entryGizmo.on('transform:move', () => { scene.forceRender = true; });
        entryGizmo.on('transform:end', () => {
            if (selectedEntryUid == null) return;
            const p = entryPivot.getLocalPosition();
            if (p.x === entryDragStart.x && p.y === entryDragStart.y && p.z === entryDragStart.z) return;
            events.fire('edit.add', new UpdatePortalEntrypointOp(
                events, selectedEntryUid,
                [entryDragStart.x, entryDragStart.y, entryDragStart.z],
                [p.x, p.y, p.z]
            ));
        });

        // --- click to select by portal center proximity ---
        const isPrimary = (e: PointerEvent) => (e.pointerType === 'mouse' ? e.button === 0 : e.isPrimary);

        // Select by clicking anywhere on a portal's rectangle: project its four
        // corners to screen and hit-test the click against the two triangles.
        const zoneAt = (offsetX: number, offsetY: number): PortalData | null => {
            const zones = events.invoke('portals.list') as PortalData[];
            const cw = canvasContainer.dom.clientWidth;
            const ch = canvasContainer.dom.clientHeight;
            // last added on top
            for (let i = zones.length - 1; i >= 0; i--) {
                const z = zones[i];
                qrot.set(z.rotation[0], z.rotation[1], z.rotation[2], z.rotation[3]);
                let allInFront = true;
                for (let c = 0; c < 4; c++) {
                    lc.set(LOCAL_CORNERS[c][0] * z.width, LOCAL_CORNERS[c][1] * z.height, 0);
                    qrot.transformVector(lc, lc);
                    wc[c].set(z.position[0] + lc.x, z.position[1] + lc.y, z.position[2] + lc.z);
                    if (!scene.camera.worldToScreen(wc[c], sc[c])) {
                        allInFront = false;
                        break;
                    }
                    sc[c].x *= cw;
                    sc[c].y *= ch;
                }
                if (!allInFront) {
                    continue;
                }
                if (pointInTri(offsetX, offsetY, sc[0], sc[1], sc[2]) ||
                    pointInTri(offsetX, offsetY, sc[0], sc[2], sc[3])) {
                    return z;
                }
            }
            return null;
        };

        // hit-test the entrypoint dots (screen space, ~10px), returns the scene uid or null
        const entrypointAt = (offsetX: number, offsetY: number): number | null => {
            const eps = events.invoke('portals.exportEntrypoints') as Record<string, [number, number, number]>;
            const cw = canvasContainer.dom.clientWidth;
            const ch = canvasContainer.dom.clientHeight;
            for (const key of Object.keys(eps)) {
                const pos = eps[key];
                epWorld.set(pos[0], pos[1], pos[2]);
                if (!scene.camera.worldToScreen(epWorld, epScreen)) continue;
                const x = epScreen.x * cw;
                const y = epScreen.y * ch;
                if (Math.abs(x - offsetX) < 10 && Math.abs(y - offsetY) < 10) {
                    return parseInt(key, 10);
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
        const pointerup = (e: PointerEvent) => {
            if (!active || !clicked || !isPrimary(e)) {
                return;
            }
            clicked = false;
            const epHit = entrypointAt(e.offsetX, e.offsetY);
            if (epHit != null) {
                selectedEntryUid = epHit;
                refreshBar();
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            const hit = zoneAt(e.offsetX, e.offsetY);
            if (hit) {
                events.fire('portals.select', hit.id);
                e.preventDefault();
                e.stopPropagation();
            }
        };

        // --- delete selected portal ---
        events.on('select.delete', () => {
            if (!active) {
                return;
            }
            const id = events.invoke('portals.selected') as string | null;
            if (!id) {
                return;
            }
            const zones = events.invoke('portals.list') as PortalData[];
            const index = zones.findIndex(z => z.id === id);
            const data = zones[index];
            if (data) {
                events.fire('edit.add', new RemovePortalOp(events, data, index));
            }
        });

        // --- reconcile plane meshes with the data. Runs whenever portals change,
        //     even if the tool is inactive, so portals stay visible while other
        //     tools are in use. The gizmo + editing are still active-only. ---
        const syncShapes = () => {
            const zones = events.invoke('portals.list') as PortalData[];
            const liveIds = new Set(zones.map(z => z.id));
            // remove shapes for deleted portals
            for (const [id, shape] of shapes) {
                if (!liveIds.has(id)) {
                    scene.remove(shape);
                    shapes.delete(id);
                }
            }
            const selId = events.invoke('portals.selected') as string | null;
            for (const z of zones) {
                let shape = shapes.get(z.id);
                if (!shape) {
                    shape = new PortalShape();
                    scene.add(shape);
                    shapes.set(z.id, shape);
                }
                // do not fight the gizmo while dragging the selected portal
                if (!(dragging && z.id === selId)) {
                    shape.setTransform(z.position, z.rotation, z.width, z.height);
                }
                shape.selected = z.id === selId;
            }
        };

        events.on('portals.changed', () => {
            syncShapes();
            refreshBar();
            updateGizmos();
            updateEntryGizmo();
        });
        events.on('portals.selectionChanged', () => {
            syncShapes();
            refreshBar();
            updateGizmos();
            updateEntryGizmo();
        });

        this.activate = () => {
            active = true;
            canvasContainer.dom.addEventListener('pointerdown', pointerdown);
            canvasContainer.dom.addEventListener('pointermove', pointermove);
            canvasContainer.dom.addEventListener('pointerup', pointerup, true);
            syncShapes();
            refreshBar();
            updateGizmos();
            updateEntryGizmo();
        };

        this.deactivate = () => {
            active = false;
            canvasContainer.dom.removeEventListener('pointerdown', pointerdown);
            canvasContainer.dom.removeEventListener('pointermove', pointermove);
            canvasContainer.dom.removeEventListener('pointerup', pointerup, true);
            events.fire('portals.select', null);
            bar.hidden = true;
            translateGizmo.detach();
            rotateGizmo.detach();
            entryGizmo.detach();
            drawEntrypoints();
        };
    }
}

export { PortalTool };
