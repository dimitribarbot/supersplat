# Portal marker click behaviour and plane alignment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the exported viewer, a click on a portal icon shows its tooltip and nothing else, and the icon lies flat in the portal's plane with only its projected ellipse clickable.

**Architecture:** Three layers, matching the existing feature. A pure, playcanvas-free decision helper in `src/portal-marker.ts` (unit-tested normally *and* stringified into the runtime via `Function.prototype.toString()`); the companion runtime in `src/viewer-companion/portal-markers.ts` that owns the entities and pointer listeners; and string patches to the vendored viewer bundle in `src/viewer-engine-patch.ts`. Movement is suppressed by guarding the viewer's own two click-to-navigate decision points, not by swallowing pointer events.

**Tech Stack:** TypeScript, Vitest, PlayCanvas (via the vendored `@playcanvas/splat-transform` viewer bundle), Rollup.

**Spec:** `docs/superpowers/specs/2026-08-07-portal-marker-click-and-orientation-design.md`

**Branch:** `portal-viewer-icon` — continues the unshipped feature. Do **not** squash or merge; that happens after E2E, for the branch as a whole.

## Global Constraints

- **Stringified helpers must be self-contained.** Every function in `src/portal-marker.ts` is injected into the runtime with `toString()`. No module-scope references, no imports, no closure captures. `Math.*` and other globals are fine.
- **`src/viewer-companion/*.ts` template literals contain no backslashes, no backticks, and no `${`.** Build-time template cooking eats backslash escapes, and the runtime string is spliced into another template literal. Existing tests assert all three; do not defeat them.
- **Never add `preventDefault` or `stopPropagation` to the companion runtime.** A test asserts their absence, and the whole design depends on the marker never intercepting a gesture.
- **Engine-patch anchors must be verified against the real bundle by hand.** The unit tests only check synthetic snippets. The verification script is in this plan (Task 2, Step 1).
- **`npm run build` exit code is not a type gate.** Rollup reports TypeScript errors as warnings and exits 0. The gate is `grep -c "plugin typescript" <log>` equal to **0**.
- **Run test gates in the foreground, redirecting output to a file.** Vitest hangs when backgrounded or piped into another command.
- **Prefer Bash (Git Bash).** Run commands plainly — no `cd`, `git -C` or `npm --prefix` pointing at the working directory.
- **Do not reorder imports.** Match surrounding style; leave existing import order alone.

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/portal-marker.ts` | Pure decisions. `markerHitTest` becomes elliptical and loses its `radius` parameter. | 1 |
| `test/portal-marker.test.ts` | Unit tests for the above. | 1 |
| `src/viewer-companion/portal-markers.ts` | Runtime. One-time plane-aligned orientation, per-frame ellipse axes, the published hit-test global, the click slop constant. | 1, 2 |
| `test/portal-markers.test.ts` | String assertions over the runtime. | 1, 2 |
| `src/viewer-engine-patch.ts` | `Quat` added to the `window.__ssPc` publish; two new guard patches (count 4 → 6). | 1, 2 |
| `test/viewer-engine-patch.test.ts` | Patch tests against synthetic bundle snippets. | 1, 2 |
| `docs/superpowers/2026-08-06-portal-viewer-icon-handoff.md` | The E2E checklist, whose item 10 now inverts. | 3 |

---

### Task 1: Elliptical hit test and plane-aligned orientation

A plane-aligned disc projects to an ellipse. Foreshortening compresses one axis only, so a circular hit region — at any radius — is wrong: shrink it and the icon's own left/right extremes stop responding; leave it and clicks on empty space beside a steeply-angled icon get eaten.

The pure helper and the runtime that feeds it are one task on purpose. Changing `markerHitTest`'s signature without updating its two call sites in the same commit range would leave the exported viewer broken — and invisibly so, since the runtime is never executed by the tests, which are string assertions. Land them together.

**Files:**
- Modify: `src/portal-marker.ts:54-73` (the `markerHitTest` block); its export list is unchanged
- Modify: `src/viewer-companion/portal-markers.ts` — header comment (lines 3-6), scratch declarations (lines 80-81), `markerMakeOne` (lines 179-189), `markerUpdate` (lines 248-279), scratch construction (lines 349-350), both `markerHitTest` call sites (lines 388, 393)
- Modify: `src/viewer-engine-patch.ts:156-166` — add `Quat` to the `window.__ssPc` publish
- Test: `test/portal-marker.test.ts:99-133` (the `markerHitTest` describe block) and `:169-176` (the self-contained assertion); `test/portal-markers.test.ts`; `test/viewer-engine-patch.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `markerHitTest(markers, x, y): number` where each marker is
  `{ sx: number, sy: number, ux: number, uy: number, vx: number, vy: number, onScreen: boolean }`.
  `sx`/`sy` are the icon centre in canvas-relative CSS pixels; `u = (ux, uy)` and
  `v = (vx, vy)` are the screen-space images of the quad's two in-plane
  half-axes. Returns the index of the topmost hit marker, or `-1`.
  Also produces `window.__ssPc.Quat`, and marker records carrying `axisU`/`axisV`
  (constant world-space in-plane axes) alongside the screen fields above.
  Task 2 calls `markerHitTest` through a published global.

