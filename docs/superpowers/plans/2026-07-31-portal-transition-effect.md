# Portal Transition Effect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-portal (default-on) tile transition to the exported viewer: the outgoing scene is covered by translucent tiles flying in edges-first, the scene swaps hidden, then the cover breaks up centre-first to reveal the incoming scene — after the streaming loading overlay when the destination is not yet resident.

**Architecture:** A DOM tile layer overlaid on the viewer canvas, driven by a pure phase machine. All decision logic lives in a new pure module (`src/portal-transition.ts`) that is unit-tested and stringified into the exported viewer; the existing `crossingReducer` is not modified and still owns every scene switch. The per-portal flag travels editor → document → export bundle → `window.__supersplatPortals.portals[i].transition`.

**Tech Stack:** TypeScript (bundler resolution, `strictNullChecks: false`), Vitest, PCUI (editor toolbar), i18next (9 locales), Rollup.

**Spec:** `docs/superpowers/specs/2026-07-31-portal-transition-effect-design.md` — read it before starting.

## Global Constraints

- **Absent means enabled.** `transition === undefined` is an enabled portal everywhere (editor, document, bundle, runtime). Only an explicit `false` disables. Never write a default of `true` into the data.
- **Stringified-helper rules.** Anything injected into the exported viewer via `Function.toString()` must be self-contained: no imports, no references to sibling functions or module constants, all literals inline. The exported-viewer companion body (`companionRuntime` in `src/viewer-companion/portals.ts`) is authored inside a **template literal**: it must contain **no backslash escapes** (they are eaten at build time) and **no `${`** sequences (they would interpolate).
- **Fixed effect constants** (from the spec, do not invent others): sweep `225` ms, per-tile motion `150` ms, covered hold `100` ms, tile colour opaque `#0a0c10` inside an `opacity: .7` group
  (same 70% result, but overlaps do not stack alpha), fly distance `140` px, `scale(.25)`, spin `±(16–66)°`, grid ~14 × 9 at desktop aspect.
