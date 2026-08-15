# Per-scene collision parameters + post-export size report — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator set collision `radius` and `voxelSize` per portal scene instead of sharing one value across the whole export, and report each scene's actual collision file size once the export finishes.

**Architecture:** Two index-aligned arrays (`portalRadii`, `portalVoxelSizes`) ride alongside the existing `portalEnvironments` through `ExperienceSettings` → `resolvePortalExtras` → `ExtraPortalScene` → `writeCollisionVoxel`. The export core is otherwise untouched: it already broadcasts every written ZIP entry's byte length on the `exportFile` event, so the size report is built by listening rather than by adding plumbing. A new shared PCUI module renders collapsible per-scene cards in both export dialogs.

**Tech Stack:** TypeScript (strictNullChecks off), PCUI, Rollup, Vitest, Fastify (server), i18next.

**Spec:** `docs/superpowers/specs/2026-08-15-per-scene-collision-params-design.md` — read it before Task 1. It records *why* the adaptive voxel-size default and the in-dialog size estimate were both rejected; do not reintroduce either.

## Global Constraints

- **Defaults never change:** every scene starts at `environment: 'indoor'`, `radius: 50`, `voxelSize: 0.05`. Slider ranges stay `radius` 5–500 precision 0, `voxelSize` 0.02–0.5 precision 2.
- **`ViewerExportSettings.collision` keeps its shape** `{ environment, radius, voxelSize }` and keeps meaning *scene 0*. Do not make it an array. The server's byte-parity guarantee depends on the single-scene path being untouched.
- **Do not modify `src/ui/popup.ts` or `src/ui/scss/popup.scss`** — upstream-owned. New UI goes in new fork-authored files.
- **Do not modify `src/collision-voxel-options.ts`** — out of scope for this change.
- **Localization:** every new i18n key must be added to all nine files in `static/locales/*.json`.
- **Lint:** run `npm run lint` before each commit. ESLint is pinned to v10; **never** attempt an `import/order` autofix (it crashes). Leave import ordering exactly as you find it.
- **Vitest hangs when backgrounded or piped.** Run it in the foreground and redirect to a file: `npx vitest run <path> > /tmp/out.txt 2>&1; cat /tmp/out.txt`. Never pipe it to `grep`.
- **Rollup reports TypeScript errors as warnings.** A build "succeeding" proves nothing. Gate on `npm run build 2>&1 | grep -c "plugin typescript"` being `0`.
- Run all commands from the repo root with no `cd` / `git -C` / `npm --prefix` prefix pointing at the cwd. Server commands are the exception and are given explicitly.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/splat-serialize.ts` | modify | add `portalRadii` / `portalVoxelSizes` to `ExperienceSettings`; `radius` / `voxelSize` on `portalScenes[]` entries |
| `src/portal-export.ts` | modify | `PortalExtra` + `resolvePortalExtras` carry the two values |
| `src/splat-export-core.ts` | modify | `ExtraPortalScene` carries them; `writePortalScene` reads them off `scene` |
| `src/portal-upload.ts` | modify | `PortalUploadMeta` carries them to the server |
| `server/src/run-export.ts` | modify | rebuild `ExtraPortalScene` with them; emit collision-size progress events |
| `server/src/progress.ts` | modify | `ProgressEvent` progress variant gains `collision?: { index, bytes }` |
| `src/ui/collision-params.ts` | **create** | per-scene collision state + collapsible card UI, shared by both dialogs |
| `src/ui/export-popup.ts` | modify | mount the shared panel; assemble the arrays |
| `src/ui/s3-publish-dialog.ts` | modify | same |
| `src/ui/export-summary-dialog.ts` | **create** | post-export per-scene collision size report |
| `src/ui/scss/export-popup.scss` | modify | card styling; scrollable `#content` |
| `src/ui/scss/export-summary-dialog.scss` | **create** | summary dialog styling |
| `src/ui/scss/style.scss` | modify | import the new stylesheet |
| `src/ui/editor.ts` | modify | instantiate the summary dialog; register `showExportSummary` |
| `src/file-handler.ts` | modify | pass the arrays; collect sizes (local + server export) |
| `src/s3-publish.ts` | modify | collect sizes on publish; show the summary dialog |
| `static/locales/*.json` (9) | modify | four new keys |
| `test/portal-export.test.ts` | modify | per-index carry + fallback |
| `test/collision-size-report.test.ts` | **create** | the entry-name → scene-index parser |
| `server/test/portal-extras.test.ts` | modify | round-trip through `portalExtras` |
| `server/test/run-export.test.ts` | modify | collision progress events emitted |

Task order is dependency order: types and pure logic first (1–3), then the server (4), then UI (5–8), then wiring (9–10).

---

### Task 1: Carry `radius` / `voxelSize` through `resolvePortalExtras`