- [ ] **Step 1: Replace the `markerHitTest` unit tests**

In `test/portal-marker.test.ts`, replace the entire `describe('markerHitTest', ...)` block (lines 99-133) with:

```ts
describe('markerHitTest', () => {
    // A face-on marker: both half-axes are 24px and perpendicular, so the
    // ellipse is the circle of radius 24 the old implementation used.
    const facing = { sx: 100, sy: 100, ux: 24, uy: 0, vx: 0, vy: 24, onScreen: true };
    // The same marker seen at a steep angle: full width, squashed to 6px
    // vertically. This is the case a scaled circle gets wrong in both
    // directions at once.
    const edgeOn = { sx: 100, sy: 100, ux: 24, uy: 0, vx: 0, vy: 6, onScreen: true };

    it('hits dead-centre', () => {
        expect(markerHitTest([facing], 100, 100)).toBe(0);
    });

    it('hits exactly on the ellipse boundary', () => {
        expect(markerHitTest([facing], 124, 100)).toBe(0);
    });

    it('misses just outside the boundary', () => {
        expect(markerHitTest([facing], 125, 100)).toBe(-1);
    });

    it('keeps the full major axis clickable when foreshortened', () => {
        // 20px along the uncompressed axis is well inside
        expect(markerHitTest([edgeOn], 120, 100)).toBe(0);
    });

    it('rejects the minor axis at a distance the major axis accepts', () => {
        // 12px vertically is outside a 6px half-axis, though the old circular
        // test (radius 24) would have accepted it
        expect(markerHitTest([edgeOn], 100, 112)).toBe(-1);
        expect(markerHitTest([edgeOn], 100, 105)).toBe(0);
    });

    it('handles a rotated ellipse, not just an axis-aligned one', () => {
        // major axis vertical, minor axis horizontal
        const tilted = { sx: 100, sy: 100, ux: 0, uy: 24, vx: 6, vy: 0, onScreen: true };
        expect(markerHitTest([tilted], 100, 120)).toBe(0);
        expect(markerHitTest([tilted], 108, 100)).toBe(-1);
    });

    it('never matches a degenerate (edge-on) marker', () => {
        // both half-axes collinear => zero determinant => no ellipse at all
        const degenerate = { sx: 100, sy: 100, ux: 24, uy: 0, vx: 12, vy: 0, onScreen: true };
        expect(markerHitTest([degenerate], 100, 100)).toBe(-1);
        expect(markerHitTest([degenerate], 110, 100)).toBe(-1);
    });

    it('never matches a marker with onScreen false', () => {
        expect(markerHitTest([{ ...facing, onScreen: false }], 100, 100)).toBe(-1);
    });

    it('returns -1 for an empty or absent list', () => {
        expect(markerHitTest([], 100, 100)).toBe(-1);
        expect(markerHitTest(null as any, 100, 100)).toBe(-1);
    });

    it('picks the nearest of two overlapping markers', () => {
        const markers = [facing, { ...facing, sx: 110 }];
        expect(markerHitTest(markers, 108, 100)).toBe(1);
        expect(markerHitTest(markers, 102, 100)).toBe(0);
    });
});
```

- [ ] **Step 2: Extend the self-contained contract test to cover `markerHitTest`**

`markerHitTest` is stringified into the runtime like the others, but was missing
from this assertion. In `test/portal-marker.test.ts`, replace lines 169-176:

```ts
    it('keeps every stringified helper self-contained', () => {
        // These five are injected into the companion runtime via toString(),
        // so their bodies must not reference module-scope bindings.
        [portalsForScene, markerScale, markerVisible, markerHitTest, resolveMarkerTooltip].forEach((fn) => {
            expect(fn.toString()).not.toContain('MARKER_TOOLTIPS');
            expect(fn.toString()).not.toContain('MARKER_SIZE');
        });
    });
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npx vitest run test/portal-marker.test.ts > /tmp/t1.log 2>&1; echo "exit=$?"; tail -30 /tmp/t1.log
```

