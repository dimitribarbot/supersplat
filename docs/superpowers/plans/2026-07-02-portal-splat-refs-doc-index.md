# Portal Splat References via Document Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make portal↔splat references survive across editor sessions by persisting them as document splat-array indices (remapped to live uids on load) instead of session-scoped uids only.

**Architecture:** The in-memory portal model keeps using splat `uid`s (no change to runtime state, tools, export, or UI). Only serialization changes: `docSerialize.portals` gains an optional `uidToIndex` map and writes `frontIndex`/`backIndex` alongside the legacy uid fields; a new `docSerialize.portalsIndex` function produces index-based start-splat and entrypoint fields; `docDeserialize.portals` gains an optional 4th `remap` argument that resolves indices back to the live uids of the splats just created by the document loader. Legacy `.ssproj` files (uid fields only) fall back to today's behavior verbatim.

**Tech Stack:** TypeScript, Vitest (Node env), PlayCanvas-based SuperSplat editor, event-bus architecture (`events.function`/`events.invoke`).

**Series note:** This plan is one of a 6-plan series written 2026-07-02 against commit `916666a`. Plans 3, 5, and 6 of the series modify `src/viewer-companion/portals.ts` (this plan does NOT); earlier plans in the series may have merged before this one executes. Task 0 below is the mandatory preflight: for each file:line citation and code anchor in this plan, grep to confirm the anchor still exists; if code has drifted, adapt the plan's snippets to the current code rather than pasting blindly.

## Context

### Repo primer (read this first — you have zero other context)

SuperSplat (`C:\Dev\playcanvas\supersplat`) is a browser-based 3D Gaussian-splat editor built on the PlayCanvas engine + PCUI. This fork adds a **portals** feature: a project can contain multiple splat scenes; the exported HTML viewer renders one scene at a time and swaps when the camera crosses a doorway (a portal rectangle whose +Z side shows the `frontUid` splat and -Z side the `backUid` splat).

Key architecture facts:

- A single event bus (`src/events.ts`, created in `src/main.ts`) wires everything: `events.fire/on` = pub-sub, `events.function(name, fn)` / `events.invoke(name, ...args)` = queryable registered callbacks. Modules register via `registerXxxEvents(events)` called from `main.ts`.
- Scene elements extend `src/element.ts` (lifecycle add/remove/serialize; **monotonic session-scoped `uid`** assigned in the constructor).
- Portal editor state lives in `src/portals.ts` (`registerPortalsEvents`): an array of `PortalData` records (`frontUid`/`backUid` splat refs), a `startUid` (start scene), and an `entrypoints` map (`uid -> [x,y,z]` spawn position per scene).
- Documents are `.ssproj` ZIP files written/read by `src/doc.ts` (`registerDocEvents`): `document.json` (all metadata) + one `splat_<i>.ply` per splat, where `i` is the splat's index in the `scene.allSplats` array at save time.
- Tests: Vitest, Node env, `test/**/*.test.ts`. Run all: `npm run test`. Run one file: `npx vitest run test/portals.test.ts`. Lint: `npm run lint`. `src/portals.ts` is already unit-tested through a minimal fake event bus (see `test/portals.test.ts` — `makeEvents()`), so all serialization logic in this plan is pure-testable.
- Dev server: `npm run develop` → http://localhost:3333 (debug build with watch; refresh the browser manually after rebuilds).

### The defect (verified against commit `916666a`)

Portals persist splat references by **session-scoped uid**, which is never restored on document load:

- `src/element.ts:24` — `let nextUid = 1;` — a module-level monotonic counter, never reset. **Every** `Element` consumes from it at construction: splats, but also camera, portal/off-limits debug shape elements, etc.
- `Splat.docDeserialize` (`src/splat.ts:661-674`) restores name/transform/tint/visibility only — **not** the uid (it cannot: the uid was already assigned by the `Element` constructor when the asset loader built the splat).
- `src/doc.ts:168-170` saves portal data keyed by these uids (`portals` records carry `frontUid`/`backUid`; `portalsStartSplat` is a uid; `portalsEntrypoints` is a uid-keyed record), and `src/doc.ts:127` feeds them back raw on load with no remapping:
  ```ts
  events.invoke('docDeserialize.portals', document.portals, document.portalsStartSplat, document.portalsEntrypoints);
  ```

