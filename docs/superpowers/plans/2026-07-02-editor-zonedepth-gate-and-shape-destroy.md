# Editor zoneDepth Gate + Portal/Zone Shape Destroy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Series note:** This plan is #4 of a 6-plan series written 2026-07-02 against commit `916666a`. Plans 3, 5, and 6 of the series modify `src/viewer-companion/portals.ts` (this plan does NOT), and earlier plans in the series may have merged before this one executes. Task 0 below re-verifies every file:line anchor; if code has drifted, adapt the snippets to the current code rather than pasting blindly.

**Goal:** Fix two small editor defects with outsized GPU cost: (1) the per-frame zone-depth splat pass runs even when the walls that consume it are hidden (doubling splat rasterization during image/video export of portal-bearing documents), and (2) deleted portal / off-limits-zone shapes are removed from the scene but never destroyed, leaking GPU vertex/index buffers on every delete, undo-of-add, and document load.

**Architecture:** Both fixes are minimal, local editor changes. Fix 1 adds one condition (`scene.offLimitsLayer.enabled`) to the existing gate in `Camera.onPreRender`. Fix 2 calls the existing-but-never-called `shape.destroy()` at the single shape-removal site in each tool's `syncShapes` reconciler, and extends both shape classes' `destroy()` to also destroy their per-instance `ShaderMaterial`.

**Tech Stack:** TypeScript, PlayCanvas engine 2.19.2 (WebGL2), Rollup build, ESLint, Vitest (not applicable here — see Context/Testability).

## Context

### Repo primer (read this if you know nothing about the codebase)

SuperSplat (`C:\Dev\playcanvas\supersplat`) is a browser-based 3D Gaussian-splat editor built on the PlayCanvas engine + PCUI. This fork adds **portals** (multiple scenes in one project; a portal is a doorway rectangle) and **off-limits zones** (blocking wall rectangles). In the editor, both render as translucent quads ("walls") — cyan for portals, red for zones.

Key architecture facts:

- A single event bus (`src/events.ts`, created in `src/main.ts`) wires everything: `events.fire/on` = pub-sub, `events.function/invoke` = queryable state. `events.invoke('portals.list')` / `events.invoke('offLimitsZones.list')` return the current data arrays.
- Scene elements extend `src/element.ts` (lifecycle: `add`/`remove`/`onPreRender`/`serialize`; base `Element.destroy()` at `src/element.ts:36-40` just calls `scene.remove(this)` if still attached — subclasses override it to release resources).
- `src/scene.ts` owns the PlayCanvas app. Rendering is **dirty-driven** (`app.autoRender = false`, `src/scene.ts:129`): idle frames render nothing; camera motion, gizmo drags, and export loops each mark the scene dirty and pay for a render.
- Undo/redo: mutations are op objects fired via `events.fire('edit.add', op)`. Undoing an "add portal" op removes the portal from the data list and fires `portals.changed`.
- `window.scene` is exposed globally (`src/main.ts:277`) — used by the manual verification steps below.
- Dev server: `npm run develop` → http://localhost:3333 (debug build + watch; refresh browser manually).

### How walls render (shared by both defects)

- `src/scene.ts:211` creates a dedicated layer: `this.offLimitsLayer = new Layer({ name: 'OffLimits' })`. Portals AND off-limits zones both render on this one layer (see `layers: [this.scene.offLimitsLayer.id]` at `src/portal-shape.ts:86` and `src/off-limits-zone-shape.ts:86`).
- `src/camera.ts:595-597`: the camera's `zonePass` draws `scene.offLimitsLayer` into the main target after the splats.
- The wall fragment shader does **manual** depth testing against a per-frame splat-depth texture (`zoneDepthTex`). That texture is produced by `Camera.renderZoneDepth()` (`src/camera.ts:686-708`), which re-renders **the entire splat layer** through a `RenderPassPicker` in depth-estimation mode into `zoneDepthTarget`. This is roughly a full second splat rasterization pass.

