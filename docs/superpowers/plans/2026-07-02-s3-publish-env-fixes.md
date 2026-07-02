# S3 Publish Dialog — Per-Scene Environment Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Series note:** This plan is #1 of a 6-plan series written 2026-07-02 against commit `916666a`. Plans 3, 5, and 6 of the series modify `src/viewer-companion/portals.ts`; earlier plans in the series may have merged before this one executes (this plan touches only `src/ui/s3-publish-dialog.ts`, so conflicts are unlikely but not impossible). **Task 0 (preflight) is mandatory:** for each file:line citation and code anchor in this plan, grep to confirm the anchor still exists; if code has drifted, adapt the snippets to the current code rather than pasting blindly.

**Goal:** Port two already-fixed export-popup bugs (wrong start-scene collision environment, and per-scene environment choices resetting on toggle) to the parallel S3 publish dialog, keeping the two dialogs' code deliberately parallel.

**Architecture:** `src/ui/s3-publish-dialog.ts` is a self-contained PCUI dialog whose `show()` returns a promise of `S3PublishOptions`; it duplicates (by design, no shared code) the portal per-scene environment UI of `src/ui/export-popup.ts`. Both fixes are small, local edits to the dialog that mirror commits `8bbf651` and `22e8fcc` already applied to the export popup.

**Tech Stack:** TypeScript, PCUI (`@playcanvas/pcui`) widgets, Rollup build, ESLint. No engine or viewer-runtime code is touched.

## Context

### What this app is (condensed primer)

SuperSplat (repo root `C:\Dev\playcanvas\supersplat`) is a browser-based 3D Gaussian-splat editor built on the PlayCanvas engine + PCUI. This fork adds a **portals** feature: a project can hold multiple scenes (splats); the exported HTML viewer renders one scene at a time and swaps when the camera crosses a doorway (portal rectangle). A single event bus (`src/events.ts`) wires everything: `events.fire/on` is pub-sub; `events.function/invoke` is queryable state (e.g. `events.invoke('portals.count')`, `events.invoke('scene.allSplats')`).

When a multi-scene portal project is exported (or published to S3), each scene's **walk-mode collision voxel** is baked with an Interior (`'indoor'`) / Exterior (`'outdoor'`) "environment" choice that controls how the collision seed/flood-fill behaves. Two UI surfaces collect this choice:

1. **Export popup** (`src/ui/export-popup.ts`) — used by File → Export → viewer ZIP.
2. **S3 publish dialog** (`src/ui/s3-publish-dialog.ts`) — used by File → Publish… when the optional export server (`server/`) is same-origin and S3-configured (`caps.publish === true`; see `src/ui/editor.ts:233-244`).

Both dialogs have the same portal UI shape:

- A **single global** `environment` SelectInput, hidden whenever the project has portals (see `updateCollisionVisibility` — `src/ui/s3-publish-dialog.ts:150-159`).
- A **per-scene** row of Interior/Exterior SelectInputs (`rebuildPerSceneEnv`, one per portal-referenced scene, index-keyed in a `perSceneEnvSelects: Map<number, SelectInput>`; index 0 is always the **start scene**, because `bundle.sceneUids[0]` is the start uid — see `src/portal-upload.ts:47`).
- On confirm, the dialog assembles options containing:
  - `viewerExportSettings.collision.environment` — the environment used to bake the **start scene's** collision (`'indoor' | 'outdoor'`).
  - `experienceSettings.portalEnvironments` — the full per-scene array, read from `perSceneEnvSelects` (s3 dialog: `src/ui/s3-publish-dialog.ts:247`; export popup: `src/ui/export-popup.ts:758`). Extra scenes (index ≥ 1) get their environments from this array via `buildPortalUpload` → `portalExtras[i].environment` (`src/portal-upload.ts:43,62`).

### The two bugs (fixed in the export popup, never ported here)

**Bug 1 — start scene bakes the wrong environment (HIGH).**
`src/ui/s3-publish-dialog.ts:259` (inside `assemble()`):

```ts
collision: collision.value ? { environment: environment.value as 'indoor' | 'outdoor', radius: radius.value, voxelSize: voxelSize.value } : undefined,
```

For a portal project the global `environment` select is **hidden** and stuck at its `'indoor'` default, yet this line still reads it. Consequence: publishing a portal walkthrough whose start scene the user set to Exterior always bakes the start scene's collision as Interior → wrong walk collision in the published viewer. Extra scenes (index ≥ 1) are unaffected because they flow through `portalEnvironments` (line 247), which reads the per-scene selects correctly.

