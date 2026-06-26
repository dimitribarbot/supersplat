# Portals — Sub-Project 2 (Exported-Viewer Walkthrough): Kickoff Memo

> **Purpose:** Hand-off note to start sub-project 2 in a fresh session with zero prior context. Read this first, then the spec/plan it references.

## Where things stand (as of 2026-06-20)

**Sub-project 1 (editor portals) is DONE and merged to local `main`** (commit `c8226c6` at hand-off; run `git log --oneline -5 main` to find the current tip — `main` is ahead of `origin/main` and NOT pushed). It delivers the full *editor* experience: author portal rectangles between loaded 3DGS scenes, and a non-destructive "Walkthrough" toggle that renders one scene at a time and swaps the visible scene when the camera crosses a portal.

Read these two (both committed under `docs/superpowers/`):
- **Design spec:** `docs/superpowers/specs/2026-06-20-portals-multi-scene-walkthrough-design.md` — **§5 sketches this sub-project.**
- **Implementation plan (sub-project 1):** `docs/superpowers/plans/2026-06-20-portals-editor.md` — shows the patterns/data model you will reuse.

Background context (why portals at all): they replace an abandoned "merge-cut" tool. Merging two overlapping 3DGS floor captures into one asset can't work (constructive solid geometry on a radiance field can't separate the cross-floor "haze"). Portals sidestep merging: keep each scene intact, show one at a time, switch at doorways. The deliverable is a *walkthrough*, not a fused file.

## Goal of sub-project 2

Make the portal walkthrough work in the **exported standalone web viewer** (the published HTML), not just the editor. Today that viewer hosts a **single** splat scene; portals need it to **hold multiple scenes and switch between them** at runtime as the camera crosses portals.

## ⚠️ Do the feasibility spike FIRST — this is the gating unknown

The exported viewer is a **separate runtime** built by the `@playcanvas/splat-transform` dependency (`writeHtml`), not the editor codebase. Off-limits zones work there only because they're injected as a small camera-*clamping* `<script>` — they add no geometry. Portals need real multi-scene capability. Before designing anything, answer:

1. Can `@playcanvas/splat-transform`'s `writeHtml` emit/host **multiple GSplat scenes** in one bundle, with per-scene visibility togglable at runtime?
2. If not: can multiple scene assets be **bundled** (multiple `.ply`/`.sog` payloads or URLs) and a **custom companion script** load + enable/disable them?
3. How does the viewer reference/load scene assets today, and where is the runtime hook to switch them (`window.__supersplatViewer` / its `cameraManager`)?

Investigate `node_modules/@playcanvas/splat-transform` (the `writeHtml` output + viewer bootstrap) and an actual exported HTML bundle. If multi-scene hosting is impossible in the current dependency, the answer might be "wait for / contribute to splat-transform," and that should be surfaced to the user before building.

## Key files for the exported-viewer path (grep to confirm current line numbers)

- `src/splat-export-core.ts` — `buildOffLimitsZonesInjection` builds the `<script>` tags injected into the exported HTML and wires `window.__supersplatViewer`. **Template for a portal injection.**
- `src/viewer-companion/off-limits-collision.ts` — self-contained `segmentBlockedByWall`, injected **verbatim** via `Function.prototype.toString()`. It is portable plain JS (no imports). **This is exactly how to inject portal logic.**
- `src/splat-serialize.ts` — `serializeViewer()`, `writeViewerCore()`, `serializeViewerSettings()`; the bundle + `experienceSettings.json`.
- `src/ui/export-popup.ts` (~680-705) — assembles `ExperienceSettings` (`offLimitsZones`, `offLimitsMessage`). **Extend it with `portals` + the start scene.**
- The viewer reads `experienceSettings.json`; the camera is `window.__supersplatViewer.cameraManager.camera` (read per-frame).

## What sub-project 1 ALREADY gives you to reuse