Expected: FAIL. The new cases pass `undefined` where the old signature wants a
radius, so boundary and foreshortening assertions come back wrong.

- [ ] **Step 4: Rewrite `markerHitTest`**

In `src/portal-marker.ts`, replace the comment block and function at lines 54-73:

```ts
// Index of the topmost marker whose icon covers (x, y), or -1.
//
// The icon lies flat in the portal plane, so it projects to an ELLIPSE, not a
// circle: foreshortening compresses one axis only. `u` and `v` are the screen
// images of the quad's two in-plane half-axes, so they are the ellipse's
// conjugate half-axes, and undoing that 2x2 map turns the test back into the
// unit disc. Three things fall out of the geometry rather than needing code:
// edge-on collapses the determinant to zero so an invisible icon is
// unclickable with no angle threshold; a tilted doorway gives a rotated
// ellipse; and the normalised distance doubles as the nearest-centre tie-break
// for overlapping icons.
const markerHitTest = (markers: { sx: number, sy: number, ux: number, uy: number, vx: number, vy: number, onScreen: boolean }[], x: number, y: number): number => {
    const list = markers || [];
    let best = -1;
    let bestDist = -1;
    for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (!m || !m.onScreen) continue;
        const det = m.ux * m.vy - m.uy * m.vx;
        // Degenerate: the two axes are collinear, so the icon is edge-on and
        // draws nothing. Also keeps the division below off NaN.
        if (Math.abs(det) < 1e-6) continue;
        const dx = x - m.sx;
        const dy = y - m.sy;
        const k1 = (m.vy * dx - m.vx * dy) / det;
        const k2 = (m.ux * dy - m.uy * dx) / det;
        const d = k1 * k1 + k2 * k2;
        if (d <= 1 && (best === -1 || d < bestDist)) {
            best = i;
            bestDist = d;
        }
    }
    return best;
};
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run test/portal-marker.test.ts > /tmp/t1.log 2>&1; echo "exit=$?"; tail -30 /tmp/t1.log
```

Expected: PASS, all `portal-marker.test.ts` cases.

Do **not** commit yet. The hit test is correct now, but nothing populates its
inputs and the runtime still calls the old 4-argument form — committing here
would leave the exported viewer broken. The remaining steps are a second
red/green cycle that closes that gap; the whole task lands as one commit at
Step 16.

- [ ] **Step 6: Add the runtime string assertions**

In `test/portal-markers.test.ts`, add these three tests inside
`describe('markerRuntime', ...)`, after the existing
`it('inserts its layer before the splats ...')` block:

```ts
    it('lies in the portal plane instead of billboarding', () => {
        // orientation comes from the portal's own quaternion, set once at
        // creation; the camera rotation is no longer consulted at all
        expect(markerRuntime).toContain('entity.setRotation(new pcns.Quat(');
        expect(markerRuntime).toContain('entity.rotateLocal(90, 0, 0)');
        expect(markerRuntime).not.toContain('markerCamera.getRotation()');
        expect(markerRuntime).not.toContain('m.entity.setRotation(rot)');
    });

    it('projects the two in-plane half-axes for the elliptical hit test', () => {
        expect(markerRuntime).toContain('m.ux =');
        expect(markerRuntime).toContain('m.uy =');
        expect(markerRuntime).toContain('m.vx =');
        expect(markerRuntime).toContain('m.vy =');
        // the half-extent of a 1x1 PlaneGeometry at uniform scale s
        expect(markerRuntime).toContain('var half = s * 0.5');
    });

    it('calls the hit test without a shared radius', () => {
        expect(markerRuntime).not.toContain('MARKER_SIZE / 2');
    });
```

In `test/viewer-engine-patch.test.ts`, add one assertion inside the first
`it(...)`, next to the other `expect(source).toContain('...')` publish checks
(after the `PlaneGeometry: PlaneGeometry` line):

```ts
        expect(source).toContain('Quat: Quat');
```

- [ ] **Step 7: Run the tests to verify they fail**

```bash
npx vitest run test/portal-markers.test.ts test/viewer-engine-patch.test.ts > /tmp/t2.log 2>&1; echo "exit=$?"; tail -40 /tmp/t2.log
```

Expected: FAIL — four new assertions, none of that text exists yet.

- [ ] **Step 8: Publish `Quat` to the companion**

In `src/viewer-engine-patch.ts`, in the last patch's `replace` string, change the
line listing `StandardMaterial` onward so `Quat` is included:

```ts
            '    StandardMaterial: StandardMaterial, Texture: Texture, Color: Color, Vec3: Vec3,\n' +
            '    Quat: Quat, BlendState: BlendState, PlaneGeometry: PlaneGeometry,\n' +
```

(replacing the existing `'    BlendState: BlendState, PlaneGeometry: PlaneGeometry,\n'` line.)

The patch's `applied` marker is `window.__ssPc = {`, which is unchanged, so
idempotency still holds.

- [ ] **Step 9: Orient the marker once, at creation**

In `src/viewer-companion/portal-markers.ts`, replace `markerMakeOne`
(lines 179-189) with:

```js
  function markerMakeOne(pcns, app, portal, index) {
    var material = markerMakeMaterial(pcns, markerTexture, markerBaseColor);
    var mi = new pcns.MeshInstance(markerMesh, material);
    mi.cull = false;
    var entity = new pcns.Entity('portal-marker-' + index);
    entity.addComponent('render', { layers: [markerLayer.id], meshInstances: [mi] });
    app.root.addChild(entity);
    entity.setPosition(portal.position[0], portal.position[1], portal.position[2]);
    // Lie flat IN the portal plane rather than turning to face the camera.
    // PlaneGeometry spans local XZ with a +Y normal, and +90 about X sends +Y
    // to +Z -- the portal normal axis, matching portal-export's
    // rotateByQuat(rotation, [0, 0, 1]). The rotation never changes, so this is
    // set once and markerUpdate does no orientation work at all.
    var r = portal.rotation || [0, 0, 0, 1];
    entity.setRotation(new pcns.Quat(r[0], r[1], r[2], r[3]));
    entity.rotateLocal(90, 0, 0);
    // The quad spans the entity's local X and Z, so these two world vectors are
    // its in-plane axes. Constant for the same reason, so capture them here and
    // keep the per-frame path allocation-free.
    var axisU = entity.right.clone();
    var axisV = entity.forward.clone();
    entity.enabled = false;
    return {
      entity: entity, material: material, visible: false,
      axisU: axisU, axisV: axisV,
      sx: 0, sy: 0, ux: 0, uy: 0, vx: 0, vy: 0, onScreen: false
    };
  }
```

- [ ] **Step 10: Project the half-axes each frame**

In the same file, replace `markerUpdate` (lines 248-279) with:

```js
  function markerUpdate() {
    if (!markerLayer || !markerCamera || !liveApp) { return; }
    var cam = markerCamera.camera;
    var canvasHeight = liveApp.graphicsDevice.canvas.clientHeight;
    var viewMatrix = cam.viewMatrix;
    var proj5 = cam.projectionMatrix.data[5];
    for (var i = 0; i < markers.length; i++) {
      var m = markers[i];
      if (!m || !m.visible) { continue; }
      var p = m.entity.getPosition();
      viewMatrix.transformPoint(p, markerViewPos);
      if (markerViewPos.z >= 0) {
        m.onScreen = false;
        if (markerHovered === i) { markerSetHover(i, false); }
        if (markerTipOwner === i) { markerCloseTip(); }
        continue;
      }
      cam.worldToScreen(p, markerScreenPos);
      var s = markerScale(MARKER_SIZE, canvasHeight, proj5, -markerViewPos.z);
      m.entity.setLocalScale(s, s, s);
      m.sx = markerScreenPos.x;
      m.sy = markerScreenPos.y;
      // Project the quad's two in-plane half-axes. Their screen images are the
      // conjugate half-axes of the ellipse the disc projects to, which is
      // exactly the clickable region. PlaneGeometry is 1x1, so the half extent
      // at uniform scale s is s * 0.5 -- half the marker size in pixels when
      // the portal faces the camera.
      //
      // Do NOT write that as the literal expression MARKER_SIZE over two: a
      // test asserts the old shared-radius call shape is gone by searching the
      // runtime string for it.
      var half = s * 0.5;
      markerAxisPos.set(p.x + m.axisU.x * half, p.y + m.axisU.y * half, p.z + m.axisU.z * half);
      cam.worldToScreen(markerAxisPos, markerAxisScreen);
      m.ux = markerAxisScreen.x - m.sx;
      m.uy = markerAxisScreen.y - m.sy;
      markerAxisPos.set(p.x + m.axisV.x * half, p.y + m.axisV.y * half, p.z + m.axisV.z * half);
      cam.worldToScreen(markerAxisPos, markerAxisScreen);
      m.vx = markerAxisScreen.x - m.sx;
      m.vy = markerAxisScreen.y - m.sy;
      m.onScreen = true;
      if (markerTipOwner === i) {
        markerTip.classList.add('on');
        markerPositionTip(markerScreenPos.x, markerScreenPos.y);
      }
    }
  }
```