Reference fix: commit `8bbf651` ("fix(portals): use per-scene environment for start scene collision") changed the equivalent line in the export popup (now `src/ui/export-popup.ts:776`) to source the start scene's environment from `perSceneEnvSelects.get(0)?.value` when a portal `bundle` exists, falling back to the global select for non-portal exports.

**Bug 2 — per-scene choices silently reset to Interior on any toggle (HIGH).**
`src/ui/s3-publish-dialog.ts:98-127` (`rebuildPerSceneEnv`) recreates every per-scene SelectInput with `defaultValue: 'indoor'` (line 117) and no persistence. `rebuildPerSceneEnv` is invoked by:

- `streaming.on('change', rebuildPerSceneEnv)` — line 161,
- `collision.on('change', updateCollisionVisibility)` — line 160, which calls `rebuildPerSceneEnv()` at line 157.

So toggling Streaming or Collision after choosing Exterior for some scenes discards every choice back to Interior, silently.

Reference fix: commit `22e8fcc` ("fix(portals): persist per-scene environment across modal toggles") added a **uid-keyed** persistence map to the export popup (`src/ui/export-popup.ts:305-339`): `perSceneEnvValues: Map<number /* scene uid */, 'indoor' | 'outdoor'>`, populated by a `change` handler on each select, used as each recreated select's `defaultValue`, and cleared on reset so every fresh dialog session starts at the default. The map is keyed by scene **uid** (stable per loaded splat) rather than index, so it survives rebuilds even if scene ordering changes.

### Design decision

Port the two fixes **verbatim-in-spirit**, adapted to the s3 dialog's variable names (`environment`/`collision`/`streaming` instead of `environmentSelect`/`collisionToggle`/`streamingToggle`; reset lives inline in `this.show()` instead of a separate reset section). The two dialogs intentionally duplicate this UI (see the comment at `src/ui/s3-publish-dialog.ts:9-11`: "kept local to avoid coupling the two dialog modules"). **Do NOT refactor to share code between the dialogs — that dedup is explicitly out of scope for this plan.** Even if you notice the dialogs have drifted elsewhere, keep changes minimal and confined to these two fixes.

### Testability

PCUI dialog code is **not unit-testable** in this repo's Node vitest environment (no DOM; PCUI widgets require a browser). There is no pure logic worth extracting here — both fixes are one-liner wiring changes inside a constructor closure. Verification is therefore: `npm run lint`, a successful `npm run build` (which type-checks via the Rollup TypeScript plugin), and the scripted manual verification in Task 3.

## Global Constraints

- Use Bash (Git Bash on Windows), never PowerShell. Run all commands plainly from the repo root — no `cd`, `git -C`, or `npm --prefix` prefixes (they trigger permission prompts). Server commands in Task 3 are the one exception (they must run in `server/`; use a separate shell or the documented invocation).
- ESLint is pinned to v10 and **crashes on `import/order` autofix** — never run `eslint --fix` for import ordering; match surrounding import order by hand (this plan adds no imports).
- Never delete `package-lock.json`.
- `tsconfig`: `strictNullChecks: false`, `noImplicitAny: true`. Match surrounding code style; comments explain constraints, not narration.
- Don't touch code unrelated to the task. This plan modifies exactly one file: `src/ui/s3-publish-dialog.ts`.
- Work on a feature branch (created in Task 0). Project convention: when the feature is complete and verified, squash all commits into a single commit summarizing the change.
- Build for manual verification with `npm run build` (release build → `dist/`).

---

### Task 0: Preflight — branch + anchor verification

**Files:**
- Read-only: `src/ui/s3-publish-dialog.ts`, `src/ui/export-popup.ts`
**Interfaces:**
- Consumes: nothing
- Produces: feature branch `fix/s3-publish-env`; confirmed (or adapted) line anchors for Tasks 1–2

- [ ] **Step 1: Create the feature branch**

```bash
git checkout main
git checkout -b fix/s3-publish-env
```

- [ ] **Step 2: Verify every code anchor this plan relies on still exists**

Run each grep; every one must return exactly the shown match (line numbers may have drifted slightly — that is fine, adapt; a *missing* match means the code has changed materially and you must re-derive the edit from the current source before proceeding):

