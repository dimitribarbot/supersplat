# Portals — Sub-Project 2, Phase 2 (Export + Viewer Runtime): Kickoff Memo

> **Purpose:** Hand-off to continue sub-project 2 in a fresh session. **Phase 1 (editor entrypoint authoring) is DONE and committed.** Read this, then the plan it references, then resume at Task 3.

## Where things stand (as of 2026-06-25)

Branch: **`portals-exported-viewer`** (off `main`; NOT pushed; tip `f239ef1` at hand-off — run `git log --oneline main..HEAD` for the current tip).

**Sub-project 2 = "make the portal walkthrough work in the exported standalone ZIP viewer"** (multiple 3DGS scenes in one bundle, switch the visible scene + its collision at runtime as the camera crosses portals). Background: portals replace an abandoned "merge-cut" tool — two overlapping floor captures can't be fused (CSG on a radiance field can't separate the cross-floor haze), so we keep each scene intact, show one at a time, switch at doorways. Editor portals (sub-project 1) already shipped on `main`.

### The two governing documents (both committed on this branch)
- **Design spec:** `docs/superpowers/specs/2026-06-20-portals-sub-project-2-exported-viewer-design.md` — the approved design (companion-injection, ZIP layout, uid→index mapping, per-scene collision + entrypoint, the two verification-gated risks). **Read this first.**
- **Implementation plan:** `docs/superpowers/plans/2026-06-20-portals-sub-project-2-exported-viewer.md` — 12 TDD tasks across 6 phases, with complete code per step. **This is what you execute. Resume at Task 3.**

### Phase 1 — DONE (Tasks 1–2, committed)
Per-scene **entrypoint** authoring in the editor (a world-space position per scene, used later as the exported collision flood-fill seed). Commits:
- `1f7adf3` Task 1 — entrypoint data model + persistence (`src/portals.ts`, `src/doc.ts`). Pure TDD, 6 tests in `test/portals.test.ts`.
- `e66d5f6` Task 2 — authoring UI in `src/tools/portal-tool.ts` (Entrypoint row, SVG dot overlay, translate gizmo) + `src/ui/scss/select-toolbar.scss`.
- `2d88b46`, `280ce25`, `03f213c`, `f239ef1` — user-review fixes (see "Phase 1 lessons" below).

**User-verified in-app:** set entrypoint from camera, fly away → gizmo auto-appears; click a dot to select/edit; toolbar on one line. All good.

### Phase 1 gives Phase 2 these reusable hooks (already on the branch)
- `events.invoke('portals.export')` → `{ position, rotation, width, height, frontUid, backUid }[]` (added in SP1).
- `events.invoke('portals.startSplat')` → start-scene uid.
- `events.invoke('portals.exportEntrypoints')` → `Record<string /*uid*/, [x,y,z]>` (NEW in Phase 1 — the authored per-scene seeds; absent uids fall back to the portal-derived seed).
- `events.invoke('scene.allSplats')` → ALL splats incl. hidden (use this, NOT `getSplats()`, so hidden portal scenes still export).
- `src/portal-geom.ts` — pure `segmentCrossesRect` / `resolveActiveSplat` (reuse VERBATIM in the viewer companion via `Function.prototype.toString()`, like `off-limits-collision.ts`).

## What Phase 2 is (the remaining plan tasks)

| Phase | Tasks | Deliverable |
|---|---|---|
| 2 — pure export helpers | **3, 4** | `src/portal-export.ts` (playcanvas-free, fully TDD): scene-set + uid→index map + URL maps; two-tier collision-seed resolver (authored entrypoint → portal-derived fallback). |
| 3 — export wiring | **5, 6, 7** | Extend `ExperienceSettings`; per-scene Interior/Exterior UI in `export-popup.ts`; the multi-scene `scenes/N/` serialization loop + per-scene collision voxel + scene-prefixed progress; `injectPortals` payload+companion shell. |
| 4 — **verification spikes** | **8, 9** | ⚠️ **Run these against a REAL export before writing Tasks 10–11.** (1) dynamic streaming gsplat-asset creation + disabled-entity coarse residency; (2) runtime collision swap via reflected constructor + `cameraManager.collision`. Each has a documented fallback (SOG-per-scene; start-only collision) — they may shift scope, so do them first. |
| 5 — viewer runtime | **10, 11** | The injected companion: create one gsplat entity per extra scene (disabled), per-frame `resolveActiveSplat` toggle, per-scene collision preload/swap. App handle = `window.__supersplatViewer.debugPanel._global.app` (fallback `…navCursor.app`). |
| 6 — finish | **12** | Locale strings (all locales — Phase 1 added only `en` for the entrypoint keys), the two-floor `RdC`+`Etage` Maison_Bueil E2E, then `superpowers:finishing-a-development-branch` (squash ALL branch commits incl. docs into ONE, do not push). |

