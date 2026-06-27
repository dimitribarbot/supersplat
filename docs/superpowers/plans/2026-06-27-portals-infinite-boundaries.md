# Portal Infinite (Extendable) Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an author mark individual edges (top/right/bottom/left) of a portal quad as "infinite" so a camera crossing the portal's plane past that edge still triggers a scene swap, in both the editor walkthrough and the exported viewer.

**Architecture:** A new optional `infinite` field rides on every portal-shaped type. The single pure crossing function `segmentCrossesRect` (shared by the editor runtime, the baked animation timeline, and the stringified exported-viewer companion) relaxes its bounds check per-edge. The editor gains a toolbar button that opens a cross-layout popup of four toggles plus SVG arrow icons on the selected portal's infinite edges. No runtime wiring changes — once `infinite` is on the rects, every consumer honors it for free.

**Tech Stack:** TypeScript, PlayCanvas, @playcanvas/pcui, Vitest, Rollup, SCSS, i18next.

## Global Constraints

- Local frame: portal local **+X = right, −X = left, +Y = top, −Y = bottom**, normal = local Z (front +Z, back −Z). Same frame as `width`/`height`, the gizmo, and `CORNERS` in `portal-shape.ts`.
- `infinite` shape is exactly `{ top: boolean, right: boolean, bottom: boolean, left: boolean }`; optional/absent = no edges infinite (must behave identically to today).
- The portal's center, gizmo, and visible quad must NOT move or resize — only the crossing test relaxes.
- `segmentCrossesRect` is stringified verbatim into the exported viewer (`segmentCrossesRect.toString()`), so it must stay self-contained (no external references) and read `infinite` only off its `rect` parameter.
- Prefer Bash (Git Bash) for git/npm. Do not run `cd`/`git -C`/`npm --prefix` pointing at the cwd. Commit messages end with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.
- Run from repo root: tests `npm test`, build `npm run build`, lint `npm run lint`.
- Work happens on branch `feat/portal-infinite-boundaries` (already created; the design doc is already committed there).

---

### Task 1: Relax the crossing math (`portal-geom.ts`)

**Files:**
- Modify: `src/portal-geom.ts` (type `PortalRect` lines 4-11; bounds check lines 51-55; exports line 91)
- Test: `test/portal-geom.test.ts`

