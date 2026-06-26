# Portals — Sub-Project 2 (Exported-Viewer Walkthrough): Design Spec

> **Status:** Approved design, ready for implementation planning.
> **Predecessor:** Sub-project 1 (editor portals) — merged to local `main` (`c8226c6`).
> **Kickoff memo:** `docs/superpowers/2026-06-20-portals-sub-project-2-kickoff.md`
> **Parent design:** `docs/superpowers/specs/2026-06-20-portals-multi-scene-walkthrough-design.md` (§5 sketches this sub-project).

## 1. Goal

Make the portal walkthrough work in the **exported standalone web viewer** (the published ZIP), not just the editor. Today the exported viewer hosts a **single** splat scene; portals need it to **hold multiple scenes and switch between them at runtime** as the camera crosses portals — invisibly, with no merged geometry (portals exist precisely because two overlapping floor captures cannot be fused).

## 2. Feasibility spike — findings (the gating unknown)

The exported viewer is a separate runtime built by `@playcanvas/splat-transform`'s `writeHtml`, not the editor codebase. Before designing, we confirmed multi-scene hosting is possible **without modifying the dependency**:

- **`writeHtml` natively hosts exactly ONE scene.** Its signature takes a single `dataTable` → one SOG → the bootstrap loads one `contents: fetch(contentUrl)`. Native multi-scene is therefore *not* available.
- **The viewer is a full PlayCanvas app.** It loads splats via `new Asset(filename, 'gsplat', { url, filename, contents }, data)` → `entity.addComponent('gsplat', { unified: true, asset })`. `unified: true` is the engine's batched multi-gsplat renderer; `app.scene.gsplat` even exposes a per-id visibility stream (`enableIds`). The engine supports many gsplat entities, each toggled via `entity.enabled`.
- **The live `app` is reachable at runtime** from the already-published viewer handle: `window.__supersplatViewer.debugPanel._global.app` (unconditional), with `…navCursor.app` as a fallback (only exists when `!config.noui`). Off-limits zones already publish `window.__supersplatViewer`; this design reuses that exact mechanism.
- **Engine constructors** (`Asset`, `Entity`) and the collision class are module-private, but reachable by reflecting off already-loaded instances (`startEntity.constructor`, `startAsset.constructor`, `startCollision.constructor`).

**Conclusion:** the walkthrough is implementable as a **companion-injection** (bundle the scenes + inject a runtime `<script>` that reaches the app and toggles gsplat entities), mirroring `off-limits-collision.ts`. No dependency fork required. Two paths reach into dep internals and are therefore **verification-gated** (see §8): dynamic *streaming* gsplat-asset creation, and runtime collision swapping. Each has a concrete fallback so the feature ships regardless.

## 3. Scope decisions (locked)

| Decision | Choice |
|---|---|
| Export target | **ZIP package (multi-file)** only. Single-HTML and streaming-only are out of scope for v1. |
| Topology | **General N-scene**, stateful cross-the-doorway switching (carried over from sub-project 1). |
| Per-scene bundle format | **Follows the existing streaming toggle**: streaming off → one `.sog` per scene; streaming on → one LOD bundle per scene. |
| Scene load model | **Preload all** scenes at viewer start (active enabled, rest disabled). With streaming this is naturally *coarse-only* until a scene is enabled, then it ramps to full detail. |
| Per-scene collision | **Environment (Interior/Exterior) is per scene**; radius and voxel size remain shared across scenes for v1. Indoor flood-fill seed = **authored per-scene entrypoint when set, else a portal-derived best-effort default** (§5.6, §5.8). |

## 4. Architecture overview

Two halves, both **gated on "portals exist in this export"**. With no portals, every existing export path is byte-for-byte unchanged.

1. **Export side** (`splat-serialize.ts` / `splat-export-core.ts` / `ui/export-popup.ts` + a new pure helper): when portals exist and the target is ZIP, serialize *each* portal-referenced scene as its own bundle inside the ZIP, generate a per-scene collision voxel, and write a `portals` block (with a uid→scene-index mapping and start index) into `experienceSettings.json`.
2. **Viewer companion** (`src/viewer-companion/portals.ts`, injected like `off-limits-collision.ts`): on viewer start, reach the live app, create one gsplat entity per *extra* scene (disabled), enable the start scene, and per frame run `resolveActiveSplat` to toggle which single entity (and which collision volume) is active when the camera crosses a portal.

