# Off-limits Zones — Infinite Bounds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give off-limits zones the same per-edge "extend to infinity" capability portals already have — toggled from the zone toolbar, shown as red in-scene arrows, persisted in the document, and baked into the exported/published viewer's collision.

**Architecture:** Mirror the portal "infinite boundaries" feature (commit `17022aa`) onto the structurally-identical zone subsystem. Zones gain an optional `infinite?: InfiniteEdges` field; the viewer collision test relaxes its bounds check per-edge; the editor tool gains a `⤢` button, a plus-shaped toggle popup, and a red SVG arrow overlay. Export/publish dialogs are untouched — they inherit the field through `offLimitsZones.export`.

**Tech Stack:** TypeScript (strictNullChecks off), PlayCanvas + PCUI, Rollup/SCSS, Vitest (Node env), i18next locales.

## Global Constraints

- The `InfiniteEdges` type already exists and is exported from `src/portal-geom.ts` as `{ top: boolean, right: boolean, bottom: boolean, left: boolean }`. Reuse it via a **type-only** import; do not redefine it.
- `src/viewer-companion/off-limits-collision.ts` is injected into the exported viewer verbatim via `Function.prototype.toString()`. Its runtime body must stay self-contained: no module-level references, no imports used at runtime (type-only imports are erased and are fine, but prefer inlining the edge type there).
- Size SVG text via inline `t.style.fontSize`, never the SVG `font-size` attribute — the global `* { font-size: 12px }` rule overrides the attribute.
- Arrows are **red**: `fill = '#ff3333'`, `stroke = '#7a0000'`.
- Do NOT edit `src/ui/export-popup.ts`, `src/ui/publish-settings-dialog.ts`, or `src/ui/s3-publish-dialog.ts` — they inherit `infinite` automatically once `offLimitsZones.export` emits it.
- Do NOT re-attempt ESLint `import/order` autofix (eslint@10 crashes); match surrounding import ordering by hand.
- Run commands plainly from the repo root (Git Bash); no `cd`/`--prefix`.
- Tests: `npx vitest run test/<file>.test.ts`. Lint: `npm run lint`.

---

### Task 1: Data model + serialization + payload type

Add the optional `infinite` field to the zone records and thread it through the export shape, document (de)serialization, and the viewer-settings payload type. `UpdateZoneOp` already merges partial patches (`Object.assign`), so no new undo op is needed.

**Files:**
- Modify: `src/off-limits-zones.ts` (types ~7-21; `offLimitsZones.export` ~204; `docSerialize.offLimitsZones` ~215; `docDeserialize.offLimitsZones` ~225)
- Modify: `src/splat-serialize.ts:127`
- Test: `test/off-limits-zones.test.ts`

**Interfaces:**
- Consumes: `InfiniteEdges` from `src/portal-geom.ts`.
- Produces: `ZoneData.infinite?: InfiniteEdges` and `ZoneExport.infinite?: InfiniteEdges`; `offLimitsZones.export` / `docSerialize.offLimitsZones` emit `infinite`; `docDeserialize.offLimitsZones` restores it.

- [ ] **Step 1: Write the failing tests**

Add these three tests inside the `describe('off-limits zones model', ...)` block in `test/off-limits-zones.test.ts` (after the existing `'export drops the id'` test):

