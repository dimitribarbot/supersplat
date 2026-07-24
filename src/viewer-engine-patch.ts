// Export-time patch for the PlayCanvas engine bundled inside
// @playcanvas/splat-transform's exported viewer (index.js / output.html).
//
// History: splat-transform 2.7.1 baked engine 2.20.2, which was missing two
// gsplat streaming fixes (PR #8998 GSplatAssetLoader loader-stall + _failed
// bookkeeping, PR #9011 GSplatOctree/GSplatWorld unload race). This file used
// to string-patch those into the baked bundle to make it byte-identical to
// 2.20.5. As of splat-transform 3.1.6 (engine 2.21.0, >= 2.20.5) those fixes
// ship in the bundle already -- verified: the baked viewer engine now contains
// `hasFailed(url)` (PR #8998) and `inst.octree.destroyed` (PR #9011). The nine
// engine backport patches are therefore obsolete and have been removed.
//
// What remains are three fork-specific patches (NOT upstream backports) that
// add viewer-APP behaviour absent from any upstream engine version:
//
//   1. A spawn-preserving `reseat()` method on the viewer's CameraManager.
//   2/3. VR/AR entry grounded to the floor beneath the camera instead of
//        world Y=0 (`groundBelowCamera()` + the XR-start rig placement).
//
// These target the exported viewer app (4-/8-space indented), not the engine,
// so they are unaffected by the engine bump; each search string was re-verified
// to occur exactly once in the real splat-transform 3.1.6 baked viewer (the
// app shell is unchanged). Enforcement is a non-fatal `console.warn`: a miss
// means the bundled viewer app changed shape, and the injected portal
// companion's `snap()` fallback still applies.
//
// Off-limits reseat rationale: the off-limits-zones companion clamps the walk
// camera by setting a safe pose and re-seating the active controller. It
// previously used `snap()`, but snap() re-runs the controller's `onEnter()`,
// which re-captures the walk/fly reset spawn at the current (wall-clamped)
// position -- so being blocked overwrote the reset spawn to the wall and
// pressing R (resetToSpawn) returned there. `reseat()` is snap() with
// `onEnter()` swapped for `goto()`, which re-seats position/angles WITHOUT
// grounding or storing the spawn, so native reset is left intact. The companion
// prefers `reseat()` and falls back to `snap()` when this patch did not apply.
//
// Patches whose search text survives the replacement carry an `applied` marker
// so a second pass is a no-op. Pure and environment-agnostic (also compiled for
// the export server via dist-shared).

type EnginePatchResult = { source: string; patched: number };

type EnginePatch = {
    search: string;
    replace: string;
    // present in the output once this patch has been applied; only needed
    // when `search` is a prefix of `replace` (search alone self-destructs
    // for the other patches)
    applied?: string;
};

