# Portal support for the S3 publish flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the portal multi-scene walkthrough (already in the ZIP export) to the S3 publish flow: per-scene Interior/Exterior collision dropdowns in the publish dialog and a multi-scene portal bundle uploaded to the (already-ready) `/api/publish` server endpoint.

**Architecture:** Extract the export path's inline "serialize each extra scene to a gzipped PLY + build portalExtras meta" loop into a shared helper `src/portal-upload.ts`, then consume it from both `file-handler.ts` (behavior-preserving refactor) and the new `s3-publish.ts` portal path. Mirror `export-popup.ts`'s per-scene environment UI into `s3-publish-dialog.ts`. The server already accepts `extraPly` + `portalExtras`.

**Tech Stack:** TypeScript, PCUI (dialog UI), `@playcanvas/splat-transform` (`serializePly`, `MemoryFileSystem`), vitest, rollup.

## Global Constraints

- Target ONLY the S3 publish flow (`s3-publish-dialog.ts`, `s3-publish.ts`). Do NOT touch `publish.ts` / `publish-settings-dialog.ts` (PlayCanvas hosted publish).
- `src/portal-export.ts` MUST stay free of `playcanvas` / `@playcanvas/splat-transform` imports (it is the unit-testable pure module). Serialization-touching code goes in `src/portal-upload.ts` instead.
- Reuse existing locale keys `popup.export.environment.indoor` / `popup.export.environment.outdoor`. No new locale keys.
- Per-task type-check gate: `npx tsc --noEmit`. Lint gate: `npm run lint`. Test gate: `npm run test`.
- Final correctness for the upload/UI glue is a manual end-to-end test against a **RELEASE build** (`npm run build`) — per the portal-feature minification gotcha previously hit. The toolchain does not unit-test modules importing `playcanvas`; those follow the existing `writeViaServer`/dialog convention (build + E2E verified).
- Commit messages end with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

---

## File Structure

- `src/portal-export.ts` (modify) — gains pure `collisionSeedTuple(es)`, exported.
- `src/portal-upload.ts` (create) — `buildPortalUpload(...)` + `PortalUploadMeta`; the only new module importing `serializePly`.
- `src/file-handler.ts` (modify) — import `collisionSeedTuple` from portal-export (remove local copy); replace the inline extra-scene loop in `writeViaServer` with `buildPortalUpload`.
- `src/export-server-client.ts` (modify) — `runServerPublish` gains `extraPlyGz?: Blob[]`.
- `src/ui/s3-publish-dialog.ts` (modify) — per-scene env selectors + portal-bundle injection into `experienceSettings`.
- `src/s3-publish.ts` (modify) — call `buildPortalUpload`, serialize the start scene as primary, pass `extraPlyGz` + `portalExtras`.
- `test/portal-export.test.ts` (modify) — test for `collisionSeedTuple`.

---

## Task 1: Move `collisionSeedTuple` into the pure portal-export module

**Files:**
- Modify: `src/portal-export.ts`
- Modify: `src/file-handler.ts:170-172` (remove local const), `:651`, `:788` (use imported)
- Test: `test/portal-export.test.ts`

**Interfaces:**
- Produces: `collisionSeedTuple(es: { cameras?: { initial?: { position?: [number, number, number] } }[] }): [number, number, number]` exported from `src/portal-export.ts`.

- [ ] **Step 1: Write the failing test**

Append to `test/portal-export.test.ts`:

```ts
import { collisionSeedTuple } from '../src/portal-export';

describe('collisionSeedTuple', () => {
    it('returns the first camera initial position', () => {
        expect(collisionSeedTuple({ cameras: [{ initial: { position: [1, 2, 3] } }] })).toEqual([1, 2, 3]);
    });

    it('falls back to origin when no camera/position present', () => {
        expect(collisionSeedTuple({})).toEqual([0, 0, 0]);
        expect(collisionSeedTuple({ cameras: [] })).toEqual([0, 0, 0]);
        expect(collisionSeedTuple({ cameras: [{}] })).toEqual([0, 0, 0]);
    });
});
```

