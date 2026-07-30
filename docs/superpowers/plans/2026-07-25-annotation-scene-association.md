# Annotation ↔ Scene Association Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Associate each annotation with a splat so that, in a portal (multi-scene) export, navigating between annotations switches the exported viewer to the scene that annotation lives in.

**Architecture:** The editor stores a splat reference (`sceneUid`) on each annotation, auto-assigned from the raycast hit at placement and overridable via a dropdown. It is persisted in `.ssproj` as a document splat *index* (uids are session-scoped). At export it is resolved against the portal bundle's `sceneUids` into a scene *index* and baked into the viewer settings as `extras.scene`. In the exported viewer the portals companion listens for `annotation.activate` and dispatches a scene crossing — the same mechanism the `reset` handler already uses, because an annotation fly-to is a teleport that no portal rectangle can detect.

**Tech Stack:** TypeScript, PlayCanvas engine + PCUI, Rollup, Vitest, i18next.

**Design spec:** `docs/superpowers/specs/2026-07-25-annotation-scene-association-design.md` (commit `947a831`).

## Global Constraints

- **Companion template literals** (`src/viewer-companion/*.ts`): the runtime body is a template literal. **No backslash escapes** — they are eaten at build time. **No backticks inside comments** — they terminate the literal. String operations only.
- **Companion code style:** ES5-flavoured (`var`, `function`) to match the surrounding runtime, which is stringified and minified into the export.
- **ESLint is pinned to v10 and crashes on `import/order` autofix.** Do not reorder imports; add new imports adjacent to existing ones in the established grouping. Never run `eslint --fix` on import order.
- **Vitest must run in the foreground with output redirected to a file** outside the repo (Git Bash: `> /tmp/vitest.txt 2>&1`), then read the file. Never background it, never pipe it to `grep` — it hangs.
- **Use Bash (Git Bash), not PowerShell.** Run commands plainly from the repo root — no `cd`, no `git -C`, no `npm --prefix` pointing at the cwd.
- **Sentinel value:** the Scene dropdown is a numeric `SelectInput`; `-1` is the sentinel for "no scene" (`sceneUid === null`). Named `NO_SCENE`.
- **Naming (must match verbatim across tasks):** `sceneUid` (editor field), `sceneIndex` (document field), `extras.scene` (export field), `annotationScenes` (companion payload array), `resolveAnnotationSceneIndex` (pure resolver), `ss-annotation-offscene` (CSS class).
- **Do not touch** `src/annotation-overlay.ts` or `src/viewer-companion/annotation-links.ts` — both are explicitly out of scope.

---

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `src/portal-export.ts` | Modify | Add the pure uid→scene-index resolver, next to `buildPortalBundle` |
| `test/portal-export.test.ts` | Modify | Unit tests for the resolver |
| `src/annotations.ts` | Modify | `sceneUid` field, export shape, document (de)serialization |
| `test/annotations.test.ts` | Create | Unit tests for the annotation event registry |
| `src/ui/export-popup.ts` | Modify (line 800) | Pass `bundle?.sceneUids` to `annotations.export` |
| `src/ui/s3-publish-dialog.ts` | Modify (line 249) | Same |
| `src/doc.ts` | Modify (lines 136, 205) | Thread `uidToIndex` / `indexToUid` through the annotation (de)serializers |
| `src/tools/annotation-tool.ts` | Modify | Auto-assign at placement; Scene dropdown; portal gating |
| `static/locales/*.json` (9 files) | Modify | `panel.annotations.scene`, `panel.annotations.scene-none` |
| `src/viewer-companion/portals.ts` | Modify | `annotation.activate` dispatch; hotspot filtering; `annotationScenes` payload; CSS rule |
| `test/portals-injection.test.ts` | Modify | Assert the payload and runtime hooks are emitted |

---

### Task 1: Pure uid → scene-index resolver

The one piece of export logic that can be tested without playcanvas. Everything downstream depends on its exact signature.

