# Portal Transition Dropdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the portal editor's single on/off transition toggle with a three-way dropdown — None / Tiles / Defocus Dip — retiming the existing tile effect and adding a new full-screen defocus effect to the exported viewer.

**Architecture:** `PortalData.transition` moves from `boolean` to a `'none' | 'tiles' | 'defocus'` enum with a pure normalizer that absorbs the legacy boolean, so existing documents need no migration. The exported viewer's `transitionReducer` lifecycle is unchanged; only the three cover drivers it commands (`startDismantle` / `startReconstruct` / `clearCover`) branch on a `coverKind` captured when a crossing is accepted. Both covers are CSS-transition driven — no rAF loop, no canvas readback.

**Tech Stack:** TypeScript (strictNullChecks off), PCUI (`SelectInput`), Vitest, Rollup, i18next. The exported-viewer runtime lives in `src/viewer-companion/portals.ts` as a template literal that is injected verbatim into the exported HTML.

**Spec:** `docs/superpowers/specs/2026-08-06-portal-transition-dropdown-design.md`

## Post-execution amendments

This plan is an execution record; the following were decided after it ran and
are **not** reflected in the task text below. The spec
(`docs/superpowers/specs/2026-08-06-portal-transition-dropdown-design.md`) is the
current source of truth.

1. **Defocus is now the default, not Tiles.** `normalizePortalTransition` falls
   back to `'defocus'`; only an explicit `'tiles'` selects the tile cover. Every
   "absent = 'tiles'" statement below is therefore stale.
2. **Dropdown order is None / Defocus Dip / Tiles.**
3. **`will-change` was removed from both covers** (redundant for a running
   transform/opacity transition, and `background-color` is not compositable).
4. **`.ss-portal-tile` gained `margin: -1px`** to close the seams the 26px grid
   opened — `scale(1.02)` is a proportional overlap and fell under one device
   pixel at that tile size.

## Global Constraints

- **Timings are fixed, copied verbatim from the spec.** Tiles: sweep `150ms`, per-tile `100ms`, hold `67ms`. Defocus: in `213ms` `cubic-bezier(.32,0,.67,0)`, out `373ms` `cubic-bezier(.22,1,.36,1)`, hold `67ms`.
- **Tile grid:** `TARGET = 26`, `MAX_TILES = 1200`, minimums `6` cols / `4` rows. Fly distance `86.5px`.
- **Defocus endpoints:** `blur(26px) saturate(.45)`, veil `rgba(7,10,14,.9)`.
- **`src/viewer-companion/portals.ts` is a template literal.** Any code added to `companionStyle` or `companionRuntime` must contain **no backslash escapes** and **no `${` sequences** — they are cooked at build time. String concatenation only.
- **Functions stringified into the viewer must be self-contained.** `tileGrid`, `tileGeometry`, `tileDelay` and `transitionReducer` in `src/portal-transition.ts` are passed through `Function.toString()` and evaluated in a separate scope: no imports, no sibling references, all literals inline. `normalizePortalTransition` is **not** stringified — it is a plain import.
- **Do not modify `transitionReducer`, `crossingReducer`, `resolvePortalCrossing`, or the collision-swap call in `transDispatch`.** They are out of scope.
- **ESLint `import/order` autofix crashes** on this repo's pinned ESLint 10. Match surrounding import order by hand; never run an import-order autofix.
- **Run tests in the foreground**, redirecting output to a file. Never background-chain or pipe `vitest` to `grep` — it hangs.
- Commands run plainly from the repo root. No `cd` / `git -C` / `npm --prefix` prefixes pointing at the cwd.

## File Structure

| file | responsibility | change |
| --- | --- | --- |
| `src/portal-transition.ts` | pure transition primitives (stringified) + the transition enum | modify |
| `src/portals.ts` | `PortalData` type, document serialize/deserialize, edit ops | modify |
| `src/portal-export.ts` | editor records → exported bundle payload | modify |
| `src/tools/portal-tool.ts` | portal editor bar UI | modify |
| `src/viewer-companion/portals.ts` | exported-viewer runtime (CSS + JS template literals) | modify |
| `static/locales/*.json` (9 files) | UI strings | modify |
| `test/portal-transition.test.ts` | `tileGrid` + normalizer unit tests | modify |
| `test/portals.test.ts` | document round-trip tests | modify |
| `test/portal-export.test.ts` | bundle payload tests | modify |
| `test/portals-injection.test.ts` | injected-runtime string assertions | modify |

No new files. Every change is confined to files that already own the concept.

---

### Task 1: The transition enum and normalizer

**Files:**
- Modify: `src/portal-transition.ts:1-11` (header comment), `:141-152` (exports)
- Test: `test/portal-transition.test.ts:3` (import), append new describe block

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type PortalTransition = 'none' | 'tiles' | 'defocus'`
  - `normalizePortalTransition(v: unknown): PortalTransition`

- [ ] **Step 1: Write the failing test**

Append to `test/portal-transition.test.ts`:

```typescript
describe('normalizePortalTransition', () => {
    it('maps the legacy boolean onto the enum', () => {
        expect(normalizePortalTransition(false)).toBe('none');
        expect(normalizePortalTransition(true)).toBe('tiles');
    });

    it('treats an absent value as tiles (the historical "absent means enabled")', () => {
        expect(normalizePortalTransition(undefined)).toBe('tiles');
        expect(normalizePortalTransition(null)).toBe('tiles');
    });

    it('passes the three enum values through', () => {
        expect(normalizePortalTransition('none')).toBe('none');
        expect(normalizePortalTransition('tiles')).toBe('tiles');
        expect(normalizePortalTransition('defocus')).toBe('defocus');
    });

    it('falls back to tiles for an unrecognised value', () => {
        expect(normalizePortalTransition('shards')).toBe('tiles');
        expect(normalizePortalTransition(7)).toBe('tiles');
    });
});
```

And extend the import on line 3:

```typescript
import { tileGrid, tileGeometry, tileDelay, transitionReducer, normalizePortalTransition, TransitionState } from '../src/portal-transition';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/portal-transition.test.ts > /tmp/t1.txt 2>&1; tail -30 /tmp/t1.txt`
Expected: FAIL — `normalizePortalTransition is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `src/portal-transition.ts`, immediately after the `TransitionResult` type alias (before the `tileGrid` definition):