### Defect 1 — zoneDepth pass runs when walls are invisible ([MED][perf])

`Camera.onPreRender` (`src/camera.ts:710-723`) gates the extra pass only on the *existence* of portals/zones:

```ts
    onPreRender() {
        this.rebuildRenderTargets();
        this.updateCameraUniforms();

        // Off-limits walls and portals share the zone shader, which needs a
        // per-frame splat depth texture to test against. Only pay the extra
        // splat render when at least one zone or portal exists.
        const zoneCount = (this.scene.events.invoke('offLimitsZones.list') as unknown[])?.length ?? 0;
        const portalCount = (this.scene.events.invoke('portals.list') as unknown[])?.length ?? 0;
        if (zoneCount > 0 || portalCount > 0) {
            this.renderZoneDepth();
            this.scene.graphicsDevice.scope.resolve('zoneDepthTex').setValue(this.zoneDepthBuffer);
        }
    }
```

But `src/render.ts` disables the layer during image/video export when the "Show Debug Overlays" toggle is off (`showDebug === false`, the default):

- `src/render.ts:130` (image export): `scene.offLimitsLayer.enabled = showDebug;` — restored to `true` in the `finally` at `src/render.ts:180`.
- `src/render.ts:250` (video export): same, restored at `src/render.ts:410`.

With the layer disabled, PlayCanvas skips the `zonePass` entirely (that is how the existing "hide walls in export" feature works), so the wall shader never samples `zoneDepthTex` — yet `onPreRender` still runs the full extra splat pass **for every exported frame**. A video export of a portal-bearing document pays ~2× splat rasterization per frame for a texture nothing reads.

**Which states enable/disable `offLimitsLayer.enabled` (exhaustive — verified by grep over `src/`):**

| State | `enabled` | Walls drawn? |
|---|---|---|
| Default (constructed `src/scene.ts:211`; engine `Layer` defaults `_enabled = true`) | `true` | yes |
| Image export, Show Debug off (`render.ts:130` → restore `:180`) | `false` | no |
| Video export, Show Debug off (`render.ts:250` → restore `:410`) | `false` | no |
| `render.offscreen` (`render.ts:79`, doc poster capture) — does NOT touch the layer | `true` | yes |

There are no other writers. Therefore `scene.offLimitsLayer.enabled` is *exactly* "walls will be drawn this frame", and it is the correct — and complete — gate condition. No other visibility signal applies: `scene.camera.renderOverlays` does **not** gate the `zonePass` (walls draw regardless of it), so it must not be added to this gate.

**Fix:** add `&& this.scene.offLimitsLayer.enabled` to the gate. (`this.scene` is the correct property path inside `Camera` — the same method already uses `this.scene.events` and `this.scene.graphicsDevice`.)

### Defect 2 — deleted shapes are never destroyed: GPU buffer leak ([MED][memory])

Each portal/zone in the data model gets a visual quad: `PortalShape` (`src/portal-shape.ts`) / `OffLimitsZoneShape` (`src/off-limits-zone-shape.ts`). Each shape's `add()` news its own `ShaderMaterial`, `Mesh` (one quad: vertex + index buffer on the GPU), and `MeshInstance`, and parents an `Entity` (`pivot`) with a render component.

Each tool reconciles shapes against the data in a `syncShapes` function — **the only place shapes are ever removed** in either tool (verified: `scene.remove(` appears exactly once per tool; tool `deactivate()` intentionally keeps shapes visible while other tools are active). `src/tools/portal-tool.ts:714-723`:

```ts
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
```

and identically at `src/tools/off-limits-zone-tool.ts:453-462`. `Scene.remove` (`src/scene.ts:277-291`) only calls `element.remove()`, which detaches the pivot from the graph (`src/portal-shape.ts:92-94`). `PortalShape.destroy()` (`src/portal-shape.ts:96-98`, currently just `this.pivot?.destroy()`) is **never called by anyone** — same for `OffLimitsZoneShape.destroy()`.