- **`events.invoke('portals.export')`** (in `src/portals.ts`) already returns the portal array `{ position, rotation, width, height, frontUid, backUid }`. It was added in sub-project 1 and is **currently unused** — it exists precisely for this export step. There is also `events.invoke('portals.startSplat')`.
- **`src/portal-geom.ts`** — pure, **playcanvas-free** `segmentCrossesRect(prev, cur, rect)` and `resolveActiveSplat(prev, cur, portals, currentUid)`, with unit tests (`test/portal-geom.test.ts`). It is portable array math with no imports, so it can be **injected into the viewer the same way `off-limits-collision.ts` is** (Function.prototype.toString or a sibling `viewer-companion/` module). **Reuse this exact logic so the viewer and editor switch identically** — do not reimplement crossing math.
- Data model: `PortalData { position:[x,y,z], rotation:[x,y,z,w], width, height, frontUid, backUid }` (local +Z side = "front"). Plus a global start scene.

## Design decisions to carry over from sub-project 1

- **Switch model:** cross-the-doorway, *stateful*; each portal records the scene on each side (front = local +Z). On crossing, the active scene becomes the side the camera ends on.
- **Topology:** general N-scene graph (any number of scenes/portals).
- **Seeding:** there is a designated **start scene**; the walkthrough begins there and crossings take over.
- **In the viewer, portals are INVISIBLE** — they are transition triggers, not drawn geometry (just like off-limits walls are invisible camera-clampers). So you do **not** need to render the cyan rectangle in the viewer, and the editor-only `zoneDepthTex` depth-pass concern (see below) does **not** apply. The viewer only needs the crossing test + scene visibility swap.

## Critical gotchas / things to solve in the export step

1. **Splat references are editor `uid`s (session-scoped).** Portal `frontUid`/`backUid`/start are splat `uid` numbers, meaningful only in the editor session. The export MUST map each referenced `uid` → the scene's identifier/index in the exported bundle, and rewrite the portal references accordingly. Decide the bundle's per-scene identity scheme during the spike/design.
2. **All portal-referenced scenes must be exported, even hidden ones.** The current export path serializes only *visible* splats (`getSplats()` filters `splat.visible`). A portal walkthrough needs every scene a portal points to, regardless of current visibility. The export must include them all.
3. **Editor depth-pass lesson (context, not a viewer task):** in the *editor*, the portal rectangle's correct occlusion depended on a per-frame splat depth texture (`zoneDepthTex`) rendered in `src/camera.ts onPreRender`; sub-project 1 had a bug where that pass was gated only on off-limits zones, not portals (fixed). This is editor-only — listed so you understand the shared off-limits machinery, not because the viewer needs it.

## Suggested workflow for the fresh session

This is feature work — follow the superpowers flow:
1. **Spike** the dependency question above (investigate, report findings to the user). This may change everything.
2. **`superpowers:brainstorming`** → design sub-project 2 based on spike findings; write a spec to `docs/superpowers/specs/`.
3. **`superpowers:writing-plans`** → implementation plan.
4. **`superpowers:subagent-driven-development`** → execute (as sub-project 1 was: per-task TDD + reviews + a whole-branch review).
5. **`superpowers:finishing-a-development-branch`** → squash to one commit (incl. docs) and merge.

**Verify in the viewer:** export a two-floor scene (e.g. the user's `RdC` + `Etage` Maison_Bueil captures) with a portal in the stairwell, open the exported HTML, navigate through the portal, confirm the visible scene swaps.

## Project conventions & known issues (carry into the new session)

- Work on a feature branch off `main`; squash to ONE commit at the end (including docs); do NOT push unless the user asks (their features live on local `main`, ahead of `origin`).
- Use the Bash tool (Git Bash); run commands plainly with **no `cd`/`git -C`/`--prefix` pointing at the cwd** (causes permission prompts).
- **eslint@10 import/order crash:** `npm run lint` (`eslint src`) crashes on `src/main.ts` from a known pinned-eslint bug — unrelated to your work. **`tsc --noEmit` + `npm run build` are the real gates.** Never run `eslint --fix` on import/order.
- The **3 `server/test/*` failures** (`Cannot find package 'tsx'`) are pre-existing/environmental — ignore them in `npm test` output.
- Tests: `npm test` (vitest). Pure logic that must be unit-tested goes in a **playcanvas-free** module (importing playcanvas under vitest's node env hangs — that's why `portal-geom.ts` / `alignment-solve.ts` exist).
