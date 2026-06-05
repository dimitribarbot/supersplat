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
            if (!showing) {
                // overlays hidden: also dismiss any lingering hover preview
                preview.classList.add('hidden');
            }
            const annotations = showing ? (events.invoke('annotations.list') as AnnotationData[]) : [];
            const selectedId = annotations.length > 0 ? (events.invoke('annotations.selected') as string | null) : null;

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
            // mirror the old marker's gating: no need to force a frame when the
            // overlay isn't being drawn
            if (scene.camera.renderOverlays) {
                scene.forceRender = true;
            }
        };
        events.on('annotations.changed', markDirty);
        events.on('annotations.selectionChanged', markDirty);

        // hit-test a screen point against every marker (used by hover + click)
        const isPrimary = (e: PointerEvent) => (e.pointerType === 'mouse' ? e.button === 0 : e.isPrimary);

        const markerAt = (offsetX: number, offsetY: number): AnnotationData | null => {
            const annotations = events.invoke('annotations.list') as AnnotationData[];
            for (let i = 0; i < annotations.length; i++) {
                const a = annotations[i];
                project(a.position, p);
                if (Math.abs(p.x - offsetX) < 8 && Math.abs(p.y - offsetY) < 8) {
                    return a;
                }
            }
            return null;
        };

        // click-to-enter: when the annotation tool is inactive, clicking a marker
        // switches into annotation mode and selects it (mirrors the tool's own
        // click detection: any move between down and up cancels the click)
        let clicked = false;
        const onPointerDown = (e: PointerEvent) => {
            if (!clicked && isPrimary(e)) {
                clicked = true;
            }
        };
        const onPointerUp = (e: PointerEvent) => {
            if (!clicked || !isPrimary(e)) {
                return;
            }
            clicked = false;
            // while the annotation tool is active it handles clicks itself
            if (events.invoke('tool.active') === 'annotation' || !scene.camera.renderOverlays) {
                return;
            }
            const hit = markerAt(e.offsetX, e.offsetY);
            if (hit) {
                events.fire('tool.annotation');
                events.fire('annotations.select', hit.id);
                e.preventDefault();
                e.stopPropagation();
            }
        };
        parent.addEventListener('pointerdown', onPointerDown);
        parent.addEventListener('pointerup', onPointerUp);

        // hover preview — skip the selected annotation (its move gizmo is active)
        const onPointerMove = (e: PointerEvent) => {
            clicked = false;
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
            // skip on miss, and on empty annotations (would show a blank box)
            if (!hit || (!hit.title && !hit.text && !hit.url)) {
                preview.classList.add('hidden');
                return;
            }
            previewTitle.textContent = hit.title || '';
            previewTitle.style.display = hit.title ? 'block' : 'none';
            previewText.textContent = hit.text || '';
            previewText.style.display = hit.text ? 'block' : 'none';
            previewLink.style.display = hit.url ? 'inline-block' : 'none';
            // p already holds the hovered marker's screen coords from the hit-test loop
            preview.style.left = `${p.x + 12}px`;
            preview.style.top = `${p.y + 12}px`;
            preview.classList.remove('hidden');
        };
        parent.addEventListener('pointermove', onPointerMove);
    }
}

export { AnnotationOverlay };
