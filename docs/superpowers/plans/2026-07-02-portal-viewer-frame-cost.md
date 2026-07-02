# Portal Viewer Frame-Cost Elimination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the steady-state per-frame CPU cost and GC pressure in the exported portal viewer runtime (octree re-scans, hot-path allocations, redundant residency polling) and in the editor walkthrough preview (per-frame rects rebuild + Vec3 allocation).

**Architecture:** Four independent fixes: (1) rewrite the two pure crossing helpers in `src/portal-geom.ts` to be allocation-free in the no-crossing steady state (inline scalar math, lazy result creation), guarded by the existing unit tests; (2) throttle-and-stop the per-frame `updateDeviceFinest` octree scan in the exported viewer's rAF `tick` via a new pure, unit-tested, stringifiable cadence helper, and reuse persistent position buffers in `tick`; (3) make the pin-residency poll (`awaitResident`) track only not-yet-resident files (swap-remove remaining-set) so its per-frame work shrinks to zero; (4) cache the editor walkthrough's portal-rects array (rebuild only on `portals.changed` / activation) and reuse scratch objects in its prerender handler.

**Tech Stack:** TypeScript, Vitest (Node env), PlayCanvas engine (read-only — verified contracts cited below), Rollup + terser (release build), `Function.prototype.toString()` stringification for the exported-viewer runtime.

## Series note

This plan is one of a 6-plan series written 2026-07-02 against commit `916666a`. Plans 3 (mobile memory), 5 (crossing robustness), and 6 (this one) all modify `src/viewer-companion/portals.ts`; plans 3 and 5 are expected to have merged before this one executes. **All line numbers in this plan are against `916666a` and WILL have drifted.** Task 0 (preflight) is mandatory: for each file:line citation and code anchor, grep to confirm the anchor still exists; where code has drifted, adapt this plan's snippets to the current code — anchor on function names and the described behavior, never paste blindly.

## Context

### What this codebase is (condensed primer)

SuperSplat (repo root `C:\Dev\playcanvas\supersplat`) is a browser-based 3D Gaussian-splat editor built on the PlayCanvas engine + PCUI. This fork adds a **portals** feature: a project holds multiple scenes; the exported HTML viewer renders one scene at a time and swaps when the camera crosses a doorway (portal rectangle).

Key facts you need for this plan:

