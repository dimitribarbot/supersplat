# Hand-off: upstream merge + splat-transform v3 — Phase 1 E2E & Phase 2

Date: 2026-07-24 · Branch: `merge-latest-upstream-commits`

This memo hands off two things to a fresh session: (1) finishing **Phase 1**
(user E2E + git finalization), and (2) the state of **Phase 2** (deferred).

Full blow-by-blow of the whole effort is in the SDD ledger
`.superpowers/sdd/progress.md` (gitignored). Spec/plan:
`docs/superpowers/specs/2026-07-24-upstream-merge-splat-transform-v3-design.md`,
`docs/superpowers/plans/2026-07-24-upstream-merge-splat-transform-v3.md`.

---

## 1. Current git state (READ FIRST)

Everything is committed on `merge-latest-upstream-commits` (NOT pushed; ~49 commits
ahead of `origin/main`):

- **Merge commit `108cb3d`** — a *preserved merge* (parents `7b531bf` fork +
  `cc6e86a` upstream 2.32.2). The LCC2-import regression fix (`file-handler.ts`
  folder-guard, which was wrongly blocking `.lcc2`) was **folded into this commit**
  via amend, so the merge is self-consistent.
- **One follow-up commit on top** — the LCC environment restoration + UX tweaks
  (all user-E2E-verified): `src/io/read/lcc-environment.ts` (new; restores LCC v1 +
  LCC2 skybox), `src/io/read/loader.ts` (wires the environment `combine()`),
  `src/asset-loader.ts` (removed the LOD-select dialog's `/upload` note),
  `test/lcc-environment.test.ts` (new), and this memo.
- **All green:** `npm run lint` 0, `npx tsc --noEmit` 0, front-end `npm run test`
  **355/355**, server `npm run test --prefix server` **47/47** (incl. byte-parity +
  GPU streaming), `npm run build` ok.

### Next steps
1. Run the **Phase 1 E2E** checklist below.
2. Decide whether to keep the two-commit shape or **squash the whole branch** to one
   commit; then **push** (or merge to `main`) — **only after the user says so**.

---

## 2. Phase 1 — remaining E2E checklist (user)

Automated gates are all green; these need a human + real assets. Run a **release**
build (`npm run build`) and, for server-export items, the export server
(`npm run dev` in `server/`).

**Exports (each format):** PLY · compressed PLY · `.splat` · **SOG** · **SPZ** ·
**HTML viewer** · **package (zip) viewer**. (Note: SPZ has a *pre-existing upstream*
browser-abort bug — see `spz-export-browser-abort-upstream-bug` memory — not caused
by this merge; don't chase it.)

**Custom subsystems:**
- **Portal walkthrough** streaming export + the exported streaming viewer.
- **Collision** export (voxel).
- **S3 publish** (incl. portal multi-scene).
- **Exported-viewer runtime:** VR/AR floor grounding, off-limits **R-reset**, portal
  reset-scene. (These are `viewer-engine-patch.ts` string patches, now 3 of them,
  retargeted to engine 2.21 — a miss only `console.warn`s, so verify the *features*
  actually work in the exported viewer.)

**LCC (user already verified working):** LCC v1 + LCC2 import **with environment
(skybox)**; lone-`.lcc`/`.lcc2` shows the folder-required modal; LOD dialog has no
`/upload` line. Re-confirm skybox **placement/orientation** on a few real scenes —
the one un-provable-without-real-files risk is the `combine()` coordinate transform
(3.1.6's `combine` bakes to identity; should render identically, but eyeball it).

**Belt-and-suspenders (optional, from the final review):**
- Export the **same scene** compressed-ply locally vs "on server" and `diff` the
  bytes (parity spot-check). Expected identical: both paths converge on the same
  `writeCompressedPly` (v3's `writeSource('compressed-ply')` materializes + delegates).
- Start the **measure or orient tool**, export a PNG/JPEG, confirm no tool overlay
  leaks into the image (the new upstream `overlayLayer` isn't gated in `render.ts`;
  likely already suppressed by `renderOverlays`, but verify — if it leaks, add
  `scene.overlayLayer.enabled = false` alongside the existing gizmo/off-limits gates).

**Locale review:** ~14 machine-translated fork keys across de/es/ja/ko/pt-BR/ru/zh-CN
(the 2 new keys — see `.superpowers/sdd/task-1-report.md`) + the restored
`popup.lcc-upload-warning`. Review translation quality.

---

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

---

## 4. v3 migration cheat-sheet (for anyone touching these paths)

- `writeLod` **removed** → `writeLodSource({ mainSource, envSource, ... })`. Feed a
  structural multi-LOD source: `stackLods(levels.map(l => bakeTransform(dataTableToChunkSource(l), Transform.PLY)))`.
  The `bakeTransform(..., PLY)` is **load-bearing**: v3 `processDataTable` decimate
  rebases each level to `Transform.IDENTITY` while `lod0` is `PLY`; without baking,
  `stackLods` throws "transform mismatch" (caught only by the server GPU test, not tsc).
- `simplifyGaussians` **removed** → `processDataTable(prev, [{ kind: 'decimate', count: target, percent: null }], { createDevice })`.
- `readFile` now returns **`ChunkSource[]`** (was `DataTable[]`) → `materializeToDataTable(sources[0], createChunkDataPool())`.
- `MemoryFileSystem.results` (a `Map`, was `.files` in some versions — fork already uses `.results`).
- `splat-serialize.ts` is a **hybrid**: fork DataTable serializers + grafted upstream
  `writeSplatFile`/`createExportSource`/`WebGPUUnavailableError`. Don't repoint the
  fork serializers at the source API (that's the Phase-2 discussion above).
- `viewer-engine-patch.ts` trimmed 12→3 patches (9 engine backports now baked into
  engine 2.21; kept the 3 fork feature patches).
- The 3.1.6 package I inspected was extracted via `npm pack @playcanvas/splat-transform@3.1.6`
  into a session-local scratchpad (gone in a fresh session — re-`npm pack` if you
  need to read its `dist/cli.mjs`, which has the un-tree-shaken source).

---

## 5. Environment / process notes

- Prefer Git Bash; run commands plainly (no `cd`/`git -C`/`npm --prefix` at cwd,
  except `--prefix server` which targets the subdir).
- Never `rm package-lock.json` on Windows (prunes cross-platform binaries).
- ESLint 10 crashes on `import/order` autofix — don't reorder imports / don't `--fix`
  import order; fix style manually.
- Don't background/pipe `vitest` (it hangs) — run foreground, redirect to a file.
- `dist/` and `dist-shared/` are gitignored; the server bakes its runtime from
  `dist-shared` — after changing `splat-export-core.ts`, rebuild with
  `node scripts/build-shared.mjs` before running server tests.