Add `collisionSeedTuple` to the existing `import { ... } from '../src/portal-export';` line instead of a second import if you prefer — either compiles.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- portal-export`
Expected: FAIL — `collisionSeedTuple is not exported` / undefined.

- [ ] **Step 3: Add the pure helper to `src/portal-export.ts`**

After the `resolveCollisionSeed` export block (near the existing `export { resolveCollisionSeed, EYE_HEIGHT, SIDE_NUDGE };`), add:

```ts
// Start-scene collision seed = the start camera's initial position (or origin).
// Pure (no playcanvas) so both the export and publish upload paths share it.
const collisionSeedTuple = (es: { cameras?: { initial?: { position?: [number, number, number] } }[] }): [number, number, number] => {
    return es.cameras?.[0]?.initial?.position ?? [0, 0, 0];
};

export { collisionSeedTuple };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- portal-export`
Expected: PASS (all portal-export tests).

- [ ] **Step 5: Update `src/file-handler.ts` to use the imported helper**

Remove the local definition at lines 170-172:

```ts
const collisionSeedTuple = (es: { cameras?: { initial?: { position?: [number, number, number] } }[] }): [number, number, number] => {
    return es.cameras?.[0]?.initial?.position ?? [0, 0, 0];
};
```

Add `collisionSeedTuple` to the existing portal-export import (line 9):

```ts
import { collisionSeedTuple, resolvePortalExtras } from './portal-export';
```

The two call sites (`startSeed: collisionSeedTuple(es)` at ~:651 and ~:788) now resolve to the import — no further change needed.

- [ ] **Step 6: Type-check, lint, commit**

Run: `npx tsc --noEmit` (expect no errors), `npm run lint` (expect clean).

```bash
git add src/portal-export.ts src/file-handler.ts test/portal-export.test.ts
git commit -m "refactor(portals): move collisionSeedTuple into pure portal-export module

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Shared portal upload helper (`src/portal-upload.ts`)

**Files:**
- Create: `src/portal-upload.ts`

**Interfaces:**
- Consumes: `resolvePortalExtras`, `collisionSeedTuple` from `./portal-export`; `serializePly`, `SerializeSettings` from `./splat-serialize`; `MemoryFileSystem` from `@playcanvas/splat-transform`; `Events` from `./events`; `Splat` from `./splat`.
- Produces:
  ```ts
  type PortalUploadMeta = {
      seed: [number, number, number];
      environment: 'indoor' | 'outdoor';
      collisionUrl: string | null;
      streaming: boolean;
  };
  buildPortalUpload(args: {
      events: Events;
      es: any;                       // experienceSettings w/ portalScenes/portalCollision/portalEnvironments
      serializeSettings: SerializeSettings;
      streaming: boolean;
  }): Promise<{ startSplat: Splat; extraPlyGz: Blob[]; portalExtras: PortalUploadMeta[]; } | null>
  ```

**Note on testing:** this module imports `serializePly` (→ `playcanvas`/`splat-transform`), which the vitest setup does not unit-test (no existing test imports `splat-serialize`). Its non-trivial decision logic (`resolvePortalExtras`, `collisionSeedTuple`) is already covered by `test/portal-export.test.ts`. This helper is verified via `npx tsc --noEmit`, `npm run build`, and the Task 7 E2E — matching the existing `writeViaServer` convention.

- [ ] **Step 1: Create `src/portal-upload.ts`**

