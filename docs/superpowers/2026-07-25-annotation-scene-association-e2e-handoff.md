# Annotation ↔ scene association — E2E hand-off memo

Date: 2026-07-25
Status: **E2E COMPLETE (2026-07-30) — all checks passed, two defects found and fixed**

## E2E outcome (2026-07-30)

Every check below was run on a release build. Sections A, B, C and D all pass.
Two defects surfaced, both fixed and re-verified in the browser:

**1. Hotspot filtering did not work, and the approach was abandoned (check 12).**
`8b27f1a` hid off-scene markers by putting `display: none !important` on the Nth
`.pc-annotation-hotspot`. But that element is an invisible (`opacity: 0`) DOM
*hit-target*; the visible marker is a 3D mesh (`base`/`overlay` render entities).
The filter therefore left every marker on screen while silently killing its click
handler. Given the choice between hiding properly (disable the annotation entity)
and dropping the filter, the user chose **markers visible and clickable in every
scene** — clicking an off-scene marker switches to its scene. `8b27f1a` was
reverted in full, taking the `annotationScenes` payload table with it (it had no
other consumer). See the spec's revised decision row.

**2. The exported viewer showed a stale link on annotations that have none
(check 17).** Pre-existing bug in `src/viewer-companion/annotation-links.ts`
(since `612fdd1`), not introduced here, but found by this E2E. The viewer reuses a
single `.pc-annotation` tooltip and rewrites only its title/text; the link was
injected *and cleared* solely from a hotspot-click handler, so chevron navigation
left the previous annotation's link appended. Fixed by driving injection from
`annotation.activate` (fires on both paths, after the tooltip is populated) and
reading `extras` off the activated annotation. First tests for that companion
added in `test/annotation-links.test.ts`, which executes the emitted runtime
against a fake DOM rather than asserting on the string. Because that bug is
pre-existing and unrelated to this feature, its fix is deliberately kept **out of
the feature squash** and lands as its own commit on top — so it stays visible in
`git log` on `main`.

Two checklist items below are obsolete rather than passed:

- **9** (`annotationScenes` in the payload) — the table no longer exists.
- **21** (hotspot ordering) — the "Nth hotspot = Nth annotation" assumption is
  gone from the codebase entirely; the filter that relied on it is reverted and
  the link companion now reads `extras` directly.

**20** passed with the opposite outcome to the one predicted: activating an
annotation mid-animation does *not* get reverted, because the viewer's own
handler sets `cameraMode = 'orbit'`, and the per-frame timeline dispatch is gated
on `cameraMode === 'anim'`. Recorded in the spec.

## TL;DR (historical — pre-E2E)

Everything is built, reviewed and committed on branch `annotation-scene-association`.
Nothing is pushed, nothing is squashed. The one remaining step is the manual
end-to-end pass below (plan Task 7), which needs a browser and real splat data.
After it passes, squash + merge per "Finishing the branch" at the bottom.

```
branch:  annotation-scene-association
base:    aff409c   (== origin/main == local main, in sync)
head:    fda94ef   (11 commits)
tree:    clean
gates:   vitest 41 files / 413 tests | lint 0 | tsc 0 | npm run build (release) 0
```

Do NOT re-run any implementation task. The progress ledger
(`.superpowers/sdd/progress.md`, git-ignored) records every task as complete with
its commits; trust it and `git log` over any recollection.

## What the feature does

An annotation can now be associated with a splat. In a multi-scene **portal**
export, activating an annotation — via the viewer's prev/next chevrons or by
clicking its hotspot — switches the exported viewer to the scene that annotation
lives in. Annotation markers belonging to a non-active scene are hidden.

Three separate numbering schemes are involved; keeping them apart is the core of
the design:

| Scheme | Where | Why |
| --- | --- | --- |
| splat **uid** | editor session (`sceneUid`) | what the editor has at hand |
| document splat **index** (`sceneIndex`) | `.ssproj` | uids are session-scoped and unstable across loads |
| export scene **index** (`extras.scene`) | exported viewer settings | derived at export by `buildPortalBundle` (start scene first, then first-seen) |

## Commits on the branch

```
fda94ef fix(annotations): pin the runtime bindings in tests and drop the stale-uid fallback
8b27f1a feat(portals): hide annotation hotspots that belong to another scene
b399660 fix(portals): reject a non-finite annotation scene index before dispatching
ea1f6e1 feat(portals): switch scene when an annotation is activated in the exported viewer
e2756ff feat(annotations): scene dropdown in the annotation toolbar, auto-assigned at placement
e794131 feat(annotations): persist the scene association by document splat index
0f9cc7d fix(annotations): default sceneUid at the two other AnnotationData construction sites
a6bf7e8 feat(annotations): associate an annotation with a splat and bake extras.scene on export
307fc80 feat(portals): pure resolver from annotation splat uid to export scene index
d3c9ade docs: implementation plan for annotation-to-scene association
947a831 docs: design spec for annotation-to-scene association in portal exports
```

Design spec: `docs/superpowers/specs/2026-07-25-annotation-scene-association-design.md`
Plan: `docs/superpowers/plans/2026-07-25-annotation-scene-association.md`

## Resuming: get back to a testable state

The release build in `dist/` may be stale by then — rebuild it. **The E2E must be
run on a RELEASE build**: the viewer companion is a stringified template literal
that gets minified into the export, and minification of stringified helpers has
broken this code before. A debug build proves nothing here.

```bash
npm run build > /tmp/ann-build.txt 2>&1    # BUILD_TYPE=release is the default
```

Then serve the app. For a pure front-end pass:

```bash
npm run develop          # http://localhost:3333 — but this is a DEBUG build
```