**Interfaces:**
- Produces: `type InfiniteEdges = { top: boolean, right: boolean, bottom: boolean, left: boolean }` (exported); `PortalRect` gains `infinite?: InfiniteEdges`. `segmentCrossesRect(prev, cur, rect)` signature unchanged; behavior relaxes per-edge.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('segmentCrossesRect', ...)` block in `test/portal-geom.test.ts` (before its closing `});` on line 45):

```ts
    it('a crossing past the right edge counts only when right is infinite', () => {
        // pierce at ix = +10, well past hw = 2
        expect(segmentCrossesRect([10, 0, -1], [10, 0, 1], rect())).toBeNull();
        const r = rect({ infinite: { top: false, right: true, bottom: false, left: false } });
        expect(segmentCrossesRect([10, 0, -1], [10, 0, 1], r)).toEqual({ side: 'front', t: 0.5 });
    });

    it('right-infinite does not extend the opposite (left) edge', () => {
        const r = rect({ infinite: { top: false, right: true, bottom: false, left: false } });
        expect(segmentCrossesRect([-10, 0, -1], [-10, 0, 1], r)).toBeNull();
    });

    it('top and bottom infinite extend the vertical edges independently', () => {
        const top = rect({ infinite: { top: true, right: false, bottom: false, left: false } });
        expect(segmentCrossesRect([0, 10, -1], [0, 10, 1], top)).not.toBeNull();
        expect(segmentCrossesRect([0, -10, -1], [0, -10, 1], top)).toBeNull();
        const bottom = rect({ infinite: { top: false, right: false, bottom: true, left: false } });
        expect(segmentCrossesRect([0, -10, -1], [0, -10, 1], bottom)).not.toBeNull();
    });

    it('all-four infinite acts as the full splitting plane', () => {
        const all = rect({ infinite: { top: true, right: true, bottom: true, left: true } });
        expect(segmentCrossesRect([100, -100, -1], [100, -100, 1], all)).toEqual({ side: 'front', t: 0.5 });
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- portal-geom`
Expected: FAIL — the four new tests fail (the far-off crossings currently return `null` even when `infinite` is set; TypeScript also errors that `infinite` is not on `PortalRect`).

- [ ] **Step 3: Add the type and relax the bounds check**

In `src/portal-geom.ts`, add the type just above `type PortalRect` (after line 2):

```ts
type InfiniteEdges = { top: boolean, right: boolean, bottom: boolean, left: boolean };
```

Add the field to `PortalRect` (inside the type, after the `backUid` line):

```ts
    backUid: number | null,   // scene on the local -Z side
    infinite?: InfiniteEdges  // edges extended to the scene boundary (absent = none)
```

Replace the current bounds check (lines 51-55):

```ts
    const ix = a[0] + t * (b[0] - a[0]);
    const iy = a[1] + t * (b[1] - a[1]);
    if (Math.abs(ix) > hw || Math.abs(iy) > hh) {
        return null;
    }
```

with the per-edge relaxation:

```ts
    const ix = a[0] + t * (b[0] - a[0]);
    const iy = a[1] + t * (b[1] - a[1]);
    // Per-edge bounds: an edge flagged `infinite` extends to the scene boundary,
    // so a crossing past that edge still counts. With no flags this is identical
    // to the original |ix| <= hw && |iy| <= hh test.
    const inf = rect.infinite;
    if (ix > hw && !(inf && inf.right)) return null;
    if (ix < -hw && !(inf && inf.left)) return null;
    if (iy > hh && !(inf && inf.top)) return null;
    if (iy < -hh && !(inf && inf.bottom)) return null;
```

Update the export line (currently `export { segmentCrossesRect, resolveActiveSplat, PortalRect, Vec3, Quat };`) to add the new type:

```ts
export { segmentCrossesRect, resolveActiveSplat, PortalRect, InfiniteEdges, Vec3, Quat };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- portal-geom`
Expected: PASS — all `segmentCrossesRect` and `resolveActiveSplat` tests green (the original outside-extents test on line 27 still passes because its `rect()` has no `infinite`).

- [ ] **Step 5: Commit**

```bash
git add src/portal-geom.ts test/portal-geom.test.ts
git commit -m "feat(portals): per-edge infinite crossing in segmentCrossesRect

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Persist `infinite` on portal records (`portals.ts`)

**Files:**
- Modify: `src/portals.ts` (import line 1; `PortalData` type lines 7-15; `portals.export` lines 219-226; `docSerialize.portals` lines 229-237; `docDeserialize.portals` push lines 255-263)
- Test: `test/portals.test.ts`

**Interfaces:**
- Consumes: `InfiniteEdges` from `./portal-geom` (Task 1).
- Produces: `PortalData` gains `infinite?: InfiniteEdges`; `portals.export`, `docSerialize.portals` each emit `infinite`; `docDeserialize.portals` restores it.

- [ ] **Step 1: Write the failing tests**

Append two tests inside the `describe('portals events', ...)` block in `test/portals.test.ts` (before its closing `});` on line 89):

```ts
    it('round-trips the infinite-edges flags through serialize/deserialize', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        const inf = { top: true, right: false, bottom: false, left: true };
        new AddPortalOp(events, portal({ id: 'portal_0', infinite: inf })).do();
        const serialized = events.invoke('docSerialize.portals');
        expect(serialized[0].infinite).toEqual(inf);

        const events2 = makeEvents();
        registerPortalsEvents(events2);
        events2.invoke('docDeserialize.portals', serialized, null);
        expect((events2.invoke('portals.list') as PortalData[])[0].infinite).toEqual(inf);
    });

    it('portals.export includes the infinite-edges flags', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        const inf = { top: false, right: true, bottom: false, left: false };
        new AddPortalOp(events, portal({ infinite: inf })).do();
        expect((events.invoke('portals.export') as any[])[0].infinite).toEqual(inf);
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- portals.test`
Expected: FAIL — `serialized[0].infinite` / exported `infinite` are `undefined` (and TypeScript errors that `infinite` is not on `PortalData`).

- [ ] **Step 3: Add the field and thread it through**

In `src/portals.ts`, update the import on line 1:

```ts
import { Events } from './events';
import { InfiniteEdges } from './portal-geom';
```

Add the field to `PortalData` (after the `backUid` line in the type):

```ts
    frontUid: number | null,
    backUid: number | null,
    infinite?: InfiniteEdges
};
```

In `portals.export` (lines 219-226), add `infinite` to the mapped object:

```ts
    events.function('portals.export', () => portals.map(p => ({
        position: [p.position[0], p.position[1], p.position[2]],
        rotation: [p.rotation[0], p.rotation[1], p.rotation[2], p.rotation[3]],
        width: p.width,
        height: p.height,
        frontUid: p.frontUid,
        backUid: p.backUid,
        infinite: p.infinite
    })));
```

In `docSerialize.portals` (lines 229-237), add `infinite` to the mapped object:

```ts
    events.function('docSerialize.portals', (): PortalData[] => portals.map(p => ({
        id: p.id,
        position: [p.position[0], p.position[1], p.position[2]],
        rotation: [p.rotation[0], p.rotation[1], p.rotation[2], p.rotation[3]],
        width: p.width,
        height: p.height,
        frontUid: p.frontUid,
        backUid: p.backUid,
        infinite: p.infinite
    })));
```

In `docDeserialize.portals`, add `infinite` to the pushed object (in the `data.forEach` block, after the `backUid` line):

```ts
                portals.push({
                    id: d.id ?? genId(),
                    position: d.position,
                    rotation: d.rotation ?? [0, 0, 0, 1],
                    width: d.width ?? 1,
                    height: d.height ?? 1,
                    frontUid: d.frontUid ?? null,
                    backUid: d.backUid ?? null,
                    infinite: d.infinite
                });
```

(Note: `infinite: d.infinite` is `undefined` when absent. Vitest `toEqual` ignores `undefined` properties, so the existing "deserialize fills missing defaults" test on line 84 still passes.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- portals.test`
Expected: PASS — all `portals events` and `portal entrypoints` tests green.

- [ ] **Step 5: Commit**

```bash
git add src/portals.ts test/portals.test.ts
git commit -m "feat(portals): persist infinite-edge flags on portal records

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Carry `infinite` into the export bundle (`portal-export.ts`, `splat-serialize.ts`)

**Files:**
- Modify: `src/portal-export.ts` (imports top of file; `ExportPortal` type lines 10-17; `PortalBundle.portals` shape line 21; `rewritten` map lines 66-73)
- Modify: `src/splat-serialize.ts` (`ExperienceSettings.portals` type line 130) — type-only
- Test: `test/portal-export.test.ts`

**Interfaces:**
- Consumes: `InfiniteEdges` from `./portal-geom`; `portals.export` objects now carry `infinite` (Task 2).
- Produces: `ExportPortal` and `PortalBundle.portals[]` gain `infinite?: InfiniteEdges`; `buildPortalBundle` copies it onto each rewritten portal. The exported viewer settings (`ExperienceSettings.portals`) carry `infinite` through `bundle.portals` (assigned at `export-popup.ts:748` and `s3-publish-dialog.ts:243`).

- [ ] **Step 1: Write the failing test**

Append inside the `describe('buildPortalBundle', ...)` block in `test/portal-export.test.ts` (before its closing `});` on line 80):

```ts
    it('carries the infinite-edges flags onto the rewritten portals', () => {
        const inf = { top: false, right: true, bottom: false, left: false };
        const b = buildPortalBundle({
            portals: [{ ...portal(10, 20), infinite: inf }],
            startUid: 10, availableUids: [10, 20], streaming: false, collision: false
        })!;
        expect(b.portals[0].infinite).toEqual(inf);
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- portal-export`
Expected: FAIL — `b.portals[0].infinite` is `undefined` (and TypeScript errors that `infinite` is not on the `ExportPortal` input).

- [ ] **Step 3: Thread `infinite` through the bundle types and rewrite**

In `src/portal-export.ts`, add an import at the very top of the file (above the `type Vec3` lines):

```ts
import { InfiniteEdges } from './portal-geom';
```

Add the field to `ExportPortal` (after the `backUid` line):

```ts
    frontUid: number | null,
    backUid: number | null,
    infinite?: InfiniteEdges
};
```

Add the field to the `PortalBundle.portals` array shape (line 21):

```ts
    portals: { position: Vec3, rotation: Quat, width: number, height: number, front: number | null, back: number | null, infinite?: InfiniteEdges }[];
```

Add `infinite` to the `rewritten` map (lines 66-73):

```ts
    const rewritten = portals.map(p => ({
        position: [p.position[0], p.position[1], p.position[2]] as Vec3,
        rotation: [p.rotation[0], p.rotation[1], p.rotation[2], p.rotation[3]] as Quat,
        width: p.width,
        height: p.height,
        front: indexOf(p.frontUid),
        back: indexOf(p.backUid),
        infinite: p.infinite
    }));
```

In `src/splat-serialize.ts`, update the `ExperienceSettings.portals` type (line 130) to include `infinite`:

```ts
    portals?: { position: [number, number, number], rotation: [number, number, number, number], width: number, height: number, front: number | null, back: number | null, infinite?: { top: boolean, right: boolean, bottom: boolean, left: boolean } }[],
```

- [ ] **Step 4: Run the test + typecheck**

Run: `npm test -- portal-export`
Expected: PASS — all `buildPortalBundle`, `resolveCollisionSeed`, `resolvePortalExtras`, `collisionSeedTuple` tests green.

- [ ] **Step 5: Commit**

```bash
git add src/portal-export.ts src/splat-serialize.ts test/portal-export.test.ts
git commit -m "feat(portals): carry infinite-edge flags into the export bundle

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Thread `infinite` into runtime/timeline/viewer rects

**Files:**
- Modify: `src/portals-runtime.ts` (`buildRects` map lines 31-38)
- Modify: `src/viewer-companion/portals.ts` (runtime `rects` map lines 184-186; `buildPortalsInjection` `portalRects` map lines 445-452)
- Test: `test/portal-anim-timeline.test.ts`

**Interfaces:**
- Consumes: `PortalRect.infinite` (Task 1); `portals.list` / payload `portals[]` objects carrying `infinite` (Tasks 2-3).
- Produces: every `PortalRect` built for the editor walkthrough, the baked anim timeline, and the exported-viewer runtime carries `infinite`, so `segmentCrossesRect` honors it in all three.

- [ ] **Step 1: Write the failing test**

Append inside the `describe('buildPortalAnimTimeline', ...)` block in `test/portal-anim-timeline.test.ts` (after the test on lines 40-46; place it before the next test or the block's closing `});`):

```ts
    it('honors an infinite right edge: a crossing past the edge registers', () => {
        // 10x10 portal at origin (hw = 5); path pierces the plane at x = 20 (past the right edge).
        const farTrack = track({
            keyframes: { times: [0, 30], values: { position: [20, 0, -5, 20, 0, 5], target: [0, 0, 0, 0, 0, 0], fov: [60, 60] } }
        });
        // finite portal: no crossing
        expect(buildPortalAnimTimeline(farTrack, [portal], 0)).toEqual([{ t: 0, scene: 0 }]);
        // right edge infinite: crossing into the front scene registers
        const offset: PortalRect = { ...portal, infinite: { top: false, right: true, bottom: false, left: false } };
        const tl = buildPortalAnimTimeline(farTrack, [offset], 0);
        expect(tl).toHaveLength(2);
        expect(tl[1].scene).toBe(1);
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- portal-anim-timeline`
Expected: FAIL — the infinite-edge timeline has length 1 (no crossing recorded) because the rects passed through do not yet carry `infinite`... actually here the test passes `offset` directly, so this test will PASS already for the timeline module (it consumes `PortalRect` directly). Confirm: if it PASSES, that proves the timeline core already honors `infinite` via Task 1 — keep the test as a regression guard and proceed to wire the three callers in Step 3 (which have no unit coverage). If it FAILS, Task 1 was not applied; stop and fix Task 1.

- [ ] **Step 3: Pass `infinite` through the three rect builders**

In `src/portals-runtime.ts`, `buildRects` (lines 31-38):

```ts
        return data.map(p => ({
            position: p.position,
            rotation: p.rotation,
            width: p.width,
            height: p.height,
            frontUid: p.frontUid,
            backUid: p.backUid,
            infinite: p.infinite
        }));
```

In `src/viewer-companion/portals.ts`, the runtime `rects` map (lines 184-186):

```ts
  var rects = data.portals.map(function (p) {
    return { position: p.position, rotation: p.rotation, width: p.width, height: p.height, frontUid: p.front, backUid: p.back, infinite: p.infinite };
  });
```

In `src/viewer-companion/portals.ts`, the `buildPortalsInjection` `portalRects` map (lines 445-452):

```ts
    const portalRects = portals.map((p: any) => ({
        position: p.position,
        rotation: p.rotation,
        width: p.width,
        height: p.height,
        frontUid: p.front,
        backUid: p.back,
        infinite: p.infinite
    }));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- portal-anim-timeline`
Expected: PASS — all `buildPortalAnimTimeline` tests green.

- [ ] **Step 5: Commit**

```bash
git add src/portals-runtime.ts src/viewer-companion/portals.ts test/portal-anim-timeline.test.ts
git commit -m "feat(portals): pass infinite-edge flags through runtime/timeline/viewer rects

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Localization keys (9 locale files)

**Files:**
- Modify: `static/locales/en.json` (after the `"portals.entrypoint.clear"` line)
- Modify: `static/locales/de.json`, `es.json`, `fr.json`, `ja.json`, `ko.json`, `pt-BR.json`, `ru.json`, `zh-CN.json`

**Interfaces:**
- Produces: localization keys `portals.bounds`, `portals.bounds.tooltip`, `portals.bounds.top|right|bottom|left` consumed by the toolbar UI (Tasks 6-7).

- [ ] **Step 1: Add the keys to `en.json`**

In `static/locales/en.json`, immediately after the `"portals.entrypoint.clear": "Clear",` line (line 82), add:

```json
    "portals.bounds": "Bounds",
    "portals.bounds.tooltip": "Extend portal edges to the scene boundary",
    "portals.bounds.top": "Top",
    "portals.bounds.right": "Right",
    "portals.bounds.bottom": "Bottom",
    "portals.bounds.left": "Left",
```

- [ ] **Step 2: Add the translated keys to the other 8 locales**

Add the same six keys (in the same place — after that file's `"portals.entrypoint.clear"` entry, matching its existing comma/format) to each file, using these translations:

`static/locales/de.json`:
```json
    "portals.bounds": "Grenzen",
    "portals.bounds.tooltip": "Portalkanten bis zur Szenengrenze erweitern",
    "portals.bounds.top": "Oben",
    "portals.bounds.right": "Rechts",
    "portals.bounds.bottom": "Unten",
    "portals.bounds.left": "Links",
```

`static/locales/es.json`:
```json
    "portals.bounds": "Límites",
    "portals.bounds.tooltip": "Extender los bordes del portal hasta el límite de la escena",
    "portals.bounds.top": "Arriba",
    "portals.bounds.right": "Derecha",
    "portals.bounds.bottom": "Abajo",
    "portals.bounds.left": "Izquierda",
```

`static/locales/fr.json`:
```json
    "portals.bounds": "Limites",
    "portals.bounds.tooltip": "Étendre les bords du portail jusqu'à la limite de la scène",
    "portals.bounds.top": "Haut",
    "portals.bounds.right": "Droite",
    "portals.bounds.bottom": "Bas",
    "portals.bounds.left": "Gauche",
```

`static/locales/ja.json`:
```json
    "portals.bounds": "境界",
    "portals.bounds.tooltip": "ポータルの端をシーンの境界まで拡張",
    "portals.bounds.top": "上",
    "portals.bounds.right": "右",
    "portals.bounds.bottom": "下",
    "portals.bounds.left": "左",
```

`static/locales/ko.json`:
```json
    "portals.bounds": "경계",
    "portals.bounds.tooltip": "포털 가장자리를 장면 경계까지 확장",
    "portals.bounds.top": "위",
    "portals.bounds.right": "오른쪽",
    "portals.bounds.bottom": "아래",
    "portals.bounds.left": "왼쪽",
```

`static/locales/pt-BR.json`:
```json
    "portals.bounds": "Limites",
    "portals.bounds.tooltip": "Estender as bordas do portal até o limite da cena",
    "portals.bounds.top": "Cima",
    "portals.bounds.right": "Direita",
    "portals.bounds.bottom": "Baixo",
    "portals.bounds.left": "Esquerda",
```

`static/locales/ru.json`:
```json
    "portals.bounds": "Границы",
    "portals.bounds.tooltip": "Расширить края портала до границы сцены",
    "portals.bounds.top": "Верх",
    "portals.bounds.right": "Право",
    "portals.bounds.bottom": "Низ",
    "portals.bounds.left": "Лево",
```

`static/locales/zh-CN.json`:
```json
    "portals.bounds": "边界",
    "portals.bounds.tooltip": "将传送门边缘扩展到场景边界",
    "portals.bounds.top": "上",
    "portals.bounds.right": "右",
    "portals.bounds.bottom": "下",
    "portals.bounds.left": "左",
```

- [ ] **Step 3: Verify the JSON is valid**

Run: `node -e "['de','en','es','fr','ja','ko','pt-BR','ru','zh-CN'].forEach(l=>{const o=require('./static/locales/'+l+'.json'); if(!o['portals.bounds.left']) throw new Error('missing key in '+l); }); console.log('locales ok')"`
Expected: prints `locales ok` (each file parses and contains the new keys).

- [ ] **Step 4: Commit**

```bash
git add static/locales/*.json
git commit -m "feat(portals): localization for infinite-bounds controls

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Toolbar button + cross-layout popup (`portal-tool.ts`, SCSS)

**Files:**
- Modify: `src/tools/portal-tool.ts` (bar setup ~lines 51-84; the existing `pointerdown` handler lines 506-510; `portals.selectionChanged` handler lines 587-592; `deactivate` lines 605-616)
- Create: `src/ui/scss/portal-bounds-popup.scss`
- Modify: `src/ui/scss/style.scss` (add `@use` after line 30)

**Interfaces:**
- Consumes: `UpdatePortalOp` (already imported), `PortalData.infinite` (Task 2), localization keys (Task 5), `events`, `selected()`, `active`, `canvasContainer`.
- Produces: `boundsButton` (toolbar), `boundsPopup` (cross-layout toggles), and the helpers `emptyEdges()`, `edgesOf(z)`, `refreshBoundsPopup()`, `toggleBoundsPopup(show?)` used by Task 7 and the in-scene icons. Toggling an edge fires an undoable `UpdatePortalOp` patching `infinite`.

- [ ] **Step 1: Add the SCSS and wire it in**

Create `src/ui/scss/portal-bounds-popup.scss`:

```scss
@use 'colors.scss' as *;

.portal-bounds-popup {
    position: absolute;
    transform: translate(-50%, 0);
    z-index: 100;
    padding: 8px;
    border-radius: 8px;
    background-color: $bcg-primary;

    display: grid;
    grid-template-columns: repeat(3, 36px);
    grid-template-rows: repeat(3, 36px);
    gap: 4px;

    &.pcui-hidden {
        display: none;
    }

    .portal-bounds-toggle {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 36px;
        min-width: 36px;
        padding: 0;
        border-radius: 2px;
        font-size: 18px;

        &.active {
            background-color: $clr-hilight !important;
        }
    }

    .portal-bounds-top { grid-column: 2; grid-row: 1; }
    .portal-bounds-left { grid-column: 1; grid-row: 2; }
    .portal-bounds-right { grid-column: 3; grid-row: 2; }
    .portal-bounds-bottom { grid-column: 2; grid-row: 3; }
}
```

In `src/ui/scss/style.scss`, after the `@use 'portal-entrypoint-overlay.scss';` line (line 30), add:

```scss
@use 'portal-bounds-popup.scss';
```

- [ ] **Step 2: Create the button, popup, and helpers in `portal-tool.ts`**

In `src/tools/portal-tool.ts`, after the `rotateButton` declaration (line 53), add the bounds button:

```ts
        const boundsButton = new Button({ text: '⤢', class: 'select-toolbar-button' });
        boundsButton.dom.title = localize('portals.bounds.tooltip');
```

After `bar.append(rotateButton);` (line 77), append the button:

```ts
        bar.append(boundsButton);
```

After the `canvasContainer.append(bar);` line (line 84), build the popup and helpers:

```ts
        // --- infinite-bounds popup (cross layout) ---
        const boundsPopup = new Container({ class: 'portal-bounds-popup', hidden: true });
        boundsPopup.dom.addEventListener('pointerdown', e => e.stopPropagation());
        const EDGE_DIRS = ['top', 'right', 'bottom', 'left'] as const;
        type EdgeDir = typeof EDGE_DIRS[number];
        const edgeGlyph: Record<EdgeDir, string> = { top: '↑', right: '→', bottom: '↓', left: '←' };
        const edgeButtons = {} as Record<EdgeDir, Button>;
        EDGE_DIRS.forEach((dir) => {
            const b = new Button({ text: edgeGlyph[dir], class: ['portal-bounds-toggle', `portal-bounds-${dir}`] });
            b.dom.title = localize(`portals.bounds.${dir}`);
            edgeButtons[dir] = b;
            boundsPopup.append(b);
        });
        canvasContainer.append(boundsPopup);

        const emptyEdges = () => ({ top: false, right: false, bottom: false, left: false });
        const edgesOf = (z: PortalData) => ({ ...emptyEdges(), ...(z.infinite ?? {}) });

        const refreshBoundsPopup = () => {
            const z = active ? selected() : null;
            boundsButton.enabled = !!z;
            if (!z) {
                boundsPopup.hidden = true;
                return;
            }
            const e = edgesOf(z);
            EDGE_DIRS.forEach(dir => edgeButtons[dir].class[e[dir] ? 'add' : 'remove']('active'));
        };

        const positionBoundsPopup = () => {
            const br = boundsButton.dom.getBoundingClientRect();
            const cr = canvasContainer.dom.getBoundingClientRect();
            boundsPopup.dom.style.left = `${br.left - cr.left + br.width / 2}px`;
            boundsPopup.dom.style.top = `${br.bottom - cr.top + 8}px`;
        };

        const toggleBoundsPopup = (show?: boolean) => {
            const next = typeof show === 'boolean' ? show : boundsPopup.hidden;
            if (next && active && selected()) {
                refreshBoundsPopup();
                positionBoundsPopup();
                boundsPopup.hidden = false;
            } else {
                boundsPopup.hidden = true;
            }
        };

        boundsButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            if (!active) return;
            toggleBoundsPopup();
        });

        EDGE_DIRS.forEach((dir) => {
            edgeButtons[dir].dom.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                const z = selected();
                if (!z) return;
                const oldEdges = edgesOf(z);
                const newEdges = { ...oldEdges, [dir]: !oldEdges[dir] };
                events.fire('edit.add', new UpdatePortalOp(events, z.id, { infinite: z.infinite }, { infinite: newEdges }));
            });
        });
