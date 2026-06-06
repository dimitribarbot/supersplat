# RESUME — Collision detection feature (handoff for a new session)

Date: 2026-06-06

## Where things stand

**Branch:** `feature/collision-detection-zip-export` (base: `main` @ `1e8755b`). Working tree is **clean**; everything below is committed. 15 commits ahead of `main`.

This branch adds **collision detection to SuperSplat's viewer ZIP export**: voxelize the scene via `@playcanvas/splat-transform`'s `writeVoxel`, bundle `index.voxel.json` + `index.voxel.bin` into the ZIP, and repoint the exported viewer's `collisionUrl` to load it. It also localized export-dialog labels and the annotation "Open link" text.

### DONE and verified (committed)
1. **Core collision feature** (commits `ce6b4bd`…`baca589`, plus fixes `0d1ade4`, `3f0e80f`):
   - `src/collision-voxel-options.ts` — pure helpers (`collisionSeedFromSettings`, `collisionVoxelOptions`) + types.
   - `src/splat-export-core.ts` — `writeCollisionVoxel` + `repointCollisionUrl`; threaded a `collision` param through `writeViewerCore`/`writeStreamingViewerCore` (voxelize before streaming LOD build; repoint after the viewer HTML is finalized).
   - `src/splat-serialize.ts`, `server/src/run-export.ts` — `collision` option plumbed through local + server export.
   - `src/ui/export-popup.ts` — "Collision Detection" toggle + Indoor/Outdoor select (ZIP-only).
   - `static/locales/*.json` — collision keys.
   - `server/test/collision.gpu.test.ts` — GPU integration test (passed on a GPU machine: voxel files present + collisionUrl repointed; absent without collision).
   - Indoor → external-fill (`navExteriorRadius: 1.6`, `navSeed`); Outdoor → floor-fill (`floorFill: true, floorFillDilation: 1.6`). No carve. Seed = start camera position, passed in **world space, no flip** (verified against the library).
   - Verification: `npm run build`, `npm run lint`, root unit tests, and the full server suite (`cd server && npx vitest run`, 29/29) all GREEN.
2. **Localization** (commit `62de325`): translated Collision Detection / Environment / Indoor / Outdoor / Export on server into the 8 non-English locales; added `annotation.open-link` to all 9; editor overlay uses i18next; the **exported viewer localizes "Open link" via `navigator.language`** (9 langs, base-subtag + English fallback) since it has no i18next. ("Streaming" left as-is.)
3. **Diagnostic logging** (commit `e5e51fd`): `writeCollisionVoxel` logs the exact underlying `writeVoxel` error (object + stack + `cause`) to the console before throwing the user-facing summary.

### NOT done yet — the reason we're handing off
The user tested on a large scene and hit an error. **Confirmed root cause** (via the diagnostic logging): `RangeError: Set maximum size exceeded` in splat-transform's `filterAndFillBlocks` — V8 caps a `Set` at 2²⁴ ≈ 16.7M, and a large scene produces >16.7M fully-solid 4×4×4 voxel blocks at 0.05 m. The **GPU pass succeeds**; the limit is the CPU-side solid-block count, and the throw is a synchronous `RangeError` *after* GPU cleanup (so retrying coarser is safe).

**The large-scene fix is designed and planned but NOT implemented:**
- Spec: `docs/superpowers/specs/2026-06-06-collision-large-scene-design.md`
- Plan: `docs/superpowers/plans/2026-06-06-collision-large-scene.md` (8 tasks, full code, ready to execute)

