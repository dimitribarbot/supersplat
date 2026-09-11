# Upstream v3 merge — E2E hand-off

**Written:** 2026-09-10 · **Branch:** `feature/upstream-v3-merge` at `b5e7b2d` · **Backup tag:** `backup/pre-upstream-v3-merge` (= `ae9bd67`)

## Where things stand

The merge of `upstream/main` (`0487778`, one commit past `v3.1.1`) into this fork is **code-complete**. Ten implementation tasks, each independently reviewed; a whole-branch review; and a final fix wave, all clear.

**Every automated gate is green:**

| Gate | Result |
| --- | --- |
| `npx tsc -p tsconfig.json --noEmit` | exit 0 |
| `npm run lint` | clean |
| `npm run test` (front end) | **1105 / 1105**, 72 files |
| `server/` → `npm run test` | **172 / 172**, 27 files |
| **byte-parity** (`server/test/parity-compressed.test.ts`) | **passes** |
| `npm run build` → `grep -c "plugin typescript"` | **0** |
| `npm run lint:locales` | *not* clean — expected, see below |

`lint:locales` reporting drift is **correct and pre-existing**: the nine locales legitimately differ from `en.json` by CLDR plural suffixes only (es/fr/pt-BR/ru carry more plural forms than English, ja/ko/zh-CN fewer) and `scripts/check-locales.mjs` compares key sets naively. Verified identical at the fork tip. The real gate is that no *non*-plural key drifts, and it doesn't.

**Two things remain, both requiring a human:**

1. **The manual E2E** — the checklist below. This is the only gate that can validate the WGSL shader port and the zone-depth pass.
2. **The squash-merge to `main`** — only after the E2E passes.

## Read these first in a fresh session

- **The ledger** — `.superpowers/sdd/2026-09-10-upstream-v3-merge/progress.md`. Git-ignored, still present deliberately. Holds all 28 rulings, per-task evidence, and every deferred item. **If an E2E step fails, this is what identifies which task and which decision to reopen.**
- **The plan** — `docs/superpowers/plans/2026-09-10-upstream-v3-merge.md`. Task 11 is the full E2E checklist; Task 12 is the squash.
- **The spec** — `docs/superpowers/specs/2026-09-10-upstream-v3-merge-design.md`. §2 settled decisions, §4 target architecture, §7 the auto-merge audit results.

## Setup

```bash
npm run build && npm run serve     # release build, http://localhost:3333
```

- Must be a **release** build for anything export-related.
- Must be a **WebGPU-capable browser**. The editor no longer has a WebGL2 path — upstream deleted it, and `src/main.ts` requests `deviceTypes: ['webgpu']` only.
- **Use a scene with multiple splats.** A single-splat scene cannot distinguish a correct zone-depth loop from one that clears on every iteration. Hard requirement.
- **Stop the local AI image-generation server first.** The machine took a `dxgkrnl.sys` bugcheck (`0x7E`) on 2026-09-10 at 21:36 while that server was running. This work was exonerated on evidence — every task ran only `tsc`/`eslint`/`vitest`/`git`, and the editor had never been launched — but the E2E *will* drive WebGPU hard, and running both at once makes a repeat crash unattributable. (WebGPU itself is known good here: all 7 `.gpu.test.ts` server tests execute on a live Dawn device, 21/21, with zero skip paths taken.)

## The four checks that matter most

Nothing automated can touch these. Everything else below is regression-checking.

1. **Zones and portals render *and* occlude.** Walls visible where nothing blocks them, hidden where splats sit in front, updating as the camera moves.
   - Invisible walls ⇒ the **WGSL port** failed (Task 8).
   - Walls that never occlude, or occlude against only one splat in a multi-splat scene ⇒ the **zone-depth loop** failed (Task 7).
2. **Occlusion must not lag fast camera motion by a frame.** That is the specific symptom if the frame-ordering fix (R20) is still wrong.
3. **With a zone present, hide all splats.** The walls must **not** freeze showing ghost occlusion from the hidden splats. This was a real regression found by the final review (I2) and fixed by clearing the depth target when nothing draws.
4. **Save a multi-scene portal document, then reload it.** Portal and annotation references must resolve to the **right** scenes. No test covers this — it is a data-integrity path that only surfaces on reload. Also load a **pre-v3 `.ssproj`** to exercise the legacy v0 branch.

## Expected behaviour — not bugs

- A zone or portal added to a scene with **no splat loaded** is invisible. Pre-existing; the zero-initialised depth texture decodes to "discard everywhere". Load a splat first.
- **PCUI select dropdowns clipped** in the export / S3 / summary dialogs. Pre-existing, fork-only, predates the merge (ruling R23).
- `lint:locales` reporting plural-suffix drift (above).

## The rest of the checklist

Each item traces to a specific defect found and fixed during the merge.

