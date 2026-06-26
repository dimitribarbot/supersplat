# Portals — Sub-Project 2, Phase 2, Session-2 Handoff Memo

> **Purpose:** Continue the exported-viewer portal walkthrough in a fresh session. This memo supersedes the earlier `2026-06-25-portals-sub-project-2-phase-2-kickoff.md` for "where we are now". Read this first, then the plans it references.

## TL;DR — where we are (2026-06-25, end of session 2)

- Branch: **`portals-exported-viewer`** (off `main`, NOT pushed). Run `git log --oneline main..HEAD` for the current tip.
- **The entire EXPORT side is done and works** — including the late scope addition of **streaming + server** export for portals. Verified green: `npx tsc --noEmit`, `npm run build`, and `npm test` (125 pass; the 3 `server/test/*` `tsx` failures are pre-existing/environmental — ignore).
- **The Task 8 runtime spike PASSED for BOTH SOG and streaming** (see "Spike findings" — this is the key new knowledge). Dynamic multi-scene gsplat creation + enable/disable switching works at runtime, no haze, **no SOG fallback needed**.
- **What's left:** the Task 9 collision-swap spike (manual, ~10 min), then the viewer-runtime companion (Tasks 10–11), then locales + the full E2E + finish (Task 12), plus the streaming/server 4-combo E2E (NEW Task 7).
- The injected viewer **companion runtime is still a no-op STUB**. That's why, in the user's manual console test, the visible scene switched but **collision did not** — expected; the runtime that swaps collision isn't built yet.

## The governing documents (all committed on the branch)

1. **Design spec:** `docs/superpowers/specs/2026-06-20-portals-sub-project-2-exported-viewer-design.md`
2. **Main implementation plan:** `docs/superpowers/plans/2026-06-20-portals-sub-project-2-exported-viewer.md` — 12 tasks. Tasks 1–7 DONE. Task 8 spike DONE (see below). **Resume at Task 9 (collision spike), then Tasks 10–12.**
3. **Streaming/server extension plan:** `docs/superpowers/plans/2026-06-25-portals-streaming-server-support.md` — 7 tasks. NEW Tasks 1–6 DONE; NEW Task 7 = the user-driven 4-combo E2E (still to do).
4. **Progress ledger (git-ignored scratch):** `.superpowers/sdd/progress.md` — the authoritative task-by-task record. **Trust it + `git log` over memory after compaction.** Artifacts for the extension plan are prefixed `task-sN-*`.

## ⭐ Spike findings — Task 8 (dynamic multi-scene gsplat creation) — PASSED

Run manually in the exported viewer's DevTools console against a real 2-scene export. **Result: works for SOG and streaming.** The exact, verified incantation (use this VERBATIM when writing the Task 10 companion):

- **App handle:** `window.__supersplatViewer.debugPanel._global.app` (primary path; documented fallback `…navCursor.app`).
- **Camera manager:** `window.__supersplatViewer.cameraManager` (holds `.camera` and `.collision`).
- **Start gsplat entity:** `app.root.findComponent('gsplat').entity`.
- **⚠️ CORRECTION to the main plan's Task 10 code:** `startEntity.gsplat.asset` is a **number (asset id; observed `-1`)**, NOT the Asset instance — so `startEntity.gsplat.asset.constructor` is `Number`, and `new (that)(...)` throws `asset.on is not a function` inside `app.assets.add`. **Do NOT construct assets that way.** The plan's Task 10 snippet (`var Asset = startEntity.gsplat.asset.constructor; new Asset(...)`) is WRONG and must be replaced with `loadFromUrl` below.
- **Asset creation that WORKS (both formats):**
  ```js
  app.assets.loadFromUrl(url, 'gsplat', (err, asset) => { /* url = scenes/N/scene.sog OR scenes/N/lod-meta.json */ });
  ```
  `app.assets.loadFromUrl` is present; it constructs + loads the Asset internally (no need for the Asset class). Confirmed for `scenes/1/scene.sog` AND `scenes/1/lod-meta.json` (streaming octree parser accepts the dynamically-created asset). The registry holds ~121 assets; `app.assets.list()[0].constructor` is the real `Asset` class if ever needed.