**Failure mode:** save a doc whose splats got uids 2,3. In another session, load any other scene first (or open the same doc twice in one session, or create any element before loading — the counter only advances) → the reloaded splats get different uids → every portal silently dangles or, worse, binds to the **wrong** splat: walkthrough breaks, the portal panel's front/back dropdowns are wrong, exports are wrong. It survives E2E today only because fresh-boot save → fresh-boot load happens to reproduce the same uid sequence.

**Sibling check (done, no action needed):** portals are the *only* subsystem that persists splat uids. `src/off-limits-zones.ts`, `src/annotations.ts`, `src/timeline.ts`, and `src/camera-poses.ts` were grepped for uid usage in their `docSerialize.*` payloads — none found. This plan's scope is portals only.

### Chosen design (user-approved)

Serialize splat references as the splat's **index in the document's splat array** — the same identity already used for the `splat_<i>.ply` filenames in the `.ssproj` — and remap index→live-uid during document load. The in-memory model keeps using uids; only serialization/deserialization changes.

Why the index is a sound identity — verified save/load chain:

- **Save** (`src/doc.ts:153-209`): a single `splats` array is fetched once (`events.invoke('scene.allSplats')`, line 157), then used for BOTH `document.splats = splats.map(s => s.docSerialize())` (line 171) AND the `splat_${i}.ply` write loop (lines 194-196). So at save time, index `i` in that array ↔ `splats[i].uid` ↔ `splat_i.ply` is exact. (`scene.allSplats` is `scene.getElementsByType(ElementType.splat)` — `src/file-handler.ts:468-470` — a filter over `scene.elements`, which preserves `scene.add` insertion order, `src/scene.ts:261-266`.)
- **Load** (`src/doc.ts:104-115`): splats are loaded **sequentially with `await` in a plain `for` loop over `document.splats`**, index `i` loading `splat_${i}.ply`. Each `scene.assetLoader.load(...)` constructs the `Splat` (and thus assigns its uid) before returning (`src/asset-loader.ts:40` — `return new Splat(asset, transform.rotation)`), so by the time the loop body continues, the uid for document index `i` is known. The `docDeserialize.portals` invoke happens at `src/doc.ts:127`, strictly **after** the whole loop — all live uids are known at that point. The remap therefore runs there, fed by an array collected inside the loop.

**Backward compatibility (REQUIRED):** previously saved `.ssproj` files contain only the raw-uid fields. Strategy:

- **New saves write BOTH** the legacy uid fields (`frontUid`/`backUid`/`portalsStartSplat`/`portalsEntrypoints`) and the new index fields (`frontIndex`/`backIndex`/`portalsStartSplatIndex`/`portalsEntrypointsByIndex`). Rationale for keeping the uid fields: it costs a few bytes, keeps new files loadable by pre-fix builds (with the old fresh-session-only guarantee), and makes rollback trivial. Old deserializers read only the fields they know, so the extra fields are harmless.
- **On load:** if index fields are present (they are `null` rather than absent in new files even when unset, because the serializer always writes them — `JSON.stringify` keeps `null` but drops `undefined`, so presence-of-field is a reliable new-format discriminator), remap index→uid, **ignoring** the legacy uid fields entirely (falling back to a legacy uid when an index is null would silently reintroduce the bug). If index fields are absent (legacy file), fall back to today's raw-uid behavior verbatim. **Accepted limitation:** legacy files retain the old fresh-session-only guarantee — they load correctly only when the uid sequence happens to match (fresh boot, doc loaded first).

### New document.json fields (written by `saveDocument`)

| Field | Type | Meaning |
|---|---|---|
| `portals[i].frontIndex` | `number \| null` | document splat index of the front scene (null = unset/stale ref) |
| `portals[i].backIndex` | `number \| null` | document splat index of the back scene |
| `portalsStartSplatIndex` | `number \| null` | document splat index of the walkthrough start scene |
| `portalsEntrypointsByIndex` | `Record<string, [number, number, number]>` | entrypoint position keyed by `String(splatIndex)` |

## Global Constraints

- Use Bash (Git Bash on Windows), never PowerShell. Run all commands plainly from the repo root — no `cd`, `git -C`, or `npm --prefix` prefixes (they trigger permission prompts).
- ESLint is pinned to v10 and **crashes on `import/order` autofix** — never run `eslint --fix` for import ordering; match surrounding import order by hand.
- Never delete `package-lock.json`.
- `tsconfig`: `strictNullChecks: false`, `noImplicitAny: true`. Match surrounding code style; comments explain constraints, not narration.
- Don't touch code unrelated to the task. This plan touches exactly two source files (`src/portals.ts`, `src/doc.ts`) and one test file (`test/portals.test.ts`).
- Work on a feature branch (`feat/portal-splat-refs-doc-index`). When the feature is complete and verified, squash all commits into a single commit summarizing the change (the finishing skill handles this — see final task).
- Do NOT modify `src/viewer-companion/*` (other plans in this series own that file; this change is editor-serialization only and never gets stringified into the exported viewer).

