# Portals (editor sub-project) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an author place portal rectangles between loaded 3DGS scenes and, in a "Walkthrough" mode, navigate a multi-scene experience where crossing a portal swaps the visible scene — all inside the SuperSplat editor viewport.

**Architecture:** Mirror the existing off-limits-zones subsystem (rectangle data + edit ops + events module + gizmo tool + custom-shader shape). Add a playcanvas-free geometry module for portal crossing math (adapted from the off-limits viewer collision). Switching runs only while a non-destructive "Walkthrough" toggle is on: it snapshots splat visibility, seeds a start scene, and each frame tests the camera movement segment against every portal, swapping which splat is visible.

**Tech Stack:** TypeScript, PlayCanvas engine, `@playcanvas/pcui` widgets, the project `Events` bus, vitest (node env), rollup build, eslint.

## Global Constraints

- **Splat references use `uid` (number)**, matching the existing splat-dropdown pattern in `src/ui/alignment-panel.ts:111-133`. This refines the design spec's loose "SplatId" wording. `uid` is session-scoped; portal bindings persist across a document reload only if splats reload in the same order — flagged as a known v1 limitation, not solved here.
- **Pure geometry stays playcanvas-free.** `src/portal-geom.ts` must import nothing from `playcanvas` (importing playcanvas under vitest's node env hangs — the reason `merge-cut-geom.ts` / `alignment-solve.ts` exist as pure modules). Use plain tuple/array math.
- **Local rectangle frame:** a portal is a unit quad in its local XY plane, normal local +Z, scaled to `width × height`. Local +Z side = "front", local −Z side = "back". This is identical to the off-limits zone frame, so the gizmo entity rotation IS the portal rotation (no orientation correction).
- **No new dependencies.** Reuse existing pcui widgets and engine classes only.
- **Verification per task:** `npx tsc --noEmit` (clean), `npm run test` (green), `npm run lint` (no new errors) where the task touches `src/`. eslint note: do NOT run `eslint --fix` on import/order (the pinned eslint@10 crashes on that autofix); fix import order by hand if flagged.
- **Commits:** conventional-commit subject; end every commit message body with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Work on branch `feat/portals` (already created, holds the design spec).

## File Structure

**New files:**
- `src/portal-geom.ts` — pure crossing math: `segmentCrossesRect`, `resolveActiveSplat`, types `PortalRect`, `Vec3`, `Quat`. No playcanvas import.
- `test/portal-geom.test.ts` — unit tests for the above.
- `src/portals.ts` — portal data model, edit ops, `registerPortalsEvents` (state, queries, mutators, selection, serialization, export).
- `test/portals.test.ts` — unit tests for ops + serialization round-trip.
- `src/portal-shape.ts` — `PortalShape` custom-shader rectangle (clone of `off-limits-zone-shape.ts`, distinct color).
- `src/tools/portal-tool.ts` — `PortalTool` gizmo authoring tool (clone of `off-limits-zone-tool.ts`, front/back/start scene pickers).
- `src/portals-runtime.ts` — `registerPortalsRuntime`: walkthrough enable/disable, per-frame switching.
- `src/ui/svg/portal.svg` — toolbar/toggle icon.

**Modified files:**
- `src/main.ts` — register portal events, runtime, and tool.
- `src/doc.ts` — serialize/deserialize portals + start splat.
- `src/ui/scene-panel.ts` — "Walkthrough" toggle button next to "Solo Selected".
- `src/ui/bottom-toolbar.ts` — portal authoring toolbar button.
- `src/ui/scss/select-toolbar.scss` — add the missing `.active` background (fixes off-limits too).
- `static/locales/en.json` — `portals.*` and `tooltip.scene.walkthrough` keys.

---

### Task 1: Pure portal crossing geometry

**Files:**
- Create: `src/portal-geom.ts`
- Test: `test/portal-geom.test.ts`

**Interfaces:**
- Produces:
  - `type Vec3 = [number, number, number]`
  - `type Quat = [number, number, number, number]`
  - `type PortalRect = { position: Vec3, rotation: Quat, width: number, height: number, frontUid: number | null, backUid: number | null }`
  - `segmentCrossesRect(prev: Vec3, cur: Vec3, rect: PortalRect): { side: 'front' | 'back', t: number } | null`
  - `resolveActiveSplat(prev: Vec3, cur: Vec3, portals: PortalRect[], currentUid: number | null): number | null`

- [ ] **Step 1: Write the failing test**

Create `test/portal-geom.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import { segmentCrossesRect, resolveActiveSplat, PortalRect } from '../src/portal-geom';

const rect = (over: Partial<PortalRect> = {}): PortalRect => ({
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1], // identity: local frame == world, normal +Z
    width: 4,
    height: 4,
    frontUid: 10,
    backUid: 20,
    ...over
});

describe('segmentCrossesRect', () => {
    it('reports a front-side crossing through the rectangle', () => {
        const c = segmentCrossesRect([0, 0, -1], [0, 0, 1], rect());
        expect(c).toEqual({ side: 'front', t: 0.5 });
    });

    it('reports a back-side crossing when moving the other way', () => {
        const c = segmentCrossesRect([0, 0, 1], [0, 0, -1], rect());
        expect(c).toEqual({ side: 'back', t: 0.5 });
    });

    it('returns null when the hit point is outside the width/height extents', () => {
        expect(segmentCrossesRect([10, 0, -1], [10, 0, 1], rect())).toBeNull();
    });

    it('returns null when both endpoints are on the same side', () => {
        expect(segmentCrossesRect([0, 0, 1], [0, 0, 2], rect())).toBeNull();
    });
});

describe('resolveActiveSplat', () => {
    it('returns the current uid when nothing is crossed', () => {
        expect(resolveActiveSplat([0, 0, 1], [0, 0, 2], [rect()], 20)).toBe(20);
    });

    it('switches to the front scene after crossing onto the front side', () => {
        expect(resolveActiveSplat([0, 0, -1], [0, 0, 1], [rect()], 20)).toBe(10);
    });

    it('applies multiple crossings in order along the segment (last wins)', () => {
        const a = rect({ position: [0, 0, 0], frontUid: 10, backUid: 20 });
        const b = rect({ position: [0, 0, 5], frontUid: 30, backUid: 40 });
        // segment from z=-1 to z=6 crosses A (t~0.14) then B (t~0.86)
        expect(resolveActiveSplat([0, 0, -1], [0, 0, 6], [a, b], 20)).toBe(30);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/portal-geom.test.ts`
Expected: FAIL — cannot resolve `../src/portal-geom`.

- [ ] **Step 3: Write minimal implementation**

Create `src/portal-geom.ts`:

```ts
type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

type PortalRect = {
    position: Vec3,
    rotation: Quat,   // unit quaternion [x, y, z, w]
    width: number,
    height: number,
    frontUid: number | null,  // scene on the local +Z side
    backUid: number | null    // scene on the local -Z side
};

// Crossing test for the segment prev -> cur against the portal rectangle.
// Adapted from the off-limits viewer collision (segmentBlockedByWall): same
// local-frame transform (rectangle in local XY, normal local Z), but instead of
// clamping it reports which side the camera ended on and the segment parameter t.
const segmentCrossesRect = (prev: Vec3, cur: Vec3, rect: PortalRect): { side: 'front' | 'back', t: number } | null => {
    const cx = rect.position[0], cy = rect.position[1], cz = rect.position[2];
    const qx = rect.rotation[0], qy = rect.rotation[1], qz = rect.rotation[2], qw = rect.rotation[3];
    const hw = rect.width * 0.5;
    const hh = rect.height * 0.5;

    // Rotate (p - center) into local frame using the inverse (conjugate) rotation.
    const toLocal = (p: Vec3): Vec3 => {
        const x = p[0] - cx, y = p[1] - cy, z = p[2] - cz;
        const ix = -qx, iy = -qy, iz = -qz, iw = qw;
        const tx = 2 * (iy * z - iz * y);
        const ty = 2 * (iz * x - ix * z);
        const tz = 2 * (ix * y - iy * x);
        return [
            x + iw * tx + (iy * tz - iz * ty),
            y + iw * ty + (iz * tx - ix * tz),
            z + iw * tz + (ix * ty - iy * tx)
        ];
    };

    const a = toLocal(prev);
    const b = toLocal(cur);
    const az = a[2], bz = b[2];

    const eps = 1e-9;
    if (az * bz > 0 || az === bz || (Math.abs(az) < eps && Math.abs(bz) < eps)) {
        return null;
    }

    const t = az / (az - bz);
    if (t < 0 || t > 1) {
        return null;
    }

    const ix = a[0] + t * (b[0] - a[0]);
    const iy = a[1] + t * (b[1] - a[1]);
    if (Math.abs(ix) > hw || Math.abs(iy) > hh) {
        return null;
    }

    // The camera ends on the side of `cur`: local +Z is front, -Z is back.
    return { side: bz > 0 ? 'front' : 'back', t };
};

// Walk all portals, apply each crossing in order along the segment, and return
// the resulting active splat uid (or the unchanged current uid if none cross).
const resolveActiveSplat = (prev: Vec3, cur: Vec3, portals: PortalRect[], currentUid: number | null): number | null => {
    const crossings: { t: number, uid: number | null }[] = [];
    for (const p of portals) {
        const c = segmentCrossesRect(prev, cur, p);
        if (c) {
            crossings.push({ t: c.t, uid: c.side === 'front' ? p.frontUid : p.backUid });
        }
    }
    crossings.sort((m, n) => m.t - n.t);
    let active = currentUid;
    for (const c of crossings) {
        if (c.uid !== null) {
            active = c.uid;
        }
    }
    return active;
};

export { segmentCrossesRect, resolveActiveSplat, PortalRect, Vec3, Quat };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/portal-geom.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/portal-geom.ts test/portal-geom.test.ts
git commit -m "$(printf 'feat(portals): pure portal crossing geometry\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: Portal data model, events, and document serialization

**Files:**
- Create: `src/portals.ts`
- Test: `test/portals.test.ts`
- Modify: `src/main.ts` (register events — after line 115 `registerOffLimitsZonesEvents(events);`)
- Modify: `src/doc.ts` (serialize at ~line 165, deserialize at ~line 126)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type PortalData = { id: string, position: [number,number,number], rotation: [number,number,number,number], width: number, height: number, frontUid: number | null, backUid: number | null }`
  - `class AddPortalOp { constructor(events, data: PortalData) }` with `do/undo/destroy`
  - `class RemovePortalOp { constructor(events, data: PortalData, index: number) }`
  - `class UpdatePortalOp { constructor(events, id: string, oldValues: Partial<PortalData>, newValues: Partial<PortalData>) }`
  - `class SetStartSplatOp { constructor(events, oldUid: number | null, newUid: number | null) }`
  - `registerPortalsEvents(events): void`
  - Events fired/queried: `portals.list` (→ `PortalData[]`), `portals.byId` (→ `PortalData|null`), `portals.selected` (→ `string|null`), `portals.newId` (→ `string`), `portals.startSplat` (→ `number|null`), `portals.count` (→ `number`), `portals.insertRaw`, `portals.removeRaw`, `portals.updateRaw`, `portals.setStartRaw`, `portals.select`, `portals.selectionChanged`, `portals.changed`, `portals.export`, `docSerialize.portals`, `docDeserialize.portals`.

- [ ] **Step 1: Write the failing test**

Create `test/portals.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import { AddPortalOp, RemovePortalOp, SetStartSplatOp, PortalData, registerPortalsEvents } from '../src/portals';

// Minimal Events double: function/invoke registry + on/fire listeners.
const makeEvents = () => {
    const fns = new Map<string, (...args: any[]) => any>();
    const listeners = new Map<string, ((...args: any[]) => void)[]>();
    return {
        function(name: string, fn: (...args: any[]) => any) { fns.set(name, fn); },
        invoke(name: string, ...args: any[]) { return fns.get(name)?.(...args); },
        on(name: string, fn: (...args: any[]) => void) {
            const arr = listeners.get(name) ?? [];
            arr.push(fn);
            listeners.set(name, arr);
        },
        fire(name: string, ...args: any[]) { (listeners.get(name) ?? []).forEach(fn => fn(...args)); }
    } as any;
};

const portal = (over: Partial<PortalData> = {}): PortalData => ({
    id: 'portal_0',
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    width: 2,
    height: 2,
    frontUid: 1,
    backUid: 2,
    ...over
});

describe('portals events', () => {
    it('adds, lists, and selects a portal', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        const p = portal();
        new AddPortalOp(events, p).do();
        expect(events.invoke('portals.list')).toEqual([p]);
        expect(events.invoke('portals.selected')).toBe('portal_0');
        expect(events.invoke('portals.count')).toBe(1);
    });

    it('add op undo removes the portal', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        const op = new AddPortalOp(events, portal());
        op.do();
        op.undo();
        expect(events.invoke('portals.list')).toEqual([]);
    });

    it('remove op undo restores at the original index', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        new AddPortalOp(events, portal({ id: 'portal_0' })).do();
        new AddPortalOp(events, portal({ id: 'portal_1' })).do();
        const list = events.invoke('portals.list') as PortalData[];
        new RemovePortalOp(events, list[0], 0).do();
        expect((events.invoke('portals.list') as PortalData[]).map(p => p.id)).toEqual(['portal_1']);
        new RemovePortalOp(events, list[0], 0).undo();
        expect((events.invoke('portals.list') as PortalData[]).map(p => p.id)).toEqual(['portal_0', 'portal_1']);
    });

    it('serializes and deserializes including the start splat', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        new AddPortalOp(events, portal({ id: 'portal_5' })).do();
        new SetStartSplatOp(events, null, 7).do();
        const serialized = events.invoke('docSerialize.portals');
        const start = events.invoke('portals.startSplat');

        const events2 = makeEvents();
        registerPortalsEvents(events2);
        events2.invoke('docDeserialize.portals', serialized, start);
        expect(events2.invoke('portals.list')).toEqual([portal({ id: 'portal_5' })]);
        expect(events2.invoke('portals.startSplat')).toBe(7);
        expect(events2.invoke('portals.newId')).toBe('portal_6');
    });

    it('deserialize fills missing rotation/size/uid defaults', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        events.invoke('docDeserialize.portals', [{ id: 'portal_0', position: [0, 0, 0] }], undefined);
        expect(events.invoke('portals.byId', 'portal_0')).toEqual({
            id: 'portal_0', position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 1, height: 1, frontUid: null, backUid: null
        });
        expect(events.invoke('portals.startSplat')).toBeNull();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/portals.test.ts`
Expected: FAIL — cannot resolve `../src/portals`.

- [ ] **Step 3: Write minimal implementation**

Create `src/portals.ts`:

```ts
import { Events } from './events';

// Editor-internal portal record: a rectangle (width x height) centered at
// `position`, oriented by `rotation` (quaternion [x,y,z,w]). The +Z side of the
// rectangle shows `frontUid`, the -Z side shows `backUid` (splat uids). Packed
// arrays so serialization is a straight copy (mirrors off-limits-zones.ts).
type PortalData = {
    id: string,
    position: [number, number, number],
    rotation: [number, number, number, number],
    width: number,
    height: number,
    frontUid: number | null,
    backUid: number | null
};

class AddPortalOp {
    name = 'addPortal';
    events: Events;
    data: PortalData;
    constructor(events: Events, data: PortalData) {
        this.events = events;
        this.data = data;
    }
    do() {
        this.events.fire('portals.insertRaw', this.data);
        this.events.fire('portals.select', this.data.id);
    }
    undo() {
        this.events.fire('portals.removeRaw', this.data.id);
    }
    destroy() {
        this.events = null;
        this.data = null;
    }
}

class RemovePortalOp {
    name = 'removePortal';
    events: Events;
    data: PortalData;
    index: number;
    constructor(events: Events, data: PortalData, index: number) {
        this.events = events;
        this.data = data;
        this.index = index;
    }
    do() {
        this.events.fire('portals.removeRaw', this.data.id);
    }
    undo() {
        this.events.fire('portals.insertRaw', this.data, this.index);
    }
    destroy() {
        this.events = null;
        this.data = null;
    }
}

class UpdatePortalOp {
    name = 'updatePortal';
    events: Events;
    id: string;
    oldValues: Partial<PortalData>;
    newValues: Partial<PortalData>;
    constructor(events: Events, id: string, oldValues: Partial<PortalData>, newValues: Partial<PortalData>) {
        this.events = events;
        this.id = id;
        this.oldValues = oldValues;
        this.newValues = newValues;
    }
    do() {
        this.events.fire('portals.updateRaw', this.id, this.newValues);
    }
    undo() {
        this.events.fire('portals.updateRaw', this.id, this.oldValues);
    }
    destroy() {
        this.events = null;
        this.oldValues = null;
        this.newValues = null;
    }
}

class SetStartSplatOp {
    name = 'setPortalStartSplat';
    events: Events;
    oldUid: number | null;
    newUid: number | null;
    constructor(events: Events, oldUid: number | null, newUid: number | null) {
        this.events = events;
        this.oldUid = oldUid;
        this.newUid = newUid;
    }
    do() {
        this.events.fire('portals.setStartRaw', this.newUid);
    }
    undo() {
        this.events.fire('portals.setStartRaw', this.oldUid);
    }
    destroy() {
        this.events = null;
    }
}

const registerPortalsEvents = (events: Events) => {
    const portals: PortalData[] = [];
    let startUid: number | null = null;
    let nextId = 0;
    let selectedId: string | null = null;

    const genId = () => `portal_${nextId++}`;
    const fireChanged = () => events.fire('portals.changed');

    // --- queries ---
    events.function('portals.list', () => portals);
    events.function('portals.byId', (id: string) => portals.find(p => p.id === id) ?? null);
    events.function('portals.selected', () => selectedId);
    events.function('portals.newId', () => genId());
    events.function('portals.startSplat', () => startUid);
    events.function('portals.count', () => portals.length);

    // --- low-level mutators (called by edit ops; fire change events) ---
    events.on('portals.insertRaw', (data: PortalData, index?: number) => {
        if (typeof index === 'number' && index >= 0 && index <= portals.length) {
            portals.splice(index, 0, data);
        } else {
            portals.push(data);
        }
        fireChanged();
    });

    events.on('portals.removeRaw', (id: string) => {
        const i = portals.findIndex(p => p.id === id);
        if (i >= 0) {
            portals.splice(i, 1);
            if (selectedId === id) {
                selectedId = null;
                events.fire('portals.selectionChanged', null);
            }
            fireChanged();
        }
    });

    events.on('portals.updateRaw', (id: string, patch: Partial<Omit<PortalData, 'id'>>) => {
        const p = portals.find(x => x.id === id);
        if (p) {
            Object.assign(p, patch);
            fireChanged();
        }
    });

    events.on('portals.setStartRaw', (uid: number | null) => {
        startUid = uid ?? null;
        fireChanged();
    });

    // --- selection ---
    events.on('portals.select', (id: string | null) => {
        if (selectedId !== id) {
            selectedId = id;
            events.fire('portals.selectionChanged', id);
        }
    });

    // --- reset on scene clear ---
    events.on('scene.clear', () => {
        portals.length = 0;
        startUid = null;
        nextId = 0;
        selectedId = null;
        events.fire('portals.selectionChanged', null);
        fireChanged();
    });

    // --- export shape (read by the export popups in sub-project 2) ---
    events.function('portals.export', () => portals.map(p => ({
        position: [p.position[0], p.position[1], p.position[2]],
        rotation: [p.rotation[0], p.rotation[1], p.rotation[2], p.rotation[3]],
        width: p.width,
        height: p.height,
        frontUid: p.frontUid,
        backUid: p.backUid
    })));

    // --- document serialization ---
    events.function('docSerialize.portals', (): PortalData[] => portals.map(p => ({
        id: p.id,
        position: [p.position[0], p.position[1], p.position[2]],
        rotation: [p.rotation[0], p.rotation[1], p.rotation[2], p.rotation[3]],
        width: p.width,
        height: p.height,
        frontUid: p.frontUid,
        backUid: p.backUid
    })));

    events.function('docDeserialize.portals', (data: PortalData[], start?: number | null) => {
        portals.length = 0;
        nextId = 0;
        selectedId = null;
        startUid = (typeof start === 'number') ? start : null;
        if (Array.isArray(data)) {
            data.forEach((d) => {
                portals.push({
                    id: d.id ?? genId(),
                    position: d.position,
                    rotation: d.rotation ?? [0, 0, 0, 1],
                    width: d.width ?? 1,
                    height: d.height ?? 1,
                    frontUid: d.frontUid ?? null,
                    backUid: d.backUid ?? null
                });
                const m = /^portal_(\d+)$/.exec(d.id ?? '');
                if (m) {
                    nextId = Math.max(nextId, parseInt(m[1], 10) + 1);
                }
            });
        }
        events.fire('portals.selectionChanged', null);
        fireChanged();
    });
};

export {
    registerPortalsEvents,
    AddPortalOp,
    RemovePortalOp,
    UpdatePortalOp,
    SetStartSplatOp,
    PortalData
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/portals.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Register the events in `src/main.ts`**

Add the import next to the other `register*` imports (alphabetical block around line 15):

```ts
import { registerPortalsEvents } from './portals';
```

Add the call immediately after `registerOffLimitsZonesEvents(events);` (line 115):

```ts
    registerPortalsEvents(events);
```

- [ ] **Step 6: Serialize in `src/doc.ts`**

In the `document` object literal (around line 165, after `offLimitsMessage: events.invoke('offLimitsZones.message'),`), add:

```ts
                portals: events.invoke('docSerialize.portals'),
                portalsStartSplat: events.invoke('portals.startSplat'),
```

- [ ] **Step 7: Deserialize in `src/doc.ts`**

After `events.invoke('docDeserialize.offLimitsZones', document.offLimitsZones, document.offLimitsMessage);` (line 126), add:

```ts
            events.invoke('docDeserialize.portals', document.portals, document.portalsStartSplat);
```

(Old documents have `document.portals === undefined`; `docDeserialize.portals` clears to empty in that case.)

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/portals.ts test/portals.test.ts src/main.ts src/doc.ts
git commit -m "$(printf 'feat(portals): portal data model, events, and doc serialization\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: Portal visual shape

**Files:**
- Create: `src/portal-shape.ts`

**Interfaces:**
- Consumes: the existing off-limits shader + `Element` base (no portal-task dependencies).
- Produces: `class PortalShape extends Element` with `pivot: Entity`, `add()`, `remove()`, `destroy()`, `setTransform(position: number[], rotation: number[], width: number, height: number)`, and a `selected` boolean accessor — same surface as `OffLimitsZoneShape`.

This shape has no unit tests (its template `off-limits-zone-shape.ts` has none); it is verified by typecheck/build and visually during manual E2E.

- [ ] **Step 1: Copy the template**

```bash
cp src/off-limits-zone-shape.ts src/portal-shape.ts
```

- [ ] **Step 2: Rename the class and entity**

In `src/portal-shape.ts`:
- Rename `class OffLimitsZoneShape` → `class PortalShape`.
- Change `new Entity('offLimitsZone')` → `new Entity('portal')`.
- Change `uniqueName: 'offLimitsZoneMaterial'` → `uniqueName: 'portalMaterial'`.
- Change the export line `export { OffLimitsZoneShape };` → `export { PortalShape };`.

- [ ] **Step 3: Give portals a distinct color**

In the `writeColors()` method, replace the red fill with cyan so portals read differently from red off-limits walls. Change:

```ts
            colors[o] = 255;
            colors[o + 1] = 0;
            colors[o + 2] = 0;
            colors[o + 3] = alpha;
```

to:

```ts
            colors[o] = 0;
            colors[o + 1] = 200;
            colors[o + 2] = 255;
            colors[o + 3] = alpha;
```

Also update the class comment that says "Red, semi-transparent" to "Cyan, semi-transparent".

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/portal-shape.ts
git commit -m "$(printf 'feat(portals): cyan portal rectangle shape\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 4: Shared toolbar active-state CSS fix

**Files:**
- Modify: `src/ui/scss/select-toolbar.scss`

The Move/Rotate buttons add the `.active` class in JS (`off-limits-zone-tool.ts:159-160`) but `.select-toolbar-button` has no `&.active` rule, so the active state is invisible. This one rule fixes the existing off-limits bug and gives the portal tool's Move/Rotate buttons correct styling for free (shared class).

- [ ] **Step 1: Add the active-state rule**

In `src/ui/scss/select-toolbar.scss`, inside the `.select-toolbar-button` block (currently lines 20-24), add an `&.active` rule using the existing PCUI active-surface token:

```scss
    .select-toolbar-button {
        height: 38px;
        padding: 0px 16px;
        border-radius: 2px;

        &.active {
            background-color: $bcg-active;
        }
    }
```

If `$bcg-active` is not exported from `colors.scss`, use the same token the rest of the app uses for an active/pressed surface — check `colors.scss` and pick the existing active/primary-active variable (do NOT invent a hex value). Confirm by opening `src/ui/scss/colors.scss` and using a defined variable.

- [ ] **Step 2: Build to confirm SCSS compiles**

Run: `npm run build`
Expected: build completes with no SCSS error.

- [ ] **Step 3: Manual visual check**

Run `npm run develop`, open the off-limits zones tool, click Move then Rotate — the selected mode button now has a filled background. (Portals reuse the same class, verified in Task 5.)

- [ ] **Step 4: Commit**

```bash
git add src/ui/scss/select-toolbar.scss
git commit -m "$(printf 'fix(ui): visible active background for select-toolbar toggle buttons\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 5: Portal authoring tool, toolbar button, and locale

**Files:**
- Create: `src/tools/portal-tool.ts`
- Create: `src/ui/svg/portal.svg`
- Modify: `src/main.ts` (import + `toolManager.register` after line 257)
- Modify: `src/ui/bottom-toolbar.ts` (toolbar button)
- Modify: `static/locales/en.json` (`portals.*` keys)

**Interfaces:**
- Consumes: `PortalShape` (Task 3); `AddPortalOp`, `RemovePortalOp`, `UpdatePortalOp`, `PortalData`, plus the `portals.*` events (Task 2); `Splat`/`scene.getElementsByType` for the scene dropdowns.
- Produces: `class PortalTool { activate(): void; deactivate(): void }` registered under the tool id `'portals'`.

No unit tests (its template `off-limits-zone-tool.ts` has none); verified by typecheck/build + manual E2E.

- [ ] **Step 1: Copy the template**

```bash
cp src/tools/off-limits-zone-tool.ts src/tools/portal-tool.ts
```

- [ ] **Step 2: Swap imports and class name**

In `src/tools/portal-tool.ts`:
- Replace the import line `import { Button, Container, Label, NumericInput, TextInput } from '@playcanvas/pcui';` with:
  ```ts
  import { Button, Container, Label, NumericInput, SelectInput } from '@playcanvas/pcui';
  ```
- Add these imports (next to the existing ones):
  ```ts
  import { ElementType } from '../element';
  import { Splat } from '../splat';
  ```
- Replace `import { OffLimitsZoneShape } from '../off-limits-zone-shape';` with `import { PortalShape } from '../portal-shape';`.
- Replace `import { AddZoneOp, RemoveZoneOp, SetMessageOp, UpdateZoneOp, ZoneData } from '../off-limits-zones';` with (note `SetStartSplatOp`, used by the start-scene picker in Step 3):
  ```ts
  import { AddPortalOp, RemovePortalOp, SetStartSplatOp, UpdatePortalOp, PortalData } from '../portals';
  ```
- Rename `class OffLimitsZoneTool` → `class PortalTool` and the export `export { OffLimitsZoneTool };` → `export { PortalTool };`.
- Throughout the file, replace identifiers: `OffLimitsZoneShape` → `PortalShape`, `ZoneData` → `PortalData`, `AddZoneOp` → `AddPortalOp`, `RemoveZoneOp` → `RemovePortalOp`, `UpdateZoneOp` → `UpdatePortalOp`, and every `offLimitsZones.` event string → `portals.` (e.g. `offLimitsZones.list` → `portals.list`, `offLimitsZones.select` → `portals.select`, `offLimitsZones.selected` → `portals.selected`, `offLimitsZones.newId` → `portals.newId`, `offLimitsZones.changed` → `portals.changed`, `offLimitsZones.selectionChanged` → `portals.selectionChanged`).
- The `shapes` map type becomes `Map<string, PortalShape>`.

- [ ] **Step 3: Replace the message input with Front/Back/Start scene pickers**

Remove the message widgets (the `messageLabel`, `messageInput`, their `bar.append(...)`, and the `messageInput.on('change', ...)` handler that builds `SetMessageOp`). Also delete the `refreshBar()` lines that set `messageInput.value`/`messageInput.placeholder`.

In their place, after the `heightInput` declaration, add the scene pickers:

```ts
        const frontLabel = new Label({ text: localize('portals.front') });
        const frontInput = new SelectInput({ type: 'number', options: [], width: 140 });
        const backLabel = new Label({ text: localize('portals.back') });
        const backInput = new SelectInput({ type: 'number', options: [], width: 140 });
        const startLabel = new Label({ text: localize('portals.start') });
        const startInput = new SelectInput({ type: 'number', options: [], width: 140 });
```

Append them to the bar (replacing where `messageLabel`/`messageInput` were appended):

```ts
        bar.append(frontLabel);
        bar.append(frontInput);
        bar.append(backLabel);
        bar.append(backInput);
        bar.append(startLabel);
        bar.append(startInput);
```

Add scene-option plumbing (place near the `selected()` helper). This mirrors `src/ui/alignment-panel.ts:111-133`:

```ts
        const splatList = () => scene.getElementsByType(ElementType.splat) as Splat[];
        const splatName = (splat: Splat) => {
            const filename = (splat.asset.file as any)?.filename ?? splat.name ?? `Splat ${splat.uid}`;
            return `${splat.uid}: ${filename}`;
        };
        const refreshSceneOptions = () => {
            const options = splatList().map(splat => ({ v: splat.uid, t: splatName(splat) }));
            frontInput.options = options;
            backInput.options = options;
            startInput.options = options;
        };
```

In `refreshBar()`, after the existing `widthInput.enabled = !!z;` / `heightInput.enabled = !!z;` lines, set the picker enablement and values (the selected portal `z` now has `frontUid`/`backUid`; the start picker is always enabled and reflects the global start splat):

```ts
            refreshSceneOptions();
            frontInput.enabled = !!z;
            backInput.enabled = !!z;
            if (z) {
                frontInput.value = z.frontUid;
                backInput.value = z.backUid;
            }
            startInput.value = events.invoke('portals.startSplat') as number | null;
```

Wire the picker changes (place with the other `.on('change', ...)` handlers, replacing the removed message handler; `SetStartSplatOp` is already imported in Step 2):

```ts
        frontInput.on('change', (v: number) => {
            if (suppress) { return; }
            const z = selected();
            if (z && z.frontUid !== v) {
                events.fire('edit.add', new UpdatePortalOp(events, z.id, { frontUid: z.frontUid }, { frontUid: v }));
            }
        });
        backInput.on('change', (v: number) => {
            if (suppress) { return; }
            const z = selected();
            if (z && z.backUid !== v) {
                events.fire('edit.add', new UpdatePortalOp(events, z.id, { backUid: z.backUid }, { backUid: v }));
            }
        });
        startInput.on('change', (v: number) => {
            if (suppress) { return; }
            const current = events.invoke('portals.startSplat') as number | null;
            if (current !== v) {
                events.fire('edit.add', new SetStartSplatOp(events, current, v));
            }
        });
```

- [ ] **Step 4: Set front/back defaults when a portal is created**

In the Add-button handler, the `data` object now needs `frontUid`/`backUid`. Default them to the first two loaded splats (so a fresh portal is immediately meaningful). Replace the `const data: ZoneData = { ... }` block with:

```ts
            const splats = splatList();
            const data: PortalData = {
                id: events.invoke('portals.newId') as string,
                position: [t.x, t.y, t.z],
                rotation: [q.x, q.y, q.z, q.w],
                width: 2,
                height: 2,
                frontUid: splats[0]?.uid ?? null,
                backUid: splats[1]?.uid ?? null
            };
            events.fire('edit.add', new AddPortalOp(events, data));
```

- [ ] **Step 5: Register the tool in `src/main.ts`**

Add the import next to the other tool imports (around line 34):

```ts
import { PortalTool } from './tools/portal-tool';
```

Add the registration after the off-limits registration (line 257):

```ts
    toolManager.register('portals', new PortalTool(events, scene, editorUI.canvasContainer));
```

- [ ] **Step 6: Add a toolbar button**

Open `src/ui/bottom-toolbar.ts`. Find the off-limits zones button (search for the existing off-limits tool button — it registers a button that fires `tool.toggle`/activates the `'offLimitsZones'` tool and toggles its `.active` class). Immediately after it, add an analogous portal button. Use the existing button-construction pattern in that file verbatim, substituting:
- icon: import `portalSvg from './svg/portal.svg'` and use it like the off-limits button uses its icon;
- the tool id string `'offLimitsZones'` → `'portals'`;
- tooltip text `localize('tooltip.portals')`.

(Do not invent a new pattern — copy the exact off-limits button block in this file, including its `events.on('tool.activated'...)`/active-class wiring, and rename the tool id, icon, and tooltip.)

- [ ] **Step 7: Create the toolbar icon**

Create `src/ui/svg/portal.svg` (a simple doorway glyph; SVGs here are imported as `data:image/svg+xml,...` modules):

```svg
<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="6" y="3" width="12" height="18" rx="1" stroke="currentColor" stroke-width="1.5"/>
  <circle cx="14.5" cy="12" r="1" fill="currentColor"/>
</svg>
```

If other svgs in `src/ui/svg/` use a specific import shape (check one existing file + how `bottom-toolbar.ts` imports/uses an icon) and it differs, match that exact format.

- [ ] **Step 8: Add locale keys**

In `static/locales/en.json`, add these keys (place the `portals.*` group next to the `offLimitsZones.*` group, and the tooltip next to `tooltip.scene.solo`). Use the existing JSON style (comma-separated, no trailing comma):

```json
    "portals.add": "Add",
    "portals.move": "Move",
    "portals.rotate": "Rotate",
    "portals.width": "Width",
    "portals.height": "Height",
    "portals.front": "Front scene",
    "portals.back": "Back scene",
    "portals.start": "Start scene",
    "tooltip.portals": "Portals",
```

(Other locales fall back to English automatically, as the existing `offLimitsZones.*` and `mergeCut.*` keys do — no other locale files need editing.)

- [ ] **Step 9: Typecheck, lint, build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: tsc clean; lint no new errors; build succeeds.

- [ ] **Step 10: Manual E2E check**

`npm run develop`, load two splats, open the Portals tool: Add places a cyan rectangle; Move/Rotate gizmos work and show active background; Front/Back/Start dropdowns list both splats; selecting a portal shows its scenes; width/height edit live.

- [ ] **Step 11: Commit**

```bash
git add src/tools/portal-tool.ts src/ui/svg/portal.svg src/main.ts src/ui/bottom-toolbar.ts static/locales/en.json
git commit -m "$(printf 'feat(portals): authoring tool, toolbar button, and locale\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 6: Walkthrough toggle and runtime switching

**Files:**
- Create: `src/portals-runtime.ts`
- Modify: `src/main.ts` (import + `registerPortalsRuntime(events, scene)` near the other `register*(events)` calls — note this one also needs `scene`)
- Modify: `src/ui/scene-panel.ts` (Walkthrough toggle button)
- Reuse: `src/ui/svg/portal.svg` (Task 5) for the toggle icon

**Interfaces:**
- Consumes: `resolveActiveSplat`, `PortalRect` (Task 1); `portals.list`, `portals.startSplat`, `portals.count`, `portals.changed` (Task 2); `Splat.uid`, `Splat.visible`, `scene.getElementsByType` (engine).
- Produces: `registerPortalsRuntime(events, scene): void`; listens to the `portals.walkthrough` event (boolean) fired by the scene panel toggle.

No unit tests for the runtime wiring itself (its decision core, `resolveActiveSplat`, is already tested in Task 1); verified by typecheck/build + manual E2E.

- [ ] **Step 1: Write the runtime module**

Create `src/portals-runtime.ts`:

```ts
import { Mat4, Vec3 } from 'playcanvas';

import { ElementType } from './element';
import { Events } from './events';
import { PortalRect, resolveActiveSplat } from './portal-geom';
import { Scene } from './scene';
import { Splat } from './splat';
import { PortalData } from './portals';

// Drives the in-editor multi-scene walkthrough. While walkthrough mode is on,
// only one splat is visible at a time; crossing a portal rectangle swaps which.
// Mode is a non-destructive overlay: it snapshots each splat's visibility on
// enable and restores it on disable.
const registerPortalsRuntime = (events: Events, scene: Scene) => {
    let active = false;
    let activeUid: number | null = null;
    const prev = new Vec3();
    let havePrev = false;
    const snapshot = new Map<number, boolean>();

    const splats = () => scene.getElementsByType(ElementType.splat) as Splat[];

    const applyVisibility = () => {
        splats().forEach((s) => {
            s.visible = s.uid === activeUid;
        });
    };

    const buildRects = (): PortalRect[] => {
        const data = events.invoke('portals.list') as PortalData[];
        return data.map(p => ({
            position: p.position,
            rotation: p.rotation,
            width: p.width,
            height: p.height,
            frontUid: p.frontUid,
            backUid: p.backUid
        }));
    };

    const enable = () => {
        active = true;
        havePrev = false;
        snapshot.clear();
        splats().forEach(s => snapshot.set(s.uid, s.visible));
        const start = events.invoke('portals.startSplat') as number | null;
        const list = splats();
        activeUid = (start !== null && list.some(s => s.uid === start)) ? start : (list[0]?.uid ?? null);
        applyVisibility();
    };

    const disable = () => {
        active = false;
        splats().forEach((s) => {
            if (snapshot.has(s.uid)) {
                s.visible = snapshot.get(s.uid);
            }
        });
        snapshot.clear();
    };

    events.on('portals.walkthrough', (on: boolean) => {
        if (on === active) {
            return;
        }
        if (on) {
            enable();
        } else {
            disable();
        }
    });

    // Per-frame: the prerender event carries the camera world transform.
    events.on('prerender', (cameraWorldTransform: Mat4) => {
        if (!active) {
            return;
        }
        const cur = cameraWorldTransform.getTranslation();
        if (havePrev) {
            const newUid = resolveActiveSplat(
                [prev.x, prev.y, prev.z],
                [cur.x, cur.y, cur.z],
                buildRects(),
                activeUid
            );
            if (newUid !== activeUid) {
                activeUid = newUid;
                applyVisibility();
            }
        }
        prev.copy(cur);
        havePrev = true;
    });

    // If walkthrough is on and all portals get deleted, leaving it on is fine;
    // exiting is the panel toggle's job. Nothing to do on portals.changed here.
};

export { registerPortalsRuntime };
```

Note: confirm the `prerender` event payload type. The off-limits tooling and `src/scene.ts:381` fire it with the camera world transform (`Mat4`); `Mat4.getTranslation()` returns a `Vec3`. If your local signature differs (e.g. it passes the camera or a pose), read the camera world position the same way the codebase does elsewhere (e.g. `scene.camera`), keeping the prev/cur segment logic identical.

- [ ] **Step 2: Register the runtime in `src/main.ts`**

Add the import near the other `register*` imports:

```ts
import { registerPortalsRuntime } from './portals-runtime';
```

Add the call where `scene` is available (after `scene` is constructed and after `registerPortalsEvents(events);`). Search `main.ts` for an existing `register*(events, scene)` call (a register that already takes the scene) and place it alongside:

```ts
    registerPortalsRuntime(events, scene);
```

If no `register*` runs after `scene` exists, place the call right after the line that constructs `scene` (the same place the tools — which also need `scene` — are wired, around line 255-257).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (If `prerender`'s payload type mismatches, adjust per the Step 1 note before proceeding.)

- [ ] **Step 4: Add the Walkthrough toggle to `src/ui/scene-panel.ts`**

Mirror the existing Solo toggle (`scene-panel.ts:46-61,75,87`). Add a `portalSvg` import at the top:

```ts
import portalSvg from './svg/portal.svg';
```

After the `soloToggle` block (after line 61), add:

```ts
        let walkthroughActive = false;

        const walkthroughToggle = new Container({
            class: 'panel-header-button'
        });
        walkthroughToggle.dom.appendChild(createSvg(portalSvg));

        const refreshWalkthroughEnabled = () => {
            const count = events.invoke('portals.count') as number;
            walkthroughToggle.class[count > 0 ? 'remove' : 'add']('disabled');
        };

        walkthroughToggle.on('click', () => {
            const count = events.invoke('portals.count') as number;
            if (count === 0) {
                return; // disabled until at least one portal exists
            }
            walkthroughActive = !walkthroughActive;
            walkthroughToggle.class[walkthroughActive ? 'add' : 'remove']('active');
            events.fire('portals.walkthrough', walkthroughActive);
        });

        events.on('portals.changed', refreshWalkthroughEnabled);
        refreshWalkthroughEnabled();
```

Append it next to the solo toggle (after `sceneHeader.append(soloToggle);`, line 75):

```ts
        sceneHeader.append(walkthroughToggle);
```

Register a tooltip next to the solo tooltip (after line 87):

```ts
        tooltips.register(walkthroughToggle, localize('tooltip.scene.walkthrough'), 'top');
```

- [ ] **Step 5: Add the toggle locale key + disabled style**

In `static/locales/en.json`, add next to `tooltip.scene.solo`:

```json
    "tooltip.scene.walkthrough": "Walkthrough",
```

Confirm `panel-header-button` has a visible `.active` style already (the solo toggle relies on it — search the scss for `panel-header-button`). If there is no `.disabled` style on `panel-header-button`, add a minimal one (reduced opacity + `pointer-events` left clickable since the JS already guards) to its scss block:

```scss
        &.disabled {
            opacity: 0.4;
        }
```

(Place this in whichever scss file defines `.panel-header-button`.)

- [ ] **Step 6: Typecheck, lint, build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: tsc clean; lint no new errors; build succeeds.

- [ ] **Step 7: Manual E2E check**

`npm run develop`, load two stacked-floor splats, align them, add a portal in the stairwell with Front = upper, Back = lower, set Start scene. The Walkthrough toggle is greyed until the portal exists, then enables. Turn it on: only the start scene shows. Orbit/move the camera through the portal rectangle: the visible scene swaps. Turn it off: prior visibility is restored.

- [ ] **Step 8: Commit**

```bash
git add src/portals-runtime.ts src/main.ts src/ui/scene-panel.ts static/locales/en.json
git commit -m "$(printf 'feat(portals): walkthrough toggle and per-frame scene switching\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Notes for the implementer

- **Splat identity is `uid` (session-scoped).** Portal front/back/start references are stored as uids. Across a document reload, bindings hold only if splats reload in the same order; otherwise the dropdowns show stale values and the author re-points them. Robust cross-reload binding is intentionally out of scope (sub-project 1 is editor + single session).
- **Desync recovery is by design.** A camera teleport can skip a doorway; toggling Walkthrough off then on re-seeds to the start scene. No per-scene bounding boxes (overlapping floor captures make them ambiguous).
- **Exported viewer is a separate sub-project.** The `portals.export` event is added here but unused; wiring portals into the published HTML viewer needs a feasibility spike and its own spec (see the design doc §5).
- **Two pre-existing `server/test/*` failures** (`Cannot find package 'tsx'`) are environmental and unrelated — ignore them when reading `npm run test` output.
```