- **Entity creation:** `new start.constructor(name)` (Entity class from the start entity), then `e.addComponent('gsplat', { asset, unified: true })` — the start gsplat has `unified === true`, mirror it. Copy transform from the start entity: `setLocalPosition/Rotation/Scale(start.getLocalPosition()/…)`. `app.root.addChild(e)`.
- **Scene switch:** toggle `entity.enabled`. To show exactly one scene, **disable every other scene entity and enable the active one** (the companion's `applyActive()` does this). Confirmed clean — no haze — for SOG and streaming. (The user's initial "haze" was simply both scenes enabled at once.)
- After any change: `app.renderNextFrame = true;`

**Implication:** streaming is fully viable at runtime → keep streaming support (the user explicitly wants streaming + server). The earlier "SOG fallback" is NOT triggered.

## Spike findings — Task 9 (collision swap) — PARTLY RESOLVED from the splat-transform SOURCE; one runtime unknown left

⚠️ **CORRECTION to the main plan's Task 9/11:** the collision is **NOT** on `cameraManager` — `window.__supersplatViewer.cameraManager.collision` is `undefined` (user confirmed). The viewer's collision architecture, read from `node_modules/@playcanvas/splat-transform/dist/index.mjs`:

- Collision class: **`VoxelCollision`**, or **`FlippedVoxelCollision extends VoxelCollision`** for **legacy** voxels. Legacy test in the loader: `const isLegacy = !metadata.version || parseFloat(metadata.version) < 1.1;`.
- The viewer builds it with `loadVoxelCollision(jsonUrl)` and passes it into `new CameraManager(global, sceneBound, collision)`, which distributes it to the **movement controllers** (a closure-local `controllers` object): `controllers.fly.collision = collision; controllers.walk.collision = collision;`.
- Each movement controller has `set collision(value){ this._mover.collision = value; this._mover.reset(this._position); }` (and `get collision(){ return this._mover.collision; }`); the orbit controller uses `this._navInteraction.collision`. **So the swap target is the controller's `.collision` setter, not the CameraManager.** Assigning it re-seeds the mover immediately.
- **Voxel file format (confirmed from `loadVoxelCollision`):**
  ```js
  const metadata = await (await fetch(jsonUrl)).json();                 // fields: nodeCount, leafDataCount, version
  const buffer   = await (await fetch(jsonUrl.replace('.voxel.json','.voxel.bin'))).arrayBuffer();
  const view     = new Uint32Array(buffer);
  const nodes    = view.slice(0, metadata.nodeCount);
  const leafData = view.slice(metadata.nodeCount, metadata.nodeCount + metadata.leafDataCount);
  const inst     = new Ctor(metadata, nodes, leafData);                 // Ctor = VoxelCollision | FlippedVoxelCollision
  ```
  (The main plan's Task 11 loader guessed `nodeCount`/`leafDataCount` correctly — keep it, but feed the new instance to the CONTROLLERS, not `cm.collision`.)

**The one remaining runtime unknown — the ACCESS PATH** from `window.__supersplatViewer` to the fly/walk controllers (they may be closure-captured and not publicly reachable). Resolve it with the discovery + swap test below; record the working path. The Task 11 companion should **self-discover** the controllers at startup (scan for objects with a `collision` accessor / `_mover` / `_navInteraction`), capture the start collision's constructor, preload each scene's voxel, and on switch assign `controller.collision = preloaded[idx]` to every discovered controller. Fallback if no controller is reachable: start-scene-only collision (voxels still bundled; document the limitation).

**Discovery test (run in the exported viewer console, collision-ON export):**
```js
const v = window.__supersplatViewer;
const seen = new Set(); const ctrls = [];
(function scan(o, path, d){
  if (!o || typeof o !== 'object' || d > 5 || seen.has(o)) return; seen.add(o);
  const proto = Object.getPrototypeOf(o) || {};
  if (Object.getOwnPropertyNames(proto).includes('collision') || '_mover' in o || '_navInteraction' in o) {
    let cur; try { cur = o.collision; } catch {}
    ctrls.push({ path, obj: o, ctor: o.constructor && o.constructor.name, collisionCtor: cur && cur.constructor && cur.constructor.name });
  }
  for (const k of Object.keys(o)) { let val; try { val = o[k]; } catch { continue; } if (val && typeof val === 'object') scan(val, path + '.' + k, d + 1); }
})(v, 'viewer', 0);
window.__ssCtrls = ctrls;
console.table(ctrls.map(c => ({ path: c.path, ctor: c.ctor, collisionCtor: c.collisionCtor })));
```

**Swap test (after discovery):**
```js
async function swap(jsonUrl){
  const ctrls = (window.__ssCtrls || []).filter(c => c.collisionCtor);   // controllers that currently hold a collision
  if (!ctrls.length) { console.warn('no reachable controller holds a collision'); return; }
  const Ctor = ctrls[0].obj.collision.constructor;
  const meta = await (await fetch(jsonUrl)).json();
  const view = new Uint32Array(await (await fetch(jsonUrl.replace('.voxel.json','.voxel.bin'))).arrayBuffer());
  const inst = new Ctor(meta, view.slice(0, meta.nodeCount), view.slice(meta.nodeCount, meta.nodeCount + meta.leafDataCount));
  ctrls.forEach(c => { c.obj.collision = inst; });
  console.log('swapped collision ->', jsonUrl, 'on', ctrls.map(c => c.path));
}
swap('scenes/1/scene.voxel.json');   // then walk into a scene-1 wall: does the camera collide against scene 1 now?
```
Record: the `console.table` paths + `collisionCtor` (VoxelCollision/FlippedVoxelCollision), and whether the swap makes the camera collide against scene 1. That confirms Task 11's mechanism end to end.

## What's left (ordered)

1. **Task 9 spike** (manual console, ~10 min) — collision-swap feasibility + record field names. (Main plan Task 9.)
2. **Task 10** — companion runtime: create one disabled gsplat per extra scene via `loadFromUrl` (NOT `new Asset` — see correction), per-frame `resolveActiveSplat` switch toggling `entity.enabled`. Use `window.__supersplatPortals` (already injected) + `window.__supersplatViewer`. Build on `src/viewer-companion/portals.ts` (the `companionRuntime` string is currently a stub with `segmentCrossesRect`/`resolveActiveSplat` already stringified in).
3. **Task 11** — companion collision preload + swap on crossing, using the Task 9 field names + `cameraManager.collision`.
4. **Task 12** — locale strings (all locales; Phase 1 added only `en` for the entrypoint keys), the two-floor `RdC`+`Etage` Maison_Bueil walkthrough E2E, then `superpowers:finishing-a-development-branch` (squash ALL branch commits incl. docs into ONE; do NOT push unless asked).
5. **NEW Task 7** (extension plan) — the 4-combo export E2E: local/server × SOG/streaming produce correct `scenes/N/` layout + zero-portals regression. (The user has already partially verified SOG + streaming sizes/layout locally.)

Execution method: continue **`superpowers:subagent-driven-development`** (fresh implementer per task → review → fix loop → ledger). Models: spikes are manual (you + user); runtime tasks (10, 11) → sonnet; locales (12) → cheap tier.

## What session 2 built (so you don't re-investigate)

**Export side, in order (all reviewed, build/tsc/tests green):**
- Main-plan Tasks 3–7 (commits `c749dc6`, `8b2972c`, `f808980`, `fc796c9`+`497737f`, `ed14b89`+`b3b446a`): pure export helpers (`src/portal-export.ts`: `buildPortalBundle`, `resolveCollisionSeed`), `ExperienceSettings` portal fields + per-scene Interior/Exterior UI, the multi-scene `scenes/N/` serialization loop + per-scene collision voxel, and `injectPortals` (payload + companion shell, runtime still a stub).
- **Debug fix (`bd46b94`):** first real export surfaced 3 bugs — (A) per-scene env dropdowns crushed (reused `.row` fixed height → new `.per-scene-env` column class); (B) export only wrote `index.*` because the user's "export on server" was ON and bypassed the client portal serialization; (C) streaming defaulted on. (B)/(C) were initially guarded off, then properly supported in the extension plan below.
- **Streaming + server extension (NEW Tasks 1–6; commits `1e6fb9a`, `0285c78`, `c52a30f`, `7a29fc5`, `2c3818f`, `679d88a`):** streaming local writes extras into the streaming ZIP's memFs before sealing; re-enabled both toggles for portals; shared pure `resolvePortalExtras`; local + server paths both upload/parse one PLY per portal scene (client `runServerExport` sends ordered `extraPly` parts + `portalExtras` metadata; server `run-export.ts` parses them into `extraScenes` for the shared `writeViewerCore`; server already shared that function). The server endpoints (`/api/export`, `/api/publish`), `jobs.ts`, worker host, and worker were threaded; new CPU test `server/test/portal-extras.test.ts`.
- **Primary-scene fix (`716e8ab`):** the export used `getSplats()` (all VISIBLE splats, merged) as the primary scene → with both portal scenes visible the primary became both merged AND each non-start scene was re-emitted as `scenes/N/` (duplication, ~2× ZIP). Fixed both local + server paths to pin the primary to the **start scene alone** (`bundle.sceneUids[0]` by uid). The user confirmed sizes are correct after this.
- **Progress-label fixes (`823a9ad` + the consistent-prefix commit after it):** streaming extra-scene phases now read `Scene N/M: <label>` for every sub-phase (decimation, collision, chunk packaging), and the streaming primary carries `Scene 1/N:` when extras exist.

**Open minors carried for the FINAL whole-branch review** (recorded in the ledger, not yet fixed): Task 5 `perSceneEnvRow` not constructed `hidden:true` (cosmetic); Task 6 `getPrefix` dead-param (now repurposed) / server length-mismatch yields 500 not 400; Task 7 vacuous test-2 assertion; Task S4 accepted estimated-warning behavior delta. These are deliberate deferrals — the final review triages them.

## Conventions & gotchas (carry forward)

- **Build gates are the real gates:** `npx tsc --noEmit` (run in the FOREGROUND, generous timeout ≥ 240000 ms — slow + unreliable backgrounded) and `npm run build`. **Do NOT run `npm run lint` / `eslint --fix`** (pinned-eslint@10 import/order crash on `src/main.ts`, spurious).
- Tests: `npm test` (vitest). The 3 `server/test/*` `tsx` failures are pre-existing — ignore. Pure logic that must be unit-tested goes in a **playcanvas-free** module (`portal-export.ts`, `portal-geom.ts`); importing full `playcanvas` under vitest hangs (type-only import is fine).
- Use the Bash tool (Git Bash); run commands **plainly — no `cd` / `git -C` / `--prefix`** pointing at the cwd (permission prompts).
- **Portals are package/ZIP-only for the viewer** — the `html` (single-file) branch of `writeViewerCore` still throws on portals by design (no place for `scenes/N/`). Streaming + server + SOG are all supported.
- The server **shares** `writeViewerCore` from `src/splat-export-core.ts` (loaded at runtime from `dist-shared/`); a server build runs `build:shared` + tsc.
- Reusable runtime hooks already injected: `window.__supersplatPortals` (the payload: `portals`, `portalScenes`, `portalStart`, `portalCollision`, `portalEnvironments`), `window.__supersplatViewer`, and the stringified `segmentCrossesRect`/`resolveActiveSplat` from `src/portal-geom.ts` inside the companion stub.
- Squash to ONE commit at the very end (incl. all docs). Do NOT push unless the user asks.

## E2E acceptance (the real gate, Task 12)

Two-floor `RdC`+`Etage` Maison_Bueil: stairwell portal (front=RdC, back=Etage, start=RdC), authored entrypoint on Etage, collision ON. Export ZIP (try SOG and streaming, local and server). Serve `index.html`: walk through the stairwell → visible scene swaps AND the camera collides against the correct floor. Then re-export with NO portals → viewer unchanged (single scene, no `__supersplatPortals`).
