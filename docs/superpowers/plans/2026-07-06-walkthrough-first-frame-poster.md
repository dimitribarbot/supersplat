# Walkthrough-first-frame Poster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the exported viewer's load-time poster from the walkthrough's first frame (position/target/fov of the earliest camera keyframe) when an animation is included, matching what the viewer opens on; fall back to the current viewport when there is no walkthrough.

**Architecture:** A new pure helper `firstWalkthroughPose(experienceSettings)` extracts the first camera-anim keyframe pose from the already-built `ExperienceSettings` (returns `null` when `startMode !== 'animTrack'` or no usable track). The existing `render.poster` event gains an optional `pose` argument: when given, it snapshots the live camera, applies the pose instantly for the offscreen render, and restores the camera in `finally`. The two poster call sites (file export, S3 publish) derive the pose and pass it through.

**Tech Stack:** TypeScript, PlayCanvas engine, Vitest (Node env), event-bus architecture (`events.function` / `events.invoke` / `events.fire`).

## Global Constraints

- Prefer Bash (Git Bash) for git/npm/npx; run commands plainly — no `cd` / `git -C` / `npm --prefix` pointing at the cwd.
- Do not re-run `import/order` autofix (ESLint crashes on it); match surrounding import ordering manually.
- Tests: `npx vitest run test/<file>.test.ts` — run gated in the foreground, never backgrounded or piped to grep.
- No behavior change when there is no walkthrough: the no-`pose` code path must remain byte-for-byte equivalent to today.
- `ExperienceSettings`, `AnimTrack.keyframes.values` = `{ position: number[], target: number[], fov: number[] }`, and `Camera.initial.fov` are defined in `src/splat-serialize.ts` (`ExperienceSettings` is exported).

---

### Task 1: Pure `firstWalkthroughPose` helper + unit tests

**Files:**
- Create: `src/poster-pose.ts`
- Test: `test/poster-pose.test.ts`

**Interfaces:**
- Consumes: `ExperienceSettings` type from `src/splat-serialize.ts` (already exported).
- Produces:
  - `type PosterPose = { position: [number, number, number]; target: [number, number, number]; fov: number };`
  - `const firstWalkthroughPose: (experienceSettings: ExperienceSettings) => PosterPose | null;`
  - Both exported from `src/poster-pose.ts`.

- [ ] **Step 1: Write the failing tests**

Create `test/poster-pose.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

import { firstWalkthroughPose } from '../src/poster-pose';

// Minimal ExperienceSettings-shaped fixtures. Only the fields the helper reads
// are populated; the helper must ignore everything else and never throw on
// missing optional data.
const withTrack = (overrides: any = {}) => ({
    startMode: 'animTrack',
    cameras: [{ initial: { position: [9, 9, 9], target: [8, 8, 8], fov: 42 } }],
    animTracks: [{
        name: 'cameraAnim',
        keyframes: {
            times: [0, 30, 60],
            values: {
                position: [1, 2, 3, 10, 11, 12, 20, 21, 22],
                target: [4, 5, 6, 13, 14, 15, 23, 24, 25],
                fov: [50, 55, 60]
            }
        }
    }],
    ...overrides
} as any);

describe('firstWalkthroughPose', () => {
    it('returns the first keyframe pose when a walkthrough is included', () => {
        expect(firstWalkthroughPose(withTrack())).toEqual({
            position: [1, 2, 3],
            target: [4, 5, 6],
            fov: 50
        });
    });

    it('returns null when startMode is not animTrack', () => {
        expect(firstWalkthroughPose(withTrack({ startMode: 'default' }))).toBeNull();
    });

    it('returns null when there are no anim tracks', () => {
        expect(firstWalkthroughPose(withTrack({ animTracks: [] }))).toBeNull();
    });

    it('returns null when keyframe times are empty', () => {
        const es = withTrack();
        es.animTracks[0].keyframes.times = [];
        expect(firstWalkthroughPose(es)).toBeNull();
    });

    it('returns null when the position values are too short', () => {
        const es = withTrack();
        es.animTracks[0].keyframes.values.position = [1, 2];
        expect(firstWalkthroughPose(es)).toBeNull();
    });

    it('falls back to the start-pose fov when the keyframe fov array is missing', () => {
        const es = withTrack();
        delete es.animTracks[0].keyframes.values.fov;
        expect(firstWalkthroughPose(es)).toEqual({
            position: [1, 2, 3],
            target: [4, 5, 6],
            fov: 42
        });
    });

    it('falls back to 60 when neither keyframe fov nor start-pose fov exist', () => {
        const es = withTrack({ cameras: [] });
        delete es.animTracks[0].keyframes.values.fov;
        expect(firstWalkthroughPose(es)?.fov).toBe(60);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/poster-pose.test.ts`