```ts
// Shared "serialize each extra portal scene to a gzipped PLY + build the
// portalExtras upload meta" step for the server-upload paths (ZIP export and
// S3 publish). Lives outside portal-export.ts because it needs serializePly
// (which pulls in splat-transform/playcanvas); portal-export.ts stays pure.

import { MemoryFileSystem } from '@playcanvas/splat-transform';

import { Events } from './events';
import { collisionSeedTuple, resolvePortalExtras } from './portal-export';
import { Splat } from './splat';
import { serializePly, SerializeSettings } from './splat-serialize';

type PortalUploadMeta = {
    seed: [number, number, number];
    environment: 'indoor' | 'outdoor';
    collisionUrl: string | null;
    streaming: boolean;
};

// Returns null when `es` is not a portal export (no portalScenes, single scene,
// or resolvePortalExtras yields null). Otherwise returns the start splat (to be
// serialized by the caller as the primary scene.ply) plus the gzipped extra
// scene PLYs and their upload metadata, in the same index order as portalScenes.
const buildPortalUpload = async (args: {
    events: Events;
    es: any;
    serializeSettings: SerializeSettings;
    streaming: boolean;
}): Promise<{ startSplat: Splat; extraPlyGz: Blob[]; portalExtras: PortalUploadMeta[] } | null> => {
    const { events, es, serializeSettings, streaming } = args;

    if (!es?.portalScenes || es.portalScenes.length <= 1) return null;

    const all = events.invoke('scene.allSplats') as Splat[];
    const resolved = resolvePortalExtras({
        portals: events.invoke('portals.export') ?? [],
        startUid: events.invoke('portals.startSplat') ?? null,
        availableUids: all.map(s => s.uid),
        streaming,
        collision: !!es.portalCollision && es.portalCollision.length > 0,
        authored: events.invoke('portals.exportEntrypoints') ?? {},
        startSeed: collisionSeedTuple(es),
        environments: es.portalEnvironments ?? []
    });
    if (!resolved) return null;

    const startUid = resolved.bundle.sceneUids[0];
    const startSplat = all.find(s => s.uid === startUid);
    if (!startSplat) throw new Error(`Portal export: start scene uid ${startUid} not found among loaded splats.`);

    const extraPlyGz: Blob[] = [];
    const portalExtras: PortalUploadMeta[] = [];
    for (const ex of resolved.extras) {
        const splat = all.find(s => s.uid === ex.uid);
        if (!splat) throw new Error(`Portal export: scene uid ${ex.uid} not found among loaded splats.`);
        const sFs = new MemoryFileSystem();
        await serializePly([splat], serializeSettings, sFs, 'scene.ply');
        const bytes = sFs.results.get('scene.ply');
        if (!bytes) throw new Error(`Portal export: scene uid ${ex.uid} produced no PLY.`);
        const gz = await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
        extraPlyGz.push(gz);
        portalExtras.push({ seed: ex.seed, environment: ex.environment, collisionUrl: ex.collisionUrl, streaming });
    }

    return { startSplat, extraPlyGz, portalExtras };
};

export { buildPortalUpload, PortalUploadMeta };
```

- [ ] **Step 2: Type-check + lint**

Run: `npx tsc --noEmit` (expect no errors), `npm run lint` (expect clean).

- [ ] **Step 3: Commit**

```bash
git add src/portal-upload.ts
git commit -m "feat(portals): shared portal upload helper for server paths

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Refactor `writeViaServer` to use the shared helper

**Files:**
- Modify: `src/file-handler.ts` (the `writeViaServer` extra-scene block, ~:639-676; imports)

**Interfaces:**
- Consumes: `buildPortalUpload` from `./portal-upload`.

**Note:** behavior-preserving. Re-verified by the existing export E2E (no new unit test).

- [ ] **Step 1: Add the import**

Add after the existing portal-export import (line 9):

```ts
import { buildPortalUpload } from './portal-upload';
```

- [ ] **Step 2: Replace the inline extra-scene block in `writeViaServer`**

Replace this block (currently ~lines 639-676):

```ts
            let extraPlyGz: Blob[] | undefined;
            if (fileType === 'htmlViewer' || fileType === 'packageViewer') {
                const es = options.viewerExportSettings?.experienceSettings as any;
                if (es?.portalScenes && es.portalScenes.length > 1) {
                    const all = events.invoke('scene.allSplats') as Splat[];
                    const resolved = resolvePortalExtras({
                        portals: events.invoke('portals.export') ?? [],
                        startUid: events.invoke('portals.startSplat') ?? null,
                        availableUids: all.map(s => s.uid),
                        streaming: !!options.viewerExportSettings!.streaming,
                        collision: !!es.portalCollision && es.portalCollision.length > 0,
                        authored: events.invoke('portals.exportEntrypoints') ?? {},
                        startSeed: collisionSeedTuple(es),
                        environments: es.portalEnvironments ?? []
                    });
                    if (resolved) {
                        const startUid = resolved.bundle.sceneUids[0];
                        const startSplat = all.find(s => s.uid === startUid);
                        if (!startSplat) throw new Error(`Portal export: start scene uid ${startUid} not found among loaded splats.`);
                        splats = [startSplat];
                        const blobs: Blob[] = [];
                        const meta: { seed: [number, number, number]; environment: 'indoor' | 'outdoor'; collisionUrl: string | null; streaming: boolean }[] = [];
                        for (const ex of resolved.extras) {
                            const splat = all.find(s => s.uid === ex.uid);
                            if (!splat) throw new Error(`Portal export: scene uid ${ex.uid} not found among loaded splats.`);
                            const sFs = new MemoryFileSystem();
                            await serializePly([splat], serializeSettings, sFs, 'scene.ply');
                            const bytes = sFs.results.get('scene.ply');
                            if (!bytes) throw new Error(`Portal export: scene uid ${ex.uid} produced no PLY.`);
                            const gz = await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
                            blobs.push(gz);
                            meta.push({ seed: ex.seed, environment: ex.environment, collisionUrl: ex.collisionUrl, streaming: !!options.viewerExportSettings!.streaming });
                        }
                        extraPlyGz = blobs;
                        (wire as any).portalExtras = meta;
                    }
                }
            }
