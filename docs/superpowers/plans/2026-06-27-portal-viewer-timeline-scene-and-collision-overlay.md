# Portal Viewer — Timeline-Driven Scene Switching & Collision-Overlay Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two bugs in the exported multi-scene portal viewer: (1) when the camera animation ("video") plays or is scrubbed, the visible scene now tracks where the authored path is on the timeline (so pressing play returns to the initial scene, and scrubbing jumps to the correct scene); (2) the collision-debug overlay reflects the currently active scene instead of always showing the initial scene.

**Architecture:** At **export time** we evaluate the camera animation spline (the exact `CubicSpline` the viewer uses) against the portal rectangles to precompute a compact "time → active scene" timeline, baked into the injected payload. At **runtime**, while the viewer is in animation mode the companion derives the active scene purely from `state.animationTime` (timeline lookup) instead of from frame-to-frame crossing deltas; during free navigation it keeps the existing delta-based crossing detection. Separately, the companion rebuilds the viewer's `VoxelDebugOverlay` (whose GPU buffers are uploaded once at construction) after a collision swap so the overlay shows the active scene's voxels.

**Tech Stack:** TypeScript, Vitest, the SuperSplat exported-viewer companion (`src/viewer-companion/portals.ts`, a stringified runtime IIFE), pure helpers in `src/portal-geom.ts` and `src/anim/spline.ts`.

## Global Constraints

- The new timeline module MUST be PlayCanvas-free (pure math), like `src/portal-geom.ts`, so it runs in the export path and is unit-testable. Allowed imports: `./anim/spline` (`CubicSpline`) and `./portal-geom` (`resolveActiveSplat`, `segmentCrossesRect`, `PortalRect`, `Vec3`).
- The companion runtime is a string template injected verbatim and then minified. New runtime code MUST NOT reference any top-level (mangled) identifier from outside the IIFE; it may only use values from `window.__supersplatPortals` (`data`), `window.__supersplatViewer`, and functions stringified into the IIFE. (Same gotcha documented in `portal-geom.ts:62`.)
- The spline reconstruction MUST match the viewer's `AnimState.fromTrack`: `points` = per keyframe `[pos.x,pos.y,pos.z, target.x,target.y,target.z, fov]`; `times` = keyframe frame numbers; `extra = (duration === times[times.length-1] / frameRate) ? 1 : 0`; `spline = CubicSpline.fromPointsLooping((duration + extra) * frameRate, times, points, smoothness)`; evaluate at `v * frameRate` for `v` in seconds ∈ [0, duration].
- `state.animationTime` is `cursor.value` ∈ [0, duration] seconds and is direction-agnostic (pingpong reuses the same forward mapping), so a single forward time→scene timeline is correct for all loop modes.
- Active-scene index, collision array index, and `portals[].front`/`portals[].back` are all **scene indices** in the exported payload (the export already rewrote editor uids to indices). `portalStart` (default 0) is the initial scene.
- Run unit tests with `npm test` (`vitest run`). The stringified companion runtime is verified end-to-end against a **release build** (per project convention), not unit-tested.

---

## File Structure

- `src/portal-anim-timeline.ts` (create) — pure: build the time→scene timeline from an animation track + portal rects.
- `test/portal-anim-timeline.test.ts` (create) — unit tests for the timeline builder.
- `src/viewer-companion/portals.ts` (modify) — bake `portalAnimTimeline` into the payload; companion runtime: timeline-driven scene switching in anim mode + collision-overlay rebuild on swap.
- `test/portals-injection.test.ts` (modify) — assert the timeline is computed and baked into the payload (and absent/empty when there is no animation).

---

## Task 1: Pure time→scene timeline builder

**Files:**
- Create: `src/portal-anim-timeline.ts`
- Test: `test/portal-anim-timeline.test.ts`

