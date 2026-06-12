# Off-Limits Zone Wall Occlusion (smooth + see-through + occluded) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the editor's off-limits zone wall render as a smooth, semi-transparent panel that shows splats *behind* it yet is correctly occluded by splats *in front* of it.

**Architecture:** Splats don't write a usable depth buffer, so we render the wall *after* the splat color pass and depth-test each wall fragment against a per-frame **splat depth texture**. That texture is produced by re-rendering the splats in the engine's existing "depth estimation" pick mode (alpha-weighted normalized depth, R channel; transmittance, A channel — see `src/shaders/splat-shader.ts:94-100` and `src/picker.ts:174-204,206-240`). Splats behind the wall are already composited into the color buffer, so the wall alpha-blends smoothly over them (see-through); splats in front have a nearer depth, so the wall fragment is discarded (occluded). This is editor-only; the exported viewer is untouched (it uses analytic collision).

**Tech Stack:** TypeScript, PlayCanvas engine (`RenderPassForward`, `RenderPassPicker`, `RenderTarget`, `Texture`, `ShaderMaterial`, GLSL), the project's `Scene`/`Camera`/`Element` framework.

**Verification note (read first):** This is a GPU/visual feature. There is no WebGL context in vitest, so it CANNOT be unit-tested. Automated checks are limited to `npm run build` and `npx eslint src`. Correctness is verified by Dimitri in the editor (`npm run develop`). Each task ends with an explicit "ask Dimitri to verify" checkpoint. Two engine details are flagged as **VALIDATE** because they depend on engine internals the author cannot self-verify; the spike (Task 2) exists to confirm them before building on top.

---

## File Structure

- `src/camera.ts` (modify) — owns a new `zoneDepthTarget` (RGBA16F), runs a per-frame splat-depth render into it when zones exist, adds a `zonePass` to `framePasses`, and binds the depth texture + camera params as global shader scope values.
- `src/scene.ts` (modify) — adds a dedicated `offLimitsLayer` so the wall renders in its own pass between splats and gizmos.
- `src/shaders/off-limits-zone-shader.ts` (modify) — wall vertex shader passes view-space Z; fragment shader samples the splat depth texture, reconstructs the splat's normalized linear depth, and discards the wall fragment where it is behind the splat surface.
- `src/off-limits-zone-shape.ts` (modify) — render on `offLimitsLayer`; material does NOT depth-test/-write against the hardware buffer (the test is manual, in-shader); keep alpha blend.
- `src/off-limits-zones.ts` (read only) — provides `offLimitsZones.list` to gate the depth pass (no change).

---

## Task 1: Add the `offLimitsLayer` and move the wall onto it (no occlusion yet)

This isolates the wall into its own render pass so later tasks can control exactly when/where it draws, without disturbing world/splat/gizmo passes. After this task the wall behaves like the current smooth pane (Task 0 baseline), just rendered from a dedicated layer + pass.

**Files:**
- Modify: `src/scene.ts:76-78` (layer fields), `src/scene.ts:206-210` (layer creation/registration)
- Modify: `src/camera.ts:98-102` (pass fields), `src/camera.ts:318-322` (pass construction), `src/camera.ts:304-308` (camera layers list — REQUIRED, the camera only renders layers in this list), `src/camera.ts:537-557` (pass init + framePasses), `src/camera.ts:430-435` (destroy)
- Modify: `src/off-limits-zone-shape.ts:80-83` (render layer)

- [ ] **Step 1: Declare the layer field in Scene**

In `src/scene.ts`, add to the class fields next to `gizmoLayer` (currently `src/scene.ts:78`):

```ts
    worldLayer: Layer;
    splatLayer: Layer;
    gizmoLayer: Layer;
    offLimitsLayer: Layer;
```

- [ ] **Step 2: Create and register the layer**

In `src/scene.ts`, after the gizmo layer is created (currently `src/scene.ts:206`) and before `layers.push(...)` (currently `src/scene.ts:208-210`):

```ts
        // gizmo layer
        this.gizmoLayer = new Layer({ name: 'Gizmo' });

        // off-limits zone layer: renders AFTER splats so the wall can blend over
        // them and be manually depth-tested against the splat depth texture.
        this.offLimitsLayer = new Layer({ name: 'OffLimits' });

        const layers = this.app.scene.layers;
        layers.push(this.splatLayer);
        layers.push(this.offLimitsLayer);
        layers.push(this.gizmoLayer);
```

