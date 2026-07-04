# Session Handoff — 2026-07-03 (portal viewer memory + export bug fixes)

Read this first to resume. Full task-by-task history is in `.superpowers/sdd/progress.md`. All work is **local, nothing pushed.**

## Git state at handoff

```
main (2be2420, 3 ahead of origin, NOT pushed)
 ├─ 12a4b70  (prior: upstream v2.28.1 merge)
 ├─ eee0577  (prior: portal splat refs doc-index — Plan #2)
 ├─ d97d195  fix: export start scene → visible scene + name-first labels   [DONE, user-verified]
 ├─ 21c1104  fix: fallback .ssproj save streams from chunks (no >2GB OOM)   [DONE, user-verified]
 └─ 2be2420  feat: Plan 3 — mobile memory bounding (frontier residency)     [DONE, user-E2E'd]

feat/portal-viewer-budget-residency (5f0bd25)   ← rebased ON TOP of main; +7 commits
 └─ budget-bounded residency redesign            [IMPLEMENTED + review-clean; E2E PENDING]
```

## What is DONE (merged to local main)

1. **Plan 3 — mobile memory bounding** (`2be2420`). Exported portal viewer frontier-manages SOG scene assets + collision voxels, caps pinned streaming splats to the device budget, incremental distance-2 warming. User E2E-verified both export variants. Plan: `docs/superpowers/plans/2026-07-02-portal-viewer-mobile-memory.md`.

2. **Three export/save bug fixes** found during the Plan 3 E2E, all user-verified:
   - **Start scene** (`d97d195`): the exported viewer now starts in the Scene-Manager-visible/selected scene (via `preferredStartUid` in `buildPortalBundle`, `src/portal-export.ts`), not the first-portal scene.
   - **Scene names** (`d97d195`): export popup / portal menu / alignment panel / S3 dialog now label scenes `name`-first (`splat.name ?? filename ?? uid`), so `.ssproj`-restored scenes show their real name, not `splat_0.ply`.
   - **Save OOM** (`21c1104`): the non-File-System-Access save path (Brave/Firefox — `window.showSaveFilePicker === undefined`) buffered the whole multi-scene zip into one contiguous `Uint8Array` and OOM'd >2GB. `BrowserDownloadWriter` (`src/io/write/browser-file-system.ts`) now builds the download `Blob` from the chunk array — no contiguous alloc. Byte-identical, format unchanged.

## What is PENDING — resume here

**Budget-bounded residency** (branch `feat/portal-viewer-budget-residency` @ `5f0bd25`). Motivated by the Plan 3 E2E: adjacency-only residency evicts+reloads scenes even on desktop with free memory. New policy: keep as many scenes resident as fit a device budget (frontier guaranteed, LRU-evict only under pressure). For ≤5 scenes → everything resident → no reloads on any device.
- Spec: `docs/superpowers/specs/2026-07-03-portal-viewer-budget-residency-design.md`
- Plan: `docs/superpowers/plans/2026-07-03-portal-viewer-budget-residency.md`
- Implemented via subagent-driven-development, all reviews clean; **Opus whole-branch review = Ready to merge** (no Critical/Important). Gates: 230 vitest, tsc, lint all clean; RELEASE build passes.

Key pieces:
- Pure helper `selectResidentScenes(adjacency, active, recency, sceneCosts, ceiling)` in `src/portal-preload.ts` (priority admission: guaranteed frontier → recency → BFS proximity, until the ceiling).
- Runtime wiring in `src/viewer-companion/portals.ts`: `residentScenes()` (replaces the old `desiredResidentScenes` reconcile calls), `getResidentCeiling()` = `RESIDENT_BUDGET_MULT × getSplatBudget()`, `noteVisit()` recency, `sceneCost()` at `deviceFinest`.
- SOG per-scene count baked in `src/splat-export-core.ts` so SOG shares the same budget accounting.

### To finish (fresh session)

