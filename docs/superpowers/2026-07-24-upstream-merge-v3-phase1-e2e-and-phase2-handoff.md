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

## 3. Phase 2 — full source-API migration (deferred; mostly NOT worth it)

**Key finding (decisive):** splat-transform 3.1.6 ships a source/streaming writer
for **only** PLY, SOG, and LOD (`writeSource`, `writeSogSource`, `writeLodSource`).
**`writeHtml`, `writeVoxel`, and `writeSpz` are DataTable-ONLY** — no source variant
exists. So the fork's HTML-viewer, collision-voxel, and SPZ export paths **must keep
DataTable permanently**. A "full Phase 2" is therefore largely infeasible; the
DataTable path is the supported end-state, not scaffolding (upstream's own loader
also materializes to DataTable).

**What Phase 2 could still do (optional perf, not correctness):** convert the
**SOG / LOD / PLY** producers in `splat-export-core.ts` from DataTable to streaming
`ChunkSource`s, so peak resident memory is one layer instead of the whole scene —
helps only very large exports. **The risk is the byte-parity guarantee** (server +
browser must stay byte-identical), so it must be gated on the server parity + GPU
tests and E2E. Do this **only if big-scene export memory actually bites.** It's a
small, self-contained follow-up, not a blocking task.

**Related maintenance item (worth an upstream request):** the LCC **v1** environment
codec is now vendored in `src/io/read/lcc-environment.ts` (a faithful port of
splat-transform's internal `deserializeEnvironment`). It could drift if upstream
changes the LCC format (guarded with a fallback, so it degrades to "no skybox").
splat-transform *has* the function (`readLccEnvironmentSource`) but doesn't export
it and tree-shakes it out of the runtime bundle. **File an upstream issue/PR asking
them to export `readLcc[2]EnvironmentSource` (or add a `readFile` option to include
the environment); when they ship it, delete the v1 codec port** and call theirs.
LCC2's env is already read via the public API (no custom codec), so it's low-risk.

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
