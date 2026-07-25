# splat-transform v3 Phase-2 Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record splat-transform v3 Phase 2 as complete, remove dead/incorrect code left by the merge, and make portal-scene extraction lazy so peak export memory is one scene instead of N.

**Architecture:** Three independent parts. Part A is documentation only. Part B removes a dead locale key, a stale function name, and four missing `ChunkSource.close()` calls. Part C changes the shared editor ↔ server `ExtraPortalScene` contract from an eager `dataTable` to a `loadDataTable()` thunk, loads one scene's table at a time inside `writePortalScene`, and reorders the package branch so the per-scene gaussian counts baked into `index.html` come from the write loop's return values instead of from resident tables.

**Tech Stack:** TypeScript (strictNullChecks off), Rollup, Vitest, `@playcanvas/splat-transform` 3.1.6, PlayCanvas 2.21, i18next, Fastify (export server).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-25-splat-transform-v3-phase2-closeout-design.md`. Read it before starting.
- **Do not** convert any producer to `writeSource` / `writeSogSource` / `decimateSource`. Findings 1-2 of the spec show no benefit and real byte-parity risk. Out of scope.
- **Do not** change any writer's input bytes or options. The browser↔server byte-parity guarantee must hold; progress and memory changes are UI/lifetime-only.
- Prefer Bash (Git Bash). Run commands plainly — no `cd` / `git -C` / `npm --prefix` pointing at the cwd (triggers permission prompts). `--prefix server` is the one allowed exception since it targets a subdir.
- Never run `rm package-lock.json` (prunes cross-platform binaries on Windows).
- ESLint 10 crashes on `import/order` autofix. Never run `eslint --fix` for import order; never reorder imports. Fix style manually.
- Never background or pipe `vitest` — it hangs. Run it in the foreground and redirect output to a file, then read the file.
- `dist/` and `dist-shared/` are gitignored. The export server bakes its runtime from `dist-shared/`, so after **any** change to `src/splat-export-core.ts` you MUST run `node scripts/build-shared.mjs` before running server tests, or the tests exercise the old contract.
- Locale files live in `static/locales/<lang>.json`. There are exactly 9: `en`, `fr`, `de`, `es`, `ja`, `ko`, `pt-BR`, `ru`, `zh-CN`. `npm run lint:locales` (`scripts/check-locales.mjs`) enforces that every locale has **exactly the same keys in exactly the same order** as `en.json` — so an inserted key must go at the *same position* in all 9 files, and a deleted key must be deleted from all 9. Baseline before this work: `✔ All 8 locales are in sync with en.json (459 keys).` Run it after every locale edit.
- `npm run test --prefix server` has a `pretest` hook that already runs `build:shared`, so `dist-shared/` is rebuilt automatically by that command. The explicit `node scripts/build-shared.mjs` step is still worth running when you want to see the shared build succeed on its own.
- New i18n key, exact value per locale (use verbatim):
  - `en`: `Extracting scene data`
  - `fr`: `Extraction des données de la scène`
  - `de`: `Szenendaten werden extrahiert`
  - `es`: `Extrayendo datos de la escena`
  - `ja`: `シーンデータを抽出中`
  - `ko`: `장면 데이터 추출 중`
  - `pt-BR`: `Extraindo dados da cena`
  - `ru`: `Извлечение данных сцены`
  - `zh-CN`: `正在提取场景数据`
- Branch: `merge-upstream-part-2` (currently identical to `main`). Do not push; do not merge to `main`. Committing locally is expected and encouraged.

---

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `docs/superpowers/2026-07-24-upstream-merge-v3-phase1-e2e-and-phase2-handoff.md` | Modify §3 | Records Phase 2 as complete-by-analysis |
| `C:\Users\User\.claude\projects\C--Dev-playcanvas-supersplat\memory\upstream-merge-splat-transform-v3-done.md` | Modify | Keeps project memory consistent with the memo |
| `static/locales/*.json` (9 files) | Modify | Remove `popup.lod-upload-note`; add `export.progress.extracting-scene` |
| `src/splat-export-core.ts` | Modify | `ExtraPortalScene` contract, lazy load in `writePortalScene`, `mainSource.close()`, package-branch reorder, `fireExtracting` helper, rename `buildStreamingLodTable` |
| `src/splat-serialize.ts` | Modify ~1485 | Browser caller passes a `loadDataTable` thunk |
| `src/io/read/lcc-environment.ts` | Modify 253, 259 | Missing `source.close()` |
| `server/src/run-export.ts` | Modify 89, 178-199 | Missing `close()`; lazy extra-scene loader |
| `server/test/zip-helpers.ts` | Create | Shared PLY/ZIP test helpers, extracted from `streaming.gpu.test.ts` |
| `server/test/streaming.gpu.test.ts` | Modify | Import the shared helpers; add 2-scene streaming GPU test |
| `server/test/package-portal.gpu.test.ts` | Create | 2-scene non-streaming (package) GPU test — covers the reorder |

Task order matters: Task 4 (tests) is written before Task 5-7 (the refactor) so it fails first. Tasks 1-3 are independent and can be done in any order.

---

### Task 1: Close out Phase 2 in the docs

**Files:**
- Modify: `docs/superpowers/2026-07-24-upstream-merge-v3-phase1-e2e-and-phase2-handoff.md` (§3, lines 81-107)
- Modify: `C:\Users\User\.claude\projects\C--Dev-playcanvas-supersplat\memory\upstream-merge-splat-transform-v3-done.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by later tasks. Documentation only.

- [ ] **Step 1: Replace §3 of the hand-off memo**

Find the section beginning `## 3. Phase 2 — full source-API migration (deferred; mostly NOT worth it)` and ending immediately before `## 4. v3 migration cheat-sheet`. Replace the whole section with:

```markdown
## 3. Phase 2 — COMPLETE (do not re-open)

**Verdict (2026-07-25): there is nothing left to migrate.** Verified against the
3.1.6 `.d.ts` files, call site by call site:

| Fork call site | Status in 3.1.6 | Migration value |
| --- | --- | --- |
| `writeSog({dataTable})` | **already a thin adapter over `writeSogSource`** — "Wraps the table as a resident ChunkSource via the migration shim and encodes it through the same path"; `writeSogSource` itself is not re-exported from the package root (`dist/lib/index.d.ts` exports `writeSog`/`writeLodSource` but not it) | **zero** — migrating would inline the adapter, and the adapter's own target isn't even public |
| `writeHtml`, `writeVoxel`, `writeSpz` | DataTable-only: `writeSource` accepts these `outputFormat`s but has no *streaming* writer for them, so it materializes to a `DataTable` right at the writer and delegates to `writeFile` anyway (`writeImage` is also DataTable-only but unused by the fork) | **no benefit** — routing through `writeSource` buys nothing |
| `writeCompressedPly` | its `writeCompressedPlySource` sibling is an adapter that *materializes* — compressed PLY is inherently whole-scene | **impossible** |
| `writeLodSource({mainSource})` | modern source API | already migrated |
| `dataTableToChunkSource` / `bakeTransform` / `stackLods` | modern combinators | already used |
| `processDataTable([{kind:'decimate'}])` | source sibling `decimateSource` is stream-once (its `spill` is optional, only used once an intermediate generation exceeds `memoryBudgetBytes`, which defaults to 24 GiB); `writeLodSource` needs random-access **gathers** over `mainSource`, so each level would still have to be materialized/compacted before it could be read back | server-only, and parity-risky |
| server `materializeToDataTable` | required because downstream is `writeHtml`/`writeVoxel`/the `writeSog` adapter | none |

Two further facts that close the "deprecated functions" question:

- **No `@deprecated` tag anywhere in splat-transform 3.1.6.** The DataTable API
  is documented as "compat (secondary)" / "Legacy", which is not deprecation, and
  it cannot be removed while `writeHtml`/`writeVoxel`/`writeSpz` are
  DataTable-only (`writeImage` is also DataTable-only but unused by the fork).
  The DataTable path is the supported end state, not scaffolding.
- **Zero of engine 2.21's 53 `@deprecated` symbols are used by the fork.** The
  `splatBudget` references are all `app.scene.gsplat.splatBudget` (the
  *recommended* property); the deprecated one is `GSplatComponent#splatBudget`.

Also note: splat-transform's README line "resident memory is bounded by chunk
size rather than scene size" describes the **export/transform** side (it sits in
the *Library Usage* section and ends "…the same pipeline the CLI uses"). It says
nothing about the exported viewer, which is the PlayCanvas engine's gsplat
renderer and is already chunk-bounded via streamed SOG + `splatBudget` + the
fork's budget-residency work in `portal-preload.ts`.

A streamed LOD chain is blocked by shape, not just cost: `decimateSource`
"supports a single sequential pass — the PLY-terminal consumption model", while
`writeLodSource` needs random-access **gathers** over `mainSource`. Feeding a
stream-once source into a random-access gather means each level would have to
be materialized (and, once the resident budget forces it, spilled/compacted)
before `writeLodSource` could read it back — landing on the same memory profile
the fork already has, not a smaller one. The CLI never builds an LOD chain by
decimating at all; for `lod` output it requires input that already carries
structural LODs, so there is no upstream pattern to copy.

**What replaced Phase 2:** the real portal-export memory cliff turned out to be
eager per-scene `DataTable` extraction, fixed separately — see
`docs/superpowers/specs/2026-07-25-splat-transform-v3-phase2-closeout-design.md`.

**Still open (unchanged):** the LCC **v1** environment codec vendored in
`src/io/read/lcc-environment.ts` is a faithful port of splat-transform's internal
`deserializeEnvironment`. 3.1.6 still does not export `readLccEnvironmentSource`
(confirmed against `dist/lib/readers/index.d.ts`). File an upstream issue/PR
asking them to export `readLcc[2]EnvironmentSource`; delete the port when they
ship it. LCC2's env already uses the public API.
```

- [ ] **Step 2: Update the project memory file**

Edit `C:\Users\User\.claude\projects\C--Dev-playcanvas-supersplat\memory\upstream-merge-splat-transform-v3-done.md`. Keep its existing frontmatter and body, and replace any wording that says Phase 2 is deferred / infeasible / optional with the completion verdict. Add these sentences to the body:

```markdown
**Phase 2 = COMPLETE by analysis (2026-07-25), do not re-open.** `writeSog` is
already a thin adapter over `writeSogSource`; `writeHtml`/`writeVoxel`/`writeSpz`
are DataTable-ONLY (`writeImage` is also DataTable-only but unused by the fork);
`writeCompressedPly` is inherently whole-scene. splat-transform
3.1.6 has NO `@deprecated` tags, and zero of engine 2.21's 53 deprecated symbols
are used by the fork. The README's "resident memory bounded by chunk size rather
than scene size" is about the EXPORT side, not the exported viewer (which is
already chunk-bounded via streamed SOG + `app.scene.gsplat.splatBudget` +
`portal-preload.ts`). What actually mattered was eager per-scene DataTable
extraction — see [[portal-export-lazy-scene-extraction]].
```

- [ ] **Step 3: Verify no code was touched**

Run: `git status --short`
Expected: only the memo path listed (the memory file lives outside the repo, so it will not appear). No files under `src/`, `server/`, `static/`, or `test/`.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/2026-07-24-upstream-merge-v3-phase1-e2e-and-phase2-handoff.md
git commit -m "docs: record splat-transform v3 Phase 2 as complete by analysis

writeSog is already an adapter over writeSogSource; writeHtml/writeVoxel/
writeSpz are DataTable-only (writeImage is also DataTable-only but unused by
the fork); nothing in splat-transform 3.1.6 or engine 2.21
that the fork uses is deprecated. Replaces the 'deferred' framing so a future
session does not re-litigate it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Remove the dead `popup.lod-upload-note` locale key

**Files:**
- Modify: `static/locales/en.json:170`, and the same line in `fr`, `de`, `es`, `ja`, `ko`, `pt-BR`, `ru`, `zh-CN`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. Independent.

- [ ] **Step 1: Confirm the key really is dead**

Run: `grep -rn "lod-upload-note" src/`
Expected: no output (exit code 1). The LOD-dialog note that used it was removed during the upstream merge.

Run: `grep -rln "lod-upload-note" static/locales/`
Expected: all 9 locale files listed.

- [ ] **Step 2: Delete the line from all 9 locale files**

Each file has the key on line 170, formatted as one line. Delete the whole line, including its trailing comma, from each of the 9 files. Do not reformat anything else. For reference, the `en` line is:

```json
    "popup.lod-upload-note": "Note: you can upload scenes with LODs directly at",
```

- [ ] **Step 3: Verify the JSON is still valid in all 9 files and the key is gone**

Run:
```bash
for l in en fr de es ja ko pt-BR ru zh-CN; do node -e "JSON.parse(require('fs').readFileSync('static/locales/$l.json','utf8'));console.log('$l ok')"; done
grep -rn "lod-upload-note" static/locales/ ; echo "grep exit: $?"
```
Expected: nine `<lang> ok` lines, then no grep matches and `grep exit: 1`.

- [ ] **Step 4: Run the locale consistency gate**

Run: `npm run lint:locales`
Expected: `✔ All 8 locales are in sync with en.json (458 keys).` — one fewer than the 459 baseline. If it reports a missing/stale/out-of-order key, you deleted the line from some files but not all; fix and re-run.

- [ ] **Step 5: Commit**

```bash
git add static/locales
git commit -m "chore: drop dead popup.lod-upload-note locale key

The LOD-select dialog's /upload note was removed during the upstream merge,
leaving the key with zero references in src/. Deleted from all 9 locales.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Add the missing `ChunkSource.close()` calls

**Files:**
- Modify: `server/src/run-export.ts:88-91`, `server/src/run-export.ts:187-189`
- Modify: `src/io/read/lcc-environment.ts:252-253`, `src/io/read/lcc-environment.ts:258-259`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. Independent of Tasks 1-2 and of the Part C tasks. (Task 6 rewrites the `run-export.ts:187-189` region; if Task 6 is done first, apply the `close()` there instead of here and note it.)

Background: `materializeToDataTable` copies the source's data into a `DataTable`; the source itself still holds decode state and, for a `MemoryReadFileSystem`, pins the input PLY bytes. `src/io/read/loader.ts:131` already closes correctly — these four sites are the outliers.

- [ ] **Step 1: Close the primary source in the server export**

In `server/src/run-export.ts`, the current code is:

```ts
    const chunkPool = createChunkDataPool();
    const dataTable = await materializeToDataTable(sources[0], chunkPool);
    // Re-tag: the readback table is not guaranteed to carry the PLY transform.
    (dataTable as any).transform = Transform.PLY;
```

Change to:

```ts
    const chunkPool = createChunkDataPool();
    const dataTable = await materializeToDataTable(sources[0], chunkPool);
    // Release the reader's decode state / the pinned input PLY bytes: the table
    // owns a full copy now. Mirrors src/io/read/loader.ts.
    await sources[0].close();
    // Re-tag: the readback table is not guaranteed to carry the PLY transform.
    (dataTable as any).transform = Transform.PLY;
```

- [ ] **Step 2: Close the extra-scene source in the server export**

In the same file, inside `buildExtraScenes`, the current code is:

```ts
            const t = await materializeToDataTable(esources[0], chunkPool);
            (t as any).transform = Transform.PLY;
```

Change to:

```ts
            const t = await materializeToDataTable(esources[0], chunkPool);
            await esources[0].close();
            (t as any).transform = Transform.PLY;
```

- [ ] **Step 3: Close both environment sources in the LCC reader**

In `src/io/read/lcc-environment.ts`, the current code at the two sites is:

```ts
                const sources = await readFile({ filename: 'meta.json', inputFormat: 'sog', options: defaultOptions, params: [], fileSystem: zipFs });
                return await materializeToDataTable(sources[0], pool);
```

and

```ts
        const sources = await readFile({ filename: chunkPath, inputFormat, options: defaultOptions, params: [], fileSystem });
        return await materializeToDataTable(sources[0], pool);
```

Rewrite each so the source is closed before returning (the `return await` must become a temp so the close happens first):

```ts
                const sources = await readFile({ filename: 'meta.json', inputFormat: 'sog', options: defaultOptions, params: [], fileSystem: zipFs });
                const table = await materializeToDataTable(sources[0], pool);
                await sources[0].close();
                return table;
```

and

```ts
        const sources = await readFile({ filename: chunkPath, inputFormat, options: defaultOptions, params: [], fileSystem });
        const table = await materializeToDataTable(sources[0], pool);
        await sources[0].close();
        return table;
```

- [ ] **Step 4: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: no output, exit 0.

Run: `npm run lint`
Expected: exit 0, no errors.

- [ ] **Step 5: Run the existing LCC and server tests**

Run: `npx vitest run test/lcc-environment.test.ts > /tmp/lcc.log 2>&1; echo "exit: $?"; tail -20 /tmp/lcc.log`
Expected: `exit: 0`, all tests passing.

Run: `npm run test --prefix server > /tmp/server.log 2>&1; echo "exit: $?"; tail -25 /tmp/server.log`
Expected: `exit: 0`. All tests pass (GPU tests included; they self-skip if no GPU is present).

- [ ] **Step 6: Commit**

```bash
git add server/src/run-export.ts src/io/read/lcc-environment.ts
git commit -m "fix: close ChunkSources after materializing to DataTable

readFile's sources hold decode state and, over MemoryReadFileSystem, pin the
input PLY bytes for the whole export. src/io/read/loader.ts already closed
correctly; the server export (x2) and the LCC environment reader (x2) did not.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Failing GPU tests for 2-scene portal export

**Files:**
- Create: `server/test/zip-helpers.ts`
- Modify: `server/test/streaming.gpu.test.ts`
- Create: `server/test/package-portal.gpu.test.ts`
- Test: both test files above

**Decision (user-approved, supersedes the first draft of this task):** the ZIP/PLY
helpers are **extracted into a shared module** rather than duplicated into the new
test file. `server/vitest.config.ts` collects only `test/**/*.test.ts`, so a
`zip-helpers.ts` in that directory is a plain module, not a test file.

**Interfaces:**
- Consumes: `runExport` from `server/src/run-export.js` — signature `runExport({ plyGz: Buffer, options: ExportOptions, sink: { emit(e) }, getDeviceCreator, isCancelled?, extraPlyGz?: Buffer[] }) => Promise<{ files: { name: string, data: Uint8Array }[] }>`. `ExportOptions.portalExtras` is `{ seed: [number,number,number]; environment: 'indoor'|'outdoor'; collisionUrl: string|null; streaming: boolean }[]`, index-aligned to `extraPlyGz`.
- Produces: the two tests that gate Tasks 5-7. No source symbols.

The streaming test is written **first** and must fail against the current code. The package test is a **regression guard** for Task 6's reorder and passes against current code by design (user-approved) — a pure reorder has no new behaviour to drive red-green, and its job is to prove the output did not change. Both pin the observable contract the refactor has to preserve: extra scenes still land under `scenes/1/`, and `portalSceneLodCounts` still has one entry per scene.

- [ ] **Step 1: Extract the shared test helpers**

Create `server/test/zip-helpers.ts` by **moving** (not copying) the five module-level helpers currently at the top of `server/test/streaming.gpu.test.ts` — `NAMES`, `makePlyGz`, `zipEntryNames`, `zipReadEntry`, `experienceSettings`. Copy their bodies and comments verbatim; the only change is that `makePlyGz`'s `n` parameter loses its `= 2048` default (both call sites pass it explicitly) and each helper gets an `export`:

```ts
import { Column, DataTable, Transform, writeFile, MemoryFileSystem } from '@playcanvas/splat-transform';
import { gzipSync, inflateRawSync } from 'node:zlib';