**Interfaces:**
- Consumes: `CubicSpline` from `src/anim/spline.ts`; `resolveActiveSplat`, `segmentCrossesRect`, `PortalRect`, `Vec3` from `src/portal-geom.ts`.
- Produces:
  - `type PortalAnimTrack = { duration: number; frameRate: number; smoothness?: number; keyframes: { times: number[]; values: { position: number[]; target: number[]; fov: number[] } } }`
  - `type PortalTimelineEntry = { t: number; scene: number }`
  - `buildPortalAnimTimeline(track: PortalAnimTrack | null | undefined, portals: PortalRect[], startIndex: number, sampleMult?: number): PortalTimelineEntry[]` — returns change-points sorted ascending by `t`, always non-empty with `[0] === { t: 0, scene: startIndex }`.

- [ ] **Step 1: Write the failing tests**

Create `test/portal-anim-timeline.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

import { buildPortalAnimTimeline, PortalAnimTrack } from '../src/portal-anim-timeline';
import { PortalRect } from '../src/portal-geom';

// Portal in the XY plane at the origin (identity rotation -> normal is local +Z).
// Local +Z side is "front" (scene 1), local -Z side is "back" (scene 0).
const portal: PortalRect = {
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    width: 10,
    height: 10,
    frontUid: 1,
    backUid: 0
};

// Linear-ish track (smoothness 0) so the path is a monotonic interpolation.
// keyframe 0 at z=-5 (back side), keyframe 1 at z=+5 (front side). times in frames.
const track = (overrides: Partial<PortalAnimTrack> = {}): PortalAnimTrack => ({
    duration: 1,
    frameRate: 30,
    smoothness: 0,
    keyframes: {
        times: [0, 30],
        values: {
            position: [0, 0, -5, 0, 0, 5],
            target: [0, 0, 0, 0, 0, 0],
            fov: [60, 60]
        }
    },
    ...overrides
});

describe('buildPortalAnimTimeline', () => {
    it('always starts at t=0 with the start scene', () => {
        const tl = buildPortalAnimTimeline(track(), [portal], 0);
        expect(tl[0]).toEqual({ t: 0, scene: 0 });
    });

    it('records a crossing into the far scene as the path passes through the portal', () => {
        const tl = buildPortalAnimTimeline(track(), [portal], 0);
        expect(tl).toHaveLength(2);
        expect(tl[1].scene).toBe(1);
        expect(tl[1].t).toBeGreaterThan(0);
        expect(tl[1].t).toBeLessThan(1);
    });

    it('returns only the start entry when the path never crosses a portal', () => {
        // Path stays entirely on the back side (z from -5 to -1): no crossing.
        const noCross = track({
            keyframes: { times: [0, 30], values: { position: [0, 0, -5, 0, 0, -1], target: [0, 0, 0, 0, 0, 0], fov: [60, 60] } }
        });
        const tl = buildPortalAnimTimeline(noCross, [portal], 0);
        expect(tl).toEqual([{ t: 0, scene: 0 }]);
    });

    it('records a round trip as two crossings (back -> front -> back)', () => {
        // z: -5 -> +5 -> -5 across three keyframes.
        const roundTrip = track({
            duration: 2,
            keyframes: {
                times: [0, 30, 60],
                values: { position: [0, 0, -5, 0, 0, 5, 0, 0, -5], target: [0, 0, 0, 0, 0, 0, 0, 0, 0], fov: [60, 60, 60] }
            }
        });
        const tl = buildPortalAnimTimeline(roundTrip, [portal], 0);
        expect(tl).toHaveLength(3);
        expect(tl.map(e => e.scene)).toEqual([0, 1, 0]);
        expect(tl[1].t).toBeLessThan(tl[2].t);
    });

    it('returns only the start entry for a degenerate track (fewer than 2 keyframes)', () => {
        const single = track({ keyframes: { times: [0], values: { position: [0, 0, -5], target: [0, 0, 0], fov: [60] } } });
        expect(buildPortalAnimTimeline(single, [portal], 0)).toEqual([{ t: 0, scene: 0 }]);
    });

    it('returns only the start entry when the track is null/undefined', () => {
        expect(buildPortalAnimTimeline(null, [portal], 3)).toEqual([{ t: 0, scene: 3 }]);
        expect(buildPortalAnimTimeline(undefined, [portal], 2)).toEqual([{ t: 0, scene: 2 }]);
    });

    it('returns only the start entry when there are no portals', () => {
        expect(buildPortalAnimTimeline(track(), [], 0)).toEqual([{ t: 0, scene: 0 }]);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- portal-anim-timeline`