Why this is a real GPU leak and not just GC pressure (verified in `node_modules/playcanvas/build/playcanvas.dbg.mjs`, engine 2.19.2):

- `VertexBuffer`/`IndexBuffer` constructors register themselves in the graphics device's global `device.buffers` `Set`; only their `destroy()` removes them. An undestroyed mesh's buffers stay registered (and their WebGL buffers allocated) **forever**, unreachable by JS GC.
- The destroy chain that releases them: `entity.destroy()` → `RenderComponent.onRemove()` → `destroyMeshInstances()` → `meshInstance.destroy()` → mesh refcount hits 0 → `mesh.destroy()` → vertex + index buffers destroyed and removed from `device.buffers`. So the existing `this.pivot?.destroy()` **does** release the Entity, MeshInstance, and Mesh GPU buffers — it just needs to be called.
- The material is NOT destroyed by that chain (`meshInstance.destroy()` only deregisters itself from it). Each shape news its own `ShaderMaterial`, so add `this.material?.destroy()` to the shapes' `destroy()`. Note: the compiled shader *program* is shared via the device program library (`ShaderMaterial.getShaderVariant` → `getProgramLibrary(device).getProgram('shader-material', ...)`, keyed by the material's `uniqueName` + options), so there is no per-shape program leak — `material.destroy()` is cheap hygiene that drops the material's shader-variant references and matches engine guidance. Calling it *after* `pivot.destroy()` is safe: by then `meshInstance.destroy()` has already deregistered the mesh instance (`set material` calls `prevMat.removeMeshInstanceRef(this)`), so `material.destroy()` iterates an empty set.

Contrast with the codebase's own correct pattern: `Scene.clear` (`src/scene.ts:252-258`) calls `this.remove(splat)` **then** `splat.destroy()` on every splat; `Splat.destroy()` (`src/splat.ts:287-292`) destroys its entity and unloads its asset. The shapes' removal site must do the same: `scene.remove(shape); shape.destroy();`. (Order matters: remove first — `scene.remove` fires `scene.elementRemoved` and calls `element.remove()`, which expects a live pivot.)

Every leak path funnels through `syncShapes`: portal/zone delete, undo-of-add, redo-of-delete, and document load/reset all mutate the data list and fire `portals.changed` / `offLimitsZones.changed`, which the tools handle by calling `syncShapes`. Fixing the one reconciler line per tool fixes all paths.

### Testability

Neither fix is unit-testable in Node vitest: both are coupled to the PlayCanvas engine and the WebGL2 graphics device (render passes, layers, entities, GPU buffers), and the repo's vitest setup runs in a Node environment with no engine or GPU. Verification is therefore: `npm run lint` + `npm run build` (typecheck) per task, plus the scripted manual verification in Task 3 with exact console expressions and expected observations. Neither fix touches `src/viewer-companion/` (no stringification constraints apply); the debug build (`npm run develop`) is sufficient for E2E.

## Global Constraints

- Use Bash (Git Bash on Windows), never PowerShell. Run commands plainly from the repo root — no `cd`, `git -C`, or `npm --prefix` prefixes (they trigger permission prompts).
- ESLint is pinned to v10 and **crashes on `import/order` autofix** — never run `eslint --fix` for import ordering; match surrounding import order by hand (neither task adds imports).
- Never delete `package-lock.json`.
- `tsconfig`: `strictNullChecks: false`, `noImplicitAny: true`. Match surrounding code style; comments explain constraints, not narration.
- Don't touch code unrelated to the task.
- Work on a feature branch; when complete and verified, squash to a single commit (Task 4).
- **Out of scope — do not implement:** lazy allocation of `zoneDepthBuffer`, hoisting the per-frame `new Color` in `renderZoneDepth`, any dedup/shared-base-class refactor between `portal-tool.ts`/`off-limits-zone-tool.ts` or the two shape classes.