- [ ] **Step 3: Declare and construct the zone pass in Camera**

In `src/camera.ts`, add the field next to `gizmoPass` (currently `src/camera.ts:101`):

```ts
    gizmoPass: RenderPassForward;
    zonePass: RenderPassForward;
    finalPass: SimpleRenderPass;
```

And construct it next to the others (currently `src/camera.ts:321`):

```ts
        this.gizmoPass = new RenderPassForward(device, composition, app.scene, renderer);
        this.zonePass = new RenderPassForward(device, composition, app.scene, renderer);
```

- [ ] **Step 3b: Add the layer to the camera's layers list (REQUIRED)**

The camera only collects/renders layers present in `mainCamera.camera.layers`. Add the new layer (currently `src/camera.ts:304-308`), ordered to match the pass sequence:

```ts
        this.mainCamera.camera.layers = [
            scene.worldLayer.id,
            scene.splatLayer.id,
            scene.offLimitsLayer.id,
            scene.gizmoLayer.id
        ];
```

Without this, the wall is completely invisible even though the pass and layer exist.

- [ ] **Step 4: Init the zone pass and insert it into framePasses**

In `src/camera.ts`, after the splat pass init block (currently `src/camera.ts:542-545`) and before the gizmo pass init (currently `src/camera.ts:547`):

```ts
            // configure zone pass - off-limits walls, drawn into the main target
            // AFTER the splats (so it blends over splat color) with NO clears
            // (so the shared depth/color from earlier passes is preserved).
            this.zonePass.init(this.mainTarget);
            this.zonePass.addLayer(this.camera, scene.offLimitsLayer, false, false);
            this.zonePass.addLayer(this.camera, scene.offLimitsLayer, true, false);
```

Then update the framePasses array (currently `src/camera.ts:557`):

```ts
            this.camera.framePasses = [this.clearPass, this.mainPass, this.splatPass, this.zonePass, this.gizmoPass, this.finalPass];
```

- [ ] **Step 5: Destroy the pass**

In `src/camera.ts` destroy (currently `src/camera.ts:430-435`), add next to `gizmoPass`:

```ts
        this.gizmoPass?.destroy();
        this.zonePass?.destroy();
```

- [ ] **Step 6: Render the wall on the new layer**

In `src/off-limits-zone-shape.ts`, change the render layer (currently `src/off-limits-zone-shape.ts:82`):

```ts
        this.pivot.addComponent('render', {
            meshInstances: [this.meshInstance],
            layers: [this.scene.offLimitsLayer.id]
        });
```

Leave the material as-is for this task (the plain color shader, `depthTest=true`, `depthWrite=false`). NOTE: with the zone pass sharing `mainTarget`'s depth (written by the world layer only, not splats), the wall will currently NOT be occluded by splats — this is expected until Task 3. It should look like a smooth pane that floats over splats.

- [ ] **Step 7: Build + lint**

Run: `npm run build` — Expected: `created dist` with no TypeScript errors.
Run: `npx eslint src` — Expected: exit 0.

- [ ] **Step 8: Verify with Dimitri**

