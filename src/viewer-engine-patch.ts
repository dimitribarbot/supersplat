// Export-time patch for the PlayCanvas engine bundled inside
// @playcanvas/splat-transform's exported viewer (index.js / output.html).
//
// splat-transform 2.7.1 bakes engine 2.20.2, which is missing two gsplat
// streaming fixes shipped upstream by 2.20.5:
//
// - Engine PR #8998 (GSplatAssetLoader): a block load cancelled mid-flight
//   leaves its Asset `loaded === true` with no resource, after which `load()`
//   early-returns forever. The instance's pending/prefetch entry for that file
//   then never completes, so `world.pendingLoadCount` never reaches 0 and the
//   viewer's ready gate (`ready && loading === 0`) never fires: the loading
//   bar parks at ~95%, `firstFrame` (walkthrough autostart) never fires, and
//   `splatBudget` stays 0 (engine budget balancer disabled -> unbounded
//   streaming). Reproduces on single-scene exports with a cold cache. The
//   upstream fix resets such assets on the next `load()` — gated on a new
//   `_failed` URL set so a URL whose retries are exhausted parks instead of
//   re-downloading forever — and re-attaches the consumed 'error' listener on
//   the retry path (a second consecutive failure would wedge the loader).
//
// - Engine PR #9011 (GSplatOctree/GSplatWorld): unloading an octree asset
//   while its instance is still registered in the streaming world races the
//   per-frame update — `ensureFileResource()` runs after `destroy()` nulled
//   `assetLoader`, and the budget pass touches placements of a destroyed
//   octree. The exported viewer's portal companion destroys scene entities in
//   SOG/package mode (unloadScene), which is exactly this race. The upstream
//   fix bails out of `ensureFileResource()` when `assetLoader` is null and
//   sweeps instances of destroyed octrees at the top of `GSplatWorld.update`.
//
// Until splat-transform ships an engine >= 2.20.5, apply the fixes to the
// baked bundle by exact tab-indented string replacement, byte-identical to
// the upstream 2.20.5 build output. Every search pattern was verified to
// occur exactly once in the real splat-transform 2.7.1 bundle. A miss means
// the bundled engine changed shape -- the caller warns, and the injected
// portal companion's ready-gate watchdog remains as the runtime fallback.
// Patches whose search text survives the replacement carry an `applied`
// marker so a second pass is a no-op. Pure and environment-agnostic (also
// compiled for the export server via dist-shared).
//
// Additional fork-specific patches (NOT upstream backports) live at the end of
// the list. One adds a spawn-preserving `reseat()` method to the viewer's
// CameraManager; two more (see their own comment block below) ground VR/AR
// entry to the floor beneath the camera instead of world Y=0. The
// off-limits-zones companion clamps the walk camera by setting a safe pose and
// re-seating the active controller. It previously used `snap()`, but snap()
// re-runs the controller's `onEnter()`, which re-captures the walk/fly reset
// spawn at the current (wall-clamped) position -- so being blocked overwrote
// the reset spawn to the wall and pressing R (resetToSpawn) returned there.
// `reseat()` is snap() with `onEnter()` swapped for `goto()`, which re-seats
// position/angles WITHOUT grounding or storing the spawn, so native reset is
// left intact. The companion prefers `reseat()` and falls back to `snap()`
// when this patch did not apply (older/newer bundle). This part of the viewer
// (the app, not the engine) is 4-space indented, hence the spaces below.

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
    // --- PR #8998 + upstream _failed bookkeeping (GSplatAssetLoader) ---
    {
        // field declaration
        search:
            '\t_retryCount = /* @__PURE__ */ new Map();\n' +
            '\t_destroyed = false;\n',
        replace:
            '\t_retryCount = /* @__PURE__ */ new Map();\n' +
            '\t_failed = /* @__PURE__ */ new Set();\n' +
            '\t_destroyed = false;\n'
    },
    {
        // destroy() clears the set
        search:
            '\t\tthis._retryCount.clear();\n' +
            '\t}\n',
        replace:
            '\t\tthis._retryCount.clear();\n' +
            '\t\tthis._failed.clear();\n' +
            '\t}\n'
    },
    {
        // load(): reset a cancelled loaded-but-resourceless asset so it retries
        search:
            '\tload(url) {\n' +
            '\t\tconst asset = this._urlToAsset.get(url);\n' +
            '\t\tif (asset?.loaded || this._currentlyLoading.has(url)) {\n',
        replace:
            '\tload(url) {\n' +
            '\t\tconst asset = this._urlToAsset.get(url);\n' +
            '\t\tif (asset && asset.loaded && !asset.resource && !this._currentlyLoading.has(url) && !this._failed.has(url)) {\n' +
            '\t\t\tasset.loaded = false;\n' +
            '\t\t}\n' +
            '\t\tif (asset?.loaded || this._currentlyLoading.has(url)) {\n'
    },
    {
        // retry path re-attaches the consumed error listener
        search:
            '\t\t\tthis._retryCount.set(url, retryCount + 1);\n' +
            '\t\t\tasset.loaded = false;\n' +
            '\t\t\tasset.loading = false;\n' +
            '\t\t\tthis._registry.load(asset);\n',
        replace:
            '\t\t\tthis._retryCount.set(url, retryCount + 1);\n' +
            '\t\t\tasset.loaded = false;\n' +
            '\t\t\tasset.loading = false;\n' +
            '\t\t\tasset.once("error", (retryErr) => this._onAssetLoadError(url, asset, retryErr));\n' +
            '\t\t\tthis._registry.load(asset);\n'
    },
    {
        // retries exhausted: park the URL
        search:
            '\t\t} else {\n' +
            '\t\t\tthis._currentlyLoading.delete(url);\n' +
            '\t\t\tthis._retryCount.delete(url);\n' +
            '\t\t\tthis._processQueue();\n' +
            '\t\t}\n',
        replace:
            '\t\t} else {\n' +
            '\t\t\tthis._currentlyLoading.delete(url);\n' +
            '\t\t\tthis._retryCount.delete(url);\n' +
            '\t\t\tthis._failed.add(url);\n' +
            '\t\t\tthis._processQueue();\n' +
            '\t\t}\n'
    },
    {
        // unload() un-parks the URL
        search:
            '\t\tthis._retryCount.delete(url);\n' +
            '\t\tconst asset = this._urlToAsset.get(url);\n',
        replace:
            '\t\tthis._retryCount.delete(url);\n' +
            '\t\tthis._failed.delete(url);\n' +
            '\t\tconst asset = this._urlToAsset.get(url);\n'
    },
    {
        // hasFailed accessor (upstream public API)
        search:
            '\t\treturn asset?.resource;\n' +
            '\t}\n',
        replace:
            '\t\treturn asset?.resource;\n' +
            '\t}\n' +
            '\thasFailed(url) {\n' +
            '\t\treturn this._failed.has(url);\n' +
            '\t}\n',
        applied: '\thasFailed(url) {\n'
    },
    // --- PR #9011 (GSplatOctree.ensureFileResource / GSplatWorld.update) ---
    {
        search:
            '\tensureFileResource(fileIndex) {\n' +
            '\t\tif (this.fileResources.has(fileIndex)) {\n',
        replace:
            '\tensureFileResource(fileIndex) {\n' +
            '\t\tif (!this.assetLoader) {\n' +
            '\t\t\treturn;\n' +
            '\t\t}\n' +
            '\t\tif (this.fileResources.has(fileIndex)) {\n'
    },
    {
        search:
            '\tupdate(camera, allowLodUpdate, requireCenters, result) {\n' +
            '\t\tresult.newVersion = false;\n' +
            '\t\tresult.overdrawDirty = false;\n' +
            '\t\tresult.sortNeeded = false;\n',
        replace:
            '\tupdate(camera, allowLodUpdate, requireCenters, result) {\n' +
            '\t\tresult.newVersion = false;\n' +
            '\t\tresult.overdrawDirty = false;\n' +
            '\t\tresult.sortNeeded = false;\n' +
            '\t\tfor (const [placement, inst] of this._octreeInstances) {\n' +
            '\t\t\tif (inst.octree.destroyed) {\n' +
            '\t\t\t\tthis._octreeInstances.delete(placement);\n' +
            '\t\t\t\tthis._layerPlacementsDirty = true;\n' +
            '\t\t\t\tthis._placementSetChanged = true;\n' +
            '\t\t\t\tthis._octreeInstancesToDestroy.push(inst);\n' +
            '\t\t\t}\n' +
            '\t\t}\n',
        applied: 'inst.octree.destroyed'
    },
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