```

with:

```ts
            let extraPlyGz: Blob[] | undefined;
            if (fileType === 'htmlViewer' || fileType === 'packageViewer') {
                const es = options.viewerExportSettings?.experienceSettings as any;
                const upload = await buildPortalUpload({
                    events,
                    es,
                    serializeSettings,
                    streaming: !!options.viewerExportSettings!.streaming
                });
                if (upload) {
                    splats = [upload.startSplat];
                    extraPlyGz = upload.extraPlyGz;
                    (wire as any).portalExtras = upload.portalExtras;
                }
            }
```

- [ ] **Step 3: Check for now-unused imports**

`resolvePortalExtras` and `collisionSeedTuple` are still used by the local-export branch in `scene.write` (~:781-789); keep both imports. `MemoryFileSystem` and `serializePly` are still used elsewhere in `writeViaServer` (the primary PLY extraction) and `scene.write`; keep them. Run `npm run lint` to confirm no unused-import errors.

- [ ] **Step 4: Type-check, lint, test**

Run: `npx tsc --noEmit`, `npm run lint`, `npm run test` (full suite — expect all pass).

- [ ] **Step 5: Commit**

```bash
git add src/file-handler.ts
git commit -m "refactor(portals): writeViaServer uses shared buildPortalUpload helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `runServerPublish` accepts extra portal PLYs

**Files:**
- Modify: `src/export-server-client.ts` (`runServerPublish`, ~:93-136)

**Interfaces:**
- Produces: `runServerPublish(plyGz, options, onProgress, extraPlyGz?: Blob[])` — appends each `extraPlyGz` blob as an `extraPly` form field, exactly like `runServerExport`.

- [ ] **Step 1: Add the parameter and form fields**

Change the `runServerPublish` signature and the FormData construction. Replace:

```ts
export const runServerPublish = async (
    plyGz: Blob,
    options: object & { name: string; public: boolean; overwrite: boolean },
    onProgress: (p: ServerProgress) => void
): Promise<PublishResult> => {
    const form = new FormData();
    form.append('ply', plyGz, 'scene.ply.gz');
    form.append('options', JSON.stringify(options));
```

with:

```ts
export const runServerPublish = async (
    plyGz: Blob,
    options: object & { name: string; public: boolean; overwrite: boolean },
    onProgress: (p: ServerProgress) => void,
    extraPlyGz?: Blob[]
): Promise<PublishResult> => {
    const form = new FormData();
    form.append('ply', plyGz, 'scene.ply.gz');
    (extraPlyGz ?? []).forEach((b, i) => form.append('extraPly', b, `scene-${i + 1}.ply.gz`));
    form.append('options', JSON.stringify(options));
```

- [ ] **Step 2: Type-check + lint**

Run: `npx tsc --noEmit` (expect no errors — the existing single-arg call in `s3-publish.ts` still compiles since the new param is optional), `npm run lint`.