```bash
grep -n "environment: environment.value as 'indoor' | 'outdoor'" src/ui/s3-publish-dialog.ts
# expect 1 match, ~line 259 (inside assemble(), the collision: line)

grep -n "defaultValue: 'indoor'," src/ui/s3-publish-dialog.ts
# expect 2 matches: the global environment select (~line 57) and the per-scene select (~line 117).
# Task 2 edits ONLY the per-scene one (inside rebuildPerSceneEnv).

grep -n "streaming.on('change', rebuildPerSceneEnv)" src/ui/s3-publish-dialog.ts
# expect 1 match, ~line 161

grep -n "perSceneEnvValues" src/ui/s3-publish-dialog.ts
# expect NO matches (if it already exists, Bug 2 was already ported — stop and report)

grep -n "perSceneEnvValues" src/ui/export-popup.ts
# expect ~4 matches (~lines 308, 329, 335, 593) — the reference implementation
```

- [ ] **Step 3: Read the reference fixes** (context for review, no code change)

```bash
git show 8bbf651
git show 22e8fcc
```

Both diffs touch `src/ui/export-popup.ts` only. Tasks 1 and 2 port them, one commit each, to `src/ui/s3-publish-dialog.ts`.

---

### Task 1: Start scene collision environment from its per-scene selector (port of `8bbf651`)

**Files:**
- Modify: `src/ui/s3-publish-dialog.ts` (one line inside `assemble()`, ~line 259)
**Interfaces:**
- Consumes: `bundle` (local const built ~line 228 inside `assemble()`, `null` when the project has no portals), `perSceneEnvSelects: Map<number, SelectInput>` (index 0 = start scene), `environment: SelectInput` (global select), `collision`, `radius`, `voxelSize` widgets — all already in scope.
- Produces: `S3PublishOptions.viewerExportSettings.collision.environment` now carries the start scene's per-scene choice for portal publishes. No signature changes.

**No unit test is possible** (PCUI constructor closure, browser-only). Substitute: lint + build + Task 3 manual verification.

- [ ] **Step 1: Apply the edit**

In `src/ui/s3-publish-dialog.ts`, inside `assemble()` (the `return { ... viewerExportSettings: ... }` block, ~line 259), replace this line:

```ts
                        collision: collision.value ? { environment: environment.value as 'indoor' | 'outdoor', radius: radius.value, voxelSize: voxelSize.value } : undefined,
```

with:

```ts
                        // For a portal publish the start scene (index 0) is hidden from the
                        // global environment select and chosen via its per-scene selector, so
                        // source its environment from there (portalEnvironments[0]); fall back
                        // to the global select for a non-portal publish.
                        collision: collision.value ? { environment: (bundle ? (perSceneEnvSelects.get(0)?.value ?? 'indoor') : environment.value) as 'indoor' | 'outdoor', radius: radius.value, voxelSize: voxelSize.value } : undefined,
```

Notes:
- `bundle` is the local const declared a few lines above in the same `assemble()` closure (`const bundle = (events.invoke('portals.count') ?? 0) > 0 ? buildPortalBundle({...}) : null;`). Do not re-derive it.
- This exactly mirrors the fixed export popup line (`src/ui/export-popup.ts:776`), with the s3 dialog's widget names (`collision`/`environment`/`radius`/`voxelSize` vs. the popup's `collisionToggle`/`environmentSelect`/`radiusSlider`/`voxelSizeSlider`) and without the popup's `viewerTypeSelect.value === 'zip'` guard (the s3 dialog is always `type: 'zip'`).

- [ ] **Step 2: Lint and build**

```bash
npm run lint
```
Expected: exits 0, no new warnings/errors.

```bash
npm run build
```
Expected: Rollup completes, `created dist ...` (or similar) with no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/ui/s3-publish-dialog.ts
git commit -m "fix(portals): use per-scene environment for start scene collision in S3 publish

Ports export-popup commit 8bbf651 to the S3 publish dialog: the start
scene (index 0) sourced its collision environment from the global
environment select, which is hidden when portals are present and stuck
at its 'indoor' default. Source it from the per-scene selector (index 0)
when a portal bundle exists; fall back to the global select otherwise.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Persist per-scene environment choices across toggle rebuilds (port of `22e8fcc`)

**Files:**
- Modify: `src/ui/s3-publish-dialog.ts` (three regions: map declaration ~line 96, `rebuildPerSceneEnv` body ~lines 115-123, `show()` reset block ~line 183)
**Interfaces:**
- Consumes: `perSceneEnvSelects` declaration site, `rebuildPerSceneEnv`'s `bundle.sceneUids.forEach((uid, index) => ...)` loop (where `uid: number` is the scene's stable uid), the reset block inside `this.show()`.
- Produces: new closure-local `perSceneEnvValues: Map<number, 'indoor' | 'outdoor'>` (sceneUid → environment). Not exported; no signature changes.

**No unit test is possible** (PCUI constructor closure, browser-only). Substitute: lint + build + Task 3 manual verification.

- [ ] **Step 1: Declare the persistence map**