The crossing math (`src/portal-geom.ts`) and the switching state machine (`src/portals-runtime.ts`) already exist from sub-project 1 and are reused. The companion is essentially the editor runtime with `s.visible` replaced by `entity.enabled`, fed from `experienceSettings` instead of editor events.

## 5. Export side

### 5.1 Which scenes
The set of scenes to export = `{startUid} ∪ {every non-null frontUid/backUid across all portals}`, looked up against `events.invoke('scene.allSplats')` — which returns **all** splats including hidden ones (the current `getSplats()` filters `splat.visible`; using `scene.allSplats` solves the "hidden scenes must still export" gotcha). The **start scene** is the viewer's primary `contentUrl` (`scene.sog` / streaming `lod-meta.json`, exactly as today). Every *other* referenced scene becomes an additional bundle.

### 5.2 Per-scene serialization
Call the existing `extractDataTable([oneSplat], settings)` once per scene. `extractDataTable` bakes each splat's editor world-transform into the output coordinates, so every scene's bundle lands in **one shared world frame** — no cross-scene alignment work, and portal coordinates (editor world space, injected verbatim) line up automatically. The format (SOG vs LOD bundle) follows the streaming toggle, looping the existing single-scene code paths per scene.

### 5.3 ZIP layout
The start scene's files are emitted at the ZIP root **exactly as today** (untouched single-scene path). Every *extra* scene gets its own self-contained **folder** `scenes/N/`, uniform across both formats — this is required because a streaming bundle is not a single file but `lod-meta.json` + per-LOD chunk folders (`0_0/`, `0_1/`, …), which would collide at the root.
```
index.html
settings.json                  (the viewer settings JSON writeHtml embeds — extended, see §5.5)
scene.sog                       ← start scene  (SOG)   — or:
lod-meta.json + 0_0/ 0_1/ …     ← start scene  (streaming)
index.voxel.json / .bin         ← start scene collision (unchanged), if collision on

scenes/1/scene.sog              ← extra scene 1 (SOG)  — or:
scenes/1/lod-meta.json + 0_0/ … ← extra scene 1 (streaming)
scenes/1/scene.voxel.json / .bin← extra scene 1 collision (if collision on)
scenes/2/ …
```
For streaming extra scenes, `writeLod` is given an output base of `/scenes/N/lod-meta.json` so its chunk paths nest under `scenes/N/` and the meta's relative chunk references still resolve from that folder. (Confirming `writeLod`'s relative-reference behaviour under a nested base folds into the streaming verification-gate in §8.)

### 5.4 uid → scene-index mapping (the export's key job)
Editor `uid`s are session-scoped and meaningless in the bundle, so the export rewrites them to **bundle scene indices**. Index 0 = the primary/start scene. A new **pure, playcanvas-free helper** (e.g. `src/portal-export.ts`, unit-tested) builds:
- `portalScenes: string[]` — index → relative asset URL. Index 0 = primary/start (empty string; already loaded by the viewer). Extra scenes follow the `scenes/N/` convention and the streaming toggle: `scenes/N/scene.sog` (SOG) or `scenes/N/lod-meta.json` (streaming). E.g. `["", "scenes/1/scene.sog", "scenes/2/scene.sog", …]`.
- `portalStart: number` — the start scene's index (0).
- `portals: { position, rotation, width, height, front: number|null, back: number|null }[]` — `front`/`back` are scene **indices** (or `null` for an unbound side).
- `portalCollision?: (string|null)[]` — index → voxel `.voxel.json` URL (when collision is on): index 0 = `index.voxel.json`, extras = `scenes/N/scene.voxel.json`.

The companion never sees a editor uid. A portal referencing a uid that no longer exists is dropped with a warning; if fewer than 2 resolvable scenes remain, portal injection is skipped entirely (nothing to switch).

### 5.5 `ExperienceSettings` extension
In `splat-serialize.ts`, extend the `ExperienceSettings` type with optional `portals`, `portalScenes`, `portalStart`, `portalCollision`. Assembled in `ui/export-popup.ts` (~680) from `events.invoke('portals.export')` + `events.invoke('portals.startSplat')` run through the new helper. All fields optional → absent when there are no portals, so existing exports serialize identically.