```typescript
// Which cover the exported viewer plays when a portal is crossed. NOT
// stringified into the viewer -- this is a plain import used by the editor UI,
// the document reader and the export payload builder.
type PortalTransition = 'none' | 'tiles' | 'defocus';

// Single reader for every stored shape of the field. Documents written before
// the dropdown stored a boolean, where absent meant "enabled", so anything that
// is not an explicit off resolves to the tile cover.
const normalizePortalTransition = (v: unknown): PortalTransition => {
    if (v === false || v === 'none') {
        return 'none';
    }
    if (v === 'defocus') {
        return 'defocus';
    }
    return 'tiles';
};
```

Add both to the export block at the bottom:

```typescript
export {
    tileGrid,
    tileGeometry,
    tileDelay,
    transitionReducer,
    normalizePortalTransition,
    PortalTransition,
    TilePhase,
    TransitionPhase,
    TransitionState,
    TransitionEvent,
    TransitionActions,
    TransitionResult
};
```

- [ ] **Step 4: Fix the file header, which now over-claims**

Replace lines 5-10 of `src/portal-transition.ts`:

```typescript
// tileGrid, tileGeometry, tileDelay and transitionReducer are stringified into
// the exported viewer (Function.toString()) and evaluated in a separate scope,
// so each of those four must be SELF-CONTAINED: no imports, no references to
// sibling functions or module constants, all literals inline. The runtime body
// that hosts them is authored inside a template literal, so this file must also
// contain no backslash escapes and no '${' sequences in code that is
// stringified. normalizePortalTransition is NOT stringified; it is a plain
// import used by the editor and the export builder.
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/portal-transition.test.ts > /tmp/t1.txt 2>&1; tail -30 /tmp/t1.txt`
Expected: PASS — all tests green (the four existing `tileGrid` tests still pass; they are rewritten in Task 2)

- [ ] **Step 6: Commit**

```bash
git add src/portal-transition.ts test/portal-transition.test.ts
git commit -m "feat(portals): add the PortalTransition enum and its normalizer"
```

---

### Task 2: Retarget the tile grid to 26px with a total-tile cap

**Files:**
- Modify: `src/portal-transition.ts:42-63` (`tileGrid`)
- Test: `test/portal-transition.test.ts:5-29` (`describe('tileGrid')`)

**Interfaces:**
- Consumes: nothing
- Produces: `tileGrid(width: number, height: number): { cols: number, rows: number }` — same signature, new bounds. Callers unchanged.

- [ ] **Step 1: Write the failing test**

Replace the whole `describe('tileGrid', ...)` block in `test/portal-transition.test.ts` (lines 5-29) with:

```typescript
describe('tileGrid', () => {
    it('produces roughly square 26px tiles at a desktop aspect', () => {
        const g = tileGrid(1600, 1000);
        expect(g.cols).toBe(43);
        expect(g.rows).toBe(27);
    });

    it('hits the 26px target exactly on a phone, where the cap does not bite', () => {
        const g = tileGrid(390, 844);
        expect(g.cols).toBe(15);
        expect(g.rows).toBe(32);
        expect(g.cols * g.rows).toBe(480);
    });

    it('keeps a small viewport on the 26px target', () => {
        const g = tileGrid(320, 640);
        expect(g.cols).toBe(12);
        expect(g.rows).toBe(24);
    });

    it('clamps a very narrow viewport to the minimum columns', () => {
        const g = tileGrid(80, 200);
        expect(g.cols).toBe(6);
        expect(g.rows).toBe(15);
    });

    it('still caps when an axis is pinned to its minimum', () => {
        // cols floors to 6 before the cap, so scaling it down and reclamping
        // would re-inflate the product past MAX_TILES
        const g = tileGrid(100, 5000);
        expect(g.cols).toBe(6);
        expect(g.rows).toBe(200);
        expect(g.cols * g.rows).toBeLessThanOrEqual(1200);
    });

    it('caps the total tile count on a large display', () => {
        const g = tileGrid(2560, 1440);
        expect(g.cols * g.rows).toBeLessThanOrEqual(1200);
        expect(g.cols).toBe(46);
        expect(g.rows).toBe(25);
    });

    it('keeps tiles roughly square when the cap bites', () => {
        const g = tileGrid(1920, 1080);
        expect(g.cols * g.rows).toBeLessThanOrEqual(1200);
        const tileW = 1920 / g.cols;
        const tileH = 1080 / g.rows;
        expect(tileW / tileH).toBeGreaterThan(0.8);
        expect(tileW / tileH).toBeLessThan(1.25);
    });

    it('caps an extreme aspect ratio too', () => {
        const g = tileGrid(6000, 400);
        expect(g.cols * g.rows).toBeLessThanOrEqual(1200);
        expect(g.rows).toBeGreaterThanOrEqual(4);
    });

    it('falls back to a valid grid for degenerate sizes', () => {
        const g = tileGrid(0, 0);
        expect(g.cols).toBeGreaterThanOrEqual(6);
        expect(g.rows).toBeGreaterThanOrEqual(4);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/portal-transition.test.ts > /tmp/t2.txt 2>&1; tail -40 /tmp/t2.txt`
Expected: FAIL — `expected 15 to be 43` (the current 110px target with the 20x16 clamp)

- [ ] **Step 3: Write minimal implementation**

Replace `tileGrid` in `src/portal-transition.ts` (lines 42-63) with:

```typescript
// Tile grid for a viewport: roughly square tiles around a 26px target, floored
// so a phone does not get one giant tile and capped on total count so a large
// display does not animate several thousand composited divs. Phones and small
// laptops hit 26px exactly; only big displays fall back to a coarser grid, and
// they land around 40-56px -- still ~4x finer than the 110px this replaced.
const tileGrid = (width: number, height: number): { cols: number, rows: number } => {
    const TARGET = 26;
    const MAX_TILES = 1200;
    const w = (typeof width === 'number' && width > 0) ? width : TARGET;
    const h = (typeof height === 'number' && height > 0) ? height : TARGET;
    let cols = Math.round(w / TARGET);
    if (cols < 6) {
        cols = 6;
    }
    let rows = Math.round(cols * h / w);
    if (rows < 4) {
        rows = 4;
    }
    if (cols * rows > MAX_TILES) {
        // scale both axes by the same factor so the tiles stay roughly square
        const k = Math.sqrt(MAX_TILES / (cols * rows));
        cols = Math.floor(cols * k);
        rows = Math.floor(rows * k);
        if (cols < 6) {
            cols = 6;
        }
        if (rows < 4) {
            rows = 4;
        }
        // An axis already sitting at its minimum before the cap gets scaled
        // down and then reclamped straight back up, re-inflating the product
        // past MAX_TILES. Give the long axis whatever the short one leaves.
        if (cols * rows > MAX_TILES) {
            if (cols >= rows) {
                cols = Math.floor(MAX_TILES / rows);
                if (cols < 6) {
                    cols = 6;
                }
            } else {
                rows = Math.floor(MAX_TILES / cols);
                if (rows < 4) {
                    rows = 4;
                }
            }
        }
    }
    return { cols: cols, rows: rows };
};
```