In `src/ui/s3-publish-dialog.ts`, directly below the `perSceneEnvSelects` declaration (~line 96):

```ts
        const perSceneEnvRow = new Container({ class: 'per-scene-env', flex: true, flexDirection: 'column' });
        const perSceneEnvSelects = new Map<number, SelectInput>();
```

add:

```ts
        // Chosen environment per scene uid, persisted across rebuildPerSceneEnv()
        // calls (the Streaming/Collision toggles rebuild the rows) so user choices
        // survive. Cleared on show() so each fresh publish starts at the default.
        const perSceneEnvValues = new Map<number, 'indoor' | 'outdoor'>();  // sceneUid -> environment
```

- [ ] **Step 2: Initialise each recreated select from the map and record changes into it**

Inside `rebuildPerSceneEnv`'s `bundle.sceneUids.forEach((uid, index) => { ... })` loop (~lines 110-126), change the SelectInput construction from:

```ts
                const sel = new SelectInput({
                    class: 'select',
                    defaultValue: 'indoor',
                    options: [
                        { v: 'indoor', t: localize('popup.export.environment.indoor') },
                        { v: 'outdoor', t: localize('popup.export.environment.outdoor') }
                    ]
                });
                r.append(sel);
```

to:

```ts
                const sel = new SelectInput({
                    class: 'select',
                    defaultValue: perSceneEnvValues.get(uid) ?? 'indoor',
                    options: [
                        { v: 'indoor', t: localize('popup.export.environment.indoor') },
                        { v: 'outdoor', t: localize('popup.export.environment.outdoor') }
                    ]
                });
                sel.on('change', () => perSceneEnvValues.set(uid, sel.value as 'indoor' | 'outdoor'));
                r.append(sel);
```

Do NOT touch the other `defaultValue: 'indoor'` (the global `environment` select ~line 57).

- [ ] **Step 3: Clear the map on each dialog show**