```

- [ ] **Step 3: Refresh the popup on data/selection change and close it appropriately**

In `refreshBar()`, add a call to refresh the popup. Insert `refreshBoundsPopup();` just before the `suppress = false;` line near the end of `refreshBar` (line 148):

```ts
            entryClearButton.enabled = hasEp;
            entrySetButton.enabled = selectedEntryUid != null;
            refreshBoundsPopup();
            suppress = false;
            updateEntryGizmo();
```

In the existing canvas `pointerdown` handler (lines 506-510), close the popup on any canvas click outside it:

```ts
        const pointerdown = (e: PointerEvent) => {
            if (!boundsPopup.hidden) {
                toggleBoundsPopup(false);
            }
            if (!clicked && isPrimary(e)) {
                clicked = true;
            }
        };
```

In the `portals.selectionChanged` handler (lines 587-592), close the popup when the selection changes:

```ts
        events.on('portals.selectionChanged', () => {
            toggleBoundsPopup(false);
            syncShapes();
            refreshBar();
            updateGizmos();
            updateEntryGizmo();
        });
```

In `deactivate` (lines 605-616), hide the popup; add after `bar.hidden = true;`:

```ts
            bar.hidden = true;
            boundsPopup.hidden = true;
```

- [ ] **Step 4: Build and lint**

Run: `npm run build`
Expected: build succeeds (no TypeScript errors).

Run: `npm run lint`
Expected: no new lint errors in `src/tools/portal-tool.ts`.

- [ ] **Step 5: Manual smoke test**

Run the editor (`npm run develop` or the project's usual dev command). Activate the Portals tool, add a portal, select it. Verify:
- The bounds button (⤢) is enabled only when a portal is selected.
- Clicking it opens the cross-layout popup centered under the button; the four arrow toggles are laid out top/left/right/bottom.
- Toggling a direction highlights it (orange) and is undoable (Ctrl+Z restores the previous state; the toggle highlight follows).
- Clicking on the canvas (outside the popup) closes it; changing selection closes it.

- [ ] **Step 6: Commit**

```bash
git add src/tools/portal-tool.ts src/ui/scss/portal-bounds-popup.scss src/ui/scss/style.scss
git commit -m "feat(portals): toolbar button + cross-layout infinite-bounds popup

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: In-scene edge arrow icons (selected portal only)