```ts
it('export carries infinite edges when set', () => {
    const events = makeEvents();
    registerOffLimitsZonesEvents(events);
    const inf = { top: true, right: false, bottom: false, left: true };
    new AddZoneOp(events, zone({ infinite: inf })).do();
    expect(events.invoke('offLimitsZones.export')).toEqual([
        { position: [1, 2, 3], rotation: [0, 0, 0, 1], width: 2, height: 3, infinite: inf }
    ]);
});

it('serialize -> deserialize round-trips infinite edges', () => {
    const events = makeEvents();
    registerOffLimitsZonesEvents(events);
    const inf = { top: false, right: true, bottom: true, left: false };
    new AddZoneOp(events, zone({ id: 'zone_0', infinite: inf })).do();
    const serialized = events.invoke('docSerialize.offLimitsZones');

    const events2 = makeEvents();
    registerOffLimitsZonesEvents(events2);
    events2.invoke('docDeserialize.offLimitsZones', serialized, '');
    expect(events2.invoke('offLimitsZones.byId', 'zone_0').infinite).toEqual(inf);
});

it('deserialize leaves infinite undefined when absent', () => {
    const events = makeEvents();
    registerOffLimitsZonesEvents(events);
    events.invoke('docDeserialize.offLimitsZones', [{ id: 'zone_0', position: [0, 0, 0] }], undefined);
    expect(events.invoke('offLimitsZones.byId', 'zone_0').infinite).toBeUndefined();
});
```

Also extend the `zone(...)` test helper (top of file, ~line 30) to pass `infinite` through:

```ts
const zone = (over: Partial<ZoneData> = {}): ZoneData => ({
    id: over.id ?? 'zone_0',
    position: over.position ?? [1, 2, 3],
    rotation: over.rotation ?? [0, 0, 0, 1],
    width: over.width ?? 2,
    height: over.height ?? 3,
    infinite: over.infinite
});
```

> Note: existing `toEqual` assertions stay green — Vitest's `toEqual` ignores `undefined` properties, so a zone with `infinite: undefined` still equals the old literals.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/off-limits-zones.test.ts`
Expected: the 3 new tests FAIL (`export carries...` returns objects without `infinite`; round-trip returns `undefined`). The `infinite: over.infinite` helper line compiles because `ZoneData` does not yet have the field — it will error on type. If the type error blocks the run, that still counts as red; proceed to Step 3.

- [ ] **Step 3: Add the field and thread it through**

In `src/off-limits-zones.ts`, add the type-only import near the top (after `import { Events } from './events';`):

```ts
import type { InfiniteEdges } from './portal-geom';
```

Add `infinite?: InfiniteEdges` to both record types:

```ts
type ZoneData = {
    id: string,
    position: [number, number, number],
    rotation: [number, number, number, number],
    width: number,
    height: number,
    infinite?: InfiniteEdges
};

type ZoneExport = {
    position: [number, number, number],
    rotation: [number, number, number, number],
    width: number,
    height: number,
    infinite?: InfiniteEdges
};
```

In `offLimitsZones.export` (~line 204), add `infinite` to each mapped object:

```ts
events.function('offLimitsZones.export', (): ZoneExport[] => {
    return zones.map(z => ({
        position: [z.position[0], z.position[1], z.position[2]],
        rotation: [z.rotation[0], z.rotation[1], z.rotation[2], z.rotation[3]],
        width: z.width,
        height: z.height,
        infinite: z.infinite
    }));
});
```

In `docSerialize.offLimitsZones` (~line 215), add `infinite` to each mapped object:

```ts
events.function('docSerialize.offLimitsZones', (): ZoneData[] => {
    return zones.map(z => ({
        id: z.id,
        position: [z.position[0], z.position[1], z.position[2]],
        rotation: [z.rotation[0], z.rotation[1], z.rotation[2], z.rotation[3]],
        width: z.width,
        height: z.height,
        infinite: z.infinite
    }));
});
```

In `docDeserialize.offLimitsZones` (~line 232), add `infinite` to the pushed record:

```ts
zones.push({
    id: d.id ?? genId(),
    position: d.position,
    rotation: d.rotation ?? [0, 0, 0, 1],
    width: d.width ?? 1,
    height: d.height ?? 1,
    infinite: d.infinite
});
```

In `src/splat-serialize.ts`, replace the `offLimitsZones` element type on line 127:

```ts
    offLimitsZones: { position: [number, number, number], rotation: [number, number, number, number], width: number, height: number, infinite?: { top: boolean, right: boolean, bottom: boolean, left: boolean } }[],
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/off-limits-zones.test.ts`
Expected: PASS (all tests, including the pre-existing ones).

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: no new errors in `src/off-limits-zones.ts` or `src/splat-serialize.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/off-limits-zones.ts src/splat-serialize.ts test/off-limits-zones.test.ts
git commit -m "feat(off-limits): persist infinite edge flags on zones"
```