**Files:**
- Modify: `src/portal-export.ts:180-225`
- Test: `test/portal-export.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `PortalExtra` gains `radius: number` and `voxelSize: number`. `resolvePortalExtras` args gain `radii: number[]` and `voxelSizes: number[]`. Fallbacks are `50` and `0.05` when an array is shorter than the scene list.

- [ ] **Step 1: Read the existing test file for its conventions**

Run: `npx vitest run test/portal-export.test.ts > /tmp/pe.txt 2>&1; cat /tmp/pe.txt`

Expected: PASS. Note how existing tests build the `resolvePortalExtras` args object — copy that shape rather than inventing one.

- [ ] **Step 2: Write the failing tests**

Append to `test/portal-export.test.ts`. Build the args by copying an existing passing test's fixture and adding `radii` / `voxelSizes`:

```ts
describe('resolvePortalExtras per-scene collision params', () => {
    it('carries per-index radius and voxelSize onto each extra', () => {
        const res = resolvePortalExtras({
            ...baseArgs,                       // reuse the fixture already in this file
            environments: ['indoor', 'outdoor', 'indoor'],
            radii: [50, 200, 75],
            voxelSizes: [0.05, 0.2, 0.1]
        });
        // extras excludes index 0 (the start scene)
        expect(res.extras.map(e => e.radius)).toEqual([200, 75]);
        expect(res.extras.map(e => e.voxelSize)).toEqual([0.2, 0.1]);
    });

    it('falls back to 50 / 0.05 when the arrays are shorter than the scene list', () => {
        const res = resolvePortalExtras({
            ...baseArgs,
            environments: [],
            radii: [],
            voxelSizes: []
        });
        expect(res.extras.every(e => e.radius === 50)).toBe(true);
        expect(res.extras.every(e => e.voxelSize === 0.05)).toBe(true);
    });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/portal-export.test.ts > /tmp/pe.txt 2>&1; cat /tmp/pe.txt`

Expected: FAIL — `radius` and `voxelSize` are `undefined` on the extras.

- [ ] **Step 4: Add the fields to `PortalExtra`**

In `src/portal-export.ts`, at the `PortalExtra` type (line ~180):

```ts
type PortalExtra = {
    index: number,
    uid: number,
    collisionUrl: string | null,
    environment: 'indoor' | 'outdoor',
    radius: number,
    voxelSize: number,
    seed: Vec3,
    estimated: boolean
};
```

- [ ] **Step 5: Accept and apply the two arrays in `resolvePortalExtras`**

Add to the args type, right after `environments`:

```ts
    radii: number[],
    voxelSizes: number[],
```

Add them to the destructuring on the next line, then inside the `.map` add the two fields next to `environment`:

```ts
            environment: environments[index] ?? 'indoor',
            radius: radii[index] ?? 50,
            voxelSize: voxelSizes[index] ?? 0.05,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/portal-export.test.ts > /tmp/pe.txt 2>&1; cat /tmp/pe.txt`

Expected: PASS, including all pre-existing tests in the file.

- [ ] **Step 7: Lint and commit**

```bash
npm run lint
git add src/portal-export.ts test/portal-export.test.ts
git commit -m "feat(collision): carry per-scene radius and voxel size through resolvePortalExtras"
```

---

### Task 2: Per-scene values in the serializer types and the export core

**Files:**
- Modify: `src/splat-serialize.ts:148` and `:160`, and `serializeViewer` at `:1480-1505`
- Modify: `src/splat-export-core.ts:654-724` (`writePortalScene`), `:916-922` (`ExtraPortalScene`), call sites at `:835-846` and `:1012-1017`
- Modify: `src/portal-upload.ts`

**Interfaces:**
- Consumes: `PortalExtra.radius` / `.voxelSize` from Task 1.
- Produces: `ExtraPortalScene` gains `radius: number` and `voxelSize: number`. `writePortalScene`'s signature loses its `radius: number, voxelSize: number` positional parameters — it becomes `(memFs, index, scene, createDevice, onPhase?, onExtract?)`. `PortalUploadMeta` gains `radius: number` and `voxelSize: number`.

This task has no unit test of its own — it is a pure type/plumbing change whose behaviour is covered by Task 4's server test and the manual E2E. The gate is a clean `tsc`.

- [ ] **Step 1: Extend `ExperienceSettings` and `ViewerExportSettings`**

In `src/splat-serialize.ts`, at line ~148 add the two arrays immediately after `portalEnvironments`:

```ts
    portalEnvironments?: ('indoor' | 'outdoor')[],
    portalRadii?: number[],
    portalVoxelSizes?: number[],
```

At line ~160, extend the `portalScenes` entry type:

```ts
    portalScenes?: { splat: Splat; url: string; collisionUrl: string | null; environment: 'indoor' | 'outdoor'; radius: number; voxelSize: number; seed: [number, number, number] }[];
```

- [ ] **Step 2: Extend `ExtraPortalScene` in the export core**

In `src/splat-export-core.ts` at line ~916:

```ts
type ExtraPortalScene = {
    loadDataTable: () => Promise<DataTable>;
    streaming: boolean;
    collisionUrl: string | null;
    environment: 'indoor' | 'outdoor';
    radius: number;
    voxelSize: number;
    seed: [number, number, number];
};
```

Keep the existing property order for the fields that are already there; only add the two.

- [ ] **Step 3: Make `writePortalScene` read the values off the scene**

In `src/splat-export-core.ts` at line ~654, delete the two positional parameters:

```ts
const writePortalScene = async (
    memFs: MemoryFileSystem,
    index: number,
    scene: ExtraPortalScene,
    createDevice: DeviceCreator,
    onPhase?: (info: PhaseInfo, counted: boolean) => void,
    onExtract?: () => void
): Promise<number[]> => {
```

and inside, change the `writeCollisionVoxel` call to source them from `scene`:

```ts
        await writeCollisionVoxel(sub, dataTable, fakeSettings, createDevice, {
            environment: scene.environment,
            radius: scene.radius,
            voxelSize: scene.voxelSize
        });
```

- [ ] **Step 4: Update the streaming call site**

At `src/splat-export-core.ts` line ~835, delete these two lines:

```ts
        const collRadius = collision?.radius ?? 50;
        const collVoxelSize = collision?.voxelSize ?? 0.05;
```

and drop the two arguments from the call (line ~846):

```ts
            extraLodCounts.push(await writePortalScene(memFs, i + 1, extraScenes[i], createDevice, onSceneProgress, () => fireExtracting(events, i + 2, total, 'Exporting streaming viewer', 'export.progress.exporting-streaming')));
```

Also update the comment above the block: it currently says "uses the shared collision radius / voxel size (defaulting when collision is off...)". Replace that clause with "each scene carries its own collision radius / voxel size; writePortalScene guards on collisionUrl."

- [ ] **Step 5: Update the package call site**

At `src/splat-export-core.ts` line ~1012, delete the same two `collRadius` / `collVoxelSize` locals and drop the arguments:

```ts
                    extraCounts.push(await writePortalScene(
                        memFs, index, extraScenes![i], createDevice,
                        undefined, () => fireExtracting(events, index + 1, total, 'Exporting HTML', 'export.progress.exporting-html')
                    ));
```

- [ ] **Step 6: Pass the values through `serializeViewer`**

In `src/splat-serialize.ts` at line ~1490, add the two fields to the descriptor:

```ts
        options.portalScenes?.map(entry => ({
            collisionUrl: entry.collisionUrl,
            environment: entry.environment,
            radius: entry.radius,
            voxelSize: entry.voxelSize,
            seed: entry.seed,
            streaming: options.streaming ?? false,
            loadDataTable: () => Promise.resolve(extractDataTable([entry.splat], serializeSettings))
        })) ?? [] :
```

- [ ] **Step 7: Carry them in the upload metadata**

In `src/portal-upload.ts`, add to the `PortalUploadMeta` type:

```ts
    radius: number;
    voxelSize: number;
```

and to the push inside the extras loop:

```ts
        portalExtras.push({ seed: ex.seed, environment: ex.environment, radius: ex.radius, voxelSize: ex.voxelSize, collisionUrl: ex.collisionUrl, streaming });
```

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit > /tmp/tsc.txt 2>&1; cat /tmp/tsc.txt`

Expected: errors ONLY in `src/file-handler.ts` and `src/ui/*.ts` (they do not yet supply `radii` / `voxelSizes` / `radius` / `voxelSize`). Those are fixed in Tasks 6–9. No errors in `portal-export.ts`, `splat-export-core.ts`, `splat-serialize.ts` or `portal-upload.ts`.

- [ ] **Step 9: Lint and commit**

```bash
npm run lint
git add src/splat-serialize.ts src/splat-export-core.ts src/portal-upload.ts
git commit -m "feat(collision): per-scene radius and voxel size in the serializer and export core"
```

---

### Task 3: Parse a collision entry name into a scene index

**Files:**
- Create: `src/collision-size-report.ts`
- Test: `test/collision-size-report.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `collisionSceneIndex(entryName: string): number | null` — `0` for `index.voxel.bin`, `N` for `scenes/N/scene.voxel.bin`, `null` for anything else.
  - `formatBytes(bytes: number): string` — e.g. `1536` → `"1.5 KB"`, `39375284` → `"37.6 MB"`.
  - `COLLISION_OVERSIZE_BYTES = 15 * 1024 * 1024`

A separate tiny module rather than logic buried in a dialog, because three call sites (local export, server export, S3 publish) all need the same parser and it must be unit-testable without PCUI.

- [ ] **Step 1: Write the failing tests**

Create `test/collision-size-report.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import { collisionSceneIndex, formatBytes, COLLISION_OVERSIZE_BYTES } from '../src/collision-size-report';

describe('collisionSceneIndex', () => {
    it('maps the primary scene binary to index 0', () => {
        expect(collisionSceneIndex('index.voxel.bin')).toBe(0);
    });

    it('maps a namespaced extra scene binary to its index', () => {
        expect(collisionSceneIndex('scenes/1/scene.voxel.bin')).toBe(1);
        expect(collisionSceneIndex('scenes/12/scene.voxel.bin')).toBe(12);
    });

    it('ignores the json sidecar, other files and near-misses', () => {
        expect(collisionSceneIndex('index.voxel.json')).toBeNull();
        expect(collisionSceneIndex('scenes/1/scene.voxel.json')).toBeNull();
        expect(collisionSceneIndex('index.html')).toBeNull();
        expect(collisionSceneIndex('scenes/1/lod-meta.json')).toBeNull();
        expect(collisionSceneIndex('a/index.voxel.bin')).toBeNull();
        expect(collisionSceneIndex('scenes/x/scene.voxel.bin')).toBeNull();
    });
});

describe('formatBytes', () => {
    it('formats across units with one decimal', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(1536)).toBe('1.5 KB');
        expect(formatBytes(3682632)).toBe('3.5 MB');
        expect(formatBytes(39375284)).toBe('37.6 MB');
    });
});

describe('COLLISION_OVERSIZE_BYTES', () => {
    it('is 15 MB', () => {
        expect(COLLISION_OVERSIZE_BYTES).toBe(15 * 1024 * 1024);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/collision-size-report.test.ts > /tmp/csr.txt 2>&1; cat /tmp/csr.txt`

Expected: FAIL — cannot resolve `../src/collision-size-report`.

- [ ] **Step 3: Write the implementation**

Create `src/collision-size-report.ts`:

```ts
// Maps a written export entry name to the scene it belongs to, so the
// post-export summary can report each scene's collision binary size.
//
// The export core already broadcasts every ZIP entry as
// `events.fire('exportFile', { name, bytes })` (splat-export-core.ts, both ZIP
// loops); this module is the shared filter over that stream. Deliberately free
// of playcanvas / PCUI imports so it can be unit-tested in isolation.

// Primary scene writes `index.voxel.bin`; extras are namespaced under
// `scenes/<N>/` and renamed to `scene.voxel.bin` by writePortalScene.
const COLLISION_ENTRY = /^(?:scenes\/(\d+)\/scene|index)\.voxel\.bin$/;

const collisionSceneIndex = (entryName: string): number | null => {
    const m = COLLISION_ENTRY.exec(entryName);
    if (!m) return null;
    return m[1] === undefined ? 0 : parseInt(m[1], 10);
};

// Raw size above which the summary flags a scene as expensive. ~4 MB over the
// wire once the publish path's gzip (server/src/s3.ts) has been applied.
const COLLISION_OVERSIZE_BYTES = 15 * 1024 * 1024;

const UNITS = ['B', 'KB', 'MB', 'GB'];

const formatBytes = (bytes: number): string => {
    let v = bytes;
    let u = 0;
    while (v >= 1024 && u < UNITS.length - 1) {
        v /= 1024;
        u++;
    }
    return u === 0 ? `${v} B` : `${v.toFixed(1)} ${UNITS[u]}`;
};

export { collisionSceneIndex, formatBytes, COLLISION_OVERSIZE_BYTES };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/collision-size-report.test.ts > /tmp/csr.txt 2>&1; cat /tmp/csr.txt`

Expected: PASS, 3 suites.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/collision-size-report.ts test/collision-size-report.test.ts
git commit -m "feat(collision): shared parser for collision entry sizes"
```

---

### Task 4: Server — rebuild scenes with per-scene values, emit size events

**Files:**
- Modify: `server/src/progress.ts` (the `ProgressEvent` progress variant)
- Modify: `server/src/run-export.ts:21-23` (option types), `:150-162` (the `exportFile` listener), `:185-205` (`buildExtraScenes`)
- Test: `server/test/portal-extras.test.ts`, `server/test/run-export.test.ts`

**Interfaces:**
- Consumes: `ExtraPortalScene.radius` / `.voxelSize` (Task 2); `collisionSceneIndex` (Task 3).
- Produces: `ProgressEvent` progress variant gains `collision?: { index: number; bytes: number }`. `RunExportOptions.portalExtras[]` gains `radius: number` and `voxelSize: number`.

Server tests run from `server/`. Sync note: the server imports the export core from `dist-shared/`, so run `npm run build` in `server/` (which runs `build-shared` first) before any GPU test.

- [ ] **Step 1: Write the failing tests**

Open `server/test/portal-extras.test.ts` first and read what it currently imports and calls — the descriptor-building logic may be inline in `runExport` rather than exported. If it is inline, extract just the `metas.map(...)` body from `buildExtraScenes` into an exported pure function `buildExtraSceneDescriptors(metas, loadTable)` and test that; leave the surrounding `runExport` structure alone. Name the test helper to match whatever you export.

Append a test asserting the two values survive into the built `ExtraPortalScene`, using that file's existing fixture shape plus `radius` / `voxelSize`:

```ts
it('carries per-scene radius and voxelSize into the extra scene descriptors', () => {
    const scenes = buildExtraScenesFrom([
        { seed: [0, 0, 0], environment: 'indoor', collisionUrl: 'scenes/1/scene.voxel.json', streaming: true, radius: 200, voxelSize: 0.2 },
        { seed: [1, 0, 0], environment: 'outdoor', collisionUrl: 'scenes/2/scene.voxel.json', streaming: true, radius: 75, voxelSize: 0.1 }
    ]);
    expect(scenes.map(s => s.radius)).toEqual([200, 75]);
    expect(scenes.map(s => s.voxelSize)).toEqual([0.2, 0.1]);
});
```

If `buildExtraScenes` is not currently exported/testable in isolation, export the mapping as a small pure helper from `run-export.ts` and test that; do NOT restructure the surrounding function.

In `server/test/run-export.test.ts`, append:

```ts
it('emits a collision progress event for each collision binary written', () => {
    const emitted: any[] = [];
    const sink = { emit: (e: any) => emitted.push(e) };
    const handler = makeExportFileHandler(sink);   // the listener extracted in Step 3

    handler({ name: 'index.voxel.bin', bytes: 3682632 });
    handler({ name: 'scenes/1/scene.voxel.bin', bytes: 39375284 });
    handler({ name: 'index.html', bytes: 1234 });

    expect(emitted.filter(e => e.collision)).toEqual([
        { kind: 'progress', collision: { index: 0, bytes: 3682632 } },
        { kind: 'progress', collision: { index: 1, bytes: 39375284 } }
    ]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from `server/`: `npm test > /tmp/srv.txt 2>&1; cat /tmp/srv.txt`

Expected: FAIL on the two new tests.

- [ ] **Step 3: Extend the progress event type**

In `server/src/progress.ts`, the progress variant becomes:

```ts
    | { kind: 'progress'; message?: string; value?: number; loc?: ProgressLoc; collision?: { index: number; bytes: number } }
```

Leave the surrounding comment about `value` being 0..100 in place.

- [ ] **Step 4: Extend the options type and emit from the existing listener**

In `server/src/run-export.ts` line ~23:

```ts
    portalExtras?: { seed: [number, number, number]; environment: 'indoor' | 'outdoor'; radius: number; voxelSize: number; collisionUrl: string | null; streaming: boolean }[];
```

Import the parser at the top of the file, matching the file's existing import style for shared code:

```ts
import { collisionSceneIndex } from '../../dist-shared/collision-size-report.js';
```

> If `dist-shared` does not include this module, add `src/collision-size-report.ts` to the entry list in `scripts/build-shared.mjs` and rebuild. Verify with `ls dist-shared/collision-size-report.js` before continuing.

Then extend the **existing** `exportFile` listener at line ~150 — do not add a second listener. Keep every existing console-summary line untouched; only add the emit:

```ts
    events.on('exportFile', ({ name, bytes }: { name: string; bytes: number }) => {
        // Report collision binary sizes to the client so the export summary can
        // show them. Only the ZIP loops fire exportFile, and collision is
        // ZIP-only, so this covers every case that writes a voxel.
        const sceneIndex = collisionSceneIndex(name);
        if (sceneIndex !== null) {
            sink.emit({ kind: 'progress', collision: { index: sceneIndex, bytes } });
        }
        const m = /^(\d+_\d+)\//.exec(name);
        ...unchanged...
    });
```

Use whatever the surrounding code already calls the progress sink in this scope; if the sink is not in scope at the listener, extract the listener body into an exported `makeExportFileHandler(sink)` factory and register it — that is also what the Step 1 test imports.

- [ ] **Step 5: Pass the values into the scene descriptors**

In `buildExtraScenes` (line ~185), add to the returned object next to `environment`:

```ts
            environment: meta.environment,
            radius: meta.radius,
            voxelSize: meta.voxelSize,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run from `server/`: `npm test > /tmp/srv.txt 2>&1; cat /tmp/srv.txt`

Expected: PASS. **`parity-compressed.test.ts` must still pass** — if it does not, the single-scene path has been disturbed and you must stop and re-read the Global Constraints.

- [ ] **Step 7: Commit**

```bash
npm run lint
git add server/src/progress.ts server/src/run-export.ts server/test/ scripts/build-shared.mjs
git commit -m "feat(collision): per-scene voxel params and size reporting on the export server"
```

---

### Task 5: Shared per-scene collision UI module

**Files:**
- Create: `src/ui/collision-params.ts`
- Modify: `src/ui/scss/export-popup.scss:51-96`

**Interfaces:**
- Consumes: `Events`, `buildPortalBundle` from `../portal-export`, `i18n` from `./localization`.
- Produces:

```ts
type SceneCollision = { environment: 'indoor' | 'outdoor'; radius: number; voxelSize: number };

class PerSceneCollisionPanel extends Container {
    // rebuild the cards from the current portal bundle; hides itself when there
    // are no portals. `streaming` mirrors the dialog's streaming toggle.
    rebuild(streaming: boolean): void;
    // values for scene `index` (0 = start scene); defaults when unknown
    valuesAt(index: number): SceneCollision;
    // number of scenes currently rendered (0 when hidden)
    sceneCount(): number;
    // clear all remembered choices, for a fresh dialog open
    reset(): void;
}
```

There is no derivation, latching or auto-update anywhere in this class — the spec rejected the adaptive default. It is state plus presentation only.

- [ ] **Step 1: Create the module**

Create `src/ui/collision-params.ts`:

```ts
import { Button, Container, Label, SelectInput, SliderInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { i18n } from './localization';
import { buildPortalBundle } from '../portal-export';

type SceneCollision = { environment: 'indoor' | 'outdoor'; radius: number; voxelSize: number };

const defaults = (): SceneCollision => ({ environment: 'indoor', radius: 50, voxelSize: 0.05 });

// Per-scene collision controls for a portal export, shared by the export popup
// and the S3 publish dialog (which do not otherwise share collision UI).
//
// Values are keyed by scene UID so a choice survives a rebuild (the Streaming
// and Collision toggles both rebuild the rows); the index -> uid map is what
// assembly uses, because the exported arrays are index-aligned with
// portalEnvironments.
class PerSceneCollisionPanel extends Container {
    rebuild: (streaming: boolean) => void;
    valuesAt: (index: number) => SceneCollision;
    sceneCount: () => number;
    reset: () => void;

    constructor(events: Events) {
        super({ class: 'per-scene-collision', flex: true, flexDirection: 'column' });

        const values = new Map<number, SceneCollision>();   // uid -> values
        const order: number[] = [];                          // index -> uid

        const card = (uid: number, index: number, name: string) => {
            const v = values.get(uid) ?? defaults();
            values.set(uid, v);

            const wrap = new Container({ class: 'scene-card', flex: true, flexDirection: 'column' });

            const head = new Container({ class: 'scene-head' });
            const caret = new Label({ class: 'caret', text: '▸' });
            const title = new Label({ class: 'scene-name', text: name });
            title.dom.title = name;                          // tooltip fallback when ellipsised
            const summary = new Label({ class: 'scene-summary' });
            head.append(caret);
            head.append(title);
            head.append(summary);

            const body = new Container({ class: 'scene-body', flex: true, flexDirection: 'column', hidden: true });

            const envSelect = new SelectInput({
                class: 'select',
                defaultValue: v.environment,
                options: [
                    { v: 'indoor', t: i18n.t('popup.export.environment.indoor') },
                    { v: 'outdoor', t: i18n.t('popup.export.environment.outdoor') }
                ]
            });
            const radiusSlider = new SliderInput({ class: 'slider', min: 5, max: 500, precision: 0, value: v.radius });
            const voxelSlider = new SliderInput({ class: 'slider', min: 0.02, max: 0.5, precision: 2, value: v.voxelSize });

            const row = (labelKey: string, widget: any) => {
                const c = new Container({ class: 'row' });
                c.append(new Label({ class: 'label', text: i18n.t(labelKey) }));
                c.append(widget);
                return c;
            };
            body.append(row('popup.export.environment', envSelect));
            body.append(row('popup.export.collision-radius', radiusSlider));
            body.append(row('popup.export.voxel-size', voxelSlider));

            const refreshSummary = () => {
                const envText = i18n.t(v.environment === 'indoor' ? 'popup.export.environment.indoor' : 'popup.export.environment.outdoor');
                summary.text = `${envText} · ${v.radius} · ${v.voxelSize}`;
            };
            refreshSummary();

            envSelect.on('change', () => {
                v.environment = envSelect.value as 'indoor' | 'outdoor';
                refreshSummary();
            });
            radiusSlider.on('change', () => {
                v.radius = radiusSlider.value;
                refreshSummary();
            });
            voxelSlider.on('change', () => {
                v.voxelSize = voxelSlider.value;
                refreshSummary();
            });

            head.dom.addEventListener('click', () => {
                body.hidden = !body.hidden;
                caret.text = body.hidden ? '▸' : '▾';
            });

            wrap.append(head);
            wrap.append(body);
            return wrap;
        };

        this.rebuild = (streaming: boolean) => {
            this.clear();
            order.length = 0;

            const portalsRaw = events.invoke('portals.export') ?? [];
            const startUid = events.invoke('portals.startSplat') ?? null;
            const allSplats = events.invoke('scene.allSplats') ?? [];
            const availableUids = allSplats.map((s: any) => s.uid);
            const preferredStartUid = events.invoke('selection')?.uid ?? null;
            const bundle = (events.invoke('portals.count') ?? 0) > 0 ?
                buildPortalBundle({ portals: portalsRaw, startUid, availableUids, streaming, collision: true, preferredStartUid }) :
                null;
            if (!bundle) {
                this.hidden = true;
                return;
            }
            this.hidden = false;
            bundle.sceneUids.forEach((uid, index) => {
                const splat = allSplats.find((s: any) => s.uid === uid);
                const name = splat ? `${uid}: ${(splat.name ?? splat.asset?.file?.filename ?? uid)}` : `Scene ${index}`;
                order.push(uid);
                this.append(card(uid, index, name));
            });
        };

        this.valuesAt = (index: number) => {
            const uid = order[index];
            return (uid !== undefined && values.get(uid)) || defaults();
        };

        this.sceneCount = () => order.length;

        this.reset = () => {
            values.clear();
            order.length = 0;
            this.clear();
        };
    }
}

export { PerSceneCollisionPanel, type SceneCollision };
```

Note `Button` is imported but unused in this listing — remove it from the import if you do not add a button, or lint will flag it.

- [ ] **Step 2: Style the cards**

In `src/ui/scss/export-popup.scss`, replace the `.per-scene-env` block (lines 51-65) with:

```scss
            // per-scene collision cards (portals): a vertical stack of
            // collapsible cards. Must NOT inherit `.row`'s fixed 24px height,
            // or the stacked scene rows collapse into a single crushed strip.
            .per-scene-collision {
                padding-bottom: 8px;

                &:not(.pcui-hidden) {
                    display: flex;
                    flex-direction: column;
                }

                .scene-card {
                    border-top: 1px solid $bcg-darker;
                    padding: 4px 0;
                }

                .scene-head {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    height: 24px;
                    line-height: 24px;
                    cursor: pointer;

                    .caret {
                        flex: 0 0 auto;
                        margin: 0;
                        color: $text-secondary;
                    }

                    // the name owns the full dialog width here rather than
                    // sharing a 180px label column with a control, which is
                    // what used to ellipsise it after ~16 characters
                    .scene-name {
                        flex: 1 1 auto;
                        margin: 0;
                        overflow: hidden;
                        white-space: nowrap;
                        text-overflow: ellipsis;
                    }

                    .scene-summary {
                        flex: 0 0 auto;
                        margin: 0;
                        color: $text-secondary;
                    }
                }

                .scene-body {
                    padding: 4px 0 0 12px;
                }

                .row:last-child {
                    padding-bottom: 0;
                }
            }
```

Then make `#content` scrollable — three controls per scene across several scenes would otherwise push the dialog past the viewport, and `#dialog` is `overflow: hidden`. Add to the `#content` block (line ~47):

```scss
        #content {
            min-height: 60px;
            max-height: calc(100vh - 200px);
            overflow-y: auto;
            padding: 12px;
```

Verify `$text-secondary` and `$bcg-darker` exist in `src/ui/scss/colors.scss` before using them; substitute the nearest existing variables if not.

- [ ] **Step 3: Build and confirm no TypeScript errors in the new file**

Run: `npm run build > /tmp/build.txt 2>&1; grep -c "plugin typescript" /tmp/build.txt`

Expected: the count is `0`. (A nonzero exit code alone means nothing here — Rollup downgrades TS errors to warnings.)

- [ ] **Step 4: Lint and commit**

```bash
npm run lint
git add src/ui/collision-params.ts src/ui/scss/export-popup.scss
git commit -m "feat(collision): shared per-scene collision panel with collapsible scene cards"
```

---

### Task 6: Mount the panel in the export popup

**Files:**
- Modify: `src/ui/export-popup.ts:324-364` (remove), `:487` and `:611-619` (row lists), `:554-564` (visibility), `:639-645` (reset), `:820-846` (assembly)

**Interfaces:**
- Consumes: `PerSceneCollisionPanel` (Task 5).
- Produces: the popup's assembled `experienceSettings` now includes `portalRadii` and `portalVoxelSizes`.

- [ ] **Step 1: Replace the per-scene environment block**

Delete `perSceneEnvRow`, `perSceneEnvSelects`, `perSceneEnvValues` and `rebuildPerSceneEnv` (lines 324-364) and put in their place:

```ts
        // viewer: per-scene collision params (portals only). One collapsible card
        // per portal-referenced scene; falls back to the single environment /
        // radius / voxel rows below when there are no portals.
        const perSceneCollision = new PerSceneCollisionPanel(events);
```

Add the import beside the other local UI imports, following the file's existing import style:

```ts
import { PerSceneCollisionPanel } from './collision-params';
```

- [ ] **Step 2: Update every reference to the removed names**

- line ~487: `content.append(perSceneEnvRow)` → `content.append(perSceneCollision)`
- lines ~611 and ~619: replace `perSceneEnvRow` with `perSceneCollision` in both the `allRows` array and the `viewer` entry of `activeRows`.

- [ ] **Step 3: Update visibility, and hide the shared rows when cards are shown**

Replace `updateCollisionVisibility` (lines 554-564) with:

```ts
        const updateCollisionVisibility = () => {
            const isZipViewer = currentExportType === 'viewer' && viewerTypeSelect.value === 'zip';
            collisionRow.hidden = !isZipViewer;
            const showSub = !isZipViewer || !collisionToggle.value;
            perSceneCollision.rebuild(streamingToggle.value);
            const hasCards = !perSceneCollision.hidden && perSceneCollision.sceneCount() > 0;
            // with portals, the three shared rows are replaced by the per-scene cards
            environmentRow.hidden = showSub || hasCards;
            radiusRow.hidden = showSub || hasCards;
            voxelSizeRow.hidden = showSub || hasCards;
            perSceneCollision.hidden = perSceneCollision.hidden || showSub;
        };
```

Note this is a real behaviour change from today: `radiusRow` and `voxelSizeRow` were previously shown *alongside* the per-scene environment selectors. They are now hidden whenever cards are present, because the cards own those values.

- [ ] **Step 4: Update the streaming handler and reset**

Line ~599: `streamingToggle.on('change', () => { rebuildPerSceneEnv(); });` becomes:

```ts
        streamingToggle.on('change', () => {
            updateCollisionVisibility();
        });
```

In `reset` (lines ~639-645) replace `perSceneEnvValues.clear();` with `perSceneCollision.reset();`, keeping the surrounding lines (`collisionToggle.value = true;`, `environmentSelect.value = 'indoor';`, `radiusSlider.value = 50;`, `voxelSizeSlider.value = 0.05;`, `updateCollisionVisibility();`) exactly as they are.

- [ ] **Step 5: Assemble the arrays**

At line ~827, replace the `portalEnvironments` line with three lines:

```ts
                        portalEnvironments: bundle.sceneUids.map((_, i) => perSceneCollision.valuesAt(i).environment),
                        portalRadii: bundle.sceneUids.map((_, i) => perSceneCollision.valuesAt(i).radius),
                        portalVoxelSizes: bundle.sceneUids.map((_, i) => perSceneCollision.valuesAt(i).voxelSize)
```

At line ~845, source the scene-0 values from the panel when there is a bundle:

```ts
                        collision: (viewerTypeSelect.value === 'zip' && collisionToggle.value) ? (bundle ? {
                            environment: perSceneCollision.valuesAt(0).environment,
                            radius: perSceneCollision.valuesAt(0).radius,
                            voxelSize: perSceneCollision.valuesAt(0).voxelSize
                        } : {
                            environment: environmentSelect.value as 'indoor' | 'outdoor',
                            radius: radiusSlider.value,
                            voxelSize: voxelSizeSlider.value
                        }) : undefined,
```

Keep the existing explanatory comment above this line; update its wording from "chosen via its per-scene selector" to "chosen via its per-scene card".

- [ ] **Step 6: Build and check**

Run: `npm run build > /tmp/build.txt 2>&1; grep -c "plugin typescript" /tmp/build.txt`

Expected: `0`.

- [ ] **Step 7: Lint and commit**

```bash
npm run lint
git add src/ui/export-popup.ts
git commit -m "feat(collision): per-scene collision cards in the export popup"
```

---

### Task 7: Mount the panel in the S3 publish dialog

**Files:**
- Modify: `src/ui/s3-publish-dialog.ts:95-137` (remove), `:139-142` (append), `:160-171` (visibility), `:190-197` (reset), `:254-260` and `:275` (assembly)

**Interfaces:**
- Consumes: `PerSceneCollisionPanel` (Task 5).
- Produces: the publish options' `experienceSettings` now includes `portalRadii` and `portalVoxelSizes`.

The same edits as Task 6, against this file's own names. Repeated in full because the two dialogs do not share this code.

- [ ] **Step 1: Replace the per-scene environment block**

Delete `perSceneEnvRow`, `perSceneEnvSelects`, `perSceneEnvValues` and `rebuildPerSceneEnv` (lines 95-137), replacing them with:

```ts
        // per-scene collision params (portals only); one collapsible card per
        // portal-referenced scene, replacing the shared environment/radius/voxel rows.
        const perSceneCollision = new PerSceneCollisionPanel(events);
```

Add the import beside the other local UI imports:

```ts
import { PerSceneCollisionPanel } from './collision-params';
```

- [ ] **Step 2: Update the append**

Line ~140: `content.append(perSceneEnvRow);` → `content.append(perSceneCollision);`

- [ ] **Step 3: Update visibility**

Replace `updateCollisionVisibility` (lines 160-169) with:

```ts
        const updateCollisionVisibility = () => {
            const hide = !collision.value;
            perSceneCollision.rebuild(streaming.value);
            const hasCards = !perSceneCollision.hidden && perSceneCollision.sceneCount() > 0;
            // with portals, the shared rows are replaced by the per-scene cards
            environmentRow.c.hidden = hide || hasCards;
            radiusRow.c.hidden = hide || hasCards;
            voxelRow.c.hidden = hide || hasCards;
            perSceneCollision.hidden = perSceneCollision.hidden || hide;
        };
```

and change line ~171 from `streaming.on('change', rebuildPerSceneEnv);` to:

```ts
        streaming.on('change', updateCollisionVisibility);
```

- [ ] **Step 4: Update reset**

In `show` (line ~194) replace `perSceneEnvValues.clear();` with `perSceneCollision.reset();`, keeping the surrounding reset lines unchanged.

- [ ] **Step 5: Assemble the arrays**

At line ~259, replace the `portalEnvironments` line with:

```ts
                        portalEnvironments: bundle.sceneUids.map((_, i) => perSceneCollision.valuesAt(i).environment),
                        portalRadii: bundle.sceneUids.map((_, i) => perSceneCollision.valuesAt(i).radius),
                        portalVoxelSizes: bundle.sceneUids.map((_, i) => perSceneCollision.valuesAt(i).voxelSize)
```

At line ~275:

```ts
                        collision: collision.value ? (bundle ? {
                            environment: perSceneCollision.valuesAt(0).environment,
                            radius: perSceneCollision.valuesAt(0).radius,
                            voxelSize: perSceneCollision.valuesAt(0).voxelSize
                        } : {
                            environment: environment.value as 'indoor' | 'outdoor',
                            radius: radius.value,
                            voxelSize: voxelSize.value
                        }) : undefined,
```

Keep the existing comment above it, updating "per-scene selector" to "per-scene card".

- [ ] **Step 6: Build and check**

Run: `npm run build > /tmp/build.txt 2>&1; grep -c "plugin typescript" /tmp/build.txt`

Expected: `0`.

- [ ] **Step 7: Lint and commit**

```bash
npm run lint
git add src/ui/s3-publish-dialog.ts
git commit -m "feat(collision): per-scene collision cards in the S3 publish dialog"
```

---

### Task 8: Export summary dialog

**Files:**
- Create: `src/ui/export-summary-dialog.ts`, `src/ui/scss/export-summary-dialog.scss`
- Modify: `src/ui/scss/style.scss`, `src/ui/editor.ts:174` (instantiation area)
- Modify: all nine `static/locales/*.json`

**Interfaces:**
- Consumes: `formatBytes`, `COLLISION_OVERSIZE_BYTES`, `CollisionSize` (Task 3).
- Produces: an `events` function

```ts
events.invoke('showExportSummary', {
    header: string,
    message?: string,
    link?: string,
    sizes: { sceneIndex: number; name: string; bytes: number }[]
}): Promise<void>
```

A dedicated dialog rather than `showPopup`, because that popup renders `message` into a single PCUI `Label` (single-line with ellipsis by default) and widening it would mean editing upstream-owned `src/ui/popup.ts` / `popup.scss`.

- [ ] **Step 1: Add the four locale keys to all nine files**

In each of `static/locales/*.json`, add under the existing `popup.export.*` group (match each file's existing nesting and key style exactly — check whether keys are flat dotted strings or nested objects before editing):

```
"popup.export.summary.header": "Export complete",
"popup.export.summary.collision": "Collision",
"popup.export.summary.scene": "scene {{index}}",
"popup.export.summary.oversize": "Scenes marked ⚠ exceed 15 MB. Increase their voxel size to reduce it."
```

Translate the values for each locale; leave the keys identical. Run `npx vitest run test/localization-plurals.test.ts > /tmp/loc.txt 2>&1; cat /tmp/loc.txt` afterwards — it guards locale-file consistency.

- [ ] **Step 2: Create the dialog**

Create `src/ui/export-summary-dialog.ts`:

```ts
import { Button, Container, Label } from '@playcanvas/pcui';

import { COLLISION_OVERSIZE_BYTES, formatBytes } from '../collision-size-report';
import { Events } from '../events';
import { i18n } from './localization';

type ExportSummary = {
    header: string;
    message?: string;
    link?: string;
    sizes: { sceneIndex: number; name: string; bytes: number }[];
};

// Post-export report of each scene's collision binary size. Shown after an
// export or publish that had collision enabled, so the operator can tune the
// per-scene voxel size against the real number rather than an estimate.
class ExportSummaryDialog extends Container {
    show: (summary: ExportSummary) => Promise<void>;
    hide: () => void;
    destroy: () => void;

    constructor(events: Events, args = {}) {
        super({ id: 'export-summary-dialog', hidden: true, tabIndex: -1, ...args });

        const dialog = new Container({ id: 'dialog' });
        const header = new Container({ id: 'header' });
        const headerLabel = new Label({ id: 'header', text: '' });
        header.append(headerLabel);

        const content = new Container({ id: 'content' });
        const message = new Label({ class: 'summary-message', hidden: true });
        const link = new Label({ class: 'summary-link', hidden: true });
        const sectionLabel = new Label({ class: 'summary-section', text: i18n.t('popup.export.summary.collision') });
        const list = new Container({ class: 'summary-list', flex: true, flexDirection: 'column' });
        const oversizeNote = new Label({ class: 'summary-oversize', text: i18n.t('popup.export.summary.oversize'), hidden: true });
        content.append(message);
        content.append(link);
        content.append(sectionLabel);
        content.append(list);
        content.append(oversizeNote);

        const footer = new Container({ id: 'footer' });
        const okButton = new Button({ class: 'button', text: i18n.t('popup.ok') });
        footer.append(okButton);

        dialog.append(header);
        dialog.append(content);
        dialog.append(footer);
        this.append(dialog);

        let onOk: () => void;
        okButton.on('click', () => onOk());

        const keydown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' || e.key === 'Enter') onOk();
            else e.stopPropagation();
        };

        this.show = (summary: ExportSummary) => {
            headerLabel.text = summary.header;

            message.hidden = !summary.message;
            if (summary.message) message.text = summary.message;

            link.hidden = !summary.link;
            if (summary.link) {
                link.text = summary.link;
                link.dom.onclick = () => window.open(summary.link, '_blank', 'noopener');
            }

            list.clear();
            let anyOversize = false;
            for (const s of summary.sizes) {
                const row = new Container({ class: 'summary-row' });
                row.append(new Label({ class: 'summary-scene', text: i18n.t('popup.export.summary.scene', { index: s.sceneIndex }) }));
                const nameLabel = new Label({ class: 'summary-name', text: s.name });
                nameLabel.dom.title = s.name;
                row.append(nameLabel);
                row.append(new Label({ class: 'summary-bytes', text: formatBytes(s.bytes) }));
                if (s.bytes > COLLISION_OVERSIZE_BYTES) {
                    anyOversize = true;
                    row.append(new Label({ class: 'summary-warn', text: '⚠' }));
                }
                list.append(row);
            }
            oversizeNote.hidden = !anyOversize;

            this.hidden = false;
            this.dom.addEventListener('keydown', keydown);
            this.dom.focus();

            return new Promise<void>((resolve) => {
                onOk = () => resolve();
            }).finally(() => {
                this.dom.removeEventListener('keydown', keydown);
                this.hide();
            });
        };

        this.hide = () => {
            this.hidden = true;
        };

        this.destroy = () => {
            this.hide();
            super.destroy();
        };

        events.function('showExportSummary', (summary: ExportSummary) => {
            return this.show(summary);
        });
    }
}

export { ExportSummaryDialog, type ExportSummary };
```

- [ ] **Step 3: Create the stylesheet**

Create `src/ui/scss/export-summary-dialog.scss`. Reuse the export popup's dialog chrome by extending its selector list rather than duplicating it — open `export-popup.scss` and add `#export-summary-dialog` to the top-level selector on line 3 so it inherits the overlay, `#dialog`, `#header` and `#footer` styling:

```scss
#export-popup, #s3-publish-dialog, #export-summary-dialog {
```

Then in the new file, only the parts unique to this dialog:

```scss
@use 'colors.scss' as *;

#export-summary-dialog {
    #content {
        .summary-message, .summary-link, .summary-oversize {
            display: block;
            margin: 0 0 8px;
            white-space: normal;
            overflow: visible;
            text-overflow: clip;
        }

        .summary-link {
            color: $clr-icon-hilight;
            cursor: pointer;
        }

        .summary-section {
            display: block;
            margin: 4px 0;
            font-weight: bold;
        }

        .summary-row {
            display: flex;
            align-items: center;
            gap: 6px;
            height: 20px;
            line-height: 20px;

            .summary-scene {
                flex: 0 0 auto;
                margin: 0;
                color: $text-secondary;
            }

            .summary-name {
                flex: 1 1 auto;
                margin: 0;
                overflow: hidden;
                white-space: nowrap;
                text-overflow: ellipsis;
            }

            .summary-bytes {
                flex: 0 0 auto;
                margin: 0;
            }

            .summary-warn {
                flex: 0 0 auto;
                margin: 0;
                color: #e0a030;
            }
        }

        .summary-oversize {
            color: #e0a030;
            font-size: 11px;
        }
    }
}
```

- [ ] **Step 4: Register the stylesheet and the dialog**

In `src/ui/scss/style.scss`, add the import next to the other dialog imports, matching the file's existing ordering convention:

```scss
@use 'export-summary-dialog.scss';
```

In `src/ui/editor.ts`, beside the `S3PublishDialog` instantiation at line ~174, add:

```ts
        const exportSummaryDialog = new ExportSummaryDialog(events);
```

and append it to the same parent the other dialogs are appended to (read the surrounding lines and follow exactly what `s3PublishDialog` does — instantiation alone does not attach it to the DOM). Add the import beside the `S3PublishDialog` import.

- [ ] **Step 5: Build and check**

Run: `npm run build > /tmp/build.txt 2>&1; grep -c "plugin typescript" /tmp/build.txt`

Expected: `0`.

- [ ] **Step 6: Run the locale test**

Run: `npx vitest run test/localization-plurals.test.ts > /tmp/loc.txt 2>&1; cat /tmp/loc.txt`

Expected: PASS.

- [ ] **Step 7: Lint and commit**

```bash
npm run lint
git add src/ui/export-summary-dialog.ts src/ui/scss/export-summary-dialog.scss src/ui/scss/style.scss src/ui/scss/export-popup.scss src/ui/editor.ts static/locales/
git commit -m "feat(collision): export summary dialog reporting per-scene collision sizes"
```

---

### Task 9: Wire the local and server export paths

**Files:**
- Modify: `src/file-handler.ts:630-735` (server export), `:802-846` (local viewer export)
- Modify: `src/portal-upload.ts` (Step 6 — finishes it for both server paths)
- Modify: `src/export-server-client.ts` (`ServerProgress` type)

**Interfaces:**
- Consumes: `collisionSceneIndex`, `CollisionSize` (Task 3); `showExportSummary` (Task 8); `resolvePortalExtras` radii/voxelSizes args (Task 1).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Supply the new arrays to `resolvePortalExtras`**

In the `htmlViewer` / `packageViewer` case (line ~812), add to the args object next to `environments`:

```ts
                            environments: es.portalEnvironments ?? [],
                            radii: es.portalRadii ?? [],
                            voxelSizes: es.portalVoxelSizes ?? [],
```

and add the two fields to the mapped `portalScenes` entry (line ~836):

```ts
                                return {
                                    splat,
                                    url: es.portalScenes![ex.index] ?? '',
                                    collisionUrl: ex.collisionUrl,
                                    environment: ex.environment,
                                    radius: ex.radius,
                                    voxelSize: ex.voxelSize,
                                    seed: ex.seed
                                };
```

- [ ] **Step 2: Add a shared size collector helper in this file**

Near the top of `file-handler.ts`, after the imports, add:

```ts
// Collect per-scene collision binary sizes for the post-export summary. The
// export core already broadcasts every written ZIP entry as `exportFile`, so
// this only has to filter. Returns a detach function; always call it.
const collectCollisionSizes = (events: Events, out: Map<number, number>) => {
    const handler = ({ name, bytes }: { name: string; bytes: number }) => {
        const idx = collisionSceneIndex(name);
        if (idx !== null) out.set(idx, bytes);
    };
    events.on('exportFile', handler);
    return () => events.off('exportFile', handler);
};
```

Import `collisionSceneIndex` from `./collision-size-report` alongside the other local imports.

> Check the `Events` class in `src/events.ts` for the actual removal method name (`off` vs `unbind`) and use whichever exists.

- [ ] **Step 3: Add a shared summary presenter**

Also near the top of `file-handler.ts`:

```ts
// Show the collision summary if anything was collected. Scene names come from
// the bundle order the caller already resolved; index 0 is the start scene.
const showCollisionSummary = async (events: Events, sizes: Map<number, number>, sceneNames: string[], header: string, message?: string, link?: string) => {
    if (sizes.size === 0) return;
    const rows = [...sizes.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([sceneIndex, bytes]) => ({ sceneIndex, name: sceneNames[sceneIndex] ?? `#${sceneIndex}`, bytes }));
    await events.invoke('showExportSummary', { header, message, link, sizes: rows });
};
```

- [ ] **Step 4: Collect and show on the local export path**

Wrap the `serializeViewer` call (line ~843). Build `sceneNames` from the resolved bundle when there is one, otherwise a single entry for the primary splat:

```ts
                    const collisionSizes = new Map<number, number>();
                    const detach = collectCollisionSizes(events, collisionSizes);
                    try {
                        await serializeViewer(primarySplats, serializeSettings, { ...viewerExportSettings!, events, portalScenes }, fs);
                    } finally {
                        detach();
                    }
                    await showCollisionSummary(events, collisionSizes, sceneNames, i18n.t('popup.export.summary.header'));
                    break;
```

where `sceneNames` is built just above, in the same place `portalScenes` is resolved:

```ts
                    let sceneNames: string[] = [(primarySplats[0]?.name) ?? ''];
```

and inside the `if (resolved)` branch, after `primarySplats` is set:

```ts
                            sceneNames = resolved.bundle.sceneUids.map((uid) => byUid(uid)?.name ?? `#${uid}`);
```

- [ ] **Step 5: Collect and show on the server export path**

In `writeViaServer`, add a map before the `runServerExport` call and populate it from the progress callback (line ~711), which already receives every `ServerProgress`:

```ts
            const collisionSizes = new Map<number, number>();
            const result = await runServerExport(plyGz, wire, (p) => {
                if ((p as any).collision) {
                    const c = (p as any).collision as { index: number; bytes: number };
                    collisionSizes.set(c.index, c.bytes);
                }
                if (!useSpinner) {
                    events.fire('progressUpdate', { text: p.message, progress: p.value, loc: p.loc });
                }
            }, extraPlyGz, ...unchanged...);
```

> Check `ServerProgress` in `src/export-server-client.ts` and add `collision?: { index: number; bytes: number }` to it so the cast above is unnecessary; prefer the typed field over `as any` if the type is local.

Then, after the writer closes and before `return true`, show the summary. `buildPortalUpload` gains its `sceneNames: string[]` return field in **Step 6 below**, so this will not typecheck until that step lands — that is expected, and the build gate is Step 7:

```ts
            await writer.close();

            const sceneNames = upload?.sceneNames ?? [splats[0]?.name ?? ''];
            await showCollisionSummary(events, collisionSizes, sceneNames, i18n.t('popup.export.summary.header'));

            return true;
```

- [ ] **Step 6: Finish `buildPortalUpload` so both server paths have what they need**

`src/portal-upload.ts` feeds both the server export (this task) and S3 publish (Task 10), so both of its remaining changes land here.

Add the two arrays to its internal `resolvePortalExtras` call, next to `environments`:

```ts
        environments: es.portalEnvironments ?? [],
        radii: es.portalRadii ?? [],
        voxelSizes: es.portalVoxelSizes ?? [],
```

Add `sceneNames: string[]` to the return type and build it from the bundle it already resolved, using the `all` splat list it already holds:

```ts
    const sceneNames = resolved.bundle.sceneUids.map(uid => all.find(s => s.uid === uid)?.name ?? `#${uid}`);

    return { startSplat, extraPlyGz, portalExtras, sceneNames };
```

Update the function's return type annotation to match.

- [ ] **Step 7: Build and check**

Run: `npm run build > /tmp/build.txt 2>&1; grep -c "plugin typescript" /tmp/build.txt`

Expected: `0`.

- [ ] **Step 8: Run the full front-end test suite**

Run: `npx vitest run > /tmp/all.txt 2>&1; cat /tmp/all.txt`

Expected: all suites PASS.

- [ ] **Step 9: Lint and commit**

```bash
npm run lint
git add src/file-handler.ts src/export-server-client.ts src/portal-upload.ts
git commit -m "feat(collision): report per-scene collision sizes after local and server exports"
```

---

### Task 10: Wire the S3 publish path

**Files:**
- Modify: `src/s3-publish.ts:40-95`

**Interfaces:**
- Consumes: everything from Tasks 1, 3, 8, 9.
- Produces: nothing.

Publish is a **separate** file from the export path with its own progress callback and its own success popup — that popup carries the published `link`, which must not be lost. `src/portal-upload.ts` was already fully updated in Task 9 Step 6, so this task touches only `s3-publish.ts`.

- [ ] **Step 1: Collect sizes from the publish progress callback**

In `src/s3-publish.ts`, add a map before `runServerPublish` and populate it in the callback (line ~81):

```ts
            const collisionSizes = new Map<number, number>();
            const result = await runServerPublish(
                plyGz,
                publishOptions,
                (p) => {
                    if (p.collision) collisionSizes.set(p.collision.index, p.collision.bytes);
                    events.fire('progressUpdate', { text: p.message, progress: p.value, loc: p.loc });
                },
                upload?.extraPlyGz,
                ...unchanged...
            );
```

- [ ] **Step 2: Show the summary instead of the plain popup when there are sizes**

Replace the success popup (lines ~88-94) with:

```ts
            events.fire('progressEnd');
            const message = result.url ?
                i18n.t('popup.publish.s3.public-message') :
                `${i18n.t('popup.publish.s3.private-message')} ${result.prefix}`;
            if (collisionSizes.size > 0) {
                // `upload` is the buildPortalUpload result already in scope above;
                // it returns sceneNames (Task 9 Step 6) so the bundle is resolved once.
                const sceneNames = upload?.sceneNames ?? [options.name];
                await events.invoke('showExportSummary', {
                    header: i18n.t('popup.publish.succeeded'),
                    message,
                    link: result.url,
                    sizes: [...collisionSizes.entries()].sort((a, b) => a[0] - b[0])
                    .map(([sceneIndex, bytes]) => ({ sceneIndex, name: sceneNames[sceneIndex] ?? `#${sceneIndex}`, bytes }))
                });
            } else {
                await events.invoke('showPopup', {
                    type: 'info',
                    header: i18n.t('popup.publish.succeeded'),
                    message,
                    link: result.url
                });
            }
```

If `upload` is not in scope at this point in the function, hoist its declaration — do **not** call `buildPortalUpload` a second time (it serializes and gzips every extra scene's PLY).

- [ ] **Step 3: Build and check**

Run: `npm run build > /tmp/build.txt 2>&1; grep -c "plugin typescript" /tmp/build.txt`

Expected: `0`.

- [ ] **Step 4: Run both test suites**

Run: `npx vitest run > /tmp/all.txt 2>&1; cat /tmp/all.txt`

Then from `server/`: `npm test > /tmp/srv.txt 2>&1; cat /tmp/srv.txt`

Expected: both fully PASS, including `parity-compressed.test.ts`.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/s3-publish.ts
git commit -m "feat(collision): report per-scene collision sizes after S3 publish"
```

---

### Task 11: Manual end-to-end verification

**Files:** none — this task produces a verification report, not code.

No automated test covers the GPU voxelisation path end to end, so this is the only gate that proves per-scene values actually reach `writeVoxel`.

- [ ] **Step 1: Build a release bundle and start the export server**

Always E2E a RELEASE build — debug builds have masked issues here before.

```bash
npm run build
```

Then from `server/`: `npm run dev` and open http://localhost:3334.

- [ ] **Step 2: Export a portal bundle with deliberately different values**

Load a multi-scene portal project. Open the export popup, choose Package ZIP with Streaming and Collision on. Confirm:

- one collapsible card per scene, collapsed, with a readable summary on each header
- the scene name is fully readable (no truncation at ~16 characters as in the current UI)
- the shared Environment / Radius / Voxel size rows are gone while cards are shown

Set scene 0 to `0.05`, scene 1 to `0.20`, scene 2 to `0.10`, and give scene 1 a radius of `200`. Export.

- [ ] **Step 3: Verify the per-scene values reached the writer**

Unzip the export and check each scene reports the resolution it was given:

```bash
unzip -p out.zip index.voxel.json | head -c 400
unzip -p out.zip scenes/1/scene.voxel.json | head -c 400
unzip -p out.zip scenes/2/scene.voxel.json | head -c 400
```

Expected: `voxelResolution` of `0.05`, `0.2`, `0.1` respectively. If a value is coarser than requested, check the console for a "Collision voxelization failed ... retrying" line — that is the pre-existing ladder, not a regression.

- [ ] **Step 4: Verify the summary dialog**

The summary dialog should appear after the export with one row per scene. Cross-check every reported size against the archive:

```bash
unzip -l out.zip | grep voxel.bin
```

Expected: reported sizes match the archive's byte counts exactly, and any scene above 15 MB carries the ⚠ marker plus the explanatory note.

- [ ] **Step 5: Verify the other two paths**

Repeat step 2 with "Export on server" enabled, and once more via S3 publish. All three must show the same dialog with matching sizes. For publish specifically, confirm the published **link is still present and still opens the scene** — that is the regression risk in Task 10.

- [ ] **Step 6: Verify the single-scene path is unchanged**

Export a project with no portals. Confirm the shared Environment / Radius / Voxel size rows appear as they do today, no cards are shown, and the summary lists exactly one scene.

- [ ] **Step 7: Check a non-English locale**

Reload with `?lng=fr` and reopen the export popup and the summary dialog. Confirm all four new strings are translated and none overflow their row.

- [ ] **Step 8: Record the result**

Write the outcome (values requested vs. `voxelResolution` observed, reported vs. actual sizes, all three paths) into `docs/superpowers/2026-08-15-per-scene-collision-params.md`, replacing its "NOT STARTED" status, and commit.

---

## Notes for the executor

- **The spec rejected two things a reasonable engineer would want to add back.** There is no adaptive voxel-size default and no in-dialog size estimate. Both were considered and rejected on evidence recorded in the spec. Do not add them.
- **`writeCollisionVoxel` and `src/collision-voxel-options.ts` are not touched by this plan.** If you find yourself editing either, re-read the task.
- **The byte-parity test is the canary.** If `server/test/parity-compressed.test.ts` fails, the single-scene export path has been disturbed — stop and revert rather than adjusting the test.
- Several steps say "check X before using it" (the `Events` removal method, the locale file nesting style, SCSS colour variables, whether `dist-shared` includes the new module). Those are real unknowns; verify rather than assume.
