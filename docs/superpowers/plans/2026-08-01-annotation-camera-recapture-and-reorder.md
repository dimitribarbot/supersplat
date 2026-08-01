# Annotation Camera Re-capture and Reordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an author change an annotation's saved camera view and its position in the annotation order after it has been placed.

**Architecture:** Three compact glyph buttons are added to the floating annotation toolbar. The camera button reuses the existing `UpdateAnnotationOp` on the already-serialized `camera` field, so no data-layer change is needed. Reordering adds one low-level mutator (`annotations.moveRaw`) and one edit-history op (`MoveAnnotationOp`) to `src/annotations.ts`; array position already *is* the annotation order everywhere it matters.

**Tech Stack:** TypeScript, PlayCanvas engine + PCUI, i18next, Vitest, ESLint.

Spec: `docs/superpowers/specs/2026-08-01-annotation-camera-recapture-and-reorder-design.md`.

## Global Constraints

- **No format change.** `camera` and array order are already persisted (`docSerialize.annotations`) and already exported (`annotations.export`). Do not touch `src/splat-serialize.ts`, `src/portal-export.ts`, `src/s3-publish.ts`, `src/viewer-companion/*` or the server.
- **Glyphs are plain text, never emoji:** `⊙` (set view), `↑` (move earlier), `↓` (move later). Follows `src/tools/portal-tool.ts:54-57` (`⤢`, `⧉`).
- **Tooltips only, no visible labels.** Set via `button.dom.title = i18n.t(key)`.
- **Localization keys** are exactly `panel.annotations.set-view`, `panel.annotations.move-earlier`, `panel.annotations.move-later`, added to all 9 locales in `static/locales/`. English values are Title Case to match the surrounding block.
- **Selection must survive a move.** Never implement a move as `removeRaw` + `insertRaw`: `removeRaw` clears the selection (`src/annotations.ts:200-204`), which would close the toolbar on every click.
- **Every mutation goes through the edit history** — `events.fire('edit.add', new …Op(…))`, never a direct raw-event fire from the UI.
- **Packed arrays are copied, never aliased,** when captured into an undo snapshot: write `[v[0], v[1], v[2]]`, matching the house style in `src/annotations.ts:259,315`.
- **Run test gates in the foreground.** Never background them and never pipe Vitest output to `grep` (it hangs — see project memory).
- **ESLint:** do not reorder existing imports; ESLint 10 crashes on `import/order` autofix. Append to existing import lines in place.

---

### Task 1: Reorder mutator and edit-history op

**Files:**
- Modify: `src/annotations.ts` (add `MoveAnnotationOp` after `UpdateAnnotationOp` ends at line 163; add the `annotations.moveRaw` handler after the `annotations.updateRaw` handler ends at line 215; add to the export block at line 374)
- Test: `test/annotations.test.ts` (append new `describe` blocks at end of file)

**Interfaces:**
- Consumes: the existing `Events` double in `test/annotations.test.ts` (`makeEvents`, `annotation`), `AddAnnotationOp`.
- Produces:
  - Event `annotations.moveRaw(id: string, toIndex: number)` — moves the record with `id` to `toIndex`, clamping `toIndex` into `[0, length - 1]`; no-ops on unknown id or when already at the target index; fires `annotations.changed` only when the array actually changed; never touches the selection.
  - `class MoveAnnotationOp { constructor(events: Events, id: string, fromIndex: number, toIndex: number); name = 'moveAnnotation'; do(); undo(); destroy(); }` — exported from `src/annotations.ts`.

- [ ] **Step 1: Write the failing tests**

Append to the end of `test/annotations.test.ts`:

```ts
describe('annotations reordering', () => {
    const seed = (events: any, n: number) => {
        for (let i = 0; i < n; i++) {
            new AddAnnotationOp(events, annotation({ id: `annotation_${i}` })).do();
        }
    };

    const ids = (events: any) => (events.invoke('annotations.list') as AnnotationData[]).map(a => a.id);

    it('moves a record to the given index', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        seed(events, 3);
        events.fire('annotations.moveRaw', 'annotation_2', 0);
        expect(ids(events)).toEqual(['annotation_2', 'annotation_0', 'annotation_1']);
    });

    it('clamps an index past the end', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        seed(events, 3);
        events.fire('annotations.moveRaw', 'annotation_0', 99);
        expect(ids(events)).toEqual(['annotation_1', 'annotation_2', 'annotation_0']);
    });

    it('clamps a negative index', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        seed(events, 3);
        events.fire('annotations.moveRaw', 'annotation_2', -5);
        expect(ids(events)).toEqual(['annotation_2', 'annotation_0', 'annotation_1']);
    });

    it('does not fire changed when the record is already at the index', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        seed(events, 3);
        let changes = 0;
        events.on('annotations.changed', () => {
            changes++;
        });
        events.fire('annotations.moveRaw', 'annotation_1', 1);
        expect(changes).toBe(0);
        expect(ids(events)).toEqual(['annotation_0', 'annotation_1', 'annotation_2']);
    });

    it('ignores an unknown id', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        seed(events, 2);
        events.fire('annotations.moveRaw', 'annotation_9', 0);
        expect(ids(events)).toEqual(['annotation_0', 'annotation_1']);
    });

    // The property that ruled out remove+insert: removeRaw clears the selection,
    // which would close the annotation toolbar on every click of a move button.
    it('leaves the selection intact when the moved record is selected', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        seed(events, 3);
        expect(events.invoke('annotations.selected')).toBe('annotation_2');
        events.fire('annotations.moveRaw', 'annotation_2', 0);
        expect(events.invoke('annotations.selected')).toBe('annotation_2');
    });

    it('MoveAnnotationOp restores the original order on undo', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        seed(events, 3);
        const op = new MoveAnnotationOp(events, 'annotation_2', 2, 1);
        op.do();
        expect(ids(events)).toEqual(['annotation_0', 'annotation_2', 'annotation_1']);
        op.undo();
        expect(ids(events)).toEqual(['annotation_0', 'annotation_1', 'annotation_2']);
    });

    it('the new order drives the export order', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        seed(events, 3);
        new MoveAnnotationOp(events, 'annotation_2', 2, 0).do();
        const out = events.invoke('annotations.export');
        expect(out.map((a: any) => a.extras.id)).toEqual(['annotation_2', 'annotation_0', 'annotation_1']);
    });

    it('the new order drives the document serialization order', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        seed(events, 3);
        new MoveAnnotationOp(events, 'annotation_0', 0, 2).do();
        const doc = events.invoke('docSerialize.annotations');
        expect(doc.map((d: any) => d.id)).toEqual(['annotation_1', 'annotation_2', 'annotation_0']);
    });
});
```

Extend the existing import at the top of the file (line 3) to pull in the new op — edit the line in place, do not add a second import statement:

```ts
import { AddAnnotationOp, AnnotationData, AnnotationImage, MoveAnnotationOp, registerAnnotationsEvents } from '../src/annotations';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/annotations.test.ts`
Expected: FAIL — the whole file fails to load with `does not provide an export named 'MoveAnnotationOp'` (Vitest resolves the named import at module load). If you instead see the file load and only the new assertions fail, that is also a valid red — the moveRaw tests report an unchanged array because the event has no listener and `fire` is a silent no-op.

- [ ] **Step 3: Add `MoveAnnotationOp`**

In `src/annotations.ts`, insert after the closing `}` of `UpdateAnnotationOp` (line 163) and before `const registerAnnotationsEvents = …`:

```ts
// Reordering an annotation is a move of its slot in the array, which IS the
// annotation order (badge numbers, export order, the exported viewer's iframe
// api index). A single move is its own inverse, so from/to round-trip exactly.
class MoveAnnotationOp {
    name = 'moveAnnotation';
    events: Events;
    id: string;
    fromIndex: number;
    toIndex: number;

    constructor(events: Events, id: string, fromIndex: number, toIndex: number) {
        this.events = events;
        this.id = id;
        this.fromIndex = fromIndex;
        this.toIndex = toIndex;
    }

    do() {
        this.events.fire('annotations.moveRaw', this.id, this.toIndex);
    }

    undo() {
        this.events.fire('annotations.moveRaw', this.id, this.fromIndex);
    }

    destroy() {
        this.events = null;
    }
}
```

- [ ] **Step 4: Add the `annotations.moveRaw` mutator**

In `src/annotations.ts`, insert after the `annotations.updateRaw` handler (which ends at line 215) and before the `// --- selection ---` comment:

```ts
    // Splices in place rather than remove+insert: removeRaw clears the
    // selection (see above), which would close the annotation toolbar on every
    // click of a move button.
    events.on('annotations.moveRaw', (id: string, toIndex: number) => {
        const from = annotations.findIndex(a => a.id === id);
        if (from < 0) {
            return;
        }
        const to = Math.max(0, Math.min(annotations.length - 1, toIndex));
        if (to === from) {
            return;
        }
        const [a] = annotations.splice(from, 1);
        annotations.splice(to, 0, a);
        fireChanged();
    });
```

- [ ] **Step 5: Export the op**

In the export block at the bottom of `src/annotations.ts` (line 374), add `MoveAnnotationOp` immediately after `UpdateAnnotationOp`:

```ts
export {
    registerAnnotationsEvents,
    AddAnnotationOp,
    RemoveAnnotationOp,
    UpdateAnnotationOp,
    MoveAnnotationOp,
    AnnotationData,
    AnnotationDocData,
    AnnotationCamera,
    AnnotationExport,
    AnnotationImage
};
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/annotations.test.ts`
Expected: PASS — all pre-existing tests plus the 9 new ones.

- [ ] **Step 7: Lint**

Run: `npm run lint`
Expected: exit 0, no new warnings.

- [ ] **Step 8: Commit**

```bash
git add src/annotations.ts test/annotations.test.ts
git commit -m "feat(annotations): add moveRaw mutator and MoveAnnotationOp"
```

---

### Task 2: Localization strings

**Files:**
- Modify: `static/locales/de.json`, `en.json`, `es.json`, `fr.json`, `ja.json`, `ko.json`, `pt-BR.json`, `ru.json`, `zh-CN.json`

**Interfaces:**
- Consumes: nothing.
- Produces: keys `panel.annotations.set-view`, `panel.annotations.move-earlier`, `panel.annotations.move-later`, consumed by Tasks 3 and 4.

- [ ] **Step 1: Add the three keys to every locale**

In each file, insert the three lines immediately **after the last line whose key starts with `"panel.annotations.images-edit`** (the line number differs per locale: `ja`, `ko`, `zh-CN` have one such line, `en`/`de` two, `es`/`fr`/`pt-BR` three, `ru` four). Keep the existing trailing comma structure valid.

`static/locales/en.json`:
```json
    "panel.annotations.set-view": "Set View From Camera",
    "panel.annotations.move-earlier": "Move Earlier",
    "panel.annotations.move-later": "Move Later",
```

`static/locales/de.json`:
```json
    "panel.annotations.set-view": "Ansicht von Kamera übernehmen",
    "panel.annotations.move-earlier": "Nach vorne verschieben",
    "panel.annotations.move-later": "Nach hinten verschieben",
```

`static/locales/es.json`:
```json
    "panel.annotations.set-view": "Establecer vista desde la cámara",
    "panel.annotations.move-earlier": "Mover antes",
    "panel.annotations.move-later": "Mover después",
```

`static/locales/fr.json`:
```json
    "panel.annotations.set-view": "Définir la vue depuis la caméra",
    "panel.annotations.move-earlier": "Déplacer avant",
    "panel.annotations.move-later": "Déplacer après",
```

`static/locales/ja.json`:
```json
    "panel.annotations.set-view": "カメラから視点を設定",
    "panel.annotations.move-earlier": "前に移動",
    "panel.annotations.move-later": "後ろに移動",
```

`static/locales/ko.json`:
```json
    "panel.annotations.set-view": "카메라에서 시점 설정",
    "panel.annotations.move-earlier": "앞으로 이동",
    "panel.annotations.move-later": "뒤로 이동",
```

`static/locales/pt-BR.json`:
```json
    "panel.annotations.set-view": "Definir vista pela câmera",
    "panel.annotations.move-earlier": "Mover para antes",
    "panel.annotations.move-later": "Mover para depois",
```

`static/locales/ru.json`:
```json
    "panel.annotations.set-view": "Задать вид с камеры",
    "panel.annotations.move-earlier": "Переместить раньше",
    "panel.annotations.move-later": "Переместить позже",
```

`static/locales/zh-CN.json`:
```json
    "panel.annotations.set-view": "从相机设置视角",
    "panel.annotations.move-earlier": "前移",
    "panel.annotations.move-later": "后移",
```

- [ ] **Step 2: Verify every locale file is still valid JSON and has the keys**