Expected: FAIL — `Cannot find module '../src/portal-anim-timeline'`.

- [ ] **Step 3: Implement the timeline builder**

Create `src/portal-anim-timeline.ts`:

```typescript
import { CubicSpline } from './anim/spline';
import { PortalRect, Vec3, resolveActiveSplat, segmentCrossesRect } from './portal-geom';

// Subset of the serialized AnimTrack (see export-popup.ts assembleViewerOptions)
// that this module needs to reproduce the viewer's camera path.
type PortalAnimTrack = {
    duration: number;
    frameRate: number;
    smoothness?: number;
    keyframes: {
        times: number[];
        values: { position: number[]; target: number[]; fov: number[] };
    };
};

// A change-point in the active scene over the animation timeline. `t` is the
// cursor time in seconds (matching the viewer's state.animationTime); `scene`
// is the scene index active from this `t` until the next entry.
type PortalTimelineEntry = { t: number; scene: number };

// Reproduce the viewer's AnimState.fromTrack spline (index.mjs): interleave
// position/target/fov per keyframe, then build a looping cubic spline over
// (duration + extra) * frameRate frames.
const buildSpline = (track: PortalAnimTrack): CubicSpline => {
    const { duration, frameRate } = track;
    const { times, values } = track.keyframes;
    const { position, target, fov } = values;
    const smoothness = track.smoothness ?? 1;

    const points: number[] = [];
    for (let i = 0; i < times.length; ++i) {
        points.push(position[i * 3], position[i * 3 + 1], position[i * 3 + 2]);
        points.push(target[i * 3], target[i * 3 + 1], target[i * 3 + 2]);
        points.push(fov[i]);
    }

    const extra = (duration === times[times.length - 1] / frameRate) ? 1 : 0;
    return CubicSpline.fromPointsLooping((duration + extra) * frameRate, times, points, smoothness);
};

// Build the time->scene timeline by sampling the camera path and replaying the
// portal crossings (using the same geometry as the runtime companion). Returns
// a compact list of change-points; always begins with { t: 0, scene: startIndex }.
const buildPortalAnimTimeline = (
    track: PortalAnimTrack | null | undefined,
    portals: PortalRect[],
    startIndex: number,
    sampleMult = 2
): PortalTimelineEntry[] => {
    const timeline: PortalTimelineEntry[] = [{ t: 0, scene: startIndex }];

    const times = track?.keyframes?.times;
    if (!track || !times || times.length < 2 || !(track.duration > 0) || portals.length === 0) {
        return timeline;
    }

    const spline = buildSpline(track);
    const { duration, frameRate } = track;

    // Sample finely across [0, duration] so a quick in-and-out crossing is not
    // missed. Sub-frame resolution (sampleMult per frame) keeps boundaries tight.
    const numSamples = Math.max(2, Math.ceil(duration * frameRate * sampleMult) + 1);
    const result: number[] = [];

    const evalPos = (v: number): Vec3 => {
        spline.evaluate(v * frameRate, result);
        return [result[0], result[1], result[2]];
    };

    let active = startIndex;
    let prev = evalPos(0);
    for (let k = 1; k < numSamples; ++k) {
        const v = (k / (numSamples - 1)) * duration;
        const cur = evalPos(v);
        const next = resolveActiveSplat(prev, cur, portals, active, segmentCrossesRect);
        if (next !== null && next !== active) {
            active = next;
            timeline.push({ t: v, scene: active });
        }
        prev = cur;
    }

    return timeline;
};

export { buildPortalAnimTimeline, PortalAnimTrack, PortalTimelineEntry };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- portal-anim-timeline`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/portal-anim-timeline.ts test/portal-anim-timeline.test.ts
git commit -m "feat(portals): pure time->scene timeline builder for exported viewer"
```

---

## Task 2: Bake the timeline into the injected payload

**Files:**
- Modify: `src/viewer-companion/portals.ts` (the `buildPortalsInjection` function and the payload object)
- Test: `test/portals-injection.test.ts`

**Interfaces:**
- Consumes: `buildPortalAnimTimeline`, `PortalTimelineEntry` from Task 1; `viewerSettingsJson.animTracks` (array; the viewer uses `animTracks[0]`), `viewerSettingsJson.portals` (entries `{ position, rotation, width, height, front, back }`), `viewerSettingsJson.portalStart`.
- Produces: payload field `portalAnimTimeline: PortalTimelineEntry[]` consumed by Task 3's runtime.

- [ ] **Step 1: Write the failing tests**

Add to `test/portals-injection.test.ts` inside the existing `describe('buildPortalsInjection', ...)` block:

```typescript
    it('bakes a portalAnimTimeline computed from the animation track', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 10, height: 10, front: 1, back: 0 }],
            portalScenes: ['', 'scenes/1/scene.sog'],
            portalStart: 0,
            animTracks: [{
                name: 'cameraAnim',
                duration: 1,
                frameRate: 30,
                loopMode: 'repeat',
                interpolation: 'spline',
                smoothness: 0,
                keyframes: { times: [0, 30], values: { position: [0, 0, -5, 0, 0, 5], target: [0, 0, 0, 0, 0, 0], fov: [60, 60] } }
            }]
        });
        expect(out).toContain('portalAnimTimeline');
        // crossing into scene 1 is recorded (path goes back -> front through the portal)
        expect(out).toContain('"scene":1');
    });

    it('bakes a start-only timeline when there is no animation track', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/scene.sog'],
            portalStart: 0
        });
        expect(out).toContain('portalAnimTimeline');
        expect(out).toContain('[{"t":0,"scene":0}]');
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- portals-injection`
Expected: FAIL — output does not contain `portalAnimTimeline`.

- [ ] **Step 3: Wire the builder into `buildPortalsInjection`**

In `src/viewer-companion/portals.ts`, add the import near the top (next to the existing `portal-geom` import):

```typescript
import { buildPortalAnimTimeline } from '../portal-anim-timeline';
```

Then, inside `buildPortalsInjection`, after the `if (!portals || portals.length === 0) { return ''; }` guard and before the `const payload = {` line, compute the timeline:

```typescript
    // Precompute the active scene over the camera-animation timeline so the
    // exported viewer can switch scenes by cursor time (play/scrub) rather than
    // only by frame-to-frame crossings. Uses the first anim track, matching the
    // viewer's getAnimTrack (animTracks[0]).
    const portalRects = portals.map((p: any) => ({
        position: p.position, rotation: p.rotation, width: p.width, height: p.height,
        frontUid: p.front, backUid: p.back
    }));
    const portalAnimTimeline = buildPortalAnimTimeline(
        viewerSettingsJson.animTracks?.[0] ?? null,
        portalRects,
        viewerSettingsJson.portalStart ?? 0
    );
```

Then add `portalAnimTimeline` to the `payload` object literal (alongside `portalSceneLodCounts`):

```typescript
    const payload = {
        portals,
        portalScenes: viewerSettingsJson.portalScenes ?? [],
        portalStart: viewerSettingsJson.portalStart ?? 0,
        portalCollision: viewerSettingsJson.portalCollision ?? [],
        portalEnvironments: viewerSettingsJson.portalEnvironments ?? [],
        portalSceneLodCounts: viewerSettingsJson.portalSceneLodCounts ?? [],
        portalAnimTimeline,
        loadingDefaults: DEFAULT_MESSAGES
    };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- portals-injection`
Expected: PASS (existing tests + the two new ones).

- [ ] **Step 5: Commit**

```bash
git add src/viewer-companion/portals.ts test/portals-injection.test.ts
git commit -m "feat(portals): bake camera-timeline scene map into exported viewer payload"
```

---

## Task 3: Runtime — timeline-driven scene switching in animation mode

**Files:**
- Modify: `src/viewer-companion/portals.ts` (the `companionRuntime` string template only)

**Interfaces:**
- Consumes: payload `data.portalAnimTimeline` (Task 2); `window.__supersplatViewer.global.state` (`cameraMode`, `animationTime`); existing companion functions `applyActive`, `swapCollision`, `beginLoading`, `entities`, `activeIndex`, `streaming`, `readyScenes`, `pendingIndex`, `lastSafe`.
- Produces: behavior only (no new payload).

> Note: this task edits code **inside** the `companionRuntime` template string. The runtime is not unit-tested (per project convention); it is verified end-to-end in Task 5. Keep all new code inside the IIFE and reference only `data`, `window.__supersplatViewer`, and in-IIFE helpers.

- [ ] **Step 1: Add timeline state + helpers near the top of the IIFE**

In `companionRuntime`, just after the line `var lastSafe = null;`, add:

```javascript
  var timeline = data.portalAnimTimeline || null;   // [{t, scene}] sorted ascending; null/absent when no animation
  function getState() {
    var v = window.__supersplatViewer;
    return (v && v.global && v.global.state) || (v && v.debugPanel && v.debugPanel._global && v.debugPanel._global.state) || null;
  }
  // Active scene for cursor time t (seconds), from the baked timeline. Linear
  // scan: timeline has one entry per crossing (small).
  function sceneAtTime(t) {
    if (!timeline || !timeline.length) return activeIndex;
    var s = timeline[0].scene;
    for (var i = 0; i < timeline.length; i++) {
      if (timeline[i].t <= t) { s = timeline[i].scene; } else { break; }
    }
    return s;
  }
  // Switch to scene idx: enable it, swap collision, and arm the streaming
  // loading overlay on a first visit. No-op when already active or not loaded.
  function switchTo(idx) {
    if (idx === activeIndex || idx === null || !entities[idx]) return;
    activeIndex = idx;
    applyActive();
    swapCollision(idx);
    if (streaming && !readyScenes[idx] && pendingIndex !== idx) { beginLoading(idx); }
  }
```

- [ ] **Step 2: Use the timeline in `tick()` while in animation mode**

In `companionRuntime`, inside `tick()`, replace the pose-guarded crossing block. The current block reads:

```javascript
      if (cam && cam.position) {
        var cur = [cam.position.x, cam.position.y, cam.position.z];
        if (lastSafe) {
          // A crossing whose target scene has not finished loading (entities[next]
          // missing) is skipped; eager preload at startup makes this rare.
          var next = resolveActiveSplat(lastSafe, cur, rects, activeIndex, segmentCrossesRect);
          if (next !== activeIndex && next !== null && entities[next]) {
            activeIndex = next;
            applyActive();
            swapCollision(next);
            // Arm the loading overlay for a first visit to this scene. Ready
            // scenes never re-arm; the poll decides whether/when to show it.
            if (streaming && !readyScenes[next] && pendingIndex !== next) {
              beginLoading(next);
            }
          }
        }
        lastSafe = cur;
      }
```

Replace it with:

```javascript
      if (cam && cam.position) {
        var cur = [cam.position.x, cam.position.y, cam.position.z];
        var st = getState();
        // In animation mode the camera is driven by the authored path, so the
        // active scene is a pure function of the cursor time (handles play,
        // scrub, scrubTo and loop wrap). In free navigation, detect crossings
        // from frame-to-frame motion. lastSafe is kept fresh in both so the
        // hand-off between modes never produces a spurious crossing.
        if (st && st.cameraMode === 'anim' && timeline) {
          switchTo(sceneAtTime(st.animationTime || 0));
        } else if (lastSafe) {
          // A crossing whose target scene has not finished loading (entities[next]
          // missing) is skipped; eager preload at startup makes this rare.
          var next = resolveActiveSplat(lastSafe, cur, rects, activeIndex, segmentCrossesRect);
          if (next !== activeIndex && next !== null && entities[next]) {
            switchTo(next);
          }
        }
        lastSafe = cur;
      }
```

- [ ] **Step 3: Build to confirm the template still compiles into the bundle**

Run: `npm run build`
Expected: build succeeds (no TypeScript/bundling errors). This does not test runtime behavior — that is Task 5.

- [ ] **Step 4: Commit**

```bash
git add src/viewer-companion/portals.ts
git commit -m "fix(portals): drive scene by animation timeline in the exported viewer"
```

---

## Task 4: Runtime — refresh the collision overlay after a scene swap

**Files:**
- Modify: `src/viewer-companion/portals.ts` (the `companionRuntime` string template only)

**Interfaces:**
- Consumes: `window.__supersplatViewer.voxelOverlay` (a `VoxelDebugOverlay` instance with `constructor`, `camera`, `mode`, `enabled`, `destroy()`); `window.__supersplatViewer.global.events` (`collisionOverlayEnabled:changed`); existing companion `liveCollision`, `applyVoxel`, `getApp`, `voxels`, `activeIndex`, `data.portalStart`.
- Produces: behavior only.

> Background: the viewer builds `VoxelDebugOverlay` once when collision loads, uploading the voxel tree (`nodes`/`leafData`) into GPU storage buffers in its constructor. The companion swaps collision by mutating the shared instance's fields in place, which updates grid params (read live each frame) but NOT the GPU buffers — so the overlay keeps rendering the initial scene's tree. Rebuilding the overlay from the (already-mutated) live collision refreshes the buffers. Rebuild only when the overlay is enabled (or becomes enabled) to avoid a per-crossing GPU/pipeline cost for viewers that never open the collision view.

- [ ] **Step 1: Add the overlay-refresh helpers**

In `companionRuntime`, immediately after the existing `swapCollision` function definition (the block ending with `if (live && voxels[idx]) applyVoxel(live, voxels[idx]);`), add:

```javascript
  // The overlay's GPU buffers are uploaded once at construction, so an in-place
  // collision swap leaves them showing the previous scene. Track which scene the
  // overlay buffers represent and rebuild from the live (already-swapped)
  // collision when needed. overlayScene starts at the scene the viewer built the
  // overlay from (the start scene).
  var overlayScene = data.portalStart || 0;
  function overlayEnabled() {
    var v = window.__supersplatViewer;
    return !!(v && v.voxelOverlay && v.voxelOverlay.enabled);
  }
  function refreshOverlay() {
    var v = window.__supersplatViewer;
    var ov = v && v.voxelOverlay;
    var live = liveCollision();
    if (!ov || !ov.constructor || !live || overlayScene === activeIndex) return;
    try {
      var app = getApp(v);
      var nv = new ov.constructor(app, live, ov.camera);  // re-uploads nodes/leafData buffers from the live collision
      nv.mode = ov.mode;
      nv.enabled = ov.enabled;
      v.voxelOverlay = nv;                                 // prerender reads this.voxelOverlay live, so the swap is seen next frame
      ov.destroy();
      overlayScene = activeIndex;
      if (app) app.renderNextFrame = true;
    } catch (e) {
      console.warn('portal overlay refresh failed:', e);
    }
  }
```

- [ ] **Step 2: Refresh on swap (only while the overlay is visible)**

In `companionRuntime`, change `swapCollision` so it refreshes the overlay after applying the voxel fields. Replace:

```javascript
  function swapCollision(idx) {
    var live = liveCollision();
    if (live && voxels[idx]) applyVoxel(live, voxels[idx]);
  }
```

with:

```javascript
  function swapCollision(idx) {
    var live = liveCollision();
    if (live && voxels[idx]) {
      applyVoxel(live, voxels[idx]);
      // Live-update the overlay only if it is currently shown; otherwise it is
      // refreshed lazily when the user enables it (see the listener in start()).
      if (overlayEnabled()) refreshOverlay();
    }
  }
```

- [ ] **Step 3: Refresh lazily when the user enables the overlay**

In `companionRuntime`, inside `start()`, after the line `entities[0] = startEntity;`, add a listener that refreshes a stale overlay when it is turned on:

```javascript
    // When the collision overlay is enabled after the user has already moved to
    // another scene, its buffers are stale -> refresh to the active scene.
    var ev = viewer && viewer.global && viewer.global.events;
    if (ev && ev.on) {
      ev.on('collisionOverlayEnabled:changed', function (on) { if (on) refreshOverlay(); });
    }
```

- [ ] **Step 4: Build to confirm the template still compiles into the bundle**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/viewer-companion/portals.ts
git commit -m "fix(portals): refresh collision overlay to the active scene after a swap"
```

---

## Task 5: End-to-end verification (release build) + full test/lint pass

**Files:** none (verification only)

> The companion runtime cannot be unit-tested; verify it in a real exported viewer. Minification can break stringified-helper assumptions, so verify a **release** build (project convention).

- [ ] **Step 1: Run the full unit-test suite**

Run: `npm test`
Expected: PASS (including the new `portal-anim-timeline` and updated `portals-injection` suites).

- [ ] **Step 2: Lint the changed files**

Run: `npm run lint`
Expected: no new errors in `src/portal-anim-timeline.ts` or `src/viewer-companion/portals.ts`. (See the pinned-ESLint note in project memory before "fixing" unrelated import-order warnings.)

- [ ] **Step 3: Produce a release export with ≥2 portal scenes, collision on, and a camera animation that travels between scenes**

In the running app (release build), set up at least two scenes joined by a portal, enable collision, author a camera animation whose path passes from scene 1 into scene 2, and export (ZIP/streaming as appropriate). Open the exported `index.html`.

- [ ] **Step 4: Verify Bug 1 — timeline-driven scene switching**

  - Manually navigate (orbit/walk/fly) into scene 2, then click the **play** (▶) button. Expected: the viewer snaps to the **initial scene** as the video starts, and switches to scene 2 at the point on the path where it crosses the portal.
  - Drag the **timeline scrubber** to a time the path is in scene 2. Expected: the viewer shows scene 2. Scrub back to an early time. Expected: it shows scene 1.
  - Let the animation **loop** (if loop mode is repeat/pingpong). Expected: the scene tracks the path correctly across the wrap.

- [ ] **Step 5: Verify Bug 2 — collision overlay tracks the active scene**

  - Walk into scene 2, then toggle the collision overlay (bottom-right button or `v`). Expected: the overlay shows **scene 2's** voxels.
  - With the overlay already on, walk back into scene 1. Expected: the overlay updates to **scene 1's** voxels.
  - Confirm a viewer that never opens the overlay shows no regression (no stutter introduced at crossings).

- [ ] **Step 6: Report results**

If all checks pass, the branch is ready to finish (see superpowers:finishing-a-development-branch — squash to a single commit per project convention). If anything fails, capture the console output and return to superpowers:systematic-debugging.

---

## Self-Review Notes

- **Spec coverage:** Bug 1 (play/scrub returns to/tracks the correct scene) → Tasks 1–3 + Step 4 verification. Bug 2 (overlay shows active scene) → Task 4 + Step 5 verification.
- **Type consistency:** `PortalAnimTrack`, `PortalTimelineEntry`, `buildPortalAnimTimeline` defined in Task 1 are consumed verbatim in Task 2. Payload field `portalAnimTimeline` produced in Task 2 is read as `data.portalAnimTimeline` in Task 3. Runtime helper names (`getState`, `sceneAtTime`, `switchTo`, `refreshOverlay`, `overlayEnabled`, `overlayScene`) are introduced and used consistently within Tasks 3–4.
- **No placeholders:** all code blocks are complete and copy-paste ready.
- **Edge cases handled:** no animation / <2 keyframes / no portals → start-only timeline (free-nav delta detection still applies); target scene not yet streamed → `switchTo` no-ops and retries next frame; overlay absent or disabled → refresh is skipped/lazy.