### 5.6 Per-scene collision (export)
Radius and voxel size stay shared; **environment is per scene**:
- **UI:** when portals exist and collision is on, the single Interior/Exterior dropdown is replaced by one Interior/Exterior selector **per referenced scene** (labelled by scene name). Shared radius / voxel-size sliders are unchanged.
- **Generation:** for each scene, generate its own voxel via the existing `writeCollisionVoxel` with that scene's `environment` and the shared radius/voxelSize.
- **Seed (entrypoint) — two-tier:** the indoor flood-fill `navSeed` must sit in the scene's open, enclosed, walkable volume; nothing about a portal rectangle's placement reliably guarantees that (a portal can extend below the floor, and the geometry just past a stairwell doorway is solid steps). So the seed resolves in priority order:
  1. **Authored per-scene entrypoint (reliable, wins when present):** a position the user captured in the editor by standing where they want to enter that scene (§5.8). Used **directly** as `navSeed` (world space) — known-open, eye-height, no geometric guessing. This is the intended fix for stairwells / below-floor portals.
  2. **Portal-derived best-effort default (fallback when no entrypoint is set):** for a scene `S`, pick a portal `P` referencing it — the **first in stable portal order** (persisted insertion order, reproducible across runs) — with `up = q·[0,1,0]` (portal local up), `n = q·[0,0,1]` (portal local normal): `S = C + h·worldUp − (H/2)·up ± d·n` — i.e. drop to the rectangle's bottom edge (≈ doorway floor), raise by a human eye-height `h ≈ 1.6`, nudge `d ≈ 0.5` into the target side (`+` if `S` is `P.front`, `−` if `P.back`). Height-stable across portal heights, and a reasonable guess for a simple vertical doorway — but **explicitly unreliable for the below-floor and stairwell cases above**, which is why the authored override exists. `h`/`d` inherit the existing "scene units ≈ metres unless scaled in the editor" caveat already carried by the collision radius.
     - **Multiple portals between the same scenes:** the collision volume is voxelized **once per scene** from a single seed, and the radius (~50 m) covers the whole capture, so the seed only needs to land anywhere in the scene's connected open volume — any referencing portal's doorway is equally valid. "First in stable order" is therefore deterministic and sufficient; it does **not** average doorways (an average could land in a wall). When the first portal happens to be the poor one (e.g. the stairwell) and a sibling doorway would be cleaner, the authored entrypoint is the intended resolution, and the per-scene fallback warning flags it.
  - The start scene keeps the start-camera seed (`collisionSeedFromSettings`), unchanged.
  - **Missing-entrypoint handling:** when an **indoor** extra scene falls back to the portal-derived guess (no authored entrypoint), export proceeds but surfaces a **non-blocking, per-scene warning** in the export dialog/log naming the scene (e.g. "Scene *Etage*: using an estimated collision entrypoint — set one in the portals panel if collision looks wrong"). Never hard-blocks; outdoor scenes (no seed needed) and scenes with an authored entrypoint produce no warning.
  - The whole resolver (authored-or-fallback) is a **pure, playcanvas-free helper** in `src/portal-export.ts`, unit-tested across both tiers; whether a given scene *triggered the fallback* is part of its return so the caller can raise the warning.
- **Bundling:** `scenes/N/scene.voxel.json` + `.bin`, referenced by `portalCollision` (§5.4).

