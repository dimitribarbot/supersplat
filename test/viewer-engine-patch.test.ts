import { describe, it, expect } from 'vitest';

import { patchViewerEngine, VIEWER_ENGINE_PATCH_COUNT } from '../src/viewer-engine-patch';

// Exact byte shapes of the buggy engine sections as they appear in the viewer
// bundle baked into @playcanvas/splat-transform 2.7.1 (engine 2.20.2,
// tab-indented, plain `class X {` declarations). Fixed upstream in playcanvas
// 2.20.4/2.20.5 (engine PRs #8998 and #9011); the bundled engine predates the
// fixes, so the export patches it in place. Every snippet below was verified
// to occur exactly once (escaped) in the real splat-transform dist bundle.

// GSplatAssetLoader (PR #8998 + upstream _failed bookkeeping)
const LOADER_SNIPPET =
    'class GSplatAssetLoader extends GSplatAssetLoaderBase {\n' +
    '\t_urlToAsset = /* @__PURE__ */ new Map();\n' +
    '\t_registry;\n' +
    '\tmaxConcurrentLoads = 2;\n' +
    '\tmaxRetries = 2;\n' +
    '\t_currentlyLoading = /* @__PURE__ */ new Set();\n' +
    '\t_loadQueue = [];\n' +
    '\t_retryCount = /* @__PURE__ */ new Map();\n' +
    '\t_destroyed = false;\n' +
    '\tdestroy() {\n' +
    '\t\tthis._urlToAsset.clear();\n' +
    '\t\tthis._loadQueue.length = 0;\n' +
    '\t\tthis._currentlyLoading.clear();\n' +
    '\t\tthis._retryCount.clear();\n' +
    '\t}\n' +
    '\tload(url) {\n' +
    '\t\tconst asset = this._urlToAsset.get(url);\n' +
    '\t\tif (asset?.loaded || this._currentlyLoading.has(url)) {\n' +
    '\t\t\treturn;\n' +
    '\t\t}\n' +
    '\t}\n' +
    '\t_onAssetLoadError(url, asset, err) {\n' +
    '\t\tif (retryCount < this.maxRetries) {\n' +
    '\t\t\tthis._retryCount.set(url, retryCount + 1);\n' +
    '\t\t\tasset.loaded = false;\n' +
    '\t\t\tasset.loading = false;\n' +
    '\t\t\tthis._registry.load(asset);\n' +
    '\t\t} else {\n' +
    '\t\t\tthis._currentlyLoading.delete(url);\n' +
    '\t\t\tthis._retryCount.delete(url);\n' +
    '\t\t\tthis._processQueue();\n' +
    '\t\t}\n' +
    '\t}\n' +
    '\tunload(url) {\n' +
    '\t\tthis._retryCount.delete(url);\n' +
    '\t\tconst asset = this._urlToAsset.get(url);\n' +
    '\t}\n' +
    '\tgetResource(url) {\n' +
    '\t\tconst asset = this._urlToAsset.get(url);\n' +
    '\t\treturn asset?.resource;\n' +
    '\t}\n' +
    '}\n';

// GSplatOctree.ensureFileResource (PR #9011: guard after destroy() nulls assetLoader)
const OCTREE_SNIPPET =
    'class GSplatOctree {\n' +
    '\tensureFileResource(fileIndex) {\n' +
    '\t\tif (this.fileResources.has(fileIndex)) {\n' +
    '\t\t\treturn;\n' +
    '\t\t}\n' +
    '\t}\n' +
    '}\n';

// GSplatWorld.update (PR #9011: sweep instances of destroyed octrees)
const WORLD_SNIPPET =
    'class GSplatWorld {\n' +
    '\tupdate(camera, allowLodUpdate, requireCenters, result) {\n' +
    '\t\tresult.newVersion = false;\n' +
    '\t\tresult.overdrawDirty = false;\n' +
    '\t\tresult.sortNeeded = false;\n' +
    '\t\tif (--this._framesTillFullUpdate <= 0) {\n' +
    '\t\t}\n' +
    '\t}\n' +
    '}\n';

