# Off-Limits Zones Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let authors place thin, freely-oriented rectangular "walls" (off-limits zones) in the editor that, in the exported viewer, block the camera via analytic fake-collision, briefly flash the wall red, and show a single (localized-default, author-overridable) message.

**Architecture:** Mirror the annotations subsystem. A model module owns the zones + global message (with undoable edit ops and document round-trip). An editor tool renders each zone as a thin transparent plane mesh (red translucent; brighter when selected) and edits the selected one with translate + rotate gizmos. Export injects a companion script (like `annotation-links.ts`) carrying the zones + message; the companion reads the viewer camera each frame and clamps it using a pure, unit-tested collision function (injected via `Function.toString()`).

**Tech Stack:** TypeScript, PlayCanvas (`Entity`, `TranslateGizmo`, `RotateGizmo`, `StandardMaterial`), `@playcanvas/pcui`, Vitest, i18next, rollup.

**Spec:** `docs/superpowers/specs/2026-06-11-off-limits-zones-design.md`

**Verification commands:**
- Single unit test file: `npx vitest run test/<file>.test.ts`
- All unit tests: `npm test`
- Lint a file: `npx eslint src/<file>.ts`
- Compile/build: `npm run build`

---

## Shared constant (referenced by Task 5 and Task 7)

PlayCanvas's `plane` primitive lies in the **XZ** plane (normal +Y), spanning X∈[-0.5,0.5], Z∈[-0.5,0.5]. Our wall rectangle is defined in **local XY** (normal local +Z), width along local X, height along local Y. The fixed correction quaternion **+90° about X** maps the plane into local XY (so plane X→wall X = width, plane Z→wall Y = height, plane normal +Y→wall normal +Z):

```
CORRECTION = quaternion(x=0.7071067811865476, y=0, z=0, w=0.7071067811865476)
```

A zone's visual entity gets `localRotation = CORRECTION` on a **child** of the gizmo pivot, so the gizmo pivot itself carries exactly the zone's stored `position`/`rotation` (no correction baked in).

---

## Task 1: Spike — confirm viewer camera/scene access (throwaway)

**This gates the whole feature.** Confirm injected JS can read the camera, set the camera, and add a temporary mesh in a *real exported viewer*. No production code is kept; the deliverable is the two confirmed accessor snippets pasted into Task 5.

**Files:** none committed (scratch only).

- [ ] **Step 1: Produce a viewer to test against**

Run the editor (`npm run develop`), load any `.ply`/`.splat`, and export a **ZIP viewer** (Export → Viewer, type ZIP, no collision needed). Unzip `output.zip` to a folder and serve it (`npx serve .`). Open it in a browser.

- [ ] **Step 2: In the browser devtools console, confirm the PlayCanvas globals**

Paste and run:

```js
const pc = window.pc;
const app = pc && (pc.app || (pc.Application && pc.Application.getApplication && pc.Application.getApplication()));
const camComp = app && app.root && app.root.findComponent && app.root.findComponent('camera');
const cam = camComp && camComp.entity;
console.log('pc:', !!pc, 'app:', !!app, 'cam:', !!cam, cam && cam.getPosition && cam.getPosition().toString());
```

Expected: all three `true` and a printed camera position. Record what actually works (the exact way to reach `pc`, `app`, and the camera entity).

- [ ] **Step 3: Confirm we can SET the camera position**

Move in the viewer, then run repeatedly:

```js
const p = cam.getPosition().clone();
cam.setPosition(p.x, p.y, p.z + 0.0); // no-op set
// then try nudging and watch it hold for a frame:
cam.setPosition(p.x, p.y, p.z - 1);
```

Expected: `setPosition` does not throw and visibly affects the camera (even if the controller fights it next frame). Note whether a per-frame `setPosition` in a `requestAnimationFrame` loop visibly clamps movement (try a small rAF loop that pins the camera to a fixed point).

- [ ] **Step 4: Confirm we can add a temporary mesh entity**

```js
const e = new pc.Entity();
e.addComponent('render', { type: 'plane' });
const m = new pc.StandardMaterial();
m.emissive = new pc.Color(1,0,0); m.useLighting = false; m.opacity = 0.6; m.blendType = pc.BLEND_NORMAL; m.cull = pc.CULLFACE_NONE; m.update();
e.render.material = m;
e.setLocalScale(2,1,2);
e.setPosition(cam.getPosition());
app.root.addChild(e);
```

Expected: a red plane appears in the scene.

- [ ] **Step 5: Decision gate**

