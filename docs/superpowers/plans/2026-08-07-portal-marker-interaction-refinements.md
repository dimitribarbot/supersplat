# Portal Marker Interaction Refinements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the exported viewer's portal marker icons stop responding to the pointer while gaming controls are active, close their tooltip on a re-click, hide the viewer's walk-mode nav hover ring while the pointer is over an icon, and stop clobbering the viewer's own cursor on hover-out.

**Architecture:** One new pure predicate in `src/portal-marker.ts` (unit-tested normally, stringified into the companion runtime), wired into the four places the companion touches the pointer; one new string patch into the vendored viewer bundle for the hover ring; one new event listener in the portals companion. No new files, no new subsystems.

**Tech Stack:** TypeScript, Vitest, Rollup. The runtime pieces are template-literal strings spliced into a vendored third-party viewer bundle at export time.

**Spec:** `docs/superpowers/specs/2026-08-07-portal-marker-interaction-refinements-design.md`

## Global Constraints

These apply to every task. Violating any of them breaks the export silently rather than loudly.

- **`src/viewer-companion/*.ts` runtime strings contain NO backslashes, NO backticks, and no surviving `${}` after build.** They are template literals spliced into another template literal, and the build cooks escape sequences. Existing tests in `test/portal-markers.test.ts` enforce all three — do not weaken them.
- **Every helper in `src/portal-marker.ts` must be self-contained.** They are stringified with `Function.prototype.toString()` into the runtime, so a reference to a module-scope constant or an import becomes a `ReferenceError` in the exported viewer.
- **`npm run build`'s exit code is NOT a type gate.** Rollup reports TypeScript errors as warnings and exits 0. The gate is `grep -c "plugin typescript" <build log>` equal to `0`.
- **Run Vitest in the foreground with output redirected to a file.** Backgrounding it or piping it to `grep` hangs. Use `npm run test > /tmp/test.log 2>&1; tail -40 /tmp/test.log` style, foreground.
- **Prefer Bash (Git Bash) over PowerShell**, and run commands plainly from the repo root — no `cd`, `git -C` or `npm --prefix` pointing at the cwd.
- **Do not reorder imports.** ESLint is pinned to v10 and crashes on `import/order` autofix.
- **Do not touch upstream-owned files** (`rollup.config.mjs`, `src/render.ts`). Nothing in this plan needs them.
- Branch is `portal-viewer-icon`. Commit after every task; the branch gets squashed later.

## File Structure

| file | responsibility | change |
| --- | --- | --- |
| `src/portal-marker.ts` | pure, playcanvas-free marker decisions | **add** `markerInteractive` |
| `src/viewer-companion/portal-markers.ts` | the injected marker runtime | gate pointer handlers, toggle tooltip, restore cursor |
| `src/viewer-companion/portals.ts` | the portals companion that hosts the runtime | **add** one `gamingControls:changed` listener |
| `src/viewer-engine-patch.ts` | string patches into the vendored bundle | **add** the 7th patch (nav hover ring) |
| `test/portal-marker.test.ts` | pure helper unit tests | **add** `markerInteractive` suite |
| `test/portal-markers.test.ts` | runtime-string assertions | **fix** one stale assertion, add four |
| `test/viewer-engine-patch.test.ts` | patch anchor + idempotence | **add** `NAV_CURSOR_SNIPPET`, bump count 6 → 7 |
| `docs/superpowers/2026-08-06-portal-viewer-icon-handoff.md` | the living hand-off memo | rewrite items 13/21, add 5 items, fix a limitation |

---

### Task 1: The `markerInteractive` predicate

