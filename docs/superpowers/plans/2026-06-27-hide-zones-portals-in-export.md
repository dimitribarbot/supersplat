# Hide off-limits zones and portals in exported image/video — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop off-limits zones (red panels) and portals (blue panels) from appearing in exported images and videos by tying them to the existing "Show Debug" export toggle.

**Architecture:** Off-limits zones and portals render via the camera's permanent `zonePass`, which draws `scene.offLimitsLayer` and is not gated by `renderOverlays`. PlayCanvas skips a layer whose `enabled` is `false`, so we set `scene.offLimitsLayer.enabled = showDebug` during the export's offscreen render and restore it to `true` afterward — mirroring the existing `scene.camera.renderOverlays` handling.

**Tech Stack:** TypeScript, PlayCanvas, SuperSplat editor.

## Global Constraints

- Single file changed: `src/render.ts`. No UI, shader, or layer-setup changes.
- `scene.offLimitsLayer` default `enabled` is `true` (`src/scene.ts:211`); always restore to `true`.
- Do not touch `render.offscreen` (line 79) or the `renderZoneDepth()` path in `src/camera.ts`.
- Portal scene-swap (`src/portals-runtime.ts`) is independent of this change and must remain so — do not modify it.

---

### Task 1: Gate `offLimitsLayer` on Show Debug in image and video export

**Files:**
- Modify: `src/render.ts` (the `render.image` handler ~line 119-183 and the `render.video` handler ~line 185-421)

**Interfaces:**
- Consumes: `scene.offLimitsLayer` (a PlayCanvas `Layer` with a boolean `enabled` property) and the `showDebug` field already destructured from `ImageSettings` / `VideoSettings` in both handlers.
- Produces: no new exported symbols; pure behavioral change.

- [ ] **Step 1: Add the gate in `render.image` setup**

In `events.function('render.image', ...)`, find:

```typescript
            // start rendering to offscreen buffer only
            scene.camera.startOffscreenMode(width, height);
            scene.camera.renderOverlays = showDebug;
            scene.gizmoLayer.enabled = false;
```

Add the `offLimitsLayer` line directly after the `renderOverlays` line:

```typescript
            // start rendering to offscreen buffer only
            scene.camera.startOffscreenMode(width, height);
            scene.camera.renderOverlays = showDebug;
            // off-limits zones and portals are editor aids; hide them unless debug is on
            scene.offLimitsLayer.enabled = showDebug;
            scene.gizmoLayer.enabled = false;
```

- [ ] **Step 2: Restore in `render.image` finally**

In the same handler's `finally` block, find:

```typescript
        } finally {
            scene.camera.endOffscreenMode();
            scene.camera.renderOverlays = true;
            scene.gizmoLayer.enabled = true;
            scene.camera.clearPass.setClearColor(nullClr);

            events.fire('stopSpinner');
        }
```

Add the restore line directly after the `renderOverlays = true` line:

```typescript
        } finally {
            scene.camera.endOffscreenMode();
            scene.camera.renderOverlays = true;
            scene.offLimitsLayer.enabled = true;
            scene.gizmoLayer.enabled = true;
            scene.camera.clearPass.setClearColor(nullClr);

            events.fire('stopSpinner');
        }
```

- [ ] **Step 3: Add the gate in `render.video` setup**

In `events.function('render.video', ...)` (inside `renderImpl`), find:

```typescript
                // start rendering to offscreen buffer only
                scene.camera.startOffscreenMode(width, height);
                scene.camera.renderOverlays = showDebug;
                scene.gizmoLayer.enabled = false;
```

Add the `offLimitsLayer` line directly after the `renderOverlays` line:

```typescript
                // start rendering to offscreen buffer only
                scene.camera.startOffscreenMode(width, height);
                scene.camera.renderOverlays = showDebug;
                // off-limits zones and portals are editor aids; hide them unless debug is on
                scene.offLimitsLayer.enabled = showDebug;
                scene.gizmoLayer.enabled = false;
```

- [ ] **Step 4: Restore in `render.video` finally**

In the same handler's `finally` block, find:

```typescript
                scene.camera.endOffscreenMode();
                scene.camera.renderOverlays = true;
                scene.gizmoLayer.enabled = true;
                scene.camera.clearPass.setClearColor(nullClr);
                scene.lockedRenderMode = false;
```

Add the restore line directly after the `renderOverlays = true` line:

```typescript
                scene.camera.endOffscreenMode();
                scene.camera.renderOverlays = true;
                scene.offLimitsLayer.enabled = true;
                scene.gizmoLayer.enabled = true;
                scene.camera.clearPass.setClearColor(nullClr);
                scene.lockedRenderMode = false;
```

- [ ] **Step 5: Verify the build / typecheck passes**

Run: `npm run build` (or the project's typecheck/lint script)
Expected: completes with no new TypeScript errors related to `render.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/render.ts
git commit -m "feat(render): hide off-limits zones and portals in image/video export"
```

---

### Task 2: Manual E2E verification

**Files:** none (verification only).

This change is GPU render-path glue with no practical unit-test seam, so verification is manual, in a running editor build.

- [ ] **Step 1: Build and run the editor**

Run the project's dev/run command (e.g. `npm run develop`) and open a scene.

- [ ] **Step 2: Set up zones and portals**

Create at least one off-limits zone (red panel) and one portal (blue panel).

- [ ] **Step 3: Image export, Show Debug OFF**

Render menu → image, leave "Show Debug" unchecked, export.
Expected: the PNG contains no red or blue panels.

- [ ] **Step 4: Image export, Show Debug ON**

Render menu → image, check "Show Debug", export.
Expected: red and blue panels are present (unchanged prior behavior).

- [ ] **Step 5: Video export, Show Debug OFF**

Render menu → video, leave "Show Debug" unchecked, export.
Expected: no red or blue panels in any frame.

- [ ] **Step 6: Walkthrough swap still works with panels hidden**

Enable portal walkthrough mode, set a camera animation whose path crosses a portal, then export a video with "Show Debug" unchecked.
Expected: scenes swap correctly as the camera crosses the portal, with no blue panel visible in the footage.

- [ ] **Step 7: Editor state restored**

After the exports, confirm the red zones and blue portals are visible again in the normal editor viewport (the `enabled` flag was restored).

---

## Self-Review

**1. Spec coverage:**
- "Tie zones/portals to Show Debug in image export" → Task 1 Steps 1-2. ✓
- "Tie zones/portals to Show Debug in video export" → Task 1 Steps 3-4. ✓
- "Restore `offLimitsLayer.enabled = true` afterward" → Task 1 Steps 2, 4. ✓
- "Out of scope: `render.offscreen`, `renderZoneDepth`, portals-runtime" → Global Constraints; no task touches them. ✓
- "Manual E2E testing incl. walkthrough swap" → Task 2. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/uncoded steps. Every code step shows the exact before/after. ✓

**3. Type consistency:** Uses only the existing `scene.offLimitsLayer.enabled` boolean and the already-destructured `showDebug`; no new signatures introduced. ✓