const PATCHES: EnginePatch[] = [
    // --- fork: spawn-preserving reseat() for the off-limits camera clamp ---
    // Insert a `reseat()` next to `snap()`. Identical to snap() except it calls
    // the active controller's `goto()` (re-seats pose only) instead of
    // `onEnter()` (which also grounds and re-stores the reset spawn). Falls back
    // to `onEnter()` for any controller without `goto()`, matching snap()'s
    // prior behaviour in those modes. 4-space indented (viewer app code).
    {
        search:
            'this.snap = () => {\n' +
            '            getController(state.cameraMode).onEnter(this.camera);\n' +
            '            target.copy(this.camera);\n' +
            '            transitionTimer = 1;\n' +
            '            global.app.renderNextFrame = true;\n' +
            '        };\n',
        replace:
            'this.snap = () => {\n' +
            '            getController(state.cameraMode).onEnter(this.camera);\n' +
            '            target.copy(this.camera);\n' +
            '            transitionTimer = 1;\n' +
            '            global.app.renderNextFrame = true;\n' +
            '        };\n' +
            '        this.reseat = () => {\n' +
            '            const controller = getController(state.cameraMode);\n' +
            '            (controller.goto || controller.onEnter).call(controller, this.camera);\n' +
            '            target.copy(this.camera);\n' +
            '            transitionTimer = 1;\n' +
            '            global.app.renderNextFrame = true;\n' +
            '        };\n',
        applied: 'this.reseat = () => {\n'
    },
    // --- fork: VR/AR enters at the floor beneath the camera, not world Y=0 ---
    // The bundled viewer's XR start handler pins the camera rig to world Y=0 and
    // uses a 'local-floor' reference space, so VR/AR only lands at eye level when
    // the scene's floor happens to sit at Y=0. Walk mode instead grounds to the
    // real floor via findCylinderSpawn (a 3D shell search, radius 5m, around the
    // camera). For an exported splat whose floor is off-zero (the common case)
    // this floats the viewer above the scene by the floor's world-Y. Two patches:
    //   1. Expose groundBelowCamera(x,y,z) on the CameraManager, running the SAME
    //      findCylinderSpawn walk uses, at the current camera XZ -> the floor Y
    //      beneath you (per-position, so slopes / multi-level stay correct).
    //   2. Have the XR start handler set the rig Y to that floor (falling back to
    //      0 when there is no collision, or no ground within range -- i.e. the
    //      prior behaviour, so a floor-at-0 scene is unchanged).
    // Runtime-only: reuses the loaded collision (single source of truth), so
    // there is nothing to bake at export and nothing to keep in parity. The 5m
    // reach is inherited from walk mode, so VR behaves exactly like entering walk.
    // Anchored on the reseat() block above (same CameraManager closure, where
    // `collision`, `controllers` and the module-level `findCylinderSpawn` and
    // `Vec3` are all in scope); runs after the reseat patch that creates it.
    {
        search:
            '        this.reseat = () => {\n' +
            '            const controller = getController(state.cameraMode);\n' +
            '            (controller.goto || controller.onEnter).call(controller, this.camera);\n' +
            '            target.copy(this.camera);\n' +
            '            transitionTimer = 1;\n' +
            '            global.app.renderNextFrame = true;\n' +
            '        };\n',
        replace:
            '        this.reseat = () => {\n' +
            '            const controller = getController(state.cameraMode);\n' +
            '            (controller.goto || controller.onEnter).call(controller, this.camera);\n' +
            '            target.copy(this.camera);\n' +
            '            transitionTimer = 1;\n' +
            '            global.app.renderNextFrame = true;\n' +
            '        };\n' +
            '        this.groundBelowCamera = (x, y, z) => {\n' +
            '            const walk = controllers.walk;\n' +
            '            if (!walk || !walk.collision) return null;\n' +
            '            const out = new Vec3();\n' +
            '            return findCylinderSpawn(walk.collision, x, y, z, (walk.capsuleHeight + walk.hoverHeight) * 0.5, walk.capsuleRadius, out) ? out.y : null;\n' +
            '        };\n',
        applied: '        this.groundBelowCamera = (x, y, z) => {\n'
    },
    {
        // XR start: ground the rig to the floor beneath the camera instead of
        // pinning it to world Y=0. Self-destructing search (the `0` becomes a
        // ternary), so no `applied` marker is needed. 8-space indented.
        search:
            '        parent.setPosition(cameraPosition.x, 0, cameraPosition.z);\n',
        replace:
            '        const ssFloorY = (window.__supersplatViewer && window.__supersplatViewer.cameraManager && window.__supersplatViewer.cameraManager.groundBelowCamera) ? window.__supersplatViewer.cameraManager.groundBelowCamera(cameraPosition.x, cameraPosition.y, cameraPosition.z) : null;\n' +
            '        parent.setPosition(cameraPosition.x, (typeof ssFloorY === \'number\') ? ssFloorY : 0, cameraPosition.z);\n'
    }
];

const VIEWER_ENGINE_PATCH_COUNT = PATCHES.length;

const patchViewerEngine = (source: string): EnginePatchResult => {
    let patched = 0;
    let out = source;
    for (const p of PATCHES) {
        if (out.includes(p.search) && !(p.applied && out.includes(p.applied))) {
            out = out.replace(p.search, p.replace);
            patched++;
        }
    }
    return { source: out, patched };
};

export { patchViewerEngine, VIEWER_ENGINE_PATCH_COUNT };