- A single event bus (`src/events.ts`, created in `src/main.ts`) wires everything: `events.fire/on` = pub-sub, `events.function/invoke` = queryable state. Modules register via `registerXxxEvents(events)` from `main.ts`.
- `src/viewer-companion/portals.ts` holds the **playcanvas-free** runtime baked into the exported HTML viewer by **stringification**: pure helper functions are inlined via `Function.prototype.toString()` plus a hand-written IIFE template string (`companionRuntime`, consumed by `buildPortalsInjection`). CRITICAL CONSTRAINTS for any code that gets stringified:
  1. Helpers must be fully self-contained — **no references to sibling functions, imports, or module-level variables** (after terser minification those names are mangled and the stringified copy would throw `ReferenceError` at runtime). The one allowed pattern is dependency injection: pass the sibling in as a parameter (see `resolveActiveSplat`'s `cross` param in `src/portal-geom.ts`).
  2. Logic inside the IIFE template string is NOT unit-testable. Testable decision logic lives in pure, exported, stringifiable helpers (`src/portal-geom.ts`, `src/portal-preload.ts`, `src/portal-anim-timeline.ts` — all pure + unit-tested); the template string is thin wiring.
  3. Any change to viewer-companion code MUST be E2E-verified with a **RELEASE build** (`npm run build`), not just debug — minification bugs only appear in release. Note: the IIFE template's own text is a string literal in the bundle, so its internal function names (`tick`, `updateDeviceFinest`, `awaitResident`, …) survive minification and remain searchable in the DevTools profiler; only the `${helper.toString()}` splices carry minified bodies.
- The editor-side walkthrough preview lives in `src/portals-runtime.ts` (per-frame `prerender` handler on the event bus); portal state + mutation events live in `src/portals.ts`.

### The four defects being fixed (audited at `916666a`; re-verify in Task 0)

**1. [MED] `updateDeviceFinest` scans the entire start-scene octree every rAF frame, forever.**
`src/viewer-companion/portals.ts:427` calls `updateDeviceFinest()` unconditionally at the top of `tick()` (the rAF loop that runs for the whole session). Its body (`:593-602`) iterates `oc.files.length` entries calling `oc.getFileResource(i)` (an engine `Map.get`) per file, per frame. `deviceFinest` is a **running-min** (only ratchets finer/lower) that settles within seconds of startup — after that every scan is pure waste: O(files) engine calls × 60 fps × session lifetime, a real battery cost on mobile.
*Fix:* extract the "should we sample this frame?" decision into a new pure stringifiable helper `shouldSampleDeviceFinest` (unit-tested, `src/portal-preload.ts` pattern): sample every frame during an initial 600-frame settle window (~10 s @ 60 fps — matches the runtime's other settle caps: `pinWhenBudgetReady` waits ≤ 600 frames, `awaitResident` ≤ 600 frames, `LOADING_MAX_FRAMES` = 600), then back off to every 30th frame (~0.5 s — a late ratchet is still caught within half a second at 1/30 the cost), and stop permanently once `deviceFinest <= 0` (level 0 is the engine's finest; the running-min cannot improve) or once it has been stable for 600 consecutive frames AND the first pin cycle has consumed it (`pinReady === true` — `pinWhenBudgetReady` sets `pinReady` and immediately runs `pinDesired()`, i.e. the first pin cycle consumes `deviceFinest` the moment the flag flips). The running-min semantics are untouched; the octree iteration itself stays in the IIFE (engine-coupled). The bounded pre-`pinReady` poll inside `pinWhenBudgetReady` (`:684-696`) also calls `updateDeviceFinest` per frame, but it self-terminates at `pinReady`/600 frames and never runs again afterwards — it is deliberately left unchanged (minimal change; it needs per-frame freshness for its own stability check).

**2. [MED] Per-frame allocations in the crossing hot path.**
- `tick()` allocates a fresh 3-element position array every frame (`:432`: `var cur = [cam.position.x, cam.position.y, cam.position.z];`), retained via `lastSafe = cur` (`:452`).
- `resolveActiveSplat` (`src/portal-geom.ts:80-97`) allocates a `crossings` array every call — every frame, even when nothing is crossed — plus a `for..of` iterator; and `segmentCrossesRect` (`:20-67`) allocates per portal per frame: a `toLocal` closure, two 3-element arrays (`:27-38`, `:40-41`), and (on crossing) a result object.
*Fix:* rewrite both helpers with inline scalar math (local `number` variables only — **NO module-level scratch objects**: stringified helpers cannot reference module symbols, and per-call closures/arrays are exactly what is being removed). The `crossings` array is created lazily, only when a crossing is actually detected (rare — allowed). The functions stay pure, self-contained, dependency-injected (`cross` param preserved), and **behaviorally identical** — the existing tests in `test/portal-geom.test.ts` are the safety net and must pass unchanged; new edge tests lock boundary behavior before the rewrite. In `tick`, a persistent `cur` scratch array and a persistent `lastSafe` buffer are reused inside the IIFE closure (allowed — the IIFE is the template, not a stringified helper). *The rewritten implementations below were validated against the full existing suite plus the new edge tests (38/38 pass, both old and new implementation) before this plan was written.*

*Test coverage the rewrite leans on:* direct — `test/portal-geom.test.ts` (10 `segmentCrossesRect` + 3 `resolveActiveSplat` cases at `916666a`); indirect — `test/portal-anim-timeline.test.ts` (drives `resolveActiveSplat` through the export-time timeline builder) and `test/portals-injection.test.ts` (stringifies both functions into the emitted runtime, catching any accidental sibling/module reference). Representative existing cases (verbatim from `test/portal-geom.test.ts`):

```ts
it('reports a front-side crossing through the rectangle', () => {
    const c = segmentCrossesRect([0, 0, -1], [0, 0, 1], rect());
    expect(c).toEqual({ side: 'front', t: 0.5 });
});

it('handles a rotated portal (90 deg about Y, normal along world +X)', () => {
    const r = rect({ rotation: [0, 0.7071067811865476, 0, 0.7071067811865476] });
    const c = segmentCrossesRect([-1, 0, 0], [1, 0, 0], r);
    expect(c?.side).toBe('front');
    expect(c?.t).toBeCloseTo(0.5);
});

it('applies multiple crossings in order along the segment (last wins)', () => {
    const a = rect({ position: [0, 0, 0], frontUid: 10, backUid: 20 });
    const b = rect({ position: [0, 0, 5], frontUid: 30, backUid: 40 });
    // segment from z=-1 to z=6 crosses A (t~0.14) then B (t~0.86)
    expect(resolveActiveSplat([0, 0, -1], [0, 0, 6], [a, b], 20)).toBe(30);
});
```
- The editor preview call site of `resolveActiveSplat` is fixed separately in defect 4.

**3. [MED] `awaitResident` re-polls every pinned file every frame.**
`src/viewer-companion/portals.ts:643-652` (inside `pinSceneToLevel`): the residency poll calls `octree.ensureFileResource(fileIndex)` + `octree.getFileResource(fileIndex)` for **every** pinned file of a pinning scene, every rAF frame, for up to 600 frames — even for files that became resident on frame 2.

*Verified engine contract* (cite: `node_modules/playcanvas/build/playcanvas/src/scene/gsplat-unified/gsplat-octree.js`):
- `getFileResource(fileIndex)` (`gsplat-octree.js:96-98`) returns `this.fileResources.get(fileIndex)` — the resource object, or `undefined` when not resident.
- `ensureFileResource(fileIndex)` (`gsplat-octree.js:143-159`) **returns `undefined` (void) — neither the resource nor a flag.** Behavior: if `fileResources.has(fileIndex)` → early return; else it asks `assetLoader.getResource(url)` — if the loader has finished, it **migrates the resource into `fileResources`** (the map `getFileResource` reads) and returns; otherwise it calls `assetLoader.load(url)`.
- `assetLoader.load(url)` (`node_modules/playcanvas/build/playcanvas/src/framework/components/gsplat/gsplat-asset-loader.js:33-46`) **dedupes**: it early-returns if the asset is loaded, currently loading, or already queued — so re-polls never multiply network requests, but each call still costs Map/Set lookups plus an O(queue) `Array.includes` scan.
- **Consequence — the first call per file is load-bearing, and re-polls of NOT-yet-resident files are also load-bearing:** there is no callback; the only way an arrived resource enters `fileResources` is a *later* `ensureFileResource` call. (The engine's own `GSplatOctreeInstance.update` does this polling for *enabled* scenes, but a pinned scene is disabled and has no render instance, so our poll is the only driver.) The waste is exclusively the calls for files that are **already resident**: once `getFileResource(i)` is truthy for a pinned file it can never become non-resident while pinned (`incRefCount` (`gsplat-octree.js:99-103`) deletes the cooldown; `unloadResource` is only reached via `decRefCount`/`updateCooldownTick` when the refcount is 0 (`gsplat-octree.js:104-114`, `:126-142`), and our `decRefCount` lives in `unpinScene`, which bumps `pinGen[idx]` and kills the poll loop).
*Fix:* build a `remaining` array of not-yet-resident pinned file indices when the poll starts, and swap-remove entries as they become resident — per-frame work shrinks to zero as loading completes. Termination, `pinGen` invalidation, the 600-frame cap, and the `readyScenes[idx] = true` completion signal are preserved exactly.

**4. [LOW] Editor walkthrough preview allocates per prerender frame.**
`src/portals-runtime.ts:84-103`: while walkthrough is on, every `prerender` calls `buildRects()` (`:29-40`), which does `events.invoke('portals.list')` + `.map` into a fresh array of fresh objects, and `cameraWorldTransform.getTranslation()` with no argument, which allocates a new `Vec3` per call (verified: `Mat4.getTranslation(t?: Vec3): Vec3` — `node_modules/playcanvas/build/playcanvas.d.ts:11828` — allocates only when `t` is omitted). Two fresh `[x, y, z]` tuples are also built per frame for the `resolveActiveSplat` call.
*Fix:* cache the rects array; rebuild it on walkthrough activation (`enable()`) and on the `portals.changed` event. `portals.changed` provably fires on **every** portal mutation — `src/portals.ts:139` defines `const fireChanged = () => events.fire('portals.changed');`, called from all seven mutation paths: `portals.insertRaw` (`:164`), `portals.removeRaw` (`:175`), `portals.updateRaw` (`:183` — `Object.assign(p, patch)` covers move/resize/rebind), `portals.setStartRaw` (`:189`), `portals.setEntrypointRaw` (`:198`), `scene.clear` (`:217`), and `docDeserialize.portals` (`:276`). Reuse a persistent scratch `Vec3` for `getTranslation` and two persistent tuples for the `resolveActiveSplat` arguments. This module imports playcanvas but loads fine under Vitest's Node env (verified), so the fix is genuinely TDD-able with an `Events` double (pattern: `test/portals.test.ts`).

### Why this order

Task 1 (portal-geom) is pure and fully test-guarded — do it first while the file is untouched. Tasks 2–3 edit the IIFE template in `src/viewer-companion/portals.ts` (drift risk from plans 3/5 — reconcile in Task 0). Task 4 is editor-only and independent. Task 5 is the release-build manual E2E; Task 6 finishes the branch.

## Global Constraints

- Use Bash (Git Bash on Windows), never PowerShell. Run commands plainly from the repo root — no `cd`, `git -C`, or `npm --prefix` prefixes (they trigger permission prompts).
- ESLint is pinned to v10 and **crashes on `import/order` autofix** — never run `eslint --fix` for import ordering; match surrounding import order by hand.
- Never delete `package-lock.json`.
- `tsconfig`: `strictNullChecks: false`, `noImplicitAny: true`. Match surrounding code style; comments explain constraints, not narration.
- Don't touch code unrelated to the task. In particular: do not modify the engine (`node_modules/`), do not touch `pinWhenBudgetReady`'s internal poll, do not restructure the IIFE beyond the snippets below.
- Stringification rules (see Context) apply to `src/portal-geom.ts`, `src/portal-preload.ts`, and the `companionRuntime` template: any exported helper spliced via `${fn.toString()}` must be fully self-contained (no imports, no sibling references, no module-level scratch); DI via parameters only.
- Behavioral identity: `segmentCrossesRect` / `resolveActiveSplat` signatures and observable behavior must not change; all existing tests pass unchanged.
- Work on a feature branch (suggested: `perf/portal-viewer-frame-cost`). When complete and verified, squash all commits into a single commit per project convention (Task 6).
- Commands: all tests `npm run test`; one file `npx vitest run test/portal-geom.test.ts`; lint `npm run lint`; typecheck `./node_modules/.bin/tsc --noEmit`; release build `npm run build`; serve the release build `npm run serve` (→ http://localhost:3333).

---

### Task 0: Preflight — reconcile anchors against the current tree

**Files:**
- Read-only: `src/viewer-companion/portals.ts`, `src/portal-geom.ts`, `src/portal-preload.ts`, `src/portals-runtime.ts`, `src/portals.ts`, `test/portal-geom.test.ts`, `test/portal-preload.test.ts`, `test/portals-injection.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a confirmed (or corrected) map of anchors for Tasks 1–4.

- [ ] **Step 1: Create the branch and verify a clean baseline**

```bash
git checkout -b perf/portal-viewer-frame-cost
npm run test
```
Expected: all test files pass (at `916666a`: 11 files). If the baseline is red, STOP and report — do not build on a broken base.

- [ ] **Step 2: Confirm every anchor this plan relies on**

```bash
grep -n "function tick()" src/viewer-companion/portals.ts
grep -n "updateDeviceFinest" src/viewer-companion/portals.ts
grep -n "var cur = \[cam.position" src/viewer-companion/portals.ts
grep -n "var lastSafe = null" src/viewer-companion/portals.ts
grep -n "lastSafe = cur" src/viewer-companion/portals.ts
grep -n "awaitResident" src/viewer-companion/portals.ts
grep -n "ensureFileResource" src/viewer-companion/portals.ts
grep -n "pinReady" src/viewer-companion/portals.ts
grep -n "const segmentCrossesRect\|const resolveActiveSplat" src/portal-geom.ts
grep -n "buildRects\|portals.list\|getTranslation" src/portals-runtime.ts
grep -n "fireChanged" src/portals.ts
grep -n "desiredResidentScenes" src/portal-preload.ts
```
Expected (at `916666a`): hits at viewer-companion/portals.ts `:423`, `:427`/`:593`/`:689`, `:432`, `:92`, `:452`, `:643`, `:628`/`:647`, `:86`/`:684`/`:691`; portal-geom.ts `:20`/`:80`; portals-runtime.ts `:29`/`:30`/`:88`; portals.ts `:139` + 7 call sites; portal-preload.ts `:205`/`:227`.

- [ ] **Step 3: Reconcile drift from plans 3 and 5 of the series**

Plans 3 (mobile memory) and 5 (crossing robustness) also modify `src/viewer-companion/portals.ts` and may have merged first. For each anchor that has moved or changed shape:
- If `tick()`'s pose/crossing block differs from the `916666a` snippet shown in Task 2 (plan 5 may have altered the `lastSafe`/crossing logic): apply the *behavior* — "no fresh position array per frame; fill a persistent scratch, run the crossing logic, then copy into a persistent `lastSafe` buffer" — to whatever the current block is. Any `lastSafe = null` reset paths (e.g. the `inputEvent 'reset'` listener) stay as-is; they compose with the buffer scheme (null = unprimed; re-priming copies into the buffer).
- If `pinSceneToLevel`/`awaitResident` differ (plan 3 may have altered pinning): apply the Task 3 behavior — "poll `ensureFileResource`/`getFileResource` only for pinned files not yet resident, swap-removing as they arrive; keep the generation check, frame cap, and completion signal" — to the current loop.
- If `updateDeviceFinest`/`pinReady` were renamed or moved: adapt the Task 2 wiring to the current names; the helper `shouldSampleDeviceFinest` itself is name-independent.
Record what you adapted in the task-completion notes. If a defect this plan fixes was *already fixed* by an earlier plan (unlikely but possible), skip the corresponding task and note it.

- [ ] **Step 4: Commit nothing** — this task changes no files.

---

### Task 1: Allocation-free crossing math in `src/portal-geom.ts`

**Files:**
- Modify: `src/portal-geom.ts:20-97` (both function bodies; types, comments header, and exports unchanged)
- Test: `test/portal-geom.test.ts` (add 6 edge tests)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `segmentCrossesRect(prev: Vec3, cur: Vec3, rect: PortalRect): { side: 'front' | 'back', t: number } | null` and `resolveActiveSplat(prev: Vec3, cur: Vec3, portals: PortalRect[], currentUid: number | null, cross = segmentCrossesRect): number | null` — **signatures identical to today**. Consumers (`src/portals-runtime.ts`, `src/portal-anim-timeline.ts:75`, `src/viewer-companion/portals.ts:63-64` and its `:447` call) need no changes.

This is a behavior-preserving rewrite, so instead of fail-first TDD the flow is: **lock edge behavior with characterization tests against the current code (all must PASS), then rewrite, then verify still green.** If any Step 1 test FAILS against the current code, STOP — the current behavior differs from this plan's assumptions (possible drift from plan 5); reconcile before rewriting.

- [ ] **Step 1: Add edge-case characterization tests**

Append inside the existing `describe('segmentCrossesRect', ...)` block of `test/portal-geom.test.ts`:

```ts
    it('a segment starting exactly on the plane crosses at t = 0', () => {
        const c = segmentCrossesRect([0, 0, 0], [0, 0, 1], rect());
        expect(c?.side).toBe('front');
        expect(c?.t).toBeCloseTo(0);   // az = 0 -> t is -0; toBeCloseTo treats -0 as 0
    });

    it('returns null when both endpoints lie on the plane', () => {
        expect(segmentCrossesRect([0, 0, 0], [1, 1, 0], rect())).toBeNull();
    });

    it('an off-center rotated portal detects the crossing (position + rotation combined)', () => {
        const r = rect({ position: [5, 0, 0], rotation: [0, 0.7071067811865476, 0, 0.7071067811865476] });
        const c = segmentCrossesRect([4, 0, 0], [6, 0, 0], r);
        expect(c?.side).toBe('front');
        expect(c?.t).toBeCloseTo(0.5);
    });
```

(Do NOT use `toEqual({ side: 'front', t: 0 })` for the first one: `t` is `-0` there — `0 / (0 - bz)` — and `toEqual` distinguishes `-0` from `0`.)

Append inside the existing `describe('resolveActiveSplat', ...)` block:

```ts
    it('a crossing into a null-bound side leaves the active scene unchanged', () => {
        expect(resolveActiveSplat([0, 0, -1], [0, 0, 1], [rect({ frontUid: null })], 20)).toBe(20);
    });

    it('returns the current uid for an empty portal list', () => {
        expect(resolveActiveSplat([0, 0, -1], [0, 0, 1], [], 20)).toBe(20);
    });

    it('a null-bound crossing between two real crossings does not erase the earlier one', () => {
        const a = rect({ position: [0, 0, 0], frontUid: 10, backUid: 20 });
        const b = rect({ position: [0, 0, 3], frontUid: null, backUid: null });
        expect(resolveActiveSplat([0, 0, -1], [0, 0, 4], [a, b], 20)).toBe(10);
    });
```

- [ ] **Step 2: Run — all tests must PASS against the current implementation**

Run: `npx vitest run test/portal-geom.test.ts`
Expected: `19 passed` (13 existing + 6 new). Any failure here = drift; stop and reconcile (Task 0 Step 3).

- [ ] **Step 3: Rewrite `segmentCrossesRect` (allocation-free steady state)**

Replace the whole `segmentCrossesRect` arrow function in `src/portal-geom.ts` (at `916666a`: lines 16-67, keeping the existing lead comment and adding the hot-path note) with:

```ts
// Crossing test for the segment prev -> cur against the portal rectangle.
// Adapted from the off-limits viewer collision (segmentBlockedByWall): same
// local-frame transform (rectangle in local XY, normal local Z), but instead of
// clamping it reports which side the camera ended on and the segment parameter t.
//
// Runs every rAF frame for every portal in the exported viewer, so the
// no-crossing path is allocation-free: the quaternion-conjugate rotation into
// the local frame is inlined as scalar math (no arrays, no closures); the only
// allocation is the result object on an actual crossing (rare).
const segmentCrossesRect = (prev: Vec3, cur: Vec3, rect: PortalRect): { side: 'front' | 'back', t: number } | null => {
    const cx = rect.position[0], cy = rect.position[1], cz = rect.position[2];
    const qx = rect.rotation[0], qy = rect.rotation[1], qz = rect.rotation[2], qw = rect.rotation[3];
    const hw = rect.width * 0.5;
    const hh = rect.height * 0.5;

    // Inverse (conjugate) rotation, applied inline to both endpoints:
    // local = v + qw*t + (qv x t) with t = 2*(qv x v), qv = (-qx,-qy,-qz).
    const ivx = -qx, ivy = -qy, ivz = -qz;

    let x = prev[0] - cx, y = prev[1] - cy, z = prev[2] - cz;
    let tx = 2 * (ivy * z - ivz * y);
    let ty = 2 * (ivz * x - ivx * z);
    let tz = 2 * (ivx * y - ivy * x);
    const ax = x + qw * tx + (ivy * tz - ivz * ty);
    const ay = y + qw * ty + (ivz * tx - ivx * tz);
    const az = z + qw * tz + (ivx * ty - ivy * tx);

    x = cur[0] - cx; y = cur[1] - cy; z = cur[2] - cz;
    tx = 2 * (ivy * z - ivz * y);
    ty = 2 * (ivz * x - ivx * z);
    tz = 2 * (ivx * y - ivy * x);
    const bx = x + qw * tx + (ivy * tz - ivz * ty);
    const by = y + qw * ty + (ivz * tx - ivx * tz);
    const bz = z + qw * tz + (ivx * ty - ivy * tx);

    const eps = 1e-9;
    if (az * bz > 0 || az === bz || (Math.abs(az) < eps && Math.abs(bz) < eps)) {
        return null;
    }

    const t = az / (az - bz);
    if (t < 0 || t > 1) {
        return null;
    }

    const hx = ax + t * (bx - ax);
    const hy = ay + t * (by - ay);
    // Per-edge bounds: an edge flagged `infinite` extends to the scene boundary,
    // so a crossing past that edge still counts. With no flags this is identical
    // to the original |hx| <= hw && |hy| <= hh test.
    const inf = rect.infinite;
    if (hx > hw && !(inf && inf.right)) return null;
    if (hx < -hw && !(inf && inf.left)) return null;
    if (hy > hh && !(inf && inf.top)) return null;
    if (hy < -hh && !(inf && inf.bottom)) return null;

    // The camera ends on the side of `cur`: local +Z is front, -Z is back.
    return { side: bz > 0 ? 'front' : 'back', t };
};
```

This is the exact same math as before (`toLocal` unrolled twice; `iw === qw` since only the vector part is negated in the conjugate). The `wxyz` naming shift (`ix/iy` hit-point vars renamed `hx/hy`) avoids colliding with the conjugate components.

- [ ] **Step 4: Rewrite `resolveActiveSplat` (lazy crossings array, indexed loops)**

Replace the whole `resolveActiveSplat` arrow function (at `916666a`: lines 80-97 — KEEP the long dependency-injection comment above it verbatim, appending the hot-path note) with:

```ts
// Walk all portals, apply each crossing in order along the segment, and return
// the resulting active splat uid (or the unchanged current uid if none cross).
//
// `cross` defaults to segmentCrossesRect and exists only so the exported-viewer
// companion can stringify this function (resolveActiveSplat.toString()) and inject
// it into a SEPARATE scope: after terser minification this body would otherwise
// call segmentCrossesRect by its mangled top-level name (e.g. `ZD`), which is not
// declared inside the injected IIFE -> ReferenceError that kills the runtime's
// rAF loop. The companion passes segmentCrossesRect explicitly (so the stringified
// default is never evaluated); the editor preview (portals-runtime.ts) and the
// unit tests run in-bundle and use the default.
//
// Hot path: called every rAF frame. The crossings array is created lazily so the
// steady state (no crossing this frame) allocates nothing; indexed loops avoid
// the for..of iterator allocation.
const resolveActiveSplat = (prev: Vec3, cur: Vec3, portals: PortalRect[], currentUid: number | null, cross = segmentCrossesRect): number | null => {
    let crossings: { t: number, uid: number | null }[] = null;
    for (let i = 0; i < portals.length; i++) {
        const p = portals[i];
        const c = cross(prev, cur, p);
        if (c) {
            if (!crossings) {
                crossings = [];
            }
            crossings.push({ t: c.t, uid: c.side === 'front' ? p.frontUid : p.backUid });
        }
    }
    if (!crossings) {
        return currentUid;
    }
    crossings.sort((m, n) => m.t - n.t);
    let active = currentUid;
    for (let i = 0; i < crossings.length; i++) {
        // a crossing into a side with no bound scene (null uid) leaves the active scene unchanged
        if (crossings[i].uid !== null) {
            active = crossings[i].uid;
        }
    }
    return active;
};
```

(`let crossings: ... = null` is fine under this repo's `strictNullChecks: false`.) The multi-crossing path is byte-for-byte the original algorithm (same stable `sort`, same null-uid skip), so ordering/tie behavior is unchanged; only the empty case skips the allocation.

- [ ] **Step 5: Run the geom tests, then the full suite**

Run: `npx vitest run test/portal-geom.test.ts`
Expected: `19 passed`.
Run: `npm run test`
Expected: all files pass (`portal-anim-timeline`, `portals-injection` also exercise these functions — the injection test stringifies them, catching any accidental sibling reference).

- [ ] **Step 6: Lint + typecheck + commit**

```bash
npm run lint
./node_modules/.bin/tsc --noEmit
git add src/portal-geom.ts test/portal-geom.test.ts
git commit -m "perf(portals): allocation-free crossing math in portal-geom"
```
Expected: lint clean, tsc exit 0.

---

### Task 2: `updateDeviceFinest` throttle/stop + persistent position buffers in `tick`

**Files:**
- Modify: `src/portal-preload.ts` (add + export `shouldSampleDeviceFinest`)
- Modify: `src/viewer-companion/portals.ts` (import + stringify the helper; add sampler state + `sampleDeviceFinest()`; replace the `tick` call; persistent `cur`/`lastSafe` buffers)
- Test: `test/portal-preload.test.ts` (new describe block), `test/portals-injection.test.ts` (one new containment assertion)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `shouldSampleDeviceFinest(frame: number, finest: number | null, stableFrames: number, pinConsumed: boolean): boolean` — exported from `src/portal-preload.ts`, stringified into the runtime. Semantics: `frame` = frames since runtime start (0-based), `finest` = current `deviceFinest` (null = unknown), `stableFrames` = frames since `deviceFinest` last changed, `pinConsumed` = the runtime's `pinReady` flag.

Part A (the pure helper) is fail-first TDD. Part B (IIFE wiring) is template-string code — **not unit-testable**; it is verified by lint + typecheck + the injection containment test + a release build (Task 5).

- [ ] **Step 1: Write the failing tests for the cadence helper**

Append to `test/portal-preload.test.ts` (and extend its import line to include `shouldSampleDeviceFinest`):

```ts
describe('shouldSampleDeviceFinest', () => {
    it('samples every frame during the initial settle window', () => {
        expect(shouldSampleDeviceFinest(0, null, 0, false)).toBe(true);
        expect(shouldSampleDeviceFinest(1, 3, 1, false)).toBe(true);
        expect(shouldSampleDeviceFinest(599, 2, 599, false)).toBe(true);
    });

    it('backs off to every 30th frame after the settle window', () => {
        expect(shouldSampleDeviceFinest(600, 2, 0, false)).toBe(true);   // 600 % 30 === 0
        expect(shouldSampleDeviceFinest(601, 2, 1, false)).toBe(false);
        expect(shouldSampleDeviceFinest(629, 2, 29, false)).toBe(false);
        expect(shouldSampleDeviceFinest(630, 2, 30, false)).toBe(true);
    });

    it('stops permanently once the finest possible level (0) is reached', () => {
        expect(shouldSampleDeviceFinest(10, 0, 0, false)).toBe(false);   // even inside the settle window
        expect(shouldSampleDeviceFinest(900, 0, 500, true)).toBe(false);
    });

    it('stops once stable for 600 frames AND the first pin cycle has consumed it', () => {
        expect(shouldSampleDeviceFinest(1200, 2, 600, true)).toBe(false);
        expect(shouldSampleDeviceFinest(1200, 2, 600, false)).toBe(true);  // pin not consumed -> keep sampling (1200 % 30 === 0)
        expect(shouldSampleDeviceFinest(1200, 2, 599, true)).toBe(true);   // not yet stable long enough
    });

    it('keeps sampling while deviceFinest is still unknown (null)', () => {
        expect(shouldSampleDeviceFinest(1200, null, 600, true)).toBe(true); // 1200 % 30 === 0
        expect(shouldSampleDeviceFinest(1201, null, 601, true)).toBe(false);
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/portal-preload.test.ts`
Expected: FAIL — `shouldSampleDeviceFinest` is not exported (`SyntaxError` / `undefined is not a function`).

- [ ] **Step 3: Implement the helper**

Append to `src/portal-preload.ts` (before the export line), and add `shouldSampleDeviceFinest` to the module's `export { ... }` list:

```ts
// Sampling cadence for the runtime's deviceFinest observation (the running-min
// finest LOD level the engine has made resident for the start scene). Scanning
// the octree is O(files) per call, so unconditional per-frame sampling is a
// steady battery/CPU drain on mobile. Cadence: sample every frame for an
// initial 600-frame settle window (~10s at 60fps, matching the runtime's other
// settle caps) while the start scene streams its near detail in; then back off
// to every 30th frame (~0.5s -- a late ratchet is still caught quickly at 1/30
// the cost); stop permanently once finest reaches 0 (the engine's finest level:
// a running-min cannot improve) or once it has been stable for 600 consecutive
// frames AND the first pin cycle has consumed it (pinConsumed). Pure and
// self-contained (no imports, no sibling-function calls) so it can be
// stringified verbatim into the exported viewer runtime via Function.toString().
const shouldSampleDeviceFinest = (frame: number, finest: number | null, stableFrames: number, pinConsumed: boolean): boolean => {
    if (finest !== null && finest <= 0) {
        return false;                    // already at the finest possible level: nothing left to ratchet
    }
    if (pinConsumed && finest !== null && stableFrames >= 600) {
        return false;                    // settled (~10s unchanged) and the first pin cycle used it
    }
    if (frame < 600) {
        return true;                     // initial settle window: sample every frame
    }
    return frame % 30 === 0;             // steady state: back off
};
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/portal-preload.test.ts`
Expected: PASS (all existing + 5 new tests).

- [ ] **Step 5: Wire the helper into the IIFE and gate the scan**

In `src/viewer-companion/portals.ts`:

(a) Extend the import (at `916666a` line 3):

```ts
import { collectLodFileUrls, lodMinLevelForBudget, collectSogBlockFileUrls, buildPortalAdjacency, desiredResidentScenes, shouldSampleDeviceFinest } from '../portal-preload';
```

(b) In the `companionRuntime` template, after the existing `var desiredResidentScenes = ${desiredResidentScenes.toString()};` line (`:70`), add:

```js
  var shouldSampleDeviceFinest = ${shouldSampleDeviceFinest.toString()};
```

(c) Immediately after the `updateDeviceFinest` function definition in the template (at `916666a` it ends at `:602`), add the sampler wrapper (IIFE-closure state is allowed here — this is the template, not a stringified helper):

```js
  // Gate the O(files) octree scan behind the pure cadence helper: full rate
  // during the settle window, then throttled, then stopped once settled/consumed
  // (see shouldSampleDeviceFinest). pinWhenBudgetReady's bounded pre-pinReady
  // poll still calls updateDeviceFinest directly (it self-terminates and needs
  // per-frame freshness for its own stability check).
  var dfFrame = 0;    // frames since the runtime started ticking (sampling clock)
  var dfStable = 0;   // frames since deviceFinest last ratcheted
  function sampleDeviceFinest() {
    if (!shouldSampleDeviceFinest(dfFrame++, deviceFinest, dfStable, pinReady)) { dfStable++; return; }
    var before = deviceFinest;
    updateDeviceFinest();
    dfStable = (deviceFinest === before) ? dfStable + 1 : 0;
  }
```

(d) In `tick()` (at `916666a` `:427`), replace the unconditional call:

```js
      updateDeviceFinest();
```
with:
```js
      sampleDeviceFinest();
```

Leave `pinWhenBudgetReady`'s internal `updateDeviceFinest()` call (`:689`) untouched.

- [ ] **Step 6: Reuse persistent position buffers in `tick`**

Still in the `companionRuntime` template. At `916666a` the pose block is:

```js
  var lastSafe = null;                       // (line 92)
  ...
      var cur = [cam.position.x, cam.position.y, cam.position.z];   // (line 432, inside tick's `if (cam && cam.position)`)
      ...
          var next = resolveActiveSplat(lastSafe, cur, rects, activeIndex, segmentCrossesRect);   // (line 447)
      ...
        lastSafe = cur;                      // (line 452)
```

(1) Replace the `var lastSafe = null;` declaration (`:92`) with:

```js
  var lastSafe = null;                      // null until primed / cleared on reset; otherwise === lastSafeBuf
  var lastSafeBuf = [0, 0, 0];              // persistent storage behind lastSafe (no per-frame allocation)
  var curPos = [0, 0, 0];                   // per-frame scratch for the camera position
```

(2) In `tick()`, replace the fresh-array line (`:432`) with in-place fills, rename the local uses of `cur` to `curPos`, and replace the trailing `lastSafe = cur;` with a copy:

```js
      if (cam && cam.position) {
        curPos[0] = cam.position.x; curPos[1] = cam.position.y; curPos[2] = cam.position.z;
        var st = getState();
        // ... (existing anim/free-nav comment block unchanged) ...
        if (st && st.cameraMode === 'anim' && timeline) {
          switchTo(sceneAtTime(st.animationTime || 0));
        } else if (lastSafe) {
          // A crossing whose target scene has not finished loading (entities[next]
          // missing) is skipped; eager preload at startup makes this rare.
          var next = resolveActiveSplat(lastSafe, curPos, rects, activeIndex, segmentCrossesRect);
          if (next !== activeIndex && next !== null && entities[next]) {
            switchTo(next);
          }
        }
        // Copy (never alias curPos) so next frame's fill can't corrupt lastSafe.
        lastSafeBuf[0] = curPos[0]; lastSafeBuf[1] = curPos[1]; lastSafeBuf[2] = curPos[2];
        lastSafe = lastSafeBuf;
      }
```

**Drift note (plan 5):** if the crossing logic inside this block has changed, keep that logic verbatim and apply only the mechanical substitution: fresh `var cur = [...]` → fill `curPos`; `lastSafe = cur` → copy into `lastSafeBuf` + `lastSafe = lastSafeBuf`. All existing `lastSafe = null` resets (e.g. the `inputEvent` `'reset'` listener, `916666a:377`) stay exactly as they are — `null` still means "unprimed", and the next tick re-primes via the copy.

- [ ] **Step 7: Extend the injection test**

In `test/portals-injection.test.ts`, inside the test `'includes the two-level coarse-LOD cache-warming routine in the runtime'`, after the existing `expect(out).toContain('updateDeviceFinest');` line, add:

```ts
        // the octree scan is throttled+stopped by the pure cadence helper
        expect(out).toContain('shouldSampleDeviceFinest');
        expect(out).toContain('sampleDeviceFinest');
```

- [ ] **Step 8: Run tests, lint, typecheck**

```bash
npx vitest run test/portals-injection.test.ts test/portal-preload.test.ts
npm run test
npm run lint
./node_modules/.bin/tsc --noEmit
```
Expected: all pass, lint clean, tsc exit 0.

- [ ] **Step 9: Stringification audit + commit**

Audit: `shouldSampleDeviceFinest` must reference **nothing** outside its own parameters/locals (constants 600/30 are baked into its body — correct). `sampleDeviceFinest`, `dfFrame`, `dfStable`, `curPos`, `lastSafeBuf` live inside the IIFE template (allowed). Confirm no stringified helper references `dfFrame`/`pinReady`/etc.

```bash
git add src/portal-preload.ts src/viewer-companion/portals.ts test/portal-preload.test.ts test/portals-injection.test.ts
git commit -m "perf(portals): throttle and stop the per-frame deviceFinest octree scan; reuse tick position buffers"
```

---

### Task 3: `awaitResident` remaining-set (poll only non-resident pinned files)

**Files:**
- Modify: `src/viewer-companion/portals.ts` — the tail of `pinSceneToLevel` (at `916666a`: lines 640-652)

**Interfaces:**
- Consumes: nothing from other tasks (independent of Task 2's edits — different regions of the same file).
- Produces: no API change. Runtime invariants preserved: `readyScenes[idx] = true` exactly when every currently-pinned file of scene `idx` is resident; `pinGen` invalidation and the 600-frame cap unchanged.

This is template-string code — **not unit-testable** (see Context). Verification = lint + typecheck + the existing injection containment assertions (`pinSceneToLevel`, `incRefCount` still present) + the Task 5 release E2E (loading overlay still reveals, crossings still instant).

- [ ] **Step 1: Replace the residency poll**

At `916666a` the tail of `pinSceneToLevel` reads:

```js
    if (added.length === 0 && pinnedFiles[idx].length === 0) { return; }
    var gen = pinGen[idx] || 0;   // a reclaim bumps pinGen[idx]; this loop then bails instead of marking a now-unpinned scene ready
    var frames = 0;
    (function awaitResident() {
      if ((pinGen[idx] || 0) !== gen) { return; }   // scene was reclaimed mid-pin -> do NOT vacuously mark the emptied pin set ready
      var allResident = true;
      for (var j = 0; j < pinnedFiles[idx].length; j++) {
        octree.ensureFileResource(pinnedFiles[idx][j]);
        if (!octree.getFileResource(pinnedFiles[idx][j])) { allResident = false; }
      }
      if (allResident) { readyScenes[idx] = true; return; }
      if (frames++ < 600) { requestAnimationFrame(awaitResident); }
    })();
```

Replace it with:

```js
    if (added.length === 0 && pinnedFiles[idx].length === 0) { return; }
    var gen = pinGen[idx] || 0;   // a reclaim bumps pinGen[idx]; this loop then bails instead of marking a now-unpinned scene ready
    var frames = 0;
    // Poll ONLY the files that are not yet resident. ensureFileResource returns
    // nothing: its side effects are (a) kicking off the engine-side load when
    // the loader doesn't have the resource yet (the loader dedupes re-requests)
    // and (b) migrating an arrived resource into octree.fileResources -- which
    // is what getFileResource reads. So re-polling a NOT-yet-resident file is
    // load-bearing (a disabled scene has no render instance to do it), but a
    // resident file never needs another call: our incRefCount pin keeps it
    // resident (the octree only unloads refcount-0 files). Swap-remove entries
    // as they arrive so the per-frame work shrinks to zero as loading completes.
    var remaining = [];
    for (var r = 0; r < pinnedFiles[idx].length; r++) {
      if (!octree.getFileResource(pinnedFiles[idx][r])) { remaining.push(pinnedFiles[idx][r]); }
    }
    (function awaitResident() {
      if ((pinGen[idx] || 0) !== gen) { return; }   // scene was reclaimed mid-pin -> do NOT vacuously mark the emptied pin set ready
      var j = 0;
      while (j < remaining.length) {
        octree.ensureFileResource(remaining[j]);
        if (octree.getFileResource(remaining[j])) {
          remaining[j] = remaining[remaining.length - 1];   // swap-remove; order is irrelevant
          remaining.pop();
        } else {
          j++;
        }
      }
      if (remaining.length === 0) { readyScenes[idx] = true; return; }
      if (frames++ < 600) { requestAnimationFrame(awaitResident); }
    })();
```

Why this is safe (verified engine contract — full citations in Context, defect 3):
- `getFileResource` returns the resource or `undefined` (`gsplat-octree.js:96-98`), so membership in `remaining` is exact.
- Once a pinned file is resident it stays resident: unload paths require refcount 0 (`gsplat-octree.js:104-114`, `:126-142`), and our refs are only released by `unpinScene`, which bumps `pinGen[idx]` and thereby terminates this very loop. Removing a resident file from `remaining` can therefore never miss a de-residency.
- Only one `awaitResident` loop per scene can be live at a time: `pinDesired` calls `pinSceneToLevel` only when `pinnedScenes[idx]` is false, and the false-transition (in `unpinScene`'s caller) is always paired with the `pinGen` bump that kills the old loop.

**Drift note (plan 3):** if the pinning code has changed shape, apply the behavior — "seed `remaining` with the pinned-but-not-resident file indices before the loop; each frame `ensureFileResource` + `getFileResource` only those; swap-remove on residency; complete/cap/generation checks unchanged" — to the current loop.

- [ ] **Step 2: Verify**

```bash
npm run test
npm run lint
./node_modules/.bin/tsc --noEmit
```
Expected: all pass (the injection test still finds `pinSceneToLevel` / `incRefCount` in the emitted runtime), lint clean, tsc exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/viewer-companion/portals.ts
git commit -m "perf(portals): poll only non-resident pinned files in awaitResident"
```

---

### Task 4: Editor walkthrough preview — cached rects + scratch reuse

**Files:**
- Modify: `src/portals-runtime.ts` (buildRects caching, `portals.changed` listener, prerender scratch reuse; at `916666a`: lines 29-40, 42-51, 84-106)
- Create: `test/portals-runtime.test.ts`

**Interfaces:**
- Consumes: `resolveActiveSplat` from Task 1 (signature unchanged, so no coupling).
- Produces: no API change; `registerPortalsRuntime(events, scene)` behavior identical except `portals.list` is no longer invoked per frame.

This IS unit-testable (verified: the module's import chain loads under Vitest's Node env). Fail-first TDD: the caching test fails against the current code.

- [ ] **Step 1: Write the tests (one red, two green characterization)**

Create `test/portals-runtime.test.ts`:

```ts
import { Mat4 } from 'playcanvas';
import { describe, it, expect } from 'vitest';

import { registerPortalsRuntime } from '../src/portals-runtime';

// Minimal Events double (pattern: test/portals.test.ts): function/invoke
// registry + on/fire listeners, plus an invoke counter so tests can assert how
// often 'portals.list' is queried.
const makeEvents = () => {
    const fns = new Map<string, (...args: any[]) => any>();
    const listeners = new Map<string, ((...args: any[]) => void)[]>();
    const invokeCounts = new Map<string, number>();
    return {
        function(name: string, fn: (...args: any[]) => any) { fns.set(name, fn); },
        invoke(name: string, ...args: any[]) {
            invokeCounts.set(name, (invokeCounts.get(name) ?? 0) + 1);
            return fns.get(name)?.(...args);
        },
        on(name: string, fn: (...args: any[]) => void) {
            const arr = listeners.get(name) ?? [];
            arr.push(fn);
            listeners.set(name, arr);
        },
        fire(name: string, ...args: any[]) { (listeners.get(name) ?? []).forEach(fn => fn(...args)); },
        invokeCounts
    } as any;
};

// registerPortalsRuntime only calls scene.getElementsByType and reads
// splat.uid / writes splat.visible, so a plain object double suffices.
const makeScene = (splats: { uid: number, visible: boolean }[]) => ({
    getElementsByType: () => splats
}) as any;

const camAt = (x: number, y: number, z: number) => new Mat4().setTranslate(x, y, z);

const portalData = () => [{
    id: 'portal_0',
    position: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0, 1] as [number, number, number, number],
    width: 4,
    height: 4,
    frontUid: 1,
    backUid: 2
}];

describe('portals-runtime walkthrough preview', () => {
    it('swaps the visible splat when the camera crosses a portal', () => {
        const events = makeEvents();
        const splats = [{ uid: 1, visible: true }, { uid: 2, visible: true }];
        registerPortalsRuntime(events, makeScene(splats));
        events.function('portals.list', () => portalData());
        events.function('portals.startSplat', () => 2);
        events.fire('portals.walkthrough', true);
        expect(splats[0].visible).toBe(false);
        expect(splats[1].visible).toBe(true);
        events.fire('prerender', camAt(0, 0, -1));   // primes prev
        events.fire('prerender', camAt(0, 0, 1));    // crosses to the front side -> uid 1
        expect(splats[0].visible).toBe(true);
        expect(splats[1].visible).toBe(false);
    });

    it('does not invoke portals.list per prerender frame (cached rects)', () => {
        const events = makeEvents();
        const splats = [{ uid: 1, visible: true }, { uid: 2, visible: true }];
        registerPortalsRuntime(events, makeScene(splats));
        events.function('portals.list', () => portalData());
        events.function('portals.startSplat', () => 2);
        events.fire('portals.walkthrough', true);
        const after = events.invokeCounts.get('portals.list') ?? 0;
        for (let i = 0; i < 10; i++) {
            events.fire('prerender', camAt(0, 0, -1 + i * 0.01));
        }
        expect(events.invokeCounts.get('portals.list') ?? 0).toBe(after);
    });

    it('rebuilds the cached rects on portals.changed', () => {
        const events = makeEvents();
        const splats = [{ uid: 1, visible: true }, { uid: 2, visible: true }];
        registerPortalsRuntime(events, makeScene(splats));
        let data = portalData();
        events.function('portals.list', () => data);
        events.function('portals.startSplat', () => 2);
        events.fire('portals.walkthrough', true);
        // move the portal out of the camera's path, then notify
        data = [{ ...portalData()[0], position: [100, 0, 0] as [number, number, number] }];
        events.fire('portals.changed');
        events.fire('prerender', camAt(0, 0, -1));
        events.fire('prerender', camAt(0, 0, 1));    // no longer crosses anything
        expect(splats[1].visible).toBe(true);        // still the start splat
        expect(splats[0].visible).toBe(false);
    });
});
```

- [ ] **Step 2: Run to verify the expected red/green split**

Run: `npx vitest run test/portals-runtime.test.ts`
Expected: 2 pass, 1 FAIL — `does not invoke portals.list per prerender frame` with `AssertionError: expected 9 to be +0` (9, not 10: the first prerender only primes `prev` and never reaches `buildRects`). If the crossing test fails instead, STOP — behavior drifted; reconcile with Task 0 findings.

- [ ] **Step 3: Implement caching + scratch reuse**

In `src/portals-runtime.ts` apply these changes (line refs at `916666a`):

(a) Replace `buildRects` (`:29-40`) with a cache-filling version and a cache variable:

```ts
    // Cached portal rects for the per-frame crossing test. Rebuilt on
    // walkthrough activation and on portals.changed (fired by every portal
    // mutation - see fireChanged() call sites in portals.ts) instead of
    // re-invoking portals.list + re-mapping every prerender frame.
    let rects: PortalRect[] = [];

    const buildRects = () => {
        const data = events.invoke('portals.list') as PortalData[];
        rects = data.map(p => ({
            position: p.position,
            rotation: p.rotation,
            width: p.width,
            height: p.height,
            frontUid: p.frontUid,
            backUid: p.backUid,
            infinite: p.infinite
        }));
    };
```

(b) In `enable()` (`:42-51`), add a `buildRects();` call after `applyVisibility();`:

```ts
    const enable = () => {
        active = true;
        havePrev = false;
        snapshot.clear();
        const list = splats();
        list.forEach(s => snapshot.set(s.uid, s.visible));
        const start = events.invoke('portals.startSplat') as number | null;
        activeUid = (start !== null && list.some(s => s.uid === start)) ? start : (list[0]?.uid ?? null);
        applyVisibility();
        buildRects();
    };
```

(c) Replace the `prerender` handler (`:82-103`) with the scratch-reusing version:

```ts
    // Per-frame: scene.ts fires 'prerender' with this.camera.worldTransform (a Mat4).
    // Mat4.getTranslation(target) writes the camera's world position into the
    // scratch Vec3 (no per-frame allocation); the two tuples are likewise reused.
    const curVec = new Vec3();
    const prevTuple: [number, number, number] = [0, 0, 0];
    const curTuple: [number, number, number] = [0, 0, 0];
    events.on('prerender', (cameraWorldTransform: Mat4) => {
        if (!active) {
            return;
        }
        const cur = cameraWorldTransform.getTranslation(curVec);
        if (havePrev) {
            prevTuple[0] = prev.x; prevTuple[1] = prev.y; prevTuple[2] = prev.z;
            curTuple[0] = cur.x; curTuple[1] = cur.y; curTuple[2] = cur.z;
            const newUid = resolveActiveSplat(prevTuple, curTuple, rects, activeUid);
            if (newUid !== activeUid) {
                activeUid = newUid;
                applyVisibility();
            }
        }
        prev.copy(cur);
        havePrev = true;
    });
```

(d) Replace the trailing comment (`:105-106` — `// If walkthrough is on and all portals get deleted ... Nothing to do on portals.changed here.`) with the rebuild listener:

```ts
    // Keep the cached rects in sync with portal mutations while walkthrough is
    // on (add/remove/update/setStart/entrypoint/clear/deserialize all fire
    // portals.changed). When walkthrough is off the cache is stale by design;
    // enable() rebuilds it on activation. If all portals get deleted the empty
    // cache simply never crosses; exiting is the panel toggle's job.
    events.on('portals.changed', () => {
        if (active) {
            buildRects();
        }
    });
```

- [ ] **Step 4: Run to verify all green**

Run: `npx vitest run test/portals-runtime.test.ts`
Expected: 3 passed.
Run: `npm run test`
Expected: all files pass.

- [ ] **Step 5: Lint + typecheck + commit**

```bash
npm run lint
./node_modules/.bin/tsc --noEmit
git add src/portals-runtime.ts test/portals-runtime.test.ts
git commit -m "perf(portals): cache walkthrough rects and reuse prerender scratch objects"
```
Expected: lint clean (imports `Mat4, Vec3` were already present — don't reorder imports), tsc exit 0.

---

### Task 5: Manual E2E verification (RELEASE build)

**Files:** none modified (observation only; if anything fails, return to the owning task — do not patch ad hoc).

Because the viewer companion is stringified and minified, this MUST be tested against a real RELEASE build (minification bugs only appear there). Note: the IIFE's internal function names (`sampleDeviceFinest`, `updateDeviceFinest`, `awaitResident`, `tick`) survive into the exported HTML as string content, so they remain searchable in the DevTools profiler.

- [ ] **Step 1: Build and serve the release editor**

```bash
npm run build
npm run serve
```
Open http://localhost:3333 (hard-reload, Ctrl+Shift+R — the service worker caches aggressively).

- [ ] **Step 2: Produce a streaming multi-scene export**

In the editor: import 2+ splat scenes, create at least one portal between them (portal tool), set the start scene, then export the HTML viewer with **Streaming** enabled and **Collision** enabled (same export flow as previous portal E2Es). Serve the exported output (e.g. `npx serve <export-dir> -l 3400`) and open it in Chrome.

- [ ] **Step 3: Profiler check A — the octree scan stops (defect 1)**

DevTools → Performance panel → check **Memory** → Record ~20 s: first ~12 s idle (no input), then ~8 s of orbiting WITHOUT crossing a portal. Stop. Verify:
- In **Bottom-Up**, filter for `updateDeviceFinest`: its self+total time must be confined to the first ~10 s (settle window + the bounded `pinWhenBudgetReady` poll). After the settle point there must be **no recurring per-frame** `updateDeviceFinest` entries — at most isolated samples ≥ 0.5 s apart (the backoff), which themselves cease once stable+consumed. Before this fix it appeared in essentially every frame's scripting for the whole recording.

- [ ] **Step 4: Profiler check B — GC pressure visibly reduced (defect 2)**

In the same recording, read the **JS Heap** graph (Memory checkbox): during the idle/orbit steady state the sawtooth (steady climb, sharp drop at each **Minor GC**) must be visibly flatter/longer-period than a pre-fix recording — record once on `main` before starting if you want a hard baseline. Cross-check: in Bottom-Up, search "GC" (Minor GC events); their count over the steady-state window should drop noticeably. (Other allocators — the engine's own frame loop — still allocate; you are looking for a clear reduction, not zero.)

- [ ] **Step 5: Behavior check — crossings still work (defects 1-3 regression)**

- Free navigation: walk through each portal in both directions → the scene swaps exactly at the doorway plane, collision follows (you cannot walk through the new scene's walls). Walk into a not-yet-visited streaming scene → the loading overlay appears and reveals (this exercises the Task 3 `readyScenes` path).
- Cross back and forth quickly several times → still instant for frontier scenes (Task 3 kept pinning intact).
- If an animation track exists in the export: play + scrub the timeline → the active scene follows the baked timeline.
- Press R (reset) after wandering into another scene → the viewer returns to the start scene (the `lastSafe = null` reset still composes with the persistent buffers from Task 2).

- [ ] **Step 6: Editor check — walkthrough preview (defect 4)**

Back in the editor (http://localhost:3333) with 2+ scenes and a portal: enable walkthrough mode, fly through the portal → the visible splat swaps. Move/resize the portal while walkthrough is on → crossing behavior follows the new rectangle (cache rebuilt via `portals.changed`). Optional profiler confirmation: record a few seconds of walkthrough orbiting and confirm no per-frame `invoke('portals.list')` scripting (unit test already guarantees this).

- [ ] **Step 7: Record the verification**

Note pass/fail per check in the task notes. Any failure → reopen the owning task (systematic-debugging), fix, rebuild, re-run this task from Step 1.

---

### Task 6: Final verification + branch finish

- [ ] **Step 1: Full gate**

```bash
npm run lint
./node_modules/.bin/tsc --noEmit
npm run test
npm run build
```
Expected: lint clean; tsc exit 0; all test files pass (now including `test/portals-runtime.test.ts`); build completes.

- [ ] **Step 2: Squash and finish per project convention**

Use `superpowers:finishing-a-development-branch`: squash all commits on `perf/portal-viewer-frame-cost` into a single commit summarizing all four fixes (allocation-free portal-geom, deviceFinest throttle/stop + tick buffers, awaitResident remaining-set, editor walkthrough caching — include this plan document), then merge per the user's convention (do not push unless asked).

Suggested squashed message subject: `perf(portals): eliminate steady-state per-frame cost in viewer runtime and editor walkthrough`