---

### Task 0: Preflight — verify plan anchors against current source

**Files:**
- Read only: `src/portals.ts`, `src/doc.ts`, `src/element.ts`, `src/asset-loader.ts`, `test/portals.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: confidence that the snippets below still match; adapted snippets if not.

- [ ] **Step 1: Create the feature branch**

```bash
git checkout main
git checkout -b feat/portal-splat-refs-doc-index
```

- [ ] **Step 2: Verify every anchor this plan relies on**

Run each grep; each must match. If any does not, read the surrounding code and adapt the corresponding snippet in this plan to current reality before proceeding.

```bash
grep -n "let nextUid = 1" src/element.ts
grep -n "docSerialize.portals" src/portals.ts src/doc.ts
grep -n "docDeserialize.portals" src/portals.ts src/doc.ts
grep -n "portalsStartSplat" src/doc.ts
grep -n "portalsEntrypoints" src/doc.ts
grep -n "scene.allSplats" src/doc.ts
grep -n "splat.docDeserialize(splatSettings)" src/doc.ts
grep -n "return new Splat" src/asset-loader.ts
grep -n "exportEntrypoints" src/portals.ts
```

Expected (against `916666a`): `src/element.ts:24`, `src/portals.ts:232` + `src/doc.ts:168`, `src/portals.ts:243` + `src/doc.ts:127`, `src/doc.ts:169` + `:127`, `src/doc.ts:170` + `:127`, `src/doc.ts:157`, `src/doc.ts:114`, `src/asset-loader.ts:40`, `src/portals.ts:149`.

- [ ] **Step 3: Confirm the existing portal test suite is green before changing anything**

Run: `npx vitest run test/portals.test.ts`
Expected: all tests pass (13 tests at `916666a`).

---

### Task 1: `src/portals.ts` — serialize splat refs as document indices

**Files:**
- Modify: `src/portals.ts` (type block lines 8-17; `docSerialize.portals` lines 232-241; add `docSerialize.portalsIndex` right after it)
- Test: `test/portals.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: existing `PortalData` type, module-local `portals`, `startUid`, `entrypoints` state in `registerPortalsEvents`.
- Produces (later tasks rely on these exact shapes):
  - `PortalDocData = PortalData & { frontIndex?: number | null, backIndex?: number | null }` (module-local type, the on-disk portal record shape).
  - `events.function('docSerialize.portals', (uidToIndex?: Map<number, number>) => PortalDocData[])` — when `uidToIndex` is given, every record carries `frontIndex`/`backIndex` (`null` for unset or unknown uids); when omitted, behavior is byte-identical to today (no index keys at all).
  - `events.function('docSerialize.portalsIndex', (uidToIndex: Map<number, number>) => { startSplatIndex: number | null, entrypointsByIndex: Record<string, [number, number, number]> })` — start splat and entrypoints converted to index space; stale uids (not in the map) are dropped (start → `null`, entrypoint → omitted).

- [ ] **Step 1: Write the failing tests**

Append this block at the end of `test/portals.test.ts` (after the closing `});` of the `portal entrypoints` describe). Note it reuses the file's existing `makeEvents`, `portal`, and imported ops — do not redefine them.

