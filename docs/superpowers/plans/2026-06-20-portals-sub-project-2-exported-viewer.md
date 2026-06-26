# Portals Sub-Project 2 (Exported-Viewer Walkthrough) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the portal multi-scene walkthrough work in the exported standalone ZIP viewer — host multiple 3DGS scenes in one bundle and switch the visible scene (and its collision volume) at runtime as the camera crosses portals.

**Architecture:** Companion-injection (no dependency fork). The export serializes every portal-referenced scene as its own bundle under `scenes/N/` in the ZIP, writes a `portals` block into the viewer settings JSON, and injects a self-contained runtime `<script>` (built exactly like `off-limits-collision.ts`). At runtime the companion reaches the live PlayCanvas app via `window.__supersplatViewer`, creates one gsplat entity per extra scene (disabled), and per frame runs the existing `resolveActiveSplat` to toggle which single entity (and collision volume) is active. An authored per-scene "entrypoint" (new editor affordance) supplies the indoor-collision flood-fill seed.

**Tech Stack:** TypeScript, PlayCanvas engine (`playcanvas`), `@playcanvas/splat-transform` (`writeHtml`/`writeSog`/`writeLod`/`writeVoxel`), `@playcanvas/pcui`, vitest.

**Spec:** `docs/superpowers/specs/2026-06-20-portals-sub-project-2-exported-viewer-design.md`

## Global Constraints