**Files:**
- Modify: `src/tools/portal-tool.ts` (add a `postrender` overlay near the entrypoint overlay ~lines 340-406; `deactivate` lines 605-616; the `portals.changed` handler lines 581-586)

**Interfaces:**
- Consumes: `edgesOf(z)` / `emptyEdges()` (Task 6), `selected()`, `active`, `epNs`, `scene.camera.worldToScreen`, `canvasContainer`. `Vec3`, `Quat` are already imported from `playcanvas`.
- Produces: an SVG overlay (`edgeSvg`) drawn each frame that shows an outward arrow at each infinite edge of the selected portal.

- [ ] **Step 1: Add the edge-icon overlay and draw function**

In `src/tools/portal-tool.ts`, after the entrypoint overlay's `events.on('postrender', drawEntrypoints);` line (line 406), add:

```ts
        // --- infinite-edge arrow overlay (selected portal only). Reuses the
        //     entrypoint overlay's never-occluded SVG pattern: project each
        //     infinite edge's midpoint plus a point stepped outward, draw an
        //     arrow glyph at the midpoint rotated to point outward on screen. ---
        const edgeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        edgeSvg.classList.add('portal-entrypoint-overlay');
        edgeSvg.style.position = 'absolute';
        edgeSvg.style.inset = '0';
        edgeSvg.style.width = '100%';
        edgeSvg.style.height = '100%';
        edgeSvg.style.pointerEvents = 'none';
        canvasContainer.dom.appendChild(edgeSvg);
        const edgeArrows: SVGTextElement[] = [];
        const edgeQuat = new Quat();
        const edgePos = new Vec3();
        const edgeLocal = new Vec3();
        const edgeMidW = new Vec3();
        const edgeOutW = new Vec3();
        const edgeMidS = new Vec3();
        const edgeOutS = new Vec3();
        // unit edge midpoints in the portal's local XY frame (scaled by w/h below)
        const EDGE_MIDS: { dir: EdgeDir, x: number, y: number }[] = [
            { dir: 'top', x: 0, y: 0.5 },
            { dir: 'right', x: 0.5, y: 0 },
            { dir: 'bottom', x: 0, y: -0.5 },
            { dir: 'left', x: -0.5, y: 0 }
        ];

        const drawEdgeIcons = () => {
            const z = active ? selected() : null;
            const edges = z ? edgesOf(z) : emptyEdges();
            const dirs = EDGE_MIDS.filter(d => edges[d.dir]);
            while (edgeArrows.length < dirs.length) {
                const t = document.createElementNS(epNs, 'text') as SVGTextElement;
                t.setAttribute('fill', '#00ccff');
                t.setAttribute('stroke', '#003344');
                t.setAttribute('stroke-width', '0.5');
                t.setAttribute('font-size', '24');
                t.setAttribute('text-anchor', 'middle');
                t.setAttribute('dominant-baseline', 'central');
                t.textContent = '➜';
                edgeSvg.appendChild(t);
                edgeArrows.push(t);
            }
            while (edgeArrows.length > dirs.length) {
                edgeArrows.pop().remove();
            }
            if (!z) return;
            const cw = canvasContainer.dom.clientWidth;
            const ch = canvasContainer.dom.clientHeight;
            edgeQuat.set(z.rotation[0], z.rotation[1], z.rotation[2], z.rotation[3]);
            edgePos.set(z.position[0], z.position[1], z.position[2]);
            dirs.forEach((d, i) => {
                const t = edgeArrows[i];
                // midpoint world
                edgeLocal.set(d.x * z.width, d.y * z.height, 0);
                edgeQuat.transformVector(edgeLocal, edgeMidW);
                edgeMidW.add(edgePos);
                // a point stepped outward along the same edge axis (1.6x the half-extent)
                edgeLocal.set(d.x * z.width * 1.6, d.y * z.height * 1.6, 0);
                edgeQuat.transformVector(edgeLocal, edgeOutW);
                edgeOutW.add(edgePos);
                const inFrontMid = scene.camera.worldToScreen(edgeMidW, edgeMidS);
                const inFrontOut = scene.camera.worldToScreen(edgeOutW, edgeOutS);
                if (!inFrontMid || !inFrontOut) {
                    t.setAttribute('visibility', 'hidden');
                    return;
                }
                const mx = edgeMidS.x * cw, my = edgeMidS.y * ch;
                const ox = edgeOutS.x * cw, oy = edgeOutS.y * ch;
                const angle = Math.atan2(oy - my, ox - mx) * 180 / Math.PI;
                t.setAttribute('visibility', 'visible');
                t.setAttribute('x', `${mx}`);
                t.setAttribute('y', `${my}`);
                t.setAttribute('transform', `rotate(${angle} ${mx} ${my})`);
            });
        };
        events.on('postrender', drawEdgeIcons);
```