Ask Dimitri: `npm run develop`, refresh, add a zone. Expected: a smooth translucent red pane appears (no grain), world-anchored. It will still float over splats (occlusion comes in Task 3). Confirm gizmos, selection, and splats all still render normally (the new layer/pass didn't disturb them).

- [ ] **Step 9: Commit**

```bash
git add src/scene.ts src/camera.ts src/off-limits-zone-shape.ts
git commit -m "feat: dedicated off-limits layer + render pass (after splats)"
```

---

## Task 2: Spike — produce a per-frame splat depth texture and visualize it

**Risk-first.** Before wiring real occlusion, prove the splat depth texture is produced correctly by rendering it straight to the wall as grayscale. This validates the two **VALIDATE** unknowns: (a) re-rendering all splats in depth mode into a persistent target each frame, and (b) the depth reconstruction `R / (1 - A)`.

**Files:**
- Modify: `src/camera.ts` — add `zoneDepthBuffer`/`zoneDepthTarget`, a `renderZoneDepth()` method, call it from the frame, bind globals.
- Modify: `src/off-limits-zone-shape.ts` — material samples the depth texture.
- Modify: `src/shaders/off-limits-zone-shader.ts` — temporary debug output.

- [ ] **Step 1: Create the depth render target**

In `src/camera.ts`, where the other targets are created (after `splatTarget`, currently `src/camera.ts:513`), add an RGBA16F target with no depth buffer (mirrors the picker depth target, which is the RGBA16F `colorTarget` per `src/camera.ts:515-519,529`):

```ts
            // off-limits zone depth: per-frame splat depth (R = alpha-weighted
            // normalized depth, A = transmittance), sampled by the wall shader.
            const zoneDepthBuffer = createTexture('zoneDepth', width, height, PIXELFORMAT_RGBA16F);
            this.zoneDepthBuffer = zoneDepthBuffer;
            this.zoneDepthTarget = new RenderTarget({
                colorBuffer: zoneDepthBuffer,
                depth: false,
                flipY: false,
                autoResolve: false
            });
```

Add the fields to the class (near the other render-target fields; search for `splatTarget:` / `colorTarget:` declarations and add alongside):

```ts
    zoneDepthBuffer: Texture;
    zoneDepthTarget: RenderTarget;
```

Add resize handling in the existing resize branch (currently `src/camera.ts:560-565`):

```ts
            splatTarget.resize(width, height);
            this.zoneDepthTarget.resize(width, height);
```

- [ ] **Step 2: Add a per-frame splat-depth render (VALIDATE)**

In `src/camera.ts`, add a method on the `Camera` class. This mirrors `Picker.prepareDepth` (`src/picker.ts:174-204`) but renders ALL splats into our persistent target. It reuses `RenderPassPicker` + the depth accumulation blend state.

```ts
    // Render all splats in depth-estimation mode into zoneDepthTarget.
    // R = sum(normalizedDepth * alpha), A = transmittance; the wall shader
    // reconstructs depth = R / (1 - A). Mirrors Picker.prepareDepth but keeps
    // every splat enabled and targets a persistent buffer.
    renderZoneDepth() {
        const { scene } = this;
        const { app, splatLayer } = scene;

        if (!this.zoneDepthPass) {
            this.zoneDepthPass = new RenderPassPicker(this.device, app.renderer);
            this.zoneDepthBlend = new BlendState(
                true,
                BLENDEQUATION_ADD, BLENDMODE_ONE, BLENDMODE_ONE_MINUS_SRC_ALPHA,
                BLENDEQUATION_ADD, BLENDMODE_ZERO, BLENDMODE_ONE_MINUS_SRC_ALPHA
            );
        }

        this.device.scope.resolve('pickOp').setValue(2);   // 'set' - don't skip visible splats
        this.device.scope.resolve('pickMode').setValue(1); // depth estimation

        this.zoneDepthPass.blendState = this.zoneDepthBlend;
        this.zoneDepthPass.init(this.zoneDepthTarget);
        this.zoneDepthPass.setClearColor(new Color(0, 0, 0, 1)); // depth 0, transmittance 1 (nothing)
        this.zoneDepthPass.update(this.camera, app.scene, [splatLayer], new Map(), false);
        this.zoneDepthPass.render();
    }
```

Add the imports to the existing `playcanvas` import block in `src/camera.ts:1-28` (note `RenderPassPicker` is NOT yet imported there — `BlendState`, the `BLEND*`/`BLENDMODE*` constants must be added too):

```ts
    BLENDEQUATION_ADD,
    BLENDMODE_ONE,
    BLENDMODE_ZERO,
    BLENDMODE_ONE_MINUS_SRC_ALPHA,
    BlendState,
    ...
    RenderPass,
    RenderPassForward,
    RenderPassPicker,
    ...
```

Add the fields:

```ts
    zoneDepthPass: RenderPassPicker;
    zoneDepthBlend: BlendState;
```

> **VALIDATE during this spike:** that `RenderPassPicker(...).update(camera, scene, [splatLayer], map, false)` + `.render()` correctly selects the depth-estimation shader variant when `pickMode=1` is set globally, exactly as `Picker.prepareDepth` relies on. If the engine API differs (constructor args, `update` signature), match whatever `src/picker.ts` currently does verbatim — it is the source of truth.

- [ ] **Step 3: Drive the depth render each frame when zones exist + bind globals**

In `src/camera.ts`, find the camera's per-frame hook (the `onPreRender` method invoked from `src/camera.ts:177`). At the end of it, add:

```ts
        // Off-limits walls need a per-frame splat depth texture to test against.
        // Only pay the extra splat render when at least one zone exists.
        const hasZones = (this.scene.events.invoke('offLimitsZones.list') as any[])?.length > 0;
        if (hasZones) {
            this.renderZoneDepth();
            this.device.scope.resolve('zoneDepthTex').setValue(this.zoneDepthBuffer);
        }
```

> **VALIDATE:** `camera_params` is a standard engine global the splat depth shader reads (`src/shaders/splat-shader.ts:98`). The wall shader will read the same global, so no extra binding should be needed. Confirm during the spike that `camera_params` is populated for the zone pass; if not, bind it explicitly here from the camera's near/far.

- [ ] **Step 4: Point the wall material at the depth texture**

In `src/off-limits-zone-shape.ts`, the material currently uses `depthTest=true, depthWrite=true`. For manual in-shader testing, change to:

```ts
        // Depth test is performed manually in the fragment shader against the
        // splat depth texture, so disable hardware depth test/write here.
        this.material.depthTest = false;
        this.material.depthWrite = false;
```

(Keep the existing alpha `blendState`.)

- [ ] **Step 5: Temporary debug shader — output sampled splat depth as grayscale**

In `src/shaders/off-limits-zone-shader.ts`, replace the contents with:

```ts
const vertexShader = /* glsl */ `
    attribute vec3 vertex_position;
    attribute vec4 vertex_color;

    varying vec4 vColor;

    uniform mat4 matrix_model;
    uniform mat4 matrix_viewProjection;

    void main(void) {
        gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position, 1.0);
        vColor = vertex_color;
    }
