import { Button, Container, Label, NumericInput, TextInput } from '@playcanvas/pcui';
import { Quat, RotateGizmo, TranslateGizmo, Vec3 } from 'playcanvas';

import { Events } from '../events';
import { OffLimitsZoneShape } from '../off-limits-zone-shape';
import { AddZoneOp, RemoveZoneOp, SetMessageOp, UpdateZoneOp, ZoneData } from '../off-limits-zones';
import { Scene } from '../scene';
import { localize } from '../ui/localization';

// temps for projecting a zone's quad corners to screen (click-to-select)
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

class OffLimitsZoneTool {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, scene: Scene, canvasContainer: Container) {
        let active = false;

        // per-zone plane meshes, keyed by zone id
        const shapes = new Map<string, OffLimitsZoneShape>();

        // --- floating editor bar ---
        const bar = new Container({ class: ['select-toolbar', 'annotations-toolbar'], hidden: true });
        bar.dom.addEventListener('pointerdown', e => e.stopPropagation());

        const addButton = new Button({ text: localize('offLimitsZones.add'), class: 'select-toolbar-button' });
        const moveButton = new Button({ text: localize('offLimitsZones.move'), class: 'select-toolbar-button' });
        const rotateButton = new Button({ text: localize('offLimitsZones.rotate'), class: 'select-toolbar-button' });
        const boundsButton = new Button({ text: '⤢', class: 'select-toolbar-button' });
        boundsButton.dom.title = localize('offLimitsZones.bounds.tooltip');
        const widthLabel = new Label({ text: localize('offLimitsZones.width') });
        const widthInput = new NumericInput({ precision: 2, value: 2, width: 80, min: 0.01 });
        const heightLabel = new Label({ text: localize('offLimitsZones.height') });
        const heightInput = new NumericInput({ precision: 2, value: 2, width: 80, min: 0.01 });
        const messageLabel = new Label({ text: localize('offLimitsZones.message') });
        const messageInput = new TextInput({ class: 'annotations-toolbar-input' });

        bar.append(addButton);
        bar.append(moveButton);
        bar.append(rotateButton);
        bar.append(boundsButton);
        bar.append(widthLabel);
        bar.append(widthInput);
        bar.append(heightLabel);
        bar.append(heightInput);
        bar.append(messageLabel);
        bar.append(messageInput);
        canvasContainer.append(bar);

        // --- selection helpers ---
        const selected = (): ZoneData | null => {
            const id = events.invoke('offLimitsZones.selected') as string | null;
            return id ? (events.invoke('offLimitsZones.byId', id) as ZoneData) : null;
        };

        // --- infinite-bounds popup (cross layout), mirrors portal-tool.ts ---
        const boundsPopup = new Container({ class: 'off-limits-bounds-popup', hidden: true });
        boundsPopup.dom.addEventListener('pointerdown', e => e.stopPropagation());
        const EDGE_DIRS = ['top', 'right', 'bottom', 'left'] as const;
        type EdgeDir = typeof EDGE_DIRS[number];
        const edgeGlyph: Record<EdgeDir, string> = { top: '↑', right: '→', bottom: '↓', left: '←' };
        const edgeButtons = {} as Record<EdgeDir, Button>;
        EDGE_DIRS.forEach((dir) => {
            const b = new Button({ text: edgeGlyph[dir], class: ['off-limits-bounds-toggle', `off-limits-bounds-${dir}`] });
            b.dom.title = localize(`offLimitsZones.bounds.${dir}`);
            edgeButtons[dir] = b;
            boundsPopup.append(b);
        });
        canvasContainer.append(boundsPopup);

        const emptyEdges = () => ({ top: false, right: false, bottom: false, left: false });
        const edgesOf = (z: ZoneData) => ({ ...emptyEdges(), ...(z.infinite ?? {}) });