For the release build plus the export server (needed only if you want to exercise
the server-side export path):

```bash
npm run dev --prefix server   # http://localhost:3334, also serves repo-root dist/
```

## The E2E checklist

### A. Editor (deferred from plan Task 4, Step 11 — a subagent could not drive it)

Load two splats, activate the annotation tool.

1. With **no portals**: the toolbar shows Title / Text / Link URL / Open in New Tab and **no Scene row**.
2. Add a portal wiring the two splats, re-select the annotation: the **Scene row appears**, pre-filled with the splat that was under the cursor when the annotation was placed.
3. Change the dropdown, press **Ctrl+Z** — the value reverts (it commits through `UpdateAnnotationOp`).
4. Set it to **None** — it stays None after re-selecting.
5. Save the `.ssproj`, reload it, re-select — the association survives the round trip.
6. Delete the splat the annotation points at, re-select — the dropdown falls back to **None**, not a stale entry.
7. `?lng=fr` — label reads **Scène**, empty option **Aucune**.

### B. Export

Author a project with at least two splats wired by a portal, an annotation in the
start scene, an annotation in a non-start scene, and one annotation with Scene =
**None**. Export as a ZIP viewer package and unzip it.

8. The settings JSON carries `"scene"` inside `extras` for the scene-assigned annotations and **omits** it for the None one.
9. The injected payload contains `"annotationScenes"`.

### C. Exported viewer

Serve the unzipped export and check:

10. **Cross-scene navigation** — the chevrons cycle every annotation; landing on one in another scene switches the visible scene.
11. **Not-yet-resident target** (streaming export) — navigating to an annotation in an unloaded scene shows the normal loading overlay and completes; no stuck overlay.
12. **Hotspot filtering** — markers of non-active scenes are hidden, and reappear when their scene becomes active.
13. **Unset annotations** — the None annotation flies the camera without changing scene.
14. **Hotspot click** — clicking a marker directly (not the chevrons) switches scene the same way.
15. **Link companion intact** — an annotation with a URL still shows its "Open link" button.
16. **Reset still correct** — press R after an annotation-driven switch: walk/fly restores the spawn scene, orbit/anim restores the start scene, as before.
17. **Single-scene export unaffected** — export a project with no portals; annotations behave exactly as before this branch.
18. **S3 publish** — publish the portal project, repeat checks 10 and 12 against the published URL.

### D. Three additions the final reviewer asked for (no unit test can see these)

19. **Startup scene** — open an export whose **first** annotation lives in a non-start scene. The viewer must still open in the **start** scene, i.e. nothing auto-fires `annotation.activate` at startup. If it does auto-activate, this feature would yank the opening view into another scene.
20. **During animation playback** — activate an annotation while the camera animation is *playing*. In anim mode the per-frame timeline dispatch re-asserts the cursor's scene every frame, so the switch is expected to be **immediately reverted**. This is not a regression (previously nothing switched at all). Confirm it is acceptable, then record it as known behaviour in the spec.
21. **Hotspot ordering** — with 3+ annotations spread across scenes, confirm the right markers are hidden. The filter relies on "Nth hotspot = Nth annotation", an assumption inherited from `src/viewer-companion/annotation-links.ts`. If it is ever violated, the *wrong* hotspots get hidden.

## Known behaviour (already accepted in the design)

The scene swaps immediately while the camera transition plays, so mid-flight you
briefly see the destination scene from the source scene's vantage point. This
matches the existing `reset` behaviour. Deferring the swap to transition-end would
mean flying *through* the old scene's geometry to a pose belonging to the new one.

## Gotchas that bit during implementation

- **`src/viewer-companion/portals.ts` runtime is a template literal.** No backslash escapes (cooked at build time), no backticks (they terminate the literal), ES5 style (`var`, `function`) because it is minified into the export.
- **Making `sceneUid` a required field broke `tsc` at construction sites** that neither vitest nor eslint flags. Run `npx tsc --noEmit` alongside `npm run lint`.
- **Redirect all gate output OUTSIDE the repo** (`/tmp/…`). Three stray `*-output.txt` files were left in the repo root during this work and would have been swept into the squash by `git add -A`.
- **Vitest** must run in the foreground with output redirected to a file — never backgrounded, never piped to `grep`, or it hangs.
- **ESLint v10 crashes on `import/order` autofix** — never run `eslint --fix`.

## Triaged Minors, deliberately not fixed

Recorded so nobody re-litigates them:

- `annotation-tool.ts`: `sceneInput.value` is left stale when the Scene row is hidden. Nothing reads it; `commit()` only fires from the change event.
- ~~three `portals.ts` hotspot-filter minors~~ — moot, the filter was reverted (see E2E outcome).
- `splatList` / `splatName` now duplicated a third time (`alignment-panel.ts`, `portal-tool.ts`, `annotation-tool.ts`). The plan chose mirroring; three copies of four lines is the stated tipping point for whoever adds a fourth.
- The dropdown lists splats no portal references; they resolve to "no scene" at export with no UI signal. Spec decision — placement can precede portal wiring.

## Finishing the branch

Once the E2E passes, use the `superpowers:finishing-a-development-branch` skill.
The established routine in this repo:

1. Tag a backup first: `git tag backup/annotation-scene-pre-squash fda94ef`
2. `git reset --soft aff409c` then one commit summarising all changes including the docs
3. **Verify the post-squash tree hash is identical to the tag's** (`git rev-parse <ref>^{tree}`) so nothing was lost
4. Fast-forward `main` onto it, re-run the gates on `main`, delete the feature branch
5. Push only when the user says so; delete the backup tag after the push

If the E2E fails, fix the defect (with a test wherever the failure is
unit-testable) before squashing.