`;

const fragmentShader = /* glsl */ `
    precision highp float;

    varying vec4 vColor;

    uniform sampler2D zoneDepthTex;
    uniform vec4 camera_params; // [?, far, near, ?] - same as splat-shader

    void main(void) {
        // DEBUG (Task 2 only): show the reconstructed splat depth as grayscale.
        vec2 uv = gl_FragCoord.xy / vec2(textureSize(zoneDepthTex, 0));
        vec4 d = texture2D(zoneDepthTex, uv);
        float transmittance = d.a;
        float splatNormDepth = (transmittance < 1.0) ? d.r / (1.0 - transmittance) : 1.0;
        gl_FragColor = vec4(vec3(splatNormDepth), 1.0);
    }
`;

export { vertexShader, fragmentShader };
```

- [ ] **Step 6: Build + lint**

Run: `npm run build` — Expected: `created dist`, no TS errors.
Run: `npx eslint src` — Expected: exit 0.

- [ ] **Step 7: Verify with Dimitri (the spike checkpoint)**

Ask Dimitri: `npm run develop`, refresh, add a zone over a splat scene. Expected: the wall shows a grayscale gradient — darker where splats are nearer the camera, lighter where farther/empty. If it's a flat single color or garbage, the depth texture isn't being produced — STOP and debug via `superpowers:systematic-debugging` before proceeding (re-check the **VALIDATE** points: pick pass variant selection, and `R/(1-A)` reconstruction).

- [ ] **Step 8: Commit (spike)**

```bash
git add src/camera.ts src/off-limits-zone-shape.ts src/shaders/off-limits-zone-shader.ts
git commit -m "spike: per-frame splat depth texture visualized on off-limits wall"
```

---

## Task 3: Real occlusion — discard wall fragments behind splats, smooth blend otherwise

Replace the debug output with the actual test: compute the wall's own normalized linear depth and discard where it is behind the splat surface; otherwise output the wall color (smooth alpha blend over the already-composited splats behind it).

**Files:**
- Modify: `src/shaders/off-limits-zone-shader.ts` (vertex passes view-space Z; fragment does the compare)

- [ ] **Step 1: Final shader**

In `src/shaders/off-limits-zone-shader.ts`, replace the contents with:

```ts
const vertexShader = /* glsl */ `
    attribute vec3 vertex_position;
    attribute vec4 vertex_color;

    varying vec4 vColor;
    varying float vViewZ;

    uniform mat4 matrix_model;
    uniform mat4 matrix_view;
    uniform mat4 matrix_viewProjection;

    void main(void) {
        vec4 worldPos = matrix_model * vec4(vertex_position, 1.0);
        gl_Position = matrix_viewProjection * worldPos;
        vColor = vertex_color;
        vViewZ = (matrix_view * worldPos).z;
    }