---

### Task 0: Preflight — verify anchors and create the branch

**Files:**
- None modified.

**Interfaces:**
- Consumes: git repo at `C:\Dev\playcanvas\supersplat`, expected near commit `916666a` (later series plans may have landed — that is fine as long as the anchors below still match).
- Produces: feature branch `fix/zonedepth-gate-and-shape-destroy` with all anchors confirmed.

- [ ] **Step 1: Confirm every code anchor this plan edits or relies on still exists**

Run each grep; every one must print at least one match. If any prints nothing, STOP and re-locate the drifted code (search for the surrounding identifiers), then adapt the corresponding task's snippet to the current code.

```bash
grep -n "if (zoneCount > 0 || portalCount > 0) {" src/camera.ts
grep -n "renderZoneDepth" src/camera.ts
grep -n "scene.offLimitsLayer.enabled = showDebug" src/render.ts
grep -n "scene.remove(shape);" src/tools/portal-tool.ts
grep -n "scene.remove(shape);" src/tools/off-limits-zone-tool.ts
grep -n "this.pivot?.destroy();" src/portal-shape.ts
grep -n "this.pivot?.destroy();" src/off-limits-zone-shape.ts
grep -n "window.scene = scene" src/main.ts
```

Expected (line numbers may drift slightly; content must match):

```
src/camera.ts:719:        if (zoneCount > 0 || portalCount > 0) {
src/camera.ts:686 + 720 (declaration + call site)
src/render.ts:130 + 250
src/tools/portal-tool.ts:720
src/tools/off-limits-zone-tool.ts:459
src/portal-shape.ts:97
src/off-limits-zone-shape.ts:97
src/main.ts:277
```

- [ ] **Step 2: Create the feature branch from up-to-date main**

```bash
git status
git checkout main
git checkout -b fix/zonedepth-gate-and-shape-destroy
```

Expected: `git status` clean before branching; new branch created.

---

### Task 1: Gate the zoneDepth pass on `offLimitsLayer.enabled`

**Files:**
- Modify: `src/camera.ts:710-723` (the `onPreRender` method)

**Interfaces:**
- Consumes: `this.scene.offLimitsLayer` — a PlayCanvas `Layer` with a boolean `enabled` property; `true` by default, set `false` only during image/video export with Show Debug off (`src/render.ts:130`, `:250`; always restored in `finally`).
- Produces: no new interfaces. Behavior change only: `renderZoneDepth()` (and the `zoneDepthTex` uniform bind) is skipped whenever the layer that draws the walls is disabled.

- [ ] **Step 1: Edit `src/camera.ts` `onPreRender`**

This code is engine-coupled rendering and not unit-testable in Node vitest (see Context/Testability) — verification is lint + build here, plus the scripted manual check in Task 3.

Replace the current gate (exact current code shown first):

```ts
        // Off-limits walls and portals share the zone shader, which needs a
        // per-frame splat depth texture to test against. Only pay the extra
        // splat render when at least one zone or portal exists.
        const zoneCount = (this.scene.events.invoke('offLimitsZones.list') as unknown[])?.length ?? 0;
        const portalCount = (this.scene.events.invoke('portals.list') as unknown[])?.length ?? 0;
        if (zoneCount > 0 || portalCount > 0) {
            this.renderZoneDepth();
            this.scene.graphicsDevice.scope.resolve('zoneDepthTex').setValue(this.zoneDepthBuffer);
        }
```

with:

```ts
        // Off-limits walls and portals share the zone shader, which needs a
        // per-frame splat depth texture to test against. Only pay the extra
        // splat render when at least one zone or portal exists AND the layer
        // that draws them is enabled (render.ts disables it during image/video
        // export when Show Debug is off; the walls aren't drawn then, so the
        // depth pass would feed a shader that never runs).
        const zoneCount = (this.scene.events.invoke('offLimitsZones.list') as unknown[])?.length ?? 0;
        const portalCount = (this.scene.events.invoke('portals.list') as unknown[])?.length ?? 0;
        if ((zoneCount > 0 || portalCount > 0) && this.scene.offLimitsLayer.enabled) {
            this.renderZoneDepth();
            this.scene.graphicsDevice.scope.resolve('zoneDepthTex').setValue(this.zoneDepthBuffer);
        }
```

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: exits 0, no new errors.

- [ ] **Step 3: Build (typecheck)**

Run: `npm run build`
Expected: Rollup completes and writes `dist/` with no TypeScript errors. (Warnings that already exist on main are acceptable.)

- [ ] **Step 4: Commit**

```bash
git add src/camera.ts
git commit -m "fix(camera): skip zoneDepth splat pass when off-limits layer is disabled

The zoneDepthTex pass re-rendered all splats every rendered frame
whenever any portal or off-limits zone existed, even during image/video
export with Show Debug off, where render.ts disables offLimitsLayer and
the wall shader that consumes the texture never runs. Gate the pass on
scene.offLimitsLayer.enabled, which is exactly 'walls drawn this frame'
(default true; false only inside the export try/finally blocks).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Destroy portal / off-limits-zone shapes on removal

**Files:**
- Modify: `src/tools/portal-tool.ts:714-723` (`syncShapes` removal loop)
- Modify: `src/tools/off-limits-zone-tool.ts:453-462` (`syncShapes` removal loop)
- Modify: `src/portal-shape.ts:96-98` (`destroy()`)
- Modify: `src/off-limits-zone-shape.ts:96-98` (`destroy()`)

**Interfaces:**
- Consumes: `Scene.remove(element)` (`src/scene.ts:277-291`, detaches only), `Entity.destroy()` / `Material.destroy()` (PlayCanvas 2.19.2; see Context for the verified release chain).
- Produces: no new interfaces. `PortalShape.destroy()` / `OffLimitsZoneShape.destroy()` now also destroy the per-instance `ShaderMaterial`; both tools call `shape.destroy()` after `scene.remove(shape)`.

- [ ] **Step 1: Call `shape.destroy()` at the portal tool's removal site**

This code is engine-coupled (entities, GPU buffers) and not unit-testable in Node vitest — verification is lint + build here, plus the scripted heap/buffer check in Task 3.

In `src/tools/portal-tool.ts`, inside `syncShapes`, replace:

```ts
            // remove shapes for deleted portals
            for (const [id, shape] of shapes) {
                if (!liveIds.has(id)) {
                    scene.remove(shape);
                    shapes.delete(id);
                }
            }
```

with:

```ts
            // remove shapes for deleted portals
            for (const [id, shape] of shapes) {
                if (!liveIds.has(id)) {
                    // remove() only detaches; destroy() releases the entity,
                    // mesh GPU buffers and material (mirrors scene.clear()).
                    scene.remove(shape);
                    shape.destroy();
                    shapes.delete(id);
                }
            }
```

- [ ] **Step 2: Same change at the off-limits-zone tool's removal site**

In `src/tools/off-limits-zone-tool.ts`, inside `syncShapes`, replace:

```ts
            // remove shapes for deleted zones
            for (const [id, shape] of shapes) {
                if (!liveIds.has(id)) {
                    scene.remove(shape);
                    shapes.delete(id);
                }
            }
```

with:

```ts
            // remove shapes for deleted zones
            for (const [id, shape] of shapes) {
                if (!liveIds.has(id)) {
                    // remove() only detaches; destroy() releases the entity,
                    // mesh GPU buffers and material (mirrors scene.clear()).
                    scene.remove(shape);
                    shape.destroy();
                    shapes.delete(id);
                }
            }