1. `git checkout feat/portal-viewer-budget-residency`
2. Run **Task 4 E2E** (plan Task 4), RELEASE build, 4-scene chained project, BOTH export modes:
   - **Streaming no-reload (core fix):** desktop walk A→B→C→D and back → NO new `200` block fetches on re-cross; memory flat.
   - **Streaming tight budget:** reload `?residentBudget=200000` → far-and-back re-pins evicted scenes (`200`s reappear), memory bounded.
   - **SOG:** 4× `scene.sog` load once, no re-fetch; `?residentBudget=<small>` → SOG evicts (proves baked count honored).
   - **Regression:** collision blocks in B/C; `R` returns to start scene A.
   - **Real phone (priority-1 gate):** no OOM/tab-reload over a ~5-min walkthrough. **Tune the ceiling knob** here: `RESIDENT_BUDGET_MULT` (default `3`) in `src/viewer-companion/portals.ts`, or live via `?residentBudget=<n>`. Lower if memory pressure; raise if scenes reload with headroom.
3. After E2E passes: squash the 7 residency commits into one (record the tuned `RESIDENT_BUDGET_MULT` in the message), then `superpowers:finishing-a-development-branch` → FF-merge to local main. **Do NOT push** unless asked.

### The one residual risk

`RESIDENT_BUDGET_MULT = 3` is a heuristic — the web has no VRAM API, so "never OOM" (priority 1) is best-effort and the real-phone pass is the actual gate. The design errs toward evicting sooner.

## Deferred (Phase 2, NOT started)

Disk-cache-via-service-worker so forced reloads (large projects / tight budget) come from disk not network. Needed only once eviction is real (not the ≤5-scene case). **First diagnose** why re-fetches bypass the HTTP cache on a REAL host (not `npx serve`): small streaming webp ALSO re-fetch as `200`, so it is NOT (just) file size — cause unverified. See the reload discussion in this session.

## Other outstanding series work

Plans **#4–#6** of the 6-plan portal series remain (see the `portal-feature-audit-2026-07-02` memory + `docs/superpowers/plans/2026-07-02-*.md`). Execute in numbered order, separate sessions.

---

## UPDATE (2026-07-03, later session) — E2E round 1 FAILED, root-caused + fixed

Desktop E2E showed re-streaming on every crossing/re-entry. Root causes (full detail in `.superpowers/sdd/progress.md` + the spec addendum): (1) desktop ceiling 3×4M=12M vs ~10.9M resident cost PER scene (whole LOD pyramid at deviceFinest 0) — the "≤5 scenes fit" premise never held; (2) scene 0 was never pin-managed and the engine frees a disabled scene's blocks, so returning to the start scene always re-streamed it. Disk cache was NOT broken (most rows were `(disk cache)`; the 200s were first-time fine-LOD fetches).

Fix (this branch, TDD, all gates green — 233 vitest / tsc / lint / release build): `RESIDENT_BUDGET_MULT` now 12 desktop / 3 mobile (UA split); scene 0 guaranteed + cost-counted + block-pinned. E2E round 2 expectations on desktop: startup loads ALL scenes' pyramids (expected, heavier startup), then ZERO re-streaming on any crossing, including back to the start scene. `?residentBudget=` still available for tuning; mobile pass unchanged.

## UPDATE 2 (2026-07-03) — E2E round 2 FAILED, ceiling made project-aware

Real numbers: scenes' finest counts 5.8M/5.4M/12.8M/8.7M → total pyramid resident cost ~61.3M > the fixed 48M desktop ceiling → neighbours still degraded. Fixed in `dc10b74`: desktop ceiling now = `max(12×splatBudget, min(Σ scene pyramid costs, deviceMemory GB × 16M splats/GB))` via new pure `computeResidentCeiling` (mobile unchanged 3×). For THIS project the ceiling computes to exactly 61.3M → everything resident, no degradation. `pinDesired` now console-logs `[portals] ceiling=… costs=[…] resident=[…] depths=… deviceFinest=… active=…` (deduped) — round-3 E2E should confirm all scenes in `resident` with all depths = deviceFinest (0 on desktop). Gates: 240 vitest / tsc / lint / release build green.