`;

const fragmentShader = /* glsl */ `
    precision highp float;

    varying vec4 vColor;
    varying float vViewZ;

    uniform sampler2D zoneDepthTex;
    uniform vec4 camera_params; // matches src/shaders/splat-shader.ts usage

    void main(void) {
        vec2 uv = gl_FragCoord.xy / vec2(textureSize(zoneDepthTex, 0));
        vec4 d = texture2D(zoneDepthTex, uv);
        float transmittance = d.a;

        // Wall's normalized linear depth, using the SAME formula as the splat
        // depth-estimation shader so the two are directly comparable:
        //   normalizedDepth = (linearDepth - camera_params.z) / (camera_params.y - camera_params.z)
        // with linearDepth = -view.z.
        float wallNorm = (-vViewZ - camera_params.z) / (camera_params.y - camera_params.z);

        // Only occlude where splats actually exist in front (transmittance low
        // enough to be a real surface). Where there is no splat, always show.
        if (transmittance < 0.99) {
            float splatNorm = d.r / (1.0 - transmittance);
            if (wallNorm > splatNorm) {
                discard; // wall is behind the splat surface -> occluded
            }
        }

        gl_FragColor = vColor; // smooth alpha blend over composited splats behind
    }
`;

export { vertexShader, fragmentShader };
```

> NOTE: `matrix_view` is a standard engine-provided uniform. If the build/runtime shows it unbound, fall back to passing `-vViewZ` as the linear depth via the camera and reconstruct, but `matrix_view` is expected to be available (the engine binds it for all forward materials).

- [ ] **Step 2: Build + lint**

Run: `npm run build` — Expected: `created dist`, no TS errors.
Run: `npx eslint src` — Expected: exit 0.

- [ ] **Step 3: Verify with Dimitri (the real checkpoint)**

Ask Dimitri: `npm run develop`, refresh. Expected, all at once:
1. Wall is a smooth translucent red panel (no grain).
2. Splats BEHIND the wall are visible through it (see-through).
3. Splats IN FRONT of the wall correctly hide it (occlusion); orbiting feels solidly anchored.
4. Selecting a zone (brighter alpha) and moving/rotating it still works; gizmos unaffected.

If occlusion is inverted (wall hidden by splats behind instead of in front), flip the compare (`wallNorm < splatNorm`) — depends on whether `camera_params` maps near/far as assumed; this is the one likely tuning point.

- [ ] **Step 4: Commit**

```bash
git add src/shaders/off-limits-zone-shader.ts
git commit -m "feat: off-limits wall occluded by splats via depth texture (smooth + see-through)"
```

---

## Task 4: Tune visibility + guard cost

- [ ] **Step 1: Confirm alpha** — In `src/off-limits-zone-shape.ts:32-33`, confirm `UNSELECTED_ALPHA`/`SELECTED_ALPHA` give Dimitri the visibility he wants now that the look is smooth; adjust the two integers if requested.

- [ ] **Step 2: Confirm the cost guard** — Verify (with Dimitri) that with NO zones present, the extra `renderZoneDepth()` does not run (the `hasZones` guard in Task 2 Step 3), i.e., scenes without zones pay nothing.

- [ ] **Step 3: Commit any tuning**

```bash
git add -A
git commit -m "chore: tune off-limits wall alpha / confirm zero-cost when unused"
```

---

## Self-Review

- **Spec coverage:** "smooth" → plain alpha color in Task 3; "see-through to splats behind" → splats pre-composited + wall blends over them (Task 3); "occluded by splats in front" → in-shader depth compare against the per-frame splat depth texture (Tasks 2-3); "editor-only / viewer untouched" → no change to `src/viewer-companion/*` or `src/splat-export-core.ts`; "no regression to splat rendering" → splat color pass untouched, depth produced in a separate additive pass (the reason this approach was chosen over global splat depth-write).
- **Placeholder scan:** Two items are explicitly marked **VALIDATE** (pick-pass variant reuse; `camera_params` near/far mapping). These are not lazy placeholders — they are genuine engine-internal unknowns the author cannot verify without a GPU, which is exactly why Task 2 is a visualize-first spike. The compare-direction tuning is called out in Task 3 Step 3.
- **Type consistency:** `zoneDepthBuffer`/`zoneDepthTarget`/`zoneDepthPass`/`zoneDepthBlend`/`offLimitsLayer`/`zonePass` used consistently; `renderZoneDepth()` defined once and called once; uniform names `zoneDepthTex`, `camera_params`, `matrix_view` consistent between camera binding and both shader versions.