- If Steps 2–4 all succeed: record the exact accessor lines for `getApp()` and `getCameraEntity(app)` and proceed. The Task 5 code already encodes the expected accessors (`pc.app` / `pc.Application.getApplication()` and `app.root.findComponent('camera').entity`) — adjust those two functions only if the spike found a different path.
- If SET (Step 3) fails: stop and revisit the approach (the spec's Approach B fallback — voxel-based blocking — would be needed). Report back before continuing.
- If only the mesh add (Step 4) fails: continue, but in Task 5 use the DOM-only red-flash feedback path (the code includes it) and skip the 3D quad.

No commit (scratch task).

---

## Task 2: Zones model — `src/off-limits-zones.ts` (TDD)

Owns the live zones array + global message, undoable edit ops, queries, export shape, and document round-trip. Mirrors `src/annotations.ts`.

**Files:**
- Create: `src/off-limits-zones.ts`
- Test: `test/off-limits-zones.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/off-limits-zones.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import { AddZoneOp, RemoveZoneOp, UpdateZoneOp, SetMessageOp, ZoneData, registerOffLimitsZonesEvents } from '../src/off-limits-zones';

// Minimal Events double (function/invoke registry + on/fire listeners),
// matching the subset of src/events.ts the model uses. Avoids importing
// playcanvas in a node-env test.
const makeEvents = () => {
    const fns = new Map<string, (...a: any[]) => any>();
    const listeners = new Map<string, ((...a: any[]) => void)[]>();
    const ev = {
        function(name: string, fn: (...a: any[]) => any) { fns.set(name, fn); },
        invoke(name: string, ...args: any[]) { return fns.get(name)?.(...args); },
        on(name: string, cb: (...a: any[]) => void) {
            const l = listeners.get(name) ?? [];
            l.push(cb);
            listeners.set(name, l);
        },
        fire(name: string, ...args: any[]) { (listeners.get(name) ?? []).forEach(cb => cb(...args)); }
    };
    return ev as any;
};

const zone = (over: Partial<ZoneData> = {}): ZoneData => ({
    id: over.id ?? 'zone_0',
    position: over.position ?? [1, 2, 3],
    rotation: over.rotation ?? [0, 0, 0, 1],
    width: over.width ?? 2,
    height: over.height ?? 3
});

describe('off-limits zones model', () => {
    it('adds and lists a zone, and selects it', () => {
        const events = makeEvents();
        registerOffLimitsZonesEvents(events);
        const z = zone();
        new AddZoneOp(events, z).do();
        expect(events.invoke('offLimitsZones.list')).toHaveLength(1);
        expect(events.invoke('offLimitsZones.byId', 'zone_0')).toEqual(z);
        expect(events.invoke('offLimitsZones.selected')).toBe('zone_0');
    });

    it('add op undo removes the zone', () => {
        const events = makeEvents();
        registerOffLimitsZonesEvents(events);
        const op = new AddZoneOp(events, zone());
        op.do();
        op.undo();
        expect(events.invoke('offLimitsZones.list')).toHaveLength(0);
    });

    it('remove op undo restores at the original index', () => {
        const events = makeEvents();
        registerOffLimitsZonesEvents(events);
        new AddZoneOp(events, zone({ id: 'zone_0' })).do();
        new AddZoneOp(events, zone({ id: 'zone_1' })).do();
        const remove = new RemoveZoneOp(events, events.invoke('offLimitsZones.byId', 'zone_0'), 0);
        remove.do();
        expect(events.invoke('offLimitsZones.list').map((z: ZoneData) => z.id)).toEqual(['zone_1']);
        remove.undo();
        expect(events.invoke('offLimitsZones.list').map((z: ZoneData) => z.id)).toEqual(['zone_0', 'zone_1']);
    });

    it('update op sets and reverts fields', () => {
        const events = makeEvents();
        registerOffLimitsZonesEvents(events);
        new AddZoneOp(events, zone()).do();
        const op = new UpdateZoneOp(events, 'zone_0', { width: 2 }, { width: 9 });
        op.do();
        expect(events.invoke('offLimitsZones.byId', 'zone_0').width).toBe(9);
        op.undo();
        expect(events.invoke('offLimitsZones.byId', 'zone_0').width).toBe(2);
    });

    it('message defaults to empty and is set/undone by SetMessageOp', () => {
        const events = makeEvents();
        registerOffLimitsZonesEvents(events);
        expect(events.invoke('offLimitsZones.message')).toBe('');
        const op = new SetMessageOp(events, '', 'No entry');
        op.do();
        expect(events.invoke('offLimitsZones.message')).toBe('No entry');
        op.undo();
        expect(events.invoke('offLimitsZones.message')).toBe('');
    });

    it('export drops the id', () => {
        const events = makeEvents();
        registerOffLimitsZonesEvents(events);
        new AddZoneOp(events, zone()).do();
        expect(events.invoke('offLimitsZones.export')).toEqual([
            { position: [1, 2, 3], rotation: [0, 0, 0, 1], width: 2, height: 3 }
        ]);
    });

    it('serialize -> deserialize round-trips zones + message and keeps ids ahead', () => {
        const events = makeEvents();
        registerOffLimitsZonesEvents(events);
        new AddZoneOp(events, zone({ id: 'zone_5' })).do();
        new SetMessageOp(events, '', 'Custom').do();
        const serialized = events.invoke('docSerialize.offLimitsZones');
        const message = events.invoke('offLimitsZones.message');

        const events2 = makeEvents();
        registerOffLimitsZonesEvents(events2);
        events2.invoke('docDeserialize.offLimitsZones', serialized, message);
        expect(events2.invoke('offLimitsZones.list')).toEqual([zone({ id: 'zone_5' })]);
        expect(events2.invoke('offLimitsZones.message')).toBe('Custom');
        // next generated id must be ahead of the loaded zone_5
        expect(events2.invoke('offLimitsZones.newId')).toBe('zone_6');
    });

    it('deserialize fills missing rotation/size defaults', () => {
        const events = makeEvents();
        registerOffLimitsZonesEvents(events);
        events.invoke('docDeserialize.offLimitsZones', [{ id: 'zone_0', position: [0, 0, 0] }], undefined);
        expect(events.invoke('offLimitsZones.byId', 'zone_0')).toEqual({
            id: 'zone_0', position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 1, height: 1
        });
        expect(events.invoke('offLimitsZones.message')).toBe('');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/off-limits-zones.test.ts`
Expected: FAIL — cannot resolve `../src/off-limits-zones`.

- [ ] **Step 3: Write the implementation**

Create `src/off-limits-zones.ts`:

```ts
import { Events } from './events';

// Editor-internal off-limits zone record. A zone is a thin vertical wall: a
// rectangle (width x height) centered at `position`, oriented by `rotation`
// (quaternion [x, y, z, w]). Packed arrays so serialization is a straight copy
// (mirrors annotations.ts).
type ZoneData = {
    id: string,
    position: [number, number, number],
    rotation: [number, number, number, number],
    width: number,
    height: number
};

// Export-shaped zone consumed by the viewer companion (no id needed).
type ZoneExport = {
    position: [number, number, number],
    rotation: [number, number, number, number],
    width: number,
    height: number
};

class AddZoneOp {
    name = 'addOffLimitsZone';
    events: Events;
    data: ZoneData;

    constructor(events: Events, data: ZoneData) {
        this.events = events;
        this.data = data;
    }

    do() {
        this.events.fire('offLimitsZones.insertRaw', this.data);
        this.events.fire('offLimitsZones.select', this.data.id);
    }

    undo() {
        this.events.fire('offLimitsZones.removeRaw', this.data.id);
    }

    destroy() {
        this.events = null;
        this.data = null;
    }
}

class RemoveZoneOp {
    name = 'removeOffLimitsZone';
    events: Events;
    data: ZoneData;
    index: number;

    constructor(events: Events, data: ZoneData, index: number) {
        this.events = events;
        this.data = data;
        this.index = index;
    }

    do() {
        this.events.fire('offLimitsZones.removeRaw', this.data.id);
    }

    undo() {
        this.events.fire('offLimitsZones.insertRaw', this.data, this.index);
    }

    destroy() {
        this.events = null;
        this.data = null;
    }
}

class UpdateZoneOp {
    name = 'updateOffLimitsZone';
    events: Events;
    id: string;
    oldValues: Partial<ZoneData>;
    newValues: Partial<ZoneData>;

    constructor(events: Events, id: string, oldValues: Partial<ZoneData>, newValues: Partial<ZoneData>) {
        this.events = events;
        this.id = id;
        this.oldValues = oldValues;
        this.newValues = newValues;
    }

    do() {
        this.events.fire('offLimitsZones.updateRaw', this.id, this.newValues);
    }

    undo() {
        this.events.fire('offLimitsZones.updateRaw', this.id, this.oldValues);
    }

    destroy() {
        this.events = null;
        this.oldValues = null;
        this.newValues = null;
    }
}

class SetMessageOp {
    name = 'setOffLimitsMessage';
    events: Events;
    oldValue: string;
    newValue: string;

    constructor(events: Events, oldValue: string, newValue: string) {
        this.events = events;
        this.oldValue = oldValue;
        this.newValue = newValue;
    }

    do() {
        this.events.fire('offLimitsZones.setMessageRaw', this.newValue);
    }

    undo() {
        this.events.fire('offLimitsZones.setMessageRaw', this.oldValue);
    }

    destroy() {
        this.events = null;
    }
}

const registerOffLimitsZonesEvents = (events: Events) => {
    const zones: ZoneData[] = [];
    let message = '';
    let nextId = 0;
    let selectedId: string | null = null;

    const genId = () => `zone_${nextId++}`;
    const fireChanged = () => events.fire('offLimitsZones.changed');

    // --- queries ---

    // Returns the live internal array — callers read it but must not mutate it.
    events.function('offLimitsZones.list', () => zones);
    events.function('offLimitsZones.byId', (id: string) => zones.find(z => z.id === id) ?? null);
    events.function('offLimitsZones.selected', () => selectedId);
    events.function('offLimitsZones.newId', () => genId());
    events.function('offLimitsZones.message', () => message);

    // --- low-level mutators (called by edit ops; fire change events) ---

    events.on('offLimitsZones.insertRaw', (data: ZoneData, index?: number) => {
        if (typeof index === 'number' && index >= 0 && index <= zones.length) {
            zones.splice(index, 0, data);
        } else {
            zones.push(data);
        }
        fireChanged();
    });

    events.on('offLimitsZones.removeRaw', (id: string) => {
        const i = zones.findIndex(z => z.id === id);
        if (i >= 0) {
            zones.splice(i, 1);
            if (selectedId === id) {
                selectedId = null;
                events.fire('offLimitsZones.selectionChanged', null);
            }
            fireChanged();
        }
    });

    events.on('offLimitsZones.updateRaw', (id: string, patch: Partial<Omit<ZoneData, 'id'>>) => {
        const z = zones.find(x => x.id === id);
        if (z) {
            Object.assign(z, patch);
            fireChanged();
        }
    });

    events.on('offLimitsZones.setMessageRaw', (value: string) => {
        message = value ?? '';
        fireChanged();
    });

    // --- selection ---

    events.on('offLimitsZones.select', (id: string | null) => {
        if (selectedId !== id) {
            selectedId = id;
            events.fire('offLimitsZones.selectionChanged', id);
        }
    });

    // --- reset on scene clear ---

    events.on('scene.clear', () => {
        zones.length = 0;
        message = '';
        nextId = 0;
        selectedId = null;
        events.fire('offLimitsZones.selectionChanged', null);
        fireChanged();
    });

    // --- export shape (read by the export popups) ---

    events.function('offLimitsZones.export', (): ZoneExport[] => {
        return zones.map(z => ({
            position: [z.position[0], z.position[1], z.position[2]],
            rotation: [z.rotation[0], z.rotation[1], z.rotation[2], z.rotation[3]],
            width: z.width,
            height: z.height
        }));
    });

    // --- document serialization ---

    events.function('docSerialize.offLimitsZones', (): ZoneData[] => {
        return zones.map(z => ({
            id: z.id,
            position: [z.position[0], z.position[1], z.position[2]],
            rotation: [z.rotation[0], z.rotation[1], z.rotation[2], z.rotation[3]],
            width: z.width,
            height: z.height
        }));
    });

    events.function('docDeserialize.offLimitsZones', (data: ZoneData[], msg?: string) => {
        zones.length = 0;
        nextId = 0;
        selectedId = null;
        message = msg ?? '';
        if (Array.isArray(data)) {
            data.forEach((d) => {
                zones.push({
                    id: d.id ?? genId(),
                    position: d.position,
                    rotation: d.rotation ?? [0, 0, 0, 1],
                    width: d.width ?? 1,
                    height: d.height ?? 1
                });
                // keep the counter ahead of any numeric id we loaded
                const m = /^zone_(\d+)$/.exec(d.id ?? '');
                if (m) {
                    nextId = Math.max(nextId, parseInt(m[1], 10) + 1);
                }
            });
        }
        events.fire('offLimitsZones.selectionChanged', null);
        fireChanged();
    });
};

export {
    registerOffLimitsZonesEvents,
    AddZoneOp,
    RemoveZoneOp,
    UpdateZoneOp,
    SetMessageOp,
    ZoneData,
    ZoneExport
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/off-limits-zones.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Lint and commit**

```bash
npx eslint src/off-limits-zones.ts test/off-limits-zones.test.ts
git add src/off-limits-zones.ts test/off-limits-zones.test.ts
git commit -m "feat: off-limits zones model with undoable ops and doc round-trip"
```

---

## Task 3: Wire model into the app + persistence (`src/main.ts`, `src/doc.ts`)

**Files:**
- Modify: `src/main.ts` (import + registration)
- Modify: `src/doc.ts` (serialize at ~163, deserialize at ~125)

- [ ] **Step 1: Register the model in `src/main.ts`**

Add the import near the other model imports (next to `import { registerAnnotationsEvents } from './annotations';` on line 5):

```ts
import { registerOffLimitsZonesEvents } from './off-limits-zones';
```

Add the registration call immediately after `registerAnnotationsEvents(events);` (line 109):

```ts
    registerOffLimitsZonesEvents(events);
```

- [ ] **Step 2: Serialize in `src/doc.ts`**

In the `document` object literal (around line 157-165), add two fields after `annotations: events.invoke('docSerialize.annotations'),`:

```ts
                annotations: events.invoke('docSerialize.annotations'),
                offLimitsZones: events.invoke('docSerialize.offLimitsZones'),
                offLimitsMessage: events.invoke('offLimitsZones.message'),
```

- [ ] **Step 3: Deserialize in `src/doc.ts`**

After `events.invoke('docDeserialize.annotations', document.annotations);` (line 125), add:

```ts
            events.invoke('docDeserialize.offLimitsZones', document.offLimitsZones, document.offLimitsMessage);
```

(Old documents have `document.offLimitsZones === undefined`; `docDeserialize.offLimitsZones` handles that by clearing to empty.)

- [ ] **Step 4: Build to typecheck**

Run: `npm run build`
Expected: builds with no TypeScript errors related to these files.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts src/doc.ts
git commit -m "feat: register off-limits zones model and persist in document"
```

---

## Task 4: Pure collision function — `src/viewer-companion/off-limits-collision.ts` (TDD)

A self-contained function (no imports, no closure refs — only its parameters and inner helpers) so it can be both unit-tested **and** injected verbatim into the viewer via `Function.prototype.toString()`. Returns the world-space safe point to clamp to when the segment `prev → cur` crosses a wall rectangle, else `null`.

**Files:**
- Create: `src/viewer-companion/off-limits-collision.ts`
- Test: `test/off-limits-collision.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/off-limits-collision.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import { segmentBlockedByWall, type Wall } from '../src/viewer-companion/off-limits-collision';

const wall = (over: Partial<Wall> = {}): Wall => ({
    position: over.position ?? [0, 0, 0],
    rotation: over.rotation ?? [0, 0, 0, 1],
    width: over.width ?? 2,
    height: over.height ?? 2
});

describe('segmentBlockedByWall', () => {
    it('blocks a segment crossing an axis-aligned wall within extents', () => {
        const safe = segmentBlockedByWall([0, 0, -1], [0, 0, 1], wall());
        expect(safe).toEqual([0, 0, -1]); // clamp back to the last safe (prev) position
    });

    it('does not block when the crossing point is outside the width', () => {
        // hw = 1, crossing at x = 5 -> outside
        expect(segmentBlockedByWall([5, 0, -1], [5, 0, 1], wall())).toBeNull();
    });

    it('does not block when the crossing point is outside the height', () => {
        expect(segmentBlockedByWall([0, 5, -1], [0, 5, 1], wall())).toBeNull();
    });

    it('does not block when both endpoints are on the same side', () => {
        expect(segmentBlockedByWall([0, 0, 1], [0, 0, 2], wall())).toBeNull();
        expect(segmentBlockedByWall([0, 0, -2], [0, 0, -1], wall())).toBeNull();
    });

    it('handles a wall rotated 90deg about Y (normal pointing along world X)', () => {
        // 90deg about Y: q = [0, sin45, 0, cos45]
        const q: [number, number, number, number] = [0, 0.7071067811865476, 0, 0.7071067811865476];
        const w = wall({ rotation: q });
        // segment now crosses along world X
        const safe = segmentBlockedByWall([-1, 0, 0], [1, 0, 0], w);
        expect(safe).not.toBeNull();
        expect(safe![0]).toBeCloseTo(-1, 6);
        // a segment along world Z should no longer be blocked by this rotated wall
        expect(segmentBlockedByWall([0, 0, -1], [0, 0, 1], w)).toBeNull();
    });

    it('respects a non-origin wall center', () => {
        const w = wall({ position: [10, 0, 0] });
        expect(segmentBlockedByWall([10, 0, -1], [10, 0, 1], w)).toEqual([10, 0, -1]);
        expect(segmentBlockedByWall([0, 0, -1], [0, 0, 1], w)).toBeNull();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/off-limits-collision.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write the implementation**

Create `src/viewer-companion/off-limits-collision.ts`:

```ts
type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

type Wall = {
    position: Vec3,
    rotation: Quat,   // unit quaternion [x, y, z, w]
    width: number,
    height: number
};

// Returns the world-space safe point to clamp the camera to (the last safe
// position `prev`) when the segment prev -> cur crosses the wall rectangle,
// otherwise null.
//
// IMPORTANT: this function is self-contained (no imports, no outer references;
// only its parameters and inner helpers). It is injected verbatim into the
// exported viewer via Function.prototype.toString(), so it must stay portable
// plain JS/array math. Do not add module-level dependencies.
const segmentBlockedByWall = (prev: Vec3, cur: Vec3, wall: Wall): Vec3 | null => {
    const cx = wall.position[0], cy = wall.position[1], cz = wall.position[2];
    const qx = wall.rotation[0], qy = wall.rotation[1], qz = wall.rotation[2], qw = wall.rotation[3];
    const hw = wall.width * 0.5;
    const hh = wall.height * 0.5;

    // Rotate (p - center) into the wall's local frame using the INVERSE rotation
    // (conjugate of the unit quaternion: [-qx, -qy, -qz, qw]).
    const toLocal = (p: Vec3): Vec3 => {
        const x = p[0] - cx, y = p[1] - cy, z = p[2] - cz;
        const ix = -qx, iy = -qy, iz = -qz, iw = qw;
        // t = 2 * cross(q_vec, v)
        const tx = 2 * (iy * z - iz * y);
        const ty = 2 * (iz * x - ix * z);
        const tz = 2 * (ix * y - iy * x);
        // v' = v + iw * t + cross(q_vec, t)
        return [
            x + iw * tx + (iy * tz - iz * ty),
            y + iw * ty + (iz * tx - ix * tz),
            z + iw * tz + (ix * ty - iy * tx)
        ];
    };

    const a = toLocal(prev);
    const b = toLocal(cur);
    const az = a[2], bz = b[2];

    // same side of the wall plane (or both exactly on it) -> no crossing
    if (az * bz > 0 || az === bz) {
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

    // Blocked: clamp back to the last safe (prev) world position.
    return [prev[0], prev[1], prev[2]];
};

export { segmentBlockedByWall, Wall, Vec3, Quat };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/off-limits-collision.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Lint and commit**

```bash
npx eslint src/viewer-companion/off-limits-collision.ts test/off-limits-collision.test.ts
git add src/viewer-companion/off-limits-collision.ts test/off-limits-collision.test.ts
git commit -m "feat: pure segment-vs-oriented-wall collision function"
```

---

## Task 5: Companion injection builder — `src/viewer-companion/off-limits-zones.ts` (TDD)

Builds the `<style>` + `<script>` fragment injected before `</body>`. Embeds the zones + custom message + localized default table, the stringified pure collision function, and the runtime glue (per-frame camera read/clamp, message overlay, optional 3D red wall). Mirrors `src/viewer-companion/annotation-links.ts`.

**Files:**
- Create: `src/viewer-companion/off-limits-zones.ts`
- Test: `test/off-limits-zones-injection.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/off-limits-zones-injection.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import { buildOffLimitsZonesInjection, resolveOffLimitsMessage, DEFAULT_MESSAGES } from '../src/viewer-companion/off-limits-zones';

const zone = {
    position: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0, 1] as [number, number, number, number],
    width: 2,
    height: 2
};

describe('resolveOffLimitsMessage', () => {
    it('prefers a non-empty custom message', () => {
        expect(resolveOffLimitsMessage('Stop!', DEFAULT_MESSAGES, 'fr')).toBe('Stop!');
    });
    it('falls back to the language default', () => {
        expect(resolveOffLimitsMessage('', DEFAULT_MESSAGES, 'fr')).toBe(DEFAULT_MESSAGES.fr);
    });
    it('falls back from a region subtag to the base language', () => {
        expect(resolveOffLimitsMessage('', DEFAULT_MESSAGES, 'fr-CA')).toBe(DEFAULT_MESSAGES.fr);
    });
    it('falls back to English for unknown languages', () => {
        expect(resolveOffLimitsMessage('', DEFAULT_MESSAGES, 'xx')).toBe(DEFAULT_MESSAGES.en);
    });
});

describe('buildOffLimitsZonesInjection', () => {
    it('returns empty string when there are no zones', () => {
        expect(buildOffLimitsZonesInjection([], 'msg')).toBe('');
        expect(buildOffLimitsZonesInjection(null as any, 'msg')).toBe('');
    });

    it('embeds the payload and runtime when zones exist', () => {
        const out = buildOffLimitsZonesInjection([zone], 'Custom');
        expect(out).toContain('window.__supersplatOffLimitsZones =');
        expect(out).toContain('"width":2');
        expect(out).toContain('"message":"Custom"');
        expect(out).toContain('<style>');
        expect(out).toContain('<script>');
    });

    it('escapes angle brackets so a payload cannot break out of the script tag', () => {
        const out = buildOffLimitsZonesInjection([zone], '</script><b>x');
        expect(out).not.toContain('</script><b>x');
        expect(out).toContain('\\u003c');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/off-limits-zones-injection.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write the implementation**

Create `src/viewer-companion/off-limits-zones.ts`:

```ts
import { segmentBlockedByWall } from './off-limits-collision';

type ZoneLike = {
    position: [number, number, number],
    rotation: [number, number, number, number],
    width: number,
    height: number
};

// Localized default messages, keyed by primary language subtag. Mirrors the
// language set used by annotation-links.ts.
const DEFAULT_MESSAGES: Record<string, string> = {
    en: 'You have reached the end of the scene.',
    de: 'Sie haben das Ende der Szene erreicht.',
    es: 'Has llegado al final de la escena.',
    fr: 'Vous avez atteint la fin de la scène.',
    ja: 'シーンの終わりに到達しました。',
    ko: '장면의 끝에 도달했습니다.',
    pt: 'Você chegou ao fim da cena.',
    ru: 'Вы достигли конца сцены.',
    zh: '您已到达场景的尽头。'
};

// Pure default-message resolver. Custom text wins; otherwise pick the viewer's
// language (region subtag -> base subtag -> English). Self-contained so it is
// also injected verbatim into the runtime via Function.toString().
const resolveOffLimitsMessage = (custom: string, defaults: Record<string, string>, lang: string): string => {
    if (custom) {
        return custom;
    }
    const l = (lang || 'en').toLowerCase();
    return defaults[l] || defaults[l.split('-')[0]] || defaults.en;
};

// CSS for the message overlay + the red screen-edge flash (DOM feedback that
// works regardless of whether the 3D red quad can be created).
const companionStyle = `
.ss-offlimits-overlay {
  position: fixed; inset: 0; pointer-events: none; z-index: 1000;
  box-shadow: inset 0 0 120px 40px rgba(255,0,0,0.0);
  transition: box-shadow 200ms ease-out; display: block;
}
.ss-offlimits-overlay.active { box-shadow: inset 0 0 120px 40px rgba(255,0,0,0.55); }
.ss-offlimits-message {
  position: fixed; left: 50%; bottom: 12%; transform: translateX(-50%);
  background: rgba(0,0,0,0.78); color: #fff; padding: 10px 16px; border-radius: 6px;
  font-family: sans-serif; font-size: 15px; pointer-events: none; z-index: 1001;
  opacity: 0; transition: opacity 200ms ease-out; max-width: 80%; text-align: center;
}
.ss-offlimits-message.active { opacity: 1; }
`;

// The runtime companion, kept as a string so it is injected verbatim. It reads
// window.__supersplatOffLimitsZones = { zones, message, defaults }, then each
// frame reads the viewer camera, clamps it against each wall, and shows
// feedback (red wall quad if PlayCanvas is reachable, plus a DOM message/flash).
//
// getApp()/getCameraEntity() encode the accessors confirmed by the Task 1
// spike. Adjust ONLY these two functions if the spike found different paths.
const companionRuntime = `
(function () {
  var data = window.__supersplatOffLimitsZones;
  if (!data || !data.zones || !data.zones.length) return;
  var zones = data.zones;
  var defaults = data.defaults || {};
  var custom = data.message || '';

  var segmentBlockedByWall = ${segmentBlockedByWall.toString()};
  var resolveOffLimitsMessage = ${resolveOffLimitsMessage.toString()};
  var msgText = resolveOffLimitsMessage(custom, defaults, navigator.language || 'en');

  // --- DOM feedback (always available) ---
  var overlay = document.createElement('div');
  overlay.className = 'ss-offlimits-overlay';
  var msgEl = document.createElement('div');
  msgEl.className = 'ss-offlimits-message';
  msgEl.textContent = msgText;
  function mount() {
    document.body.appendChild(overlay);
    document.body.appendChild(msgEl);
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
  var feedbackTimer = null;
  function flashFeedback() {
    overlay.classList.add('active');
    msgEl.classList.add('active');
    if (feedbackTimer) clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(function () {
      overlay.classList.remove('active');
      msgEl.classList.remove('active');
    }, 700);
  }

  // --- PlayCanvas access (spike-confirmed) ---
  function getApp() {
    var pc = window.pc;
    if (!pc) return null;
    return pc.app || (pc.Application && pc.Application.getApplication && pc.Application.getApplication()) || null;
  }
  function getCameraEntity(app) {
    if (!app || !app.root || !app.root.findComponent) return null;
    var c = app.root.findComponent('camera');
    return c ? c.entity : null;
  }

  // --- optional 3D red wall quad (one cached entity per zone) ---
  // plane (XZ) -> wall (XY): +90deg about X
  var CORR = [0.7071067811865476, 0, 0, 0.7071067811865476];
  var quads = [];
  function quadFor(app, index, zone) {
    var pc = window.pc;
    if (!pc || !app) return null;
    if (quads[index]) return quads[index];
    var e = new pc.Entity();
    e.addComponent('render', { type: 'plane' });
    var m = new pc.StandardMaterial();
    m.diffuse = new pc.Color(1, 0, 0);
    m.emissive = new pc.Color(1, 0, 0);
    m.opacity = 0.5;
    m.blendType = pc.BLEND_NORMAL;
    m.cull = pc.CULLFACE_NONE;
    m.useLighting = false;
    m.depthWrite = false;
    m.update();
    e.render.material = m;
    var zq = new pc.Quat(zone.rotation[0], zone.rotation[1], zone.rotation[2], zone.rotation[3]);
    zq.mul(new pc.Quat(CORR[0], CORR[1], CORR[2], CORR[3]));
    e.setPosition(zone.position[0], zone.position[1], zone.position[2]);
    e.setRotation(zq);
    e.setLocalScale(zone.width, 1, zone.height);
    e.enabled = false;
    app.root.addChild(e);
    quads[index] = e;
    return e;
  }
  var quadTimers = [];
  function showWall(app, index, zone) {
    var e = quadFor(app, index, zone);
    if (!e) return;
    e.enabled = true;
    if (quadTimers[index]) clearTimeout(quadTimers[index]);
    quadTimers[index] = setTimeout(function () { e.enabled = false; }, 700);
  }

  // --- per-frame clamp loop ---
  var lastSafe = null;
  function tick() {
    var app = getApp();
    var cam = app && getCameraEntity(app);
    if (cam) {
      var wp = cam.getPosition();
      var cur = [wp.x, wp.y, wp.z];
      if (lastSafe) {
        for (var i = 0; i < zones.length; i++) {
          var safe = segmentBlockedByWall(lastSafe, cur, zones[i]);
          if (safe) {
            cam.setPosition(safe[0], safe[1], safe[2]);
            cur = safe;
            flashFeedback();
            showWall(app, i, zones[i]);
            break;
          }
        }
      }
      lastSafe = cur;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
`;

// Produce the full HTML fragment to inject before </body>, or '' if no zones.
const buildOffLimitsZonesInjection = (zones: ZoneLike[], message: string): string => {
    if (!zones || zones.length === 0) {
        return '';
    }
    const payload = { zones, message: message || '', defaults: DEFAULT_MESSAGES };
    // Escape characters unsafe inside an HTML <script> context so the payload
    // cannot break out of the injected script tag (mirrors annotation-links.ts).
    const payloadJson = JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
    return `<style>${companionStyle}</style>` +
        `<script>window.__supersplatOffLimitsZones = ${payloadJson};</script>` +
        `<script>${companionRuntime}</script>`;
};

export { buildOffLimitsZonesInjection, resolveOffLimitsMessage, DEFAULT_MESSAGES };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/off-limits-zones-injection.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Lint and commit**

```bash
npx eslint src/viewer-companion/off-limits-zones.ts test/off-limits-zones-injection.test.ts
git add src/viewer-companion/off-limits-zones.ts test/off-limits-zones-injection.test.ts
git commit -m "feat: off-limits zones viewer companion injection builder"
```

---

## Task 6: Wire injection into export + UI export sites

Thread the zones + message into the viewer settings the injection reads, and inject the companion at every site that injects annotation links. Zones ride in `ExperienceSettings` exactly like `annotations`.

**Files:**
- Modify: `src/splat-serialize.ts` (`ExperienceSettings` type)
- Modify: `src/splat-export-core.ts` (add `injectOffLimitsZones`, call at 3 sites)
- Modify: `src/ui/export-popup.ts` (~line 688)
- Modify: `src/ui/publish-settings-dialog.ts` (~line 375)
- Modify: `src/ui/s3-publish-dialog.ts` (~line 187)

- [ ] **Step 1: Extend `ExperienceSettings` in `src/splat-serialize.ts`**

In the `ExperienceSettings` type (lines 114-128), add two fields after `annotations: Annotation[],`:

```ts
    annotations: Annotation[],
    offLimitsZones: { position: [number, number, number], rotation: [number, number, number, number], width: number, height: number }[],
    offLimitsMessage: string,
    startMode: 'default' | 'animTrack' | 'annotation'
```

- [ ] **Step 2: Add `injectOffLimitsZones` in `src/splat-export-core.ts`**

Add the import after line 21 (`import { buildAnnotationLinksInjection } ...`):

```ts
import { buildOffLimitsZonesInjection } from './viewer-companion/off-limits-zones';
```

Add this helper immediately after the `injectAnnotationLinks` function (after line 34):

```ts
// Inject the off-limits-zones companion into an HTML string before </body>.
// No-op (returns the input) when there are no zones.
const injectOffLimitsZones = (html: string, viewerSettingsJson: any): string => {
    const injection = buildOffLimitsZonesInjection(
        viewerSettingsJson?.offLimitsZones ?? [],
        viewerSettingsJson?.offLimitsMessage ?? ''
    );
    if (!injection) {
        return html;
    }
    if (html.includes('</body>')) {
        return html.replace('</body>', `${injection}</body>`);
    }
    return html + injection;
};
```

- [ ] **Step 3: Call it at the three injection sites in `src/splat-export-core.ts`**

Site A — streaming (line 379). Replace:

```ts
    const withLinks = injectAnnotationLinks(repointed, viewerSettingsJson);
    memFs.results.set('index.html', new TextEncoder().encode(withLinks));
```

with:

```ts
    const withLinks = injectAnnotationLinks(repointed, viewerSettingsJson);
    const withZones = injectOffLimitsZones(withLinks, viewerSettingsJson);
    memFs.results.set('index.html', new TextEncoder().encode(withZones));
```

Site B — html (line 433). Replace:

```ts
            const injected = injectAnnotationLinks(new TextDecoder().decode(raw), viewerSettingsJson);
            const writer = await fs.createWriter('output.html');
            await writer.write(new TextEncoder().encode(injected));
```

with:

```ts
            const injected = injectOffLimitsZones(injectAnnotationLinks(new TextDecoder().decode(raw), viewerSettingsJson), viewerSettingsJson);
            const writer = await fs.createWriter('output.html');
            await writer.write(new TextEncoder().encode(injected));
```

Site C — package (line 449). Replace:

```ts
            const injected = injectAnnotationLinks(new TextDecoder().decode(rawIndex), viewerSettingsJson);
            memFs.results.set('index.html', new TextEncoder().encode(injected));
```

with:

```ts
            const injected = injectOffLimitsZones(injectAnnotationLinks(new TextDecoder().decode(rawIndex), viewerSettingsJson), viewerSettingsJson);
            memFs.results.set('index.html', new TextEncoder().encode(injected));
```

- [ ] **Step 4: Add the two fields to each of the three `experienceSettings` literals**

In `src/ui/export-popup.ts` (~line 688), `src/ui/publish-settings-dialog.ts` (~line 375), and `src/ui/s3-publish-dialog.ts` (~line 187), each has:

```ts
    annotations: events.invoke('annotations.export') ?? [],
```

Add immediately after that line, in all three files:

```ts
    offLimitsZones: events.invoke('offLimitsZones.export') ?? [],
    offLimitsMessage: events.invoke('offLimitsZones.message') ?? '',
```

(The server path uses `experienceSettings: any` in `server/src/run-export.ts`, so it forwards these fields with no change.)

- [ ] **Step 5: Build to typecheck**

Run: `npm run build`
Expected: builds with no TypeScript errors. (If `ExperienceSettings` is constructed anywhere else without the new required fields, the compiler will flag it — add `offLimitsZones: [], offLimitsMessage: ''` there too.)

- [ ] **Step 6: Commit**

```bash
git add src/splat-serialize.ts src/splat-export-core.ts src/ui/export-popup.ts src/ui/publish-settings-dialog.ts src/ui/s3-publish-dialog.ts
git commit -m "feat: inject off-limits zones companion into exported viewer"
```

---

## Task 7: Editor zone visual — `src/off-limits-zone-shape.ts`

A thin transparent plane mesh per zone (red translucent; brighter when selected). A `pivot` entity carries the zone's exact `position`/`rotation` (gizmo target); a child `plane` carries the `CORRECTION` and the `width × height` scale.

**Files:**
- Create: `src/off-limits-zone-shape.ts`

- [ ] **Step 1: Write the implementation**

Create `src/off-limits-zone-shape.ts`:

```ts
import { BLEND_NORMAL, CULLFACE_NONE, Color, Entity, Quat, StandardMaterial } from 'playcanvas';

import { Element, ElementType } from './element';

// plane primitive (XZ) -> wall (local XY): +90deg about X.
const CORRECTION = new Quat(0.7071067811865476, 0, 0, 0.7071067811865476);

class OffLimitsZoneShape extends Element {
    pivot: Entity;
    plane: Entity;
    material: StandardMaterial;

    constructor() {
        super(ElementType.debug);

        this.pivot = new Entity('offLimitsZonePivot');
        this.plane = new Entity('offLimitsZonePlane');
        this.plane.addComponent('render', { type: 'plane' });
        this.plane.setLocalRotation(CORRECTION);
        this.pivot.addChild(this.plane);
    }

    add() {
        const material = new StandardMaterial();
        material.diffuse = new Color(1, 0, 0);
        material.emissive = new Color(1, 0, 0);
        material.opacity = 0.25;
        material.blendType = BLEND_NORMAL;
        material.cull = CULLFACE_NONE;
        material.useLighting = false;
        material.depthWrite = false;
        material.update();

        this.material = material;
        this.plane.render.meshInstances[0].material = material;
        this.plane.render.layers = [this.scene.worldLayer.id];

        this.scene.contentRoot.addChild(this.pivot);
    }

    remove() {
        this.scene.contentRoot.removeChild(this.pivot);
    }

    destroy() {
    }

    // Place the wall: pivot holds the true position/rotation (gizmo target);
    // the child plane holds the orientation correction + size.
    setTransform(position: number[], rotation: number[], width: number, height: number) {
        this.pivot.setPosition(position[0], position[1], position[2]);
        this.pivot.setRotation(new Quat(rotation[0], rotation[1], rotation[2], rotation[3]));
        this.plane.setLocalScale(width, 1, height);
    }

    set selected(value: boolean) {
        this.material.opacity = value ? 0.5 : 0.25;
        this.material.update();
    }
}

export { OffLimitsZoneShape };
```

- [ ] **Step 2: Build to typecheck**

Run: `npm run build`
Expected: no TypeScript errors. (If `Element`/`ElementType` import path or `scene.worldLayer`/`scene.contentRoot` differ, mirror exactly what `src/box-shape.ts` does — this class follows that file's pattern.)

- [ ] **Step 3: Lint and commit**

```bash
npx eslint src/off-limits-zone-shape.ts
git add src/off-limits-zone-shape.ts
git commit -m "feat: off-limits zone plane mesh element for the editor"
```

---

## Task 8: Editor tool — `src/tools/off-limits-zone-tool.ts` + registration

Floating toolbar (Add button, width/height inputs, global message field). All zones rendered as planes; click near a zone center to select; translate + rotate gizmos edit the selected zone; Delete removes it. Mirrors `src/tools/annotation-tool.ts`.

**Files:**
- Create: `src/tools/off-limits-zone-tool.ts`
- Modify: `src/main.ts` (import + register)

- [ ] **Step 1: Write the tool**

Create `src/tools/off-limits-zone-tool.ts`:

```ts
import { Button, Container, Label, NumericInput, TextInput } from '@playcanvas/pcui';
import { Quat, RotateGizmo, TranslateGizmo, Vec3 } from 'playcanvas';

import { Events } from '../events';
import { AddZoneOp, RemoveZoneOp, SetMessageOp, UpdateZoneOp, ZoneData } from '../off-limits-zones';
import { OffLimitsZoneShape } from '../off-limits-zone-shape';
import { Scene } from '../scene';
import { localize } from '../ui/localization';

const p = new Vec3();
const screen = new Vec3();
const tmpQuat = new Quat();

class OffLimitsZoneTool {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, scene: Scene, canvasContainer: Container) {
        let active = false;

        // per-zone plane meshes, keyed by zone id
        const shapes = new Map<string, OffLimitsZoneShape>();

        // --- floating editor bar ---
        const bar = new Container({ class: ['select-toolbar', 'annotations-toolbar'], hidden: true });
        bar.dom.addEventListener('pointerdown', e => e.stopPropagation());

        const addButton = new Button({ text: localize('offLimitsZones.add'), class: 'select-toolbar-button' });
        const widthLabel = new Label({ text: localize('offLimitsZones.width') });
        const widthInput = new NumericInput({ precision: 2, value: 2, width: 80, min: 0.01 });
        const heightLabel = new Label({ text: localize('offLimitsZones.height') });
        const heightInput = new NumericInput({ precision: 2, value: 2, width: 80, min: 0.01 });
        const messageLabel = new Label({ text: localize('offLimitsZones.message') });
        const messageInput = new TextInput({ class: 'annotations-toolbar-input' });

        bar.append(addButton);
        bar.append(widthLabel);
        bar.append(widthInput);
        bar.append(heightLabel);
        bar.append(heightInput);
        bar.append(messageLabel);
        bar.append(messageInput);
        canvasContainer.append(bar);

        // --- selection helpers ---
        const selected = (): ZoneData | null => {
            const id = events.invoke('offLimitsZones.selected') as string | null;
            return id ? (events.invoke('offLimitsZones.byId', id) as ZoneData) : null;
        };

        let suppress = false;
        const refreshBar = () => {
            bar.hidden = !active;
            if (!active) {
                return;
            }
            suppress = true;
            messageInput.value = events.invoke('offLimitsZones.message') as string;
            messageInput.placeholder = localize('offLimitsZones.defaultMessage');
            const z = selected();
            widthInput.enabled = !!z;
            heightInput.enabled = !!z;
            if (z) {
                widthInput.value = z.width;
                heightInput.value = z.height;
            }
            suppress = false;
        };

        const commitSize = (field: 'width' | 'height', value: number) => {
            if (suppress) {
                return;
            }
            const z = selected();
            if (!z || z[field] === value) {
                return;
            }
            events.fire('edit.add', new UpdateZoneOp(events, z.id, { [field]: z[field] }, { [field]: value }));
        };

        widthInput.on('change', (v: number) => commitSize('width', v));
        heightInput.on('change', (v: number) => commitSize('height', v));
        messageInput.on('change', (v: string) => {
            if (suppress) {
                return;
            }
            const current = events.invoke('offLimitsZones.message') as string;
            if (current !== v) {
                events.fire('edit.add', new SetMessageOp(events, current, v));
            }
        });

        // --- add a new zone at the current view target ---
        addButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            if (!active) {
                return;
            }
            const pose = events.invoke('camera.getPose');
            const t = pose?.target ?? { x: 0, y: 0, z: 0 };
            const data: ZoneData = {
                id: events.invoke('offLimitsZones.newId') as string,
                position: [t.x, t.y, t.z],
                rotation: [0, 0, 0, 1],
                width: 2,
                height: 2
            };
            events.fire('edit.add', new AddZoneOp(events, data));
        });

        // --- gizmos (translate + rotate) ---
        const translateGizmo = new TranslateGizmo(scene.camera.camera, scene.gizmoLayer);
        const rotateGizmo = new RotateGizmo(scene.camera.camera, scene.gizmoLayer);
        const dragPos = new Vec3();
        const dragRot = new Quat();

        const pivotOf = (id: string) => shapes.get(id)?.pivot ?? null;

        const updateGizmos = () => {
            translateGizmo.detach();
            rotateGizmo.detach();
            const z = active ? selected() : null;
            const pivot = z ? pivotOf(z.id) : null;
            if (pivot) {
                translateGizmo.attach(pivot);
                rotateGizmo.attach(pivot);
            }
        };

        const onRender = () => {
            scene.forceRender = true;
        };
        translateGizmo.on('render:update', onRender);
        rotateGizmo.on('render:update', onRender);

        const onStart = () => {
            const z = selected();
            const pivot = z ? pivotOf(z.id) : null;
            if (pivot) {
                dragPos.copy(pivot.getPosition());
                dragRot.copy(pivot.getRotation());
            }
        };
        translateGizmo.on('transform:start', onStart);
        rotateGizmo.on('transform:start', onStart);

        const onEnd = () => {
            const z = selected();
            const pivot = z ? pivotOf(z.id) : null;
            if (!z || !pivot) {
                return;
            }
            const pos = pivot.getPosition();
            const rot = pivot.getRotation();
            const moved = pos.x !== dragPos.x || pos.y !== dragPos.y || pos.z !== dragPos.z;
            const rotated = rot.x !== dragRot.x || rot.y !== dragRot.y || rot.z !== dragRot.z || rot.w !== dragRot.w;
            if (!moved && !rotated) {
                return;
            }
            events.fire('edit.add', new UpdateZoneOp(
                events,
                z.id,
                { position: [dragPos.x, dragPos.y, dragPos.z], rotation: [dragRot.x, dragRot.y, dragRot.z, dragRot.w] },
                { position: [pos.x, pos.y, pos.z], rotation: [rot.x, rot.y, rot.z, rot.w] }
            ));
        };
        translateGizmo.on('transform:end', onEnd);
        rotateGizmo.on('transform:end', onEnd);

        const updateGizmoSize = () => {
            const { camera, canvas } = scene;
            const size = camera.ortho ? 1125 / canvas.clientHeight : 1200 / Math.max(canvas.clientWidth, canvas.clientHeight);
            translateGizmo.size = size;
            rotateGizmo.size = size;
        };
        updateGizmoSize();
        events.on('camera.resize', updateGizmoSize);
        events.on('camera.ortho', updateGizmoSize);

        // --- click to select by zone center proximity ---
        const isPrimary = (e: PointerEvent) => (e.pointerType === 'mouse' ? e.button === 0 : e.isPrimary);

        const zoneAt = (offsetX: number, offsetY: number): ZoneData | null => {
            const zones = events.invoke('offLimitsZones.list') as ZoneData[];
            for (let i = 0; i < zones.length; i++) {
                const z = zones[i];
                p.set(z.position[0], z.position[1], z.position[2]);
                if (!scene.camera.worldToScreen(p, screen)) {
                    continue;
                }
                screen.x *= canvasContainer.dom.clientWidth;
                screen.y *= canvasContainer.dom.clientHeight;
                if (Math.abs(screen.x - offsetX) < 12 && Math.abs(screen.y - offsetY) < 12) {
                    return z;
                }
            }
            return null;
        };

        let clicked = false;
        const pointerdown = (e: PointerEvent) => {
            if (!clicked && isPrimary(e)) {
                clicked = true;
            }
        };
        const pointermove = () => {
            clicked = false;
        };
        const pointerup = (e: PointerEvent) => {
            if (!active || !clicked || !isPrimary(e)) {
                return;
            }
            clicked = false;
            const hit = zoneAt(e.offsetX, e.offsetY);
            if (hit) {
                events.fire('offLimitsZones.select', hit.id);
                e.preventDefault();
                e.stopPropagation();
            }
        };

        // --- delete selected zone ---
        events.on('select.delete', () => {
            if (!active) {
                return;
            }
            const id = events.invoke('offLimitsZones.selected') as string | null;
            if (!id) {
                return;
            }
            const zones = events.invoke('offLimitsZones.list') as ZoneData[];
            const index = zones.findIndex(z => z.id === id);
            const data = zones[index];
            if (data) {
                events.fire('edit.add', new RemoveZoneOp(events, data, index));
            }
        });

        // --- reconcile plane meshes with the data ---
        const isDragging = () => translateGizmo.dragging || rotateGizmo.dragging;

        const syncShapes = () => {
            const zones = events.invoke('offLimitsZones.list') as ZoneData[];
            const liveIds = new Set(zones.map(z => z.id));
            // remove shapes for deleted zones
            for (const [id, shape] of shapes) {
                if (!liveIds.has(id)) {
                    scene.remove(shape);
                    shapes.delete(id);
                }
            }
            const selId = events.invoke('offLimitsZones.selected') as string | null;
            for (const z of zones) {
                let shape = shapes.get(z.id);
                if (!shape) {
                    shape = new OffLimitsZoneShape();
                    scene.add(shape);
                    shapes.set(z.id, shape);
                }
                // do not fight the gizmo while dragging the selected zone
                if (!(isDragging() && z.id === selId)) {
                    shape.setTransform(z.position, z.rotation, z.width, z.height);
                }
                shape.selected = z.id === selId;
            }
        };

        const clearShapes = () => {
            for (const [, shape] of shapes) {
                scene.remove(shape);
            }
            shapes.clear();
        };

        events.on('offLimitsZones.changed', () => {
            syncShapes();
            refreshBar();
            updateGizmos();
        });
        events.on('offLimitsZones.selectionChanged', () => {
            syncShapes();
            refreshBar();
            updateGizmos();
        });

        this.activate = () => {
            active = true;
            canvasContainer.dom.addEventListener('pointerdown', pointerdown);
            canvasContainer.dom.addEventListener('pointermove', pointermove);
            canvasContainer.dom.addEventListener('pointerup', pointerup, true);
            syncShapes();
            refreshBar();
            updateGizmos();
        };

        this.deactivate = () => {
            active = false;
            canvasContainer.dom.removeEventListener('pointerdown', pointerdown);
            canvasContainer.dom.removeEventListener('pointermove', pointermove);
            canvasContainer.dom.removeEventListener('pointerup', pointerup, true);
            events.fire('offLimitsZones.select', null);
            bar.hidden = true;
            translateGizmo.detach();
            rotateGizmo.detach();
            clearShapes();
        };
    }
}

export { OffLimitsZoneTool };
```

- [ ] **Step 2: Register the tool in `src/main.ts`**

Add the import next to `import { AnnotationTool } from './tools/annotation-tool';` (line 23):

```ts
import { OffLimitsZoneTool } from './tools/off-limits-zone-tool';
```

Add the registration after `toolManager.register('annotation', ...)` (line 250):

```ts
    toolManager.register('offLimitsZones', new OffLimitsZoneTool(events, scene, editorUI.canvasContainer));
```

- [ ] **Step 3: Build to typecheck**

Run: `npm run build`
Expected: no TypeScript errors.

> Note: if `translateGizmo.dragging` / `rotateGizmo.dragging` are not exposed on the gizmo type, replace `isDragging()` with a local boolean toggled on `transform:start` (set true) and `transform:end` (set false) for both gizmos.

- [ ] **Step 4: Lint and commit**

```bash
npx eslint src/tools/off-limits-zone-tool.ts src/main.ts
git add src/tools/off-limits-zone-tool.ts src/main.ts
git commit -m "feat: off-limits zone editor tool with translate/rotate gizmos"
```

---

## Task 9: Toolbar button, icon, tooltip, and locale keys

**Files:**
- Create: `src/ui/svg/off-limits.svg`
- Modify: `src/ui/bottom-toolbar.ts`
- Modify: `static/locales/en.json` (+ `defaultMessage` in all 9 locale files)

- [ ] **Step 1: Create the icon `src/ui/svg/off-limits.svg`**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="9"/>
  <line x1="5" y1="5" x2="19" y2="19"/>
</svg>
```

- [ ] **Step 2: Wire the button in `src/ui/bottom-toolbar.ts`**

Add the import next to the other svg imports (after line 6, `import annotationsSvg from './svg/annotations.svg';`):

```ts
import offLimitsSvg from './svg/off-limits.svg';
```

Create the button after the `annotation` button (after line 122):

```ts
        const offLimits = new Button({
            id: 'bottom-toolbar-off-limits',
            class: 'bottom-toolbar-tool'
        });
```

Append its icon after `annotation.dom.appendChild(createSvg(annotationsSvg));` (line 146):

```ts
        offLimits.dom.appendChild(createSvg(offLimitsSvg));
```

Append it to the toolbar after `this.append(annotation);` (line 168):

```ts
        this.append(offLimits);
```

Fire its event after `annotation.dom.addEventListener('click', () => events.fire('tool.annotation'));` (line 186):

```ts
        offLimits.dom.addEventListener('click', () => events.fire('tool.offLimitsZones'));
```

Update the active-class block — add inside the `events.on('tool.activated', ...)` handler after the `annotation.class[...]` line (line 209):

```ts
            offLimits.class[toolName === 'offLimitsZones' ? 'add' : 'remove']('active');
```

Register its tooltip after `tooltips.register(annotation, ...)` (line 248):

```ts
        tooltips.register(offLimits, tooltip('tooltip.bottom-toolbar.off-limits'));
```

- [ ] **Step 3: Add English UI keys to `static/locales/en.json`**

After the `"panel.annotations.new-tab": ...` line (line 63), add:

```json
    "offLimitsZones.add": "Add Zone",
    "offLimitsZones.width": "Width",
    "offLimitsZones.height": "Height",
    "offLimitsZones.message": "Message",
    "offLimitsZones.defaultMessage": "You have reached the end of the scene.",
    "tooltip.bottom-toolbar.off-limits": "Off-Limits Zones",
```

(UI labels/tooltips rely on i18next English fallback in the other locales, matching how recent features added keys.)

- [ ] **Step 4: Add the localized `defaultMessage` to each non-English locale**

Add an `"offLimitsZones.defaultMessage"` key to each file (same placement convention). Use these values:

- `static/locales/de.json`: `"offLimitsZones.defaultMessage": "Sie haben das Ende der Szene erreicht.",`
- `static/locales/es.json`: `"offLimitsZones.defaultMessage": "Has llegado al final de la escena.",`
- `static/locales/fr.json`: `"offLimitsZones.defaultMessage": "Vous avez atteint la fin de la scène.",`
- `static/locales/ja.json`: `"offLimitsZones.defaultMessage": "シーンの終わりに到達しました。",`
- `static/locales/ko.json`: `"offLimitsZones.defaultMessage": "장면의 끝에 도달했습니다.",`
- `static/locales/pt-BR.json`: `"offLimitsZones.defaultMessage": "Você chegou ao fim da cena.",`
- `static/locales/ru.json`: `"offLimitsZones.defaultMessage": "Вы достигли конца сцены.",`
- `static/locales/zh-CN.json`: `"offLimitsZones.defaultMessage": "您已到达场景的尽头。",`

(These mirror the `DEFAULT_MESSAGES` table in `off-limits-zones.ts`, which drives the viewer-side default.)

- [ ] **Step 5: Build to typecheck and verify JSON parses**

Run: `npm run build`
Expected: builds; the `.svg` import resolves and locale JSON parses (a JSON syntax error fails the build).

- [ ] **Step 6: Commit**

```bash
git add src/ui/svg/off-limits.svg src/ui/bottom-toolbar.ts static/locales/
git commit -m "feat: off-limits zones toolbar button, icon, and localization"
```

---

## Task 10: Manual end-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Run the editor**

Run: `npm run develop` and open the served URL. Load a `.ply`/`.splat` scene.

- [ ] **Step 2: Author zones**

Activate the Off-Limits Zones tool (new bottom-toolbar button). Click **Add Zone** twice. Confirm:
- Two red semi-transparent rectangles appear at the view target.
- Clicking near a zone's center selects it (it brightens) and shows translate + rotate gizmos.
- Translating and rotating the selected zone moves/orients the red plane (rotation is honored — the plane is not axis-aligned).
- Editing Width/Height resizes the selected plane.
- Undo/redo (Ctrl+Z / Ctrl+Y) reverses add, move, rotate, resize, and message edits.
- Delete/Backspace removes the selected zone.
- Leave the Message field empty (to test the localized default), or type custom text.

- [ ] **Step 3: Persist**

Save the project, reload the editor, and re-open it. Confirm the zones and message round-trip (same positions, orientations, sizes, and message text).

- [ ] **Step 4: Export and verify the viewer**

Export a **ZIP viewer**. Unzip and serve it. In the viewer:
- Walk/fly toward a zone. Confirm the camera is blocked from passing through it.
- Confirm the wall briefly flashes red and the message appears (the red screen-edge flash + message overlay always appears; the 3D red wall appears if the Task 1 spike confirmed mesh creation).
- With the message left empty in the editor, set the browser/OS language (or `navigator.language`) and confirm the default message shows in that language (e.g. French → "Vous avez atteint la fin de la scène.").

- [ ] **Step 5: Verify a no-zones export is unchanged**

Export a scene with **no** zones. Confirm `index.html` contains no `__supersplatOffLimitsZones` script (the injection is a no-op).

- [ ] **Step 6: Full test + lint sweep**

```bash
npm test
npm run lint
```

Expected: all unit tests pass; lint clean.

---

## Self-Review notes

- **Spec coverage:** data model (T2), persistence (T3), collision math (T4), localized default + injection (T5), export wiring incl. all 3 UI sites + server passthrough (T6), editor plane rendering incl. rotation correctness (T7), tool + gizmos + selection + delete + multiple zones (T8), toolbar/icon/i18n (T9), spike + manual E2E (T1, T10).
- **Rendering deviation:** plane mesh instead of `BoxShape` (per approved spec update) — handled in T7 and reflected in the shared CORRECTION constant reused by the viewer quad (T5).
- **Type consistency:** `ZoneData`/`ZoneExport` from `off-limits-zones.ts`; the `ExperienceSettings.offLimitsZones` shape (T6 Step 1) matches `ZoneExport`; `segmentBlockedByWall`/`Wall` from `off-limits-collision.ts` used by T5; event names (`offLimitsZones.*`) consistent across model, tool, and export.
- **Spike-dependent code is complete, not placeholder:** `getApp()`/`getCameraEntity()` encode concrete accessors that T1 validates; only those two functions change if the spike finds a different path.