```ts
describe('portal doc-index serialization', () => {
    it('docSerialize.portals writes frontIndex/backIndex from the uid->index map', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        new AddPortalOp(events, portal({ frontUid: 2, backUid: 3 })).do();
        const serialized = events.invoke('docSerialize.portals', new Map([[2, 0], [3, 1]]));
        expect(serialized[0].frontIndex).toBe(0);
        expect(serialized[0].backIndex).toBe(1);
        // legacy uid fields are still written alongside (rollback / old-build compat)
        expect(serialized[0].frontUid).toBe(2);
        expect(serialized[0].backUid).toBe(3);
    });

    it('docSerialize.portals writes null indices for null or unknown uids', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        new AddPortalOp(events, portal({ frontUid: null, backUid: 99 })).do();
        const serialized = events.invoke('docSerialize.portals', new Map([[2, 0]]));
        expect(serialized[0].frontIndex).toBeNull();
        expect(serialized[0].backIndex).toBeNull();
    });

    it('docSerialize.portals without a map omits index fields entirely', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        new AddPortalOp(events, portal()).do();
        const serialized = events.invoke('docSerialize.portals');
        expect(serialized[0]).not.toHaveProperty('frontIndex');
        expect(serialized[0]).not.toHaveProperty('backIndex');
    });

    it('docSerialize.portalsIndex maps start splat and entrypoints to indices', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        new SetStartSplatOp(events, null, 2).do();
        new UpdatePortalEntrypointOp(events, 3, null, [1, 2, 3]).do();
        const out = events.invoke('docSerialize.portalsIndex', new Map([[2, 0], [3, 1]]));
        expect(out).toEqual({ startSplatIndex: 0, entrypointsByIndex: { '1': [1, 2, 3] } });
    });

    it('docSerialize.portalsIndex drops stale uids (start -> null, entrypoint omitted)', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        new SetStartSplatOp(events, null, 99).do();
        new UpdatePortalEntrypointOp(events, 98, null, [1, 2, 3]).do();
        const out = events.invoke('docSerialize.portalsIndex', new Map([[2, 0]]));
        expect(out).toEqual({ startSplatIndex: null, entrypointsByIndex: {} });
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/portals.test.ts`
Expected: the first, second, fourth, and fifth new tests FAIL (`expected undefined to be 0`, `expected undefined to be null`, `expected undefined to deeply equal ...` — `docSerialize.portals` ignores its argument today and `docSerialize.portalsIndex` is unregistered so `invoke` returns `undefined`). The third new test passes (documents current behavior). All 13 pre-existing tests still pass.

- [ ] **Step 3: Write the implementation**

In `src/portals.ts`, add the doc-record type directly below the `PortalData` type (after line 17):

```ts
// On-disk portal record: PortalData plus stable splat references as indices
// into the document's splat array (uids are session-scoped and NOT stable
// across loads; the uid fields are kept only for rollback to older builds).
type PortalDocData = PortalData & {
    frontIndex?: number | null,
    backIndex?: number | null
};
```

Replace the existing `docSerialize.portals` registration (lines 232-241):

```ts
    events.function('docSerialize.portals', (uidToIndex?: Map<number, number>): PortalDocData[] => portals.map((p) => {
        const doc: PortalDocData = {
            id: p.id,
            position: [p.position[0], p.position[1], p.position[2]],
            rotation: [p.rotation[0], p.rotation[1], p.rotation[2], p.rotation[3]],
            width: p.width,
            height: p.height,
            frontUid: p.frontUid,
            backUid: p.backUid,
            infinite: p.infinite
        };
        if (uidToIndex) {
            // always write a value (null, never undefined) so the field
            // survives JSON.stringify and marks the record as new-format
            const toIndex = (uid: number | null) => {
                const i = (uid === null) ? undefined : uidToIndex.get(uid);
                return (typeof i === 'number') ? i : null;
            };
            doc.frontIndex = toIndex(p.frontUid);
            doc.backIndex = toIndex(p.backUid);
        }
        return doc;
    }));

    // start splat + entrypoints converted to document splat indices (stale
    // uids are dropped rather than written as dangling references)
    events.function('docSerialize.portalsIndex', (uidToIndex: Map<number, number>) => {
        const startSplatIndex = (startUid !== null && uidToIndex.has(startUid)) ? uidToIndex.get(startUid) : null;
        const entrypointsByIndex: Record<string, [number, number, number]> = {};
        entrypoints.forEach((pos, uid) => {
            const i = uidToIndex.get(uid);
            if (typeof i === 'number') {
                entrypointsByIndex[String(i)] = [pos[0], pos[1], pos[2]];
            }
        });
        return { startSplatIndex, entrypointsByIndex };
    });
```