- [ ] **Step 3: Commit**

```bash
git add src/export-server-client.ts
git commit -m "feat(portals): runServerPublish forwards extra portal scene PLYs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Per-scene environment UI in the S3 publish dialog

**Files:**
- Modify: `src/ui/s3-publish-dialog.ts`

**Interfaces:**
- Consumes: `buildPortalBundle` from `../portal-export`; events `portals.count`, `portals.export`, `portals.startSplat`, `scene.allSplats`.
- Produces: `experienceSettings` now carries `portals`, `portalScenes`, `portalStart`, `portalCollision`, `portalEnvironments` when the scene has portals.

**Note:** PCUI dialog wiring — verified by `npx tsc --noEmit`, `npm run build`, and the Task 7 E2E (consistent with how `export-popup.ts`'s identical UI is verified). Mirrors `src/ui/export-popup.ts:300-335, 502-548, 726-753`.

- [ ] **Step 1: Add imports**

Add to the top imports of `src/ui/s3-publish-dialog.ts`:

```ts
import { buildPortalBundle } from '../portal-export';
```

`SelectInput`, `Container`, `Label` are already imported.

- [ ] **Step 2: Build the per-scene env container and rebuild fn**

After the `environmentRow`/`radiusRow`/`voxelRow` are created and appended (after the `.forEach(r => content.append(r.c))` block, ~line 93), insert the per-scene env container directly into `content` right after the single environment row. Because `content.append` order matters, append `perSceneEnvRow` immediately after `environmentRow.c`:

Replace the existing append loop:

```ts
        [streamingRow, collisionRow, environmentRow, radiusRow, voxelRow, animationRow, loopRow, colorRow, fovRow, bandsRow, subfolderRow, nameRow, publicRow]
        .forEach(r => content.append(r.c));
```

with:

```ts
        // per-scene environment selectors (portals only); one Interior/Exterior
        // select per portal-referenced scene, replacing the single environment row.
        const perSceneEnvRow = new Container({ class: 'per-scene-env', flex: true, flexDirection: 'column' });
        const perSceneEnvSelects = new Map<number, SelectInput>();

        const rebuildPerSceneEnv = () => {
            perSceneEnvRow.clear();
            perSceneEnvSelects.clear();
            const portalsRaw = events.invoke('portals.export') ?? [];
            const startUid = events.invoke('portals.startSplat') ?? null;
            const allSplats = events.invoke('scene.allSplats') ?? [];
            const availableUids = allSplats.map((s: any) => s.uid);
            const bundle = (events.invoke('portals.count') ?? 0) > 0
                ? buildPortalBundle({ portals: portalsRaw, startUid, availableUids, streaming: streaming.value, collision: true })
                : null;
            if (!bundle) { perSceneEnvRow.hidden = true; return; }
            perSceneEnvRow.hidden = false;
            bundle.sceneUids.forEach((uid, index) => {
                const splat = allSplats.find((s: any) => s.uid === uid);
                const label = splat ? `${uid}: ${(splat.asset?.file?.filename ?? splat.name ?? uid)}` : `Scene ${index}`;
                const r = new Container({ class: 'row' });
                r.append(new Label({ class: 'label', text: label }));
                const sel = new SelectInput({
                    class: 'select',
                    defaultValue: 'indoor',
                    options: [
                        { v: 'indoor', t: localize('popup.export.environment.indoor') },
                        { v: 'outdoor', t: localize('popup.export.environment.outdoor') }
                    ]
                });
                r.append(sel);
                perSceneEnvRow.append(r);
                perSceneEnvSelects.set(index, sel);
            });
        };

        [streamingRow, collisionRow, environmentRow].forEach(r => content.append(r.c));
        content.append(perSceneEnvRow);
        [radiusRow, voxelRow, animationRow, loopRow, colorRow, fovRow, bandsRow, subfolderRow, nameRow, publicRow]
        .forEach(r => content.append(r.c));