Expected: FAIL — cannot resolve `../src/poster-pose` (module does not exist yet).

- [ ] **Step 3: Write the helper**

Create `src/poster-pose.ts`:

```typescript
import type { ExperienceSettings } from './splat-serialize';

// The camera pose the export-time poster is rendered from: the first frame of
// the exported walkthrough. Plain-number arrays (playcanvas-free) so this stays
// trivially unit-testable; the render side converts to Vec3.
type PosterPose = {
    position: [number, number, number];
    target: [number, number, number];
    fov: number;
};

// Extract the first-frame camera pose of an exported walkthrough from the
// already-built ExperienceSettings, or null when there is no walkthrough (the
// caller then keeps today's behavior: poster = current viewport).
//
// A walkthrough exists when startMode === 'animTrack' and the camera anim track
// (animTracks[0], the only one built — 'cameraAnim') has at least one keyframe.
// Keyframe values are flattened per-axis: position/target are [x,y,z, x,y,z,...]
// and the first frame is index 0..2; fov is one value per keyframe (index 0).
const firstWalkthroughPose = (experienceSettings: ExperienceSettings): PosterPose | null => {
    if (!experienceSettings || experienceSettings.startMode !== 'animTrack') {
        return null;
    }

    const track = experienceSettings.animTracks?.[0];
    const kf = track?.keyframes;
    const pos = kf?.values?.position;
    const tgt = kf?.values?.target;

    if (!kf?.times?.length || !pos || pos.length < 3 || !tgt || tgt.length < 3) {
        return null;
    }

    const fovKeys = kf.values?.fov;
    const fallbackFov = experienceSettings.cameras?.[0]?.initial?.fov ?? 60;
    const fov = (fovKeys && fovKeys.length > 0) ? fovKeys[0] : fallbackFov;

    return {
        position: [pos[0], pos[1], pos[2]],
        target: [tgt[0], tgt[1], tgt[2]],
        fov
    };
};

export { firstWalkthroughPose, PosterPose };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/poster-pose.test.ts`
Expected: PASS (7 passing).

- [ ] **Step 5: Lint the new files**

Run: `npx eslint src/poster-pose.ts test/poster-pose.test.ts`
Expected: no errors. (If import ordering is flagged, fix by hand — do not run `--fix`.)

- [ ] **Step 6: Commit**

```bash
git add src/poster-pose.ts test/poster-pose.test.ts
git commit -m "feat(poster): add firstWalkthroughPose helper"
```

---

### Task 2: Render the poster from the walkthrough pose (render.poster + both call sites)

**Files:**
- Modify: `src/render.ts:124-165` (the `render.poster` event handler)
- Modify: `src/file-handler.ts:568-574` (viewer export poster render) and its import block (line 13-ish)
- Modify: `src/s3-publish.ts:57-61` (S3 publish poster render) and its import block (line 6-ish)

**Interfaces:**
- Consumes: `firstWalkthroughPose`, `PosterPose` from `src/poster-pose.ts` (Task 1).
- Consumes: existing `camera.getPose` (returns `{ position: {x,y,z}, target: {x,y,z}, fov }`) and `camera.setPose` (`(pose: { position: Vec3, target: Vec3, fov?: number }, speed) => void`) events (`src/editor.ts:763,774`).
- Produces: `render.poster` new signature `(width: number, height: number, bgColor: [number, number, number], pose?: PosterPose | null) => Promise<Uint8Array | null>`.