        const refreshBoundsPopup = () => {
            const z = active ? selected() : null;
            boundsButton.enabled = !!z;
            if (!z) {
                boundsPopup.hidden = true;
                return;
            }
            const e = edgesOf(z);
            EDGE_DIRS.forEach(dir => edgeButtons[dir].class[e[dir] ? 'add' : 'remove']('active'));
        };

        const positionBoundsPopup = () => {
            const br = boundsButton.dom.getBoundingClientRect();
            const cr = canvasContainer.dom.getBoundingClientRect();
            boundsPopup.dom.style.left = `${br.left - cr.left + br.width / 2}px`;
            boundsPopup.dom.style.top = `${br.bottom - cr.top + 8}px`;
        };

        const toggleBoundsPopup = (show?: boolean) => {
            const next = typeof show === 'boolean' ? show : boundsPopup.hidden;
            if (next && active && selected()) {
                refreshBoundsPopup();
                positionBoundsPopup();
                boundsPopup.hidden = false;
            } else {
                boundsPopup.hidden = true;
            }
        };

        boundsButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            if (!active) return;
            toggleBoundsPopup();
        });

        EDGE_DIRS.forEach((dir) => {
            edgeButtons[dir].dom.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                const z = selected();
                if (!z) return;
                const oldEdges = edgesOf(z);
                const newEdges = { ...oldEdges, [dir]: !oldEdges[dir] };
                events.fire('edit.add', new UpdateZoneOp(events, z.id, { infinite: z.infinite }, { infinite: newEdges }));
            });
        });

        // --- infinite-edge arrow overlay (selected zone only). Projects each
        //     infinite edge's midpoint plus a point stepped outward, draws a red
        //     arrow glyph at the midpoint rotated to point outward on screen. ---
        const svgNs = 'http://www.w3.org/2000/svg';
        const edgeSvg = document.createElementNS(svgNs, 'svg');
        edgeSvg.style.position = 'absolute';
        edgeSvg.style.inset = '0';
        edgeSvg.style.width = '100%';
        edgeSvg.style.height = '100%';
        edgeSvg.style.overflow = 'visible';
        edgeSvg.style.pointerEvents = 'none';
        // Prepend so the overlay sits above #canvas but below editor chrome.
        canvasContainer.dom.prepend(edgeSvg);
        const edgeArrows: SVGTextElement[] = [];
        const edgeQuat = new Quat();
        const edgePos = new Vec3();
        const edgeLocal = new Vec3();
        const edgeMidW = new Vec3();
        const edgeOutW = new Vec3();
        const edgeMidS = new Vec3();
        const edgeOutS = new Vec3();
        const EDGE_MIDS: { dir: EdgeDir, x: number, y: number }[] = [
            { dir: 'top', x: 0, y: 0.5 },
            { dir: 'right', x: 0.5, y: 0 },
            { dir: 'bottom', x: 0, y: -0.5 },
            { dir: 'left', x: -0.5, y: 0 }
        ];

        const drawEdgeIcons = () => {
            const z = active ? selected() : null;
            const edges = z ? edgesOf(z) : emptyEdges();
            const dirs = EDGE_MIDS.filter(d => edges[d.dir]);
            while (edgeArrows.length < dirs.length) {
                const t = document.createElementNS(svgNs, 'text') as SVGTextElement;
                t.setAttribute('fill', '#ff3333');
                t.setAttribute('stroke', '#7a0000');
                t.setAttribute('stroke-width', '0.5');
                // Size via inline CSS, not the SVG font-size attribute: the global
                // `*` rule (font-size: 12px) overrides the presentation attribute.
                t.style.fontSize = '24px';
                t.setAttribute('text-anchor', 'middle');
                t.setAttribute('dominant-baseline', 'central');
                t.textContent = '➜';
                edgeSvg.appendChild(t);
                edgeArrows.push(t);
            }
            while (edgeArrows.length > dirs.length) {
                edgeArrows.pop().remove();
            }
            if (!z) return;
            const cw = canvasContainer.dom.clientWidth;
            const ch = canvasContainer.dom.clientHeight;
            edgeQuat.set(z.rotation[0], z.rotation[1], z.rotation[2], z.rotation[3]);
            edgePos.set(z.position[0], z.position[1], z.position[2]);
            dirs.forEach((d, i) => {
                const t = edgeArrows[i];
                edgeLocal.set(d.x * z.width, d.y * z.height, 0);
                edgeQuat.transformVector(edgeLocal, edgeMidW);
                edgeMidW.add(edgePos);
                edgeLocal.set(d.x * z.width * 1.6, d.y * z.height * 1.6, 0);
                edgeQuat.transformVector(edgeLocal, edgeOutW);
                edgeOutW.add(edgePos);
                const inFrontMid = scene.camera.worldToScreen(edgeMidW, edgeMidS);
                const inFrontOut = scene.camera.worldToScreen(edgeOutW, edgeOutS);
                if (!inFrontMid || !inFrontOut) {
                    t.setAttribute('visibility', 'hidden');
                    return;
                }
                const mx = edgeMidS.x * cw, my = edgeMidS.y * ch;
                const ox = edgeOutS.x * cw, oy = edgeOutS.y * ch;
                const angle = Math.atan2(oy - my, ox - mx) * 180 / Math.PI;
                t.setAttribute('visibility', 'visible');
                t.setAttribute('x', `${mx}`);
                t.setAttribute('y', `${my}`);
                t.setAttribute('transform', `rotate(${angle} ${mx} ${my})`);
            });
        };
        events.on('postrender', drawEdgeIcons);

        let suppress = false;
        const refreshBar = () => {
            bar.hidden = !active;
            if (!active) {
                return;
            }
            suppress = true;
            messageInput.value = events.invoke('offLimitsZones.message') as string;
            messageInput.placeholder = localize('offLimitsZones.defaultMessage');
            const z = selected();
            widthInput.enabled = !!z;
            heightInput.enabled = !!z;
            if (z) {
                widthInput.value = z.width;
                heightInput.value = z.height;
            }
            suppress = false;
        };

        const commitSize = (field: 'width' | 'height', value: number) => {
            if (suppress) {
                return;
            }
            const z = selected();
            if (!z || z[field] === value) {
                return;
            }
            events.fire('edit.add', new UpdateZoneOp(events, z.id, { [field]: z[field] }, { [field]: value }));
        };

        widthInput.on('change', (v: number) => commitSize('width', v));
        heightInput.on('change', (v: number) => commitSize('height', v));
        messageInput.on('change', (v: string) => {
            if (suppress) {
                return;
            }
            const current = events.invoke('offLimitsZones.message') as string;
            if (current !== v) {
                events.fire('edit.add', new SetMessageOp(events, current, v));
            }
        });

        // --- add a new zone at the current view target ---
        addButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            if (!active) {
                return;
            }
            const pose = events.invoke('camera.getPose');
            const t = pose?.target ?? { x: 0, y: 0, z: 0 };
            const cp = pose?.position ?? { x: 0, y: 0, z: 1 };
            // Spawn a vertical wall yawed so its face points back at the camera,
            // so a new zone appears face-on where the author is looking.
            const q = new Quat();
            q.setFromEulerAngles(0, Math.atan2(cp.x - t.x, cp.z - t.z) * 180 / Math.PI, 0);
            const data: ZoneData = {
                id: events.invoke('offLimitsZones.newId') as string,
                position: [t.x, t.y, t.z],
                rotation: [q.x, q.y, q.z, q.w],
                width: 2,
                height: 2
            };
            events.fire('edit.add', new AddZoneOp(events, data));
        });

        // --- gizmos: one active at a time, switched via the Move/Rotate
        //     toggle (avoids overlapping translate + rotate gizmos). New zones
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
            events.fire('edit.add', new UpdateZoneOp(
                events,
                z.id,
                { position: [dragPos.x, dragPos.y, dragPos.z], rotation: [dragRot.x, dragRot.y, dragRot.z, dragRot.w] },
                { position: [pos.x, pos.y, pos.z], rotation: [rot.x, rot.y, rot.z, rot.w] }
            ));
        };
        translateGizmo.on('transform:end', onEnd);
        rotateGizmo.on('transform:end', onEnd);

        const updateGizmoSize = () => {
            const { camera, canvas } = scene;
            const size = camera.ortho ? 1125 / canvas.clientHeight : 1200 / Math.max(canvas.clientWidth, canvas.clientHeight);
            translateGizmo.size = size;
            rotateGizmo.size = size;
        };
        updateGizmoSize();
        events.on('camera.resize', updateGizmoSize);
        events.on('camera.ortho', updateGizmoSize);

        // --- click to select by zone center proximity ---
        const isPrimary = (e: PointerEvent) => (e.pointerType === 'mouse' ? e.button === 0 : e.isPrimary);

        // Select by clicking anywhere on a zone's rectangle: project its four
        // corners to screen and hit-test the click against the two triangles.
        const zoneAt = (offsetX: number, offsetY: number): ZoneData | null => {
            const zones = events.invoke('offLimitsZones.list') as ZoneData[];
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
            const hit = zoneAt(e.offsetX, e.offsetY);
            if (hit) {
                events.fire('offLimitsZones.select', hit.id);
                e.preventDefault();
                e.stopPropagation();
            }
        };

        // --- delete selected zone ---
        events.on('select.delete', () => {
            if (!active) {
                return;
            }
            const id = events.invoke('offLimitsZones.selected') as string | null;
            if (!id) {
                return;
            }
            const zones = events.invoke('offLimitsZones.list') as ZoneData[];
            const index = zones.findIndex(z => z.id === id);
            const data = zones[index];
            if (data) {
                events.fire('edit.add', new RemoveZoneOp(events, data, index));
            }
        });

        // --- reconcile plane meshes with the data. Runs whenever zones change,
        //     even if the tool is inactive, so zones stay visible while other
        //     tools are in use. The gizmo + editing are still active-only. ---
        const syncShapes = () => {
            const zones = events.invoke('offLimitsZones.list') as ZoneData[];
            const liveIds = new Set(zones.map(z => z.id));
            // remove shapes for deleted zones
            for (const [id, shape] of shapes) {
                if (!liveIds.has(id)) {
                    scene.remove(shape);
                    shapes.delete(id);
                }
            }
            const selId = events.invoke('offLimitsZones.selected') as string | null;
            for (const z of zones) {
                let shape = shapes.get(z.id);
                if (!shape) {
                    shape = new OffLimitsZoneShape();
                    scene.add(shape);
                    shapes.set(z.id, shape);
                }
                // do not fight the gizmo while dragging the selected zone
                if (!(dragging && z.id === selId)) {
                    shape.setTransform(z.position, z.rotation, z.width, z.height);
                }
                shape.selected = z.id === selId;
            }
        };

        events.on('offLimitsZones.changed', () => {
            syncShapes();
            refreshBar();
            updateGizmos();
            refreshBoundsPopup();
        });
        events.on('offLimitsZones.selectionChanged', () => {
            syncShapes();
            refreshBar();
            updateGizmos();
            refreshBoundsPopup();
        });

        this.activate = () => {
            active = true;
            canvasContainer.dom.addEventListener('pointerdown', pointerdown);
            canvasContainer.dom.addEventListener('pointermove', pointermove);
            canvasContainer.dom.addEventListener('pointerup', pointerup, true);
            syncShapes();
            refreshBar();
            updateGizmos();
            refreshBoundsPopup();
        };

        this.deactivate = () => {
            active = false;
            canvasContainer.dom.removeEventListener('pointerdown', pointerdown);
            canvasContainer.dom.removeEventListener('pointermove', pointermove);
            canvasContainer.dom.removeEventListener('pointerup', pointerup, true);
            events.fire('offLimitsZones.select', null);
            bar.hidden = true;
            boundsPopup.hidden = true;
            translateGizmo.detach();
            rotateGizmo.detach();
        };
    }
}

export { OffLimitsZoneTool };