---

### Task 2: Viewer collision — per-edge bounds relaxation

Relax the wall bounds check so a flagged edge extends to infinity, and let the viewer payload carry the field.

**Files:**
- Modify: `src/viewer-companion/off-limits-collision.ts` (`Wall` type ~4-9; bounds check ~60-62)
- Modify: `src/viewer-companion/off-limits-zones.ts` (`ZoneLike` type ~3-8)
- Test: `test/off-limits-collision.test.ts`

**Interfaces:**
- Consumes: `Wall` with new optional `infinite`.
- Produces: `segmentBlockedByWall` blocks crossings past a flagged edge; `ZoneLike.infinite?` carries the field into the injected payload.

- [ ] **Step 1: Write the failing tests**

Add these tests inside `describe('segmentBlockedByWall', ...)` in `test/off-limits-collision.test.ts` (after the existing `'does not block when the crossing point is outside the width'` / `height` tests):

```ts
it('blocks past the right edge when the right edge is infinite', () => {
    // crossing at x = 5 is outside the default half-width (1) -> normally null,
    // but with right:infinite the wall extends, so it blocks.
    const w = wall({ infinite: { top: false, right: true, bottom: false, left: false } });
    expect(segmentBlockedByWall([5, 0, -1], [5, 0, 1], w)).toEqual([5, 0, -1]);
});

it('still does not block past the left edge when only the right edge is infinite', () => {
    const w = wall({ infinite: { top: false, right: true, bottom: false, left: false } });
    expect(segmentBlockedByWall([-5, 0, -1], [-5, 0, 1], w)).toBeNull();
});

it('blocks past the top edge when the top edge is infinite', () => {
    const w = wall({ infinite: { top: true, right: false, bottom: false, left: false } });
    expect(segmentBlockedByWall([0, 5, -1], [0, 5, 1], w)).toEqual([0, 5, -1]);
});

it('no flags behaves exactly like the original bounds check', () => {
    const w = wall({ infinite: { top: false, right: false, bottom: false, left: false } });
    expect(segmentBlockedByWall([5, 0, -1], [5, 0, 1], w)).toBeNull();
    expect(segmentBlockedByWall([0, 0, -1], [0, 0, 1], w)).toEqual([0, 0, -1]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/off-limits-collision.test.ts`
Expected: the infinite-edge tests FAIL (`Wall` has no `infinite`; the bounds check returns null past every edge).

- [ ] **Step 3: Add `infinite` to `Wall` and relax the bounds check**

In `src/viewer-companion/off-limits-collision.ts`, extend the `Wall` type:

```ts
type Wall = {
    position: Vec3,
    rotation: Quat,   // unit quaternion [x, y, z, w]
    width: number,
    height: number,
    infinite?: { top: boolean, right: boolean, bottom: boolean, left: boolean }
};
```

Replace the single bounds check (currently lines 60-62):

```ts
    if (Math.abs(ix) > hw || Math.abs(iy) > hh) {
        return null;
    }
```

with the per-edge form:

```ts
    // Per-edge bounds: an edge flagged `infinite` extends the wall to the scene
    // boundary, so a crossing past that edge still blocks. With no flags this is
    // identical to the original |ix| <= hw && |iy| <= hh test.
    const inf = wall.infinite;
    if (ix > hw && !(inf && inf.right)) return null;
    if (ix < -hw && !(inf && inf.left)) return null;
    if (iy > hh && !(inf && inf.top)) return null;
    if (iy < -hh && !(inf && inf.bottom)) return null;
```

- [ ] **Step 4: Add `infinite` to the payload `ZoneLike` type**

In `src/viewer-companion/off-limits-zones.ts`, extend `ZoneLike` (~lines 3-8):

