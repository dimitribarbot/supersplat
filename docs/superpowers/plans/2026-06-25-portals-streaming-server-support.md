# Portals — Streaming + Server Export Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the portal multi-scene walkthrough export work with **streaming** (LOD) format AND via the **server** export path — lifting the interim "SOG/package, local-only" limitation so portals are a first-class option under every viewer-export combination except single-file HTML.

**Architecture:** Two independent capabilities. (1) **Streaming local:** `writeStreamingViewerCore` already buffers everything into an in-memory `MemoryFileSystem` and zips at the very end — so the extra `scenes/N/` payloads are written into that same memFs *before* the zip loop (identical to the package branch). (2) **Server:** the server already calls the shared `writeViewerCore`, which already accepts `extraScenes`; it just never receives the extra scenes because the client uploads only the primary PLY. We add a multi-PLY transport (one gzipped PLY per portal scene + per-scene metadata) so the server parses the extras into `extraScenes` and hands them to the same `writeViewerCore`.

**Tech Stack:** TypeScript, PlayCanvas engine, `@playcanvas/splat-transform`, `@playcanvas/pcui`, Fastify (server), `node:worker_threads`, vitest.

**Spec / prior plan:** `docs/superpowers/plans/2026-06-20-portals-sub-project-2-exported-viewer.md` (the parent plan; this plan extends Tasks 5–6 and supersedes their "ZIP/SOG-only, local-only" interim guards).

## Global Constraints

- Work on branch `portals-exported-viewer`. Do NOT push unless asked. Squash at the very end (the finishing skill handles this) — but make frequent local commits during development.
- Use the Bash tool (Git Bash). Run commands plainly: NO `cd` / `git -C` / `--prefix` pointing at the cwd (causes permission prompts).
- **Build gates are the real gates:** `npx tsc --noEmit` (run in the FOREGROUND, generous timeout ≥ 240000 ms — it is slow and unreliable when backgrounded) and `npm run build` must pass. Do NOT run `eslint --fix` / `npm run lint` (a known pinned-eslint@10 import/order crash on `src/main.ts` fails spuriously, unrelated to this work).
- Tests: `npm test` (vitest). The 3 `server/test/*` failures (`Cannot find package 'tsx'`) are pre-existing/environmental — ignore them. GPU-gated server tests (`*.gpu.test.ts`) only run where a GPU device is available; treat them as non-blocking in this environment.
- **Zero-portals invariant (must hold across every task):** with no portals in the export, every existing export path — local html/streaming/package and the server path — must be byte-for-byte unchanged. All new code paths are guarded on portal scenes being present.
- **Index alignment invariant:** the primary scene is index 0; extra scenes are indices `1..N` in `bundle.sceneUids` order. The local writer, the server writer, the uploaded extra-PLY order, and the per-scene metadata array MUST all share this exact order. `buildPortalBundle` (in `src/portal-export.ts`) is pure and order-stable; always recompute the bundle from the same `{ portals, startUid, availableUids, streaming, collision }` inputs.
- Pure logic that must be unit-tested goes in a **playcanvas-free** module (importing full `playcanvas` under vitest hangs). Importing `playcanvas` only in type position is fine (esbuild elides it).
- Coordinate convention unchanged: scenes are exported via `extractDataTable`, baking each splat's editor world transform into the data, so all scenes share one world frame.

## Current state (what the interim fixes did — and what this plan reverses)