Note: this task has no automated unit test — `render.poster` needs a live GPU/editor and cannot run under Vitest (Node env). It is verified by the manual E2E in Task 3. A reviewer reviews render + both wirings together.

- [ ] **Step 1: Extend `render.poster` to accept an optional pose**

In `src/render.ts`, add the `PosterPose` import to the existing local imports (keep alphabetical grouping with the other `./` imports — `poster-pose` sorts after `png-compressor`, before `scene`):

```typescript
import { PngCompressor } from './png-compressor';
import type { PosterPose } from './poster-pose';
import { Scene } from './scene';
```

Replace the handler signature and body at `src/render.ts:124` so it snapshots the live camera, applies the walkthrough pose before entering offscreen mode (whose `startOffscreenMode` calls `onUpdate(0)`, snapping the 0-duration tween), and restores the camera in `finally`. Only the marked lines are new; the render body between is unchanged:

```typescript
    events.function('render.poster', async (width: number, height: number, bgColor: [number, number, number], pose?: PosterPose | null): Promise<Uint8Array | null> => {
        // Snapshot the live editor camera so we can restore it after rendering
        // from the walkthrough's first frame. null => render the current view
        // (no walkthrough: unchanged behavior).
        const saved = pose ? events.invoke('camera.getPose') : null;
        try {
            // Move to the walkthrough first-frame pose. Fired before
            // startOffscreenMode, whose onUpdate(0) snaps the 0-damping tween so
            // the pose is fully settled before the forced render.
            if (pose) {
                events.fire('camera.setPose', {
                    position: new Vec3(pose.position[0], pose.position[1], pose.position[2]),
                    target: new Vec3(pose.target[0], pose.target[1], pose.target[2]),
                    fov: pose.fov
                }, 0);
            }

            // offscreen render of the current camera view, editor aids hidden
            scene.camera.startOffscreenMode(width, height);
            scene.camera.renderOverlays = false;
            scene.offLimitsLayer.enabled = false;
            scene.gizmoLayer.enabled = false;
            scene.camera.clearPass.setClearColor(new Color(bgColor[0], bgColor[1], bgColor[2], 1));

            scene.forceRender = true;
            await postRender();

            const data = new Uint8Array(width * height * 4);
            const { mainTarget, workTarget } = scene.camera;
            scene.dataProcessor.copyRt(mainTarget, workTarget);
            await workTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workTarget, data });

            // flip y positions to have 0,0 at the top
            let line = new Uint8Array(width * 4);
            for (let y = 0; y < height / 2; y++) {
                line = data.slice(y * width * 4, (y + 1) * width * 4);
                data.copyWithin(y * width * 4, (height - y - 1) * width * 4, (height - y) * width * 4);
                data.set(line, (height - y - 1) * width * 4);
            }

            // JPEG-encode (poster is opaque: JPEG drops alpha, bg already set)
            const canvas = new OffscreenCanvas(width, height);
            const ctx = canvas.getContext('2d');
            ctx.putImageData(new ImageData(new Uint8ClampedArray(data.buffer), width, height), 0, 0);
            const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
            return new Uint8Array(await blob.arrayBuffer());
        } catch (error) {
            console.warn('poster render failed (export continues without screenshot poster):', error);
            return null;
        } finally {
            scene.camera.endOffscreenMode();
            scene.camera.renderOverlays = true;
            scene.offLimitsLayer.enabled = true;
            scene.gizmoLayer.enabled = true;
            scene.camera.clearPass.setClearColor(nullClr);

            // Restore the editor camera to where the user left it.
            if (saved) {
                events.fire('camera.setPose', {
                    position: new Vec3(saved.position.x, saved.position.y, saved.position.z),
                    target: new Vec3(saved.target.x, saved.target.y, saved.target.z),
                    fov: saved.fov
                }, 0);
            }
        }
    });
```

(`Vec3` and `Color` are already imported at the top of `src/render.ts`.)

- [ ] **Step 2: Wire the file-export call site**

In `src/file-handler.ts`, add the helper import alongside the other `./` imports (sorts after `png-compressor`/before `portal-export`; place near the existing local imports, e.g. after the `io` import):

```typescript
import { firstWalkthroughPose } from './poster-pose';
```