```ts
type ZoneLike = {
    position: [number, number, number],
    rotation: [number, number, number, number],
    width: number,
    height: number,
    infinite?: { top: boolean, right: boolean, bottom: boolean, left: boolean }
};
```

(No code change is needed in the runtime string — it already serializes whole zone objects into `window.__supersplatOffLimitsZones`, so `infinite` flows through once the type permits it.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/off-limits-collision.test.ts`
Expected: PASS (all tests, including the pre-existing ones).

- [ ] **Step 6: Lint**

Run: `npm run lint`
Expected: no new errors in the two modified files.

- [ ] **Step 7: Commit**

```bash
git add src/viewer-companion/off-limits-collision.ts src/viewer-companion/off-limits-zones.ts test/off-limits-collision.test.ts
git commit -m "feat(off-limits): extend wall collision past infinite edges"
```

---

### Task 3: Localization keys (9 locales)

Add the bounds keys to every locale, mirroring the `portals.bounds.*` key set and reusing each locale's existing portal wording (swap "portal" → "zone").

**Files:**
- Modify: `static/locales/en.json`, `de.json`, `es.json`, `fr.json`, `ja.json`, `ko.json`, `pt-BR.json`, `ru.json`, `zh-CN.json`

**Interfaces:**
- Produces: `offLimitsZones.bounds`, `.bounds.tooltip`, `.bounds.top|right|bottom|left` in all 9 locales.

- [ ] **Step 1: Add the keys to each locale**

In each file, locate the existing `offLimitsZones.*` block (e.g. en.json lines 65-71, ending at `offLimitsZones.defaultMessage`) and add these six keys immediately after it. Use the `portals.bounds.*` entries in the **same file** as the translation reference; only `en.json` is shown literally below.

`static/locales/en.json`:

```json
    "offLimitsZones.bounds": "Bounds",
    "offLimitsZones.bounds.tooltip": "Extend zone edges to the scene boundary",
    "offLimitsZones.bounds.top": "Top",
    "offLimitsZones.bounds.right": "Right",
    "offLimitsZones.bounds.bottom": "Bottom",
    "offLimitsZones.bounds.left": "Left",
```

For the other 8 files, copy the corresponding `portals.bounds`, `portals.bounds.tooltip`, `portals.bounds.top/right/bottom/left` values from that same file, renaming the keys to the `offLimitsZones.bounds*` form. (The `.top/.right/.bottom/.left` direction words are identical to the portal ones; for `.tooltip` reuse the portal tooltip phrasing with "zone" substituted for "portal" where the language distinguishes them.)

Watch the JSON: keep the trailing comma on the line above, and do not add a trailing comma after the last key of the object.

- [ ] **Step 2: Verify the keys are present in all 9 files and JSON is valid**

Run:
```bash
grep -l '"offLimitsZones.bounds.tooltip"' static/locales/*.json | wc -l
node -e "for (const f of require('fs').readdirSync('static/locales')) JSON.parse(require('fs').readFileSync('static/locales/'+f));" && echo "all locales parse"
```
Expected: first command prints `9`; second prints `all locales parse`.

- [ ] **Step 3: Commit**

```bash
git add static/locales/*.json
git commit -m "feat(off-limits): localize zone bounds toggle strings"
```

---

### Task 4: Editor UI — bounds button, toggle popup, red arrow overlay

Add the toolbar `⤢` button, the plus-shaped toggle popup (its own stylesheet), and the red in-scene arrow overlay to the zone tool. This task has no Vitest coverage (PCUI/DOM tool, no test harness); verification is lint + build + a manual smoke test.

**Files:**
- Create: `src/ui/scss/off-limits-bounds-popup.scss`
- Modify: `src/ui/scss/style.scss` (after line 31, `@use 'portal-bounds-popup.scss';`)
- Modify: `src/tools/off-limits-zone-tool.ts`

**Interfaces:**
- Consumes: `ZoneData.infinite?` (Task 1); `UpdateZoneOp` (existing); `selected()`, `active`, `scene.camera.worldToScreen`, the `offLimitsZones.changed` / `selectionChanged` listeners (existing).
- Produces: editor UI to toggle `infinite` edges; no exported symbols change.

- [ ] **Step 1: Create the popup stylesheet**

Create `src/ui/scss/off-limits-bounds-popup.scss` (copy of the portal popup with `off-limits-` class names):

```scss
@use 'colors.scss' as *;

.off-limits-bounds-popup {
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

    .off-limits-bounds-toggle {
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

    .off-limits-bounds-top { grid-column: 2; grid-row: 1; }
    .off-limits-bounds-left { grid-column: 1; grid-row: 2; }
    .off-limits-bounds-right { grid-column: 3; grid-row: 2; }
    .off-limits-bounds-bottom { grid-column: 2; grid-row: 3; }
}
```

- [ ] **Step 2: Register the stylesheet**

In `src/ui/scss/style.scss`, after line 31 (`@use 'portal-bounds-popup.scss';`) add:

```scss
@use 'off-limits-bounds-popup.scss';
```

- [ ] **Step 3: Add the bounds button to the toolbar**

In `src/tools/off-limits-zone-tool.ts`, add the button after `rotateButton` is created (~line 46):

```ts
        const boundsButton = new Button({ text: '⤢', class: 'select-toolbar-button' });
        boundsButton.dom.title = localize('offLimitsZones.bounds.tooltip');
```

And append it to the bar right after `bar.append(rotateButton);` (~line 56):

```ts
        bar.append(boundsButton);
```

- [ ] **Step 4: Build the toggle popup and its handlers**

In `src/tools/off-limits-zone-tool.ts`, after the `selected()` helper (~line 69), add the popup, edge buttons, helpers, and toggle wiring:

```ts
        // --- infinite-bounds popup (cross layout), mirrors portal-tool.ts ---
        const boundsPopup = new Container({ class: 'off-limits-bounds-popup', hidden: true });
        boundsPopup.dom.addEventListener('pointerdown', e => e.stopPropagation());
        const EDGE_DIRS = ['top', 'right', 'bottom', 'left'] as const;
        type EdgeDir = typeof EDGE_DIRS[number];
        const edgeGlyph: Record<EdgeDir, string> = { top: '↑', right: '→', bottom: '↓', left: '←' };
        const edgeButtons = {} as Record<EdgeDir, Button>;
        EDGE_DIRS.forEach((dir) => {
            const b = new Button({ text: edgeGlyph[dir], class: ['off-limits-bounds-toggle', `off-limits-bounds-${dir}`] });
            b.dom.title = localize(`offLimitsZones.bounds.${dir}`);
            edgeButtons[dir] = b;
            boundsPopup.append(b);
        });
        canvasContainer.append(boundsPopup);

        const emptyEdges = () => ({ top: false, right: false, bottom: false, left: false });
        const edgesOf = (z: ZoneData) => ({ ...emptyEdges(), ...(z.infinite ?? {}) });

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
                events.fire('edit.add', new UpdateZoneOp(events, z.id, { infinite: z.infinite }, { infinite: newEdges }));
            });
        });
```

- [ ] **Step 5: Add the red arrow overlay**

In `src/tools/off-limits-zone-tool.ts`, after the popup wiring from Step 4, add the SVG overlay and its draw loop (uses the existing `scene` reference; reuses the local `EdgeDir`/`EDGE_DIRS`/`edgesOf`/`emptyEdges` from Step 4):

```ts
        // --- infinite-edge arrow overlay (selected zone only). Projects each
        //     infinite edge's midpoint plus a point stepped outward, draws a red
        //     arrow glyph at the midpoint rotated to point outward on screen. ---
        const svgNs = 'http://www.w3.org/2000/svg';
        const edgeSvg = document.createElementNS(svgNs, 'svg');
        edgeSvg.style.position = 'absolute';
        edgeSvg.style.inset = '0';
        edgeSvg.style.width = '100%';
        edgeSvg.style.height = '100%';
        edgeSvg.style.overflow = 'visible';
        edgeSvg.style.pointerEvents = 'none';
        // Prepend so the overlay sits above #canvas but below editor chrome.
        canvasContainer.dom.prepend(edgeSvg);
        const edgeArrows: SVGTextElement[] = [];
        const edgeQuat = new Quat();
        const edgePos = new Vec3();
        const edgeLocal = new Vec3();
        const edgeMidW = new Vec3();
        const edgeOutW = new Vec3();
        const edgeMidS = new Vec3();
        const edgeOutS = new Vec3();
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
                const t = document.createElementNS(svgNs, 'text') as SVGTextElement;
                t.setAttribute('fill', '#ff3333');
                t.setAttribute('stroke', '#7a0000');
                t.setAttribute('stroke-width', '0.5');
                // Size via inline CSS, not the SVG font-size attribute: the global
                // `*` rule (font-size: 12px) overrides the presentation attribute.
                t.style.fontSize = '24px';
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
                edgeLocal.set(d.x * z.width, d.y * z.height, 0);
                edgeQuat.transformVector(edgeLocal, edgeMidW);
                edgeMidW.add(edgePos);
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

- [ ] **Step 6: Keep the popup in sync with selection/data changes**

In `src/tools/off-limits-zone-tool.ts`, add `refreshBoundsPopup();` inside the two existing handlers and the activate/deactivate methods.

In the `offLimitsZones.changed` handler (~line 333):

```ts
        events.on('offLimitsZones.changed', () => {
            syncShapes();
            refreshBar();
            updateGizmos();
            refreshBoundsPopup();
        });
```

In the `offLimitsZones.selectionChanged` handler (~line 338):

```ts
        events.on('offLimitsZones.selectionChanged', () => {
            syncShapes();
            refreshBar();
            updateGizmos();
            refreshBoundsPopup();
        });
```

In `this.activate` (~line 344), after `updateGizmos();`:

```ts
            refreshBoundsPopup();
```

In `this.deactivate` (~line 354), after `bar.hidden = true;`:

```ts
            boundsPopup.hidden = true;
```

- [ ] **Step 7: Lint and build**

Run: `npm run lint`
Expected: no new errors in `src/tools/off-limits-zone-tool.ts`.

Run: `npm run build`
Expected: build succeeds (compiles the new SCSS `@use` and the tool changes).

- [ ] **Step 8: Manual smoke test**

Run: `npm run develop` and open http://localhost:3333.
Verify:
1. Load any splat, open the **off-limits zones** tool (bottom toolbar), click **Add Zone**.
2. The `⤢` button appears in the zone toolbar; it is enabled only while a zone is selected.
3. Click `⤢` → a 3×3 plus-shaped popup opens below the button with `↑ → ↓ ←` toggles.
4. Toggle the top edge → the toggle highlights, and a **red `➜` arrow** appears at the top edge of the selected zone in the 3D view, pointing outward. Rotate/move the zone → the arrow tracks it.
5. Toggle multiple edges; deselect the zone → arrows and popup disappear. Re-select → state is restored.
6. Undo (Ctrl+Z) reverts the last edge toggle; redo re-applies it.
7. Reload the project (or save/reopen) → infinite edges persist.

- [ ] **Step 9: Commit**

```bash
git add src/tools/off-limits-zone-tool.ts src/ui/scss/off-limits-bounds-popup.scss src/ui/scss/style.scss
git commit -m "feat(off-limits): zone infinite-bounds toggle UI and arrow overlay"
```

---

## Post-implementation (handled outside these tasks)

- End-to-end check on a **release** build (`npm run build` + serve `dist/`, or the export server `npm run dev`): export a scene with a zone that has an infinite edge, load the exported viewer, and confirm the player is blocked when walking around that edge (the wall extends past it) — and not blocked past a non-flagged edge. This guards against minification gotchas in the stringified collision runtime.
- Squash the feature branch into a single commit (including the spec + this plan) before merging to `main`, per project convention.
```
