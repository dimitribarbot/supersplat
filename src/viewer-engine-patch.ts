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
// What remains are seven fork-specific patches (NOT upstream backports) that
// add viewer-APP behaviour absent from any upstream engine version:
//
//   1. A spawn-preserving `reseat()` method on the viewer's CameraManager.
//   2/3. VR/AR entry grounded to the floor beneath the camera instead of
//        world Y=0 (`groundBelowCamera()` + the XR-start rig placement).
//   4. `window.__ssPc`, publishing the engine classes the portal-marker
//      companion needs (a classic script cannot reach them otherwise).
//   5/6. Two guards so a click on a portal marker opens its tooltip without
//        also driving the camera.
//   7. The walk-mode nav hover ring hides while the pointer is over a marker
//      icon (the viewer's own annotations get this from their DOM hotspot;
//      the markers have none by design).
//
// These target the exported viewer app (4-/8-space indented), not the engine,
// so they are unaffected by the engine bump; each search string was re-verified
// to occur exactly once in the real splat-transform 3.1.7 baked viewer (the
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
    },
    // --- fork: publish the engine classes the portal-marker companion needs ---
    // The exported viewer bundles engine + app into one unminified ESM module
    // whose only export is `main`, and the injected companions are classic
    // scripts, so there is no way to reach Entity/Mesh/StandardMaterial/...
    // from a companion. Prepend a window publish at module scope, where every
    // class is in lexical scope under its real name (verified against the
    // splat-transform 3.1.7 bundle).
    //
    // Wrapped in try/catch on purpose: if a future bundle renames a symbol
    // (rollup appends $1 on collisions), the free identifier throws a
    // ReferenceError at module evaluation -- which would kill the ENTIRE
    // viewer. Catching it degrades to "no portal icons" instead.
    //
    // `export { main };` survives its own replacement, so this patch needs the
    // `applied` marker to stay idempotent on a second pass (the other patches
    // self-destruct because their search text does not reappear).
    {
        search: 'export { main };',
        replace:
            'try { window.__ssPc = {\n' +
            '    Entity: Entity, Layer: Layer, Mesh: Mesh, MeshInstance: MeshInstance,\n' +
            '    StandardMaterial: StandardMaterial, Texture: Texture, Color: Color, Vec3: Vec3,\n' +
            '    Quat: Quat, BlendState: BlendState, PlaneGeometry: PlaneGeometry,\n' +
            '    PIXELFORMAT_RGBA8: PIXELFORMAT_RGBA8, FILTER_LINEAR: FILTER_LINEAR,\n' +
            '    CULLFACE_NONE: CULLFACE_NONE, BLENDEQUATION_ADD: BLENDEQUATION_ADD,\n' +
            '    BLENDMODE_ONE: BLENDMODE_ONE, BLENDMODE_SRC_ALPHA: BLENDMODE_SRC_ALPHA,\n' +
            '    BLENDMODE_ONE_MINUS_SRC_ALPHA: BLENDMODE_ONE_MINUS_SRC_ALPHA\n' +
            '}; } catch (ssPcErr) { console.warn(\'portal markers unavailable:\', ssPcErr); }\n' +
            'export { main };',
        applied: 'window.__ssPc = {'
    },
    // --- fork: a click on a portal marker opens its tooltip and nothing else ---
    // The marker companion's canvas listeners are deliberately passive and never
    // stop an event, so that an orbit-drag or click-to-walk gesture STARTING on
    // an icon is not swallowed. The cost is that a click on an icon also reaches
    // the viewer's own click-to-navigate handling and moves the camera.
    //
    // Fixed by guarding the two places the viewer decides a click means
    // navigate, rather than by intercepting events. Intercepting was rejected:
    // the camera controllers also listen for pointerup on the canvas to end a
    // drag and release pointer capture, so swallowing it strands them mid-drag.
    // Setting the viewer's own `_suppressClick` at pointerdown was rejected too:
    // on touch, `mobileTap` only fires when the tap did not move, so a touch
    // drag that starts on an icon never consumes the flag and it swallows the
    // NEXT tap.
    //
    // One line per site covers walk, fly and orbit together. `mobileTap`
    // fires for walk-without-gaming-controls, fly-without-gaming-controls and
    // orbit, so the single guard ahead of those branches covers all three
    // touch modes. A walk tap with gaming controls on becomes a jump and
    // never reaches here. Both guards store no state that could go stale --
    // each is evaluated at click time against the very offsets the viewer is
    // about to pick with. Both searches self-destruct (the two lines stop
    // being adjacent), so neither needs an `applied` marker. Verified to
    // occur exactly once each in the splat-transform 3.1.7 baked viewer; note
    // that the inner `if` line ALONE occurs twice, which is why both anchors
    // carry surrounding context.
    {
        // NavInteraction._onPointerUp -- mouse. 12-/16-space indented.
        search:
            '            if (this._mouseClickDelta < TAP_EPSILON) {\n' +
            '                if (state.cameraMode === \'walk\' && !state.gamingControls) {\n',
        replace:
            '            if (this._mouseClickDelta < TAP_EPSILON) {\n' +
            '                if (window.__ssPortalMarkerAt && window.__ssPortalMarkerAt(this._lastPointerOffsetX, this._lastPointerOffsetY)) return;\n' +
            '                if (state.cameraMode === \'walk\' && !state.gamingControls) {\n'
    },
    {
        // NavInteraction._onMobileTap -- touch. 8-space indented.
        search:
            '        if (this._suppressClick) {\n' +
            '            this._suppressClick = false;\n' +
            '            return;\n' +
            '        }\n' +
            '        if (state.cameraMode === \'walk\' && !state.gamingControls) {\n',
        replace:
            '        if (this._suppressClick) {\n' +
            '            this._suppressClick = false;\n' +
            '            return;\n' +
            '        }\n' +
            '        if (window.__ssPortalMarkerAt && window.__ssPortalMarkerAt(this._lastPointerOffsetX, this._lastPointerOffsetY)) return;\n' +
            '        if (state.cameraMode === \'walk\' && !state.gamingControls) {\n'
    },
    // --- fork: the nav hover ring hides while the pointer is over an icon ---
    // NavCursor.updateCursor -- the walk-mode ring that previews where a click
    // would take you. The viewer's own annotations hide it for free: their DOM
    // hotspot makes the canvas fire pointerleave, which NavCursor listens for.
    // The markers have no DOM hit-target on purpose (a per-marker div swallowed
    // the orbit-drag and click-to-walk gestures that start on a doorway), so
    // the ring keeps tracking straight through them without this.
    //
    // It also gives the one known limitation a cue: an icon fully hidden behind
    // a wall still eats the click (occlusion is layer-order paint-over, nothing
    // can query it), and now the ring disappearing says so before you click.
    //
    // offsetX/offsetY arrive as parameters, in canvas-relative CSS pixels --
    // the same space __ssPortalMarkerAt expects and the same space the two
    // click guards read out of _lastPointerOffsetX/Y. Verified against the
    // splat-transform 3.1.7 baked bundle: both anchor lines occur exactly once,
    // and the insert separates them, so this self-destructs on a second pass
    // like the other nav guards and needs no `applied` marker.
    //
    // Reaching the NavCursor instance from the companion and hiding its SVG
    // was rejected: the hover ring and the target ring share one <svg>
    // element, so hiding it would take the click-target ring with it, and the
    // instance is not published on window.__supersplatViewer.
    {
        search:
            '    updateCursor(offsetX, offsetY) {\n' +
            '        if (!this.hoverActive || this.navigating) {\n',
        replace:
            '    updateCursor(offsetX, offsetY) {\n' +
            '        if (window.__ssPortalMarkerAt && window.__ssPortalMarkerAt(offsetX, offsetY)) { this.hoverRing.hide(); return; }\n' +
            '        if (!this.hoverActive || this.navigating) {\n'
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