- `src/splat-export-core.ts:556` (html branch) — guard throws on `hasPortalScenes`. **KEEP** (single-file HTML genuinely cannot carry `scenes/N/`).
- `src/splat-export-core.ts:575` (streaming branch) — guard throws on `hasPortalScenes`. **REMOVE in Task 1** (replaced by real streaming support).
- `src/ui/export-popup.ts` `updateStreamingVisibility` — forces `streamingToggle.value = false` + `enabled = false` when portals exist. **REVERT in Task 2.**
- `src/ui/export-popup.ts` `updateServerVisibility` — `if portals return false` for viewer. **REVERT in Task 2.**
- `src/ui/export-popup.ts` `assembleViewerOptions` — `useServer: … && !bundle`. **REVERT in Task 2.**
- `src/ui/scss/export-popup.scss` `.per-scene-env` rule + `export-popup.ts` `perSceneEnvRow` class — the per-scene dropdown layout fix. **KEEP** (genuine bug fix, unrelated to streaming/server).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/splat-export-core.ts` | **(modify)** Thread `extraScenes` into `writeStreamingViewerCore` (write each into memFs before the zip loop); remove the streaming guard in `writeViewerCore`. |
| `src/ui/export-popup.ts` | **(modify)** Revert the streaming-lock and server-hide interim guards; keep the per-scene env layout fix. |
| `src/portal-export.ts` | **(modify, pure)** Add `resolvePortalExtras` — the shared, playcanvas-free resolver that maps a bundle + authored entrypoints + start seed to per-extra-scene `{ index, uid, collisionUrl, environment, seed }`. Unit-tested. |
| `test/portal-export.test.ts` | **(modify)** Unit tests for `resolvePortalExtras`. |
| `src/file-handler.ts` | **(modify)** Use `resolvePortalExtras` for the local path (replacing the inline resolution); in `writeViaServer`, when portals exist, extract one gzipped PLY per portal scene + assemble per-scene metadata and pass them to `runServerExport`. |
| `src/export-server-client.ts` | **(modify)** `runServerExport` accepts extra gzipped PLYs and appends them as ordered `extraPly` multipart parts. |
| `server/src/run-export.ts` | **(modify)** Accept `extraPlyGz` + `portalExtras`; parse each extra PLY into a `DataTable`, build the `extraScenes` array, pass it to `writeViewerCore`. |
| `server/src/index.ts` | **(modify)** Parse ordered `extraPly` file parts in `/api/export` (and `/api/publish`); pass them through `createJob`. |
| `server/src/jobs.ts` | **(modify)** Carry `extraPlyGz: Buffer[]` through the job into the worker host. |
| `server/src/run-export-worker-host.ts` | **(modify)** Transfer the extra PLY buffers into the worker. |
| `server/src/export-worker.ts` | **(modify)** Receive the extra PLY buffers and forward them to `runExport`. |
| `server/test/portal-extras.test.ts` | **(new)** CPU-only unit test: the wire/options plumbing and (where feasible) a non-GPU assertion that extra PLYs are parsed and counted. |

---

## Task 1: Streaming local — write extra portal scenes into the streaming ZIP

**Files:**
- Modify: `src/splat-export-core.ts` (`writeStreamingViewerCore`, and the streaming branch of `writeViewerCore`)

**Interfaces:**
- Consumes: the existing module-private `writePortalScene(memFs, index, scene, createDevice, radius, voxelSize, getPrefix?)`, `ExtraPortalScene` type, `MemoryFileSystem`.
- Produces: `writeStreamingViewerCore(...)` gains a trailing `extraScenes?: ExtraPortalScene[]` parameter; the streaming branch of `writeViewerCore` no longer throws on portals and forwards `extraScenes`.

This task touches dependency-internal writers (GPU device required to run); it is gated by `npx tsc --noEmit` + `npm run build` and the Task 6 E2E (no unit test).

- [ ] **Step 1: Add `extraScenes` to `writeStreamingViewerCore` and write the extras before the zip loop**

In `src/splat-export-core.ts`, change the `writeStreamingViewerCore` signature to add a trailing parameter (after `collision`):

```ts
const writeStreamingViewerCore = async (
    dataTable: DataTable,
    viewerSettingsJson: any,
    createDevice: DeviceCreator,
    fs: FileSystem,
    events?: Events,
    onLog?: (level: string, text: string) => void,
    shouldCancel?: () => boolean,
    collision?: { environment: CollisionEnvironment; radius: number; voxelSize: number },
    extraScenes?: ExtraPortalScene[]
): Promise<void> => {
```

Then, in the body, AFTER `repointCollisionUrl(memFs)` (i.e. after the primary scene + its collision are fully in `memFs`) and BEFORE the `const zipWriter = await fs.createWriter('output.zip');` line, insert:

```ts
    // Write each extra portal scene's streaming bundle (lod-meta.json + chunk
    // folders) + per-scene voxel into the SAME memFs under scenes/N/, before the
    // single zip pass below. Mirrors the package branch; uses the shared
    // collision radius / voxel size (defaulting when collision is off but a
    // scene still carries a collision URL — writePortalScene guards on it).
    if (extraScenes && extraScenes.length > 0) {
        const collRadius = collision?.radius ?? 50;
        const collVoxelSize = collision?.voxelSize ?? 0.05;
        for (let i = 0; i < extraScenes.length; i++) {
            phase = `Scene ${i + 2}/${extraScenes.length + 1}`;
            await writePortalScene(memFs, i + 1, extraScenes[i], createDevice, collRadius, collVoxelSize);
        }
    }
```

(`phase` is the existing mutable label closure used by `writeStreamingViewerCore`'s progress renderer; setting it gives the extra-scene passes a scene-numbered prefix.)

- [ ] **Step 2: Remove the streaming guard and forward `extraScenes` in `writeViewerCore`**

In `src/splat-export-core.ts`, in the `else if (viewerType === 'streaming')` branch of `writeViewerCore`, delete the interim guard block:

```ts
            // DELETE these lines:
            if (hasPortalScenes) {
                throw new Error('Portal multi-scene export is only supported with the Package (ZIP) format. Disable streaming / choose Package format and re-export.');
            }
```

and change the call to forward `extraScenes`:

```ts
            await writeStreamingViewerCore(dataTable, viewerSettingsJson, createDevice, fs, events, onLog, shouldCancel, collision, extraScenes);
```

Leave the `html` branch guard intact (single-file HTML genuinely cannot host `scenes/N/`).

- [ ] **Step 3: Type-check + build**

Run: `npx tsc --noEmit && npm run build`
Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
git add src/splat-export-core.ts
git commit -m "feat(portals): write extra portal scenes into the streaming export ZIP"
```

---

## Task 2: Re-enable the streaming + server toggles for portal exports

**Files:**
- Modify: `src/ui/export-popup.ts`

**Interfaces:**
- Consumes: existing `streamingToggle`, `serverToggle`, `serverRow`, `updateStreamingVisibility`, `updateServerVisibility`, `assembleViewerOptions`.
- Produces: no new symbols; reverts the three interim guards so portals can be exported streaming and/or via server.

Not unit-tested (UI imports playcanvas); gated by `tsc --noEmit` + `npm run build` + manual check.

- [ ] **Step 1: Revert the streaming lock**

In `updateStreamingVisibility`, restore it to its pre-interim form (remove the `hasPortals` force-off + disable):

```ts
        const updateStreamingVisibility = () => {
            streamingRow.hidden = currentExportType !== 'viewer' || viewerTypeSelect.value !== 'zip';
        };
```

- [ ] **Step 2: Revert the server-hide for portals**

In `updateServerVisibility`, remove the portal early-return inside the `currentExportType === 'viewer'` branch so it reads:

```ts
                if (currentExportType === 'viewer') {
                    return capabilities.formats.includes('htmlViewer') || capabilities.formats.includes('packageViewer');
                }
```

- [ ] **Step 3: Revert the `useServer` portal guard**

In `assembleViewerOptions`, change the `useServer` line back to:

```ts
                    useServer: !serverRow.hidden && serverToggle.value
```

(Remove the `&& !bundle` and the preceding comment line.)

- [ ] **Step 4: Type-check + build**

Run: `npx tsc --noEmit && npm run build`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add src/ui/export-popup.ts
git commit -m "feat(portals): allow streaming and server export when portals are present"
```

---

## Task 3: `resolvePortalExtras` — shared, pure per-extra-scene resolver

**Files:**
- Modify: `src/portal-export.ts`
- Test: `test/portal-export.test.ts`

**Interfaces:**
- Consumes: existing `buildPortalBundle`, `resolveCollisionSeed`, `ExportPortal`, `Vec3` from this module.
- Produces:
  - `type PortalExtra = { index: number; uid: number; collisionUrl: string | null; environment: 'indoor' | 'outdoor'; seed: Vec3; estimated: boolean }`.
  - `resolvePortalExtras(args: { portals: ExportPortal[]; startUid: number | null; availableUids: number[]; streaming: boolean; collision: boolean; authored: Record<string, Vec3>; startSeed: Vec3; environments: ('indoor'|'outdoor')[] }) => { bundle: PortalBundle; extras: PortalExtra[] } | null` — returns `null` when there is no valid bundle (`buildPortalBundle` returns null). `extras` covers indices `1..N` (the primary index 0 is excluded). `environments` is index-aligned to `bundle.sceneUids` (index 0 = start); each extra's `environment` is `environments[index] ?? 'indoor'`. `collisionUrl` is `bundle.portalCollision[index] ?? null`. `seed`/`estimated` come from `resolveCollisionSeed`.

This is pure and playcanvas-free — fully unit-tested.

- [ ] **Step 1: Write the failing tests** — append to `test/portal-export.test.ts`:

```ts
import { resolvePortalExtras } from '../src/portal-export';

const ep = (front: number | null, back: number | null) => ({
    position: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0, 1] as [number, number, number, number],
    width: 2, height: 2, frontUid: front, backUid: back
});

