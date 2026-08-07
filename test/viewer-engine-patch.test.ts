import { describe, it, expect } from 'vitest';

import { patchViewerEngine, VIEWER_ENGINE_PATCH_COUNT } from '../src/viewer-engine-patch';

// As of @playcanvas/splat-transform 3.1.6 (engine 2.21.0) the former engine
// backport patches (PRs #8998 and #9011) ship in the baked bundle, so only the
// fork's viewer-app feature patches remain: a spawn-preserving reseat() on the
// CameraManager, a groundBelowCamera() sibling, and the XR-start rig grounding.
// The snippets below are the exact byte shapes of the viewer-app sections the
// patches anchor on (4-space / 8-space indented app code, not engine code).

// CameraManager.snap (fork patch: add a spawn-preserving reseat() sibling, then
// a groundBelowCamera() sibling for the VR/AR floor fix). 4-space indented.
const CAMERA_MANAGER_SNIPPET =
    '        this.snap = () => {\n' +
    '            getController(state.cameraMode).onEnter(this.camera);\n' +
    '            target.copy(this.camera);\n' +
    '            transitionTimer = 1;\n' +
    '            global.app.renderNextFrame = true;\n' +
    '        };\n' +
    '        // application update\n';

// initXr XR-start handler (fork patch: ground the camera rig to the floor
// beneath the camera instead of pinning it to world Y=0). 8-space indented.
const INITXR_SNIPPET =
    '        cameraPosition.copy(camera.getPosition());\n' +
    '        // copy transform to parent to XR/VR mode starts in the right place\n' +
    '        parent.setPosition(cameraPosition.x, 0, cameraPosition.z);\n' +
    '        parent.setEulerAngles(0, angles.y, 0);\n';

// Tail of the bundle: the only thing it exports. The fork patch prepends a
// window publish of the engine classes the portal-marker companion needs.
const EXPORT_SNIPPET =
    'console.log(`SuperSplat Viewer`);\n' +
    '\n' +
    'export { main };\n';

// NavInteraction._onPointerUp, mouse click-to-navigate branch (fork patch: a
// click on a portal icon shows its tooltip and must not also move the camera).
// 12-/16-space indented. The inner `if` line alone occurs TWICE in the bundle
// -- once here and once in _onMobileTap -- so the anchor needs the TAP_EPSILON
// line above it to be unique.
const POINTER_UP_SNIPPET =
    '            if (this._mouseClickDelta < TAP_EPSILON) {\n' +
    '                if (state.cameraMode === \'walk\' && !state.gamingControls) {\n';

// NavInteraction._onMobileTap, touch click-to-navigate branch (same fork
// patch, other input path). 8-space indented, anchored on the _suppressClick
// early-return block above it.
const MOBILE_TAP_SNIPPET =
    '        if (this._suppressClick) {\n' +
    '            this._suppressClick = false;\n' +
    '            return;\n' +
    '        }\n' +
    '        if (state.cameraMode === \'walk\' && !state.gamingControls) {\n';

// NavCursor.updateCursor, the walk-mode hover ring (fork patch: hide the ring
// while the pointer is over a portal icon, so "ring gone" reads as "this click
// opens a tooltip and will not move you"). 4-/8-space indented. The viewer's own
// annotations get this for free from their DOM hotspot making the canvas fire
// pointerleave; the markers have no DOM hit-target by design.
const NAV_CURSOR_SNIPPET =
    '    updateCursor(offsetX, offsetY) {\n' +
    '        if (!this.hoverActive || this.navigating) {\n' +
    '            this.hoverRing.hide();\n' +
    '            return;\n' +
    '        }\n';

const BUNDLE = CAMERA_MANAGER_SNIPPET + INITXR_SNIPPET + POINTER_UP_SNIPPET + MOBILE_TAP_SNIPPET + NAV_CURSOR_SNIPPET + EXPORT_SNIPPET;