- **Export every format** through the new folder-picker dialog: `ply`, `compressed ply`, `splat`, `sog`, `spz`, `viewer` (html), `viewer` (zip), `viewer settings`, `ssproj`. Correct rows shown, folder picker and filename dialog behave, overwrite path warns, file lands.
- **Server export**: repeat `ply` and `sog` with *Export on server* enabled. It must **not** prompt for a folder (it writes locally through the same stream — ruling R16).
- **Filename validation hint** — type an invalid or existing name; the hint must be **fully readable**. Check `splat` and `ssproj` specifically: those were the clipped variants (rulings R24/R25).
- **ZIP viewer export** — the load poster must be right-way-up and not black (it would have been both before the audit fix).
- **SH column count** — export one **no-SH** scene and one **SH** scene through viewer/SOG at a `maxSHBands` above the scene's actual bands. Both must load and render; a no-SH scene should no longer ship zero-filled SH textures.
- **Kill the export server mid-export** — no stray zero-byte file left behind, and re-exporting to the same filename must succeed.
- **An `.lcc` and an `.lcc2` with a skybox**, if you have one. The skybox restore was rebuilt on an entirely different mechanism (`combine()` → `conformToSceneLayout` + `concatSource`), its 25 tests are all *synthetic* LCC-v1 tables, and `readLcc2Environment` has never run against a real sub-file. Confirm the skybox appears, nothing throws, and an export of that scene still looks right.
- **Two zones (or two portals), one selected** — the selected one should be visibly brighter (alpha 110 → 190). Cheapest check that per-mesh `vertex_color` is not aliased.
- **Resize the window** with a zone visible.
- **Exported portal viewer** — loading bar paints at 0% immediately and never regresses, scenes swap at crossings, walkthrough collision works, transition effect plays. Do **not** measure it with the browser cache disabled.
- **Image and video render** — the editor must be left exactly as found: previous tool, Solo state, selection, per-splat visibility, camera.

## If something fails

Report which step, and check the ledger for the owning task. The likely mapping:

| Symptom | Owning task / ruling |
| --- | --- |
| Walls invisible | Task 8 (WGSL port), R21 |
| Walls never occlude / only one splat | Task 7 (zone-depth loop) |
| Occlusion lags camera by a frame | Task 7, R20 |
| Walls frozen with all splats hidden | final fix wave, I2 |
| Portal/annotation refs on wrong scene after reload | Task 5 (document index map) |
| Export writes nowhere / prompts for a folder wrongly | Task 6, R16 |
| Export deleted after succeeding | final fix wave, I1 / R27 |
| `.lcc2` won't open at all | Task 4, I3 — and note the **parked** R28 below |
| Poster black or inverted | Task 9 audit (`render.ts`) |
| Filename hint unreadable | Task 9, R24/R25 |
| Byte parity broken | Task 3 (export bridge) — but note the parity test compares server-vs-server, so it would not catch a *local/server* divergence |

## Known residual — parked, recommended follow-up

**R28**: `readLccEnvironment` can throw, which fails the whole file load rather than merely dropping the skybox. Concretely, `resolveLcc2EnvFile` is called *outside* `readLcc2Environment`'s own `try` (`src/io/read/lcc-environment.ts:279`) and its legacy branch maps over `root.files` after only an `Array.isArray` check, so a non-string element throws `TypeError`. Weaker second hole: `conformToSceneLayout`'s `for (... of sceneLayout.extraColumns)` with `strictNullChecks` off.

Parked because the trigger is a **malformed** `meta.lcc2`, whereas every case the fix closed occurs with **valid** files whose environment merely disagrees on layout. Cheapest complete fix is at the `lcc-environment.ts` level, not in `loader.ts`.

Other deferred items are listed in the ledger, including one pre-existing data-loss path (`showCollisionSummary`'s synchronous siblings) and seven orphaned locale keys. **Warning for any dead-key sweep: four keys that look orphaned are live — the *server* emits them as SSE `loc` keys**, so a sweep scanning only `src/` would delete working strings.

## After a successful E2E

Task 12 in the plan. In short:

```bash
git switch main
git merge --squash feature/upstream-v3-merge
git commit          # message covers the upstream range, the WebGPU-only and
                    # service-worker decisions, the four subsystem ports, and the docs
git push origin main
git branch -D feature/upstream-v3-merge
git tag -d backup/pre-upstream-v3-merge     # only after confirming the push
```

**The squash is load-bearing, not cosmetic.** Commit `b81dbde` deliberately contains unresolved conflict markers — git refuses any commit while `MERGE_HEAD` has unmerged index entries, so one had to land before the resolution work could be split into reviewable pieces (ruling R6). Skipping the squash would publish those markers to `main`.

Then delete the SDD workspace (`.superpowers/sdd/2026-09-10-upstream-v3-merge/`) — git history becomes the record at that point.