Run: `node -e "for (const f of ['de','en','es','fr','ja','ko','pt-BR','ru','zh-CN']) { const j = JSON.parse(require('fs').readFileSync('static/locales/'+f+'.json','utf8')); for (const k of ['set-view','move-earlier','move-later']) { if (!j['panel.annotations.'+k]) throw new Error(f+' missing '+k); } console.log(f, 'ok'); }"`
Expected: nine `… ok` lines, no throw.

- [ ] **Step 3: Run the localization test suite**

Run: `npx vitest run test/localization-plurals.test.ts`
Expected: PASS (unchanged — these keys have no plural forms).

- [ ] **Step 4: Commit**

```bash
git add static/locales
git commit -m "feat(annotations): add tooltip strings for camera and order buttons"
```

Note for the reviewer: the non-English strings are machine-assisted and need a native read-through before the branch is finished.

---

### Task 3: "Set view from camera" button

**Files:**
- Modify: `src/tools/annotation-tool.ts` (import line 4; button declarations after line 53; `bar.append` block after line 67; handlers after line 155)
- Test: `test/annotations.test.ts` (append one `describe` block)

**Interfaces:**
- Consumes: `UpdateAnnotationOp` and the `AnnotationCamera` type from `../annotations`; the `camera.getPose` function registered in `src/editor.ts:891`, which returns `{ position: {x,y,z}, target: {x,y,z}, fov: number }` (plain objects, **not** `Vec3`).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Append to the end of `test/annotations.test.ts`:

```ts
describe('annotation camera pose', () => {
    it('an update of camera round-trips through undo and reaches the export', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation()).do();
        const op = new UpdateAnnotationOp(
            events,
            'annotation_0',
            { camera: { position: [0, 0, 0], target: [0, 0, 1], fov: 60 } },
            { camera: { position: [1, 2, 3], target: [4, 5, 6], fov: 45 } }
        );
        op.do();
        expect(events.invoke('annotations.export')[0].camera.initial)
        .toEqual({ position: [1, 2, 3], target: [4, 5, 6], fov: 45 });
        op.undo();
        expect(events.invoke('annotations.export')[0].camera.initial)
        .toEqual({ position: [0, 0, 0], target: [0, 0, 1], fov: 60 });
    });
});
```

Leave the import line alone for now — the next step needs it to be red.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/annotations.test.ts`
Expected: FAIL — `UpdateAnnotationOp is not defined` (it is exported from `src/annotations.ts` but not yet imported by the test file).

- [ ] **Step 3: Extend the test import and re-run**

Edit the same import line (line 3) in place — no second import statement:

```ts
import { AddAnnotationOp, AnnotationData, AnnotationImage, MoveAnnotationOp, registerAnnotationsEvents, UpdateAnnotationOp } from '../src/annotations';
```

Run: `npx vitest run test/annotations.test.ts`
Expected: PASS.

This test needs no production code because the op already exists; it is regression cover for `camera` reaching `camera.initial` in the export, which is the path the button drives.

- [ ] **Step 4: Import the op and the camera type into the tool**

In `src/tools/annotation-tool.ts`, replace line 4 (keep it a single import statement, same position in the file):

```ts
import { AddAnnotationOp, AnnotationCamera, AnnotationData, RemoveAnnotationOp, UpdateAnnotationOp } from '../annotations';
```

- [ ] **Step 5: Declare the button**

In `src/tools/annotation-tool.ts`, after the `sceneInput` declaration (line 53) add:

```ts
        const viewButton = new Button({ text: '⊙', class: 'select-toolbar-button' });
        viewButton.dom.title = i18n.t('panel.annotations.set-view');
```

`select-toolbar-button` is styled by `src/ui/scss/select-toolbar.scss:71` and applies here because the bar carries the `select-toolbar` class (line 28).

- [ ] **Step 6: Append the button to the bar**

In the `bar.append(…)` block, after `bar.append(sceneInput);` (line 67):

```ts
        bar.append(viewButton);