describe('resolvePortalExtras', () => {
    it('returns null when there is no valid bundle (<2 scenes)', () => {
        const r = resolvePortalExtras({
            portals: [ep(10, null)], startUid: 10, availableUids: [10],
            streaming: false, collision: false, authored: {}, startSeed: [0, 0, 0], environments: []
        });
        expect(r).toBeNull();
    });

    it('excludes the primary (index 0); covers indices 1..N in bundle order', () => {
        const r = resolvePortalExtras({
            portals: [ep(10, 20)], startUid: 10, availableUids: [10, 20],
            streaming: false, collision: true, authored: { '20': [5, 6, 7] },
            startSeed: [1, 1, 1], environments: ['indoor', 'outdoor']
        })!;
        expect(r.bundle.sceneUids[0]).toBe(10);
        expect(r.extras).toHaveLength(1);
        const e = r.extras[0];
        expect(e.index).toBe(1);
        expect(e.uid).toBe(20);
        expect(e.environment).toBe('outdoor');                  // environments[1]
        expect(e.collisionUrl).toBe('scenes/1/scene.voxel.json'); // bundle.portalCollision[1]
        expect(e.seed).toEqual([5, 6, 7]);                      // authored entrypoint wins
        expect(e.estimated).toBe(false);
    });

    it('collisionUrl is null for every extra when collision is off', () => {
        const r = resolvePortalExtras({
            portals: [ep(10, 20)], startUid: 10, availableUids: [10, 20],
            streaming: false, collision: false, authored: {}, startSeed: [0, 0, 0], environments: ['indoor', 'indoor']
        })!;
        expect(r.extras[0].collisionUrl).toBeNull();
    });

    it('streaming bundle yields lod-meta scene URLs (sanity: bundle reflects streaming flag)', () => {
        const r = resolvePortalExtras({
            portals: [ep(10, 20)], startUid: 10, availableUids: [10, 20],
            streaming: true, collision: false, authored: {}, startSeed: [0, 0, 0], environments: ['indoor', 'indoor']
        })!;
        expect(r.bundle.portalScenes[1]).toBe('scenes/1/lod-meta.json');
    });

    it('missing environment defaults to indoor', () => {
        const r = resolvePortalExtras({
            portals: [ep(10, 20)], startUid: 10, availableUids: [10, 20],
            streaming: false, collision: false, authored: {}, startSeed: [0, 0, 0], environments: []
        })!;
        expect(r.extras[0].environment).toBe('indoor');
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- portal-export`
Expected: FAIL — `resolvePortalExtras` not exported.

- [ ] **Step 3: Implement (append to `src/portal-export.ts`)**

```ts
type PortalExtra = {
    index: number,
    uid: number,
    collisionUrl: string | null,
    environment: 'indoor' | 'outdoor',
    seed: Vec3,
    estimated: boolean
};

// Resolve the per-extra-scene export inputs shared by BOTH the local writer
// (file-handler -> serializeViewer) and the server upload path. Pure: takes
// already-extracted primitives (no playcanvas / Splat objects), so it is
// unit-testable and guarantees the local and server paths compute an identical
// bundle + ordering. Index 0 (primary/start) is excluded from `extras`.
const resolvePortalExtras = (args: {
    portals: ExportPortal[],
    startUid: number | null,
    availableUids: number[],
    streaming: boolean,
    collision: boolean,
    authored: Record<string, Vec3>,
    startSeed: Vec3,
    environments: ('indoor' | 'outdoor')[]
}): { bundle: PortalBundle, extras: PortalExtra[] } | null => {
    const { portals, startUid, availableUids, streaming, collision, authored, startSeed, environments } = args;
    const bundle = buildPortalBundle({ portals, startUid, availableUids, streaming, collision });
    if (!bundle) return null;

    const extras: PortalExtra[] = bundle.sceneUids.slice(1).map((uid, i) => {
        const index = i + 1;
        const { seed, estimated } = resolveCollisionSeed({ sceneIndex: index, sceneUid: uid, portals, authored, startSeed });
        return {
            index,
            uid,
            collisionUrl: collision ? (bundle.portalCollision[index] ?? null) : null,
            environment: environments[index] ?? 'indoor',
            seed,
            estimated
        };
    });

    return { bundle, extras };
};

export { resolvePortalExtras, PortalExtra };
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- portal-export`
Expected: PASS (all new + existing cases).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/portal-export.ts test/portal-export.test.ts
git commit -m "feat(portals): shared pure resolver for per-extra-scene export inputs"
```

---

## Task 4: Local path uses `resolvePortalExtras` (refactor, no behavior change)

**Files:**
- Modify: `src/file-handler.ts` (the `htmlViewer`/`packageViewer` case in `scene.write`)

**Interfaces:**
- Consumes: `resolvePortalExtras` (Task 3), existing `events.invoke('portals.export' | 'portals.startSplat' | 'portals.exportEntrypoints' | 'scene.allSplats')`, the existing `collisionSeedTuple(es)` helper, `serializeViewer`.
- Produces: the local `portalScenes` array passed to `serializeViewer` is built from `resolvePortalExtras` instead of the current inline `buildPortalBundle` + per-index `resolveCollisionSeed` loop. **Behavior must be identical** (same scenes, same order, same seeds, same estimated-seed warning).

Gated by `tsc --noEmit` + `npm run build`; correctness re-verified by the Task 7 local E2E (the same local export the user already exercised).

- [ ] **Step 1: Replace the inline resolution**

In `src/file-handler.ts`, in the `htmlViewer`/`packageViewer` case, the block currently guarded by `if (es.portalScenes && es.portalScenes.length > 1)` recomputes the bundle and maps `bundle.sceneUids.slice(1)`. Replace its bundle/seed computation with `resolvePortalExtras`, preserving the existing estimated-seed warning and the `byUid` splat lookup + missing-uid throw:

```ts
                    const es = viewerExportSettings!.experienceSettings;
                    let portalScenes: ViewerExportSettings['portalScenes'];
                    if (es.portalScenes && es.portalScenes.length > 1) {
                        const all = events.invoke('scene.allSplats') as Splat[];
                        const byUid = (uid: number) => all.find(s => s.uid === uid) ?? null;
                        const resolved = resolvePortalExtras({
                            portals: events.invoke('portals.export') ?? [],
                            startUid: events.invoke('portals.startSplat') ?? null,
                            availableUids: all.map(s => s.uid),
                            streaming: !!viewerExportSettings!.streaming,
                            collision: !!es.portalCollision && es.portalCollision.length > 0,
                            authored: events.invoke('portals.exportEntrypoints') ?? {},
                            startSeed: collisionSeedTuple(es),
                            environments: es.portalEnvironments ?? []
                        });
                        if (resolved) {
                            portalScenes = resolved.extras.map((ex) => {
                                if (ex.estimated && ex.environment === 'indoor') {
                                    events.fire('progressUpdate', { text: `Scene ${ex.index}: using an estimated collision entrypoint — set one in the portals panel if collision looks wrong.` });
                                    console.warn(`Portal export: scene index ${ex.index} (uid ${ex.uid}) used an estimated collision entrypoint.`);
                                }
                                const splat = byUid(ex.uid);
                                if (!splat) throw new Error(`Portal export: scene uid ${ex.uid} not found among loaded splats.`);
                                return {
                                    splat,
                                    url: es.portalScenes![ex.index] ?? '',
                                    collisionUrl: ex.collisionUrl,
                                    environment: ex.environment,
                                    seed: ex.seed
                                };
                            });
                        }
                    }
                    await serializeViewer(splats, serializeSettings, { ...viewerExportSettings!, events, portalScenes }, fs);
```

Add `resolvePortalExtras` to the existing `from './portal-export'` import. Remove any now-unused imports (e.g. `buildPortalBundle` / `resolveCollisionSeed`) **only if** they are no longer referenced elsewhere in the file.

- [ ] **Step 2: Type-check + build**

Run: `npx tsc --noEmit && npm run build`
Expected: both succeed.

- [ ] **Step 3: Commit**

```bash
git add src/file-handler.ts
git commit -m "refactor(portals): local export resolves extra scenes via shared resolver"
```

---

## Task 5: Server upload — extract + transmit one PLY per portal scene

**Files:**
- Modify: `src/file-handler.ts` (`writeViaServer`)
- Modify: `src/export-server-client.ts` (`runServerExport`)

**Interfaces:**
- Consumes: `resolvePortalExtras` (Task 3), `serializePly`, `MemoryFileSystem`, `events.invoke('scene.allSplats')`, the existing gzip-via-`CompressionStream` pattern in `writeViaServer`.
- Produces:
  - `runServerExport(plyGz, options, onProgress, extraPlyGz?: Blob[])` — when `extraPlyGz` is non-empty, appends each as an ordered multipart file part named `extraPly` (arrival order == array order == bundle index 1..N).
  - `writeViaServer`, for `htmlViewer`/`packageViewer` with portals, attaches `options.portalExtras: { seed: [number,number,number]; environment: 'indoor'|'outdoor'; collisionUrl: string|null; streaming: boolean }[]` (index-aligned to the `extraPly` order) and passes the matching gzipped extra PLYs.

Gated by `tsc --noEmit` + `npm run build` (no unit test — DOM/PLY/gzip are browser-bound); end-to-end verified in Task 7.

- [ ] **Step 1: Extend `runServerExport` to send ordered extra PLY parts**

In `src/export-server-client.ts`, change the signature and form assembly:

```ts
export const runServerExport = async (
    plyGz: Blob,
    options: object & { fileType: string; filename: string },
    onProgress: (p: ServerProgress) => void,
    extraPlyGz?: Blob[]
): Promise<Blob> => {
    const form = new FormData();
    form.append('ply', plyGz, 'scene.ply.gz');
    (extraPlyGz ?? []).forEach((b, i) => form.append('extraPly', b, `scene-${i + 1}.ply.gz`));
    form.append('options', JSON.stringify(options));
    // ...rest unchanged...
```

- [ ] **Step 2: In `writeViaServer`, resolve + extract + gzip the extra scenes**

In `src/file-handler.ts`, inside `writeViaServer`, after the primary `plyGz` is produced and before the `runServerExport(...)` call, add portal handling for the viewer formats. The primary scene stays the visible `splats` (unchanged). For the extras, resolve via `resolvePortalExtras`, look up each splat by uid, extract + gzip a PLY for each, and build the `portalExtras` metadata in the same order:

```ts
            // Portal walkthrough: upload one gzipped PLY per extra scene + the
            // per-scene metadata the server needs to assemble extraScenes. The
            // primary scene remains `scene.ply` (the visible splats) above.
            let extraPlyGz: Blob[] | undefined;
            if ((fileType === 'htmlViewer' || fileType === 'packageViewer')) {
                const es = options.viewerExportSettings!.experienceSettings as any;
                if (es.portalScenes && es.portalScenes.length > 1) {
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

`collisionSeedTuple` already exists in this file (reads `es.cameras?.[0]?.initial?.position ?? [0,0,0]`). Ensure `wire` is declared before this block (it is: `const wire = { ...options, fileType };`) and pass the extras to the call:

```ts
            const result = await runServerExport(plyGz, wire, (p) => {
                if (!useSpinner) {
                    events.fire('progressUpdate', { text: p.message, progress: p.value });
                }
            }, extraPlyGz);
```

Add `resolvePortalExtras` to the `from './portal-export'` import if not already present.

- [ ] **Step 3: Type-check + build**

Run: `npx tsc --noEmit && npm run build`
Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
git add src/file-handler.ts src/export-server-client.ts
git commit -m "feat(portals): upload one PLY per portal scene to the server export"
```

---

## Task 6: Server — parse extra PLYs and build `extraScenes`

**Files:**
- Modify: `server/src/index.ts` (parse `extraPly` parts in `/api/export` and `/api/publish`)
- Modify: `server/src/jobs.ts` (`createJob` carries `extraPlyGz`)
- Modify: `server/src/run-export-worker-host.ts` (transfer extra buffers to the worker)
- Modify: `server/src/export-worker.ts` (forward extra buffers to `runExport`)
- Modify: `server/src/run-export.ts` (`RunExportArgs`/`ExportOptions`, parse extras, build `extraScenes`, pass to `writeViewerCore`)
- Test: `server/test/portal-extras.test.ts`

**Interfaces:**
- Consumes: the wire `options.portalExtras` (Task 5) and the ordered `extraPly` buffers; the dynamically-imported shared `writeViewerCore` (already accepts `extraScenes`).
- Produces: `runExport` accepts `extraPlyGz?: Buffer[]`; for `packageViewer`/`htmlViewer` with `options.portalExtras`, it parses each extra PLY into a `DataTable` and calls `writeViewerCore(dataTable, …, collision, extraScenes)` where each `extraScenes[i] = { dataTable, streaming, collisionUrl, environment, seed }`.

The viewer write needs a GPU device, so the end-to-end produce-a-ZIP assertion is a `*.gpu.test.ts` (non-blocking here). The new CPU-only test asserts the plumbing (extra buffers are threaded and parsed/counted) without invoking the GPU writer.

- [ ] **Step 1: Thread `extraPlyGz` through the job + worker plumbing**

`server/src/run-export.ts` — extend the option/arg types:

```ts
export type ExportOptions = {
    fileType: 'ply' | 'compressedPly' | 'splat' | 'sog' | 'htmlViewer' | 'packageViewer';
    filename: string;
    serializeSettings?: { maxSHBands?: number };
    sogIterations?: number;
    viewerExportSettings?: { type: 'html' | 'zip'; streaming?: boolean; experienceSettings: any; collision?: { environment: 'indoor' | 'outdoor'; radius: number; voxelSize: number } };
    // per-extra-scene metadata for a portal walkthrough (index-aligned to extraPlyGz)
    portalExtras?: { seed: [number, number, number]; environment: 'indoor' | 'outdoor'; collisionUrl: string | null; streaming: boolean }[];
};

export type RunExportArgs = {
    plyGz: Buffer;
    options: ExportOptions;
    sink: Sink;
    getDeviceCreator: () => (() => Promise<any>);
    isCancelled?: () => boolean;
    extraPlyGz?: Buffer[];
};
```

`server/src/jobs.ts` — `createJob` takes the extras and forwards them:

```ts
export const createJob = (plyGz: Buffer, options: ExportOptions, publish?: PublishDest, extraPlyGz?: Buffer[]): string => {
```
and pass `extraPlyGz` into `runExportViaWorker({ plyGz, options, onProgress, extraPlyGz })`.

`server/src/run-export-worker-host.ts` — add `extraPlyGz?: Buffer[]` to `RunExportViaWorkerArgs`, convert each to a standalone `Uint8Array` like `plyGz`, and include them in the `postMessage` payload + transfer list:

```ts
export const runExportViaWorker = ({ plyGz, options, onProgress, extraPlyGz }: RunExportViaWorkerArgs): RunningExport => {
    // ...existing worker setup + promise...
    const toStandalone = (b: Buffer) => {
        const standalone = b.byteOffset === 0 && b.byteLength === b.buffer.byteLength;
        return standalone ? new Uint8Array(b.buffer) : new Uint8Array(b);
    };
    const bytes = toStandalone(plyGz);
    const extraBytes = (extraPlyGz ?? []).map(toStandalone);
    worker.postMessage(
        { type: 'start', plyGz: bytes, options, extraPlyGz: extraBytes },
        [bytes.buffer as ArrayBuffer, ...extraBytes.map(e => e.buffer as ArrayBuffer)]
    );
    return { promise, cancel: () => { worker.terminate(); } };
};
```

`server/src/export-worker.ts` — receive + forward the extras:

```ts
type StartMsg = { type: 'start'; plyGz: Uint8Array; options: ExportOptions; extraPlyGz?: Uint8Array[] };
// ...
        const res = await runExport({
            plyGz: Buffer.from(msg.plyGz.buffer, msg.plyGz.byteOffset, msg.plyGz.byteLength),
            options: msg.options,
            sink: { emit: (e: ProgressEvent) => port.postMessage({ type: 'progress', event: e }) },
            getDeviceCreator: session.getDeviceCreator,
            extraPlyGz: (msg.extraPlyGz ?? []).map(u => Buffer.from(u.buffer, u.byteOffset, u.byteLength))
        });
```

- [ ] **Step 2: Build `extraScenes` in `runExport` and pass to `writeViewerCore`**

`server/src/run-export.ts` — accept `extraPlyGz` in the destructure, and for the viewer formats parse each extra PLY into a `DataTable` and assemble `extraScenes`. Add a small local PLY-reader helper that mirrors the primary read (lines ~72–83), then in the `packageViewer` (and `htmlViewer`) section build the array:

```ts
export const runExport = async ({ plyGz, options, sink, getDeviceCreator, isCancelled, extraPlyGz }: RunExportArgs): Promise<RunResult> => {
```

After the primary `dataTable` is parsed and (for viewer formats) the shared core is imported, build the extras (only when `options.portalExtras` is present):

```ts
    // Parse one DataTable per uploaded extra portal scene, in upload order
    // (== bundle index 1..N), and pair each with its client-resolved metadata.
    const buildExtraScenes = async () => {
        const metas = options.portalExtras ?? [];
        const plys = extraPlyGz ?? [];
        if (metas.length === 0 || plys.length === 0) return undefined;
        const scenes = [];
        for (let i = 0; i < metas.length; i++) {
            const raw = Buffer.from(gunzipSync(plys[i]));
            const erfs = new MemoryReadFileSystem();
            erfs.set('extra.ply', new Uint8Array(raw));
            const t = (await readFile({ filename: 'extra.ply', inputFormat: 'ply', options: READ_OPTS, params: [], fileSystem: erfs }))[0];
            (t as any).transform = Transform.PLY;
            scenes.push({
                dataTable: t,
                streaming: metas[i].streaming,
                collisionUrl: metas[i].collisionUrl,
                environment: metas[i].environment,
                seed: metas[i].seed
            });
        }
        return scenes;
    };
```

Then change the `htmlViewer` and `packageViewer` calls to pass the extras (note `writeViewerCore`'s `extraScenes` is its 10th argument, after `collision`):

```ts
    if (options.fileType === 'htmlViewer') {
        const extraScenes = await buildExtraScenes();
        await writeViewerCore(dataTable, options.viewerExportSettings!.experienceSettings, 'html', createDevice, memFs, events, onLog, isCancelled, options.viewerExportSettings!.collision, extraScenes);
        // ...unchanged...
    }

    // packageViewer
    const viewerType = options.viewerExportSettings!.streaming ? 'streaming' : 'package';
    const extraScenes = await buildExtraScenes();
    await writeViewerCore(dataTable, options.viewerExportSettings!.experienceSettings, viewerType, createDevice, memFs, events, onLog, isCancelled, options.viewerExportSettings!.collision, extraScenes);
```

(The `html` branch of `writeViewerCore` still throws if `extraScenes` is non-empty — correct: single-file HTML can't host portals, so the client never sends portal extras for HTML. Passing `undefined` keeps HTML unaffected.)

- [ ] **Step 3: Parse `extraPly` parts in the server routes**

`server/src/index.ts` — in the `/api/export` handler, collect ordered `extraPly` file parts alongside `ply`, and forward them to `createJob`:

```ts
        let plyGz: Buffer | null = null;
        let options: any = null;
        const extraPlyGz: Buffer[] = [];
        for await (const part of req.parts()) {
            if (part.type === 'file' && part.fieldname === 'ply') {
                plyGz = await part.toBuffer();
            } else if (part.type === 'file' && part.fieldname === 'extraPly') {
                extraPlyGz.push(await part.toBuffer());
            } else if (part.type === 'field' && part.fieldname === 'options') {
                try { options = JSON.parse(part.value as string); } catch { return reply.code(400).send({ error: 'options is not valid JSON' }); }
            }
        }
        // ...existing validation unchanged...
        const id = createJob(plyGz, options, undefined, extraPlyGz.length ? extraPlyGz : undefined);
```

Apply the same `extraPly` collection in the `/api/publish` handler and pass it as the 4th `createJob` arg (publish builds a `packageViewer` job, so portal walkthroughs publish correctly too).

> Note: `@fastify/multipart` preserves part order within the request, so `extraPly[i]` lines up with `portalExtras[i]`. The client appends `ply` first, then the `extraPly` parts in bundle order, then `options`.

- [ ] **Step 4: Write the CPU-only plumbing test** — `server/test/portal-extras.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { runExport } from '../src/run-export.js';

// A tiny valid binary PLY with 1 vertex (x,y,z) — enough for readFile to parse.
const tinyPly = (): Buffer => {
    const header = 'ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n';
    const body = Buffer.alloc(12); // one zeroed vertex
    return Buffer.concat([Buffer.from(header, 'ascii'), body]);
};
const noGpu = () => { throw new Error('no gpu in this test'); };

describe('runExport portal extras (CPU plumbing)', () => {
    it('plain ply path ignores extras (no GPU touched)', async () => {
        const res = await runExport({
            plyGz: gzipSync(tinyPly()),
            options: { fileType: 'ply', filename: 'out.ply' },
            sink: { emit() {} },
            getDeviceCreator: noGpu,
            extraPlyGz: [gzipSync(tinyPly())]
        });
        expect(res.files[0].name).toBe('out.ply');
    });

    it('packageViewer reaches the GPU step only AFTER parsing the primary table (extras accepted on the args)', async () => {
        // With noGpu, the viewer write throws when it requests a device — proving the
        // call path accepts extraPlyGz/portalExtras and progresses past parsing.
        await expect(runExport({
            plyGz: gzipSync(tinyPly()),
            options: {
                fileType: 'packageViewer', filename: 'out.zip',
                viewerExportSettings: { type: 'zip', streaming: false, experienceSettings: {} },
                portalExtras: [{ seed: [0, 0, 0], environment: 'indoor', collisionUrl: null, streaming: false }]
            } as any,
            sink: { emit() {} },
            getDeviceCreator: noGpu,
            extraPlyGz: [gzipSync(tinyPly())]
        })).rejects.toBeTruthy();
    });
});
```

> If `readFile` cannot parse the minimal PLY in this environment, simplify the second test to assert that `runExport` rejects (any error) rather than silently dropping the extras — the goal is to prove the new args are wired, not to exercise the GPU writer. Adjust the PLY bytes only as needed to get a clean parse; do not add a GPU dependency.

- [ ] **Step 5: Run the new server test + the existing CPU server tests**

Run: `npm test -- portal-extras` then `npm test -- run-export`
Expected: the new plumbing test passes; existing CPU `run-export` tests still pass. (GPU-gated suites are skipped where no device is present.)

- [ ] **Step 6: Type-check + build (root + server)**

Run: `npx tsc --noEmit && npm run build`
Then the server's own type-check/build if it has one: `npm run build --workspace server` is NOT used here — instead run the server package's check the repo already defines (inspect `server/package.json` scripts; run its `build`/`typecheck` script plainly, e.g. `npm --prefix … ` is disallowed, so use the repo's documented invocation). If unsure, at minimum confirm root `tsc --noEmit` covers the shared types and report the server-side check you ran.

- [ ] **Step 7: Commit**

```bash
git add server/src test/ server/test/portal-extras.test.ts
git commit -m "feat(portals): server export parses extra scene PLYs into the bundle"
```

---

## Task 7: End-to-end verification + finish

**Files:** none (verification + ledger).

- [ ] **Step 1: Local SOG (regression).** Export the two-floor capture as ZIP, collision ON, **streaming OFF**, **server OFF**. Confirm the ZIP still has `index.*` + `scenes/1/scene.sog` + `scenes/1/scene.voxel.*` and the per-scene env dropdowns render correctly (the Task 0 layout fix).

- [ ] **Step 2: Local streaming.** Same, **streaming ON**, **server OFF**. Confirm the ZIP now contains `index.html` + `lod-meta.json` + LOD chunk folders for the primary AND `scenes/1/lod-meta.json` + `scenes/1/`-namespaced chunk folders + `scenes/1/scene.voxel.*`. (Runtime loading of streaming extra scenes is the parent plan's Task 8 spike — note the result; export correctness is what this step gates.)

- [ ] **Step 3: Server SOG.** Same, **streaming OFF**, **server ON**. Confirm the downloaded ZIP matches Step 1's layout (server produced the multi-scene bundle).

- [ ] **Step 4: Server streaming.** Same, **streaming ON**, **server ON**. Confirm the ZIP matches Step 2's layout.

- [ ] **Step 5: Zero-portals regression.** Delete all portals; export each combination (local/server × streaming/SOG). Confirm single-scene output with no `scenes/`, no `__supersplatPortals`, no errors.

- [ ] **Step 6: Update the ledger + parent docs.** Record outcomes in `.superpowers/sdd/progress.md`. Note in the parent kickoff memo that the streaming/server limitation is lifted.

- [ ] **Step 7: Finish.** Return to the parent plan's remaining tasks (viewer runtime + locales + the full E2E), or, if this is the final piece, invoke `superpowers:finishing-a-development-branch` — squash all branch commits (incl. docs) into ONE, do NOT push unless asked.

---

## Self-Review

**Spec coverage:**
- Streaming local export of portals → Task 1. ✓
- Re-enable both UI toggles for portals → Task 2. ✓
- Shared, order-stable resolver (kills the local/server divergence risk) → Task 3, consumed by Tasks 4 + 5. ✓
- Server multi-PLY transport (client) → Task 5; (server parse + assemble) → Task 6. ✓
- Zero-portals byte-for-byte invariant → guarded in every task; explicitly re-verified in Task 7 Step 5. ✓
- HTML single-file limit preserved (guard kept; client never sends portal extras for HTML) → Tasks 1, 6. ✓

**Placeholder scan:** No "TBD"/"handle errors appropriately"; the one environment-dependent unknown (whether the minimal PLY parses CPU-side in Task 6 Step 4) has an explicit fallback in the step.

**Type consistency:** `PortalExtra` / `resolvePortalExtras` defined in Task 3, consumed with identical field names in Tasks 4–5. `portalExtras` wire shape (`{ seed, environment, collisionUrl, streaming }[]`) identical in Task 5 (client emit) and Task 6 (`ExportOptions` + parse). `writeViewerCore`'s `extraScenes` 10th-arg position consistent between Task 1 (streaming forward) and Task 6 (server call). `ExtraPortalScene` shape (`{ dataTable, streaming, collisionUrl, environment, seed }`) matches between the existing `writePortalScene` and the server's `buildExtraScenes`.

**Known ordering invariant:** the uploaded `extraPly` part order, the `portalExtras` array order, and `bundle.sceneUids.slice(1)` MUST coincide. All three derive from the same `resolvePortalExtras(...).extras` ordering on the client; the server consumes them positionally. Do not reorder parts.