- [ ] **Step 11: Declare the two new scratch vectors**

In the same file, replace the scratch declarations (lines 80-81):

```js
  var markerViewPos = null;    // per-frame scratch (no allocation)
  var markerScreenPos = null;
  var markerAxisPos = null;    // world point on an in-plane half-axis
  var markerAxisScreen = null; // its projection
```

and in `buildPortalMarkers`, replace line 349-350:

```js
      markerViewPos = new pcns.Vec3();
      markerScreenPos = new pcns.Vec3();
      markerAxisPos = new pcns.Vec3();
      markerAxisScreen = new pcns.Vec3();
```

- [ ] **Step 12: Drop the radius argument at both call sites**

In the same file, in the `pointerup` listener (line 388), replace:

```js
        var hit = markerHitTest(markers, upEv.clientX - rect.left, upEv.clientY - rect.top, MARKER_SIZE / 2);
```

with:

```js
        var hit = markerHitTest(markers, upEv.clientX - rect.left, upEv.clientY - rect.top);
```

and in the `pointermove` listener (line 393), replace:

```js
        var hit = markerHitTest(markers, moveEv.clientX - rect.left, moveEv.clientY - rect.top, MARKER_SIZE / 2);
```

with:

```js
        var hit = markerHitTest(markers, moveEv.clientX - rect.left, moveEv.clientY - rect.top);
```

- [ ] **Step 13: Update the file's header comment**

The header still describes billboarding. In the same file, replace lines 3-6
exactly — note the replacement must still end mid-sentence with "The quad", so
that line 7 (`// lives in a layer inserted right after World OPAQUE ...`)
continues to read correctly:

```js
// Portal icons for the exported viewer.
//
// One quad per portal, lying flat IN the portal's plane, at the portal centre
// (the point the editor's transform gizmo sits on), at a constant 48px screen size. The quad
```

Then reflow that last line to the file's ~79-column width, keeping "The quad"
as the final words.

- [ ] **Step 14: Run the tests to verify they pass**

```bash
npx vitest run test/portal-markers.test.ts test/viewer-engine-patch.test.ts > /tmp/t2.log 2>&1; echo "exit=$?"; tail -40 /tmp/t2.log
```

Expected: PASS. In particular the "no backslashes", "no backticks", "no
surviving template interpolation" and "parses as a function body" cases must
still pass — the new code introduces none of those.

- [ ] **Step 15: Run the full suite and lint**

```bash
npm run test > /tmp/t1full.log 2>&1; echo "exit=$?"; tail -12 /tmp/t1full.log
npm run lint > /tmp/l1.log 2>&1; echo "exit=$?"; tail -5 /tmp/l1.log
```

Expected: all tests pass; lint exit 0.

- [ ] **Step 16: Commit**

One commit for the whole task — the hit test and the code that populates its
inputs must not be separated.