- **Scope.** Free-navigation portal crossings only. Reset, `annotation.activate` and animation-timeline dispatches keep today's instant switch. Editor preview (`src/portals-runtime.ts`) is untouched.
- **Commands.** Use Bash (Git Bash). Run commands plainly — no `cd` / `git -C` / `npm --prefix` pointing at the cwd. Run test gates in the **foreground** and redirect output to a file (`npm run test > /tmp/out.txt 2>&1`); never background-chain them and never pipe to `grep` (vitest hangs).
- **Lint.** `npm run lint` must pass. Do **not** reorder imports (ESLint 10 crashes on `import/order` autofix) — append new names to existing import statements in place.
- **Branch.** All work happens on `feature/portal-transition-effect`. Commit after every task.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/portal-transition.ts` | **New.** Pure tile geometry + phase machine. Stringified into the viewer, unit-tested. |
| `test/portal-transition.test.ts` | **New.** Tests for the above. |
| `src/portal-geom.ts` | Add `resolvePortalCrossing` (returns which portal was crossed). `resolveActiveSplat` untouched. |
| `test/portal-geom.test.ts` | Tests for `resolvePortalCrossing`. |
| `src/portals.ts` | `PortalData.transition`, `portals.export`, doc serialize/deserialize. |
| `test/portals.test.ts` | Round-trip tests for the flag. |
| `src/tools/portal-tool.ts` | Toolbar toggle button. |
| `static/locales/*.json` (9) | Two new keys. |
| `src/portal-export.ts` | `ExportPortal.transition` + carried into `buildPortalBundle`'s rewritten records. |
| `test/portal-export.test.ts` | Bundle passthrough test. |
| `src/viewer-companion/portals.ts` | Runtime: CSS, tile layer, wiring into `tick` / `dispatch`. |
| `test/portals-injection.test.ts` | Asserts the transition helpers + CSS ship in the injection. |

---

### Task 1: Pure transition module

**Files:**
- Create: `src/portal-transition.ts`
- Test: `test/portal-transition.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `tileGrid(width: number, height: number): { cols: number, rows: number }`
  - `tileGeometry(cols: number, rows: number, index: number): { dist: number, ux: number, uy: number }`
  - `tileDelay(dist: number, sweep: number, phase: 'dismantle' | 'reconstruct'): number`
  - `transitionReducer(state: TransitionState, event: TransitionEvent): TransitionResult`
  - types `TransitionState = { phase: 'idle' | 'dismantling' | 'covered' | 'reconstructing', target: number | null }`, `TransitionEvent`, `TransitionActions = { cover: 'none' | 'dismantle' | 'reconstruct' | 'clear', dispatchTarget: number | null }`, `TransitionResult = { state: TransitionState, actions: TransitionActions }`

- [ ] **Step 1: Write the failing test**

Create `test/portal-transition.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import { tileGrid, tileGeometry, tileDelay, transitionReducer, TransitionState } from '../src/portal-transition';

describe('tileGrid', () => {
    it('produces roughly square tiles at a desktop aspect', () => {
        const g = tileGrid(1600, 1000);
        expect(g.cols).toBe(15);
        expect(g.rows).toBe(9);
    });

    it('clamps a very narrow viewport to the minimum columns', () => {
        const g = tileGrid(320, 640);
        expect(g.cols).toBe(6);
        expect(g.rows).toBe(12);
    });

    it('clamps a very wide viewport to the maximum columns and rows', () => {
        const g = tileGrid(6000, 400);
        expect(g.cols).toBe(20);
        expect(g.rows).toBe(4);
    });

    it('falls back to a valid grid for degenerate sizes', () => {
        const g = tileGrid(0, 0);
        expect(g.cols).toBeGreaterThanOrEqual(6);
        expect(g.rows).toBeGreaterThanOrEqual(4);
    });
});

describe('tileGeometry', () => {
    it('gives the centre tile a near-zero distance', () => {
        // 3x3 grid, index 4 is the exact centre
        const g = tileGeometry(3, 3, 4);
        expect(g.dist).toBeCloseTo(0, 6);
    });

    it('gives corner tiles the largest distance, capped at 1', () => {
        const g = tileGeometry(3, 3, 0);   // top-left
        expect(g.dist).toBeGreaterThan(0.9);
        expect(g.dist).toBeLessThanOrEqual(1);
    });

    it('points the unit vector outward from the centre', () => {
        const topLeft = tileGeometry(3, 3, 0);
        expect(topLeft.ux).toBeLessThan(0);
        expect(topLeft.uy).toBeLessThan(0);
        const bottomRight = tileGeometry(3, 3, 8);
        expect(bottomRight.ux).toBeGreaterThan(0);
        expect(bottomRight.uy).toBeGreaterThan(0);
    });

    it('returns a unit-length outward vector', () => {
        const g = tileGeometry(4, 4, 0);
        expect(Math.sqrt(g.ux * g.ux + g.uy * g.uy)).toBeCloseTo(1, 6);
    });
});

describe('tileDelay', () => {
    it('dismantles edges first: the centre waits the full sweep', () => {
        expect(tileDelay(0, 225, 'dismantle')).toBe(225);
        expect(tileDelay(1, 225, 'dismantle')).toBe(0);
    });

    it('reconstructs centre first: the corners wait the full sweep', () => {
        expect(tileDelay(0, 225, 'reconstruct')).toBe(0);
        expect(tileDelay(1, 225, 'reconstruct')).toBe(225);
    });

    it('is monotonic between the extremes', () => {
        expect(tileDelay(0.5, 225, 'dismantle')).toBeCloseTo(112.5, 6);
        expect(tileDelay(0.5, 225, 'reconstruct')).toBeCloseTo(112.5, 6);
    });
});

const idle: TransitionState = { phase: 'idle', target: null };

describe('transitionReducer', () => {
    it('starts a dismantle from idle', () => {
        const r = transitionReducer(idle, { type: 'crossing', target: 2 });
        expect(r.state).toEqual({ phase: 'dismantling', target: 2 });
        expect(r.actions).toEqual({ cover: 'dismantle', dispatchTarget: null });
    });

    it('ignores a crossing while a transition is already running', () => {
        const busy: TransitionState = { phase: 'dismantling', target: 2 };
        const r = transitionReducer(busy, { type: 'crossing', target: 3 });
        expect(r.state).toEqual(busy);
        expect(r.actions).toEqual({ cover: 'none', dispatchTarget: null });
    });

    it('commits the switch when the cover completes on a live target', () => {
        const r = transitionReducer({ phase: 'dismantling', target: 2 }, { type: 'covered', target: 2 });
        expect(r.state).toEqual({ phase: 'covered', target: 2 });
        expect(r.actions).toEqual({ cover: 'none', dispatchTarget: 2 });
    });

    it('cancels straight into a reconstruct when the user walked back', () => {
        const r = transitionReducer({ phase: 'dismantling', target: 2 }, { type: 'covered', target: null });
        expect(r.state).toEqual({ phase: 'reconstructing', target: null });
        expect(r.actions).toEqual({ cover: 'reconstruct', dispatchTarget: null });
    });

    it('reconstructs once the destination scene is on screen', () => {
        const r = transitionReducer({ phase: 'covered', target: 2 }, { type: 'sceneShown' });
        expect(r.state).toEqual({ phase: 'reconstructing', target: 2 });
        expect(r.actions).toEqual({ cover: 'reconstruct', dispatchTarget: null });
    });

    it('ignores sceneShown outside the covered phase', () => {
        const r = transitionReducer({ phase: 'reconstructing', target: 2 }, { type: 'sceneShown' });
        expect(r.state).toEqual({ phase: 'reconstructing', target: 2 });
        expect(r.actions).toEqual({ cover: 'none', dispatchTarget: null });
    });

    it('returns to idle when the reconstruct finishes', () => {
        const r = transitionReducer({ phase: 'reconstructing', target: 2 }, { type: 'done' });
        expect(r.state).toEqual({ phase: 'idle', target: null });
        expect(r.actions).toEqual({ cover: 'none', dispatchTarget: null });
    });

    it('ignores done outside the reconstructing phase', () => {
        const r = transitionReducer({ phase: 'covered', target: 2 }, { type: 'done' });
        expect(r.state).toEqual({ phase: 'covered', target: 2 });
    });

    it('aborts to idle and clears the cover from any phase', () => {
        (['dismantling', 'covered', 'reconstructing'] as const).forEach((phase) => {
            const r = transitionReducer({ phase, target: 2 }, { type: 'abort' });
            expect(r.state).toEqual({ phase: 'idle', target: null });
            expect(r.actions).toEqual({ cover: 'clear', dispatchTarget: null });
        });
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/portal-transition.test.ts > /tmp/pt.txt 2>&1; tail -20 /tmp/pt.txt`
Expected: FAIL — cannot resolve `../src/portal-transition`.

- [ ] **Step 3: Write the implementation**

Create `src/portal-transition.ts`:

```ts
// Pure geometry + lifecycle for the exported viewer's portal transition effect
// (a tile cover that dismantles the outgoing scene and reconstructs the
// incoming one).
//
// Every function here is stringified into the exported viewer
// (Function.toString()) and evaluated in a separate scope, so each one must be
// SELF-CONTAINED: no imports, no references to sibling functions or module
// constants, all literals inline. The runtime body that hosts them is authored
// inside a template literal, so this file must also contain no backslash
// escapes and no '${' sequences in code that is stringified.

type TilePhase = 'dismantle' | 'reconstruct';

type TransitionPhase = 'idle' | 'dismantling' | 'covered' | 'reconstructing';

type TransitionState = {
    phase: TransitionPhase,
    target: number | null   // scene index the crossing is heading for
};

type TransitionEvent =
    // A transition-enabled portal crossing was detected (only acts when idle).
    { type: 'crossing', target: number } |
    // The dismantle sweep finished. `target` is the crossing re-resolved at that
    // instant: null when the user walked back through the doorway (cancel).
    { type: 'covered', target: number | null } |
    // The destination scene is on screen behind the cover (switched and ready,
    // or the loading overlay just hid).
    { type: 'sceneShown' } |
    // The reconstruct sweep finished.
    { type: 'done' } |
    // Error/watchdog path: drop the cover immediately.
    { type: 'abort' };

type TransitionActions = {
    cover: 'none' | 'dismantle' | 'reconstruct' | 'clear',
    dispatchTarget: number | null   // hand this crossing to crossingReducer
};

type TransitionResult = { state: TransitionState, actions: TransitionActions };

// Tile grid for a viewport: roughly square tiles around a 110px target, clamped
// so a phone does not get one giant tile and an ultrawide does not get hundreds.
const tileGrid = (width: number, height: number): { cols: number, rows: number } => {
    const TARGET = 110;
    const w = (typeof width === 'number' && width > 0) ? width : TARGET;
    const h = (typeof height === 'number' && height > 0) ? height : TARGET;
    let cols = Math.round(w / TARGET);
    if (cols < 6) { cols = 6; }
    if (cols > 20) { cols = 20; }
    let rows = Math.round(cols * h / w);
    if (rows < 4) { rows = 4; }
    if (rows > 16) { rows = 16; }
    return { cols: cols, rows: rows };
};

// Normalised radial geometry of tile `index` in a cols x rows grid:
// dist 0 at the screen centre, 1 at a corner; (ux, uy) is the outward unit
// vector used for the fly-in / fly-out translation.
const tileGeometry = (cols: number, rows: number, index: number): { dist: number, ux: number, uy: number } => {
    const c = index % cols;
    const r = Math.floor(index / cols);
    const dx = (c + 0.5) / cols - 0.5;
    const dy = (r + 0.5) / rows - 0.5;
    const len = Math.sqrt(dx * dx + dy * dy) || 1e-6;
    const maxLen = Math.sqrt(0.5);
    let dist = len / maxLen;
    if (dist > 1) { dist = 1; }
    return { dist: dist, ux: dx / len, uy: dy / len };
};

// Stagger for one tile. Dismantle runs edges -> centre (the centre of the
// outgoing scene is covered last); reconstruct runs centre -> edges.
const tileDelay = (dist: number, sweep: number, phase: TilePhase): number => {
    return (phase === 'dismantle') ? (1 - dist) * sweep : dist * sweep;
};

// Transition lifecycle. The wiring applies the returned actions; it never makes
// a phase decision itself.
const transitionReducer = (state: TransitionState, event: TransitionEvent): TransitionResult => {
    const none: TransitionActions = { cover: 'none', dispatchTarget: null };
    if (event.type === 'crossing') {
        if (state.phase !== 'idle') {
            return { state: state, actions: none };
        }
        return {
            state: { phase: 'dismantling', target: event.target },
            actions: { cover: 'dismantle', dispatchTarget: null }
        };
    }
    if (event.type === 'covered') {
        if (state.phase !== 'dismantling') {
            return { state: state, actions: none };
        }
        if (event.target === null || event.target === undefined) {
            // walked back before the cover closed: no switch, just reopen
            return {
                state: { phase: 'reconstructing', target: null },
                actions: { cover: 'reconstruct', dispatchTarget: null }
            };
        }
        return {
            state: { phase: 'covered', target: event.target },
            actions: { cover: 'none', dispatchTarget: event.target }
        };
    }
    if (event.type === 'sceneShown') {
        if (state.phase !== 'covered') {
            return { state: state, actions: none };
        }
        return {
            state: { phase: 'reconstructing', target: state.target },
            actions: { cover: 'reconstruct', dispatchTarget: null }
        };
    }
    if (event.type === 'done') {
        if (state.phase !== 'reconstructing') {
            return { state: state, actions: none };
        }
        return { state: { phase: 'idle', target: null }, actions: none };
    }
    // 'abort'
    return {
        state: { phase: 'idle', target: null },
        actions: { cover: 'clear', dispatchTarget: null }
    };
};

export {
    tileGrid,
    tileGeometry,
    tileDelay,
    transitionReducer,
    TilePhase,
    TransitionPhase,
    TransitionState,
    TransitionEvent,
    TransitionActions,
    TransitionResult
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/portal-transition.test.ts > /tmp/pt.txt 2>&1; tail -20 /tmp/pt.txt`
Expected: PASS, 20 tests.

If `tileGrid(1600, 1000)` does not give exactly 15 × 9, do the arithmetic by hand (`round(1600/110) = 15`, `round(15 * 1000/1600) = 9`) and fix the **test** to the correct value rather than bending the implementation.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint > /tmp/lint.txt 2>&1; tail -5 /tmp/lint.txt
git add src/portal-transition.ts test/portal-transition.test.ts
git commit -m "feat(portals): pure tile geometry and phase machine for the transition effect"
```

---

### Task 2: Report which portal was crossed

**Files:**
- Modify: `src/portal-geom.ts` (append a new export; leave `resolveActiveSplat` and `segmentCrossesRect` untouched)
- Test: `test/portal-geom.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `segmentCrossesRect`, `PortalRect` from Task 0 (existing code).
- Produces: `resolvePortalCrossing(prev: Vec3, cur: Vec3, portals: PortalRect[], currentUid: number | null, cross?): { uid: number | null, portalIndex: number | null }` — `portalIndex` is the portal of the last *effective* crossing along the segment (the one that actually changed the scene), `null` when nothing changed.

- [ ] **Step 1: Write the failing test**

Append to `test/portal-geom.test.ts`:

```ts
import { resolvePortalCrossing } from '../src/portal-geom';

describe('resolvePortalCrossing', () => {
    it('returns the crossed portal index alongside the resulting scene', () => {
        const portals = [rect({ frontUid: 10, backUid: 20 })];
        const r = resolvePortalCrossing([0, 0, -1], [0, 0, 1], portals, 20);
        expect(r).toEqual({ uid: 10, portalIndex: 0 });
    });

    it('returns a null portal index when nothing was crossed', () => {
        const portals = [rect()];
        const r = resolvePortalCrossing([0, 0, -2], [0, 0, -1], portals, 20);
        expect(r).toEqual({ uid: 20, portalIndex: null });
    });

    it('reports the LAST effective crossing when a segment crosses two portals', () => {
        const portals = [
            rect({ position: [0, 0, 0], frontUid: 10, backUid: 20 }),
            rect({ position: [0, 0, 2], frontUid: 30, backUid: 10 })
        ];
        const r = resolvePortalCrossing([0, 0, -1], [0, 0, 3], portals, 20);
        expect(r).toEqual({ uid: 30, portalIndex: 1 });
    });

    it('skips a crossing into a side with no bound scene', () => {
        const portals = [
            rect({ position: [0, 0, 0], frontUid: 10, backUid: 20 }),
            rect({ position: [0, 0, 2], frontUid: null, backUid: 10 })
        ];
        const r = resolvePortalCrossing([0, 0, -1], [0, 0, 3], portals, 20);
        expect(r).toEqual({ uid: 10, portalIndex: 0 });
    });

    it('agrees with resolveActiveSplat on the resulting scene', () => {
        const portals = [rect({ frontUid: 10, backUid: 20 })];
        const a = resolveActiveSplat([0, 0, -1], [0, 0, 1], portals, 20);
        const b = resolvePortalCrossing([0, 0, -1], [0, 0, 1], portals, 20);
        expect(b.uid).toBe(a);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/portal-geom.test.ts > /tmp/pg.txt 2>&1; tail -20 /tmp/pg.txt`
Expected: FAIL — `resolvePortalCrossing is not a function` / not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/portal-geom.ts` (before the final `export` line, then add the name to that export list):

```ts
// Same resolution as resolveActiveSplat, but it also reports WHICH portal
// produced the resulting scene. The exported viewer needs that to read the
// portal's per-portal `transition` flag.
//
// Deliberately duplicates the loop-and-sort instead of delegating to
// resolveActiveSplat: both functions are stringified into the exported viewer
// (Function.toString()) and evaluated in SEPARATE scopes, where a call to a
// sibling top-level name would hit the terser-mangled identifier and throw.
// The geometry itself is not duplicated - it stays in the injected `cross`.
//
// Hot path (every rAF frame): the no-crossing case allocates nothing.
const resolvePortalCrossing = (
    prev: Vec3,
    cur: Vec3,
    portals: PortalRect[],
    currentUid: number | null,
    cross = segmentCrossesRect
): { uid: number | null, portalIndex: number | null } => {
    let crossings: { t: number, uid: number | null, index: number }[] = null;
    for (let i = 0; i < portals.length; i++) {
        const p = portals[i];
        const c = cross(prev, cur, p);
        if (c) {
            if (!crossings) {
                crossings = [];
            }
            crossings.push({ t: c.t, uid: c.side === 'front' ? p.frontUid : p.backUid, index: i });
        }
    }
    if (!crossings) {
        return { uid: currentUid, portalIndex: null };
    }
    crossings.sort((m, n) => m.t - n.t);
    let active = currentUid;
    let portalIndex: number | null = null;
    for (let i = 0; i < crossings.length; i++) {
        // a crossing into a side with no bound scene leaves the active scene (and
        // the reported portal) unchanged
        if (crossings[i].uid !== null) {
            active = crossings[i].uid;
            portalIndex = crossings[i].index;
        }
    }
    return { uid: active, portalIndex: portalIndex };
};
```

Then extend the existing export statement in place (do not reorder it):

```ts
export { segmentCrossesRect, resolveActiveSplat, resolvePortalCrossing, PortalRect, InfiniteEdges, Vec3, Quat };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/portal-geom.test.ts > /tmp/pg.txt 2>&1; tail -20 /tmp/pg.txt`
Expected: PASS — the new block plus all pre-existing `portal-geom` tests.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint > /tmp/lint.txt 2>&1; tail -5 /tmp/lint.txt
git add src/portal-geom.ts test/portal-geom.test.ts
git commit -m "feat(portals): resolvePortalCrossing reports the crossed portal index"
```

---

### Task 3: Editor data model and document round-trip

**Files:**
- Modify: `src/portals.ts` (type `PortalData`, `portals.export`, `docSerialize.portals`, `docDeserialize.portals`)
- Test: `test/portals.test.ts` (append a describe block)

**Interfaces:**
- Consumes: nothing.
- Produces: `PortalData.transition?: boolean` — absent means enabled. Present in the objects returned by `portals.export` and `docSerialize.portals`, and restored by `docDeserialize.portals`.

- [ ] **Step 1: Write the failing test**

Append to `test/portals.test.ts`:

```ts
describe('portal transition flag', () => {
    it('portals.export carries the transition flag through', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        events.fire('portals.insertRaw', portal({ id: 'portal_0', transition: false }));
        events.fire('portals.insertRaw', portal({ id: 'portal_1' }));
        const out = events.invoke('portals.export');
        expect(out[0].transition).toBe(false);
        expect(out[1].transition).toBeUndefined();
    });

    it('docSerialize keeps an explicit false and omits an absent flag', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        events.fire('portals.insertRaw', portal({ id: 'portal_0', transition: false }));
        events.fire('portals.insertRaw', portal({ id: 'portal_1' }));
        const serialized = events.invoke('docSerialize.portals');
        expect(serialized[0].transition).toBe(false);
        expect(JSON.parse(JSON.stringify(serialized[1])).transition).toBeUndefined();
    });

    it('docDeserialize restores an explicit false', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        events.invoke('docDeserialize.portals', [
            { id: 'portal_0', position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, frontUid: 1, backUid: 2, transition: false }
        ]);
        expect((events.invoke('portals.list') as PortalData[])[0].transition).toBe(false);
    });

    it('a legacy document without the field loads as enabled (absent)', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        events.invoke('docDeserialize.portals', [
            { id: 'portal_0', position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, frontUid: 1, backUid: 2 }
        ]);
        const p = (events.invoke('portals.list') as PortalData[])[0];
        expect(p.transition).toBeUndefined();
        expect(p.transition !== false).toBe(true);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/portals.test.ts > /tmp/po.txt 2>&1; tail -20 /tmp/po.txt`
Expected: FAIL — `transition` is not a known property of `PortalData` (type error) and is undefined in the export/serialize output.

- [ ] **Step 3: Write the implementation**

In `src/portals.ts`:

1. Add the field to `PortalData` (after `infinite`):

```ts
type PortalData = {
    id: string,
    position: [number, number, number],
    rotation: [number, number, number, number],
    width: number,
    height: number,
    frontUid: number | null,
    backUid: number | null,
    infinite?: InfiniteEdges,
    // Play the exported viewer's tile transition when this portal is crossed.
    // ABSENT MEANS ENABLED - only an explicit false disables it, so existing
    // documents need no migration.
    transition?: boolean
};
```

2. Add it to the `portals.export` mapping (after `infinite: p.infinite`):

```ts
        infinite: p.infinite,
        transition: p.transition
```

3. Add it to the `doc` object literal inside `docSerialize.portals` (after `infinite: p.infinite`):

```ts
            infinite: p.infinite,
            transition: p.transition
```

4. Add it to the object pushed in `docDeserialize.portals` (after `infinite: d.infinite`):

```ts
                    infinite: d.infinite,
                    transition: d.transition
```

5. Add `transition?: boolean` to the `PortalDocData` type — it extends `PortalData`, so nothing to do; verify no separate declaration is needed.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/portals.test.ts > /tmp/po.txt 2>&1; tail -20 /tmp/po.txt`
Expected: PASS — new block plus all pre-existing portal event tests.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint > /tmp/lint.txt 2>&1; tail -5 /tmp/lint.txt
git add src/portals.ts test/portals.test.ts
git commit -m "feat(portals): per-portal transition flag in the editor model and document"
```

---

### Task 4: Editor toolbar toggle

**Files:**
- Modify: `src/tools/portal-tool.ts` (button declaration ~line 54, bar append ~line 80, click handler, `refreshBar`)
- Modify: `static/locales/en.json`, `de.json`, `es.json`, `fr.json`, `ja.json`, `ko.json`, `pt-BR.json`, `ru.json`, `zh-CN.json`

**Interfaces:**
- Consumes: `PortalData.transition` (Task 3), `UpdatePortalOp` (existing import in this file).
- Produces: no code interface — a UI affordance. New i18n keys `portals.transition` and `portals.transition.tooltip`.

- [ ] **Step 1: Add the i18n keys**

In each of the 9 locale files, insert immediately after the `"portals.bounds.left"` line (keeping the file's existing key ordering and indentation):

```json
    "portals.transition": "Transition",
    "portals.transition.tooltip": "Play a transition effect when crossing this portal",
```

Per-locale values (key names identical, only the strings change):

| Locale | `portals.transition` | `portals.transition.tooltip` |
| --- | --- | --- |
| en | Transition | Play a transition effect when crossing this portal |
| de | Übergang | Beim Durchqueren dieses Portals einen Übergangseffekt abspielen |
| es | Transición | Reproducir un efecto de transición al cruzar este portal |
| fr | Transition | Jouer un effet de transition lors du passage par ce portail |
| ja | トランジション | このポータルを通過するときにトランジション効果を再生 |
| ko | 전환 효과 | 이 포털을 통과할 때 전환 효과 재생 |
| pt-BR | Transição | Reproduzir um efeito de transição ao atravessar este portal |
| ru | Переход | Воспроизводить эффект перехода при прохождении через этот портал |
| zh-CN | 过渡效果 | 穿过此传送门时播放过渡效果 |

Note for the reviewer: these are machine-assisted translations and follow the project's convention of flagging them for a later native review pass.

- [ ] **Step 2: Declare the button**

In `src/tools/portal-tool.ts`, immediately after the `boundsButton` declaration and its `title` assignment:

```ts
        const transitionButton = new Button({ text: '⧉', class: 'select-toolbar-button' });
        transitionButton.dom.title = i18n.t('portals.transition.tooltip');
```

- [ ] **Step 3: Append it to the toolbar**

Immediately after `bar.append(boundsButton);`:

```ts
        bar.append(transitionButton);
```

- [ ] **Step 4: Wire the click handler**

Add after the `EDGE_DIRS.forEach(...)` block that wires the bounds toggles:

```ts
        // Per-portal transition toggle. Absent means enabled, so the first click
        // on a fresh portal writes an explicit false; clicking again clears it
        // back to undefined (enabled) rather than writing true, keeping the
        // "absent means enabled" invariant in the document.
        transitionButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            const z = selected();
            if (!z) {
                return;
            }
            const next = (z.transition === false) ? undefined : false;
            events.fire('edit.add', new UpdatePortalOp(events, z.id, { transition: z.transition }, { transition: next }));
        });
```

- [ ] **Step 5: Reflect state in `refreshBar`**

Inside `refreshBar`, immediately before the existing `refreshBoundsPopup();` call:

```ts
            transitionButton.enabled = !!z;
            transitionButton.class[(z && z.transition !== false) ? 'add' : 'remove']('active');
```

- [ ] **Step 6: Verify by hand in the editor**

Run: `npm run develop` and open http://localhost:3333

Check, in order:
1. Load or create a project with two splats and a portal; select the portal.
2. The `⧉` button shows as active (the default-enabled state).
3. Click it → it goes inactive. Ctrl+Z → active again. Ctrl+Shift+Z → inactive again.
4. Deselect the portal → the button is disabled.
5. Save the project, reload it, reselect the portal → still inactive.
6. Switch locale with `?lng=fr` → the tooltip is the French string.

- [ ] **Step 7: Lint and commit**

```bash
npm run lint > /tmp/lint.txt 2>&1; tail -5 /tmp/lint.txt
git add src/tools/portal-tool.ts static/locales
git commit -m "feat(portals): per-portal transition toggle in the portal toolbar"
```

---

### Task 5: Carry the flag into the export bundle

**Files:**
- Modify: `src/portal-export.ts` (`ExportPortal` type, `PortalBundle` type, `rewritten` mapping in `buildPortalBundle`)
- Test: `test/portal-export.test.ts` (append to the existing `buildPortalBundle` describe block)

**Interfaces:**
- Consumes: `PortalData.transition` via `portals.export` (Task 3).
- Produces: `buildPortalBundle(...).portals[i].transition?: boolean` — reaches the exported viewer as `window.__supersplatPortals.portals[i].transition`.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe('buildPortalBundle', ...)` in `test/portal-export.test.ts` (match the file's existing helper for building portal inputs; if it defines a local `p(...)` or object literal style, follow it):

```ts
    it('carries an explicit transition:false into the rewritten portals', () => {
        const bundle = buildPortalBundle({
            portals: [{
                position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2,
                frontUid: 1, backUid: 2, transition: false
            }],
            startUid: 1,
            availableUids: [1, 2],
            streaming: false,
            collision: false
        });
        expect(bundle.portals[0].transition).toBe(false);
    });

    it('leaves the transition field absent when the portal never set it', () => {
        const bundle = buildPortalBundle({
            portals: [{
                position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2,
                frontUid: 1, backUid: 2
            }],
            startUid: 1,
            availableUids: [1, 2],
            streaming: false,
            collision: false
        });
        expect(bundle.portals[0].transition).toBeUndefined();
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/portal-export.test.ts > /tmp/pe.txt 2>&1; tail -20 /tmp/pe.txt`
Expected: FAIL — `transition` is not assignable to `ExportPortal` (type error) and is undefined on the bundle record.

- [ ] **Step 3: Write the implementation**

In `src/portal-export.ts`:

1. `ExportPortal` gains the field:

```ts
type ExportPortal = {
    position: Vec3,
    rotation: Quat,
    width: number,
    height: number,
    frontUid: number | null,
    backUid: number | null,
    infinite?: InfiniteEdges,
    transition?: boolean   // absent = enabled
};
```

2. `PortalBundle.portals` gains it too:

```ts
    portals: { position: Vec3, rotation: Quat, width: number, height: number, front: number | null, back: number | null, infinite?: InfiniteEdges, transition?: boolean }[];
```

3. `rewritten` inside `buildPortalBundle` carries it (after `infinite: p.infinite`):

```ts
        infinite: p.infinite,
        transition: p.transition
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/portal-export.test.ts > /tmp/pe.txt 2>&1; tail -20 /tmp/pe.txt`
Expected: PASS — new tests plus all pre-existing bundle/extras tests.

- [ ] **Step 5: Confirm the other export paths need no change**

Run: `grep -rn "buildPortalBundle\|resolvePortalExtras" src/ --include=*.ts`

Expected: the only callers are `src/ui/export-popup.ts`, `src/ui/s3-publish-dialog.ts`, `src/file-handler.ts` and `src/portal-upload.ts`, all of which pass `events.invoke('portals.export')` straight through. No edits required — record this in the commit message.

- [ ] **Step 6: Lint and commit**

```bash
npm run lint > /tmp/lint.txt 2>&1; tail -5 /tmp/lint.txt
git add src/portal-export.ts test/portal-export.test.ts
git commit -m "feat(portals): carry the transition flag into the export bundle"
```

---

### Task 6: Exported-viewer runtime

**Files:**
- Modify: `src/viewer-companion/portals.ts` — imports (line 1-4), `companionStyle` (line ~35), `companionRuntime` stringified-helper block (line ~65-82), `rects` mapping (line ~488), a new tile-cover section, `dispatch` (line ~456), `tick` free-nav branch (line ~981-993) and the overlay poll block (line ~1001)
- Test: `test/portals-injection.test.ts` (append to the existing `buildPortalsInjection` describe)

**Interfaces:**
- Consumes: `tileGrid`, `tileGeometry`, `tileDelay`, `transitionReducer` (Task 1); `resolvePortalCrossing` (Task 2); `data.portals[i].transition` (Task 5).
- Produces: no exported interface — behaviour in the injected runtime.

**Read first:** the spec's "Runtime" section, and the constraint comment at the top of `src/portal-crossing.ts`. `crossingReducer` must NOT be modified.

- [ ] **Step 1: Write the failing injection test**

Append inside the existing `describe('buildPortalsInjection', ...)` in `test/portals-injection.test.ts`:

```ts
    it('ships the transition helpers, CSS and payload flag', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1, transition: false }],
            portalScenes: ['', 'scenes/1/scene.sog'],
            portalStart: 0,
            portalCollision: [],
            portalEnvironments: ['indoor', 'indoor'],
            portalSceneLodCounts: [[1000], [1000]]
        });
        // the per-portal flag reaches the viewer payload
        expect(out).toContain('"transition":false');
        // the pure helpers are stringified in
        expect(out).toContain('var transitionReducer =');
        expect(out).toContain('var tileGrid =');
        expect(out).toContain('var tileGeometry =');
        expect(out).toContain('var tileDelay =');
        expect(out).toContain('var resolvePortalCrossing =');
        // the tile layer CSS ships
        expect(out).toContain('ss-portal-tiles');
        expect(out).toContain('#0a0c10');
        expect(out).toContain('opacity: .7');
    });

    it('keeps the runtime free of template-literal hazards', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/scene.sog'],
            portalStart: 0,
            portalCollision: [],
            portalEnvironments: ['indoor', 'indoor'],
            portalSceneLodCounts: [[1000], [1000]]
        });
        // '${' would have interpolated at build time; a surviving one means the
        // runtime body was authored wrong.
        expect(out.includes('$' + '{')).toBe(false);
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/portals-injection.test.ts > /tmp/pi.txt 2>&1; tail -30 /tmp/pi.txt`
Expected: FAIL — none of the transition markers are present.

- [ ] **Step 3: Extend the imports**

At the top of `src/viewer-companion/portals.ts`, extend the existing import statements **in place** (no reordering):

```ts
import { crossingReducer } from '../portal-crossing';
import { segmentCrossesRect, resolvePortalCrossing } from '../portal-geom';
import { tileGrid, tileGeometry, tileDelay, transitionReducer } from '../portal-transition';
```

`resolveActiveSplat` is no longer used by the companion (Step 7 replaces its only call site). Remove it from this import only — `src/portals-runtime.ts` and the unit tests keep using it from `portal-geom`.

- [ ] **Step 4: Add the tile CSS**

Append to the `companionStyle` template literal, after the existing `@keyframes ss-portal-spin` line:

```css
.ss-portal-tiles {
  position: fixed; inset: 0; z-index: 1999; pointer-events: none;
  display: grid; visibility: hidden; opacity: .7;
}
.ss-portal-tiles.armed { visibility: visible; }
.ss-portal-tile {
  background: #0a0c10; opacity: 0;
  will-change: transform, opacity;
  transition: opacity 150ms ease-out, transform 150ms cubic-bezier(.2,.75,.3,1);
}
.ss-portal-tile.on { opacity: 1; transform: scale(1.02) rotate(0deg); }
```

`z-index: 1999` is deliberate: one below the loading backdrop's `2000`, so the opaque loading overlay and its spinner always draw above the cover. `visibility: hidden` when unarmed keeps the idle layer out of compositing entirely.

- [ ] **Step 5: Stringify the helpers into the runtime**

In `companionRuntime`, immediately after the existing `var computeRevealLevel = ...` line, add — using the same `${...toString()}` interpolation form as every neighbouring line:

```
  var resolvePortalCrossing = ${resolvePortalCrossing.toString()};
  var tileGrid = ${tileGrid.toString()};
  var tileGeometry = ${tileGeometry.toString()};
  var tileDelay = ${tileDelay.toString()};
  var transitionReducer = ${transitionReducer.toString()};
```

These interpolations run at **build** time (they are part of the outer template literal that produces the runtime source). Everything *inside* the runtime body you write by hand must still contain no interpolation sequences of its own.

Also **remove** the existing `var resolveActiveSplat = ...` stringified line, since Step 7 removes its only call.

- [ ] **Step 6: Add the tile-cover block**

Insert a new section in `companionRuntime` immediately after the loading-overlay helpers (after `function hideLoading() { ... }`):

```js
  // --- portal transition cover -------------------------------------------
  // A grid of translucent tiles above the canvas (below the loading overlay).
  // Dismantle: tiles fly in from outside, spinning, edges-first, so the centre
  // of the outgoing scene is covered last. The scene swap happens under the
  // cover. Reconstruct: tiles spin away outward, centre-first, revealing the
  // incoming scene. All phase decisions live in transitionReducer.
  var REDUCED_MOTION = false;
  try { REDUCED_MOTION = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (mmErr) { REDUCED_MOTION = false; }
  var T_SWEEP = REDUCED_MOTION ? 0 : 225;     // stagger across the grid
  var T_TILE = REDUCED_MOTION ? 150 : 150;    // per-tile motion
  var T_HOLD = 100;                            // covered hold before reconstruct
  var T_COVERED_MAX_FRAMES = 120;              // ~2s watchdog while covered with no overlay

  var tileLayer = document.createElement('div');
  tileLayer.className = 'ss-portal-tiles';
  var tiles = [];                 // {el, dist, ux, uy, spin}
  var transState = { phase: 'idle', target: null };
  var coveredFrames = 0;
  var coverTimer = null;

  function mountTiles() { document.body.appendChild(tileLayer); }
  if (document.body) { mountTiles(); } else { document.addEventListener('DOMContentLoaded', mountTiles); }

  function buildTiles() {
    var g = tileGrid(window.innerWidth || 1280, window.innerHeight || 720);
    tileLayer.style.gridTemplateColumns = 'repeat(' + g.cols + ', 1fr)';
    tileLayer.style.gridTemplateRows = 'repeat(' + g.rows + ', 1fr)';
    while (tileLayer.firstChild) { tileLayer.removeChild(tileLayer.firstChild); }
    tiles = [];
    var n = g.cols * g.rows;
    for (var i = 0; i < n; i++) {
      var el = document.createElement('div');
      el.className = 'ss-portal-tile';
      tileLayer.appendChild(el);
      var geo = tileGeometry(g.cols, g.rows, i);
      tiles.push({
        el: el, dist: geo.dist, ux: geo.ux, uy: geo.uy,
        // magnitude 16-66 degrees, signed by the tile's radial direction
        spin: (16 + Math.random() * 50) * (geo.ux > 0 ? 1 : -1)
      });
    }
  }
  buildTiles();
  window.addEventListener('resize', function () {
    if (transState.phase === 'idle') { buildTiles(); }
  });

  // The off-slot transform a tile animates from (dismantle) and to
  // (reconstruct): pushed outward along its radial direction, small, spun.
  // Reduced motion keeps the tile in place and animates opacity only.
  function tileAway(t) {
    if (REDUCED_MOTION) { return 'none'; }
    return 'translate(' + (t.ux * 140) + 'px,' + (t.uy * 140) + 'px) scale(.25) rotate(' + t.spin + 'deg)';
  }

  // Two loops with ONE flush between them (standard FLIP). A flush inside the
  // loop would force a style-recalc + layout per tile -- up to 320 synchronous
  // layout passes in the frame the user crosses a portal, with the gsplat
  // canvas already under load.
  function startDismantle() {
    tileLayer.classList.add('armed');
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      t.el.style.transition = 'none';
      t.el.style.transitionDelay = '0ms';
      t.el.classList.remove('on');
      t.el.style.transform = tileAway(t);
    }
    void tileLayer.offsetWidth;              // one flush for the whole layer
    for (var j = 0; j < tiles.length; j++) {
      var u = tiles[j];
      u.el.style.transition = '';
      u.el.style.transitionDelay = tileDelay(u.dist, T_SWEEP, 'dismantle') + 'ms';
      u.el.classList.add('on');
      u.el.style.transform = '';
    }
    if (coverTimer) { clearTimeout(coverTimer); }
    coverTimer = setTimeout(onCoverComplete, T_SWEEP + T_TILE);
  }

  function startReconstruct() {
    if (coverTimer) { clearTimeout(coverTimer); }
    coverTimer = setTimeout(function () {
      for (var i = 0; i < tiles.length; i++) {
        var t = tiles[i];
        t.el.style.transitionDelay = tileDelay(t.dist, T_SWEEP, 'reconstruct') + 'ms';
        t.el.style.transform = tileAway(t);
        t.el.classList.remove('on');
      }
      coverTimer = setTimeout(function () { transDispatch({ type: 'done' }); }, T_SWEEP + T_TILE);
    }, T_HOLD);
  }

  function clearCover() {
    if (coverTimer) { clearTimeout(coverTimer); coverTimer = null; }
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      t.el.style.transition = 'none';
      t.el.style.transitionDelay = '0ms';
      t.el.classList.remove('on');
      t.el.style.transform = 'none';
    }
    void tileLayer.offsetWidth;              // one flush for the whole layer
    for (var j = 0; j < tiles.length; j++) {
      tiles[j].el.style.transition = '';
    }
    tileLayer.classList.remove('armed');
  }

  // Does portal p want the effect? Absent means enabled.
  function transitionEnabled(portalIndex) {
    if (portalIndex === null || portalIndex === undefined) { return false; }
    var p = data.portals[portalIndex];
    return !!p && p.transition !== false;
  }

  // Cover complete: re-resolve the crossing from the FROZEN lastSafe to the
  // camera's current position. If the user walked back through the doorway
  // during the dismantle, the target is gone -> cancel with no switch.
  function onCoverComplete() {
    var target = null;
    try {
      if (lastSafe) {
        var r = resolvePortalCrossing(lastSafe, curPos, rects, activeIndex, segmentCrossesRect);
        if (r.uid !== null && r.uid !== activeIndex) { target = r.uid; }
      }
    } catch (ccErr) { target = transState.target; }
    transDispatch({ type: 'covered', target: target });
  }

  function transDispatch(ev) {
    var res = transitionReducer(transState, ev);
    transState = res.state;
    var a = res.actions;
    if (transState.phase === 'covered') { coveredFrames = 0; }
    if (a.cover === 'dismantle') { startDismantle(); }
    else if (a.cover === 'reconstruct') { startReconstruct(); }
    else if (a.cover === 'clear') { clearCover(); }
    if (a.dispatchTarget !== null) {
      var u = a.dispatchTarget;
      dispatch({ type: 'crossing', target: u, loaded: !!(entities[u] || sceneLoading[u]), ready: sceneReady(u) });
    }
    if (transState.phase === 'idle' && a.cover !== 'dismantle') { tileLayer.classList.remove('armed'); }
  }
```

Note the ordering constraint: `transDispatch` calls `dispatch`, and `dispatch` (Step 7) calls `transDispatch`. Both are function declarations, so hoisting makes the mutual reference safe regardless of placement — keep this block where specified.

- [ ] **Step 7: Wire it into `dispatch` and `tick`**

**7a — `dispatch`.** At the very end of the existing `dispatch` function (after the overlay if/else chain), append:

```js
    // The cover is up and the crossing lifecycle just settled (switched and
    // ready, reveal completed, or the crossing was abandoned): the destination
    // is on screen behind the tiles, so reconstruct. This single hook covers
    // the immediate-ready commit AND the post-loading-overlay reveal.
    if (transState.phase === 'covered' && crossState.mode === 'idle') {
      transDispatch({ type: 'sceneShown' });
    }
```

**7b — `tick`, free-navigation branch.** Replace the existing `else if (lastSafe) { ... }` body (the block that calls `resolveActiveSplat`) with:

```js
        } else if (lastSafe) {
          var cr = resolvePortalCrossing(lastSafe, curPos, rects, activeIndex, segmentCrossesRect);
          var next = cr.uid;
          if (next !== activeIndex && next !== null) {
            if (transState.phase === 'dismantling') {
              // Crossing already latched; the commit re-resolves it. Dispatching
              // now would switch the scene before the cover has closed.
            } else if (transState.phase === 'idle' && transitionEnabled(cr.portalIndex)) {
              // Defer the switch: dismantle first, commit when covered.
              transDispatch({ type: 'crossing', target: next });
            } else {
              // No transition for this portal, or one is already past its commit
              // (covered / reconstructing). Dispatch normally. This path is
              // REQUIRED, not just an optimisation: when the committed crossing
              // came back `blocked`, the frozen-lastSafe re-fire arrives here
              // every frame and is what finally completes the switch once the
              // target loads. Suppressing it would strand the cover until the
              // watchdog.
              dispatch({ type: 'crossing', target: next, loaded: !!(entities[next] || sceneLoading[next]), ready: sceneReady(next) });
            }
          } else if (crossState.mode === 'blocked') {
            dispatch({ type: 'noCrossing' });   // user retreated to the known side
          }
          // Freeze lastSafe while a crossing is blocked OR while the dismantle
          // is playing. The dismantle freeze is load-bearing: without it the
          // camera walks past the portal during the sweep, the frozen segment
          // no longer crosses the rectangle, and a later blocked dispatch could
          // never re-fire - the crossing would be lost.
          if (crossState.mode !== 'blocked' && transState.phase !== 'dismantling') {
            lastSafeBuf[0] = curPos[0]; lastSafeBuf[1] = curPos[1]; lastSafeBuf[2] = curPos[2]; lastSafe = lastSafeBuf;
          }
        } else {
```

**7c — `tick`, overlay poll block.** Immediately after the `if (pendingIndex !== null) { ... }` block inside the same `try`, add the covered watchdog:

```js
      // Watchdog: the cover must never outlive its hand-off. While an overlay
      // is showing, the overlay's own reveal caps bound the wait; with no
      // overlay, a missed hand-off would strand the cover, so force the
      // reconstruct after ~2s.
      if (transState.phase === 'covered' && !overlayShown) {
        coveredFrames++;
        if (coveredFrames > T_COVERED_MAX_FRAMES) {
          console.warn('[portals] transition cover watchdog fired -- reconstructing');
          transDispatch({ type: 'sceneShown' });
        }
      }
```

**7d — `tick` error paths.** In the `catch` of the overlay-poll `try` (the one that currently logs `portal overlay poll error`), add before its existing recovery lines:

```js
      if (transState.phase !== 'idle') { transDispatch({ type: 'abort' }); }
```

And in the outer `catch (err)` of `tick` (the `tickErrored` one), add the same guarded abort so a throw mid-transition can never strand the cover:

```js
      try { if (transState.phase !== 'idle') { transDispatch({ type: 'abort' }); } } catch (abortErr) {}
```

- [ ] **Step 8: Add the per-portal flag to `rects`**

In the `rects` mapping (`data.portals.map(...)`), add the field:

```js
    return { position: p.position, rotation: p.rotation, width: p.width, height: p.height, frontUid: p.front, backUid: p.back, infinite: p.infinite, transition: p.transition };
```

- [ ] **Step 9: Run the injection tests and the full suite**

Run: `npx vitest run test/portals-injection.test.ts > /tmp/pi.txt 2>&1; tail -30 /tmp/pi.txt`
Expected: PASS.

Run: `npm run test > /tmp/all.txt 2>&1; tail -25 /tmp/all.txt`
Expected: PASS, whole suite green (portal-crossing tests included and unchanged).

- [ ] **Step 10: Lint and commit**

```bash
npm run lint > /tmp/lint.txt 2>&1; tail -5 /tmp/lint.txt
git add src/viewer-companion/portals.ts test/portals-injection.test.ts
git commit -m "feat(portals): tile transition effect in the exported viewer runtime"
```

---

### Task 7: Release-build end-to-end verification

**Files:** none modified unless a defect is found.

**Interfaces:** none — this is the acceptance gate for the whole feature.

Minification has broken stringified helpers in this subsystem before, so a debug build proves nothing here. Every check below is on a **release** build.

- [ ] **Step 1: Build a release bundle**

```bash
npm run build > /tmp/build.txt 2>&1; tail -5 /tmp/build.txt
```

- [ ] **Step 2: Non-streaming (SOG) multi-scene export**

Export a ZIP with at least two portal-linked scenes, streaming OFF, and open the exported `index.html`. Walk through a portal.

Expected: tiles fly in edges-first and cover the screen, the scene swaps hidden, tiles spin away centre-first revealing the new scene. No console errors. Total ≈ 1.5 s.

- [ ] **Step 3: Streaming export, cold cache**

Export the same project with streaming ON. Open it in a fresh profile (or hard-reload with cache disabled **only for this check** — never measure LOD download counts this way). Walk into a scene that has not streamed yet.

Expected: dismantle → the loading overlay with its spinner appears **above** the tiles → after the reveal, the cover breaks up. The reconstruct comes after the loading screen, never before.

Then throttle the network to a slow profile and cross into a scene whose asset has not loaded at all (the `blocked` path — the reducer holds the crossing until the target is loadable). Expected: same sequence, the cover simply stays up longer, and the switch completes on its own with no watchdog warning in the console (`transition cover watchdog fired` must NOT appear).

- [ ] **Step 4: Toggle off**

Set one portal's transition off in the editor, re-export, cross that portal.

Expected: instant switch, exactly today's behaviour. Crossing a different (enabled) portal in the same export still plays the effect.

- [ ] **Step 5: Walk back during the dismantle**

Cross a portal and immediately reverse through it while the tiles are still closing.

Expected: the cover reconstructs and the original scene is still active — no switch, no stuck cover.

- [ ] **Step 6: Untouched paths**

In the same export: press `R` (reset), click an annotation that lives in another scene, and play the walkthrough animation across a crossing.

Expected: all three switch instantly with no tiles — unchanged from before this feature.

- [ ] **Step 7: Mobile**

Open the streaming export on a phone and cross a portal.

Expected: the effect plays without a frame-rate collapse, and the fewer/larger tiles from `tileGrid`'s clamp look right at that viewport.

- [ ] **Step 8: Reduced motion**

Enable the OS "reduce motion" setting and cross a portal.

Expected: the cover fades in and out (~150 ms each way) with no tile flight, and the phase sequence — including the loading-overlay hand-off — is otherwise identical.

- [ ] **Step 9: Record the result**

Report which checks passed. If any failed, fix on this branch with a test where the defect is unit-testable, and re-run the failed check.

- [ ] **Step 10: Finish the branch**

Do NOT merge from this plan. Hand off to the `superpowers:finishing-a-development-branch` skill, which squashes the feature into a single commit (including the spec and this plan) and merges to `main`.

---

## Notes for the implementer

- `crossingReducer` (`src/portal-crossing.ts`) is deliberately untouched. If a change there seems necessary, stop and re-read the spec's hand-off section — the transition wraps that reducer, it does not replace it.
- The `dispatch` hook in Task 6 Step 7a fires on *any* settle to `idle`, including the abandoned-crossing path where no switch happened. That is intended: the cover must reopen on the scene the user is actually looking at.
- Existing field diagnostics in this runtime log every crossing decision with `console.info('[portals] crossing -> ...')`. Do not remove them; they are how streaming issues get diagnosed remotely.