The plan's Task blocks contain the complete code, exact file paths, and TDD steps. Start at **Task 3** (`docs/.../plans/2026-06-20-portals-sub-project-2-exported-viewer.md:463`).

## How to resume (subagent-driven development)

Phase 1 was executed with **`superpowers:subagent-driven-development`** (fresh implementer subagent per task → task review → fix loop → ledger). Continue the same way.

- **Progress ledger:** `.superpowers/sdd/progress.md` (git-ignored scratch). It records Tasks 1–2 + all Phase 1 fixes as complete. **Resume at the first unmarked task (Task 3).** Trust the ledger + `git log` over memory after any compaction.
- Per task: `scripts/task-brief PLAN N` → dispatch implementer with the brief path → `scripts/review-package BASE HEAD` → dispatch task reviewer → fix loop → mark complete in ledger. Scripts live in the skill dir: `~/.claude/plugins/cache/claude-plugins-official/superpowers/6.0.3/skills/subagent-driven-development/scripts/`.
- Model guidance: pure-code transcription tasks (3, 4, 7) → cheap tier; integration/dep-internal (5, 6, 10, 11) → sonnet; spikes (8, 9) are manual investigation, not subagent implementation.

## Project conventions & gotchas (carry into the new session)

- **Build gates are the real gates:** `npx tsc --noEmit` + `npm run build`. **Do NOT run `npm run lint` / `eslint --fix`** — a known pinned-eslint@10 import/order crash on `src/main.ts` fails spuriously, unrelated to this work.
- Tests: `npm test` (vitest). The **3 `server/test/*` failures** (`Cannot find package 'tsx'`) are pre-existing/environmental — ignore.
- Pure logic that must be unit-tested goes in a **playcanvas-free** module (importing the full `playcanvas` under vitest hangs — why `portal-geom.ts`, `alignment-solve.ts`, and the new `portal-export.ts` exist). Note: importing `playcanvas` **only in type position** is fine (esbuild elides it — that's how `portals.ts` is unit-tested via a hand-rolled `Events` double in `test/portals.test.ts`).
- Use the Bash tool (Git Bash). Run commands **plainly — no `cd` / `git -C` / `--prefix` pointing at the cwd** (causes permission prompts).
- `tsc --noEmit` is slow on this project (tens of seconds) and produced unreliable output when backgrounded last session — **run it in the foreground with a generous timeout.**
- Work on this branch; **squash to ONE commit at the very end** (incl. all docs: spec, plan, both kickoff memos). Do NOT push unless the user asks.

## Phase 1 lessons worth knowing (so you don't relearn them)

- **PCUI `SelectInput`:** its `options` setter is a no-op when new options are JSON-equal, and it preserves `_value` across changes — don't assume reassigning options resets the selection.
- **Editor gizmo gotcha (fixed):** a PlayCanvas `TranslateGizmo` attached to a pivot **coincident with the camera** (≈0 distance) renders degenerate and never recovers. The entrypoint gizmo defers its attach until the camera is `> ENTRY_GIZMO_MIN_DIST` (0.5) away (`portal-tool.ts`). Not a viewer concern (the viewer draws no gizmos), but the same "don't trust a zero-distance gizmo" intuition may matter if you ever add viewer-side gizmos (you won't — portals are invisible triggers in the viewer).
- **Floating toolbar CSS:** `position:absolute; left:50%` without an explicit width shrink-to-fits to ~half the screen; with `flex-wrap` that wraps prematurely. Fixed with `width: max-content` capped by `max-width: calc(100vw - 24px)` in `select-toolbar.scss`.
- **`portal-export.ts` does not exist yet** — Task 3 creates it. (Phase 1 referenced it in the plan/spec but only Phase 2 builds it.)

## E2E acceptance (Task 12, the real gate)

Export the two-floor `RdC` + `Etage` Maison_Bueil captures as a ZIP with a stairwell portal (front=RdC, back=Etage, start=RdC), an authored entrypoint on Etage, collision ON (per-scene Interior/Exterior). Unzip, serve, open `index.html`: walk through the stairwell portal → the visible scene swaps and the camera collides against the correct floor. Then re-export with NO portals → confirm the viewer is unchanged (no `__supersplatPortals`, single scene).