```

- [ ] **Step 7: Add the pose comparison helper and the click handler**

After the `sceneInput.on('change', …)` handler (line 155) add:

```ts
        // The stored pose is a plain object, so the generic commit() helper's
        // `a[field] === value` test can never be true for it -- comparing
        // component-wise here is what keeps a repeated click from pushing an
        // empty entry onto the undo stack.
        const samePose = (c: AnnotationCamera, pose: { position: { x: number, y: number, z: number }, target: { x: number, y: number, z: number }, fov: number }) => {
            return c.position[0] === pose.position.x &&
                   c.position[1] === pose.position.y &&
                   c.position[2] === pose.position.z &&
                   c.target[0] === pose.target.x &&
                   c.target[1] === pose.target.y &&
                   c.target[2] === pose.target.z &&
                   c.fov === pose.fov;
        };

        // pointerdown + stopPropagation (as in portal-tool.ts) so a press on the
        // bar never falls through to the canvas and places a new annotation
        viewButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            const a = selected();
            if (!active || !a) {
                return;
            }
            const pose = events.invoke('camera.getPose');
            if (!pose || samePose(a.camera, pose)) {
                return;
            }
            events.fire('edit.add', new UpdateAnnotationOp(
                events,
                a.id,
                { camera: {
                    position: [a.camera.position[0], a.camera.position[1], a.camera.position[2]],
                    target: [a.camera.target[0], a.camera.target[1], a.camera.target[2]],
                    fov: a.camera.fov
                } },
                { camera: {
                    position: [pose.position.x, pose.position.y, pose.position.z],
                    target: [pose.target.x, pose.target.y, pose.target.z],
                    fov: pose.fov
                } }
            ));
        });
```

- [ ] **Step 8: Lint and run the full unit suite**

Run: `npm run lint`
Expected: exit 0.

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 9: Verify in the running app**

Run: `npm run develop` and open http://localhost:3333.
Load any `.ply`, pick the annotation tool, click the splat to place an annotation, orbit the camera somewhere clearly different, then press `⊙`.
Expected: no visible change in the viewport (by design — the stored pose is not rendered), but Ctrl+Z / Ctrl+Y now step over a `moveAnnotation`-sibling camera edit without disturbing the marker position, and hovering `⊙` shows the localized tooltip.

- [ ] **Step 10: Commit**

```bash
git add src/tools/annotation-tool.ts test/annotations.test.ts
git commit -m "feat(annotations): re-capture an annotation's saved camera view"
```

---

### Task 4: "Move earlier" / "Move later" buttons

**Files:**
- Modify: `src/tools/annotation-tool.ts` (import line 4; button declarations after the `viewButton` added in Task 3; `bar.append` block; `refreshBar`; handlers)

**Interfaces:**
- Consumes: `MoveAnnotationOp` from Task 1; `panel.annotations.move-earlier` / `panel.annotations.move-later` from Task 2; the `annotations.list` function (returns the live array — read only, never mutate).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Import the op**

In `src/tools/annotation-tool.ts`, replace line 4 (single statement, same position):

```ts
import { AddAnnotationOp, AnnotationCamera, AnnotationData, MoveAnnotationOp, RemoveAnnotationOp, UpdateAnnotationOp } from '../annotations';
```

- [ ] **Step 2: Declare the two buttons**

Immediately after the `viewButton` declaration added in Task 3:

```ts
        const upButton = new Button({ text: '↑', class: 'select-toolbar-button' });
        upButton.dom.title = i18n.t('panel.annotations.move-earlier');
        const downButton = new Button({ text: '↓', class: 'select-toolbar-button' });
        downButton.dom.title = i18n.t('panel.annotations.move-later');
```

- [ ] **Step 3: Append them to the bar**

Immediately after `bar.append(viewButton);`:

```ts
        bar.append(upButton);
        bar.append(downButton);
```

- [ ] **Step 4: Drive the enabled state from `refreshBar`**

In `refreshBar()`, immediately before the closing `suppress = false;` (line 125 in the original file):

```ts
            // the ends are dead rather than silently no-op
            const list = events.invoke('annotations.list') as AnnotationData[];
            const index = list.indexOf(a);
            upButton.enabled = index > 0;
            downButton.enabled = index < list.length - 1;
```

`refreshBar` already runs on `annotations.changed` (line 319) and on `annotations.selectionChanged` (line 323), so the states update immediately after each move.

- [ ] **Step 5: Add the click handlers**

After the `viewButton` handler added in Task 3:

```ts
        // A disabled PCUI button can still receive a raw dom pointerdown, so the
        // bounds check here is the real guard, not the enabled flag.
        const move = (delta: number) => {
            const a = selected();
            if (!active || !a) {
                return;
            }
            const list = events.invoke('annotations.list') as AnnotationData[];
            const index = list.indexOf(a);
            const to = index + delta;
            if (index < 0 || to < 0 || to >= list.length) {
                return;
            }
            events.fire('edit.add', new MoveAnnotationOp(events, a.id, index, to));
        };

        upButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            move(-1);
        });

        downButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            move(1);
        });