**Files:**
- Modify: `src/portal-export.ts` (append after the `buildPortalBundle` export block, around line 94)
- Test: `test/portal-export.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveAnnotationSceneIndex(sceneUid: number | null | undefined, sceneUids: number[] | null | undefined): number | null` — exported from `src/portal-export.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `test/portal-export.test.ts`:

```ts
describe('resolveAnnotationSceneIndex', () => {
    it('resolves the start splat to index 0', () => {
        expect(resolveAnnotationSceneIndex(10, [10, 20])).toBe(0);
    });

    it('resolves a non-start splat to its bundle index', () => {
        expect(resolveAnnotationSceneIndex(20, [10, 20])).toBe(1);
    });

    it('returns null when the annotation has no scene', () => {
        expect(resolveAnnotationSceneIndex(null, [10, 20])).toBeNull();
        expect(resolveAnnotationSceneIndex(undefined, [10, 20])).toBeNull();
    });

    it('returns null when no bundle is being exported', () => {
        expect(resolveAnnotationSceneIndex(10, null)).toBeNull();
        expect(resolveAnnotationSceneIndex(10, undefined)).toBeNull();
    });

    it('returns null for a splat that is not a portal scene', () => {
        expect(resolveAnnotationSceneIndex(99, [10, 20])).toBeNull();
    });
});
```

Add `resolveAnnotationSceneIndex` to the existing import at the top of the file (do not reorder the import list):

```ts
import { buildPortalBundle, resolveCollisionSeed, resolvePortalExtras, resolveAnnotationSceneIndex, EYE_HEIGHT, SIDE_NUDGE, collisionSeedTuple } from '../src/portal-export';
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run test/portal-export.test.ts > /tmp/vitest.txt 2>&1
```

Read `/tmp/vitest.txt`. Expected: FAIL — `resolveAnnotationSceneIndex is not a function` (or an import/type error).

- [ ] **Step 3: Write the implementation**

In `src/portal-export.ts`, immediately after the line `export { buildPortalBundle, sceneUrl, collisionUrl, ExportPortal, PortalBundle, Vec3, Quat };`:

```ts
// Resolve an annotation's editor splat reference to an exported scene index.
// Returns null when the annotation has no scene, when no portal bundle is being
// exported (a plain single-scene export), or when the referenced splat is not a
// portal scene (unreferenced by any portal, or deleted since it was assigned).
// All three cases mean the same thing downstream: do not switch scene.
const resolveAnnotationSceneIndex = (
    sceneUid: number | null | undefined,
    sceneUids: number[] | null | undefined
): number | null => {
    if (typeof sceneUid !== 'number' || !Array.isArray(sceneUids)) {
        return null;
    }
    const i = sceneUids.indexOf(sceneUid);
    return i >= 0 ? i : null;
};

export { resolveAnnotationSceneIndex };
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run test/portal-export.test.ts > /tmp/vitest.txt 2>&1
```

Read `/tmp/vitest.txt`. Expected: PASS, all tests in the file green (the pre-existing `buildPortalBundle` / `resolveCollisionSeed` / `resolvePortalExtras` suites must still pass).

- [ ] **Step 5: Commit**

```bash
git add src/portal-export.ts test/portal-export.test.ts
git commit -m "feat(portals): pure resolver from annotation splat uid to export scene index"
```

---

### Task 2: `sceneUid` on annotations + export shape

Adds the field to the editor model and bakes `extras.scene` into the exported viewer settings. Ends with the export path working end to end.

**Files:**
- Modify: `src/annotations.ts`
- Modify: `src/ui/export-popup.ts:800`
- Modify: `src/ui/s3-publish-dialog.ts:249`
- Test: `test/annotations.test.ts` (create)

**Interfaces:**
- Consumes: `resolveAnnotationSceneIndex(sceneUid, sceneUids)` from Task 1.
- Produces:
  - `AnnotationData.sceneUid: number | null`
  - `AnnotationExport.extras: { url?: string, newTab?: boolean, scene?: number }`
  - `events.invoke('annotations.export', sceneUids?: number[]) => AnnotationExport[]`

- [ ] **Step 1: Write the failing tests**

Create `test/annotations.test.ts`. The `makeEvents` double is a local copy, matching the convention in `test/portals.test.ts` and `test/off-limits-zones.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import { AddAnnotationOp, AnnotationData, registerAnnotationsEvents } from '../src/annotations';

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

const annotation = (over: Partial<AnnotationData> = {}): AnnotationData => ({
    id: 'annotation_0',
    position: [1, 2, 3],
    title: 'T',
    text: 'X',
    url: '',
    newTab: false,
    sceneUid: null,
    camera: { position: [0, 0, 0], target: [0, 0, 1], fov: 60 },
    ...over
});

describe('annotations.export scene index', () => {
    it('bakes extras.scene from the splat uid via the portal bundle', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation({ id: 'annotation_0', sceneUid: 20 })).do();
        const out = events.invoke('annotations.export', [10, 20]);
        expect(out[0].extras.scene).toBe(1);
    });

    it('omits extras.scene when the annotation has no scene', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation({ sceneUid: null })).do();
        const out = events.invoke('annotations.export', [10, 20]);
        expect(out[0].extras.scene).toBeUndefined();
    });

    it('omits extras.scene when no bundle is passed (single-scene export)', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation({ sceneUid: 20 })).do();
        const out = events.invoke('annotations.export');
        expect(out[0].extras.scene).toBeUndefined();
    });

    it('omits extras.scene for a splat that is not a portal scene', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation({ sceneUid: 99 })).do();
        const out = events.invoke('annotations.export', [10, 20]);
        expect(out[0].extras.scene).toBeUndefined();
    });

    it('still carries the link extras alongside the scene', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation({ url: 'https://x.test', newTab: true, sceneUid: 10 })).do();
        const out = events.invoke('annotations.export', [10, 20]);
        expect(out[0].extras).toEqual({ url: 'https://x.test', newTab: true, scene: 0 });
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run test/annotations.test.ts > /tmp/vitest.txt 2>&1
```

Read `/tmp/vitest.txt`. Expected: FAIL — TypeScript rejects `sceneUid` on `AnnotationData` and/or `extras.scene` is `undefined` in the first test.

- [ ] **Step 3: Add the field to the model**

In `src/annotations.ts`, add `sceneUid` to `AnnotationData` (after `newTab`):

```ts
type AnnotationData = {
    id: string,
    position: [number, number, number],
    title: string,
    text: string,
    url: string,
    newTab: boolean,
    // Editor splat this annotation belongs to (session-scoped uid), or null.
    // Resolved to an export scene index at export time; persisted by document
    // splat index (see docSerialize.annotations) because uids are not stable.
    sceneUid: number | null,
    camera: AnnotationCamera
};
```

And widen the export shape's `extras`:

```ts
    extras: { url?: string, newTab?: boolean, scene?: number }