```

- [ ] **Step 3: Wire visibility for portals**

Replace the existing `updateCollisionVisibility` + its event hookups:

```ts
        const updateCollisionVisibility = () => {
            const hide = !collision.value;
            environmentRow.c.hidden = hide;
            radiusRow.c.hidden = hide;
            voxelRow.c.hidden = hide;
        };
        collision.on('change', updateCollisionVisibility);
```

with:

```ts
        const updateCollisionVisibility = () => {
            const hide = !collision.value;
            const hasPortals = (events.invoke('portals.count') ?? 0) > 0;
            // with portals, the single environment row is replaced by per-scene selectors
            environmentRow.c.hidden = hide || hasPortals;
            radiusRow.c.hidden = hide;
            voxelRow.c.hidden = hide;
            rebuildPerSceneEnv();
            perSceneEnvRow.hidden = perSceneEnvRow.hidden || hide;
        };
        collision.on('change', updateCollisionVisibility);
        streaming.on('change', rebuildPerSceneEnv);
```

- [ ] **Step 4: Inject the portal bundle into experienceSettings in `assemble()`**

In `assemble()`, just before the `const experienceSettings: ExperienceSettings = {` line, add:

```ts
                // portal multi-scene bundle (absent when the scene has no portals)
                const portalsRaw = events.invoke('portals.export') ?? [];
                const startUid = events.invoke('portals.startSplat') ?? null;
                const allSplats = events.invoke('scene.allSplats') ?? [];
                const availableUids = allSplats.map((s: any) => s.uid);
                const bundle = (events.invoke('portals.count') ?? 0) > 0
                    ? buildPortalBundle({ portals: portalsRaw, startUid, availableUids, streaming: streaming.value, collision: collision.value })
                    : null;
```

Then add the portal fields to the `experienceSettings` object literal, immediately after the `offLimitsMessage:` line and before `startMode:`:

```ts
                    ...(bundle ? {
                        portals: bundle.portals,
                        portalScenes: bundle.portalScenes,
                        portalStart: bundle.portalStart,
                        portalCollision: bundle.portalCollision,
                        portalEnvironments: bundle.sceneUids.map((_, i) => (perSceneEnvSelects.get(i)?.value ?? 'indoor') as 'indoor' | 'outdoor')
                    } : {}),
```

- [ ] **Step 5: Rebuild per-scene env on show**

In `this.show`, after the existing `updateCollisionVisibility();` call in the reset block (~line 142), no extra call is needed — `updateCollisionVisibility` now calls `rebuildPerSceneEnv`. Confirm `updateCollisionVisibility()` is invoked in the reset block; it already is.

- [ ] **Step 6: Type-check, lint, build**

Run: `npx tsc --noEmit`, `npm run lint`, `npm run build` (expect a clean production build).

- [ ] **Step 7: Commit**

```bash
git add src/ui/s3-publish-dialog.ts
git commit -m "feat(portals): per-scene environment selectors in S3 publish dialog

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Upload portal scenes from the S3 publish flow

**Files:**
- Modify: `src/s3-publish.ts`

**Interfaces:**
- Consumes: `buildPortalUpload` from `./portal-upload`; `runServerPublish(..., extraPlyGz?)` (Task 4).

**Note:** server-upload glue — verified by `npx tsc --noEmit`, `npm run build`, and the Task 7 E2E.

- [ ] **Step 1: Add the import**

Add to `src/s3-publish.ts` imports:

```ts
import { buildPortalUpload } from './portal-upload';
```

- [ ] **Step 2: Build the portal upload before serializing the primary scene**

Replace this block:

```ts
            // browser-side PLY extraction (same path as server export)
            const splats = events.invoke('scene.splats');
            const serializeSettings: SerializeSettings = { ...options.serializeSettings };
            const memFs = new MemoryFileSystem();
            await serializePly(splats, serializeSettings, memFs, 'scene.ply');
            const plyBytes = memFs.results.get('scene.ply');
```

with:

```ts
            // browser-side PLY extraction (same path as server export)
            const serializeSettings: SerializeSettings = { ...options.serializeSettings };

            // portal multi-scene upload: when the scene has portals, the PRIMARY
            // scene is the START scene alone; each extra scene uploads its own
            // gzipped PLY + metadata for the server to assemble (mirrors writeViaServer).
            const es = options.viewerExportSettings.experienceSettings as any;
            const upload = await buildPortalUpload({
                events,
                es,
                serializeSettings,
                streaming: !!options.viewerExportSettings.streaming
            });
            const splats = upload ? [upload.startSplat] : events.invoke('scene.splats');

            const memFs = new MemoryFileSystem();
            await serializePly(splats, serializeSettings, memFs, 'scene.ply');
            const plyBytes = memFs.results.get('scene.ply');
```

- [ ] **Step 3: Forward extra PLYs + portalExtras to the server**

Replace this block:

```ts
            const publishOptions = {
                subfolder: options.subfolder,
                name: options.name,
                public: options.public,
                overwrite: true,   // already confirmed (or didn't exist)
                serializeSettings: options.serializeSettings,
                viewerExportSettings: options.viewerExportSettings
            };
            const result = await runServerPublish(plyGz, publishOptions, p => events.fire('progressUpdate', { text: p.message, progress: p.value }));
```

with:

```ts
            const publishOptions = {
                subfolder: options.subfolder,
                name: options.name,
                public: options.public,
                overwrite: true,   // already confirmed (or didn't exist)
                serializeSettings: options.serializeSettings,
                viewerExportSettings: options.viewerExportSettings,
                ...(upload ? { portalExtras: upload.portalExtras } : {})
            };
            const result = await runServerPublish(plyGz, publishOptions, p => events.fire('progressUpdate', { text: p.message, progress: p.value }), upload?.extraPlyGz);
```

- [ ] **Step 4: Type-check, lint, build, full test**

Run: `npx tsc --noEmit`, `npm run lint`, `npm run test`, `npm run build` (all expected clean).

- [ ] **Step 5: Commit**

```bash
git add src/s3-publish.ts
git commit -m "feat(portals): S3 publish uploads multi-scene portal bundle

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: End-to-end verification (release build)

**Files:** none (verification only).

- [ ] **Step 1: Full gates**

Run, expecting all clean:
- `npx tsc --noEmit`
- `npm run lint`
- `npm run test`
- `npm run build`

- [ ] **Step 2: Manual E2E against the release build**

With the export server running and S3 configured (so the Publish menu opens the S3 dialog), and a scene that has ≥2 portal-linked sub-scenes with a start scene set in the portals panel:

1. Serve the release `dist/` build (`npm run serve`) — NOT the dev build (minification gotcha).
2. File → Publish. Confirm the S3 publish dialog shows one Interior/Exterior dropdown **per scene** (and the single Environment row is hidden) when collision is on; confirm they hide when collision is off.
3. Set distinct environments per scene, publish.
4. Open the published URL. Verify: the start scene loads, walking through a portal swaps to the linked scene, and collision behaves per the per-scene Interior/Exterior choice. Compare against an equivalent ZIP export to confirm parity.

- [ ] **Step 3: Confirm no regression on a non-portal publish**

Publish a single-scene (no portals) scene via the S3 dialog; confirm it behaves exactly as before (single environment row, single PLY, no `extraPly`).

---

## Self-Review

**Spec coverage:**
- Component 1 (shared helper) → Tasks 1 + 2.
- Component 2 (file-handler refactor) → Task 3.
- Component 3 (runServerPublish extraPlyGz) → Task 4.
- Component 4 (dialog per-scene env) → Task 5.
- Component 5 (s3-publish wiring) → Task 6.
- Testing + locales → Tasks 1 (pure test) and 7 (E2E); no new locale keys (constraint honored). All spec sections covered.

**Type consistency:** `buildPortalUpload` return shape (`startSplat`/`extraPlyGz`/`portalExtras`) is produced in Task 2 and consumed identically in Tasks 3 and 6. `PortalUploadMeta` fields (`seed`/`environment`/`collisionUrl`/`streaming`) match the server's expected `portalExtras` (server/src/index.ts already reads `options.portalExtras`). `collisionSeedTuple` signature identical across Tasks 1–2. `runServerPublish`'s new optional `extraPlyGz` (Task 4) matches the call in Task 6.

**Placeholders:** none — every code step shows full content.