```

These are the only two shape-removal sites in the codebase (verified: `grep -n "scene.remove(shape)" src/tools/*.ts` matches exactly these two lines; tool `deactivate()` deliberately keeps shapes alive so walls stay visible while other tools are active, and doc-load/undo/redo all funnel through these reconcilers via the `*.changed` events).

- [ ] **Step 3: Extend `PortalShape.destroy()` to destroy the material**

In `src/portal-shape.ts`, replace:

```ts
    destroy() {
        this.pivot?.destroy();
    }
```

with:

```ts
    destroy() {
        // Entity destroy releases the render component, mesh instance and the
        // mesh's GPU vertex/index buffers (the mesh is refcounted and this is
        // its only instance). The material is not part of that chain — each
        // shape news its own, so destroy it here too. Safe pre-add: all fields
        // but pivot are set in add().
        this.pivot?.destroy();
        this.material?.destroy();
    }
```

- [ ] **Step 4: Same change in `OffLimitsZoneShape.destroy()`**

In `src/off-limits-zone-shape.ts`, replace:

```ts
    destroy() {
        this.pivot?.destroy();
    }
```

with:

```ts
    destroy() {
        // Entity destroy releases the render component, mesh instance and the
        // mesh's GPU vertex/index buffers (the mesh is refcounted and this is
        // its only instance). The material is not part of that chain — each
        // shape news its own, so destroy it here too. Safe pre-add: all fields
        // but pivot are set in add().
        this.pivot?.destroy();
        this.material?.destroy();
    }
```

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: exits 0, no new errors.

- [ ] **Step 6: Build (typecheck)**

Run: `npm run build`
Expected: Rollup completes with no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add src/tools/portal-tool.ts src/tools/off-limits-zone-tool.ts src/portal-shape.ts src/off-limits-zone-shape.ts
git commit -m "fix(tools): destroy portal/off-limits shapes on removal (GPU buffer leak)

syncShapes removed deleted shapes with scene.remove() only, which
detaches but never destroys: the entity kept its render component, and
the quad mesh's vertex/index buffers stayed registered in
device.buffers forever — one leak per portal/zone delete, undo-of-add
and doc load. Call shape.destroy() after scene.remove() (the pattern
scene.clear() uses for splats) and extend both shapes' destroy() to
also destroy their per-instance ShaderMaterial, which the entity
destroy chain does not release.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Manual E2E verification (both fixes)

**Files:**
- None modified.

**Interfaces:**
- Consumes: the debug dev build (`npm run develop`, http://localhost:3333), a Chromium-based browser with DevTools, and any splat file (`.ply` / `.sog` / `.ssproj`) to load. The global `scene` object (`window.scene`, set in `src/main.ts:277`) provides all console observables. Neither fix touches `src/viewer-companion/`, so a debug build is sufficient — no release-build E2E requirement applies.

**Setup (once):**

- [ ] **Step 1: Start the dev server and load a scene**

```bash
npm run develop
```

Open http://localhost:3333 in Chrome/Edge. Drag-and-drop any `.ply` splat file onto the canvas (any Gaussian splat file works; larger files make the perf difference in Step 5 more visible). Open DevTools (F12) → Console.

**Destroy fix (do this first — it is quick):**

- [ ] **Step 2: Record the GPU-buffer baseline**

In the DevTools console run:

```js
scene.graphicsDevice.buffers.size
```

Note the number (call it `B`). `buffers` is the engine's live registry of every vertex/index/storage buffer on the device; each wall quad owns exactly 2 entries (1 vertex + 1 index buffer). Also record:

```js
scene.graphicsDevice._vram.vb + scene.graphicsDevice._vram.ib
```

- [ ] **Step 3: Add/delete a portal repeatedly and confirm no growth**

1. Click the **portal tool** button in the bottom toolbar (DOM id `bottom-toolbar-portals`, near the right end, before the coord-space toggle; hover tooltips identify it). A floating toolbar appears above the canvas.
2. Click **Add** in that toolbar → a cyan translucent quad appears (it is auto-created selected; if not highlighted, click it once on the canvas to select it — selected = brighter).
3. Press **Delete** → the quad disappears.
4. In the console re-check `scene.graphicsDevice.buffers.size`.
5. Repeat the add+delete cycle **20 times** (each cycle is two clicks + Delete), then re-check.

Expected (fixed): `buffers.size` returns to `B` after every delete; after 20 cycles it is still exactly `B`, and `_vram.vb + _vram.ib` is back to its baseline. Broken behavior (pre-fix, for reference): `buffers.size` grew by 2 per cycle (`B+40` after 20 cycles).

6. Undo/redo regression check: **Add** a portal, press **Delete**, then Ctrl+Z (undo → portal re-appears, `buffers.size` = `B+2`), then redo (Ctrl+Shift+Z → portal disappears, `buffers.size` = `B`). The re-added portal must render normally (cyan quad, selectable, gizmo attaches) and the console must show no errors — this proves `destroy()` on the old shape doesn't poison the fresh shape created on undo.

- [ ] **Step 4: Repeat for an off-limits zone**

Click the **off-limits tool** button (DOM id `bottom-toolbar-off-limits`, immediately left of the portal button), click **Add** (red quad), press **Delete**, cycle 20×, and check `scene.graphicsDevice.buffers.size` returns to baseline each time, with the same undo/redo spot-check. Expected: identical no-growth behavior.

(Optional deeper check: DevTools → Memory tab → take a heap snapshot before and after the 20 cycles, filter the class list for `Mesh` / `MeshInstance` / `ShaderMaterial` — counts should not grow between snapshots. The `buffers.size` check above is the authoritative, deterministic observable; the heap snapshot is corroboration only.)

**Gate fix:**

- [ ] **Step 5: Direct gate check — zoneDepth pass stops when the layer is disabled**

With exactly one portal present (add one via the portal tool, then click an empty toolbar area or switch to another tool — the wall stays visible by design), run in the console:

```js
const cam = scene.camera;
const origRZD = cam.renderZoneDepth.bind(cam);
cam.renderZoneDepth = () => { console.count('zoneDepth'); origRZD(); };
```

1. Orbit the camera (left-drag on the canvas). Expected: `zoneDepth: N` counts climb in the console while the camera moves (the pass runs on every dirty frame — this proves the instrumentation works).
2. Now simulate what export does:

```js
scene.offLimitsLayer.enabled = false; scene.forceRender = true;
```

Orbit again. Expected (fixed): the wall disappears AND **no new `zoneDepth` counts appear** while orbiting. Broken behavior (pre-fix): counts kept climbing with the wall invisible.
3. Restore and confirm the pass resumes:

```js
scene.offLimitsLayer.enabled = true; scene.forceRender = true;
```

Expected: the wall re-appears, correctly occluded by splats in front of it (this proves the gate didn't starve the wall shader of `zoneDepthTex`), and counts resume while orbiting. Refresh the page afterwards to drop the monkey-patch.

(Alternative/corroborating profiler check: DevTools → Performance tab → record ~5 s while orbiting, stop, and compare the GPU track density between step 1 and step 2 — the disabled-layer recording shows roughly half the GPU work per frame on splat-heavy scenes. The `console.count` check is the exact, binary observable; use the profiler only if you want to see the magnitude.)

- [ ] **Step 6: Export-time check — video render cost with vs without a portal**

1. With one portal in the scene: menu (top-left) → **Render** → **Video**. In the dialog leave **Show Debug Overlays** OFF (its default), keep default resolution/duration, click OK, pick a save location. Time the render (progress bar wall-clock; a stopwatch is fine).
2. Verify the resulting video shows **no** portal wall (existing behavior, must not regress).
3. Delete the portal (portal tool → click wall → Delete). Render a video again with identical settings. Time it.

Expected (fixed): the two render times are approximately equal (within normal run-to-run noise, ~±10%). Broken behavior (pre-fix): the portal-bearing render was noticeably slower (~up to 2× splat cost per frame).

4. Regression: render one more video with **Show Debug Overlays** ON and a portal present. Expected: the wall IS visible in the video and correctly occluded by splats in front of it (layer enabled ⇒ gate open ⇒ depth texture still produced).

- [ ] **Step 7: Stop the dev server**

Ctrl+C the `npm run develop` process.

---

### Task 4: Final verification and squash

**Files:**
- None modified (git operations only).

**Interfaces:**
- Consumes: the two commits from Tasks 1–2 on `fix/zonedepth-gate-and-shape-destroy`, and a completed Task 3 checklist.

- [ ] **Step 1: Run the full verification suite**

```bash
npm run lint
npm run test
npm run build
```

Expected: lint exits 0; all existing vitest suites pass (this plan adds no tests — the fixes are engine-coupled; the suites guard against accidental regressions in the pure modules); build completes.

- [ ] **Step 2: Confirm Task 3 observations are recorded**

Do not proceed unless every Expected in Task 3 was actually observed (buffer counts flat over 20 cycles for BOTH tools, zoneDepth counts stopping with the layer disabled, ~equal video render times, and both regression checks). Evidence before assertions.

- [ ] **Step 3: Squash per project convention**

Project convention: when the feature is complete and verified, squash all branch commits into a single commit summarizing the change. Use the finishing skill (superpowers:finishing-a-development-branch) to do this. Suggested squashed message:

```
fix(editor): gate zoneDepth pass on layer visibility + destroy removed portal/zone shapes

Two editor fixes with outsized GPU cost:

- camera.ts onPreRender ran the full extra splat depth pass
  (renderZoneDepth) whenever any portal/off-limits zone existed, even
  while render.ts had disabled offLimitsLayer for image/video export
  with Show Debug off — every exported frame paid ~2x splat
  rasterization feeding a shader that never ran. The pass is now also
  gated on scene.offLimitsLayer.enabled (exactly "walls drawn this
  frame": default true, false only inside the export try/finally).

- Both tools' syncShapes reconcilers removed deleted shapes with
  scene.remove() only, never calling shape.destroy(): the quad mesh's
  vertex/index buffers stayed registered in device.buffers forever —
  one GPU leak per delete, undo-of-add and doc load. Shapes are now
  destroyed on removal (the scene.clear() pattern), and both shape
  classes' destroy() also destroys their per-instance ShaderMaterial,
  which the entity destroy chain does not release.

Not unit-testable (engine/GPU-coupled); verified manually: device
buffer count flat over 20 add/delete cycles for both tools, zoneDepth
pass provably skipped while the layer is disabled, video render time
with a portal now ~equal to without.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Self-review (completed by plan author)

1. **Spec coverage:** gate fix incl. exact property path + documented enable/disable states → Task 1 + Context table; destroy fix in BOTH tools at ALL removal sites (exactly one per tool, verified by grep) → Task 2 Steps 1-2; `destroy()` release semantics verified against playcanvas 2.19.2 and extended for the material → Task 2 Steps 3-4 + Context; not-unit-testable stated + lint/build substitution → Context/Testability + Tasks 1-2; scripted manual task per fix with exact console expressions → Task 3; separate commits per fix → Tasks 1/2; final lint+test+squash → Task 4; out-of-scope items listed → Global Constraints. ✓
2. **Placeholder scan:** no TBDs; every code step shows complete before/after code from the real source. ✓
3. **Type consistency:** only existing members used (`scene.offLimitsLayer.enabled`, `shape.destroy()`, `this.material?.destroy()`); the two shape edits are intentionally identical. ✓
4. **Stringification audit:** no `src/viewer-companion/` files touched — constraint not applicable. ✓