```bash
git add src/portal-marker.ts src/viewer-companion/portal-markers.ts src/viewer-engine-patch.ts test/portal-marker.test.ts test/portal-markers.test.ts test/viewer-engine-patch.test.ts
git commit -m "feat(portals): marker icon lies in the portal plane

Orientation comes from the portal's own quaternion and is set once at
creation, so the per-frame path drops setRotation/rotateLocal/getRotation
entirely -- strictly less work than billboarding. Quat joins the
window.__ssPc publish.

A plane-aligned icon projects to an ellipse, so the old circular hit
region is wrong at every radius: shrink it and the icon's own left/right
extremes stop responding, leave it and clicks beside a steeply-angled icon
get eaten. The quad's two in-plane half-axes are projected each frame, and
the test undoes that 2x2 map and checks the unit disc. Edge-on collapses
the determinant, so an invisible icon is unclickable without an angle
threshold, and the normalised distance doubles as the nearest-centre
tie-break.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Suppress camera movement on an icon click

**Files:**
- Modify: `src/viewer-engine-patch.ts` — two new entries in `PATCHES`, plus the header comment
- Modify: `src/viewer-companion/portal-markers.ts` — publish `window.__ssPortalMarkerAt`, raise the click slop
- Test: `test/viewer-engine-patch.test.ts`, `test/portal-markers.test.ts`

**Interfaces:**
- Consumes: `markerHitTest(markers, x, y)` and the fully-populated marker records, both from Task 1.
- Produces: `window.__ssPortalMarkerAt(x, y): boolean` — canvas-relative CSS pixels, the same space the viewer's `_lastPointerOffsetX/Y` is in. Nothing later depends on it.

- [ ] **Step 1: Verify both anchors occur exactly once in the real bundle**

The unit tests only check synthetic snippets, so the anchors must be verified
against the vendored bundle by hand. Write this scratch script (it is throwaway
— do **not** commit it):

```bash
mkdir -p /tmp/ssanchor && cat > /tmp/ssanchor/check.js <<'EOF'
// The exported viewer source lives escape-encoded inside index.mjs, so decode
// the escapes before counting. Throwaway verification tooling.
const fs = require('fs');
const s = fs.readFileSync('node_modules/@playcanvas/splat-transform/dist/index.mjs', 'utf8')
    .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\(['"`])/g, '$1');
const anchors = {
    'A _onPointerUp':
        '            if (this._mouseClickDelta < TAP_EPSILON) {\n' +
        "                if (state.cameraMode === 'walk' && !state.gamingControls) {\n",
    'B _onMobileTap':
        '        if (this._suppressClick) {\n' +
        '            this._suppressClick = false;\n' +
        '            return;\n' +
        '        }\n' +
        "        if (state.cameraMode === 'walk' && !state.gamingControls) {\n",
    'naive one-liner (MUST be 2 - this is why context is needed)':
        "        if (state.cameraMode === 'walk' && !state.gamingControls) {\n"
};
for (const [k, a] of Object.entries(anchors)) console.log(s.split(a).length - 1, '\t', k);
EOF
node /tmp/ssanchor/check.js
```

Expected output — **stop and escalate if it differs**, because a zero means the
bundle changed shape and a two means the patch would hit the wrong site:

```
1 	 A _onPointerUp
1 	 B _onMobileTap
2 	 naive one-liner (MUST be 2 - this is why context is needed)
```

- [ ] **Step 2: Add the patch tests**

In `test/viewer-engine-patch.test.ts`, add these two snippet constants after
`INITXR_SNIPPET` (line 29):

```ts
// WalkInteraction._onPointerUp, mouse click-to-navigate branch (fork patch: a
// click on a portal icon shows its tooltip and must not also move the camera).
// 12-/16-space indented. The inner `if` line alone occurs TWICE in the bundle
// -- once here and once in _onMobileTap -- so the anchor needs the TAP_EPSILON
// line above it to be unique.
const POINTER_UP_SNIPPET =
    '            if (this._mouseClickDelta < TAP_EPSILON) {\n' +
    '                if (state.cameraMode === \'walk\' && !state.gamingControls) {\n';

// WalkInteraction._onMobileTap, touch click-to-navigate branch (same fork
// patch, other input path). 8-space indented, anchored on the _suppressClick
// early-return block above it.
const MOBILE_TAP_SNIPPET =
    '        if (this._suppressClick) {\n' +
    '            this._suppressClick = false;\n' +
    '            return;\n' +
    '        }\n' +
    '        if (state.cameraMode === \'walk\' && !state.gamingControls) {\n';
```

Change the `BUNDLE` constant (line 38) to include them:

```ts
const BUNDLE = CAMERA_MANAGER_SNIPPET + INITXR_SNIPPET + POINTER_UP_SNIPPET + MOBILE_TAP_SNIPPET + EXPORT_SNIPPET;
```

Change the count assertion (line 44):

```ts
        expect(VIEWER_ENGINE_PATCH_COUNT).toBe(6);
```

And add this block inside the same `it(...)`, before its closing brace:

```ts
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
```

Finally, update the two partial-bundle tests so their expected counts stay
honest. Replace the body of `it('patches partial bundles and reports the reduced count')`
count assertion (line 100) — it stays `2`, since neither new anchor is present —
and replace the count in `it('does not publish engine classes into a bundle with no export tail')`
(line 114) with:

```ts
        const { source, patched } = patchViewerEngine(CAMERA_MANAGER_SNIPPET + INITXR_SNIPPET + POINTER_UP_SNIPPET + MOBILE_TAP_SNIPPET);
        expect(patched).toBe(5);
        expect(source).not.toContain('__ssPc');
```

- [ ] **Step 3: Add the runtime string assertions**

In `test/portal-markers.test.ts`, add inside `describe('markerRuntime', ...)`:

```ts
    it('publishes the hit test for the viewer-engine click guards', () => {
        // The two engine patches call this to decide whether a click landed on
        // an icon; without it they short-circuit and the viewer behaves as
        // before, so a patch/companion mismatch is never fatal.
        expect(markerRuntime).toContain('window.__ssPortalMarkerAt = function (x, y)');
        expect(markerRuntime).toContain('markerHitTest(markers, x, y) !== -1');
    });

    it('uses the same click slop as the viewer, so no gesture falls between them', () => {
        // The viewer treats a click as a click below TAP_EPSILON = 15. A
        // smaller slop here left a 5-15px dead zone where the movement was
        // suppressed and no tooltip opened.
        expect(markerRuntime).toContain('MARKER_CLICK_SLOP = 15');
        expect(markerRuntime).not.toContain('>= 5)');
    });
```

- [ ] **Step 4: Run the tests to verify they fail**

```bash
npx vitest run test/viewer-engine-patch.test.ts test/portal-markers.test.ts > /tmp/t3.log 2>&1; echo "exit=$?"; tail -40 /tmp/t3.log
```

Expected: FAIL — patch count is 4, not 6, and none of the new runtime text exists.

- [ ] **Step 5: Add the two guard patches**

In `src/viewer-engine-patch.ts`, append these two entries to the `PATCHES` array,
after the `window.__ssPc` publish entry:

```ts
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
    // One line per site covers walk, fly and orbit together, and stores no
    // state that could go stale -- the guard is evaluated at click time against
    // the very offsets the viewer is about to pick with. Both searches
    // self-destruct (the two lines stop being adjacent), so neither needs an
    // `applied` marker. Verified to occur exactly once each in the
    // splat-transform 3.1.7 baked viewer; note that the inner `if` line ALONE
    // occurs twice, which is why both anchors carry surrounding context.
    {
        // WalkInteraction._onPointerUp -- mouse. 12-/16-space indented.
        search:
            '            if (this._mouseClickDelta < TAP_EPSILON) {\n' +
            '                if (state.cameraMode === \'walk\' && !state.gamingControls) {\n',
        replace:
            '            if (this._mouseClickDelta < TAP_EPSILON) {\n' +
            '                if (window.__ssPortalMarkerAt && window.__ssPortalMarkerAt(this._lastPointerOffsetX, this._lastPointerOffsetY)) return;\n' +
            '                if (state.cameraMode === \'walk\' && !state.gamingControls) {\n'
    },
    {
        // WalkInteraction._onMobileTap -- touch. 8-space indented.
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
    }
```

Also update the file header comment: change "What remains are three
fork-specific patches" to "five fork-specific patches" and add to its numbered
list:

```ts
//   5. `window.__ssPc`, publishing the engine classes the portal-marker
//      companion needs (a classic script cannot reach them otherwise).
//   6. Two guards so a click on a portal marker opens its tooltip without
//      also driving the camera.
```

- [ ] **Step 6: Publish the hit test and widen the click slop**

In `src/viewer-companion/portal-markers.ts`, add the constant next to
`MARKER_SIZE` (after line 54):

```js
  // The viewer treats a pointerup as a click when accumulated movement stayed
  // under TAP_EPSILON = 15. Matching it here means "the viewer would have
  // navigated" and "the marker shows its tooltip" cannot disagree; a smaller
  // value left a dead zone where the movement was suppressed and nothing
  // opened. The two metrics differ in kind -- straight-line displacement here,
  // accumulated path there -- so this makes the marker at least as forgiving,
  // not identical.
  var MARKER_CLICK_SLOP = 15;
```

In the `pointerup` listener, replace the threshold test:

```js
        if (Math.sqrt(dx * dx + dy * dy) >= MARKER_CLICK_SLOP) {
```

And in `buildPortalMarkers`, immediately after the `pointercancel` listener
registration and before `refreshPortalMarkers();`, add:

```js
      // Published for the two viewer-engine patches that guard the viewer's own
      // click-to-navigate decision points: a click landing on an icon shows the
      // tooltip and must not also move the camera. Coordinates are
      // canvas-relative CSS pixels -- the same space as the viewer's
      // _lastPointerOffsetX/Y. Markers suppressed by noui, anim playback or a
      // running transition are already not onScreen, so this is inert then.
      window.__ssPortalMarkerAt = function (x, y) {
        return markerHitTest(markers, x, y) !== -1;
      };
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npx vitest run test/viewer-engine-patch.test.ts test/portal-markers.test.ts > /tmp/t3.log 2>&1; echo "exit=$?"; tail -40 /tmp/t3.log
```

Expected: PASS.

- [ ] **Step 8: Re-verify the anchors still apply after editing**

```bash
node /tmp/ssanchor/check.js
```

Expected: unchanged from Step 1 (this checks the vendored bundle, which the
edits do not touch — it guards against having mistyped an anchor into the
source).

- [ ] **Step 9: Run all gates**

```bash
npm run test > /tmp/t3full.log 2>&1; echo "exit=$?"; tail -12 /tmp/t3full.log
npm run lint > /tmp/l3.log 2>&1; echo "exit=$?"; tail -5 /tmp/l3.log
npm run build > /tmp/b3.log 2>&1; echo "exit=$?"; grep -c "plugin typescript" /tmp/b3.log
node scripts/build-shared.mjs > /tmp/s3.log 2>&1; echo "exit=$?"
ls -la dist-shared/portal-marker.js dist-shared/viewer-companion/portal-markers.js
```

Expected: tests pass; lint exit 0; **`plugin typescript` count 0** (the build's
own exit code is not a type gate); both `dist-shared` artifacts present.

- [ ] **Step 10: Commit**

```bash
git add src/viewer-engine-patch.ts src/viewer-companion/portal-markers.ts test/viewer-engine-patch.test.ts test/portal-markers.test.ts
git commit -m "feat(portals): a click on a marker opens its tooltip only

The marker's canvas listeners stay passive, so the click also reached the
viewer's click-to-navigate handling and moved the camera. Guard the two
places the viewer decides a click means navigate -- _onPointerUp and
_onMobileTap -- covering walk, fly and orbit with one line each and
storing no state that can go stale. Both anchors verified to occur exactly
once in the baked viewer; the naive one-line anchor occurs twice.

Marker click slop raised 5px -> 15px to match the viewer's TAP_EPSILON,
closing a dead zone where movement was suppressed and no tooltip opened.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Revise the E2E checklist

The hand-off memo's checklist predates these changes and item 10 now asserts the
opposite of the intended behaviour. A stale checklist is worse than none — it
would have the tester sign off on the bug.

**Files:**
- Modify: `docs/superpowers/2026-08-06-portal-viewer-icon-handoff.md`

**Interfaces:**
- Consumes: the behaviour delivered by Tasks 1-2.
- Produces: nothing code-facing.

- [ ] **Step 1: Update the behaviour table**

In the "What shipped" table, change only the `click` row and add one new row.
Leave `look`, `size`, `which portals`, `occlusion`, `hover`, `walk / fly`,
`suppressed when` and `toggle` untouched. Replace the `click` row with:

```
| click | canvas hit-test against the icon's projected ellipse → tooltip, "Portal to another scene", localized in 9 languages; the camera does **not** move |
```

and add a new row after it:

```
| orientation | lies flat in the portal's plane; foreshortens and disappears when viewed edge-on |
```

- [ ] **Step 2: Replace checklist items 9 and 10**

```
| 9 | **Orbit-drag starting ON an icon** | Camera orbits normally; the icon must not swallow it, and no tooltip opens |
| 10 | **Click-to-walk aimed at a doorway icon** | Tooltip opens and you do **not** move. (This inverts the original expectation.) |
```

- [ ] **Step 3: Add the new items**

Append after item 22:

```
| 23 | Click an icon in **fly** mode | Tooltip opens, no fly-to |
| 24 | Click an icon in **orbit** mode | Tooltip opens, orbit centre does **not** move to it |
| 25 | Click the floor *beside* an icon, in walk mode | You walk there normally — the guard must not eat nearby clicks |
| 26 | View a portal side-on until the icon is a sliver | It is neither visible nor clickable; clicks pass through to the scene |
| 27 | View a portal from a steep but readable angle | The icon is a squashed ellipse; its full width is still clickable, its squashed height is not |
| 28 | Stand behind a portal and look back at the icon | Visible, mirrored (knob dot on the other side) — known and accepted |
| 29 | **Double-click** an icon | Still swaps camera mode and navigates — deliberately not suppressed |
```

- [ ] **Step 4: Note the supersession**

Under the memo's title block, add:

```
**Amended:** 2026-08-07 — click behaviour and plane alignment, see
`docs/superpowers/specs/2026-08-07-portal-marker-click-and-orientation-design.md`.
Items 9-10 changed meaning; items 23-29 are new.
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/2026-08-06-portal-viewer-icon-handoff.md
git commit -m "docs: revise the portal marker E2E checklist

Item 10 inverted -- a click on a doorway icon must no longer move you --
and seven items added for the plane-aligned orientation, the elliptical
hit region and the deliberately unsuppressed double-click.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Definition of done

- All three tasks committed on `portal-viewer-icon`.
- `npm run test`, `npm run lint` green; `npm run build` with a zero
  `plugin typescript` count; `node scripts/build-shared.mjs` producing both
  marker artifacts.
- The anchor verification script reports `1 / 1 / 2`.
- The branch is **not** squashed or merged — that follows the E2E pass, together
  with the still-outstanding locale sign-off on the eight non-English
  `MARKER_TOOLTIPS` strings.