### 5.7 Progress UX
The export loops over N scenes; each scene runs the same writer passes as today. Reuse the existing `createProgressRenderer` `getPrefix` mechanism (already used for streaming's "Packaging streaming chunks (5/40)") to prefix every per-step label with the scene counter and name, e.g. **"Scene 2/3 (Etage) — Packaging streaming chunks (5/40): k-means"**. Same underlying labels as today, scene-prefixed.

### 5.8 Editor additions for per-scene entrypoints (sub-project 1 surface)
Authoring the override reaches back into the editor portals feature (SP1). Minimal, additive changes:
- **Data model** (`src/portals.ts`): an optional per-scene entrypoint keyed by splat `uid` — a world-space position only (no rotation; it is just a flood-fill seed). New events to set/clear/query it; included in `docSerialize.portals` / `docDeserialize.portals` and exposed in the `portals.export` shape (a `uid → [x,y,z]` map). Cleared on `scene.clear`.
- **UI** (the portal tool's floating bar, `src/tools/portal-tool.ts`): a dedicated **Entrypoint row** — `[scene selector ▾] [Set from camera] [Clear]` with a set/unset indicator — so the chosen scene is explicit and independent of which *portal* is selected (the bar already builds equivalent scene dropdowns for front/back/start, `portal-tool.ts:53-58,87-92`). The scene dropdown lists the portal-referenced scenes.
  - **Marker (the dot):** each scene with an entrypoint draws an SVG overlay dot, re-projected every `postrender` so it is never occluded by the splats — the exact mechanism the alignment tool uses (`alignment-tool.ts:45-123`), with a small label for the scene name/number.
  - **Adjusting position:** select the dot (or pick the scene in the dropdown) → a **`TranslateGizmo`** attaches to it (translate only — no rotate) and the drag commits as an undoable `UpdatePortalEntrypointOp`, mirroring the gizmo wiring in `portal-tool.ts:190-268` / `alignment-tool.ts:127-168`. `Set from camera` captures the current editor camera world position for a one-click initial placement.
  - **Deliberately NOT surface-pick:** unlike alignment points (which raycast onto the splat surface via `scene.camera.intersect`), an entrypoint must sit in **open air at standing height** — the seed gestures are camera-capture + open-space gizmo drag only, never snapped to geometry.
- **Scope guard:** the entrypoint feeds **only** the export-time collision seed. It does **not** reposition the runtime camera on crossing (the camera continues from where the user walked, which is physically continuous in the shared world frame) — runtime camera-reset is an explicit non-goal for v1.
- **Delivery:** this editor-authoring slice (data model + UI + serialization + `portals.export` shape) is delivered as **its own commit / sub-task** within the branch, sequenced **before** the export step that consumes the entrypoint, so it lands and is reviewable independently of the viewer-export work.

## 6. Viewer companion (`src/viewer-companion/portals.ts`)

Mirrors `src/portals-runtime.ts` (the editor walkthrough) almost line-for-line — `s.visible` → `entity.enabled` — and is injected exactly like `off-limits-collision.ts`.

- **Injection builder** `buildPortalsInjection(...)`: mirrors `injectOffLimitsZones` exactly — it reads the portal fields from `viewerSettingsJson` (the same object that becomes `settings.json`, §5.5) and emits a `<script>window.__supersplatPortals = { portals, portalScenes, portalStart, portalCollision }</script>` payload (HTML-escaped like the other injectors) + a self-contained runtime `<script>`. The runtime companion reads `window.__supersplatPortals`, never `settings.json`, so it needs no access to the viewer's private settings closure. Returns `''` when there are no portals (non-portal exports stay byte-identical). Called from `splat-export-core.ts` alongside `injectOffLimitsZones` / `injectAnnotationLinks`.
- **App handle:** `window.__supersplatViewer.debugPanel._global.app` (primary), falling back to `…navCursor.app`. If neither resolves, the companion **no-ops** (no switching) rather than corrupting the viewer — same posture as off-limits' soft anchor replace.
- **Startup:** locate the existing (start) gsplat entity + asset via `app.root` to harvest the `Entity`/`Asset` constructors and the start entity's local transform. For each *extra* scene: `new Asset(url, 'gsplat', { url })` → `app.assets.add` + `load` → on load create `new Entity('gsplat')`, apply the **same local transform as the start entity** (all scenes are exported in one shared world frame with world coordinates baked in by `extractDataTable` (§5.2), so they must share the start entity's transform — typically identity — *not* be left at a default that differs from it), `addComponent('gsplat', { unified: true, asset })`, set `entity.enabled = false`, add to `app.root`. Enable the start scene. (Streaming vs SOG differ only in the asset `url`: `scenes/N/lod-meta.json` vs `scenes/N/scene.sog`.)
- **Per-frame switch:** reuse `resolveActiveSplat(prev, cur, rects, activeIndex)` **verbatim** (injected via `Function.prototype.toString()`, like `segmentBlockedByWall`) against `viewer.cameraManager.camera.position`. On change: toggle the two affected entities' `enabled`, and (if collision present) set `viewer.cameraManager.collision = collisions[activeIndex]`.
- **Collision preload + swap:** the companion reimplements the tiny `loadVoxelCollision` (fetch `.voxel.json` + `.voxel.bin`, slice into `nodes`/`leafData`) self-contained, then `new CollisionCtor(metadata, nodes, leafData)` where `CollisionCtor = startCollision.constructor`. All per-scene collisions are preloaded at startup; the active one is set via the `cameraManager.collision` setter (which calls the controller's `mover.reset`, re-seeding cleanly).
- **`portal-geom.ts` remains the single source of truth** for crossing math — editor and viewer switch identically.

## 7. Error handling & robustness

- **No portals / HTML target:** companion absent, export unchanged. If portals exist but the user picks single-**HTML** export, portals are silently ignored with a one-line note in the export dialog (v1 is ZIP-only).
- **Dep-internal reaches** (app handle, gsplat/collision constructors, streaming-asset creation, collision setter): every reach is wrapped so a failure **degrades gracefully** — missing handle → no switching; a scene asset that 404s/fails → that scene stays unloaded and a crossing into it is a no-op (the camera still moves), logged to console. **Never throw into the viewer frame loop.**
- **Export-time:** dangling portal uid → drop with warning; `< 2` resolvable scenes → skip portal injection.

## 8. Verification-gated risks (for the implementation plan)

Two runtime mechanisms reach into dependency internals. Each is implemented behind an early verification step, with a documented fallback so the feature ships either way:

1. **Dynamic streaming gsplat-asset creation** — confirm a companion-created gsplat asset pointing at a per-scene `lod-meta.json` loads via the streaming parser, and that a *disabled* streaming entity stays coarse-resident and ramps on enable. **Fallback:** SOG-per-scene (non-streaming) for portal exports.
2. **Runtime collision swap** — confirm the reimplemented voxel loader + `startCollision.constructor` + `cameraManager.collision` setter actually swaps the active collision volume. **Fallback:** bundle all per-scene voxels (export stays fully correct) but the active collision falls back to start-scene-only until a small upstream contribution lands. The export work is never wasted.

## 9. Testing strategy

- **Pure units (playcanvas-free, vitest)** — importing playcanvas under vitest's node env hangs, so all unit-tested logic lives in import-free modules:
  - `src/portal-export.ts`: scene-set collection, uid→index mapping, portal-reference rewrite, scene-URL + collision-URL maps, and the two-tier collision-seed resolver (authored entrypoint present → used directly; absent → portal-derived fallback) — table-driven tests.
  - `src/portal-geom.ts`: already has `test/portal-geom.test.ts`; reused unchanged.
  - The reimplemented voxel-loader parser (json + bin → `nodes`/`leafData` slices) as a pure function — unit-tested against a small synthetic buffer.
- **Build gates:** `tsc --noEmit` + `npm run build` are the real gates. Do **not** run `eslint --fix` (known pinned-eslint import/order crash on `src/main.ts`). The 3 `server/test/*` `tsx` failures are pre-existing/environmental — ignore.
- **Manual E2E** (per the kickoff memo): export the two-floor `RdC` + `Etage` Maison_Bueil capture with a stairwell portal as a ZIP, open the exported HTML, walk through the portal, confirm the visible scene swaps and (if collision on) the camera collides correctly on each floor.

## 10. New / touched files (anticipated)

| File | Change |
|---|---|
| `src/portal-export.ts` | **New.** Pure, playcanvas-free helper: scene-set collection, uid→index mapping, reference rewrite, scene-URL/collision-URL maps, and the two-tier collision-seed resolver (§5.6). Unit-tested. |
| `src/viewer-companion/portals.ts` | **New.** `buildPortalsInjection` + self-contained runtime companion (asset creation, switching, collision preload/swap). |
| `src/portals.ts` | **(SP1 surface)** Add optional per-scene entrypoint (keyed by splat `uid`): set/clear/query events, an `UpdatePortalEntrypointOp` edit op, doc serialize/deserialize, `portals.export` shape, reset on `scene.clear` (§5.8). |
| `src/tools/portal-tool.ts` | **(SP1 surface)** Entrypoint row in the floating bar (`[scene ▾] [Set from camera] [Clear]` + set/unset indicator); SVG overlay dot per scene (alignment-tool pattern); `TranslateGizmo` to drag the selected entrypoint (translate-only). Camera-capture / open-space only — no surface-pick (§5.8). |
| `src/splat-serialize.ts` | Extend `ExperienceSettings` (`portals`, `portalScenes`, `portalStart`, `portalCollision`); per-scene serialization loop in `serializeViewer`. |
| `src/splat-export-core.ts` | Multi-scene export loop (per-scene writers + per-scene `writeCollisionVoxel`), scene-prefixed progress, `injectPortals` wired alongside the existing injectors. |
| `src/ui/export-popup.ts` | Per-scene Interior/Exterior selectors; assemble portal fields (incl. authored entrypoints) into `ExperienceSettings`. |
| locales | New strings (per-scene collision labels, entrypoint set/clear, HTML-export "portals ignored" note) across all supported locales. |