**Files:**
- Modify: `src/portal-marker.ts`
- Test: `test/portal-marker.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `markerInteractive(s: { cameraMode: string, gamingControls: boolean }): boolean` — exported from `src/portal-marker.ts`. Returns `false` exactly when `s.gamingControls` is truthy AND `s.cameraMode` is `'walk'` or `'fly'`. Task 2 stringifies it into the runtime.

**Why one predicate covers both platforms:** the viewer's `PointerLockManager` engages the desktop pointer lock exactly when the mode is walk-or-fly, gaming controls are on, and the input mode is desktop. So desktop pointer lock is a strict subset of this condition, and no `document.pointerLockElement` check is needed. On touch, the same condition is the joystick / tap-to-jump state where a tap means "jump", not "aim here".

- [ ] **Step 1: Write the failing tests**

Add to `test/portal-marker.test.ts`. Put the `markerInteractive` name into the existing import block at the top of the file, in the position alphabetical order puts it (after `markerHitTest`, before `markerScale`) — do NOT run an import-order autofix.

```ts
describe('markerInteractive', () => {
    it('goes non-interactive in walk with gaming controls (mobile tap = jump, desktop = pointer lock)', () => {
        expect(markerInteractive({ cameraMode: 'walk', gamingControls: true })).toBe(false);
    });

    it('goes non-interactive in fly with gaming controls', () => {
        expect(markerInteractive({ cameraMode: 'fly', gamingControls: true })).toBe(false);
    });

    it('stays interactive in walk without gaming controls', () => {
        expect(markerInteractive({ cameraMode: 'walk', gamingControls: false })).toBe(true);
    });

    it('stays interactive in fly without gaming controls', () => {
        expect(markerInteractive({ cameraMode: 'fly', gamingControls: false })).toBe(true);
    });

    it('stays interactive in orbit, which never locks the pointer', () => {
        // gamingControls can be latched on from a previous walk session; orbit
        // still takes ordinary positional clicks, so the icons must respond.
        expect(markerInteractive({ cameraMode: 'orbit', gamingControls: true })).toBe(true);
    });

    it('stays interactive during anim playback', () => {
        // markerVisible already suppresses the icons entirely there; this
        // predicate must not double-suppress and mask that.
        expect(markerInteractive({ cameraMode: 'anim', gamingControls: true })).toBe(true);
    });

    it('defaults to interactive when the viewer state is unavailable', () => {
        expect(markerInteractive(null as any)).toBe(true);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/portal-marker.test.ts > /tmp/t1.log 2>&1; tail -30 /tmp/t1.log`

Expected: FAIL — `markerInteractive is not a function`, or a TypeScript/import resolution error naming `markerInteractive`.

- [ ] **Step 3: Implement the predicate**

In `src/portal-marker.ts`, insert immediately after `markerVisible` and before `markerHitTest`:

```ts
// Whether the icons respond to the pointer at all. Deliberately SEPARATE from
// markerVisible: with gaming controls on the icons stay on screen, they just
// stop reacting -- which is what the hand-off memo has always promised and what
// the runtime did not do.
//
// Gaming controls in walk or fly means the pointer is not an aim point. On
// touch a tap there is the viewer's jump (raised inside the touch input source,
// so neither engine click guard can see it, and it would fire alongside the
// tooltip). On desktop the same state is what PointerLockManager locks on, and
// under pointer lock clientX/clientY are FROZEN at the lock position -- so a
// click would open the tooltip of whatever icon sat under a stale point, and a
// pointermove would latch the hover tint there forever. Because the lock only
// ever engages in this state, testing it here needs no pointerLockElement read.
const markerInteractive = (s: { cameraMode: string, gamingControls: boolean }): boolean => {
    if (!s) return true;
    if (s.gamingControls && (s.cameraMode === 'walk' || s.cameraMode === 'fly')) return false;
    return true;
};
```

Then add `markerInteractive,` to the `export { ... }` block at the bottom of the file, keeping the existing alphabetical order (after `markerHitTest`, before `markerScale`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/portal-marker.test.ts > /tmp/t1.log 2>&1; tail -30 /tmp/t1.log`

Expected: PASS, all tests in the file green.

- [ ] **Step 5: Commit**

```bash
git add src/portal-marker.ts test/portal-marker.test.ts
git commit -m "feat(portals): markerInteractive gates icons on the gaming-controls state"
```

---

### Task 2: Gate the marker runtime's pointer handling

**Files:**
- Modify: `src/viewer-companion/portal-markers.ts`
- Modify: `src/viewer-companion/portals.ts:1106-1109` (insert a listener directly after the `cameraMode:changed` block)
- Test: `test/portal-markers.test.ts`

**Interfaces:**
- Consumes: `markerInteractive` from Task 1.
- Produces: `markerCanInteract()` inside the runtime string; `window.__ssPortalMarkerAt(x, y)` now returns `false` whenever the state is non-interactive — Task 4's engine patch relies on that.

**Heads-up — one EXISTING test breaks and must be fixed in this task.** `test/portal-markers.test.ts` currently asserts `expect(markerRuntime).not.toContain('gamingControls')` inside the test named `reads the suppression inputs from the viewer, not from annotations`. That assertion's real intent is "`markerVisible` does not depend on gaming controls", which is still true — but the bare string now appears in the runtime. Step 5 below replaces it with an assertion that says what it means. Do not simply delete it.

- [ ] **Step 1: Write the failing tests**

Add to the `describe('markerRuntime', ...)` block in `test/portal-markers.test.ts`:

```ts
    it('gates pointer interaction on the gaming-controls state', () => {
        // With gaming controls on, a mobile tap is the viewer's jump and a
        // desktop click carries frozen pointer-lock coordinates. The icons stay
        // visible; only their pointer response goes away.
        expect(markerRuntime).toContain('var markerInteractive =');
        expect(markerRuntime).toContain('function markerCanInteract()');
        expect(markerRuntime).toContain('if (!markerCanInteract()) { return; }');
    });

    it('gates the engine-side guard from the same choke point', () => {
        // Both existing click guards and the nav-hover-ring guard call this, so
        // gating it once here means none of them re-derives the rule.
        expect(markerRuntime).toContain('return markerCanInteract() && markerHitTest(markers, x, y) !== -1;');
    });

    it('tears down an open tooltip and hover when the state goes non-interactive', () => {
        // Pressing G with a tooltip open fires gamingControls:changed and
        // nothing else; without this the tooltip would hang around.
        expect(markerRuntime).toContain(
            '    if (!markerCanInteract()) {\n' +
            '      markerCloseTip();\n' +
            '      if (markerHovered !== -1) { markerSetHover(markerHovered, false); }\n' +
            '    }'
        );
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/portal-markers.test.ts > /tmp/t2.log 2>&1; tail -40 /tmp/t2.log`

Expected: FAIL — the three new tests fail on the missing substrings. The existing `reads the suppression inputs` test still PASSES at this point; it breaks in step 3.

- [ ] **Step 3: Stringify the predicate and add the runtime helper**

In `src/viewer-companion/portal-markers.ts`, in the `markerRuntime` template's helper block, add a line after `var markerVisible = ...`:

```js
  var markerInteractive = ${markerInteractive.toString()};
```

and add `markerInteractive` to the import at the top of the file, in the position alphabetical order puts it (after `markerHitTest`, before `markerScale`).

Then add this function immediately before `function markerSetHover(index, on) {`:

```js
  // Whether the icons should respond to the pointer at all right now. Read
  // fresh on every use rather than cached on an event: the viewer's own guards
  // call in at click time and must never see a stale answer.
  function markerCanInteract() {
    var st = getState();
    return markerInteractive({
      cameraMode: (st && st.cameraMode) || 'orbit',
      gamingControls: !!(st && st.gamingControls)
    });
  }
```

- [ ] **Step 4: Gate the four call sites**

All four are in `src/viewer-companion/portal-markers.ts`.

**4a — `pointerup`.** After `markerDown = false;`, insert the gate:

```js
      markerCanvas.addEventListener('pointerup', function (upEv) {
        if (!markerDown) { return; }
        markerDown = false;
        if (!markerCanInteract()) { return; }
        var dx = upEv.clientX - markerDownX;
```

(The drag-closes-the-tooltip path below it is safe to skip here: when the state is non-interactive, refreshPortalMarkers has already closed any open tooltip.)

**4b — `pointermove`.** Clear any live hover, then bail:

```js
      markerCanvas.addEventListener('pointermove', function (moveEv) {
        if (!markerCanInteract()) {
          if (markerHovered !== -1) { markerSetHover(markerHovered, false); }
          return;
        }
        var rect = markerCanvas.getBoundingClientRect();
```

**4c — `window.__ssPortalMarkerAt`.** Replace the body:

```js
      window.__ssPortalMarkerAt = function (x, y) {
        return markerCanInteract() && markerHitTest(markers, x, y) !== -1;
      };
```

**4d — `refreshPortalMarkers`.** Insert directly after the `if (activeIndex !== markerScene) { ... }` block and before `var st = getState();`:

```js
    if (!markerCanInteract()) {
      markerCloseTip();
      if (markerHovered !== -1) { markerSetHover(markerHovered, false); }
    }
```

- [ ] **Step 5: Fix the stale `gamingControls` assertion**

In `test/portal-markers.test.ts`, replace the whole body of the test named `reads the suppression inputs from the viewer, not from annotations` with:

```ts
    it('reads the suppression inputs from the viewer, not from annotations', () => {
        expect(markerRuntime).toContain('window.sse.config.noui');
        expect(markerRuntime).toContain("transState.phase !== 'idle'");
        expect(markerRuntime).not.toContain('controlsHidden');
        // Visibility is deliberately NOT a function of gamingControls -- icons
        // stay on screen while the joystick / pointer lock is active, and only
        // their pointer response goes away (markerInteractive, a separate
        // predicate). Assert the exact argument object rather than the bare
        // string, which now legitimately appears elsewhere in the runtime.
        expect(markerRuntime).toContain(
            '    var visible = markerVisible({\n' +
            '      noui: markerNoui,\n' +
            "      cameraMode: (st && st.cameraMode) || 'orbit',\n" +
            "      transitionActive: !!(transState && transState.phase !== 'idle')\n" +
            '    });'
        );
    });
```

- [ ] **Step 6: Add the `gamingControls:changed` listener**

In `src/viewer-companion/portals.ts`, insert directly after the `ev.on('cameraMode:changed', ...)` block that ends at line 1109:

```js
      // Gaming controls flip the icons non-interactive (markerInteractive), and
      // this is the ONLY event that fires on that transition -- without it a
      // tooltip or hover tint opened before the user pressed G would survive it.
      ev.on('gamingControls:changed', function () {
        refreshPortalMarkers();
      });
```

- [ ] **Step 7: Run the marker and injection tests**

Run: `npx vitest run test/portal-markers.test.ts test/portal-marker.test.ts test/portals-injection.test.ts > /tmp/t2.log 2>&1; tail -40 /tmp/t2.log`

Expected: PASS, all three files green — including the rewritten `reads the suppression inputs` test and the `parses as a function body` / no-backslash / no-backtick guards.

- [ ] **Step 8: Commit**

```bash
git add src/portal-marker.ts src/viewer-companion/portal-markers.ts src/viewer-companion/portals.ts test/portal-markers.test.ts
git commit -m "fix(portals): marker icons stop taking clicks under gaming controls"
```

---

### Task 3: Re-clicking an icon closes its tooltip

**Files:**
- Modify: `src/viewer-companion/portal-markers.ts` (the `pointerup` listener's hit branch)
- Test: `test/portal-markers.test.ts`

**Interfaces:**
- Consumes: Task 2's gated `pointerup` handler.
- Produces: nothing new. `markerTipOwner` keeps its existing meaning (portal index owning the open tooltip, `-1` for none).

**Note on the interaction with the engine guards:** the closing click is still reported as a hit by `window.__ssPortalMarkerAt`, so it is still suppressed from navigating. That is deliberate — a click on an icon never moves the camera, whatever it does to the tooltip — and it is on the E2E list in Task 6.

- [ ] **Step 1: Write the failing test**

Add to the `describe('markerRuntime', ...)` block in `test/portal-markers.test.ts`:

```ts
    it('closes an open tooltip when its own icon is clicked again', () => {
        // Click the open marker -> close; a different marker -> switch; the
        // canvas -> close. The closing click is still swallowed by the engine
        // guards, so re-clicking to dismiss does not move the camera either.
        expect(markerRuntime).toContain('if (hit === -1 || hit === markerTipOwner) { markerCloseTip(); } else { markerOpenTip(hit); }');
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/portal-markers.test.ts -t "clicked again" > /tmp/t3.log 2>&1; tail -20 /tmp/t3.log`

Expected: FAIL — substring not found.

- [ ] **Step 3: Implement the toggle**

In `src/viewer-companion/portal-markers.ts`, in the `pointerup` listener, replace:

```js
        if (hit !== -1) { markerOpenTip(hit); } else { markerCloseTip(); }
```

with:

```js
        if (hit === -1 || hit === markerTipOwner) { markerCloseTip(); } else { markerOpenTip(hit); }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/portal-markers.test.ts > /tmp/t3.log 2>&1; tail -30 /tmp/t3.log`

Expected: PASS, whole file green.

- [ ] **Step 5: Commit**

```bash
git add src/viewer-companion/portal-markers.ts test/portal-markers.test.ts
git commit -m "feat(portals): a second click on a marker closes its tooltip"
```

---

### Task 4: Hide the nav hover ring over an icon

**Files:**
- Modify: `src/viewer-engine-patch.ts` (append a 7th entry to `PATCHES`)
- Test: `test/viewer-engine-patch.test.ts`

**Interfaces:**
- Consumes: `window.__ssPortalMarkerAt(x, y)` from Task 2.
- Produces: `VIEWER_ENGINE_PATCH_COUNT` becomes `7`.

**Background:** the viewer's walk-mode hover ring is `NavCursor.hoverRing`, driven by a canvas `pointermove` listener. The viewer's own annotations hide it for free — their DOM hotspot div makes the canvas fire `pointerleave`, and `NavCursor.onPointerLeave` hides the ring. Portal markers have no DOM hit-target by design (a per-marker div swallowed the orbit-drag and click-to-walk gestures that start on a doorway), so the canvas keeps getting `pointermove` and the ring keeps tracking. Reaching the `NavCursor` instance from the companion was rejected: the hover ring and the target ring share one `<svg>`, so hiding it would take the click-target ring too, and the instance is not published on `window.__supersplatViewer`.

`updateCursor` receives the offsets as parameters — canvas-relative CSS pixels, the same space `__ssPortalMarkerAt` expects.

- [ ] **Step 1: Write the failing test**

In `test/viewer-engine-patch.test.ts`, add the snippet constant after `MOBILE_TAP_SNIPPET`:

```ts
// NavCursor.updateCursor, the walk-mode hover ring (fork patch: hide the ring
// while the pointer is over a portal icon, so "ring gone" reads as "this click
// opens a tooltip and will not move you"). 4-/8-space indented. The viewer's own
// annotations get this for free from their DOM hotspot making the canvas fire
// pointerleave; the markers have no DOM hit-target by design.
const NAV_CURSOR_SNIPPET =
    '    updateCursor(offsetX, offsetY) {\n' +
    '        if (!this.hoverActive || this.navigating) {\n' +
    '            this.hoverRing.hide();\n' +
    '            return;\n' +
    '        }\n';
```

Add it to the synthetic bundle, between the mobile-tap snippet and the export tail:

```ts
const BUNDLE = CAMERA_MANAGER_SNIPPET + INITXR_SNIPPET + POINTER_UP_SNIPPET + MOBILE_TAP_SNIPPET + NAV_CURSOR_SNIPPET + EXPORT_SNIPPET;
```

Change the count assertion in the first test from `6` to `7`:

```ts
        expect(VIEWER_ENGINE_PATCH_COUNT).toBe(7);
```

and add, at the end of that same first test:

```ts
        // fork patch: the walk-mode nav hover ring hides while the pointer is
        // over a portal icon. Same predicate the click guards use, so the ring
        // vanishing is an honest preview of "this click will not move you".
        expect(source).toContain(
            '    updateCursor(offsetX, offsetY) {\n' +
            '        if (window.__ssPortalMarkerAt && window.__ssPortalMarkerAt(offsetX, offsetY)) { this.hoverRing.hide(); return; }\n' +
            '        if (!this.hoverActive || this.navigating) {\n'
        );
```

Leave the `patches partial bundles` and `does not publish engine classes` tests alone — neither includes `NAV_CURSOR_SNIPPET`, so their expected counts of `2` and `5` are still correct.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/viewer-engine-patch.test.ts > /tmp/t4.log 2>&1; tail -40 /tmp/t4.log`

Expected: FAIL — `expected 6 to be 7`.

- [ ] **Step 3: Add the patch**

In `src/viewer-engine-patch.ts`, append to the `PATCHES` array after the `_onMobileTap` entry:

```ts
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
    {
        search:
            '    updateCursor(offsetX, offsetY) {\n' +
            '        if (!this.hoverActive || this.navigating) {\n',
        replace:
            '    updateCursor(offsetX, offsetY) {\n' +
            '        if (window.__ssPortalMarkerAt && window.__ssPortalMarkerAt(offsetX, offsetY)) { this.hoverRing.hide(); return; }\n' +
            '        if (!this.hoverActive || this.navigating) {\n'
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/viewer-engine-patch.test.ts > /tmp/t4.log 2>&1; tail -40 /tmp/t4.log`

Expected: PASS, all five tests in the file — including `is idempotent (a second pass matches nothing)`, which proves the new anchor self-destructs.

- [ ] **Step 5: Commit**

```bash
git add src/viewer-engine-patch.ts test/viewer-engine-patch.test.ts
git commit -m "feat(portals): the walk-mode nav ring hides over a portal icon"
```

---

### Task 5: Restore the canvas cursor on hover-out

**Files:**
- Modify: `src/viewer-companion/portal-markers.ts` (`markerSetHover` and the state var block)
- Test: `test/portal-markers.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a new runtime var `markerCursorSaved`.

**The bug:** `markerSetHover` sets `markerCanvas.style.cursor = 'pointer'` on hover-in and `''` on hover-out. The `''` wipes the viewer's own `'pointer'` cursor, which `NavInteraction._updateCursor` sets whenever a click can target something — so after hovering off an icon in walk / fly / orbit you get a default arrow until your next click restores it.

- [ ] **Step 1: Write the failing test**

Add to the `describe('markerRuntime', ...)` block in `test/portal-markers.test.ts`:

```ts
    it('restores the viewer cursor on hover-out instead of clearing it', () => {
        // The viewer sets its own 'pointer' whenever a click can target
        // something (NavInteraction._updateCursor). Clearing to '' left a
        // default arrow behind until the user's next click.
        expect(markerRuntime).toContain('markerCursorSaved = markerCanvas.style.cursor;');
        expect(markerRuntime).toContain('markerCanvas.style.cursor = markerCursorSaved;');
        expect(markerRuntime).not.toContain("markerCanvas.style.cursor = '';");
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/portal-markers.test.ts -t "restores the viewer cursor" > /tmp/t5.log 2>&1; tail -20 /tmp/t5.log`

Expected: FAIL — substring not found.

- [ ] **Step 3: Implement the save/restore**

In `src/viewer-companion/portal-markers.ts`, add a state var directly after the `var markerHovered = -1;` line:

```js
  var markerCursorSaved = '';  // canvas cursor as it was when the hover started
```

Then replace the body of `markerSetHover`'s if/else-if:

```js
    if (on) {
      markerHovered = index;
      if (markerCanvas) {
        // Save and restore rather than clear: the viewer sets its own 'pointer'
        // whenever a click can target something, and clearing to '' left a
        // default arrow behind until the user's next click. If the viewer
        // changes the cursor WHILE an icon is hovered we write back a stale
        // value -- accepted, it self-heals on the next pointerdown/up pair.
        markerCursorSaved = markerCanvas.style.cursor;
        markerCanvas.style.cursor = 'pointer';
      }
    } else if (markerHovered === index) {
      markerHovered = -1;
      if (markerCanvas) { markerCanvas.style.cursor = markerCursorSaved; }
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/portal-markers.test.ts > /tmp/t5.log 2>&1; tail -30 /tmp/t5.log`

Expected: PASS, whole file green.

- [ ] **Step 5: Commit**

```bash
git add src/viewer-companion/portal-markers.ts test/portal-markers.test.ts
git commit -m "fix(portals): marker hover-out restores the viewer cursor"
```

---

### Task 6: Full gates and hand-off memo update

**Files:**
- Modify: `docs/superpowers/2026-08-06-portal-viewer-icon-handoff.md`

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces: nothing consumed by later tasks — this is the last one.

- [ ] **Step 1: Run the full test suite**

Run: `npm run test > /tmp/gate-test.log 2>&1; tail -20 /tmp/gate-test.log`

Expected: all files pass. The count was 683 before this branch's refinements; it should now be 683 plus the tests added in Tasks 1-5 (7 + 3 + 1 + 1 = 12 new, one rewritten in place) = **695**. If the number differs, find out why before continuing — do not just update the figure.

- [ ] **Step 2: Run lint**

Run: `npm run lint > /tmp/gate-lint.log 2>&1; echo "exit=$?"; tail -20 /tmp/gate-lint.log`

Expected: `exit=0`. If ESLint reports import-order problems, fix them BY HAND — never run the autofix, it crashes on ESLint 10.

- [ ] **Step 3: Run the build and check the real type gate**

```bash
npm run build > /tmp/gate-build.log 2>&1
echo "typescript diagnostics: $(grep -c 'plugin typescript' /tmp/gate-build.log)"
```

Expected: `typescript diagnostics: 0`. The build's own exit code proves nothing here — Rollup reports TypeScript errors as warnings and exits 0 regardless.

- [ ] **Step 4: Rebuild the shared export core**

```bash
node scripts/build-shared.mjs
ls dist-shared/portal-marker.js dist-shared/viewer-companion/portal-markers.js
```

Expected: both files listed. The export server imports `dist-shared`, so a stale copy would make a server export behave differently from a local one.

- [ ] **Step 5: Update the "What shipped" table**

In `docs/superpowers/2026-08-06-portal-viewer-icon-handoff.md`, replace the `click` and `hover` rows of the What shipped table with:

```markdown
| click | canvas hit-test against the icon's projected ellipse → tooltip, "Portal to another scene", localized in 9 languages; the camera does **not** move. Clicking the open icon again closes the tooltip |
| orientation | lies flat in the portal's plane; foreshortens and disappears when viewed edge-on |
| hover | emissive tints orange, cursor becomes a pointer, and the viewer's walk-mode nav hover ring hides |
| pointer | **inert while gaming controls are on** (mobile joystick, desktop pointer lock) — icons stay visible, no tooltip, no tint, the jump is untouched |
```

(The `orientation` row is unchanged — it is reproduced here only because it sits between the two rows being edited.)

- [ ] **Step 6: Rewrite E2E items 13 and 21**

In the same file, replace those two rows of the Checks table:

```markdown
| 13 | With gaming controls **on** (press G, or the mobile joystick), click/tap an icon | Nothing happens: no tooltip, no hover tint. In walk mode on a phone the tap still jumps, and only jumps |
| 21 | Load on a phone | Icons render, no context loss. With gaming controls **off** a tap opens the tooltip; with them **on** a tap jumps and no tooltip appears |
```

- [ ] **Step 7: Add the new E2E items**

Append to the Checks table, after item 32:

```markdown
| 33 | Click an icon whose tooltip is already open | Tooltip closes, and you do not move |
| 34 | Walk mode, hover an icon | The nav hover ring on the floor disappears while the pointer is over the icon |
| 35 | Walk mode, move a few tens of pixels off the icon | The ring comes back and tracks normally |
| 36 | Walk mode, stand where a wall hides an icon and hover that spot | The ring disappears there too — the cue for item 32's known limitation |
| 37 | Open a tooltip in walk mode, then press **G** | Tooltip closes and the hover tint clears |
| 38 | Walk mode, hover an icon then move off it | The cursor returns to the viewer's pointer, not a default arrow |
```

Then update the sentence below the table so it reads:

```markdown
Items **9, 10, 15, 30, 31, 33 and 34** are the ones to watch: 9, 10 and 15 cover
regressions the reviews caught that no automated test can prove; 30-31 verify
that the tooltip hit test and the engine guard read the same sample (the press
position); and 33-34 are the two behaviours that changed after the first E2E
pass.
```

- [ ] **Step 8: Fix the now-wrong "known limitation"**

Replace the first bullet under Known limitations, which currently claims pointer lock takes nothing away:

```markdown
- **Inert while gaming controls are on.** With the mobile joystick or desktop
  pointer lock active, the icons stay visible but ignore the pointer entirely.
  On touch a tap there is the viewer's jump, raised inside the touch input
  source where neither click guard can see it; on desktop pointer lock freezes
  `clientX`/`clientY`, so any hit test would read a stale point. Visibility is
  the point of the icon in those modes, not clickability.
```

Leave the "An icon fully hidden behind geometry is still clickable" bullet in place, but append to it:

```markdown
  The walk-mode nav hover ring now disappears over such a spot, which is the
  only available warning that the click will not move you.
```

- [ ] **Step 9: Add the new commits to the Commits table**

Append rows for the five commits from Tasks 1-5, using their real short hashes from `git log --oneline -6`:

```markdown
| `<hash>` | `markerInteractive` — pointer response gated on the gaming-controls state |
| `<hash>` | marker icons stop taking clicks under gaming controls |
| `<hash>` | a second click on a marker closes its tooltip |
| `<hash>` | the walk-mode nav ring hides over a portal icon |
| `<hash>` | marker hover-out restores the viewer cursor |
```

Also update the Automated gates block's test figure from `683 passed (683), 52 files` to whatever step 1 actually reported.

- [ ] **Step 10: Commit**

```bash
git add docs/superpowers/2026-08-06-portal-viewer-icon-handoff.md
git commit -m "docs(portals): fold the post-E2E interaction refinements into the memo"
```

- [ ] **Step 11: Report the state honestly**

Report to the user: the four gates and their actual numbers, and that a **second browser E2E pass is required** — every change in this plan is in the exported viewer's pointer handling, which no automated test in this repo executes. The specific items to re-run are 5-10, 13, 21, 23-27, 30-38. The branch stays unsquashed and unpushed until that pass is done.

---

## Self-Review

**Spec coverage:**

| spec section | task |
| --- | --- |
| Change A — `markerInteractive` helper | Task 1 |
| Change A — 4 companion call sites + `gamingControls:changed` listener | Task 2 |
| Change B — re-click toggles closed | Task 3 |
| Change C — 7th engine patch, count 6 → 7 | Task 4 |
| Change D — cursor save/restore | Task 5 |
| Testing — `test/portal-marker.test.ts` | Task 1 step 1 |
| Testing — `test/viewer-engine-patch.test.ts` | Task 4 step 1 |
| Testing — `test/portal-markers.test.ts` string assertions | Tasks 2, 3, 5 |
| Testing — `test/portals-injection.test.ts` | Task 2 step 7 runs it; the listener is covered by the existing "companion contains its listeners" assertions rather than a new one |
| E2E impact — rewrites and additions | Task 6 steps 6-8 |

No gaps.

**Placeholder scan:** the only `<hash>` placeholders are in Task 6 step 9, where the values cannot exist until Tasks 1-5 have been committed; the step says where to get them.

**Type consistency:** `markerInteractive` takes `{ cameraMode, gamingControls }` and is referenced under that exact name and shape in Tasks 1, 2 and the runtime helper `markerCanInteract`. `window.__ssPortalMarkerAt(x, y)` keeps its existing two-argument signature and boolean return in Tasks 2 and 4. `markerTipOwner`, `markerCloseTip`, `markerOpenTip`, `markerSetHover`, `markerHovered` and `markerCanvas` are all pre-existing names used as they already are.