Approach: voxelize only a **sphere of radius R around the start position** + **auto-coarsen the voxel size** (ladder from the user's voxel size up to a 0.4 m floor) until the solid-block count fits; clear, actionable error if even 0.4 m fails. Expose **Collision radius (m)** and **Voxel size (m)** sliders in the dialog (localized). Tiling+merge deferred (no octree-merge API; viewer loads a single file).

## How to resume (next session)

1. Read the two docs above (spec then plan).
2. Execute `docs/superpowers/plans/2026-06-06-collision-large-scene.md` task-by-task — use **superpowers:subagent-driven-development** (dispatch a fresh subagent per task, spec-review then code-review each) or **superpowers:executing-plans**. The plan has exact code for every step.
3. After Task 8 verification, the user must **manually test** the export on their large scene (restart the export server first so it reloads `dist-shared`).
4. Then run **superpowers:finishing-a-development-branch**: per the user's standing rule, **squash ALL feature commits into one** summarizing the whole change (collision + localization + large-scene fix + docs), then offer merge-to-`main` vs PR. (Finishing was paused mid-flow to add localization, then this fix.)

## Critical conventions / gotchas (the user is strict about these)

- **No redundant `cd`/`git -C`/`npm --prefix` targeting the current dir** — it triggers permission prompts the user finds very annoying. Use absolute paths for Read/Bash instead of `cd`-ing into subdirs to investigate. (I drifted cwd twice this session by `cd`-ing into `node_modules/...` for greps — avoid that; pass absolute paths to `grep`/`sed` or use the Grep/Read tools.)
- **Server tests**: allowlisted form is exactly `cd server && npx vitest run <args>` (no subshell `( … )`, no trailing pipe). This drifts cwd to `server/`; do root commands first. From `server/`, commit with paths relative to `server/` (e.g. `git add test/collision.gpu.test.ts`).
- **`dist-shared`**: the server loads the shared core from repo-root `dist-shared/` (gitignored). After editing `src/splat-export-core.ts` (or anything it imports), run `node scripts/build-shared.mjs`, and **restart the running export server** (Node caches the dynamic import).
- **eslint@10 `import/order` autofix CRASHES** on this repo — keep new relative imports in **alphabetical order** to avoid triggering it (don't try to "fix" eslint/import-x). Match style: 4-space indent, single quotes, `operator-linebreak` puts `?`/`:` at line END, double-quoted strings flagged (use single quotes / escapes).
- **Root `npm test` shows 3 pre-existing failures** (`routes`, `worker-roundtrip`, `worker-progress.gpu`) with `Cannot find package 'tsx'` — these only happen when the root vitest runner sweeps `server/test` (the worker subprocess can't resolve `tsx` from the repo root). They are **unrelated to this feature** and pass when run from `server/`. Verify root tests with `npx vitest run test/...` and server tests with `cd server && npx vitest run`.
- **Locales**: 9 files in `static/locales/`; keep every key present in all 9. Do NOT edit `dist/static/locales/*` (build artifacts).
- Memory file (auto-loaded): `C:\Users\User\.claude\projects\C--Dev-playcanvas-supersplat\memory\` — see `no-redundant-cd-prefix.md`, `eslint10-import-order-crash.md`.

## Key technical facts (so you don't re-derive them)

- DataTable from `extractDataTable` is in **PLY space** (`Rz(-180)·world`), tagged `Transform.PLY`.
- `writeVoxel` re-applies the PLY transform → voxelizes in **world space** and uses `navSeed` in world space → pass the camera world position **unflipped** as `navSeed`. For the new radius **filtering** of the PLY columns, flip the seed to PLY space: `(x,y,z)→(-x,-y,z)` (distance is rotation-invariant, so radius ≈ metres unless the splat was scaled).
- The exported viewer's `index.html` contains exactly `const collisionUrl = url.searchParams.get('collision') ?? url.searchParams.get('voxel')`; we append `?? './index.voxel.json'` (guarded replace) only when collision is enabled. `writeVoxel({ filename: 'index.voxel.json' })` emits `index.voxel.json` + `index.voxel.bin` into the same MemoryFileSystem that gets zipped.
- Streaming ordering invariant: voxelize the FULL-res table **before** `buildStreamingLodTable` consumes it; repoint `collisionUrl` **after** the viewer HTML is finalized.