- [ ] **Step 2: Force a render on portal data change so icons update immediately**

In the `portals.changed` handler (lines 581-586), add a forced render so the overlay (and shapes) refresh the moment an edge is toggled (toggling does not move the gizmo, which is the usual render trigger):

```ts
        events.on('portals.changed', () => {
            syncShapes();
            refreshBar();
            updateGizmos();
            updateEntryGizmo();
            scene.forceRender = true;
        });
```

- [ ] **Step 3: Clear the icons on deactivate**

In `deactivate` (lines 605-616), after `drawEntrypoints();`, add a redraw of the edge icons (with `active` now false they are removed):

```ts
            drawEntrypoints();
            drawEdgeIcons();
```

- [ ] **Step 4: Build and lint**

Run: `npm run build`
Expected: build succeeds.

Run: `npm run lint`
Expected: no new lint errors.

- [ ] **Step 5: Manual smoke test**

In the editor, with the Portals tool active and a portal selected, open the bounds popup and toggle each direction. Verify:
- A cyan arrow appears just past the corresponding edge of the selected portal, pointing outward, and disappears when toggled off.
- The arrow stays anchored to the correct edge as you orbit/rotate the camera and as you rotate the portal with the Rotate gizmo.
- Deselecting the portal (or deactivating the tool) removes the arrows.