export const NAMES = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

export const makePlyGz = async (n: number): Promise<Buffer> => {
    const cols = NAMES.map((name, i) => new Column(name, Float32Array.from({ length: n }, (_, r) => Math.fround(Math.sin((i + 1) + r * 0.001)))));
    const memFs = new MemoryFileSystem();
    await writeFile({ filename: 'p.ply', outputFormat: 'ply', dataTable: new DataTable(cols, Transform.PLY), options: {} }, memFs);
    return Buffer.from(gzipSync(Buffer.from(memFs.results.get('p.ply')!)));
};
```

followed by `zipEntryNames`, `zipReadEntry` and `experienceSettings`, each `export`ed, with bodies and comments copied verbatim from `streaming.gpu.test.ts`. Do not change any logic.

- [ ] **Step 2: Point `streaming.gpu.test.ts` at the shared module**

Delete the five moved helpers (and the now-unused `@playcanvas/splat-transform` / `inflateRawSync` imports, keeping `gzipSync` only if something else still uses it — if nothing does, drop the `node:zlib` import too) and add:

```ts
import { makePlyGz, zipEntryNames, zipReadEntry, experienceSettings } from './zip-helpers.js';
```

Do not reorder the surviving imports (ESLint 10 crashes on `import/order` autofix). Keep every existing `describe`/`it` body byte-identical.

- [ ] **Step 3: Prove the extraction changed nothing**

Run: `npm run test --prefix server -- test/streaming.gpu.test.ts > /tmp/gpu0.log 2>&1; echo "exit: $?"; tail -30 /tmp/gpu0.log`
Expected: `exit: 0` — the same tests pass as before the extraction. If the GPU probe reports no GPU, the bodies early-return; that is acceptable here (this step only proves the refactor compiles and collects), but note it in your report.

- [ ] **Step 4: Add the 2-scene streaming test to `server/test/streaming.gpu.test.ts`**

Append this new `describe` block at the end of the file, using the imported helpers.

```ts
describe('runExport streaming packageViewer with a portal extra scene (GPU)', () => {
    let gpu = false;
    let res: RunResult | undefined;
    const events: ProgressEvent[] = [];

    beforeAll(async () => {
        gpu = (await probeGpu()).gpu;
        if (!gpu) return;
        const plyGz = await makePlyGz(2048);
        const extraGz = await makePlyGz(1024);
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const session = createGpuSession();
        try {
            res = await runExport({
                plyGz,
                options: {
                    fileType: 'packageViewer',
                    filename: 'out.zip',
                    viewerExportSettings: { type: 'zip', streaming: true, experienceSettings },
                    portalExtras: [{ seed: [0, 0, 0], environment: 'indoor', collisionUrl: null, streaming: true }]
                },
                sink: { emit: e => events.push(e) },
                getDeviceCreator: session.getDeviceCreator,
                extraPlyGz: [extraGz]
            });
        } finally {
            await session.dispose();
            spy.mockRestore();
        }
    }, 240000);

    it('writes the extra scene under scenes/1/ as a streaming bundle', () => {
        if (!gpu) { console.warn('No GPU available; skipping portal streaming GPU test'); return; }
        const names = zipEntryNames(Buffer.from(res!.files[0].data));
        expect(names).toContain('scenes/1/lod-meta.json');
        expect(names.some(n => /^scenes\/1\/0_0\//.test(n))).toBe(true);
    });

    it('bakes one portalSceneLodCounts entry per scene into index.html', () => {
        if (!gpu) return;
        const html = zipReadEntry(Buffer.from(res!.files[0].data), 'index.html').toString('utf8');
        const m = /"portalSceneLodCounts":(\[\[.*?\]\])/.exec(html);
        expect(m).toBeTruthy();
        const counts = JSON.parse(m![1]) as number[][];
        expect(counts).toHaveLength(2);
        // Streaming: every scene contributes its full LOD chain (finest level first).
        expect(counts[0][0]).toBe(2048);
        expect(counts[1][0]).toBe(1024);
    });

    it('extracts scene 2 lazily: its extraction is reported after scene 1 is packaged', () => {
        if (!gpu) return;
        const keys = events.flatMap(e => (e as any).loc?.segments?.map((s: any) => s.key) ?? []);
        const packaged = keys.indexOf('export.progress.packaging-chunks');
        const extracting = keys.indexOf('export.progress.extracting-scene');
        expect(packaged).toBeGreaterThanOrEqual(0);
        expect(extracting).toBeGreaterThan(packaged);
    });
});
```

- [ ] **Step 5: Run the streaming test to verify it fails**

Run: `npm run test --prefix server -- test/streaming.gpu.test.ts > /tmp/gpu1.log 2>&1; echo "exit: $?"; tail -40 /tmp/gpu1.log`

Expected: FAIL. The single-scene tests still pass; the three new ones fail — `scenes/1/lod-meta.json` missing is possible but the certain failure is the third test (`export.progress.extracting-scene` is not emitted at all, so `indexOf` returns -1). If your GPU probe reports no GPU, all bodies early-return and nothing fails: in that case stop and report that the GPU gate is unavailable, because these tests are the only coverage for Tasks 5-7.

- [ ] **Step 6: Create the 2-scene package (non-streaming) test**

Create `server/test/package-portal.gpu.test.ts`, importing the shared helpers from Step 1:

```ts
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { probeGpu, createGpuSession } from '../src/gpu.js';
import { runExport, type RunResult } from '../src/run-export.js';
import { makePlyGz, zipEntryNames, zipReadEntry, experienceSettings } from './zip-helpers.js';

// Covers the package (non-streaming) portal branch, whose portalSceneLodCounts is
// built from the scene write loop's return values rather than from resident tables.
describe('runExport package portal walkthrough, 2 scenes, non-streaming (GPU)', () => {
    let gpu = false;
    let res: RunResult | undefined;

    beforeAll(async () => {
        gpu = (await probeGpu()).gpu;
        if (!gpu) return;
        const plyGz = await makePlyGz(2048);
        const extraGz = await makePlyGz(1024);
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const session = createGpuSession();
        try {
            res = await runExport({
                plyGz,
                options: {
                    fileType: 'packageViewer',
                    filename: 'out.zip',
                    viewerExportSettings: { type: 'zip', streaming: false, experienceSettings },
                    portalExtras: [{ seed: [0, 0, 0], environment: 'indoor', collisionUrl: null, streaming: false }]
                },
                sink: { emit() {} },
                getDeviceCreator: session.getDeviceCreator,
                extraPlyGz: [extraGz]
            });
        } finally {
            await session.dispose();
            spy.mockRestore();
        }
    }, 240000);

    it('writes the extra scene as scenes/1/scene.sog', () => {
        if (!gpu) { console.warn('No GPU available; skipping package portal GPU test'); return; }
        const names = zipEntryNames(Buffer.from(res!.files[0].data));
        expect(names).toContain('scenes/1/scene.sog');
    });

    it('bakes a single-element count per scene into portalSceneLodCounts', () => {
        if (!gpu) return;
        const html = zipReadEntry(Buffer.from(res!.files[0].data), 'index.html').toString('utf8');
        const m = /"portalSceneLodCounts":(\[\[.*?\]\])/.exec(html);
        expect(m).toBeTruthy();
        expect(JSON.parse(m![1])).toEqual([[2048], [1024]]);
    });
});
```

- [ ] **Step 7: Run the package test to verify it passes today**

Run: `npm run test --prefix server -- test/package-portal.gpu.test.ts > /tmp/gpu2.log 2>&1; echo "exit: $?"; tail -30 /tmp/gpu2.log`

Expected: **PASS**. This test describes behaviour that already works — it is a *regression guard* for the reorder in Task 6, not a red test. If it fails now, stop: the assertion does not match current behaviour and must be corrected before any refactor, otherwise it cannot protect anything. (Most likely mismatch: the exact JSON shape of `portalSceneLodCounts` in `index.html`. Read the value out of the ZIP and fix the expectation to whatever the current code actually produces, keeping the two-scene structure.)

- [ ] **Step 8: Commit the helpers and both tests**

```bash
git add server/test/zip-helpers.ts server/test/streaming.gpu.test.ts server/test/package-portal.gpu.test.ts
git commit -m "test: cover 2-scene portal export on both viewer branches

Streaming: asserts scenes/1/ bundle, one portalSceneLodCounts entry per scene,
and that scene 2's extraction is reported after scene 1 is packaged (the lazy
ordering, currently failing). Package: regression guard for the count-collection
reorder. Portal multi-scene export had no GPU coverage before this.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Lazy `ExtraPortalScene` contract + `writePortalScene`

**Files:**
- Modify: `src/splat-export-core.ts` — `ExtraPortalScene` (756-762), `writePortalScene` (517-571), new `fireExtracting` helper, `buildStreamingLodTable` rename (394, 443, 549, 638, 648, 878), `mainSource.close()` (after 562 and after 670)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, for Tasks 6-7:
  - `type ExtraPortalScene = { loadDataTable: () => Promise<DataTable>; streaming: boolean; collisionUrl: string | null; environment: 'indoor' | 'outdoor'; seed: [number, number, number] }`
  - `const buildStreamingLodSource: (lod0: DataTable, createDevice: DeviceCreator, onPhase?: (info: PhaseInfo) => void) => Promise<{ mainSource: ChunkSource; levelCounts: number[] }>` — module-private (renamed from `buildStreamingLodTable`, no longer exported)
  - `const fireExtracting: (events: Events | undefined, index: number, total: number) => void`
  - `writePortalScene(memFs, index, scene, createDevice, radius, voxelSize, onPhase?, onExtract?) => Promise<number[]>` — the returned array is now the counts to bake for that scene: the LOD chain when `scene.streaming`, else `[numRows]`

- [ ] **Step 1: Rename `buildStreamingLodTable` → `buildStreamingLodSource` and make it module-private**

It returns `{ mainSource, levelCounts }`, not a table — the name predates the v3 signature. It is exported but nothing imports it (the server destructures only `writeSogCore` and `writeViewerCore` from `dist-shared`).

Rename the declaration at line 394, the two call sites (549, 648), and the comment mention at 638. Then change the export list on the last line of the file from:

```ts
export { createProgressRenderer, buildStreamingLodTable, writeSogCore, writeViewerCore };
```

to:

```ts
export { createProgressRenderer, writeSogCore, writeViewerCore };
```

Verify: `grep -rn "buildStreamingLodTable" src/ server/src/ test/ scripts/` must return nothing.

- [ ] **Step 2: Add the `fireExtracting` helper**

Insert directly after the `withScene` helper (which ends at line 203). The `PHASES` table is deliberately *not* used here: `PHASES` entries are prefixes that `createProgressRenderer` only applies when splat-transform's logger fires an event, and our extraction fires none — so this must be a direct emit. Shape matches `export.progress.preparing-gpu` in `server/src/run-export.ts` and the handler at `src/ui/editor.ts:423-438`.

```ts
// Report a scene's DataTable extraction directly on the event bus. Extraction is
// our own JS loop and emits no splat-transform logger events, so the PHASES
// prefix mechanism (which only decorates library events) cannot surface it.
// `text` stays English for the server/SSE/log path; `loc.segments` lets the
// browser localize. No step name: the handler appends none when absent.
const fireExtracting = (events: Events | undefined, index: number, total: number): void => {
    events?.fire('progressUpdate', {
        text: `Scene ${index}/${total}: Extracting scene data`,
        progress: 0,
        loc: {
            segments: [
                { key: 'export.progress.scene', params: { index, total } },
                { key: 'export.progress.extracting-scene' }
            ]
        }
    });
};
```

- [ ] **Step 3: Change the `ExtraPortalScene` type**

Replace lines 756-762:

```ts
type ExtraPortalScene = {
    dataTable: DataTable;
    streaming: boolean;
    collisionUrl: string | null;
    environment: 'indoor' | 'outdoor';
    seed: [number, number, number];
};
```

with:

```ts
// The scene's table is a thunk, not a value: portal exports hold one scene
// resident at a time. At SH degree 3 a table is ~236 B/gaussian, so eagerly
// materializing every scene cost ~N x the whole scene before a byte was written.
type ExtraPortalScene = {
    loadDataTable: () => Promise<DataTable>;
    streaming: boolean;
    collisionUrl: string | null;
    environment: 'indoor' | 'outdoor';
    seed: [number, number, number];
};
```

- [ ] **Step 4: Rewrite `writePortalScene` to load lazily, close the LOD source, and return bakeable counts**

Replace the whole function (lines 517-571) with:

```ts
const writePortalScene = async (
    memFs: MemoryFileSystem,
    index: number,
    scene: ExtraPortalScene,
    createDevice: DeviceCreator,
    radius: number,
    voxelSize: number,
    onPhase?: (info: PhaseInfo, counted: boolean) => void,
    onExtract?: () => void
): Promise<number[]> => {
    const base = `scenes/${index}`;
    const sub = new MemoryFileSystem();
    // Materialize this scene's table now and let it die with this call, so scene
    // i is collectable before scene i+1 loads. Peak = 1 table, not N.
    onExtract?.();
    const dataTable = await scene.loadDataTable();
    let counts: number[] = [dataTable.numRows];
    // Voxelize first, on the pristine full-resolution table, before the streaming
    // LOD build reads it. This mirrors the primary scene's collision→LOD order so
    // every scene's progress reads consistently. writeCollisionVoxel does not mutate
    // its input, so the subsequent LOD/SOG build still sees clean data.
    if (scene.collisionUrl) {
        onPhase?.(PHASES.generatingCollision(), false);
        // Synthesise a minimal settings object that places the seed at cameras[0].initial.position
        // so collisionSeedFromSettings picks it up for the per-scene voxel.
        const fakeSettings = { cameras: [{ initial: { position: scene.seed } }] };
        await writeCollisionVoxel(sub, dataTable, fakeSettings, createDevice, { environment: scene.environment, radius, voxelSize });
        // writeCollisionVoxel emits index.voxel.json / index.voxel.bin — rename to scene.voxel.*
        for (const name of ['index.voxel.json', 'index.voxel.bin']) {
            const data = sub.results.get(name);
            if (data) {
                sub.results.set(name.replace('index.', 'scene.'), data);
                sub.results.delete(name);
            }
        }
    }
    if (scene.streaming) {
        const { mainSource, levelCounts } = await buildStreamingLodSource(dataTable, createDevice, (info) => {
            onPhase?.(info, false);   // decimation passes carry their level in the label
        });
        counts = levelCounts;
        onPhase?.(PHASES.packagingChunks(), true);
        await writeLodSource({
            filename: '/lod-meta.json',
            mainSource,
            envSource: null,
            iterations: 10,
            createDevice,
            chunkCount: 512,
            chunkExtent: 16
        }, sub);
        // Release the stacked per-level sources so the decimated LOD chain is
        // collectable before the namespacing pass (the CLI closes here too).
        await mainSource.close();
    } else {
        await writeSog({ filename: 'scene.sog', dataTable, bundle: true, iterations: 10, createDevice, logging: 'silent' }, sub);
    }
    // Namespace every emitted key under scenes/<index>/
    for (const [name, data] of sub.results.entries()) {
        memFs.results.set(`${base}/${name.replace(/^\/+/, '')}`, data);
    }
    return counts;
};
```

Note what changed beyond laziness: `levelCounts` is initialized to `[dataTable.numRows]` and overwritten only in the streaming branch, so the non-streaming branch now returns `[numRows]` instead of `[]`. Task 6 depends on that.

- [ ] **Step 5: Close the primary scene's LOD source too**

In `writeStreamingViewerCore`, immediately after the `await writeLodSource({...}, memFs);` call that ends at line 670, add:

```ts
    await mainSource.close();
```

Same defect as the per-scene one: without it the primary's whole decimated LOD chain stays referenced while every extra scene is written.

- [ ] **Step 6: Typecheck to confirm the contract change surfaces both callers**

Run: `npx tsc --noEmit`
Expected: FAIL with errors at `src/splat-serialize.ts` (still passing `dataTable:`) and at `src/splat-export-core.ts:839` (still reading `s.dataTable.numRows`). These are exactly the sites Tasks 6-7 fix. Do not fix them here.

- [ ] **Step 7: Commit (compiles only after Task 6)**

Because the type change intentionally breaks its callers, commit Tasks 5, 6 and 7's source edits together at the end of Task 7. Skip committing here; go straight to Task 6.

---

### Task 6: Package-branch reorder + browser caller

**Files:**
- Modify: `src/splat-export-core.ts:826-856` (the package branch inside `writeViewerCore`)
- Modify: `src/splat-serialize.ts:1485-1493`

**Interfaces:**
- Consumes from Task 5: `ExtraPortalScene.loadDataTable`, `writePortalScene(..., onPhase?, onExtract?) => Promise<number[]>` returning bakeable counts, `fireExtracting(events, index, total)`.
- Produces: nothing new. Task 7 changes only `server/src/run-export.ts`.

Why the reorder: `portalSceneLodCounts` currently reads `s.dataTable.numRows` for every extra *before* any scene is written. With a thunk there is no table to read, so the counts must come from the write loop's return values — which means the loop has to run before `index.html` is finalized. `writePortalScene` only ever writes under `scenes/<N>/`, so it cannot collide with `index.html` / `index.js`; `repointCollisionUrl` must still run after injection.

- [ ] **Step 1: Reorder the package branch**

The current body of the `else` branch (package/ZIP) runs: `writeHtml` → collision → build `sogSettings` from resident tables → poster/inject → `patchEngineLoaderInMemFs` → `repointCollisionUrl` → scene loop → ZIP. Replace the region from the `const sogSettings = ...` assignment through the end of the scene loop with the scene loop first, then the settings and injection:

```ts
            // Write extra portal scenes under scenes/N/ FIRST: their gaussian
            // counts are only known once each scene's table has been loaded, and
            // those counts are baked into index.html below. Scene writes touch
            // only scenes/<N>/ keys, so they cannot collide with index.html.
            const extraCounts: number[][] = [];
            if (hasPortalScenes) {
                const collRadius = collision?.radius ?? 50;
                const collVoxelSize = collision?.voxelSize ?? 0.05;
                for (let i = 0; i < extraScenes!.length; i++) {
                    const index = i + 1;
                    scenePrefix = { en: `Scene ${index + 1}/${total}`, scene: { index: index + 1, total } };
                    extraCounts.push(await writePortalScene(
                        memFs, index, extraScenes![i], createDevice, collRadius, collVoxelSize,
                        undefined, () => fireExtracting(events, index + 1, total)
                    ));
                }
            }
            const sogSettings = hasPortalScenes ?
                { ...viewerSettingsJson, portalSceneLodCounts: [[dataTable.numRows], ...extraCounts] } :
                viewerSettingsJson;
            const withPoster = applyPoster(new TextDecoder().decode(rawIndex), sogSettings, posterBytes, memFs);
            const injected = injectDeviceFallback(injectPortals(injectOffLimitsZones(injectAnnotationLinks(withPoster, sogSettings), sogSettings), sogSettings));
            memFs.results.set('index.html', new TextEncoder().encode(injected));
            patchEngineLoaderInMemFs(memFs);
            if (collision) {
                repointCollisionUrl(memFs);
            }
```

Everything before (`writeHtml`, the primary `writeCollisionVoxel`, the `rawIndex` guard) and after (the ZIP loop) stays exactly as it is. `rawIndex` is read from `memFs` before the scene loop, so keep its `const rawIndex = memFs.results.get('index.html')` and the throw guard above the new block.

- [ ] **Step 2: Pass `onExtract` in the streaming branch too**

In `writeStreamingViewerCore`, the extra-scene loop currently ends with:

```ts
            extraLodCounts.push(await writePortalScene(memFs, i + 1, extraScenes[i], createDevice, collRadius, collVoxelSize, onSceneProgress));
```

Change to:

```ts
            extraLodCounts.push(await writePortalScene(memFs, i + 1, extraScenes[i], createDevice, collRadius, collVoxelSize, onSceneProgress, () => fireExtracting(events, i + 2, total)));
```

(`i + 2` because the primary is scene 1.)

- [ ] **Step 3: Make the browser caller lazy**

In `src/splat-serialize.ts`, replace:

```ts
    const extraScenes = (experienceSettings.portalScenes && experienceSettings.portalScenes.length > 1) ?
        options.portalScenes?.map(entry => ({
            collisionUrl: entry.collisionUrl,
            environment: entry.environment,
            seed: entry.seed,
            streaming: options.streaming ?? false,
            dataTable: extractDataTable([entry.splat], serializeSettings)
        })) ?? [] :
        [];
```

with:

```ts
    // Descriptors only: each scene's table is extracted inside writeViewerCore,
    // one at a time, so a multi-scene walkthrough no longer holds every scene's
    // float32 columns at once. The Splat elements are already resident in the
    // editor, so the descriptor itself costs nothing.
    const extraScenes = (experienceSettings.portalScenes && experienceSettings.portalScenes.length > 1) ?
        options.portalScenes?.map(entry => ({
            collisionUrl: entry.collisionUrl,
            environment: entry.environment,
            seed: entry.seed,
            streaming: options.streaming ?? false,
            loadDataTable: async () => extractDataTable([entry.splat], serializeSettings)
        })) ?? [] :
        [];
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: FAIL only inside `server/src/run-export.ts` (its `buildExtraScenes` still returns `dataTable:`). No errors under `src/`. Task 7 fixes the server.

- [ ] **Step 5: Proceed to Task 7 without committing**

The tree does not typecheck until the server caller is updated. Do not commit yet.

---

### Task 7: Lazy server caller, locale key, and the full gate

**Files:**
- Modify: `server/src/run-export.ts:176-199` (and its two `buildExtraScenes()` call sites)
- Modify: `static/locales/*.json` (9 files) — add `export.progress.extracting-scene`

**Interfaces:**
- Consumes from Tasks 5-6: `ExtraPortalScene.loadDataTable`, `fireExtracting`.
- Produces: a green tree.

Note: `src/splat-export-core.ts` is deliberately **not** touched in this task. In particular there is no `PHASES.extractingScene` entry — see Task 5 Step 2 for why the label must be a direct `events.fire` instead of a `PHASES` prefix.

- [ ] **Step 1: Make the server's extra scenes lazy**

Replace `buildExtraScenes` with a version that returns descriptors. Each `loadDataTable` does that one scene's gunzip + read + materialize + close, so at most one extra table exists at a time. `chunkPool` and `Transform` are already imported in this file.

```ts
    // One descriptor per uploaded extra portal scene, in upload order (== bundle
    // index 1..N), paired with its client-resolved metadata. The table is built
    // on demand by the shared core, one scene at a time — parsing all of them up
    // front held every scene's float32 columns for the whole export.
    const buildExtraScenes = () => {
        const metas = options.portalExtras ?? [];
        const plys = extraPlyGz ?? [];
        if (metas.length === 0 || plys.length === 0) return undefined;
        return metas.map((meta, i) => ({
            loadDataTable: async () => {
                const raw = Buffer.from(gunzipSync(plys[i]));
                const erfs = new MemoryReadFileSystem();
                erfs.set('extra.ply', new Uint8Array(raw));
                const esources = await readFile({ filename: 'extra.ply', inputFormat: 'ply', options: READ_OPTS, params: [], fileSystem: erfs });
                const t = await materializeToDataTable(esources[0], chunkPool);
                await esources[0].close();
                (t as any).transform = Transform.PLY;
                return t;
            },
            streaming: meta.streaming,
            collisionUrl: meta.collisionUrl,
            environment: meta.environment,
            seed: meta.seed
        }));
    };
```

- [ ] **Step 2: Update both `buildExtraScenes()` call sites**

It is no longer `async`, so drop the `await`. There are two call sites (the `htmlViewer` branch and the `packageViewer` branch). Change each

```ts
        const extraScenes = await buildExtraScenes();
```

to

```ts
        const extraScenes = buildExtraScenes();
```

Run `grep -n "buildExtraScenes()" server/src/run-export.ts` and confirm no `await` remains on any of them.

- [ ] **Step 3: Add the new locale key to all 9 files**

In each `static/locales/<lang>.json`, insert a line immediately **after** the existing `"export.progress.preparing-viewer"` line, using the exact value for that locale from Global Constraints. The position must be the same in all 9 files — `npm run lint:locales` fails on order mismatches, not just missing keys. For `en`:

```json
    "export.progress.extracting-scene": "Extracting scene data",
```

Do this for all 9 files. Verify:

```bash
for l in en fr de es ja ko pt-BR ru zh-CN; do node -e "const j=JSON.parse(require('fs').readFileSync('static/locales/$l.json','utf8'));if(!j['export.progress.extracting-scene'])throw new Error('missing in $l');console.log('$l', j['export.progress.extracting-scene'])"; done
npm run lint:locales
```
Expected: nine lines, each printing the locale and its translation, then `✔ All 8 locales are in sync with en.json (459 keys).` (458 after Task 2's deletion, +1 here). Any missing key throws; any position mismatch fails the locale gate.

- [ ] **Step 4: Typecheck and lint the whole tree**

Run: `npx tsc --noEmit`
Expected: no output, exit 0.

Run: `npm run lint`
Expected: exit 0.

Run: `npm run lint:locales`
Expected: `✔ All 8 locales are in sync with en.json (459 keys).`

- [ ] **Step 5: Run the front-end test suite**

Run: `npm run test > /tmp/fe.log 2>&1; echo "exit: $?"; tail -20 /tmp/fe.log`
Expected: `exit: 0`, all tests pass (355 before this work; the count should be unchanged — no front-end tests were added).

- [ ] **Step 6: Rebuild the shared core, then run the server suite**

The server bakes its runtime from `dist-shared/`. Skipping this step tests the *old* contract and the GPU tests will fail confusingly.

Run: `node scripts/build-shared.mjs && echo "shared build ok"`
Expected: `shared build ok`.

Run: `npm run test --prefix server > /tmp/server.log 2>&1; echo "exit: $?"; tail -40 /tmp/server.log`
Expected: `exit: 0`. All server tests pass, including the parity test, the two new portal GPU tests from Task 4, and the three new streaming assertions (`scenes/1/lod-meta.json`, the 2-entry `portalSceneLodCounts`, and extraction-after-packaging ordering).

- [ ] **Step 7: Confirm the production build still works**

Run: `npm run build > /tmp/build.log 2>&1; echo "exit: $?"; tail -10 /tmp/build.log`
Expected: `exit: 0`.

- [ ] **Step 8: Commit the whole refactor**

```bash
git add src/splat-export-core.ts src/splat-serialize.ts server/src/run-export.ts static/locales
git commit -m "perf: extract portal scenes lazily, one at a time

Portal exports materialized every scene's DataTable up front and held them for
the whole export -- at SH degree 3 (~236 B/gaussian) a 4-scene walkthrough at 5M
gaussians each was ~4.7 GB resident before a byte was written.

ExtraPortalScene.dataTable becomes loadDataTable(); writePortalScene loads one
table, uses it, and lets it die with the call. It also closes the stacked LOD
source (as the CLI does), and the primary scene's is closed too.

The package branch now writes its scenes before finalizing index.html, because
portalSceneLodCounts can no longer be read off resident tables -- it comes from
the write loop's return values, so writePortalScene returns [numRows] rather
than [] when not streaming.

Extraction is reported via a direct progressUpdate (new
export.progress.extracting-scene key, 9 locales): PHASES entries only prefix
splat-transform logger events, and extraction emits none.

Also renames buildStreamingLodTable -> buildStreamingLodSource (it returns a
ChunkSource) and makes it module-private -- nothing imported it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 9: Write the session memory**

Create `C:\Users\User\.claude\projects\C--Dev-playcanvas-supersplat\memory\portal-export-lazy-scene-extraction.md`:

```markdown
---
name: portal-export-lazy-scene-extraction
description: Portal export holds one scene's DataTable at a time; Phase 2 of the splat-transform v3 migration is closed as complete-by-analysis.
metadata:
  type: project
---

Portal multi-scene export was materializing every scene's `DataTable` up front
(`src/splat-serialize.ts`), ~236 B/gaussian at SH3, so a 4-scene 5M-gaussian
walkthrough held ~4.7 GB before writing a byte. `ExtraPortalScene.dataTable` is
now `loadDataTable()`, and `writePortalScene` loads/uses/drops one table per
scene. It also closes the stacked LOD `ChunkSource` (the CLI does; we didn't).

**Why:** the user asked whether splat-transform 3.1.6's "resident memory bounded
by chunk size rather than scene size" could help portals. It could not — that
line is about the export side, and the real cliff was our own eager extraction.

**How to apply:**
- The package (non-streaming) branch must write scenes BEFORE finalizing
  `index.html`: `portalSceneLodCounts` comes from `writePortalScene`'s return
  value, not from resident tables.
- Progress labels for our own (non-library) work must be a direct
  `events.fire('progressUpdate', {loc:{segments}})`. The `PHASES` table only
  *prefixes* events fired by splat-transform's logger, so a PHASES entry for a
  pure-JS step never renders.
- Phase 2 of the v3 migration is CLOSED as complete — see
  [[upstream-merge-splat-transform-v3-done]]. Do not re-open: `writeSog` is
  already an adapter over `writeSogSource`, `writeHtml`/`writeVoxel`/`writeSpz`
  are DataTable-only (`writeImage` is also DataTable-only but unused by the
  fork), and nothing the fork uses is `@deprecated` in
  splat-transform 3.1.6 or engine 2.21.
```

Then add one line to `C:\Users\User\.claude\projects\C--Dev-playcanvas-supersplat\memory\MEMORY.md`:

```markdown
- [Portal export lazy scene extraction](portal-export-lazy-scene-extraction.md) — one scene's DataTable resident at a time (~4.7 GB → ~1×); v3 Phase 2 CLOSED complete-by-analysis; PHASES only prefixes library events.
```

- [ ] **Step 10: Report the E2E checklist to the user**

Automated gates cannot cover the exported viewer. Tell the user to verify, on a **release** build (`npm run build`), a portal walkthrough with ≥2 scenes in **both** streaming and package (ZIP) modes:

1. Every scene loads in the exported viewer and crossings still work.
2. Per-scene collision still works (walk into a wall in scene 2).
3. The progress dialog shows "Scene N/M: Extracting scene data" between scenes.
4. Optional: the same export via the export server ("Export on server") produces a working bundle.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| Part A — memo §3 rewrite + memory update | Task 1 |
| Part B1 — dead `popup.lod-upload-note` | Task 2 |
| Part B2 — `buildStreamingLodTable` rename + un-export | Task 5 Step 1 |
| Part B3 — missing `close()` (server ×2, lcc-environment ×2) | Task 3 |
| Part C — `ExtraPortalScene` contract | Task 5 Step 3 |
| Part C — `writePortalScene` lazy load + `mainSource.close()` + counts | Task 5 Steps 4-5 |
| Part C — package-branch reorder | Task 6 Step 1 |
| Part C — browser caller | Task 6 Step 3 |
| Part C — server caller | Task 7 Steps 1-2 |
| Part C — progress key + direct-emit mechanism | Task 5 Step 2, Task 7 Step 3 |
| Testing — 2 GPU tests + lazy-ordering assertion | Task 4 |
| Gates | Task 7 Steps 4-7 |
| E2E | Task 7 Step 10 |

No gaps.

**Type consistency:** `loadDataTable` (not `loadTable`/`getDataTable`) in Tasks 5, 6, 7. `buildStreamingLodSource` in Task 5 Steps 1 and 4. `fireExtracting(events, index, total)` in Task 5 Step 2 and called in Task 6 Steps 1-2. `writePortalScene`'s 8th parameter is `onExtract?: () => void` in Task 5 Step 4 and supplied positionally after `onPhase` in both Task 6 call sites (the package call passes `undefined` for `onPhase`, matching today's behaviour of not supplying one).

**Known ordering hazard:** Task 3 Step 2 and Task 7 Step 1 both touch the `esources[0]` region of `server/src/run-export.ts`. Task 7's replacement block already contains the `close()`, so whichever runs second wins cleanly — but if Task 7 is applied first, Task 3 Step 2 becomes a no-op and should be skipped rather than re-added.