```

- [ ] **Step 4: Bake the index in `annotations.export`**

Add the import at the top of `src/annotations.ts`, directly below the existing `Events` import (do not reorder):

```ts
import { Events } from './events';
import { resolveAnnotationSceneIndex } from './portal-export';
```

Replace the `annotations.export` registration:

```ts
    // `sceneUids` is the portal bundle's scene ordering (index 0 = start scene);
    // absent on non-portal export paths, in which case no annotation gets a scene.
    events.function('annotations.export', (sceneUids?: number[]): AnnotationExport[] => {
        return annotations.map((a) => {
            const scene = resolveAnnotationSceneIndex(a.sceneUid, sceneUids);
            return {
                position: [a.position[0], a.position[1], a.position[2]],
                title: a.title,
                text: a.text,
                camera: {
                    initial: {
                        position: [a.camera.position[0], a.camera.position[1], a.camera.position[2]],
                        target: [a.camera.target[0], a.camera.target[1], a.camera.target[2]],
                        fov: a.camera.fov
                    }
                },
                extras: {
                    url: a.url || undefined,
                    newTab: a.url ? a.newTab : undefined,
                    scene: scene ?? undefined
                }
            };
        });
    });
```

Also default the field in `docDeserialize.annotations` so loading an older document does not produce `undefined` (the document-index work lands in Task 3; this is only the default):

```ts
                    newTab: d.newTab ?? false,
                    sceneUid: d.sceneUid ?? null,
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run test/annotations.test.ts > /tmp/vitest.txt 2>&1
```

Read `/tmp/vitest.txt`. Expected: PASS, 5/5.

- [ ] **Step 6: Pass the bundle at both export call sites**

`src/ui/export-popup.ts` line 800 — replace:

```ts
                    annotations: events.invoke('annotations.export') ?? [],
```

with:

```ts
                    annotations: events.invoke('annotations.export', bundle?.sceneUids) ?? [],