- [ ] **Step 6: Commit**

```bash
git add src/tools/portal-tool.ts
git commit -m "feat(portals): in-scene arrow icons for infinite edges

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Full verification (build, tests, end-to-end walkthrough + exported viewer)

**Files:** none (verification only)

**Interfaces:**
- Consumes: everything from Tasks 1-7.

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: PASS — all test files green, including `portal-geom`, `portals`, `portal-export`, `portal-anim-timeline`.

- [ ] **Step 2: Lint and build**

Run: `npm run lint`
Expected: no new errors.

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Editor walkthrough E2E**

In the editor: load/create at least two splats, add a portal between them with `front`/`back` set, mark one edge infinite (e.g. right). Set a start scene. Enable walkthrough mode and fly so the camera crosses the portal's plane **past the infinite edge** (outside the visible quad). Verify the scene swaps. Then cross past a NON-infinite edge and verify it does NOT swap. Confirm a normal through-the-quad crossing still swaps.

- [ ] **Step 4: Exported viewer E2E (RELEASE build)**

Because the viewer companion is stringified and minified, this MUST be tested against a real exported RELEASE build (per project history — minification has previously broken stringified helpers). Export the scene (HTML or ZIP) with the portal configured, serve the output, and in the exported viewer:
- In free/fly navigation, cross the portal plane past the infinite edge → scene swaps; past a finite edge → no swap.
- If an animation track was exported, play it and confirm the baked timeline swaps scenes at the right time when the path passes an infinite edge.

- [ ] **Step 5: Verification report**

Confirm and record: unit tests pass (paste the summary line), lint clean, build clean, and both E2E checks behave as specified. If any check fails, return to the owning task rather than patching ad hoc.

---

## Self-Review

**Spec coverage:**
- Crossing-semantics relaxation (spec §1) → Task 1.
- Data model `infinite` field + persistence (spec §2) → Task 2; export bundle + viewer-settings type → Task 3; runtime/timeline/viewer rect threading → Task 4.
- Toolbar button + cross-layout popup, undoable, selected-portal scope (spec §3) → Task 6.
- In-scene edge icons, selected-portal-only, outward arrows (spec §3) → Task 7.
- Runtime in both editor + exported viewer (spec §4) → covered by Tasks 1+4 (no new wiring) and verified in Task 8.
- Localization across 9 locales (spec §5) → Task 5.
- Testing (spec §6) → Tasks 1-4 carry the unit tests; Task 8 is the integration/E2E gate.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has expected output. ✓

**Type consistency:** `InfiniteEdges = { top, right, bottom, left }` defined in Task 1, imported in Tasks 2-3, mirrored as an inline literal in `splat-serialize.ts` (Task 3) and `static`/runtime JSON; `infinite` field name and `edgesOf`/`emptyEdges`/`toggleBoundsPopup`/`refreshBoundsPopup` helper names used consistently between Tasks 6 and 7. Edge order top/right/bottom/left consistent throughout. ✓

**Note on Task 4 Step 2:** the timeline test passes a `PortalRect` with `infinite` directly, so it validates the Task 1 core and is expected to pass immediately; the three caller edits in Step 3 have no unit coverage and are verified by build + the Task 8 E2E. This is intentional and called out in that task.
