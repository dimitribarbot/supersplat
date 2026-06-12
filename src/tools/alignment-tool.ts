import { Container } from '@playcanvas/pcui';
import { Entity, TranslateGizmo, Vec3 } from 'playcanvas';

import { AlignmentManager, AlignmentPickSide } from '../alignment';
import { Events } from '../events';
import { Scene } from '../scene';

class AlignmentTransformHandler {
    activate() {}
    deactivate() {}
}

const p = new Vec3();

type Marker = {
    circle: SVGCircleElement;
    label: SVGTextElement;
};

type MarkerPoint = {
    id: number;
    side: AlignmentPickSide;
    num: number;
    world: Vec3;
};

class AlignmentTool {
    activate: () => void;
    deactivate: () => void;

    constructor(
        events: Events,
        scene: Scene,
        manager: AlignmentManager,
        canvasContainer: Container
    ) {
        const transformHandler = new AlignmentTransformHandler();
        const parent = canvasContainer.dom;
        let active = false;
        let clicked = false;

        // SVG overlay above the canvas. Draws a numbered dot for every picked
        // source/target point, projected to screen coordinates each frame so the
        // markers are never occluded by the splats (mirrors AnnotationOverlay).
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.classList.add('alignment-overlay-svg', 'hidden');
        parent.appendChild(svg);
        const ns = svg.namespaceURI;

        const markers: Marker[] = [];

        const ensurePool = (n: number) => {
            while (markers.length < n) {
                const circle = document.createElementNS(ns, 'circle') as SVGCircleElement;
                circle.classList.add('alignment-marker-dot');
                const label = document.createElementNS(ns, 'text') as SVGTextElement;
                label.classList.add('alignment-marker-label');
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

        // project a world position to pixel coordinates within the canvas;
        // returns false when the point is behind the camera (mirrored projection).
        const project = (world: Vec3, out: Vec3) => {
            const inFront = scene.camera.worldToScreen(world, out);
            out.x *= parent.clientWidth;
            out.y *= parent.clientHeight;
            return inFront;
        };

        // flat list of points to draw: each pair contributes a source dot and/or
        // a target dot, both labelled with the pair's 1-based index.
        const collectPoints = (): MarkerPoint[] => {
            const points: MarkerPoint[] = [];
            manager.pairs.forEach((pair, index) => {
                if (pair.source && manager.source) {
                    const world = manager.pairWorldPoint(pair, 'source', new Vec3());
                    if (world) points.push({ id: pair.id, side: 'source', num: index + 1, world });
                }
                if (pair.target && manager.target) {
                    const world = manager.pairWorldPoint(pair, 'target', new Vec3());
                    if (world) points.push({ id: pair.id, side: 'target', num: index + 1, world });
                }
            });
            return points;
        };

        const draw = () => {
            if (!active) {
                ensurePool(0);
                return;
            }

            const points = collectPoints();
            const sel = manager.selected;
            ensurePool(points.length);

            points.forEach((pt, i) => {
                const { circle, label } = markers[i];
                if (!project(pt.world, p)) {
                    circle.setAttribute('visibility', 'hidden');
                    label.setAttribute('visibility', 'hidden');
                    return;
                }
                circle.setAttribute('visibility', 'visible');
                label.setAttribute('visibility', 'visible');
                circle.setAttribute('cx', `${p.x}`);
                circle.setAttribute('cy', `${p.y}`);
                circle.classList.toggle('target', pt.side === 'target');
                circle.classList.toggle('selected', !!sel && pt.id === sel.id && pt.side === sel.side);
                // number badge at the upper-left of the dot
                label.setAttribute('x', `${p.x - 8}`);
                label.setAttribute('y', `${p.y - 8}`);
                label.textContent = `${pt.num}`;
            });
        };

        // --- translate gizmo for fine-tuning the selected point ---

        const gizmo = new TranslateGizmo(scene.camera.camera, scene.gizmoLayer);
        const pivot = new Entity('alignmentGizmoPivot');

        const updateGizmo = () => {
            gizmo.detach();
            const sel = active ? manager.selected : null;
            if (!sel) {
                return;
            }
            const pair = manager.pairs.find(pr => pr.id === sel.id);
            if (!pair || !pair[sel.side]) {
                return;
            }
            // alignment points are stored splat-local; the gizmo works in world space
            const world = manager.pairWorldPoint(pair, sel.side, p);
            if (!world) {
                return;
            }
            pivot.setLocalPosition(world);
            gizmo.attach(pivot);
        };

        gizmo.on('render:update', () => {
            scene.forceRender = true;
        });
        gizmo.on('transform:move', () => {
            const sel = manager.selected;
            if (sel) {
                // mutate the point live so the overlay dot tracks the drag. The
                // overlay re-reads positions every postrender, so do NOT fire
                // 'alignment.changed' here — that would re-run updateGizmo and
                // detach/reattach the gizmo mid-drag.
                manager.setPointWorld(sel.id, sel.side, pivot.getLocalPosition());
            }
            scene.forceRender = true;
        });
        gizmo.on('transform:end', () => {
            // re-solve (updates RMS / residuals / preview availability) once the
            // drag finishes. Pairs are transient tool state, so the move is not
            // pushed to the undo history.
            manager.commitMove();
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

        events.on('postrender', draw);
        events.on('alignment.changed', () => {
            updateGizmo();
            scene.forceRender = true;
        });

        const isPrimary = (e: PointerEvent) => {
            return e.pointerType === 'mouse' ? e.button === 0 : e.isPrimary;
        };

        // hit-test a screen point against every marker dot (used for selection)
        const markerAt = (offsetX: number, offsetY: number): MarkerPoint | null => {
            const points = collectPoints();
            for (const pt of points) {
                if (!project(pt.world, p)) {
                    continue;
                }
                if (Math.abs(p.x - offsetX) < 8 && Math.abs(p.y - offsetY) < 8) {
                    return pt;
                }
            }
            return null;
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

            // 1) click near an existing marker -> select it (shows the gizmo)
            const hit = markerAt(e.offsetX, e.offsetY);
            if (hit) {
                manager.selectPoint(hit.id, hit.side);
                e.preventDefault();
                e.stopPropagation();
                return;
            }

            // 2) otherwise raycast the splat -> place a new point
            const result = await scene.camera.intersect(
                e.offsetX / parent.clientWidth,
                e.offsetY / parent.clientHeight
            );

            if (result) {
                manager.addPickedPoint(result.splat, result.position);
                e.preventDefault();
                e.stopPropagation();
            }
        };

        this.activate = () => {
            active = true;
            svg.classList.remove('hidden');
            parent.addEventListener('pointerdown', pointerdown);
            parent.addEventListener('pointermove', pointermove);
            parent.addEventListener('pointerup', pointerup, true);
            events.fire('alignment.active', true);
            events.fire('transformHandler.push', transformHandler);
            updateGizmo();
            scene.forceRender = true;
        };

        this.deactivate = () => {
            active = false;
            svg.classList.add('hidden');
            ensurePool(0);
            gizmo.detach();
            manager.clearSelection();
            manager.revertPreview();
            parent.removeEventListener('pointerdown', pointerdown);
            parent.removeEventListener('pointermove', pointermove);
            parent.removeEventListener('pointerup', pointerup, true);
            events.fire('alignment.active', false);
            events.fire('transformHandler.pop');
            scene.forceRender = true;
        };
    }
}

export { AlignmentTool };