```

`src/ui/s3-publish-dialog.ts` line 249 — make the identical replacement. In both files `bundle` is already in scope (declared a few lines above, `null` when the scene has no portals).

Leave `src/ui/publish-settings-dialog.ts:386` **unchanged**: the PlayCanvas publish path has no portal bundle, so it must not bake scene indices.

- [ ] **Step 7: Verify the full suite and the type check**

```bash
npx vitest run > /tmp/vitest.txt 2>&1
npm run lint > /tmp/lint.txt 2>&1
```

Read both files. Expected: all tests PASS; lint exits 0 with no new errors.

- [ ] **Step 8: Commit**

```bash
git add src/annotations.ts src/ui/export-popup.ts src/ui/s3-publish-dialog.ts test/annotations.test.ts
git commit -m "feat(annotations): associate an annotation with a splat and bake extras.scene on export"
```

---

### Task 3: Persist the association in the document

Uids are session-scoped, so the `.ssproj` stores a document splat index — the exact scheme `PortalDocData.frontIndex` / `backIndex` already uses.

**Files:**
- Modify: `src/annotations.ts`
- Modify: `src/doc.ts:136` and `src/doc.ts:205`
- Test: `test/annotations.test.ts`

**Interfaces:**
- Consumes: `AnnotationData.sceneUid` from Task 2.
- Produces:
  - `AnnotationDocData = AnnotationData & { sceneIndex?: number | null }`
  - `events.invoke('docSerialize.annotations', uidToIndex?: Map<number, number>) => AnnotationDocData[]`
  - `events.invoke('docDeserialize.annotations', data: AnnotationDocData[], remap?: { indexToUid: number[] })`

- [ ] **Step 1: Write the failing tests**

Append to `test/annotations.test.ts`:

```ts
describe('annotations document serialization', () => {
    it('writes the splat reference as a document index', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation({ sceneUid: 77 })).do();
        const out = events.invoke('docSerialize.annotations', new Map([[77, 2]]));
        expect(out[0].sceneIndex).toBe(2);
        expect(out[0].sceneUid).toBe(77);
    });

    it('writes null (never undefined) for an unassociated annotation', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation({ sceneUid: null })).do();
        const out = events.invoke('docSerialize.annotations', new Map([[77, 2]]));
        expect(out[0].sceneIndex).toBeNull();
        expect(JSON.parse(JSON.stringify(out))[0]).toHaveProperty('sceneIndex');
    });

    it('writes null for a splat missing from the document', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation({ sceneUid: 99 })).do();
        const out = events.invoke('docSerialize.annotations', new Map([[77, 2]]));
        expect(out[0].sceneIndex).toBeNull();
    });

    it('restores the uid from the index (index is authoritative)', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        // stale uid 77 from the saving session; index 2 maps to live uid 500
        events.invoke('docDeserialize.annotations',
            [{ ...annotation({ sceneUid: 77 }), sceneIndex: 2 }],
            { indexToUid: [100, 200, 500] });
        expect((events.invoke('annotations.list') as AnnotationData[])[0].sceneUid).toBe(500);
    });

    it('resolves a dangling index to null', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        events.invoke('docDeserialize.annotations',
            [{ ...annotation({ sceneUid: 77 }), sceneIndex: 9 }],
            { indexToUid: [100, 200] });
        expect((events.invoke('annotations.list') as AnnotationData[])[0].sceneUid).toBeNull();
    });

    it('a legacy record with no sceneIndex loads as unassociated', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        const legacy: any = annotation();
        delete legacy.sceneUid;
        events.invoke('docDeserialize.annotations', [legacy], { indexToUid: [100, 200] });
        expect((events.invoke('annotations.list') as AnnotationData[])[0].sceneUid).toBeNull();
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run test/annotations.test.ts > /tmp/vitest.txt 2>&1
```

Read `/tmp/vitest.txt`. Expected: FAIL — `sceneIndex` is `undefined`, and the deserialize tests report `sceneUid` 77 instead of the remapped value.

- [ ] **Step 3: Implement serialization**

In `src/annotations.ts`, add the document type next to `AnnotationData`:

```ts
// On-disk annotation record: AnnotationData plus a stable splat reference as an
// index into the document's splat array (uids are session-scoped and NOT stable
// across loads; the sceneUid field is kept only for rollback to older builds).
type AnnotationDocData = AnnotationData & {
    sceneIndex?: number | null
};
```

Replace the `docSerialize.annotations` registration:

```ts
    events.function('docSerialize.annotations', (uidToIndex?: Map<number, number>): AnnotationDocData[] => {
        return annotations.map((a) => {
            const doc: AnnotationDocData = {
                id: a.id,
                position: [a.position[0], a.position[1], a.position[2]],
                title: a.title,
                text: a.text,
                url: a.url,
                newTab: a.newTab,
                sceneUid: a.sceneUid,
                camera: {
                    position: [a.camera.position[0], a.camera.position[1], a.camera.position[2]],
                    target: [a.camera.target[0], a.camera.target[1], a.camera.target[2]],
                    fov: a.camera.fov
                }
            };
            if (uidToIndex) {
                // always write a value (null, never undefined) so the field
                // survives JSON.stringify and marks the record as new-format
                const i = (a.sceneUid === null) ? undefined : uidToIndex.get(a.sceneUid);
                doc.sceneIndex = (typeof i === 'number') ? i : null;
            }
            return doc;
        });
    });
```

- [ ] **Step 4: Implement deserialization**

Replace the `docDeserialize.annotations` registration:

```ts
    events.function('docDeserialize.annotations', (data: AnnotationDocData[], remap?: { indexToUid: number[] }) => {
        // the index field is authoritative when present (uids are session-scoped
        // and only valid in the session that saved them); legacy documents
        // without it simply have no association
        const indexToUid = (remap && Array.isArray(remap.indexToUid)) ? remap.indexToUid : null;
        const fromIndex = (index: number | null | undefined): number | null => {
            if (!indexToUid || typeof index !== 'number') {
                return null;
            }
            const uid = indexToUid[index];
            return (typeof uid === 'number') ? uid : null;
        };

        annotations.length = 0;
        nextId = 0;
        selectedId = null;
        if (Array.isArray(data)) {
            data.forEach((d) => {
                annotations.push({
                    id: d.id ?? genId(),
                    position: d.position,
                    title: d.title ?? '',
                    text: d.text ?? '',
                    url: d.url ?? '',
                    newTab: d.newTab ?? false,
                    sceneUid: (indexToUid && d.sceneIndex !== undefined) ? fromIndex(d.sceneIndex) : (d.sceneUid ?? null),
                    camera: d.camera ?? { position: [0, 0, 0], target: [0, 0, 1], fov: 60 }
                });
                // keep the counter ahead of any numeric id we loaded
                const m = /^annotation_(\d+)$/.exec(d.id ?? '');
                if (m) {
                    nextId = Math.max(nextId, parseInt(m[1], 10) + 1);
                }
            });
        }
        events.fire('annotations.selectionChanged', null);
        fireChanged();
    });
```

Add `AnnotationDocData` to the module's export list at the bottom of the file:

```ts
export {
    registerAnnotationsEvents,
    AddAnnotationOp,
    RemoveAnnotationOp,
    UpdateAnnotationOp,
    AnnotationData,
    AnnotationDocData,
    AnnotationCamera,
    AnnotationExport
};
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run test/annotations.test.ts > /tmp/vitest.txt 2>&1
```

Read `/tmp/vitest.txt`. Expected: PASS, 11/11 (5 from Task 2 + 6 new).

- [ ] **Step 6: Wire it into the document**

`src/doc.ts` line 205 — replace:

```ts
                annotations: events.invoke('docSerialize.annotations'),
```

with:

```ts
                annotations: events.invoke('docSerialize.annotations', uidToIndex),
```

`uidToIndex` is already built at line 196 for the portal references.

`src/doc.ts` line 136 — replace:

```ts
            events.invoke('docDeserialize.annotations', document.annotations);
```

with:

```ts
            events.invoke('docDeserialize.annotations', document.annotations, {
                indexToUid: loadedSplats.map(s => s.uid)
            });
```

`loadedSplats` is populated by the loop at lines 112–126, and the same expression is already used for the portal deserialize two lines below.

- [ ] **Step 7: Verify the full suite and lint**

```bash
npx vitest run > /tmp/vitest.txt 2>&1
npm run lint > /tmp/lint.txt 2>&1
```

Read both. Expected: all PASS; lint exits 0.

- [ ] **Step 8: Commit**

```bash
git add src/annotations.ts src/doc.ts test/annotations.test.ts
git commit -m "feat(annotations): persist the scene association by document splat index"
```

---

### Task 4: Scene dropdown in the annotation toolbar

Auto-assign at placement plus a manual override, shown only when the project has portals.

**Files:**
- Modify: `src/tools/annotation-tool.ts`
- Modify: `static/locales/en.json`, `de.json`, `es.json`, `fr.json`, `ja.json`, `ko.json`, `pt-BR.json`, `ru.json`, `zh-CN.json`

**Interfaces:**
- Consumes: `AnnotationData.sceneUid` (Task 2); `events.invoke('portals.count')`, `events.invoke('portals.list')` (existing).
- Produces: no new API — UI only.

- [ ] **Step 1: Add the locale keys**

In each of the 9 files, insert two entries directly after `"panel.annotations.new-tab"` (line 64 in `en.json`), keeping the surrounding indentation and trailing commas valid:

| File | `panel.annotations.scene` | `panel.annotations.scene-none` |
| --- | --- | --- |
| `en.json` | `"Scene"` | `"None"` |
| `de.json` | `"Szene"` | `"Keine"` |
| `es.json` | `"Escena"` | `"Ninguna"` |
| `fr.json` | `"Scène"` | `"Aucune"` |
| `ja.json` | `"シーン"` | `"なし"` |
| `ko.json` | `"장면"` | `"없음"` |
| `pt-BR.json` | `"Cena"` | `"Nenhuma"` |
| `ru.json` | `"Сцена"` | `"Нет"` |
| `zh-CN.json` | `"场景"` | `"无"` |

(Terminology matches the existing `portals.front` / `portals.start` translations in each locale.)

For `en.json` the result reads:

```json
    "panel.annotations.new-tab": "Open in New Tab",
    "panel.annotations.scene": "Scene",
    "panel.annotations.scene-none": "None",
```

- [ ] **Step 2: Verify every locale file is still valid JSON**

```bash
for f in static/locales/*.json; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" || echo "BAD $f"; done
```

Expected: no output (no `BAD` lines).

- [ ] **Step 3: Add the imports and the sentinel**

In `src/tools/annotation-tool.ts`, extend the two existing import lines (add to them, do not reorder the import block) and add the three new module imports next to the existing relative imports:

```ts
import { BooleanInput, Container, Label, SelectInput, TextInput } from '@playcanvas/pcui';
import { Entity, TranslateGizmo, Vec3 } from 'playcanvas';

import { AddAnnotationOp, AnnotationData, RemoveAnnotationOp, UpdateAnnotationOp } from '../annotations';
import { ElementType } from '../element';
import { Events } from '../events';
import { Scene } from '../scene';
import { Splat } from '../splat';
import { i18n } from '../ui/localization';
```

Below the existing module-level temporaries:

```ts
const p = new Vec3();
const screen = new Vec3();

// The Scene dropdown is a numeric SelectInput, so "no scene" needs a numeric
// stand-in; -1 can never collide with a splat uid (uids are monotonic from 0).
const NO_SCENE = -1;
```

- [ ] **Step 4: Add the Scene row to the toolbar**

After the `newTabInput` declaration and before the `bar.append(...)` calls:

```ts
        const sceneLabel = new Label({ text: i18n.t('panel.annotations.scene') });
        const sceneInput = new SelectInput({ type: 'number', options: [], width: 140 });
```

Then append it last, after `bar.append(newTabInput);`:

```ts
        bar.append(sceneLabel);
        bar.append(sceneInput);
```

- [ ] **Step 5: Build the option list**

After the `selected()` helper:

```ts
        // Scene options are every loaded splat (not just portal-referenced ones):
        // placement auto-assigns whichever splat was clicked, which may not be
        // wired into a portal yet. Mirrors portal-tool.ts's option construction.
        const splatList = () => scene.getElementsByType(ElementType.splat) as Splat[];
        const splatName = (splat: Splat) => {
            const filename = splat.name ?? (splat.asset.file as any)?.filename ?? `Splat ${splat.uid}`;
            return `${splat.uid}: ${filename}`;
        };
        const refreshSceneOptions = () => {
            sceneInput.options = [
                { v: NO_SCENE, t: i18n.t('panel.annotations.scene-none') },
                ...splatList().map(splat => ({ v: splat.uid, t: splatName(splat) }))
            ];
        };
```

- [ ] **Step 6: Populate and gate the row in `refreshBar`**

Replace the body of `refreshBar` with:

```ts
        let suppress = false;
        const refreshBar = () => {
            const a = selected();
            bar.hidden = !active || !a;
            if (!a) {
                return;
            }
            suppress = true;
            titleInput.value = a.title;
            textInput.value = a.text;
            urlInput.value = a.url;
            newTabInput.value = a.newTab;
            // the scene association is meaningless without portals: no portals
            // means no exported scene indices and so nothing to switch between
            const hasPortals = ((events.invoke('portals.count') as number) ?? 0) > 0;
            sceneLabel.hidden = !hasPortals;
            sceneInput.hidden = !hasPortals;
            if (hasPortals) {
                refreshSceneOptions();
                const options = sceneInput.options as { v: number, t: string }[];
                // a splat deleted since assignment leaves a dangling uid -> show "None"
                sceneInput.value = options.some(o => o.v === a.sceneUid) ? a.sceneUid : NO_SCENE;
            }
            suppress = false;
        };
```

- [ ] **Step 7: Widen `commit` and bind the change handler**

Change the `commit` signature:

```ts
        const commit = (field: keyof AnnotationData, value: string | boolean | number | null) => {
```

Add the handler after the existing `newTabInput.on('change', ...)` line:

```ts
        sceneInput.on('change', (v: number) => commit('sceneUid', v === NO_SCENE ? null : v));
```

- [ ] **Step 8: Auto-assign at placement**

In `pointerup`, in the `AnnotationData` literal, add the field after `newTab`:

```ts
                url: '',
                newTab: false,
                // the splat under the cursor is the scene this annotation belongs to
                sceneUid: result.splat?.uid ?? null,
```

`result.splat` is already returned by `scene.camera.intersect()` (see `src/camera.ts:846`).

- [ ] **Step 9: Refresh when portals change**

Next to the existing `annotations.changed` / `annotations.selectionChanged` listeners:

```ts
        // adding or removing the project's first/last portal shows or hides the
        // Scene row while the annotation tool is active
        events.on('portals.changed', () => {
            refreshBar();
        });
```

- [ ] **Step 10: Lint and build**

```bash
npm run lint > /tmp/lint.txt 2>&1
npm run build > /tmp/build.txt 2>&1
```

Read both. Expected: lint exits 0; build completes with no TypeScript errors.

- [ ] **Step 11: Verify manually in the editor**

```bash
npm run develop
```

Open http://localhost:3333 and check, in order:

1. Load two splats. With **no portals**, activate the annotation tool and place an annotation — the toolbar shows Title / Text / Link URL / Open in New Tab and **no Scene row**.
2. Add a portal (portal tool) wiring the two splats, then re-select the annotation — the **Scene row now appears**, pre-filled with the splat that was under the cursor when it was placed.
3. Change the dropdown to the other splat, then press Ctrl+Z — the value reverts (undo goes through `UpdateAnnotationOp`).
4. Set it to **None** — it stays None after re-selecting the annotation.
5. Save the project (`.ssproj`), reload it, re-select the annotation — the association survives the round trip.
6. Delete the splat the annotation points at, re-select the annotation — the dropdown falls back to **None** rather than showing a stale entry.
7. Switch the UI language (`?lng=fr`) — the label reads **Scène** and the empty option **Aucune**.

- [ ] **Step 12: Commit**

```bash
git add src/tools/annotation-tool.ts static/locales
git commit -m "feat(annotations): scene dropdown in the annotation toolbar, auto-assigned at placement"
```

---

### Task 5: Switch scene when an annotation is activated

The runtime half. `annotation.activate` fires for both the navigator chevrons and hotspot clicks, so one listener covers both.

**Files:**
- Modify: `src/viewer-companion/portals.ts` (the `ev.on(...)` block inside `start()`, near line 699)
- Test: `test/portals-injection.test.ts`

**Interfaces:**
- Consumes: `extras.scene` baked by Task 2.
- Produces: nothing importable — behaviour inside the injected runtime string.

- [ ] **Step 1: Write the failing test**

Append to the `buildPortalsInjection` describe block in `test/portals-injection.test.ts`:

```ts
    it('binds the annotation-activation scene switch', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/scene.sog'],
            portalStart: 0
        });
        expect(out).toContain('annotation.activate');
    });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/portals-injection.test.ts > /tmp/vitest.txt 2>&1
```

Read `/tmp/vitest.txt`. Expected: FAIL — the emitted string does not contain `annotation.activate`.

- [ ] **Step 3: Add the listener**

In `src/viewer-companion/portals.ts`, inside `start()`, immediately after the existing `ev.on('inputEvent', ...)` block (which closes around line 709) and before the `ev.on('cameraMode:changed', ...)` handler:

```js
      // The annotation navigator chevrons and a hotspot click both end at
      // 'annotation.activate', fired with the RAW settings annotation -- so
      // extras.scene (baked at export from the annotation's splat) says which
      // scene the pose it flies to actually lives in. The fly-to is a TELEPORT:
      // it need not pass through a doorway, so free-nav crossing detection can
      // never see it, exactly like the reset case above. Route through the
      // reducer so a not-yet-resident target reuses the normal loading overlay,
      // and clear lastSafe so the position discontinuity is not read as a
      // spurious crossing on the next frame.
      ev.on('annotation.activate', function (ann) {
        var idx = ann && ann.extras && ann.extras.scene;
        if (typeof idx !== 'number' || !isFinite(idx) || idx < 0 || idx >= data.portalScenes.length) { return; }
        if (idx === activeIndex) { return; }
        dispatch({ type: 'crossing', target: idx, loaded: !!(entities[idx] || sceneLoading[idx]), ready: sceneReady(idx) });
        lastSafe = null;
      });
```

(The `!isFinite(idx)` clause was added during review: `typeof NaN === 'number'`, and NaN fails every ordering comparison, so both range checks would silently pass it through without this guard.)

Remember the global constraints: no backslash escapes, no backticks in these comments.

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run test/portals-injection.test.ts > /tmp/vitest.txt 2>&1
```

Read `/tmp/vitest.txt`. Expected: PASS, whole file green.

- [ ] **Step 5: Lint**

```bash
npm run lint > /tmp/lint.txt 2>&1
```

Read `/tmp/lint.txt`. Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/viewer-companion/portals.ts test/portals-injection.test.ts
git commit -m "feat(portals): switch scene when an annotation is activated in the exported viewer"
```

---

### Task 6: Hide hotspots belonging to other scenes

**Files:**
- Modify: `src/viewer-companion/portals.ts` (`companionStyle` ~line 35; new runtime helper; `applyActive` ~line 638; `start()`; `buildPortalsInjection` payload ~line 1763)
- Test: `test/portals-injection.test.ts`

**Interfaces:**
- Consumes: `extras.scene` baked by Task 2.
- Produces: `annotationScenes: (number | null)[]` in the `window.__supersplatPortals` payload — index-aligned with the viewer's annotation list.

- [ ] **Step 1: Write the failing tests**

Append to the `buildPortalsInjection` describe block in `test/portals-injection.test.ts`:

```ts
    it('bakes the annotation scene table, index-aligned with the annotations', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/scene.sog'],
            portalStart: 0,
            annotations: [
                { title: 'a', extras: { scene: 1 } },
                { title: 'b', extras: { url: 'https://x.test' } },
                { title: 'c', extras: { scene: 0 } }
            ]
        });
        expect(out).toContain('"annotationScenes":[1,null,0]');
    });

    it('emits an empty scene table when no annotation has a scene', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/scene.sog'],
            portalStart: 0
        });
        expect(out).toContain('"annotationScenes":[]');
    });

    it('ships the off-scene hide rule as an important stylesheet declaration', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/scene.sog'],
            portalStart: 0
        });
        expect(out).toContain('.ss-annotation-offscene');
        expect(out).toContain('display: none !important');
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run test/portals-injection.test.ts > /tmp/vitest.txt 2>&1
```

Read `/tmp/vitest.txt`. Expected: FAIL on all three new tests.

- [ ] **Step 3: Add the CSS rule**

In `src/viewer-companion/portals.ts`, append to `companionStyle` (before its closing backtick):

```css
.ss-annotation-offscene { display: none !important; }
```

`!important` is required, not stylistic: the viewer writes `hotspotDom.style.display` **inline**, and an important stylesheet declaration is what beats a non-important inline one.

- [ ] **Step 4: Bake the payload array**

In `buildPortalsInjection`, immediately before the `const payload = {` literal:

```ts
    // Scene index per annotation, positionally aligned with the viewer's
    // annotation list (which is settings.annotations verbatim). null = no scene,
    // meaning the hotspot is visible in every scene.
    const annotationScenes = (viewerSettingsJson.annotations ?? []).map((a: any) => {
        const s = a?.extras?.scene;
        return (typeof s === 'number') ? s : null;
    });
```

and add it to the payload after `portalAnimTimeline` (order matters for the test's exact-substring assertion):

```ts
        portalAnimTimeline,
        annotationScenes,
        loadingDefaults: DEFAULT_MESSAGES
```

- [ ] **Step 5: Add the runtime filter**

In the companion runtime, immediately before `function applyActive()` (around line 637):

```js
  // Hotspot visibility by scene. The viewer creates one .pc-annotation-hotspot
  // per annotation IN ANNOTATION ORDER (the same ordering the annotation-link
  // companion relies on), so the Nth hotspot belongs to annotationScenes[N].
  // Portal scenes overlap in space, so without this the markers of every floor
  // hang in the air in all the others. Annotations with no scene stay visible
  // everywhere. Hiding uses a class backed by an !important stylesheet rule
  // because the viewer writes hotspotDom.style.display inline.
  var annotationScenes = data.annotationScenes || [];
  var hasSceneAnnotations = false;
  for (var ai = 0; ai < annotationScenes.length; ai++) {
    if (typeof annotationScenes[ai] === 'number') { hasSceneAnnotations = true; break; }
  }
  function applyHotspotVisibility() {
    if (!hasSceneAnnotations) { return; }
    var host = document.getElementById('annotations');
    if (!host) { return; }
    var hotspots = host.querySelectorAll('.pc-annotation-hotspot');
    for (var i = 0; i < hotspots.length; i++) {
      var s = annotationScenes[i];
      if (typeof s === 'number' && s !== activeIndex) {
        hotspots[i].classList.add('ss-annotation-offscene');
      } else {
        hotspots[i].classList.remove('ss-annotation-offscene');
      }
    }
  }
```

- [ ] **Step 6: Call it on every scene change and on late-created hotspots**

Extend `applyActive` (it is the single place the visible scene changes):

```js
  // Enable exactly the active scene; disable the rest (avoids overlapping haze).
  function applyActive() {
    for (var i = 0; i < entities.length; i++) {
      if (entities[i]) entities[i].enabled = (i === activeIndex);
    }
    applyHotspotVisibility();
    var app = getApp(window.__supersplatViewer);
    if (app) app.renderNextFrame = true;
  }
```

And in `start()`, immediately after the existing `applyActive();` call (around line 747):

```js
    // hotspots are created once the splat scene loads, so keep filtering as they
    // appear -- same approach the annotation-link companion uses for binding
    if (hasSceneAnnotations) {
      applyHotspotVisibility();
      new MutationObserver(function () { applyHotspotVisibility(); })
        .observe(document.body, { childList: true, subtree: true });
    }
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npx vitest run test/portals-injection.test.ts > /tmp/vitest.txt 2>&1
```

Read `/tmp/vitest.txt`. Expected: PASS, whole file green.

- [ ] **Step 8: Verify the whole suite and lint**

```bash
npx vitest run > /tmp/vitest.txt 2>&1
npm run lint > /tmp/lint.txt 2>&1
```

Read both. Expected: all PASS; lint exits 0.

- [ ] **Step 9: Commit**

```bash
git add src/viewer-companion/portals.ts test/portals-injection.test.ts
git commit -m "feat(portals): hide annotation hotspots that belong to another scene"
```

---

### Task 7: Release-build end-to-end verification

The companion runtime is a stringified template and is minified into the export, so nothing before this task proves it actually runs. Minification of stringified helpers has broken this code before — a debug build is **not** sufficient evidence.

**Files:** none modified (unless a defect is found).

**Interfaces:** consumes everything from Tasks 1–6.

- [ ] **Step 1: Produce a release build**

```bash
npm run build > /tmp/build.txt 2>&1
```

Read `/tmp/build.txt`. Expected: completes with no errors. (`npm run build` defaults to `BUILD_TYPE=release`, which strips `Debug.exec` and runs terser — this is the configuration that must be tested.)

- [ ] **Step 2: Author the test project**

In the editor, build a project with:
- at least two splats wired by a portal (so a bundle exists),
- at least one annotation in the start scene,
- at least one annotation in a non-start scene,
- one annotation with Scene = **None**.

- [ ] **Step 3: Export and verify the baked settings**

Export as a ZIP viewer package, unzip it, and confirm the settings JSON carries `"scene"` inside the `extras` of the scene-assigned annotations and omits it for the None one. Confirm the injected payload contains `"annotationScenes"`.

- [ ] **Step 4: Run the viewer E2E checklist**

Serve the unzipped export and check:

1. **Cross-scene navigation** — the navigator chevrons cycle every annotation; landing on one in another scene switches the visible scene to match.
2. **Not-yet-resident target** (streaming export) — navigating to an annotation in an unloaded scene shows the normal loading overlay and completes; no stuck overlay.
3. **Hotspot filtering** — markers of non-active scenes are hidden and reappear when their scene becomes active.
4. **Unset annotations** — the None annotation flies the camera without changing scene.
5. **Hotspot click** — clicking a marker directly (not the chevrons) switches scene the same way.
6. **Link companion intact** — an annotation with a URL still shows its "Open link" button.
7. **Reset still correct** — pressing R after an annotation-driven switch behaves as before (walk/fly restores the spawn scene; orbit/anim restores the start scene).
8. **Single-scene export unaffected** — export a project with no portals; annotations behave exactly as they did before this feature.
9. **S3 publish** — publish the portal project and repeat checks 1 and 3 against the published URL.

- [ ] **Step 5: Report**

Report the checklist results verbatim, including any failures. If a check fails, stop and fix it (with a test where the failure is unit-testable) before proceeding.

- [ ] **Step 6: Finish the branch**

Once every check passes, use the `superpowers:finishing-a-development-branch` skill: squash the feature's commits into a single commit summarising all changes including documentation, then merge.

---

## Notes for the implementer

- **Why a splat uid and not a scene index in the editor:** export scene indices are derived from the portal graph at export time (`buildPortalBundle` puts the start scene first, then the rest in first-seen order). An index stored in the editor would silently rot whenever portals change.
- **Why `extras`:** the exported viewer does `this.annotations = global.settings.annotations` and hands that raw object to `annotation.activate`, so `extras` arrives verbatim at runtime. It is the same channel `extras.url` / `extras.newTab` already use.
- **Known behaviour (accepted in the design):** the scene swaps immediately while the camera transition plays, so mid-flight you briefly see the destination scene from the source scene's vantage point. This matches the existing reset behaviour; deferring the swap to transition-end would mean flying through the old scene's geometry to a pose belonging to the new one.