```

- [ ] **Step 6: Lint and run the full unit suite**

Run: `npm run lint`
Expected: exit 0.

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 7: Verify in the running app**

Run: `npm run develop` and open http://localhost:3333.
Place three annotations, select the third, press `↑` twice.
Expected: the numbered badges renumber live (the selected marker becomes `1`), the toolbar stays open with the same annotation selected throughout, `↑` greys out at the first slot and `↓` at the last, and Ctrl+Z steps the annotation back one slot per press.

- [ ] **Step 8: Commit**

```bash
git add src/tools/annotation-tool.ts
git commit -m "feat(annotations): move an annotation earlier or later in the order"
```

---

### Task 5: End-to-end verification

**Files:**
- Modify: none (verification only; fixes land as follow-up commits if something fails)

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: a green E2E result, which is the gate for finishing the branch.

- [ ] **Step 1: Full gate**

Run: `npm run lint`
Expected: exit 0.

Run: `npx vitest run`
Expected: PASS, no skipped annotation tests.

Run: `npm run build`
Expected: build completes, `dist/` written, no TypeScript errors.

- [ ] **Step 2: Camera re-capture reaches the exported viewer**

In a release build (`npm run build`, then serve `dist/`), place an annotation, orbit to a clearly different viewpoint, press `⊙`, then export as Package (ZIP) and open the exported viewer.
Expected: clicking that annotation flies to the **new** view, not the placement view.

- [ ] **Step 3: Order reaches the exported viewer**

Place three annotations with distinct titles, reorder them with `↑`/`↓`, export, and open the viewer.
Expected: the exported annotation sequence matches the editor's badge numbering.

- [ ] **Step 4: Undo/redo**

In the editor, alternate camera re-captures and moves, then Ctrl+Z back to the start and Ctrl+Y forward.
Expected: each step reverses exactly one operation; no marker jumps position on a camera undo, and no annotation is lost or duplicated.

- [ ] **Step 5: Project round-trip**

Save a `.ssproj` containing re-captured views and a custom order, clear the scene, reload the project.
Expected: both the views and the order survive; re-export produces the same viewer behaviour as before the save.

- [ ] **Step 6: Report**

Report the result of every step above verbatim, including any failure. Do not claim completion on any step that was not actually run.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 camera re-capture (no new plumbing, copied arrays) | Task 3 steps 1, 7 |
| §1 `annotations.moveRaw` | Task 1 step 4 |
| §1 `MoveAnnotationOp` | Task 1 steps 3, 5 |
| §2 three glyph buttons, tooltips, `select-toolbar-button` | Task 3 steps 5-6, Task 4 steps 2-3 |
| §2 component-wise pose comparison | Task 3 step 7 |
| §2 enabled/disabled at the ends | Task 4 step 4 |
| §2 `pointerdown` + `stopPropagation` | Task 3 step 7, Task 4 step 5 |
| §3 three keys × 9 locales, Title Case English | Task 2 |
| §4 no export/persistence code change | Global Constraints (explicit do-not-touch list) |
| §5 all six unit tests | Task 1 step 1 (six of them), Task 3 step 1 (camera round-trip) |
| §5 manual E2E checklist (4 items) | Task 5 steps 2-5 |

No spec requirement is unassigned.

**Placeholder scan:** none — every code step carries the literal code, every locale string is spelled out, every run step names the command and the expected result.

**Type consistency:** `MoveAnnotationOp(events, id, fromIndex, toIndex)` is declared in Task 1 and called with that exact signature in Task 1's tests and Task 4 step 5. `annotations.moveRaw(id, toIndex)` is fired with two arguments everywhere. `AnnotationCamera` (imported in Task 3 step 4) is the type of `a.camera` and the first parameter of `samePose`. `camera.getPose` is typed as plain `{x,y,z}` objects in Task 3, matching `src/editor.ts:891-900` — not `Vec3`, which is what `camera.setPose` takes and would have been the easy mistake.