- Work on branch `portals-exported-viewer` (already created off `main`). Do NOT push unless asked. Squash to ONE commit at the very end (the finishing skill handles this) — but make frequent local commits during development.
- Use the Bash tool (Git Bash). Run commands plainly: NO `cd` / `git -C` / `--prefix` pointing at the cwd (causes permission prompts).
- **Build gates are the real gates:** `npx tsc --noEmit` and `npm run build` must pass. Do **NOT** run `eslint --fix` / `npm run lint` (a known pinned-eslint@10 import/order crash on `src/main.ts` is unrelated to this work and will fail spuriously).
- Tests: `npm test` (vitest). The 3 `server/test/*` failures (`Cannot find package 'tsx'`) are pre-existing/environmental — ignore them. Pure logic that must be unit-tested goes in a **playcanvas-free** module (importing the full `playcanvas` under vitest's node env hangs). Note: a module that imports `playcanvas` **only in type position** is fine — esbuild elides the import (this is how `portals.ts` is already tested).
- Feature is **gated on "portals exist in this export"**: with zero portals every existing export path must be byte-for-byte unchanged. All new `ExperienceSettings` fields are optional and absent when there are no portals.
- v1 scope: **ZIP target only**, **general N-scene**, **format follows the streaming toggle**, **preload-all** load model, **per-scene Interior/Exterior** (radius + voxel size shared).
- Coordinate convention: scenes are exported via `extractDataTable`, which bakes each splat's editor world transform into the data — so all scenes share one world frame and portal/entrypoint coordinates (editor world space) line up with no conversion. Portal local +Z = "front".

---

## File Structure

| File | Responsibility |
|---|---|
| `src/portals.ts` | **(modify)** Add per-scene entrypoint map (keyed by splat `uid`), `UpdatePortalEntrypointOp`, set/clear/query events, `portals.exportEntrypoints`, doc serialize/deserialize, reset on `scene.clear`. |
| `src/doc.ts` | **(modify)** Persist `portalsEntrypoints` alongside `portals` / `portalsStartSplat`. |
| `src/tools/portal-tool.ts` | **(modify)** Entrypoint row in the floating bar; SVG overlay dot per scene; translate-only gizmo to drag the selected entrypoint. |
| `src/portal-export.ts` | **(new, pure, playcanvas-free)** Scene-set collection, `uid → index` mapping, portal-reference rewrite, scene-URL/collision-URL maps, and the two-tier collision-seed resolver. Unit-tested. |
| `src/splat-serialize.ts` | **(modify)** Extend `ExperienceSettings`; multi-scene serialization loop in `serializeViewer`. |
| `src/splat-export-core.ts` | **(modify)** Per-scene writer + per-scene `writeCollisionVoxel`, scene-prefixed progress, `injectPortals` wired alongside the other injectors. |
| `src/viewer-companion/portals.ts` | **(new)** `buildPortalsInjection` (payload + runtime `<script>`) and the self-contained runtime companion (asset creation, switching, collision preload/swap). |
| `src/ui/export-popup.ts` | **(modify)** Per-scene Interior/Exterior selectors; assemble portal fields (incl. authored entrypoints) into `ExperienceSettings`. |
| `src/ui/localization/*` | **(modify)** New strings across all locales. |
| `test/portal-export.test.ts` | **(new)** Unit tests for `portal-export.ts`. |
| `test/portals.test.ts` | **(modify)** Add entrypoint data-model tests. |

---

## Phase 1 — Editor entrypoint authoring (SP1 surface; own commits)

### Task 1: Per-scene entrypoint data model + persistence

**Files:**
- Modify: `src/portals.ts`
- Modify: `src/doc.ts:127`, `src/doc.ts:168`
- Test: `test/portals.test.ts`

**Interfaces:**
- Consumes: existing `registerPortalsEvents(events)`, the `Events` double in `test/portals.test.ts`.
- Produces:
  - `class UpdatePortalEntrypointOp` with `constructor(events, uid: number, oldPos: [number,number,number]|null, newPos: [number,number,number]|null)`, `.do()`, `.undo()`, `.destroy()`.
  - Events: `portals.setEntrypointRaw(uid, pos|null)`; functions `portals.entrypoint(uid) -> [number,number,number]|null`, `portals.exportEntrypoints() -> Record<string, [number,number,number]>` (string uid keys), and the deserialize accepts a 3rd arg.
  - `docSerialize` side: `events.invoke('portals.exportEntrypoints')`.

- [ ] **Step 1: Write the failing tests** — append to `test/portals.test.ts`:

```ts
import { UpdatePortalEntrypointOp } from '../src/portals';

describe('portal entrypoints', () => {
    it('set + query a per-scene entrypoint', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        new UpdatePortalEntrypointOp(events, 7, null, [1, 2, 3]).do();
        expect(events.invoke('portals.entrypoint', 7)).toEqual([1, 2, 3]);
        expect(events.invoke('portals.entrypoint', 8)).toBeNull();
    });

    it('clearing (newPos null) removes the entrypoint', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        new UpdatePortalEntrypointOp(events, 7, null, [1, 2, 3]).do();
        new UpdatePortalEntrypointOp(events, 7, [1, 2, 3], null).do();
        expect(events.invoke('portals.entrypoint', 7)).toBeNull();
    });

    it('undo restores the previous entrypoint value', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        const op = new UpdatePortalEntrypointOp(events, 7, null, [1, 2, 3]);
        op.do();
        op.undo();
        expect(events.invoke('portals.entrypoint', 7)).toBeNull();
    });

    it('exportEntrypoints returns a uid->position record', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        new UpdatePortalEntrypointOp(events, 7, null, [1, 2, 3]).do();
        expect(events.invoke('portals.exportEntrypoints')).toEqual({ '7': [1, 2, 3] });
    });

    it('deserialize restores entrypoints from the 3rd arg', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        events.invoke('docDeserialize.portals', [], null, { '7': [4, 5, 6] });
        expect(events.invoke('portals.entrypoint', 7)).toEqual([4, 5, 6]);
    });

    it('scene.clear wipes entrypoints', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        new UpdatePortalEntrypointOp(events, 7, null, [1, 2, 3]).do();
        events.fire('scene.clear');
        expect(events.invoke('portals.entrypoint', 7)).toBeNull();
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- portals`
Expected: FAIL — `UpdatePortalEntrypointOp` is not exported / `portals.entrypoint` returns undefined.

- [ ] **Step 3: Implement in `src/portals.ts`**

Add the op class (next to `SetStartSplatOp`):

```ts
class UpdatePortalEntrypointOp {
    name = 'updatePortalEntrypoint';
    events: Events;
    uid: number;
    oldPos: [number, number, number] | null;
    newPos: [number, number, number] | null;
    constructor(events: Events, uid: number, oldPos: [number, number, number] | null, newPos: [number, number, number] | null) {
        this.events = events;
        this.uid = uid;
        this.oldPos = oldPos;
        this.newPos = newPos;
    }
    do() {
        this.events.fire('portals.setEntrypointRaw', this.uid, this.newPos);
    }
    undo() {
        this.events.fire('portals.setEntrypointRaw', this.uid, this.oldPos);
    }
    destroy() {
        this.events = null;
    }
}
```

Inside `registerPortalsEvents`, next to `let startUid`, add:

```ts
    const entrypoints = new Map<number, [number, number, number]>();
```

Add queries (near `portals.startSplat`):

```ts
    events.function('portals.entrypoint', (uid: number) => entrypoints.get(uid) ?? null);
    events.function('portals.exportEntrypoints', () => {
        const out: Record<string, [number, number, number]> = {};
        entrypoints.forEach((pos, uid) => {
            out[String(uid)] = [pos[0], pos[1], pos[2]];
        });
        return out;
    });
```

Add the low-level mutator (near `portals.setStartRaw`):

```ts
    events.on('portals.setEntrypointRaw', (uid: number, pos: [number, number, number] | null) => {
        if (pos) {
            entrypoints.set(uid, [pos[0], pos[1], pos[2]]);
        } else {
            entrypoints.delete(uid);
        }
        fireChanged();
    });
```

In the `scene.clear` handler, add `entrypoints.clear();` alongside the existing resets.

Extend `docDeserialize.portals` signature and body — change it to accept entrypoints and seed the map:

```ts
    events.function('docDeserialize.portals', (data: PortalData[], start?: number | null, eps?: Record<string, [number, number, number]>) => {
        portals.length = 0;
        nextId = 0;
        selectedId = null;
        startUid = (typeof start === 'number') ? start : null;
        entrypoints.clear();
        if (eps && typeof eps === 'object') {
            Object.keys(eps).forEach((k) => {
                const v = eps[k];
                if (Array.isArray(v) && v.length >= 3) {
                    entrypoints.set(parseInt(k, 10), [v[0], v[1], v[2]]);
                }
            });
        }
        // ... existing portal-restore loop unchanged ...
```

Export the new op:

```ts
export {
    registerPortalsEvents,
    AddPortalOp,
    RemovePortalOp,
    UpdatePortalOp,
    SetStartSplatOp,
    UpdatePortalEntrypointOp,
    PortalData
};
```

- [ ] **Step 4: Wire persistence in `src/doc.ts`**

At line ~127 (deserialize), add the 3rd arg:

```ts
            events.invoke('docDeserialize.portals', document.portals, document.portalsStartSplat, document.portalsEntrypoints);
```

At line ~168 (serialize), add a sibling field:

```ts
                portals: events.invoke('docSerialize.portals'),
                portalsStartSplat: events.invoke('portals.startSplat'),
                portalsEntrypoints: events.invoke('portals.exportEntrypoints'),
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npm test -- portals`
Expected: PASS (all entrypoint tests green, existing portal tests still green).

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/portals.ts src/doc.ts test/portals.test.ts
git commit -m "feat(portals): per-scene entrypoint data model + persistence"
```

---

### Task 2: Entrypoint authoring UI (dot overlay + translate gizmo + bar row)

**Files:**
- Modify: `src/tools/portal-tool.ts`
- Modify: `src/ui/scss/*` (reuse an existing overlay style or add a small `.portal-entrypoint-dot` rule — see Step 3)

**Interfaces:**
- Consumes: `UpdatePortalEntrypointOp`, `portals.entrypoint`, `portals.exportEntrypoints`, `portals.list`, `scene.getElementsByType`, `scene.camera.worldToScreen`, `scene.gizmoLayer`, `events.invoke('camera.getPose')`.
- Produces: no exported symbols; purely additive editor behaviour.

Not unit-testable (imports `playcanvas`); gated by `tsc --noEmit` + `npm run build` + manual check.

- [ ] **Step 1: Add the Entrypoint row to the floating bar**

In `PortalTool`'s constructor, after the `startInput` block (~line 58–72), add:

```ts
        const entryLabel = new Label({ text: localize('portals.entrypoint') });
        const entrySceneInput = new SelectInput({ type: 'number', options: [], width: 140 });
        const entrySetButton = new Button({ text: localize('portals.entrypoint.set'), class: 'select-toolbar-button' });
        const entryClearButton = new Button({ text: localize('portals.entrypoint.clear'), class: 'select-toolbar-button' });
        bar.append(entryLabel);
        bar.append(entrySceneInput);
        bar.append(entrySetButton);
        bar.append(entryClearButton);
```

- [ ] **Step 2: Populate the scene dropdown with portal-referenced scenes + reflect set/unset**

In `refreshSceneOptions` (after it sets front/back/start options) add:

```ts
        // entrypoint dropdown lists only scenes referenced by a portal (the ones exported)
        const referenced = new Set<number>();
        (events.invoke('portals.list') as PortalData[]).forEach((p) => {
            if (p.frontUid !== null) referenced.add(p.frontUid);
            if (p.backUid !== null) referenced.add(p.backUid);
        });
        entrySceneInput.options = splatList()
            .filter(s => referenced.has(s.uid))
            .map(s => ({ v: s.uid, t: splatName(s) }));
```

In `refreshBar` (inside the `suppress = true` block), reflect current selection's set/unset state on the buttons:

```ts
        const epUid = entrySceneInput.value as number | null;
        const hasEp = epUid != null && !!events.invoke('portals.entrypoint', epUid);
        entryClearButton.enabled = hasEp;
        entrySetButton.class[hasEp ? 'add' : 'remove']('active');
```

- [ ] **Step 3: Capture-from-camera + clear handlers**

Add after the existing `startInput.on('change', ...)` handler:

```ts
        entrySceneInput.on('change', () => { if (!suppress) refreshBar(); });

        entrySetButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            if (!active) return;
            const uid = entrySceneInput.value as number | null;
            if (uid == null) return;
            const pose = events.invoke('camera.getPose');
            const p = pose?.position;
            if (!p) return;
            const old = events.invoke('portals.entrypoint', uid) as [number, number, number] | null;
            events.fire('edit.add', new UpdatePortalEntrypointOp(events, uid, old, [p.x, p.y, p.z]));
        });

        entryClearButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            if (!active) return;
            const uid = entrySceneInput.value as number | null;
            if (uid == null) return;
            const old = events.invoke('portals.entrypoint', uid) as [number, number, number] | null;
            if (old) events.fire('edit.add', new UpdatePortalEntrypointOp(events, uid, old, null));
        });
```

Import `UpdatePortalEntrypointOp` at the top of the file (add to the existing `from '../portals'` import).

- [ ] **Step 4: Draw the entrypoint dots (SVG overlay, never occluded)**

This mirrors `alignment-tool.ts:45-123`. Add an SVG overlay in the constructor:

```ts
        const epSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        epSvg.classList.add('portal-entrypoint-overlay');
        epSvg.style.position = 'absolute';
        epSvg.style.inset = '0';
        epSvg.style.width = '100%';
        epSvg.style.height = '100%';
        epSvg.style.pointerEvents = 'none';
        canvasContainer.dom.appendChild(epSvg);
        const epNs = epSvg.namespaceURI;
        const epDots: { circle: SVGCircleElement, label: SVGTextElement }[] = [];
        const epWorld = new Vec3();
        const epScreen = new Vec3();

        const drawEntrypoints = () => {
            const eps = active ? (events.invoke('portals.exportEntrypoints') as Record<string, [number, number, number]>) : {};
            const uids = Object.keys(eps);
            while (epDots.length < uids.length) {
                const circle = document.createElementNS(epNs, 'circle') as SVGCircleElement;
                circle.setAttribute('r', '6');
                circle.setAttribute('fill', '#00ccff');
                circle.setAttribute('stroke', '#003344');
                circle.setAttribute('stroke-width', '2');
                const label = document.createElementNS(epNs, 'text') as SVGTextElement;
                label.setAttribute('fill', '#ffffff');
                label.setAttribute('font-size', '11');
                epSvg.appendChild(circle);
                epSvg.appendChild(label);
                epDots.push({ circle, label });
            }
            while (epDots.length > uids.length) {
                const d = epDots.pop();
                d.circle.remove();
                d.label.remove();
            }
            const cw = canvasContainer.dom.clientWidth;
            const ch = canvasContainer.dom.clientHeight;
            uids.forEach((uid, i) => {
                const pos = eps[uid];
                epWorld.set(pos[0], pos[1], pos[2]);
                const inFront = scene.camera.worldToScreen(epWorld, epScreen);
                const { circle, label } = epDots[i];
                if (!inFront) {
                    circle.setAttribute('visibility', 'hidden');
                    label.setAttribute('visibility', 'hidden');
                    return;
                }
                const x = epScreen.x * cw;
                const y = epScreen.y * ch;
                circle.setAttribute('visibility', 'visible');
                label.setAttribute('visibility', 'visible');
                circle.setAttribute('cx', `${x}`);
                circle.setAttribute('cy', `${y}`);
                label.setAttribute('x', `${x + 9}`);
                label.setAttribute('y', `${y - 9}`);
                label.textContent = `⌂ ${uid}`;
            });
        };
        events.on('postrender', drawEntrypoints);
```

Add `Vec3` to the existing `from 'playcanvas'` import if not already present (it is — `Vec3` is imported).

- [ ] **Step 5: Translate gizmo to drag the selected entrypoint**

Add a third gizmo dedicated to the entrypoint, attached when its scene dropdown points at a scene that has an entrypoint. Reuse the existing `updateGizmoSize` (extend it to set `entryGizmo.size` too). Add:

```ts
        const entryGizmo = new TranslateGizmo(scene.camera.camera, scene.gizmoLayer);
        const entryPivot = new Entity('portalEntrypointPivot');
        const entryDragStart = new Vec3();
        let entryDragging = false;

        const updateEntryGizmo = () => {
            entryGizmo.detach();
            if (!active) return;
            const uid = entrySceneInput.value as number | null;
            if (uid == null) return;
            const pos = events.invoke('portals.entrypoint', uid) as [number, number, number] | null;
            if (!pos) return;
            entryPivot.setLocalPosition(pos[0], pos[1], pos[2]);
            entryGizmo.attach(entryPivot);
        };
        entryGizmo.on('render:update', () => { scene.forceRender = true; });
        entryGizmo.on('transform:start', () => {
            entryDragging = true;
            entryDragStart.copy(entryPivot.getLocalPosition());
        });
        entryGizmo.on('transform:move', () => { scene.forceRender = true; });
        entryGizmo.on('transform:end', () => {
            entryDragging = false;
            const uid = entrySceneInput.value as number | null;
            if (uid == null) return;
            const p = entryPivot.getLocalPosition();
            if (p.x === entryDragStart.x && p.y === entryDragStart.y && p.z === entryDragStart.z) return;
            events.fire('edit.add', new UpdatePortalEntrypointOp(
                events, uid,
                [entryDragStart.x, entryDragStart.y, entryDragStart.z],
                [p.x, p.y, p.z]
            ));
        });
```

Import `Entity` from `playcanvas` (add to the existing import). Call `updateEntryGizmo()` from `refreshBar`, from the `entrySceneInput.on('change')` handler, and inside the existing `portals.changed` / `portals.selectionChanged` handlers (next to `updateGizmos()`). In `deactivate`, call `entryGizmo.detach()` and `drawEntrypoints()` once more (it self-clears because `active` is false). In `updateGizmoSize`, add `entryGizmo.size = size;`.

- [ ] **Step 6: Build + type-check**

Run: `npx tsc --noEmit && npm run build`
Expected: both succeed.

- [ ] **Step 7: Manual smoke check**

Load two splats, open the Portals tool, add a portal referencing both, pick a scene in the Entrypoint dropdown, click **Set from camera** → a cyan `⌂` dot appears at the camera position; drag its gizmo → dot moves; undo (Ctrl+Z) reverts; **Clear** removes it. Save + reload the project → entrypoint persists.

- [ ] **Step 8: Commit**

```bash
git add src/tools/portal-tool.ts src/ui/scss
git commit -m "feat(portals): author per-scene entrypoint (dot + translate gizmo) in the editor"
```

---

## Phase 2 — Pure export helpers (playcanvas-free, full TDD)

### Task 3: `portal-export.ts` — scene set, uid→index map, reference rewrite, URL maps

**Files:**
- Create: `src/portal-export.ts`
- Test: `test/portal-export.test.ts`

**Interfaces:**
- Consumes: nothing from the app (pure). Input shapes defined below.
- Produces:
  - `type ExportPortal = { position:[number,number,number], rotation:[number,number,number,number], width:number, height:number, frontUid:number|null, backUid:number|null }` (the shape `events.invoke('portals.export')` already returns).
  - `type PortalBundle = { sceneUids: number[]; portals: { position; rotation; width; height; front: number|null; back: number|null }[]; portalScenes: string[]; portalStart: number; portalCollision: (string|null)[] }`.
  - `buildPortalBundle(args: { portals: ExportPortal[]; startUid: number|null; availableUids: number[]; streaming: boolean; collision: boolean }) => PortalBundle | null` — returns `null` when fewer than 2 resolvable scenes (caller then skips portal injection).

- [ ] **Step 1: Write the failing tests** — `test/portal-export.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import { buildPortalBundle } from '../src/portal-export';

const portal = (front: number | null, back: number | null) => ({
    position: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0, 1] as [number, number, number, number],
    width: 2, height: 2, frontUid: front, backUid: back
});

describe('buildPortalBundle', () => {
    it('maps uids to bundle indices with start = index 0', () => {
        const b = buildPortalBundle({
            portals: [portal(10, 20)],
            startUid: 10,
            availableUids: [10, 20],
            streaming: false,
            collision: false
        });
        expect(b).not.toBeNull();
        expect(b!.portalStart).toBe(0);
        expect(b!.sceneUids[0]).toBe(10);        // start first
        expect(b!.sceneUids).toContain(20);
        expect(b!.portals[0].front).toBe(0);     // uid 10 -> index 0
        expect(b!.portals[0].back).toBe(b!.sceneUids.indexOf(20));
    });

    it('primary scene URL is empty; extra scenes follow scenes/N convention (SOG)', () => {
        const b = buildPortalBundle({ portals: [portal(10, 20)], startUid: 10, availableUids: [10, 20], streaming: false, collision: false })!;
        expect(b.portalScenes[0]).toBe('');
        const idx20 = b.sceneUids.indexOf(20);
        expect(b.portalScenes[idx20]).toBe(`scenes/${idx20}/scene.sog`);
    });

    it('streaming uses lod-meta.json per extra scene', () => {
        const b = buildPortalBundle({ portals: [portal(10, 20)], startUid: 10, availableUids: [10, 20], streaming: true, collision: false })!;
        const idx20 = b.sceneUids.indexOf(20);
        expect(b.portalScenes[idx20]).toBe(`scenes/${idx20}/lod-meta.json`);
    });

    it('collision URLs: primary = index.voxel.json, extras = scenes/N/scene.voxel.json', () => {
        const b = buildPortalBundle({ portals: [portal(10, 20)], startUid: 10, availableUids: [10, 20], streaming: false, collision: true })!;
        const idx20 = b.sceneUids.indexOf(20);
        expect(b.portalCollision[0]).toBe('index.voxel.json');
        expect(b.portalCollision[idx20]).toBe(`scenes/${idx20}/scene.voxel.json`);
    });

    it('collision array is empty when collision is off', () => {
        const b = buildPortalBundle({ portals: [portal(10, 20)], startUid: 10, availableUids: [10, 20], streaming: false, collision: false })!;
        expect(b.portalCollision).toEqual([]);
    });

    it('null start falls back to the first referenced scene as index 0', () => {
        const b = buildPortalBundle({ portals: [portal(10, 20)], startUid: null, availableUids: [10, 20], streaming: false, collision: false })!;
        expect(b.portalStart).toBe(0);
        expect(b.sceneUids[0]).toBe(10);
    });

    it('drops references to uids that no longer exist', () => {
        const b = buildPortalBundle({ portals: [portal(10, 99)], startUid: 10, availableUids: [10, 20], streaming: false, collision: false });
        // uid 99 is gone -> that side becomes null; only scene 10 remains resolvable -> < 2 scenes -> null
        expect(b).toBeNull();
    });

    it('returns null when fewer than 2 resolvable scenes', () => {
        const b = buildPortalBundle({ portals: [portal(10, null)], startUid: 10, availableUids: [10], streaming: false, collision: false });
        expect(b).toBeNull();
    });

    it('dedupes a scene referenced by multiple portals', () => {
        const b = buildPortalBundle({
            portals: [portal(10, 20), portal(20, 30)],
            startUid: 10,
            availableUids: [10, 20, 30],
            streaming: false, collision: false
        })!;
        expect(b.sceneUids.filter(u => u === 20).length).toBe(1);
        expect(b.sceneUids.length).toBe(3);
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- portal-export`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/portal-export.ts`**

```ts
// Pure, dependency-free helpers that turn the editor's session-scoped portal
// records (splat-uid references) into the exported bundle's index-based shape:
// a per-scene identity scheme (0 = primary/start), rewritten portal references,
// and the relative scene/collision URLs the viewer companion loads. No
// playcanvas / splat-transform imports so it is unit-testable in isolation.

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

type ExportPortal = {
    position: Vec3,
    rotation: Quat,
    width: number,
    height: number,
    frontUid: number | null,
    backUid: number | null
};

type PortalBundle = {
    sceneUids: number[];                 // index -> editor uid (index 0 = start)
    portals: { position: Vec3, rotation: Quat, width: number, height: number, front: number | null, back: number | null }[];
    portalScenes: string[];              // index -> relative asset URL (index 0 = '')
    portalStart: number;                 // always 0
    portalCollision: (string | null)[];  // index -> voxel URL, or [] when collision off
};

const sceneUrl = (index: number, streaming: boolean): string => {
    if (index === 0) return '';
    return streaming ? `scenes/${index}/lod-meta.json` : `scenes/${index}/scene.sog`;
};

const collisionUrl = (index: number): string => {
    return index === 0 ? 'index.voxel.json' : `scenes/${index}/scene.voxel.json`;
};

const buildPortalBundle = (args: {
    portals: ExportPortal[],
    startUid: number | null,
    availableUids: number[],
    streaming: boolean,
    collision: boolean
}): PortalBundle | null => {
    const { portals, startUid, availableUids, streaming, collision } = args;
    const exists = (uid: number | null): uid is number => uid !== null && availableUids.includes(uid);

    // collect referenced, existing scene uids
    const referenced: number[] = [];
    const add = (uid: number | null) => {
        if (exists(uid) && !referenced.includes(uid)) referenced.push(uid);
    };
    portals.forEach((p) => { add(p.frontUid); add(p.backUid); });

    // choose the start scene: explicit start if valid, else first referenced
    const start = exists(startUid) ? startUid : (referenced[0] ?? null);
    if (start === null) return null;

    // index order: start first, then the rest in first-seen order
    const sceneUids: number[] = [start, ...referenced.filter(u => u !== start)];
    if (sceneUids.length < 2) return null;

    const indexOf = (uid: number | null): number | null => {
        const i = exists(uid) ? sceneUids.indexOf(uid) : -1;
        return i >= 0 ? i : null;
    };

    const rewritten = portals.map(p => ({
        position: [p.position[0], p.position[1], p.position[2]] as Vec3,
        rotation: [p.rotation[0], p.rotation[1], p.rotation[2], p.rotation[3]] as Quat,
        width: p.width,
        height: p.height,
        front: indexOf(p.frontUid),
        back: indexOf(p.backUid)
    }));

    const portalScenes = sceneUids.map((_, i) => sceneUrl(i, streaming));
    const portalCollision = collision ? sceneUids.map((_, i) => collisionUrl(i)) : [];

    return { sceneUids, portals: rewritten, portalScenes, portalStart: 0, portalCollision };
};

export { buildPortalBundle, sceneUrl, collisionUrl, ExportPortal, PortalBundle, Vec3, Quat };
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- portal-export`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/portal-export.ts test/portal-export.test.ts
git commit -m "feat(portals): pure export helper — scene set, uid->index map, URL maps"
```

---

### Task 4: `portal-export.ts` — two-tier collision-seed resolver

**Files:**
- Modify: `src/portal-export.ts`
- Test: `test/portal-export.test.ts`

**Interfaces:**
- Produces: `resolveCollisionSeed(args: { sceneIndex: number; sceneUid: number; portals: ExportPortal[]; authored: Record<string, Vec3>; startSeed: Vec3 }) => { seed: Vec3; estimated: boolean }`.
  - Index 0 (start) → `{ seed: startSeed, estimated: false }`.
  - Authored entrypoint present for `sceneUid` → `{ seed: authored, estimated: false }`.
  - Else portal-derived best-effort from the first portal whose front/back is this scene → `{ seed, estimated: true }`.
  - `EYE_HEIGHT = 1.6`, `SIDE_NUDGE = 0.5` exported constants.

- [ ] **Step 1: Write the failing tests** — append to `test/portal-export.test.ts`:

```ts
import { resolveCollisionSeed, EYE_HEIGHT, SIDE_NUDGE } from '../src/portal-export';

const portalAt = (pos: [number, number, number], front: number | null, back: number | null, h = 2) => ({
    position: pos as [number, number, number],
    rotation: [0, 0, 0, 1] as [number, number, number, number],  // identity: up=+Y, normal=+Z
    width: 2, height: h, frontUid: front, backUid: back
});

describe('resolveCollisionSeed', () => {
    it('start scene (index 0) uses the start seed and is not estimated', () => {
        const r = resolveCollisionSeed({ sceneIndex: 0, sceneUid: 10, portals: [], authored: {}, startSeed: [1, 2, 3] });
        expect(r).toEqual({ seed: [1, 2, 3], estimated: false });
    });

    it('authored entrypoint wins and is not estimated', () => {
        const r = resolveCollisionSeed({ sceneIndex: 1, sceneUid: 20, portals: [portalAt([0, 0, 0], 10, 20)], authored: { '20': [5, 6, 7] }, startSeed: [0, 0, 0] });
        expect(r).toEqual({ seed: [5, 6, 7], estimated: false });
    });

    it('portal-derived fallback: floor (bottom edge) + eye height, nudged to the scene side, marked estimated', () => {
        // identity rotation, portal center at y=10, height 2 -> bottom edge y=9; +eye -> 9+1.6.
        // scene 20 is the BACK side -> nudge -Z by SIDE_NUDGE.
        const r = resolveCollisionSeed({ sceneIndex: 1, sceneUid: 20, portals: [portalAt([0, 10, 0], 10, 20)], authored: {}, startSeed: [0, 0, 0] });
        expect(r.estimated).toBe(true);
        expect(r.seed[0]).toBeCloseTo(0, 6);
        expect(r.seed[1]).toBeCloseTo(9 + EYE_HEIGHT, 6);
        expect(r.seed[2]).toBeCloseTo(-SIDE_NUDGE, 6);
    });

    it('front-side scene nudges +Z', () => {
        const r = resolveCollisionSeed({ sceneIndex: 1, sceneUid: 10, portals: [portalAt([0, 10, 0], 10, 20)], authored: {}, startSeed: [0, 0, 0] });
        expect(r.seed[2]).toBeCloseTo(SIDE_NUDGE, 6);
    });

    it('height-stable: a 6m-tall portal still seeds ~eye height above the bottom edge', () => {
        const r = resolveCollisionSeed({ sceneIndex: 1, sceneUid: 10, portals: [portalAt([0, 10, 0], 10, 20, 6)], authored: {}, startSeed: [0, 0, 0] });
        expect(r.seed[1]).toBeCloseTo(10 - 3 + EYE_HEIGHT, 6);  // bottom edge = 10 - 6/2 = 7
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- portal-export`
Expected: FAIL — `resolveCollisionSeed` not exported.

- [ ] **Step 3: Implement (append to `src/portal-export.ts`)**

```ts
const EYE_HEIGHT = 1.6;
const SIDE_NUDGE = 0.5;

// Rotate vector v by unit quaternion q (q * v * q^-1).
const rotateByQuat = (q: Quat, v: Vec3): Vec3 => {
    const [x, y, z, w] = q;
    const tx = 2 * (y * v[2] - z * v[1]);
    const ty = 2 * (z * v[0] - x * v[2]);
    const tz = 2 * (x * v[1] - y * v[0]);
    return [
        v[0] + w * tx + (y * tz - z * ty),
        v[1] + w * ty + (z * tx - x * tz),
        v[2] + w * tz + (x * ty - y * tx)
    ];
};

const resolveCollisionSeed = (args: {
    sceneIndex: number,
    sceneUid: number,
    portals: ExportPortal[],
    authored: Record<string, Vec3>,
    startSeed: Vec3
}): { seed: Vec3, estimated: boolean } => {
    const { sceneIndex, sceneUid, portals, authored, startSeed } = args;

    if (sceneIndex === 0) {
        return { seed: [startSeed[0], startSeed[1], startSeed[2]], estimated: false };
    }

    const a = authored[String(sceneUid)];
    if (a && a.length >= 3) {
        return { seed: [a[0], a[1], a[2]], estimated: false };
    }

    // portal-derived best-effort: first portal whose front/back is this scene
    const p = portals.find(pt => pt.frontUid === sceneUid || pt.backUid === sceneUid);
    if (!p) {
        // no portal references it (shouldn't happen for an exported scene) -> fall back to start seed
        return { seed: [startSeed[0], startSeed[1], startSeed[2]], estimated: true };
    }
    const up = rotateByQuat(p.rotation, [0, 1, 0]);
    const n = rotateByQuat(p.rotation, [0, 0, 1]);
    const sign = p.frontUid === sceneUid ? 1 : -1;
    const hh = p.height * 0.5;
    // S = C - (H/2)*up (bottom edge) + h*worldUp + sign*d*n
    const seed: Vec3 = [
        p.position[0] - hh * up[0] + sign * SIDE_NUDGE * n[0],
        p.position[1] - hh * up[1] + EYE_HEIGHT + sign * SIDE_NUDGE * n[1],
        p.position[2] - hh * up[2] + sign * SIDE_NUDGE * n[2]
    ];
    return { seed, estimated: true };
};

export { resolveCollisionSeed, EYE_HEIGHT, SIDE_NUDGE };
```

> Note: eye-height is raised along **world up** (`+EYE_HEIGHT` on the Y component), while the bottom-edge drop uses **portal local up** (`up`) — matching the spec's tilt handling. For identity rotation these coincide, as the tests assert.

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- portal-export`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/portal-export.ts test/portal-export.test.ts
git commit -m "feat(portals): two-tier collision-seed resolver (authored | portal-derived)"
```

---

## Phase 3 — Export wiring

### Task 5: Extend `ExperienceSettings` + assemble portal fields + per-scene environment UI

**Files:**
- Modify: `src/splat-serialize.ts:114-130` (`ExperienceSettings` type)
- Modify: `src/ui/export-popup.ts:276-341` (per-scene environment UI), `:680-707` (assemble)

**Interfaces:**
- Consumes: `buildPortalBundle` (Task 3), `events.invoke('portals.export')`, `events.invoke('portals.startSplat')`, `events.invoke('portals.exportEntrypoints')`, `events.invoke('scene.allSplats')`.
- Produces: `ExperienceSettings` gains optional `portals`, `portalScenes`, `portalStart`, `portalCollision`, and `portalEnvironments?: ('indoor'|'outdoor')[]` (index-aligned to `portalScenes`); the export popup emits these. The `ViewerExportSettings.collision` stays as the shared `{ radius, voxelSize }`; per-scene environment travels in `portalEnvironments`.

- [ ] **Step 1: Extend the type** in `src/splat-serialize.ts` (`ExperienceSettings`, after `offLimitsMessage`):

```ts
    offLimitsMessage: string,
    // multi-scene portal walkthrough (absent unless portals exist)
    portals?: { position: [number, number, number], rotation: [number, number, number, number], width: number, height: number, front: number | null, back: number | null }[],
    portalScenes?: string[],
    portalStart?: number,
    portalCollision?: (string | null)[],
    portalEnvironments?: ('indoor' | 'outdoor')[],
    startMode: 'default' | 'animTrack' | 'annotation'
```

- [ ] **Step 2: Add per-scene environment selectors in the export popup**

Replace the single `environmentSelect` usage with a per-scene container. After the existing `environmentRow` block (~line 297), add a dynamic container that rebuilds when portals/collision change:

```ts
        // viewer: per-scene environment (portals only). One Interior/Exterior
        // selector per portal-referenced scene; falls back to the single
        // environmentSelect above when there are no portals.
        const perSceneEnvRow = new Container({ class: 'row', flex: true, flexDirection: 'column' });
        const perSceneEnvSelects = new Map<number, SelectInput>();  // sceneIndex -> select

        const rebuildPerSceneEnv = () => {
            perSceneEnvRow.clear();
            perSceneEnvSelects.clear();
            const portals = events.invoke('portals.export') ?? [];
            const startUid = events.invoke('portals.startSplat') ?? null;
            const allSplats = events.invoke('scene.allSplats') ?? [];
            const availableUids = allSplats.map((s: any) => s.uid);
            const bundle = events.invoke('portals.count') > 0
                ? buildPortalBundle({ portals, startUid, availableUids, streaming: streamingToggle.value, collision: true })
                : null;
            if (!bundle) { perSceneEnvRow.hidden = true; return; }
            perSceneEnvRow.hidden = false;
            bundle.sceneUids.forEach((uid, index) => {
                const splat = allSplats.find((s: any) => s.uid === uid);
                const name = splat ? `${uid}: ${(splat.asset?.file?.filename ?? splat.name ?? uid)}` : `Scene ${index}`;
                const row = new Container({ class: 'row' });
                row.append(new Label({ class: 'label', text: name }));
                const sel = new SelectInput({
                    class: 'select',
                    defaultValue: 'indoor',
                    options: [
                        { v: 'indoor', t: localize('popup.export.environment.indoor') },
                        { v: 'outdoor', t: localize('popup.export.environment.outdoor') }
                    ]
                });
                row.append(sel);
                perSceneEnvRow.append(row);
                perSceneEnvSelects.set(index, sel);
            });
        };
```

Append `perSceneEnvRow` to `content` right after `environmentRow` (`content.append(perSceneEnvRow);` near line 393). Import `buildPortalBundle` at the top of `export-popup.ts`. Call `rebuildPerSceneEnv()` from the visibility-refresh logic (where `collisionRow.hidden` is set, ~465) and on `streamingToggle` change. When portals exist, hide the single `environmentRow` and show `perSceneEnvRow`; otherwise the reverse:

```ts
            const hasPortals = (events.invoke('portals.count') ?? 0) > 0;
            environmentRow.hidden = showSub || hasPortals;
            rebuildPerSceneEnv();
            perSceneEnvRow.hidden = perSceneEnvRow.hidden || showSub;
```

- [ ] **Step 3: Assemble portal fields into `experienceSettings`** (in `assembleViewerOptions`, ~line 680). After computing `bgColor`, add:

```ts
                // portal multi-scene bundle (absent when no portals)
                const portalsRaw = events.invoke('portals.export') ?? [];
                const startUid = events.invoke('portals.startSplat') ?? null;
                const allSplats = events.invoke('scene.allSplats') ?? [];
                const availableUids = allSplats.map((s: any) => s.uid);
                const collisionOn = viewerTypeSelect.value === 'zip' && collisionToggle.value;
                const bundle = (events.invoke('portals.count') ?? 0) > 0
                    ? buildPortalBundle({ portals: portalsRaw, startUid, availableUids, streaming: streamingToggle.value, collision: collisionOn })
                    : null;
```

Then in the `experienceSettings` object literal add (when `bundle` is non-null):

```ts
                    ...(bundle ? {
                        portals: bundle.portals,
                        portalScenes: bundle.portalScenes,
                        portalStart: bundle.portalStart,
                        portalCollision: bundle.portalCollision,
                        portalEnvironments: bundle.sceneUids.map((_, i) => (perSceneEnvSelects.get(i)?.value ?? 'indoor') as 'indoor' | 'outdoor')
                    } : {}),
```

- [ ] **Step 4: Type-check + build**

Run: `npx tsc --noEmit && npm run build`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add src/splat-serialize.ts src/ui/export-popup.ts
git commit -m "feat(portals): export settings carry portal bundle + per-scene environment"
```

---

### Task 6: Multi-scene serialization loop + per-scene collision + scene-prefixed progress

**Files:**
- Modify: `src/splat-serialize.ts` (`serializeViewer`)
- Modify: `src/splat-export-core.ts` (`writeViewerCore` / a new `writePortalScenes` helper)

**Interfaces:**
- Consumes: `ExperienceSettings.portals*` fields (Task 5), `extractDataTable`, `writeSogCore`/`writeViewerCore` internals (`writeSog`, `writeLod`, `writeCollisionVoxel`, `ZipFileSystem`, `MemoryFileSystem`), `resolveCollisionSeed` (Task 4), `events.invoke('scene.allSplats')` results passed in as `Splat[]`.
- Produces: the ZIP gains `scenes/N/...` payloads + `scenes/N/scene.voxel.json` for every extra scene; warnings fired via `events` for estimated seeds.

This task touches dependency-internal writers; it is gated by `npm run build` + the Task 12 E2E (no unit test — the writers need a GPU device).

- [ ] **Step 1: Thread all portal scenes into `serializeViewer`**

`serializeViewer` currently extracts a single `dataTable` from the visible `splats`. The exported viewer's **primary** scene stays the passed `splats`; the **extra** scenes must be gathered from ALL splats (incl. hidden) by uid. Change `serializeViewer` (`src/splat-serialize.ts`) to accept the full splat list and the bundle:

```ts
const serializeViewer = async (splats: Splat[], serializeSettings: SerializeSettings, options: ViewerExportSettings, fs: FileSystem): Promise<void> => {
    const { experienceSettings, events, collision } = options;
    const dataTable = extractDataTable(splats, serializeSettings);
    const viewerType = options.type === 'html' ? 'html' : (options.streaming ? 'streaming' : 'package');

    // Build per-scene extra tables for a portal walkthrough. The primary scene
    // is index 0 (the passed `splats` / `dataTable`); extra scenes are looked up
    // by uid against the full scene list so hidden scenes still export.
    const extraScenes = (experienceSettings.portalScenes && experienceSettings.portalScenes.length > 1)
        ? options.portalScenes?.slice(1).map((entry) => ({
            url: entry.url,
            collisionUrl: entry.collisionUrl,
            environment: entry.environment,
            seed: entry.seed,
            dataTable: extractDataTable([entry.splat], serializeSettings)
        })) ?? []
        : [];

    await writeViewerCore(dataTable, experienceSettings, viewerType, createGpuDevice, fs, events, undefined, undefined, collision, extraScenes);
};
```

Add to `ViewerExportSettings` (in `splat-serialize.ts`) a resolved `portalScenes?` array carrying the actual `Splat` objects + per-scene seed/environment (assembled by the caller in Step 2):

```ts
type ViewerExportSettings = {
    type: 'html' | 'zip';
    streaming?: boolean;
    experienceSettings: ExperienceSettings;
    collision?: { environment: 'indoor' | 'outdoor'; radius: number; voxelSize: number };
    events?: Events;
    // resolved per-scene export inputs for a portal walkthrough (index 0 = primary, omitted)
    portalScenes?: { splat: Splat; url: string; collisionUrl: string | null; environment: 'indoor' | 'outdoor'; seed: [number, number, number] }[];
};
```

- [ ] **Step 2: Resolve `portalScenes` (with seeds) in `file-handler.ts`**

The popup emits index-based settings; `file-handler.ts:719` calls `serializeViewer`. Before that call, when `experienceSettings.portals` exists, resolve each scene index to its `Splat` + seed. In `file-handler.ts`, in the `htmlViewer`/`packageViewer` case:

```ts
                case 'htmlViewer':
                case 'packageViewer': {
                    const es = viewerExportSettings!.experienceSettings;
                    let portalScenes;
                    if (es.portalScenes && es.portalScenes.length > 1) {
                        const all = events.invoke('scene.allSplats') as Splat[];
                        const byUid = (uid: number) => all.find(s => s.uid === uid) ?? null;
                        const portalsRaw = events.invoke('portals.export') ?? [];
                        const authored = events.invoke('portals.exportEntrypoints') ?? {};
                        const startSeed = collisionSeedTuple(es);  // start-camera seed [x,y,z], see helper below
                        // sceneUids recomputed deterministically the SAME way as the popup
                        const bundle = buildPortalBundle({
                            portals: portalsRaw,
                            startUid: events.invoke('portals.startSplat') ?? null,
                            availableUids: all.map(s => s.uid),
                            streaming: !!viewerExportSettings!.streaming,
                            collision: !!es.portalCollision && es.portalCollision.length > 0
                        })!;
                        portalScenes = bundle.sceneUids.slice(1).map((uid, i) => {
                            const index = i + 1;
                            const { seed, estimated } = resolveCollisionSeed({
                                sceneIndex: index, sceneUid: uid, portals: portalsRaw, authored, startSeed
                            });
                            if (estimated && es.portalEnvironments?.[index] === 'indoor') {
                                events.fire('progressUpdate', { text: `Scene ${index}: using an estimated collision entrypoint — set one in the portals panel if collision looks wrong.` });
                                console.warn(`Portal export: scene index ${index} (uid ${uid}) used an estimated collision entrypoint.`);
                            }
                            return {
                                splat: byUid(uid)!,
                                url: es.portalScenes![index],
                                collisionUrl: es.portalCollision?.[index] ?? null,
                                environment: es.portalEnvironments?.[index] ?? 'indoor',
                                seed
                            };
                        });
                    }
                    await serializeViewer(splats, serializeSettings, { ...viewerExportSettings!, events, portalScenes }, fs);
                    break;
                }
```

Add a tiny local helper `collisionSeedTuple(es)` in `file-handler.ts` returning `es.cameras?.[0]?.initial?.position ?? [0,0,0]`. Import `buildPortalBundle`, `resolveCollisionSeed` from `../portal-export` and `Splat` as needed.

- [ ] **Step 3: Write the extra scenes in `splat-export-core.ts`**

Extend `writeViewerCore` with a trailing `extraScenes` param and, after the primary scene is written into the ZIP (the `package`/`streaming` branches), write each extra scene under `scenes/N/`. Add a helper that, given a `MemoryFileSystem` and an extra scene, writes its SOG or LOD bundle + voxel and namespaces every key under `scenes/N/`:

```ts
// Write one extra portal scene's payload into memFs under `scenes/<index>/`.
const writePortalScene = async (
    memFs: MemoryFileSystem,
    index: number,
    scene: { dataTable: DataTable; streaming: boolean; collisionUrl: string | null; environment: 'indoor' | 'outdoor'; seed: [number, number, number] },
    createDevice: DeviceCreator,
    radius: number,
    voxelSize: number
): Promise<void> => {
    const base = `scenes/${index}`;
    const sub = new MemoryFileSystem();
    if (scene.streaming) {
        const lodTable = await buildStreamingLodTable(scene.dataTable.clone(), createDevice);
        await writeLod({ filename: '/lod-meta.json', dataTable: lodTable, envDataTable: null, iterations: 10, createDevice, chunkCount: 512, chunkExtent: 16 }, sub);
    } else {
        await writeSog({ filename: 'scene.sog', dataTable: scene.dataTable, bundle: true, iterations: 10, createDevice, logging: 'silent' }, sub);
    }
    if (scene.collisionUrl) {
        // reuse writeCollisionVoxel with a per-scene seed + environment by
        // synthesizing a minimal settings object that carries the seed as the
        // start camera position and the chosen environment.
        const fakeSettings = { cameras: [{ initial: { position: scene.seed } }] };
        await writeCollisionVoxel(sub, scene.dataTable, fakeSettings, createDevice, { environment: scene.environment, radius, voxelSize });
        // writeCollisionVoxel emits index.voxel.json/.bin — rename to scene.voxel.*
        for (const name of ['index.voxel.json', 'index.voxel.bin']) {
            const data = sub.results.get(name);
            if (data) { sub.results.set(name.replace('index.', 'scene.'), data); sub.results.delete(name); }
        }
    }
    // namespace every emitted key under scenes/<index>/
    for (const [name, data] of sub.results.entries()) {
        memFs.results.set(`${base}/${name.replace(/^\/+/, '')}`, data);
    }
};
```

> `writeCollisionVoxel` and `writeStreamingLodTable` are already module-private in this file; export-import not needed. `collisionSeedFromSettings` reads `cameras[0].initial.position`, so the synthesized `fakeSettings` makes the per-scene seed drive the voxel. Confirm `writeCollisionVoxel`'s signature accepts a settings-like object with just `cameras` (it does — it only reads `cameras?.[0]?.initial?.position`).

Call `writePortalScene` for each `extraScenes[i]` inside the `package` branch (and the `streaming` branch) of `writeViewerCore`, **before** the ZIP-write loop, using the shared `collision.radius`/`collision.voxelSize` (defaulting to 50 / 0.05 when collision is off but portals carry collision URLs — guard so voxels are only written when `scene.collisionUrl` is set). Pass `extraScenes` through the function signature and forward it from `writeStreamingViewerCore` similarly.

- [ ] **Step 4: Scene-prefixed progress**

Wrap the per-scene writes with the existing prefix mechanism. Before each extra scene, set the renderer's phase prefix to `Scene ${index+1}/${total} (${name})` by passing a `getPrefix` that reads a mutable `currentScenePrefix` variable (mirror `writeStreamingViewerCore`'s `phase` pattern). For the non-streaming `package` path (which today passes no prefix), introduce the same `getPrefix` wiring so labels read `Scene 2/3: <step>`.

- [ ] **Step 5: Build**

Run: `npx tsc --noEmit && npm run build`
Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add src/splat-serialize.ts src/splat-export-core.ts src/file-handler.ts
git commit -m "feat(portals): export every portal scene into scenes/N/ with per-scene collision"
```

---

### Task 7: `injectPortals` payload builder + wire into export-core

**Files:**
- Create: `src/viewer-companion/portals.ts` (builder half only in this task; runtime companion in Tasks 10–11)
- Modify: `src/splat-export-core.ts` (`injectPortals` alongside `injectOffLimitsZones`)
- Test: `test/portals-injection.test.ts` (mirror `test/off-limits-zones-injection.test.ts`)

**Interfaces:**
- Consumes: `ExperienceSettings.portals*` from `viewerSettingsJson`.
- Produces: `buildPortalsInjection(viewerSettingsJson) => string` — returns `''` when no portals; otherwise `<script>window.__supersplatPortals = {...}</script><script>${runtime}</script>` (HTML-escaped payload, mirroring `buildOffLimitsZonesInjection`).

- [ ] **Step 1: Write the failing test** — `test/portals-injection.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import { buildPortalsInjection } from '../src/viewer-companion/portals';

describe('buildPortalsInjection', () => {
    it('returns empty string when there are no portals', () => {
        expect(buildPortalsInjection({})).toBe('');
        expect(buildPortalsInjection({ portals: [] })).toBe('');
    });

    it('emits the payload global and a runtime script when portals exist', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/scene.sog'],
            portalStart: 0,
            portalCollision: [],
            portalEnvironments: ['indoor', 'indoor']
        });
        expect(out).toContain('window.__supersplatPortals');
        expect(out).toContain('scenes/1/scene.sog');
        expect(out).toContain('<script>');
        // payload is HTML-escaped (no raw </script> break-out)
        expect(out).not.toContain('</script>'.replace('>', '>') + 'window');
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- portals-injection`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the builder** in `src/viewer-companion/portals.ts` (runtime companion is a stub string for now, filled in Tasks 10–11):

```ts
import { segmentCrossesRect, resolveActiveSplat } from '../portal-geom';

// Runtime companion injected verbatim. Filled in Tasks 10-11; for now it wires
// the crossing helpers and a no-op so the injection shape is testable.
const companionRuntime = `
(function () {
  var data = window.__supersplatPortals;
  if (!data || !data.portals || !data.portalScenes || data.portalScenes.length < 2) return;
  var segmentCrossesRect = ${segmentCrossesRect.toString()};
  var resolveActiveSplat = ${resolveActiveSplat.toString()};
  // --- runtime body added in Tasks 10-11 ---
})();
`;

const buildPortalsInjection = (viewerSettingsJson: any): string => {
    const portals = viewerSettingsJson?.portals;
    if (!portals || portals.length === 0) {
        return '';
    }
    const payload = {
        portals,
        portalScenes: viewerSettingsJson.portalScenes ?? [],
        portalStart: viewerSettingsJson.portalStart ?? 0,
        portalCollision: viewerSettingsJson.portalCollision ?? [],
        portalEnvironments: viewerSettingsJson.portalEnvironments ?? []
    };
    const payloadJson = JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/ /g, '\u2028')   // mirror buildOffLimitsZonesInjection escaping (off-limits-zones.ts)
    .replace(/ /g, '\u2029');
    return `<script>window.__supersplatPortals = ${payloadJson};</script>` +
        `<script>${companionRuntime}</script>`;
};

export { buildPortalsInjection };
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm test -- portals-injection`
Expected: PASS.

- [ ] **Step 5: Wire into `splat-export-core.ts`**

Add an `injectPortals` function mirroring `injectOffLimitsZones` (it needs the same `window.__supersplatViewer` publish anchor — already added by `injectOffLimitsZones`; make `injectPortals` reuse the published handle, so just inject before `</body>`):

```ts
import { buildPortalsInjection } from './viewer-companion/portals';

const injectPortals = (html: string, viewerSettingsJson: any): string => {
    const injection = buildPortalsInjection(viewerSettingsJson);
    if (!injection) return html;
    // ensure the viewer handle is published (idempotent with injectOffLimitsZones)
    const bootstrap = 'const viewer = await main(canvas, settingsJson, config);';
    const withHandle = (html.includes(bootstrap) && !html.includes('window.__supersplatViewer = viewer;'))
        ? html.replace(bootstrap, `${bootstrap} window.__supersplatViewer = viewer;`)
        : html;
    return withHandle.includes('</body>') ? withHandle.replace('</body>', `${injection}</body>`) : withHandle + injection;
};
```

Call `injectPortals(...)` in the `package` and `streaming` branches right after `injectOffLimitsZones(...)` (chain it: `const withPortals = injectPortals(withZones, viewerSettingsJson);` then set that into `index.html`).

- [ ] **Step 6: Build**

Run: `npx tsc --noEmit && npm run build`
Expected: both succeed.

- [ ] **Step 7: Commit**

```bash
git add src/viewer-companion/portals.ts src/splat-export-core.ts test/portals-injection.test.ts
git commit -m "feat(portals): inject portal payload + companion shell into the exported viewer"
```

---

## Phase 4 — Verification gates (spikes, BEFORE the runtime companion)

> These are the two dependency-internal risks from spec §8. Run them as real experiments against an actual export before writing the runtime body (Tasks 10–11). Each has a documented fallback. Record findings in a comment block at the top of `src/viewer-companion/portals.ts`.

### Task 8: Spike — dynamic streaming gsplat-asset creation + disabled-entity residency

- [ ] **Step 1:** Export a 2-scene ZIP with **streaming OFF** (SOG) first using the current build (Tasks 1–7 produce the bundle + scenes; the companion is still a no-op). Unzip and confirm `scenes/1/scene.sog`, `scenes/1/scene.voxel.json` exist and `settings.json` (the viewer settings) contains the `portals`/`portalScenes` block. Open `index.html` in a local server (`npx serve` or similar). In DevTools console, confirm `window.__supersplatViewer` exists and resolve the app handle:

```js
const app = window.__supersplatViewer.debugPanel?._global?.app || window.__supersplatViewer.navCursor?.app;
console.log(!!app, !!app.assets, !!app.scene.gsplat);
```

Expected: `true true true`. Record which path resolved the app.

- [ ] **Step 2:** Manually create a second gsplat from `scenes/1/scene.sog` in the console and confirm it renders when enabled and disappears when disabled:

```js
const A = window.__supersplatViewer.debugPanel._global.app;
const startEntity = A.root.findComponent('gsplat').entity;
const Asset = startEntity.gsplat.asset.constructor;
const Entity = startEntity.constructor;
const asset = new Asset('s1', 'gsplat', { url: 'scenes/1/scene.sog' });
A.assets.add(asset); A.assets.load(asset);
asset.ready(() => {
  const e = new Entity('s1'); e.addComponent('gsplat', { unified: true, asset });
  e.setLocalPosition(startEntity.getLocalPosition()); e.setLocalRotation(startEntity.getLocalRotation()); e.setLocalScale(startEntity.getLocalScale());
  A.root.addChild(e); e.enabled = false; window.__t = e; A.renderNextFrame = true;
});
// then: window.__t.enabled = true (should appear), = false (should vanish)
```

Expected: toggling `enabled` shows/hides the second scene with no haze when only one is enabled. Record the exact app-handle + constructor-access path that worked.

- [ ] **Step 3:** Repeat Step 1–2 with **streaming ON**, pointing the asset at `scenes/1/lod-meta.json`. Confirm the streaming asset loads (coarse first), renders on enable, and that while disabled it does not stream full detail. **If streaming-asset creation fails** (asset never readies, or the parser rejects the dynamic URL): record the failure and adopt the **SOG fallback** — Task 5's bundle should force `streaming:false` for portal exports (add a guard in the popup: portals + zip ⇒ disable/ignore the streaming toggle, with a localized note). Update the spec §8 outcome.

- [ ] **Step 4:** Commit findings (a comment block; no code change if both passed):

```bash
git add src/viewer-companion/portals.ts
git commit -m "spike(portals): verify dynamic multi-scene gsplat creation in exported viewer"
```

### Task 9: Spike — runtime collision swap

- [ ] **Step 1:** In the same exported viewer console, confirm the collision class + setter:

```js
const cm = window.__supersplatViewer.cameraManager;
console.log(cm.collision && cm.collision.constructor.name);   // VoxelCollision / FlippedVoxelCollision
```

- [ ] **Step 2:** Fetch `scenes/1/scene.voxel.json` + `.bin`, slice into `nodes`/`leafData`, build a new instance via `cm.collision.constructor`, and assign `cm.collision = newInstance`. Confirm the camera now collides against scene 1's geometry (walk into a wall). Record the exact metadata field names (`nodeCount`, `leafDataCount`) by inspecting the fetched JSON — they drive the slicing in Task 11.

- [ ] **Step 3:** **If the swap fails** (constructor shape differs, or setter doesn't propagate): adopt the **start-scene-only collision fallback** — Task 11 still preloads nothing extra; only the start scene's collision stays active. Voxels remain bundled (export already correct). Update spec §8 outcome.

- [ ] **Step 4:** Commit findings:

```bash
git add src/viewer-companion/portals.ts
git commit -m "spike(portals): verify runtime collision-volume swap in exported viewer"
```

---

## Phase 5 — Viewer companion runtime

### Task 10: Companion runtime — multi-scene creation + per-frame scene switch

**Files:**
- Modify: `src/viewer-companion/portals.ts` (`companionRuntime`)

**Interfaces:**
- Consumes: `window.__supersplatPortals`, `window.__supersplatViewer`, `segmentCrossesRect`/`resolveActiveSplat` (injected), the app-handle path confirmed in Task 8.
- Produces: at runtime, one disabled gsplat entity per extra scene; per-frame enable-toggle on portal crossings. No exported symbols.

Gated by build + Task 12 E2E (dep-internal; not unit-testable).

- [ ] **Step 1: Replace the `companionRuntime` body** with the verified switching logic (use the exact app-handle path Task 8 recorded; the code below uses the documented primary path with the navCursor fallback):

```js
const companionRuntime = `
(function () {
  var data = window.__supersplatPortals;
  if (!data || !data.portals || !data.portalScenes || data.portalScenes.length < 2) return;
  var resolveActiveSplat = ${resolveActiveSplat.toString()};
  var segmentCrossesRect = ${segmentCrossesRect.toString()};

  function getApp(v) { return (v && v.debugPanel && v.debugPanel._global && v.debugPanel._global.app) || (v && v.navCursor && v.navCursor.app) || null; }

  var entities = [];          // index -> gsplat Entity (index 0 = start, filled below)
  var activeIndex = data.portalStart || 0;
  var lastSafe = null;

  // portal rects with index-based front/back for resolveActiveSplat
  var rects = data.portals.map(function (p) {
    return { position: p.position, rotation: p.rotation, width: p.width, height: p.height, frontUid: p.front, backUid: p.back };
  });

  function start() {
    var viewer = window.__supersplatViewer;
    var app = getApp(viewer);
    var cm = viewer && viewer.cameraManager;
    if (!app || !cm || !cm.camera) { requestAnimationFrame(start); return; }

    var startComp = app.root.findComponent('gsplat');
    if (!startComp) { requestAnimationFrame(start); return; }
    var startEntity = startComp.entity;
    var Asset = startEntity.gsplat.asset.constructor;
    var Entity = startEntity.constructor;
    entities[0] = startEntity;

    for (var i = 1; i < data.portalScenes.length; i++) {
      (function (idx) {
        var url = data.portalScenes[idx];
        var asset = new Asset('portalScene' + idx, 'gsplat', { url: url });
        app.assets.add(asset);
        app.assets.load(asset);
        asset.ready(function () {
          var e = new Entity('portalScene' + idx);
          e.addComponent('gsplat', { unified: true, asset: asset });
          e.setLocalPosition(startEntity.getLocalPosition());
          e.setLocalRotation(startEntity.getLocalRotation());
          e.setLocalScale(startEntity.getLocalScale());
          app.root.addChild(e);
          e.enabled = (idx === activeIndex);
          entities[idx] = e;
          app.renderNextFrame = true;
        });
        asset.on('error', function (err) { console.warn('portal scene ' + idx + ' failed to load:', err); });
      })(i);
    }
    // make sure the start scene matches activeIndex (it's the only enabled one)
    applyActive();
    requestAnimationFrame(tick);
  }

  function applyActive() {
    for (var i = 0; i < entities.length; i++) {
      if (entities[i]) entities[i].enabled = (i === activeIndex);
    }
    var app = getApp(window.__supersplatViewer);
    if (app) app.renderNextFrame = true;
  }

  function tick() {
    var viewer = window.__supersplatViewer;
    var cm = viewer && viewer.cameraManager;
    var cam = cm && cm.camera;
    if (cam && cam.position) {
      var cur = [cam.position.x, cam.position.y, cam.position.z];
      if (lastSafe) {
        var next = resolveActiveSplat(lastSafe, cur, rects, activeIndex);
        if (next !== activeIndex && next !== null && entities[next]) {
          activeIndex = next;
          applyActive();
          if (window.__supersplatPortalsOnSwitch) window.__supersplatPortalsOnSwitch(next);  // collision hook (Task 11)
        }
      }
      lastSafe = cur;
    }
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(start);
})();
`;
```

> If Task 8 recorded that `asset.ready` is unavailable, use `asset.on('load', ...)` instead (both exist on `Asset`); keep whichever the spike confirmed.

- [ ] **Step 2: Build**

Run: `npx tsc --noEmit && npm run build`
Expected: both succeed (the runtime is a template string — type-checking only covers the surrounding TS).

- [ ] **Step 3: Commit**

```bash
git add src/viewer-companion/portals.ts
git commit -m "feat(portals): runtime companion creates + switches multi-scene gsplats in the viewer"
```

---

### Task 11: Companion collision preload + swap

**Files:**
- Modify: `src/viewer-companion/portals.ts` (`companionRuntime`)

**Interfaces:**
- Consumes: `data.portalCollision`, the collision constructor + metadata field names confirmed in Task 9, the `window.__supersplatPortalsOnSwitch` hook from Task 10.
- Produces: per-scene collision volumes preloaded; the active one assigned to `cameraManager.collision` on switch.

- [ ] **Step 1: Add a self-contained voxel loader + preload + swap** to `companionRuntime` (inside the IIFE, before `start`). Use the metadata field names Task 9 recorded:

```js
  var collisions = [];   // index -> collision instance (or null)
  function loadVoxel(url, Ctor) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('voxel json ' + r.status);
      return r.json();
    }).then(function (meta) {
      var binUrl = url.replace('.voxel.json', '.voxel.bin');
      return fetch(binUrl).then(function (rb) {
        if (!rb.ok) throw new Error('voxel bin ' + rb.status);
        return rb.arrayBuffer();
      }).then(function (buf) {
        var view = new Uint32Array(buf);
        var nodes = view.slice(0, meta.nodeCount);
        var leafData = view.slice(meta.nodeCount, meta.nodeCount + meta.leafDataCount);
        return new Ctor(meta, nodes, leafData);
      });
    });
  }

  function preloadCollisions() {
    var cm = window.__supersplatViewer && window.__supersplatViewer.cameraManager;
    if (!cm || !cm.collision || !data.portalCollision || data.portalCollision.length === 0) return;
    var Ctor = cm.collision.constructor;
    collisions[activeIndex] = cm.collision;   // the viewer already loaded the start collision
    for (var i = 0; i < data.portalCollision.length; i++) {
      (function (idx) {
        var url = data.portalCollision[idx];
        if (!url || collisions[idx]) return;
        loadVoxel(url, Ctor).then(function (inst) { collisions[idx] = inst; })
          .catch(function (err) { console.warn('portal collision ' + idx + ' failed:', err); });
      })(i);
    }
  }

  window.__supersplatPortalsOnSwitch = function (idx) {
    var cm = window.__supersplatViewer && window.__supersplatViewer.cameraManager;
    if (cm && collisions[idx]) cm.collision = collisions[idx];
  };
```

Call `preloadCollisions();` at the end of `start()` (after the asset-creation loop).

- [ ] **Step 2: Build**

Run: `npx tsc --noEmit && npm run build`
Expected: both succeed.

- [ ] **Step 3: Commit**

```bash
git add src/viewer-companion/portals.ts
git commit -m "feat(portals): runtime per-scene collision preload + swap on portal crossing"
```

---

## Phase 6 — Localization, E2E, finish

### Task 12: Locale strings, end-to-end verification, branch finish

**Files:**
- Modify: `src/ui/localization/*` (every locale file)

**Interfaces:** none.

- [ ] **Step 1: Add locale strings.** Find the locale files and the existing `popup.export.environment*` / `portals.*` keys:

Locate them with the Grep tool (pattern `popup.export.environment` or `portals\.add`) over `src/ui/localization` to find every locale file and the existing key style.

Add to **every** locale file (en first, then de/es/fr/ja/ko/pt/ru/zh — translate; copy en for any you cannot translate confidently and leave a `// TODO translate` is NOT allowed — use the English string as the value, which is the project's existing fallback practice):
- `portals.entrypoint` = "Entrypoint" (fr: "Point d'entrée")
- `portals.entrypoint.set` = "Set from camera" (fr: "Définir depuis la caméra")
- `portals.entrypoint.clear` = "Clear" (fr: "Effacer")

(Mirror the exact key style already used by `portals.add` / `portals.move` in the locale files.)

- [ ] **Step 2: Build + full test run**

Run: `npx tsc --noEmit && npm run build && npm test`
Expected: build clean; all tests pass except the known 3 `server/test/*` `tsx` failures.

- [ ] **Step 3: Manual E2E (the real acceptance test).**

Using the two-floor `RdC` + `Etage` Maison_Bueil captures:
1. Load both, align if needed (already aligned in prior work).
2. Portals tool → add a portal in the stairwell, front = RdC, back = Etage; set the start scene = RdC.
3. For Etage, set an entrypoint (stand on the upper floor → Set from camera).
4. Export → ZIP, collision ON, set RdC=indoor / Etage=indoor, streaming per Task 8's outcome.
5. Unzip, serve, open `index.html`.
6. Walk from RdC through the stairwell portal → confirm the visible scene swaps to Etage, and the camera collides against Etage's floor/walls (not RdC's). Walk back → swaps to RdC.
7. Re-export with **no** portals (delete them) → confirm the viewer is byte-identical behaviour to before (single scene, no console errors, no `__supersplatPortals`).

Record results. If a verification-gated fallback (Task 8/9) was triggered, confirm the fallback behaves correctly (SOG instead of streaming; start-only collision).

- [ ] **Step 4: Commit locales.**

```bash
git add src/ui/localization
git commit -m "feat(portals): localized strings for per-scene entrypoint authoring"
```

- [ ] **Step 5: Finish the branch.** Invoke `superpowers:finishing-a-development-branch` — squash all commits (including the design spec and this plan) into ONE commit summarizing the feature, and merge to local `main` per project convention (do NOT push unless the user asks).

---

## Self-Review

**Spec coverage:**
- §2 feasibility / app handle → Tasks 8–9 (verify), 10–11 (use). ✓
- §3 scope (ZIP, N-scene, streaming-toggle, preload-all, per-scene env) → Tasks 5, 6, 10. ✓
- §5.1 include hidden scenes (`scene.allSplats`) → Tasks 5, 6. ✓
- §5.2 per-scene `extractDataTable`, shared world frame → Task 6. ✓
- §5.3 `scenes/N/` layout (SOG + streaming) → Tasks 3, 6. ✓
- §5.4 uid→index map + reference rewrite + URL maps → Task 3. ✓
- §5.5 `ExperienceSettings` extension → Task 5. ✓
- §5.6 two-tier seed + multi-portal + missing-entrypoint warning → Tasks 4, 6. ✓
- §5.7 scene-prefixed progress → Task 6 Step 4. ✓
- §5.8 editor entrypoint authoring (data model, dot, gizmo, camera-capture, own commits, scope guard) → Tasks 1, 2. ✓
- §6 companion (handle, asset creation, switch, collision swap) → Tasks 7, 10, 11. ✓
- §7 error handling (graceful degrade, no throw in frame loop) → Tasks 10, 11 (try/load guards, `findComponent` polling). ✓
- §8 verification gates + fallbacks → Tasks 8, 9. ✓
- §9 testing (pure units, build gates, E2E) → Tasks 1, 3, 4, 7 (units); 12 (E2E). ✓

**Placeholder scan:** No "TBD"/"handle errors appropriately"; all code steps contain concrete code. The single intentional unknown — the exact app-handle/constructor/metadata-field names — is resolved by the explicit spike Tasks 8–9 before the runtime tasks consume them, with concrete candidate code given.

**Type consistency:** `buildPortalBundle` / `PortalBundle.sceneUids` / `portalScenes` / `portalCollision` names match across Tasks 3, 5, 6. `resolveCollisionSeed` signature matches between Task 4 (def) and Task 6 (use). `UpdatePortalEntrypointOp` signature matches between Tasks 1 (def) and 2 (use). `buildPortalsInjection(viewerSettingsJson)` matches between Tasks 7 (def) and the export-core call.

**Known sequencing risk:** Tasks 5 and 6 both call `buildPortalBundle` to recompute `sceneUids`; they MUST pass identical `streaming`/`collision`/`availableUids` so the index order matches the emitted `portalScenes`. Task 6 Step 2 recomputes the bundle from the same inputs deterministically — keep that invariant (the function is pure and order-stable).