// CameraManager.snap (fork patch: add a spawn-preserving reseat() sibling, then
// a groundBelowCamera() sibling for the VR/AR floor fix).
// This part of the viewer bundle (the app, not the engine) is 4-space indented.
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

const BUNDLE = OCTREE_SNIPPET + WORLD_SNIPPET + LOADER_SNIPPET + CAMERA_MANAGER_SNIPPET + INITXR_SNIPPET;

describe('patchViewerEngine', () => {
    it('applies all engine fixes (#8998 incl. _failed parity, #9011) to the baked bundle', () => {
        const { source, patched } = patchViewerEngine(BUNDLE);
        expect(patched).toBe(VIEWER_ENGINE_PATCH_COUNT);
        expect(VIEWER_ENGINE_PATCH_COUNT).toBe(12);

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

        // #8998: cancelled-load unstick, gated on the _failed set like upstream
        expect(source).toContain('if (asset && asset.loaded && !asset.resource && !this._currentlyLoading.has(url) && !this._failed.has(url)) {');
        // #8998: retry re-attaches the consumed error listener
        expect(source).toContain('asset.once("error", (retryErr) => this._onAssetLoadError(url, asset, retryErr));');
        // upstream _failed bookkeeping: field, destroy-clear, add on exhaustion,
        // delete on unload, hasFailed accessor
        expect(source).toContain('\t_failed = /* @__PURE__ */ new Set();\n\t_destroyed = false;\n');
        expect(source).toContain('\t\tthis._retryCount.clear();\n\t\tthis._failed.clear();\n\t}\n');
        expect(source).toContain('\t\t\tthis._retryCount.delete(url);\n\t\t\tthis._failed.add(url);\n\t\t\tthis._processQueue();\n');
        expect(source).toContain('\t\tthis._retryCount.delete(url);\n\t\tthis._failed.delete(url);\n\t\tconst asset = this._urlToAsset.get(url);\n');
        expect(source).toContain('\thasFailed(url) {\n\t\treturn this._failed.has(url);\n\t}\n');

        // #9011: ensureFileResource bails when the octree was destroyed
        expect(source).toContain('\tensureFileResource(fileIndex) {\n\t\tif (!this.assetLoader) {\n\t\t\treturn;\n\t\t}\n\t\tif (this.fileResources.has(fileIndex)) {\n');
        // #9011: world update sweeps instances whose octree was destroyed
        expect(source).toContain('\t\tfor (const [placement, inst] of this._octreeInstances) {\n\t\t\tif (inst.octree.destroyed) {\n\t\t\t\tthis._octreeInstances.delete(placement);\n\t\t\t\tthis._layerPlacementsDirty = true;\n\t\t\t\tthis._placementSetChanged = true;\n\t\t\t\tthis._octreeInstancesToDestroy.push(inst);\n\t\t\t}\n\t\t}\n');

        // original logic is preserved after the inserted guards
        expect(source).toContain('if (asset?.loaded || this._currentlyLoading.has(url)) {');
        expect(source).toContain('\t\tif (--this._framesTillFullUpdate <= 0) {');
    });

    it('is idempotent (a second pass matches nothing)', () => {
        const once = patchViewerEngine(BUNDLE);
        const twice = patchViewerEngine(once.source);
        expect(twice.patched).toBe(0);
        expect(twice.source).toBe(once.source);
    });

    it('patches partial bundles and reports the reduced count', () => {
        const { source, patched } = patchViewerEngine(LOADER_SNIPPET);
        expect(patched).toBe(7);
        expect(source).toContain('hasFailed(url)');
        expect(source).not.toContain('ensureFileResource');
    });

    it('returns unknown sources unchanged with patched=0', () => {
        const { source, patched } = patchViewerEngine('const x = 1;');
        expect(patched).toBe(0);
        expect(source).toBe('const x = 1;');
    });
});