Do not change the exports at the bottom of the file (`PortalDocData` stays module-local — nothing outside `src/portals.ts` names it; `doc.ts` talks to it through untyped `events.invoke`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/portals.test.ts`
Expected: all tests pass (13 existing + 5 new = 18). The pre-existing serialize round-trip tests must still pass unchanged — if any existing test broke, the conditional index-field emission is wrong (index keys must not appear when the map is omitted).

- [ ] **Step 5: Commit**

```bash
git add src/portals.ts test/portals.test.ts
git commit -m "feat(portals): serialize splat refs as document splat indices"
```

---

### Task 2: `src/portals.ts` — deserialize with index→uid remap and legacy fallback

**Files:**
- Modify: `src/portals.ts` (`docDeserialize.portals` registration, lines 243-277 at `916666a`, now shifted down by Task 1's insertions)
- Test: `test/portals.test.ts` (append to the `portal doc-index serialization` describe block from Task 1)

**Interfaces:**
- Consumes: `PortalDocData` type and the serialize functions from Task 1 (`docSerialize.portals(uidToIndex?)`, `docSerialize.portalsIndex(uidToIndex)`).
- Produces (Task 3 relies on this exact signature):

  ```ts
  events.function('docDeserialize.portals', (
      data: PortalDocData[],
      start?: number | null,                                   // legacy uid
      eps?: Record<string, [number, number, number]>,          // legacy uid-keyed
      remap?: {
          indexToUid: number[],                                // live uid of document splat index i
          startIndex?: number | null,                          // document.portalsStartSplatIndex
          entrypointsByIndex?: Record<string, [number, number, number]>  // document.portalsEntrypointsByIndex
      }
  ) => void)
  ```

  Resolution rules: for each reference, the index field is authoritative **iff** `remap.indexToUid` is an array AND the index field is present (`!== undefined`, including present-but-`null`); otherwise the legacy uid path runs verbatim. Out-of-range or `null` indices resolve to `null` (dangling → unbound, never wrong-bound). All existing ≤3-arg call sites keep today's behavior exactly.

- [ ] **Step 1: Write the failing tests**

Append inside the `portal doc-index serialization` describe block from Task 1 (before its closing `});`):

```ts
    it('round-trips splat refs across a uid drift via the index remap', () => {
        // session 1: the two splats have uids [2, 3]
        const s1 = makeEvents();
        registerPortalsEvents(s1);
        new AddPortalOp(s1, portal({ id: 'portal_0', frontUid: 2, backUid: 3 })).do();
        new SetStartSplatOp(s1, null, 2).do();
        new UpdatePortalEntrypointOp(s1, 3, null, [4, 5, 6]).do();
        const uidToIndex = new Map([[2, 0], [3, 1]]);
        // simulate the real .ssproj write/read (JSON drops undefined, keeps null)
        const doc = JSON.parse(JSON.stringify({
            portals: s1.invoke('docSerialize.portals', uidToIndex),
            portalsStartSplat: s1.invoke('portals.startSplat'),
            portalsEntrypoints: s1.invoke('portals.exportEntrypoints'),
            ...s1.invoke('docSerialize.portalsIndex', uidToIndex)
        }));

        // session 2: the same two splats (same document order) now have uids [7, 9]
        const s2 = makeEvents();
        registerPortalsEvents(s2);
        s2.invoke('docDeserialize.portals', doc.portals, doc.portalsStartSplat, doc.portalsEntrypoints, {
            indexToUid: [7, 9],
            startIndex: doc.startSplatIndex,
            entrypointsByIndex: doc.entrypointsByIndex
        });

        const p = (s2.invoke('portals.list') as PortalData[])[0];
        expect(p.frontUid).toBe(7);
        expect(p.backUid).toBe(9);
        expect(s2.invoke('portals.startSplat')).toBe(7);
        expect(s2.invoke('portals.entrypoint', 9)).toEqual([4, 5, 6]);
        expect(s2.invoke('portals.entrypoint', 3)).toBeNull();
    });

    it('legacy documents (uid fields only) still load via the raw-uid fallback', () => {
        // a pre-fix .ssproj payload: no frontIndex/backIndex/startIndex/entrypointsByIndex
        const legacyPortals = [{
            id: 'portal_0', position: [0, 0, 0], rotation: [0, 0, 0, 1],
            width: 2, height: 2, frontUid: 2, backUid: 3
        }];
        const events = makeEvents();
        registerPortalsEvents(events);
        // the loader always passes remap.indexToUid (splats were loaded), but a
        // legacy doc has no index fields, so the uid path must run verbatim
        events.invoke('docDeserialize.portals', legacyPortals, 2, { '3': [1, 2, 3] }, {
            indexToUid: [7, 9],
            startIndex: undefined,
            entrypointsByIndex: undefined
        });
        const p = (events.invoke('portals.list') as PortalData[])[0];
        expect(p.frontUid).toBe(2);
        expect(p.backUid).toBe(3);
        expect(events.invoke('portals.startSplat')).toBe(2);
        expect(events.invoke('portals.entrypoint', 3)).toEqual([1, 2, 3]);
    });

    it('null or out-of-range indices deserialize to null uids (index wins over legacy uid)', () => {
        const events = makeEvents();
        registerPortalsEvents(events);
        events.invoke('docDeserialize.portals', [{
            id: 'portal_0', position: [0, 0, 0], rotation: [0, 0, 0, 1],
            width: 2, height: 2, frontUid: 2, backUid: 3,
            frontIndex: null, backIndex: 5
        }], null, undefined, { indexToUid: [7, 9], startIndex: null, entrypointsByIndex: {} });
        const p = (events.invoke('portals.list') as PortalData[])[0];
        expect(p.frontUid).toBeNull();
        expect(p.backUid).toBeNull();
        expect(events.invoke('portals.startSplat')).toBeNull();
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/portals.test.ts`
Expected: the drift test FAILS with `expected 2 to be 7` (deserialize currently ignores the 4th arg and restores raw uids); the null/out-of-range test FAILS with `expected 2 to be null`. The legacy-fallback test PASSES already (extra args are ignored today) — that is fine; it pins the behavior so the Step 3 rewrite cannot regress it. All Task 1 tests still pass.

- [ ] **Step 3: Write the implementation**

Replace the entire `docDeserialize.portals` registration in `src/portals.ts` (the function currently spanning lines 243-277 at `916666a`) with:

```ts
    events.function('docDeserialize.portals', (data: PortalDocData[], start?: number | null, eps?: Record<string, [number, number, number]>, remap?: { indexToUid: number[], startIndex?: number | null, entrypointsByIndex?: Record<string, [number, number, number]> }) => {
        // index fields are authoritative when present (uids are session-scoped
        // and only valid in the session that saved them); legacy documents
        // without index fields keep the old raw-uid behavior verbatim
        const indexToUid = (remap && Array.isArray(remap.indexToUid)) ? remap.indexToUid : null;
        const fromIndex = (index: number | null): number | null => {
            if (!indexToUid || typeof index !== 'number') {
                return null;
            }
            const uid = indexToUid[index];
            return (typeof uid === 'number') ? uid : null;
        };

        portals.length = 0;
        nextId = 0;
        selectedId = null;

        if (indexToUid && remap.startIndex !== undefined) {
            startUid = fromIndex(remap.startIndex);
        } else {
            startUid = (typeof start === 'number') ? start : null;
        }

        entrypoints.clear();
        if (indexToUid && remap.entrypointsByIndex !== undefined) {
            const byIndex = remap.entrypointsByIndex;
            Object.keys(byIndex).forEach((k) => {
                const uid = fromIndex(parseInt(k, 10));
                const v = byIndex[k];
                if (uid !== null && Array.isArray(v) && v.length >= 3) {
                    entrypoints.set(uid, [v[0], v[1], v[2]]);
                }
            });
        } else if (eps && typeof eps === 'object') {
            Object.keys(eps).forEach((k) => {
                const v = eps[k];
                if (Array.isArray(v) && v.length >= 3) {
                    entrypoints.set(parseInt(k, 10), [v[0], v[1], v[2]]);
                }
            });
        }

        if (Array.isArray(data)) {
            data.forEach((d) => {
                const resolve = (index: number | null | undefined, legacyUid: number | null | undefined) => {
                    if (indexToUid && index !== undefined) {
                        return fromIndex(index);
                    }
                    return legacyUid ?? null;
                };
                portals.push({
                    id: d.id ?? genId(),
                    position: d.position,
                    rotation: d.rotation ?? [0, 0, 0, 1],
                    width: d.width ?? 1,
                    height: d.height ?? 1,
                    frontUid: resolve(d.frontIndex, d.frontUid),
                    backUid: resolve(d.backIndex, d.backUid),
                    infinite: d.infinite
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
```

Note: everything except the `indexToUid`/`fromIndex`/`resolve` additions and the start/entrypoints branching is today's code, kept verbatim (id/rotation/width/height defaults, `nextId` recovery, final change events).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/portals.test.ts`
Expected: all 21 tests pass — including the 13 pre-existing ones, which exercise the ≤3-arg legacy path (e.g. `docDeserialize.portals` with `serialized, start` and with `[], null, { '7': [4, 5, 6] }`). If any pre-existing test fails, the legacy fallback is broken — fix before proceeding.

- [ ] **Step 5: Commit**

```bash
git add src/portals.ts test/portals.test.ts
git commit -m "feat(portals): remap doc splat indices to live uids on deserialize"
```

---

### Task 3: `src/doc.ts` — wire the index map through save and load

**Files:**
- Modify: `src/doc.ts` (load loop lines 103-115; `docDeserialize.portals` invoke line 127; save `document` construction lines 157-172)

**Interfaces:**
- Consumes (exact, from Tasks 1-2):
  - `events.invoke('docSerialize.portals', uidToIndex: Map<number, number>)` → portal records with `frontIndex`/`backIndex`.
  - `events.invoke('docSerialize.portalsIndex', uidToIndex: Map<number, number>)` → `{ startSplatIndex: number | null, entrypointsByIndex: Record<string, [number, number, number]> }`.
  - `events.invoke('docDeserialize.portals', data, start, eps, { indexToUid: number[], startIndex, entrypointsByIndex })`.
- Produces: new `document.json` fields `portalsStartSplatIndex`, `portalsEntrypointsByIndex`, and per-portal `frontIndex`/`backIndex` (see Context table). Legacy fields unchanged.

This task is **not unit-testable**: `registerDocEvents` requires a live `Scene`, the File System Access API, and the ZIP filesystem — none available in the Node test env, and standing up fakes for all of it buys nothing over the pure tests in Tasks 1-2 (which cover every branch of the conversion) plus the manual E2E in Task 4. Substitute: lint + typecheck-via-build here, scripted manual verification in Task 4.

- [ ] **Step 1: Update `saveDocument`**

In `src/doc.ts`, replace lines 157-172 (from `const splats = ...` through the closing `};` of the `document` literal):

```ts
            const splats = events.invoke('scene.allSplats') as Splat[];

            // a splat's identity in the document is its index in this array:
            // it drives both the splats[i] metadata below and the
            // `splat_<i>.ply` payload filenames. uids are session-scoped, so
            // portal splat references are persisted by index (legacy uid
            // fields are kept alongside for older builds).
            const uidToIndex = new Map<number, number>(splats.map((s, i) => [s.uid, i] as [number, number]));
            const portalsIndex = events.invoke('docSerialize.portalsIndex', uidToIndex);

            const document = {
                version: 0,
                camera: scene.camera.docSerialize(),
                view: events.invoke('docSerialize.view'),
                poseSets: events.invoke('docSerialize.poseSets'),
                timeline: events.invoke('docSerialize.timeline'),
                annotations: events.invoke('docSerialize.annotations'),
                offLimitsZones: events.invoke('docSerialize.offLimitsZones'),
                offLimitsMessage: events.invoke('offLimitsZones.message'),
                portals: events.invoke('docSerialize.portals', uidToIndex),
                portalsStartSplat: events.invoke('portals.startSplat'),
                portalsStartSplatIndex: portalsIndex.startSplatIndex,
                portalsEntrypoints: events.invoke('portals.exportEntrypoints'),
                portalsEntrypointsByIndex: portalsIndex.entrypointsByIndex,
                splats: splats.map(s => s.docSerialize())
            };
```

Everything after this literal (serializeSettings, the ZIP writing, the `splat_${i}.ply` loop) stays untouched — the loop already iterates the same `splats` array, which is what makes the index identity exact.

- [ ] **Step 2: Update `loadDocument`**

Replace the splat-loading loop (lines 103-115):

```ts
            // run through each splat and load it, collecting the created
            // elements: loadedSplats[i] is built from `splat_${i}.ply`, so the
            // array maps document splat index -> live session uid
            const loadedSplats: Splat[] = [];
            for (let i = 0; i < document.splats.length; ++i) {
                const filename = `splat_${i}.ply`;
                const splatSettings = document.splats[i];

                // load splat directly from the zip filesystem (streams on-demand)
                // skipReorder=true because ssproj PLY files are already in morton order
                const splat = await scene.assetLoader.load(filename, zipFs, false, true);

                await scene.add(splat);

                splat.docDeserialize(splatSettings);

                loadedSplats.push(splat);
            }
```

Then replace the portals invoke (line 127):

```ts
            events.invoke('docDeserialize.portals', document.portals, document.portalsStartSplat, document.portalsEntrypoints, {
                indexToUid: loadedSplats.map(s => s.uid),
                startIndex: document.portalsStartSplatIndex,
                entrypointsByIndex: document.portalsEntrypointsByIndex
            });
```

(For a legacy file, `document.portalsStartSplatIndex` and `document.portalsEntrypointsByIndex` are `undefined` and the per-portal records have no `frontIndex`/`backIndex` — Task 2's deserializer then runs the raw-uid fallback verbatim.)

- [ ] **Step 3: Lint and typecheck via build**

```bash
npm run lint
npm run build
```

Expected: lint reports no errors in `src/doc.ts` / `src/portals.ts`; the Rollup build completes without TypeScript errors and writes `dist/`. (The release build is also the artifact Task 4 can serve.)

- [ ] **Step 4: Run the full test suite**

Run: `npm run test`
Expected: all test files pass (portals: 21 tests).

- [ ] **Step 5: Commit**

```bash
git add src/doc.ts
git commit -m "feat(doc): persist portal splat refs by document index in ssproj"
```

---

### Task 4: Manual E2E verification (scripted)

**Files:** none (verification only).

**Interfaces:** consumes the running editor; produces user-visible proof that portal↔splat bindings survive a uid drift and that legacy files still load.

Build type: **debug dev server is sufficient** — this change never touches `src/viewer-companion/*` or anything stringified into the exported viewer, so no release-build minification risk exists. Use `npm run develop`.

- [ ] **Step 1: Start the dev server**

```bash
npm run develop
```

Open http://localhost:3333 in Chrome (File System Access API needed for clean save/load).

- [ ] **Step 2: Build a two-scene portal project**

1. Import a first splat `.ply` (drag-drop onto the canvas, or File → Import). Any splat file works; two different ones make the verification unambiguous.
2. Import a second splat `.ply`.
3. Activate the portal tool (portal icon in the bottom toolbar), draw/place a portal rectangle in the viewport.
4. In the portal panel, set **Front** to splat 1 and **Back** to splat 2 (dropdowns show the splat names).
5. Set the walkthrough **start scene** to splat 1 and, if the panel offers it, set an entrypoint on splat 2.
6. File → Save As… → save as `portal-index-test.ssproj`.

- [ ] **Step 3: Verify bindings survive a uid drift (same session — counter has advanced)**

1. Without reloading the page, File → Open → `portal-index-test.ssproj` (confirm the reset prompt). Because the element uid counter advanced during step 2 (two splat imports + portal shape elements), the reloaded splats now have **different uids** than the ones stored in the legacy uid fields — this is exactly the drift that used to break bindings.
2. Select the portal and check the portal panel: **Front must show splat 1's name and Back splat 2's name** (before the fix: empty or wrong entries).
3. Check the start-scene control still shows splat 1, and the entrypoint on splat 2 is still present.
4. Repeat the open once more (load the same file a second time) — bindings must still be correct.

- [ ] **Step 4: Verify a hard drift (fresh session, extra element first)**

1. Reload the browser tab (fresh uid counter).
2. Import any unrelated splat `.ply` first (this shifts the uid sequence), then File → Open → `portal-index-test.ssproj`.
3. Verify the portal panel Front/Back, start scene, and entrypoint are all still correct.

- [ ] **Step 5: Verify legacy-file fallback**

1. Reload the browser tab.
2. As the FIRST action in the fresh session, File → Open a pre-fix `.ssproj` that contains portals (any project saved before this branch). If no such file is available, mark this step skipped and rely on the legacy-fixture unit test from Task 2 — do not fabricate one.
3. Verify it loads without errors and portal bindings are correct (fresh-boot-first-load is the one case legacy files guarantee).
4. Save it (File → Save As… under a new name) and re-open it in the same session — bindings must now survive drift too (the re-save wrote index fields).

- [ ] **Step 6: Confirm the saved JSON contains the new fields (spot check)**

```bash
unzip -p /path/to/portal-index-test.ssproj document.json | head -c 2000
```

Expected: the JSON contains `"frontIndex":`, `"backIndex":`, `"portalsStartSplatIndex":`, and `"portalsEntrypointsByIndex":` alongside the legacy `"frontUid"`/`"backUid"`/`"portalsStartSplat"`/`"portalsEntrypoints"` fields. (Adjust the path to wherever the browser saved the file.)

---

### Task 5: Final checks and finish the branch

**Files:** none.

- [ ] **Step 1: Run the full verification suite**

```bash
npm run lint
npm run test
```

Expected: lint clean; all Vitest suites pass.

- [ ] **Step 2: Finish the branch**

Per project convention, squash all commits on `feat/portal-splat-refs-doc-index` into a single commit summarizing the change (e.g. `feat(portals): stable splat refs across sessions via doc-index remap`), then merge to local `main` per the finishing-a-development-branch skill. Do not push unless the user asks.