Note: no `const`/arrow helpers may be extracted out of this function — it is stringified into the viewer and must stay self-contained.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/portal-transition.test.ts > /tmp/t2.txt 2>&1; tail -40 /tmp/t2.txt`
Expected: PASS — all `tileGrid` and `normalizePortalTransition` tests green

- [ ] **Step 5: Commit**

```bash
git add src/portal-transition.ts test/portal-transition.test.ts
git commit -m "feat(portals): retarget the transition tile grid to 26px with a 1200-tile cap"
```

---

### Task 3: Widen `PortalData.transition` to the enum

**Files:**
- Modify: `src/portals.ts:16-20` (type), `:335-345` (deserialize)
- Test: `test/portals.test.ts:281-320` (`describe('portal transition flag')`)

**Interfaces:**
- Consumes: `PortalTransition`, `normalizePortalTransition` from Task 1
- Produces: `PortalData.transition?: PortalTransition`. `docSerialize.portals` writes the value verbatim; `docDeserialize.portals` maps legacy booleans onto the enum but leaves an absent field absent.

- [ ] **Step 1: Write the failing test**

Replace the whole `describe('portal transition flag', ...)` block in `test/portals.test.ts` (lines 281-320) with:

```typescript
describe('portal transition kind', () => {
    it('portals.export carries the transition kind through', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        events.fire('portals.insertRaw', portal({ id: 'portal_0', transition: 'none' }));
        events.fire('portals.insertRaw', portal({ id: 'portal_1', transition: 'defocus' }));
        events.fire('portals.insertRaw', portal({ id: 'portal_2' }));
        const out = events.invoke('portals.export');
        expect(out[0].transition).toBe('none');
        expect(out[1].transition).toBe('defocus');
        expect(out[2].transition).toBeUndefined();
    });

    it('docSerialize keeps an explicit kind and omits an absent one', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        events.fire('portals.insertRaw', portal({ id: 'portal_0', transition: 'defocus' }));
        events.fire('portals.insertRaw', portal({ id: 'portal_1' }));
        const serialized = events.invoke('docSerialize.portals');
        expect(serialized[0].transition).toBe('defocus');
        expect(JSON.parse(JSON.stringify(serialized[1])).transition).toBeUndefined();
    });

    it('docDeserialize restores an explicit kind', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        events.invoke('docDeserialize.portals', [
            { id: 'portal_0', position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, frontUid: 1, backUid: 2, transition: 'defocus' }
        ]);
        expect((events.invoke('portals.list') as PortalData[])[0].transition).toBe('defocus');
    });

    it('migrates a legacy transition:false document to none', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        events.invoke('docDeserialize.portals', [
            { id: 'portal_0', position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, frontUid: 1, backUid: 2, transition: false }
        ]);
        expect((events.invoke('portals.list') as PortalData[])[0].transition).toBe('none');
    });

    it('migrates a legacy transition:true document to tiles', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        events.invoke('docDeserialize.portals', [
            { id: 'portal_0', position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, frontUid: 1, backUid: 2, transition: true }
        ]);
        expect((events.invoke('portals.list') as PortalData[])[0].transition).toBe('tiles');
    });

    it('a legacy document without the field stays absent, so re-saving does not dirty it', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        events.invoke('docDeserialize.portals', [
            { id: 'portal_0', position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, frontUid: 1, backUid: 2 }
        ]);
        const p = (events.invoke('portals.list') as PortalData[])[0];
        expect(p.transition).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/portals.test.ts > /tmp/t3.txt 2>&1; tail -40 /tmp/t3.txt`
Expected: FAIL — `expected false to be 'none'` on the legacy-migration cases

- [ ] **Step 3: Write minimal implementation**

In `src/portals.ts`, add the import. The file's existing imports must keep their current order — insert `PortalTransition` / `normalizePortalTransition` following the surrounding style:

```typescript
import { normalizePortalTransition, PortalTransition } from './portal-transition';
```

Change the `PortalData.transition` field (lines 17-20):

```typescript
    // Which cover the exported viewer plays when this portal is crossed.
    // ABSENT MEANS 'tiles' - documents written before the dropdown stored a
    // boolean and are migrated on load, so no document needs rewriting.
    transition?: PortalTransition
```

Widen the on-disk type so the legacy shape type-checks. Change `PortalDocData` (immediately below `PortalData`) to:

```typescript
type PortalDocData = Omit<PortalData, 'transition'> & {
    frontIndex?: number | null,
    backIndex?: number | null,
    // pre-dropdown documents stored a boolean here
    transition?: PortalTransition | boolean
};
```

In the deserialize handler, replace `transition: d.transition` (line ~343) with:

```typescript
                    transition: migrateDocTransition(d.transition)
```

and define the helper just above `registerPortalsEvents` (module scope, near `genId`):

```typescript
// Legacy documents stored a boolean; map it onto the enum at load. An absent
// field stays absent so loading and re-saving a document that never touched the
// feature does not write an explicit "tiles" into every portal record.
const migrateDocTransition = (v: unknown): PortalTransition | undefined => {
    return (v === undefined || v === null) ? undefined : normalizePortalTransition(v);
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/portals.test.ts > /tmp/t3.txt 2>&1; tail -40 /tmp/t3.txt`
Expected: PASS

- [ ] **Step 5: Verify the whole suite still passes**

Run: `npm run test > /tmp/t3all.txt 2>&1; tail -30 /tmp/t3all.txt`
Expected: all green. `test/portal-export.test.ts` still passes at this point — it feeds `buildPortalBundle` its own literals and does not go through `PortalData`.

Do **not** run `npm run build` here. `portal-export.ts` still declares `transition?: boolean` while `portals.export` now emits a string, so the app will not type-check until Task 4 lands. Vitest transpiles without type-checking, which is why the suite is green.

- [ ] **Step 6: Commit**

```bash
git add src/portals.ts test/portals.test.ts
git commit -m "feat(portals): widen PortalData.transition to the three-way enum"
```

---

### Task 4: Normalize the transition kind into the export payload

**Files:**
- Modify: `src/portal-export.ts:7` (import), `:20` (`ExportPortal`), `:25` (`PortalBundle`), `:87` (pass-through)
- Test: `test/portal-export.test.ts:107-121`

**Interfaces:**
- Consumes: `PortalTransition`, `normalizePortalTransition` from Task 1
- Produces: `PortalBundle.portals[].transition: PortalTransition` — always one of the three strings, never absent, never a boolean. This is the shape the viewer runtime in Tasks 6-8 reads.

- [ ] **Step 1: Write the failing test**

Replace the two `transition` tests in `test/portal-export.test.ts` (lines 107-121) with:

```typescript
    it('carries an explicit transition kind into the rewritten portals', () => {
        const b = buildPortalBundle({
            portals: [{ ...portal(10, 20), transition: 'defocus' as const }],
            startUid: 10, availableUids: [10, 20], streaming: false, collision: false
        })!;
        expect(b.portals[0].transition).toBe('defocus');
    });

    it('resolves an absent transition to tiles so the payload is always explicit', () => {
        const b = buildPortalBundle({
            portals: [portal(10, 20)],
            startUid: 10, availableUids: [10, 20], streaming: false, collision: false
        })!;
        expect(b.portals[0].transition).toBe('tiles');
    });

    it('migrates a legacy boolean false to none', () => {
        const b = buildPortalBundle({
            portals: [{ ...portal(10, 20), transition: false as any }],
            startUid: 10, availableUids: [10, 20], streaming: false, collision: false
        })!;
        expect(b.portals[0].transition).toBe('none');
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/portal-export.test.ts > /tmp/t4.txt 2>&1; tail -30 /tmp/t4.txt`
Expected: FAIL — `expected undefined to be 'tiles'`

- [ ] **Step 3: Write minimal implementation**

In `src/portal-export.ts`, add the import alongside the existing `portal-geom` one, matching its style:

```typescript
import { InfiniteEdges } from './portal-geom';
import { normalizePortalTransition, PortalTransition } from './portal-transition';
```

Change `ExportPortal.transition` (line 20):

```typescript
    transition?: PortalTransition   // absent = 'tiles'
```

Change the `PortalBundle.portals` element type (line 25) — note the field is now required, not optional:

```typescript
    portals: { position: Vec3, rotation: Quat, width: number, height: number, front: number | null, back: number | null, infinite?: InfiniteEdges, transition: PortalTransition }[];
```

Change the pass-through in `rewritten` (line 87):

```typescript
        transition: normalizePortalTransition(p.transition)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/portal-export.test.ts > /tmp/t4.txt 2>&1; tail -30 /tmp/t4.txt`
Expected: PASS

- [ ] **Step 5: Confirm the injection test now sees the new payload shape**

Run: `npx vitest run test/portals-injection.test.ts > /tmp/t4b.txt 2>&1; tail -30 /tmp/t4b.txt`
Expected: the `ships the transition helpers, CSS and payload flag` test still passes — it builds its own literal payload with `transition: false` and asserts `"transition":false`, which `buildPortalsInjection` serializes verbatim without going through `buildPortalBundle`. Task 8 updates it. If it fails for any other reason, stop and report.

- [ ] **Step 6: Commit**

```bash
git add src/portal-export.ts test/portal-export.test.ts
git commit -m "feat(portals): normalize the transition kind into the export payload"
```

---

### Task 5: Retime the tile cover to the design's 0.75x playback

**Files:**
- Modify: `src/viewer-companion/portals.ts:59-64` (CSS), `:337-339` (constants), `:390` (fly distance)
- Test: `test/portals-injection.test.ts:431-452`

**Interfaces:**
- Consumes: nothing
- Produces: nothing new. Behavioural change only.

- [ ] **Step 1: Write the failing test**

In `test/portals-injection.test.ts`, add these assertions at the end of the existing `it('ships the transition helpers, CSS and payload flag', ...)` block (after `expect(out).toContain('opacity: .7');`):

```typescript
        // the design's 0.75x playback: 150ms sweep + 100ms per tile, 67ms hold
        expect(out).toContain('transition: opacity 100ms ease-out, transform 100ms cubic-bezier(.2,.75,.3,1)');
        expect(out).toContain('var T_SWEEP = REDUCED_MOTION ? 0 : 150;');
        expect(out).toContain('var T_HOLD = 67;');
        // 26px tiles fly proportionally less far than the old 110px ones:
        // 140 * (0.5 + 0.5 * 26/110) = 86.5. Assert the whole expression so the
        // test cannot pass on an unrelated 86.5 elsewhere in the bundle.
        expect(out).toContain("'translate(' + (t.ux * 86.5) + 'px,' + (t.uy * 86.5) + 'px) scale(.25) rotate('");
        expect(out).not.toContain('t.ux * 140');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/portals-injection.test.ts > /tmp/t5.txt 2>&1; tail -30 /tmp/t5.txt`
Expected: FAIL — the 150ms CSS duration and 225ms sweep are still in the output

- [ ] **Step 3: Write minimal implementation**

In `src/viewer-companion/portals.ts`, change the tile CSS (lines 59-64). Only the two durations on the non-reduced rule change; the reduced rule keeps 150ms and is matched by `T_TILE` below:

```css
.ss-portal-tile {
  background: #0a0c10; opacity: 0;
  transition: opacity 100ms ease-out, transform 100ms cubic-bezier(.2,.75,.3,1);
}
.ss-portal-tiles.reduced .ss-portal-tile { transition: opacity 150ms linear; }
.ss-portal-tile.on { opacity: 1; transform: scale(1.02) rotate(0deg); }
```

Change the timing constants (lines 337-339):

```javascript
  var T_SWEEP = REDUCED_MOTION ? 0 : 150;     // stagger across the grid
  var T_TILE = REDUCED_MOTION ? 150 : 100;    // per-tile motion; MUST match the CSS duration above
  var T_HOLD = 67;                            // covered hold before reconstruct
```

Change the fly distance in `tileAway` (line 390). The prototype scales the 140px offset with tile size, `140 * (0.5 + 0.5 * 26/110)`:

```javascript
  function tileAway(t) {
    if (REDUCED_MOTION) { return 'none'; }
    return 'translate(' + (t.ux * 86.5) + 'px,' + (t.uy * 86.5) + 'px) scale(.25) rotate(' + t.spin + 'deg)';
  }
```

Update the comment above `tileAway` to note the 86.5px figure comes from the 26px target.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/portals-injection.test.ts > /tmp/t5.txt 2>&1; tail -30 /tmp/t5.txt`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/viewer-companion/portals.ts test/portals-injection.test.ts
git commit -m "feat(portals): retime the tile transition to the design's 0.75x playback"
```

---

### Task 6: Add the Defocus Dip cover

**Files:**
- Modify: `src/viewer-companion/portals.ts` — `companionStyle` (append), cover section head (`:329-352`), build gating (`:374-383`), drivers (`:393-441`), `transitionEnabled` (`:443-448`), idle disarm (`:483`), tick call site (`:1258`)
- Test: `test/portals-injection.test.ts`

**Interfaces:**
- Consumes: `PortalBundle.portals[].transition: PortalTransition` from Task 4
- Produces (all inside the injected runtime):
  - `transitionKind(portalIndex): 'none' | 'tiles' | 'defocus'` — replaces `transitionEnabled(portalIndex)`
  - `var coverKind` — the kind the in-flight crossing uses
  - `startTileDismantle()` / `startTileReconstruct()` / `clearTiles()` — the renamed existing tile bodies
  - `defocusLayer`, `startDefocusIn()`, `startDefocusOut()`, `clearDefocus()` — the new cover
  - `startDismantle()` / `startReconstruct()` / `clearCover()` — dispatchers on `coverKind`, still the only entry points `transDispatch` calls

**Two commits.** Steps 1-8 are a behaviour-neutral refactor that threads the cover kind through; steps 9-18 add the second cover and give the dispatchers their branches. The refactor lands on its own so it is bisectable, but the task is reviewed as one range — the dispatchers are branching by the time anyone reads them.

#### Commit 1 — thread the cover kind through the drivers

- [ ] **Step 1: Write the failing test**

In `test/portals-injection.test.ts`, add a new `it` block after the existing transition test:

```typescript
    it('resolves the cover kind per portal and defaults a legacy flag to tiles', () => {
        const out = buildPortalsInjection({
            portals: [
                { position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1, transition: 'none' },
                { position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 1, back: 0, transition: 'tiles' }
            ],
            portalScenes: ['', 'scenes/1/scene.sog'],
            portalStart: 0,
            portalCollision: [],
            portalEnvironments: ['indoor', 'indoor'],
            portalSceneLodCounts: [[1000], [1000]]
        });
        // the kinds reach the viewer payload verbatim
        expect(out).toContain('"transition":"none"');
        expect(out).toContain('"transition":"tiles"');
        // the runtime resolves them, and still honours the legacy boolean
        expect(out).toContain('function transitionKind(');
        expect(out).toContain("if (v === false || v === 'none') { return 'none'; }");
        // the in-flight crossing's cover is captured, not re-derived
        expect(out).toContain('var coverKind =');
        expect(out).not.toContain('function transitionEnabled(');
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/portals-injection.test.ts > /tmp/t6.txt 2>&1; tail -30 /tmp/t6.txt`
Expected: FAIL — `transitionKind` is not in the output

- [ ] **Step 3: Move and rewrite the kind resolver**

In `src/viewer-companion/portals.ts`, **delete** `transitionEnabled` from its current position (lines 443-448) and add this in its place at the top of the cover section, immediately after the `T_COVERED_MAX_FRAMES` line (~340), so the build gating below can call it:

```javascript
  // Which cover portal p wants. Payloads are normalized at export, so the
  // boolean branch only fires for a bundle produced by an older build.
  function transitionKind(portalIndex) {
    if (portalIndex === null || portalIndex === undefined) { return 'none'; }
    var p = data.portals[portalIndex];
    if (!p) { return 'none'; }
    var v = p.transition;
    if (v === false || v === 'none') { return 'none'; }
    if (v === 'defocus') { return 'defocus'; }
    return 'tiles';
  }

  // The cover the in-flight crossing is using. Captured when the reducer accepts
  // a crossing; the reducer only accepts while idle, so exactly one crossing is
  // ever in flight and this stays stable across its whole lifecycle.
  var coverKind = 'tiles';
```

- [ ] **Step 4: Rename the three tile drivers and add dispatchers**

Rename `startDismantle` → `startTileDismantle`, `startReconstruct` → `startTileReconstruct`, `clearCover` → `clearTiles`. Leave every line of their bodies untouched. Then add the three dispatchers immediately after `clearTiles`:

```javascript
  // Cover-kind dispatchers. transDispatch only ever calls these three; each
  // cover owns its own timing and its own coverTimer usage.
  function startDismantle() { startTileDismantle(); }
  function startReconstruct() { startTileReconstruct(); }
  function clearCover() { clearTiles(); }
```

(Step 14 adds the `coverKind === 'defocus'` branches. Keeping them trivial in this commit is what makes it a pure, verifiable rename.)

- [ ] **Step 5: Update the build gating**

Replace the `wantsTransition` block (lines 379-383) with:

```javascript
  var wantsTiles = data.portals.some(function (p, i) { return transitionKind(i) === 'tiles'; });
  if (wantsTiles) { buildTiles(); }
  window.addEventListener('resize', function () {
    if (wantsTiles && transState.phase === 'idle') { buildTiles(); }
  });
```

Update the comment block above it (lines 374-378) to say the grid is built only when at least one portal asks for the **tile** cover, and that `transitionKind` returning `'none'` or `'defocus'` for every portal leaves `tiles` empty and unreferenced.

- [ ] **Step 6: Update the tick call site**

In `tick()` (~line 1254), the block that begins `if (next !== activeIndex && next !== null) {`. Add the kind lookup as its first statement and use it in both places:

```javascript
          if (next !== activeIndex && next !== null) {
            var kind = transitionKind(cr.portalIndex);
            if (transState.phase === 'dismantling') {
              // Crossing already latched; the commit re-resolves it. Dispatching
              // now would switch the scene before the cover has closed.
            } else if (transState.phase === 'idle' && kind !== 'none') {
              // Defer the switch: dismantle first, commit when covered.
              coverKind = kind;
              transDispatch({ type: 'crossing', target: next });
            } else {
```

Leave the long comment on the final `else` branch and its body exactly as they are.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/portals-injection.test.ts > /tmp/t6.txt 2>&1; tail -30 /tmp/t6.txt`
Expected: PASS — both the retiming test from Task 5 and the new cover-kind test

- [ ] **Step 8: Commit the refactor**

```bash
git add src/viewer-companion/portals.ts test/portals-injection.test.ts
git commit -m "refactor(portals): thread a per-crossing cover kind through the transition drivers"
```

#### Commit 2 — add the cover

- [ ] **Step 9: Write the failing test**

In `test/portals-injection.test.ts`, add after the cover-kind test:

```typescript
    it('ships the defocus cover with the design endpoints and curves', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1, transition: 'defocus' }],
            portalScenes: ['', 'scenes/1/scene.sog'],
            portalStart: 0,
            portalCollision: [],
            portalEnvironments: ['indoor', 'indoor'],
            portalSceneLodCounts: [[1000], [1000]]
        });
        expect(out).toContain('"transition":"defocus"');
        // CSS: one full-screen layer, blur + veil at the design's endpoints
        expect(out).toContain('.ss-portal-defocus');
        expect(out).toContain('blur(26px) saturate(.45)');
        expect(out).toContain('rgba(7,10,14,.9)');
        // both vendor prefixes ship, so Safari gets the effect
        expect(out).toContain('-webkit-backdrop-filter: blur(26px) saturate(.45)');
        // timing: 213ms cubicIn in, 373ms quintOut out
        expect(out).toContain('var T_DEFOCUS_IN = REDUCED_MOTION ? 150 : 213;');
        expect(out).toContain('var T_DEFOCUS_OUT = REDUCED_MOTION ? 150 : 373;');
        expect(out).toContain('cubic-bezier(.32,0,.67,0)');
        expect(out).toContain('cubic-bezier(.22,1,.36,1)');
        // the dispatchers route to it
        expect(out).toContain("if (coverKind === 'defocus') { startDefocusIn(); }");
        expect(out).toContain("if (coverKind === 'defocus') { startDefocusOut(); }");
        expect(out).toContain("if (coverKind === 'defocus') { clearDefocus(); }");
    });
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npx vitest run test/portals-injection.test.ts > /tmp/t7.txt 2>&1; tail -30 /tmp/t7.txt`
Expected: FAIL — `.ss-portal-defocus` is not in the output

- [ ] **Step 11: Add the CSS**

Append to the `companionStyle` template literal in `src/viewer-companion/portals.ts`, after the `.ss-portal-tile.on` rule and before the closing backtick.

Two structural points, both load-bearing:
1. The idle state uses `backdrop-filter: none`, not `blur(0px)`. A non-`none` backdrop-filter creates a permanent stacking context and can promote a compositor layer even at zero blur; `.armed` installs `blur(0px)` one flush before `.on` is added, so the transition still has a numeric start value.
2. `background-color` and `backdrop-filter` are listed in one `transition-property` so both ride the same curve — the prototype locks blur and dim to a single curve deliberately, so it reads as one physical action.

```css
.ss-portal-defocus {
  position: fixed; inset: 0; z-index: 1999; pointer-events: none;
  visibility: hidden;
  background-color: rgba(7,10,14,0);
  -webkit-backdrop-filter: none; backdrop-filter: none;
  transition-property: background-color, -webkit-backdrop-filter, backdrop-filter;
  transition-duration: 213ms;
  transition-timing-function: cubic-bezier(.32,0,.67,0);
}
.ss-portal-defocus.armed {
  visibility: visible; will-change: backdrop-filter, background-color;
  -webkit-backdrop-filter: blur(0px) saturate(1); backdrop-filter: blur(0px) saturate(1);
}
.ss-portal-defocus.armed.on {
  background-color: rgba(7,10,14,.9);
  -webkit-backdrop-filter: blur(26px) saturate(.45); backdrop-filter: blur(26px) saturate(.45);
}
.ss-portal-defocus.reduced.armed, .ss-portal-defocus.reduced.armed.on {
  -webkit-backdrop-filter: none; backdrop-filter: none;
}
```

- [ ] **Step 12: Add the constants and the element**

In the cover section, after the `T_HOLD` line, add:

```javascript
  var T_DEFOCUS_IN = REDUCED_MOTION ? 150 : 213;    // cubicIn dismantle
  var T_DEFOCUS_OUT = REDUCED_MOTION ? 150 : 373;   // quintOut reconstruct
  var DEFOCUS_IN_EASE = REDUCED_MOTION ? 'linear' : 'cubic-bezier(.32,0,.67,0)';
  var DEFOCUS_OUT_EASE = REDUCED_MOTION ? 'linear' : 'cubic-bezier(.22,1,.36,1)';
```

After the `tileLayer` declaration, add:

```javascript
  // Defocus cover: one full-screen layer whose backdrop blur and veil ramp on a
  // single curve. No grid, no portal origin -- the whole frame dips. Mounted
  // unconditionally like the tile layer: idle it is one hidden div with no
  // filter and no children, so an unused cover costs nothing.
  var defocusLayer = document.createElement('div');
  defocusLayer.className = 'ss-portal-defocus' + (REDUCED_MOTION ? ' reduced' : '');
```

Rename the mount function to `mountCovers` and append both layers. Update both of its call sites on the line below it:

```javascript
  function mountCovers() { document.body.appendChild(tileLayer); document.body.appendChild(defocusLayer); }
  if (document.body) { mountCovers(); } else { document.addEventListener('DOMContentLoaded', mountCovers); }
```

- [ ] **Step 13: Add the three defocus drivers**

Immediately after `clearTiles`, before the dispatchers:

```javascript
  // Dismantle: 0 -> 1 on cubicIn. The zero-duration flush pins blur(0px) as the
  // transition's start value (armed installs it) so the ramp has a numeric
  // origin rather than interpolating out of 'none'.
  function startDefocusIn() {
    defocusLayer.classList.add('armed');
    defocusLayer.style.transitionDuration = '0ms';
    defocusLayer.classList.remove('on');
    void defocusLayer.offsetWidth;
    defocusLayer.style.transitionDuration = T_DEFOCUS_IN + 'ms';
    defocusLayer.style.transitionTimingFunction = DEFOCUS_IN_EASE;
    defocusLayer.classList.add('on');
    if (coverTimer) { clearTimeout(coverTimer); }
    coverTimer = setTimeout(onCoverComplete, T_DEFOCUS_IN);
  }

  // Reconstruct: transitioning the same properties back to their base values on
  // an ease-out curve IS the prototype's c = 1 - quintOut(p). No rAF needed.
  function startDefocusOut() {
    if (coverTimer) { clearTimeout(coverTimer); }
    coverTimer = setTimeout(function () {
      defocusLayer.style.transitionDuration = T_DEFOCUS_OUT + 'ms';
      defocusLayer.style.transitionTimingFunction = DEFOCUS_OUT_EASE;
      defocusLayer.classList.remove('on');
      coverTimer = setTimeout(function () { transDispatch({ type: 'done' }); }, T_DEFOCUS_OUT);
    }, T_HOLD);
  }

  function clearDefocus() {
    if (coverTimer) { clearTimeout(coverTimer); coverTimer = null; }
    defocusLayer.style.transitionDuration = '0ms';
    defocusLayer.classList.remove('on');
    void defocusLayer.offsetWidth;
    defocusLayer.style.transitionDuration = '';
    defocusLayer.style.transitionTimingFunction = '';
    defocusLayer.classList.remove('armed');
  }
```

- [ ] **Step 14: Route the dispatchers**

Replace the three trivial dispatchers from Step 4 with:

```javascript
  function startDismantle() {
    if (coverKind === 'defocus') { startDefocusIn(); } else { startTileDismantle(); }
  }
  function startReconstruct() {
    if (coverKind === 'defocus') { startDefocusOut(); } else { startTileReconstruct(); }
  }
  function clearCover() {
    if (coverKind === 'defocus') { clearDefocus(); } else { clearTiles(); }
  }
```

- [ ] **Step 15: Disarm both layers when the machine returns to idle**

In `transDispatch`, replace the final line:

```javascript
    if (transState.phase === 'idle' && a.cover !== 'dismantle') {
      tileLayer.classList.remove('armed');
      defocusLayer.classList.remove('armed');
    }
```

- [ ] **Step 16: Run tests to verify they pass**

Run: `npx vitest run test/portals-injection.test.ts > /tmp/t7.txt 2>&1; tail -30 /tmp/t7.txt`
Expected: PASS

- [ ] **Step 17: Run the whole suite**

Run: `npm run test > /tmp/t7all.txt 2>&1; tail -30 /tmp/t7all.txt`
Expected: all green

- [ ] **Step 18: Commit the cover**

```bash
git add src/viewer-companion/portals.ts test/portals-injection.test.ts
git commit -m "feat(portals): add the Defocus Dip transition cover to the exported viewer"
```

---

### Task 7: Replace the toggle button with the dropdown

**Files:**
- Modify: `src/tools/portal-tool.ts:63-64` (button), `:94` (bar order), `:167-179` (handler), `:245-246` (refresh)
- Modify: `static/locales/{de,en,es,fr,ja,ko,pt-BR,ru,zh-CN}.json`

**Interfaces:**
- Consumes: `PortalData.transition?: PortalTransition` (Task 3), `normalizePortalTransition` (Task 1), the existing `UpdatePortalOp` and `group()` helper
- Produces: nothing consumed by other tasks

This task has no unit test — there is no PCUI test harness in this repo, and every other control in this bar is likewise verified by hand. Step 6 is the verification.

- [ ] **Step 1: Add the locale strings**

Add three keys to each of the nine files in `static/locales/`, immediately after the existing `portals.transition.tooltip` line, matching the surrounding indentation and trailing-comma style:

```
en:     "portals.transition.none": "None",      "portals.transition.tiles": "Tiles",     "portals.transition.defocus": "Defocus Dip"
fr:     "portals.transition.none": "Aucune",    "portals.transition.tiles": "Tuiles",    "portals.transition.defocus": "Flou progressif"
de:     "portals.transition.none": "Keiner",    "portals.transition.tiles": "Kacheln",   "portals.transition.defocus": "Weichzeichnen"
es:     "portals.transition.none": "Ninguna",   "portals.transition.tiles": "Mosaico",   "portals.transition.defocus": "Desenfoque"
pt-BR:  "portals.transition.none": "Nenhuma",   "portals.transition.tiles": "Mosaico",   "portals.transition.defocus": "Desfoque"
ru:     "portals.transition.none": "Нет",       "portals.transition.tiles": "Плитки",    "portals.transition.defocus": "Расфокусировка"
ja:     "portals.transition.none": "なし",       "portals.transition.tiles": "タイル",      "portals.transition.defocus": "デフォーカス"
ko:     "portals.transition.none": "없음",       "portals.transition.tiles": "타일",       "portals.transition.defocus": "디포커스"
zh-CN:  "portals.transition.none": "无",         "portals.transition.tiles": "瓦片",       "portals.transition.defocus": "失焦"
```

The eight non-English sets are machine-assisted and must be listed as PENDING REVIEW in the hand-off note (Task 8, Step 5).

- [ ] **Step 2: Replace the button with the dropdown**

In `src/tools/portal-tool.ts`, delete the two `transitionButton` lines (63-64) and put in their place:

```typescript
        const transitionLabel = new Label({ text: i18n.t('portals.transition') });
        const transitionInput = new SelectInput({
            type: 'string',
            options: [
                { v: 'none', t: i18n.t('portals.transition.none') },
                { v: 'tiles', t: i18n.t('portals.transition.tiles') },
                { v: 'defocus', t: i18n.t('portals.transition.defocus') }
            ],
            width: 140
        });
        transitionInput.dom.title = i18n.t('portals.transition.tooltip');
```

Add the import for the normalizer, matching the file's existing import block style:

```typescript
import { normalizePortalTransition, PortalTransition } from '../portal-transition';
```

Replace `bar.append(transitionButton);` (line 94) with:

```typescript
        bar.append(group(transitionLabel, transitionInput));
```

Note `group()` is declared just below, at line 85. `bar.append(...)` calls already run after it, so this is safe.

- [ ] **Step 3: Replace the pointerdown handler with a change handler**

Delete the whole `transitionButton.dom.addEventListener('pointerdown', ...)` block including its four-line comment (lines 167-179). Add this instead, alongside the other `on('change')` handlers (after the `startInput.on('change', ...)` block, ~line 292):

```typescript
        transitionInput.on('change', (v: PortalTransition) => {
            if (suppress) {
                return;
            }
            const z = selected();
            if (!z || normalizePortalTransition(z.transition) === v) {
                return;
            }
            events.fire('edit.add', new UpdatePortalOp(events, z.id, { transition: z.transition }, { transition: v }));
        });
```

The undo value is the raw stored field, which may be `undefined` — the same convention `frontInput` / `backInput` / the bounds edges already use.

- [ ] **Step 4: Update refreshBar**

Replace the two `transitionButton` lines (245-246) with:

```typescript
            transitionInput.enabled = !!z;
            if (z) {
                transitionInput.value = normalizePortalTransition(z.transition);
            }
```

This sits inside the existing `suppress = true` window, so setting `.value` will not re-enter the change handler.

- [ ] **Step 5: Lint and type-check**

Run: `npm run lint > /tmp/t8lint.txt 2>&1; tail -20 /tmp/t8lint.txt`
Expected: exit 0, no errors. Do **not** apply an import-order autofix if one is suggested.

Run: `npm run build > /tmp/t8build.txt 2>&1; echo "exit=$?"; grep -c "plugin typescript" /tmp/t8build.txt`

Expected: `exit=0` **and a grep count of 0**.

`@rollup/plugin-typescript` reports type errors as *warnings*, so `npm run build` exits 0 even when the type-check fails — the exit code alone is not a gate. Before this task there are exactly six such warnings (three unique, each emitted once per rollup output), all in `src/tools/portal-tool.ts` at lines 177, 178 and 246: two `TS2367` "types 'string' and 'boolean' have no overlap" and one `TS2322` "Type 'false' is not assignable to type 'PortalTransition'". Those three lines are precisely the ones this task replaces, so all six must be gone when you are done.

If a *new* TypeScript error appears, it most likely means `SelectInput`'s `type: 'string'` value typing needs the handler parameter widened — cast at the call site rather than loosening `PortalData`.

- [ ] **Step 6: Verify by hand**

Run: `npm run develop` and open http://localhost:3333

Check, in order:
1. Load two splats, activate the portal tool, add a portal. The bar shows `Transition [ Tiles ▾ ]` between the bounds button and Width.
2. The dropdown is disabled with no portal selected, enabled with one.
3. Switch it to `None`, then `Defocus Dip`. Ctrl+Z twice walks back through `None` to `Tiles`; Ctrl+Y walks forward.
4. Save the project, reload it, reopen the portal — the dropdown still reads `Defocus Dip`.
5. Load a project saved before this change that had the transition disabled — the dropdown reads `None`.
6. `?lng=fr` shows the localized option labels.

- [ ] **Step 7: Commit**

```bash
git add src/tools/portal-tool.ts static/locales
git commit -m "feat(portals): replace the transition toggle with a three-way dropdown"
```

---

### Task 8: Full verification and hand-off

**Files:**
- Create: `docs/superpowers/2026-08-06-portal-transition-dropdown-handoff.md`

**Interfaces:**
- Consumes: everything above
- Produces: the E2E checklist and the translation-review list

- [ ] **Step 1: Run the full suite and the linter**

Run: `npm run test > /tmp/t9test.txt 2>&1; tail -40 /tmp/t9test.txt`
Expected: all green.

Run: `npm run lint > /tmp/t9lint.txt 2>&1; tail -20 /tmp/t9lint.txt`
Expected: exit 0.

- [ ] **Step 2: Build a RELEASE bundle**

Run: `npm run build > /tmp/t9build.txt 2>&1; echo "exit=$?"; grep -c "plugin typescript" /tmp/t9build.txt`
Expected: `exit=0` and a grep count of **0**. As in Task 7, the exit code alone is not a gate — `@rollup/plugin-typescript` downgrades type errors to warnings, so the grep is what proves the type-check is clean.

Release is the build type that matters here: the companion runtime's helpers are stringified, and only a minified build proves the stringified functions survive terser intact. A debug build passing is not evidence.

- [ ] **Step 3: Export a two-scene portal ZIP and grep the viewer HTML**

From the editor (`npm run develop`), export a portal bundle with one portal set to `Tiles` and, if the scene has two portals, a second set to `Defocus Dip`. Unzip and inspect `index.html`:

```bash
grep -o 'ss-portal-defocus' index.html | head -1
grep -o '"transition":"[a-z]*"' index.html
grep -o 'blur(26px) saturate(.45)' index.html | head -1
```

Expected: the class ships, the payload carries the chosen kinds, the blur endpoint is intact and not mangled by minification.

- [ ] **Step 4: E2E the exported viewer**

Open the exported `index.html` and walk through each portal:

| check | expected |
| --- | --- |
| `Tiles` portal, desktop | ~1170 tiles fly in edges→centre in ~250ms, scene swaps, tiles fly out centre→edges. Noticeably snappier than before, and the tiles are much finer. |
| `Defocus` portal, desktop | whole frame blurs and darkens in 213ms, swaps, comes back over 373ms. No grid visible. |
| `None` portal | instant switch, no cover at all |
| walk back mid-dismantle | cover reopens on the original scene, no swap |
| reset (R) during a crossing | cover clears immediately, no stuck overlay |
| a cold streaming scene | the loading overlay appears above the cover; the cover does not reconstruct until the scene is shown |
| **Android phone** | **both covers, especially Defocus.** `backdrop-filter` over the WebGL canvas is the one genuine unknown in this change: it forces the compositor to snapshot the canvas backdrop for ~590ms per crossing. Watch for dropped frames, a black frame, or context loss. |
| iOS Safari | Defocus renders blurred (the `-webkit-` prefix is what carries it) |
| reduced motion (OS setting on) | both covers become plain cross-fades, no tile motion, no blur |

If Android shows a problem with Defocus, the fallback is documented in the spec: the tile cover is the safe default and Defocus is opt-in per portal, so nothing needs reverting — record the finding in the hand-off note.

- [ ] **Step 5: Write the hand-off note**

Create `docs/superpowers/2026-08-06-portal-transition-dropdown-handoff.md` recording:
- what shipped, with the final timings and grid numbers
- E2E results per row of the table above, including the Android verdict
- **PENDING REVIEW: the 24 machine-assisted locale strings** (8 locales × 3 keys) added in Task 8, listed verbatim so they can be reviewed in one pass
- anything deferred

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/2026-08-06-portal-transition-dropdown-handoff.md
git commit -m "docs(portals): hand-off note for the transition dropdown"
```

---

## Done when

- `npm run test` and `npm run lint` are green, and `npm run build` (release) succeeds.
- The portal bar shows a three-way dropdown; the choice survives save/reload and is undoable.
- A pre-change project with the transition disabled loads as `None`; one that never touched the field loads as `Tiles` and re-saves without gaining the field.
- The exported viewer plays the retimed 26px tile cover and the new Defocus Dip cover per portal, and neither for `None`.
- The Android `backdrop-filter` result is recorded in the hand-off note either way.