The s3 dialog resets its widgets inline at the top of `this.show()` (unlike the export popup's separate reset section). In the `// reset` block (~lines 180-186), change:

```ts
            // reset
            streaming.value = true;
            collision.value = true;
            environment.value = 'indoor';
            radius.value = 50;
```

to:

```ts
            // reset
            streaming.value = true;
            collision.value = true;
            environment.value = 'indoor';
            perSceneEnvValues.clear();
            radius.value = 50;
```

Ordering matters: `perSceneEnvValues.clear()` must run **before** the `updateCollisionVisibility()` call a couple of lines below it, because that call triggers `rebuildPerSceneEnv()` which reads the map. The placement above satisfies this.

- [ ] **Step 4: Lint and build**

```bash
npm run lint
```
Expected: exits 0.

```bash
npm run build
```
Expected: build completes with no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add src/ui/s3-publish-dialog.ts
git commit -m "fix(portals): persist per-scene environment across S3 publish dialog toggles

Ports export-popup commit 22e8fcc to the S3 publish dialog: toggling the
Streaming or Collision switch calls rebuildPerSceneEnv(), which cleared
and recreated every per-scene Interior/Exterior selector with its
'indoor' default, discarding user choices. Persist the chosen
environment per scene uid in a map that survives rebuilds (cleared on
show() so each fresh publish starts at the default) and initialise each
recreated selector from it.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Manual E2E verification (RELEASE build + export server)

**Files:**
- None modified. Uses the release build from Task 2 (`dist/`) and the export server (`server/`).
**Interfaces:**
- Consumes: the built app; the export server's `/api/publish` endpoint.
- Produces: verified behavior; no code.

**Preconditions.** The S3 publish dialog only appears when the export server reports `publish` capability, which requires the `S3_*` env vars to be set (see `server/README.md`); without them, File → Publish… falls back to the PlayCanvas-hosted publish dialog and this UI is unreachable. Additionally, the dialog's confirm path calls `GET /api/publish/exists` **before** sending the payload — that endpoint must respond OK (a reachable S3/Spaces config) for the `POST /api/publish` request whose payload you will inspect to be sent at all. If a real S3 config is unavailable, fall back to inspecting the assembled options via a DevTools breakpoint on the `resolve(assemble())` line in `src/ui/s3-publish-dialog.ts` (use a `npm run develop` debug build at http://localhost:3333 for readable source in that case — but note the payload-over-the-wire check below is the authoritative verification).

- [ ] **Step 1: Build the app (release) and start the export server**

```bash
npm run build
```

Then, in a **separate shell**, from the `server/` directory (this is the documented server invocation; it also serves the repo-root `dist/` so the app and `/api/*` are same-origin):

```bash
npm run dev
```

Expected: server listening on http://localhost:3334.

- [ ] **Step 2: Open a multi-scene portal project**

1. Open http://localhost:3334 in Chrome.
2. Load a project containing **two or more splat scenes connected by at least one portal** with a start scene assigned (File → Open a saved `.ssproj` document that has portals, or import two splats and draw a portal with the portal tool). Any existing portal test project used for prior portal-feature verification is fine.

- [ ] **Step 3: Open the S3 publish dialog and verify the per-scene UI**

1. Menu (top-left) → File → **Publish…**. The **S3 publish dialog** must open (header "Publish to S3" / localized equivalent). If the PlayCanvas publish dialog opens instead, the server capability probe failed — recheck the `S3_*` env vars and that you loaded the app from :3334.
2. Observe: the single "Environment" row is hidden; instead one Interior/Exterior selector row per portal-referenced scene is shown (labelled `<uid>: <filename>`); all default to Interior.

- [ ] **Step 4: Verify Bug-2 fix — persistence across toggles**

1. Set the **first** per-scene selector (index 0 = start scene) to **Exterior**. If there are 3+ scenes, set another one to Exterior too.
2. Toggle **Streaming** off, then on again.
3. Toggle **Collision** off, then on again.
4. Expected (fixed): every per-scene selector still shows the value you chose. Broken behavior (pre-fix): all selectors snap back to Interior after each toggle.

- [ ] **Step 5: Verify Bug-1 fix — start scene environment in the request payload**

1. Open DevTools → Network tab (preserve log).
2. Fill in a Name, click **Publish** (confirm overwrite if prompted).
3. Find the `POST /api/publish` request. It is `multipart/form-data`; inspect the `options` form field (Payload tab), which is a JSON string. Verify:
   - `viewerExportSettings.collision.environment` === `"outdoor"` (the start scene's choice — this is Bug 1; pre-fix it was always `"indoor"`).
   - `viewerExportSettings.experienceSettings.portalEnvironments` is an array matching every per-scene selection in scene order, e.g. `["outdoor", "indoor", ...]`.
   - `portalExtras[i].environment` (one entry per extra scene, same order as `portalScenes[1..]`) matches the corresponding choices for the non-start scenes.
4. The publish job itself may succeed or fail depending on your S3 credentials — irrelevant; the payload is the verification target.

- [ ] **Step 6: Verify reset-on-show**

1. Cancel/close any result popup, then reopen File → Publish….
2. Expected: all per-scene selectors are back to Interior (the persistence map is cleared on each `show()`), matching the export popup's per-export-session semantics.

- [ ] **Step 7: Regression check — non-portal publish**

1. Load a single-scene project with no portals (File → New, import one splat).
2. File → Publish…: the single global "Environment" row is visible (no per-scene rows). Set it to Exterior, click Publish, and confirm in the `POST /api/publish` payload that `viewerExportSettings.collision.environment` === `"outdoor"` (the `bundle ? ... : environment.value` fallback path).

---

### Task 4: Final checks and squash

**Files:**
- None modified.
**Interfaces:**
- Consumes: the two commits from Tasks 1–2.
- Produces: a single squashed commit on the feature branch, ready to merge.

- [ ] **Step 1: Run the full verification suite**

```bash
npm run lint
npm run test
```

Expected: lint exits 0; all existing vitest suites pass (this plan adds no tests — the touched code is PCUI-only and not unit-testable in the Node vitest env; nothing in `test/` exercises the dialogs).

- [ ] **Step 2: Squash per project convention**

Squash the branch's commits into a single commit summarizing both fixes (the executor's finishing skill — superpowers:finishing-a-development-branch — handles the mechanics). Suggested squashed message:

```
fix(portals): port export-popup environment fixes to the S3 publish dialog

Two per-scene collision-environment bugs fixed in the export popup
(8bbf651, 22e8fcc) had never been ported to the parallel S3 publish
dialog:

1. The start scene (index 0) sourced its collision environment from the
   hidden global environment select (stuck at 'indoor'), so a portal
   walkthrough with an Exterior start scene always baked Interior walk
   collision. Now sourced from the per-scene selector when a portal
   bundle exists, with the global select as the non-portal fallback.

2. Toggling Streaming or Collision rebuilt the per-scene selectors at
   their 'indoor' default, silently discarding user choices. Choices are
   now persisted per scene uid across rebuilds and cleared on each
   dialog show().

The two dialogs intentionally duplicate this UI; no code sharing was
introduced (out of scope).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

- [ ] **Step 3: Report completion** — do not merge or push without explicit instruction; present merge options per the finishing skill.