describe('patchViewerEngine', () => {
    it('applies the fork viewer feature patches to the baked bundle', () => {
        const { source, patched } = patchViewerEngine(BUNDLE);
        expect(patched).toBe(VIEWER_ENGINE_PATCH_COUNT);
        expect(VIEWER_ENGINE_PATCH_COUNT).toBe(7);

        // fork patch: spawn-preserving reseat() inserted next to snap(), using
        // goto() (re-seat only) instead of onEnter() (grounds + stores spawn)
        expect(source).toContain(
            '        this.reseat = () => {\n' +
            '            const controller = getController(state.cameraMode);\n' +
            '            (controller.goto || controller.onEnter).call(controller, this.camera);\n'
        );
        // the original snap() is preserved ahead of it
        expect(source).toContain('        this.snap = () => {\n            getController(state.cameraMode).onEnter(this.camera);');

        // fork patch: groundBelowCamera() inserted next to reseat(), reusing the
        // walk controller's findCylinderSpawn to find the floor beneath the camera
        expect(source).toContain(
            '        this.groundBelowCamera = (x, y, z) => {\n' +
            '            const walk = controllers.walk;\n' +
            '            if (!walk || !walk.collision) return null;\n' +
            '            const out = new Vec3();\n' +
            '            return findCylinderSpawn(walk.collision, x, y, z, (walk.capsuleHeight + walk.hoverHeight) * 0.5, walk.capsuleRadius, out) ? out.y : null;\n' +
            '        };\n'
        );

        // fork patch: XR start grounds the rig to the floor beneath the camera
        // (falling back to 0 when no collision / no ground within range)
        expect(source).toContain(
            '        const ssFloorY = (window.__supersplatViewer && window.__supersplatViewer.cameraManager && window.__supersplatViewer.cameraManager.groundBelowCamera) ? window.__supersplatViewer.cameraManager.groundBelowCamera(cameraPosition.x, cameraPosition.y, cameraPosition.z) : null;\n' +
            '        parent.setPosition(cameraPosition.x, (typeof ssFloorY === \'number\') ? ssFloorY : 0, cameraPosition.z);\n'
        );
        // the original world-Y=0 rig pin is gone
        expect(source).not.toContain('parent.setPosition(cameraPosition.x, 0, cameraPosition.z);');

        // fork patch: publish the engine classes the portal-marker companion
        // needs, guarded so a renamed symbol degrades to "no icons" rather than
        // a ReferenceError that kills the whole viewer module
        expect(source).toContain('try { window.__ssPc = {');
        expect(source).toContain('Entity: Entity');
        expect(source).toContain('MeshInstance: MeshInstance');
        expect(source).toContain('StandardMaterial: StandardMaterial');
        expect(source).toContain('PlaneGeometry: PlaneGeometry');
        expect(source).toContain('Quat: Quat');
        expect(source).toContain('BLENDMODE_ONE_MINUS_SRC_ALPHA: BLENDMODE_ONE_MINUS_SRC_ALPHA');
        // the original export is preserved after it
        expect(source.indexOf('window.__ssPc')).toBeLessThan(source.indexOf('export { main };'));

        // fork patch: a click that lands on a portal icon opens the marker
        // tooltip and must not also drive the camera. Guarding the viewer's own
        // two nav decision points covers walk, fly and orbit with one line
        // each, and stores no state that could go stale.
        const guard = 'if (window.__ssPortalMarkerAt && window.__ssPortalMarkerAt(this._lastPointerOffsetX, this._lastPointerOffsetY)) return;';
        expect(source).toContain(
            '            if (this._mouseClickDelta < TAP_EPSILON) {\n' +
            `                ${guard}\n`
        );
        expect(source).toContain(
            '        }\n' +
            `        ${guard}\n` +
            '        if (state.cameraMode === \'walk\' && !state.gamingControls) {\n'
        );
        // both nav branches survive the insert
        expect(source.split('if (state.cameraMode === \'walk\' && !state.gamingControls) {').length - 1).toBe(2);

        // fork patch: the walk-mode nav hover ring hides while the pointer is
        // over a portal icon. Same predicate the click guards use, so the ring
        // vanishing is an honest preview of "this click will not move you".
        expect(source).toContain(
            '    updateCursor(offsetX, offsetY) {\n' +
            '        if (window.__ssPortalMarkerAt && window.__ssPortalMarkerAt(offsetX, offsetY)) { this.hoverRing.hide(); return; }\n' +
            '        if (!this.hoverActive || this.navigating) {\n'
        );
    });

    it('is idempotent (a second pass matches nothing)', () => {
        const once = patchViewerEngine(BUNDLE);
        const twice = patchViewerEngine(once.source);
        expect(twice.patched).toBe(0);
        expect(twice.source).toBe(once.source);
    });

    it('patches partial bundles and reports the reduced count', () => {
        // Only the CameraManager section: reseat() + groundBelowCamera() apply
        // (both anchor on snap/reseat), but the XR-start grounding does not.
        const { source, patched } = patchViewerEngine(CAMERA_MANAGER_SNIPPET);
        expect(patched).toBe(2);
        expect(source).toContain('this.reseat = () => {');
        expect(source).toContain('this.groundBelowCamera = (x, y, z) => {');
        expect(source).not.toContain('ssFloorY');
    });

    it('returns unknown sources unchanged with patched=0', () => {
        const { source, patched } = patchViewerEngine('const x = 1;');
        expect(patched).toBe(0);
        expect(source).toBe('const x = 1;');
    });

    it('does not publish engine classes into a bundle with no export tail', () => {
        const { source, patched } = patchViewerEngine(CAMERA_MANAGER_SNIPPET + INITXR_SNIPPET + POINTER_UP_SNIPPET + MOBILE_TAP_SNIPPET);
        expect(patched).toBe(5);
        expect(source).not.toContain('__ssPc');
    });
});