Replace the poster block at `src/file-handler.ts:568-574`:

```typescript
        if (exportType === 'viewer' && options.viewerExportSettings) {
            const es = options.viewerExportSettings.experienceSettings;
            const bg = (es?.background?.color ?? [0, 0, 0]) as [number, number, number];
            const pose = firstWalkthroughPose(es);
            const poster = await events.invoke('render.poster', 1920, 1080, bg, pose) as Uint8Array | null;
            if (poster) {
                options.viewerExportSettings.poster = poster;
            }
        }
```

- [ ] **Step 3: Wire the S3-publish call site**

In `src/s3-publish.ts`, add the helper import alongside the existing `./` imports (after `portal-upload`, before `splat-serialize`):

```typescript
import { firstWalkthroughPose } from './poster-pose';
```

Replace the poster render at `src/s3-publish.ts:60-61` (the `es` local already exists just above, typed `as any`):

```typescript
            const bg = (es?.background?.color ?? [0, 0, 0]) as [number, number, number];
            const pose = firstWalkthroughPose(es);
            const posterBytes = await events.invoke('render.poster', 1920, 1080, bg, pose) as Uint8Array | null;
```

- [ ] **Step 4: Typecheck + lint the changed files**

Run: `npx tsc --noEmit`
Expected: no new errors.

Run: `npx eslint src/render.ts src/file-handler.ts src/s3-publish.ts`
Expected: no errors. (Fix any import-ordering complaint by hand; do not run `--fix`.)

- [ ] **Step 5: Run the unit suite to confirm nothing regressed**

Run: `npx vitest run test/poster-pose.test.ts`
Expected: PASS (helper unchanged; sanity check the wiring didn't break the import).

- [ ] **Step 6: Commit**

```bash
git add src/render.ts src/file-handler.ts src/s3-publish.ts
git commit -m "feat(poster): render load-time poster from walkthrough first frame"
```

---

### Task 3: Manual end-to-end verification (release build)

**Files:** none (verification only).

Per project convention, viewer/poster behavior is verified against a real **release** build (minification-sensitive; Vitest cannot exercise the GPU render). No code changes in this task — if a check fails, fix in Task 1/2 and re-run.

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: build succeeds, `dist/` produced.

- [ ] **Step 2: Serve and open the editor**

Run: `npm run develop` (serves on http://localhost:3333) or serve `dist/`.
Load a splat scene in the editor.

- [ ] **Step 3: Walkthrough case — poster matches the first frame**

  - Add ≥2 camera keyframes on the timeline that are clearly different from the current viewport (the FIRST keyframe pointed at a distinct part of the scene).
  - Move the live editor camera somewhere obviously different from the first keyframe.
  - Export → Viewer, with animation enabled. Open the exported HTML.
  - Expected: the load-time poster (blurred cover shown while streaming) shows the **first keyframe's** view, not the pre-export editor viewport. It matches the first frame the animation opens on.
  - Expected: back in the editor, the camera is exactly where you left it (no visible jump/drift after export).

- [ ] **Step 4: No-walkthrough case — unchanged behavior**

  - Disable animation (or remove all poses) and export → Viewer from a chosen viewport.
  - Expected: the poster shows the current editor viewport, exactly as before this change.

- [ ] **Step 5: S3-publish case (if S3 configured)**

  - With a walkthrough present, run S3 publish.
  - Expected: the published viewer's poster shows the walkthrough's first frame; editor camera restored afterward.
  - If S3 is not configured in this environment, note it as skipped rather than marking it passed.

- [ ] **Step 6: Record the result**

Report which cases passed/were skipped to the user before any squash/merge.

---

## Notes for the implementer

- The `render.poster` change has no automated test by design (needs a GPU); its correctness rests on Task 3's manual E2E. Do not fabricate a Vitest test that stubs the GPU — it would test the stub, not the behavior.
- Keep the no-`pose` path identical to today: reviewers should be able to confirm the current-viewport behavior is untouched when `pose` is `null`.
- The camera move uses the existing `camera.getPose` / `camera.setPose` events (damping `0` = instant); this is the same instant-move path the pose playback already uses (`src/camera-poses.ts:238`).
