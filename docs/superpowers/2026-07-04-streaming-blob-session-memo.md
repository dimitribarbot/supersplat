# Session memo — streaming blob fix (2026-07-04, evening) — HAND-OFF

Continue on branch **`fix/streaming-blob`** (NOT merged to main). Read this
memo + the spec's ROOT CAUSE section first:
`docs/superpowers/specs/2026-07-04-streaming-blob-fix-design.md`
Plan (revised mid-flight, tasks 1–8 done): `docs/superpowers/plans/2026-07-04-streaming-blob-fix.md`

## What this feature is

The "dark garbled blob" streaming artifact was diagnosed as **not an engine
bug**: it is octree coarse-chunk pop-in against the scene background (black
bg → black voids) during the pre-reveal window, visible because locally
exported viewers have no poster. Fix = superspl.at parity:

1. Every viewer export/publish ships a poster (export-time screenshot from
   the start camera; solid bg-color SVG cover when absent) and defaults the
   stock viewer's `?poster=` to it → canvas covered until `loaded`, then the
   complete coarse scene refines to sharp. `?poster=` (empty) disables.
2. Portal-crossing overlay reveals on per-DESTINATION coarse-file residency
   (old global `_gsplatCount` threshold was invalidated by budget-bounded
   multi-scene residency).

## Verified ✅ (user, throttled cold loads)

- Single-scene initial load, solid-cover fallback path (headless export):
  grey cover + progress → complete blurry scene → sharpens. No voids.
- Single-scene initial load, real poster path (editor export): works, "nice".
- Tests: 254 front-end + 47 server green; lint 0; `npx tsc --noEmit` 0;
  dist-shared rebuilt.

## OPEN ISSUES (next session's work) ❌

1. **Crossing reveal too early — CODE-COMPLETE (`e9b872d`, 2026-07-05),
   E2E PENDING.** Implemented exactly as sketched: reveal gate = residency
   at the scene's pin/reveal depth (`sceneMinLevel[idx]` falling back to
   `deviceMinLevel(idx)`), via new pure `sceneResidentToDepth` in
   `src/portal-preload.ts` (unit-tested, stringified into the runtime);
   `sceneCoarseResident` renamed `sceneRevealResident`; ALSO moved the pin
   pump's `markReady` from the coarsest batch to the finest pinned batch
   (`lv === pmin`) so a mid-preload crossing holds the overlay too (the
   coarse-batch markReady would otherwise skip `beginLoading` entirely and
   reveal mixed quality with NO overlay). `LOADING_MAX_FRAMES` cap kept.
   Mobile-safe: the gate depth is the budget-degraded pin depth, never
   desktop depth. 262 front-end + 47 server tests green, lint 0, tsc 0,
   dist-shared rebuilt, release build OK. Needs Dimitri's desktop
   throttled-crossing E2E: overlay should now stay up until the destination
   shows uniformly sharp (longer overlay, no mixed-LOD reveal).
2. **Mobile WebGL2 crash — REGRESSION from this branch's POSTER, fix
   attempt 2 pending E2E.** Not pre-existing: pre-branch WebGL2 walked the
   same 4 scenes fine; on-device bisect: poster active → context lost
   seconds into the load (engine tracker at only 36MB — pressure is
   browser-side), `?poster=` (empty) → clean. The freeze-at-13%/22% is the
   post-loss wedged block loader (`files=0/22`, `loading=2` frozen).
   Attempt 1 `f48d7b4`: killed the poster's animated full-screen CSS blur
   (mobile-gated `#poster{filter:none !important}`) — did NOT stop the
   loss (field run 2) but kept (free compositor win). Attempt 2 `b0b8d2c`:
   the remaining poster-only delta — the stock viewer holds the CANVAS at
   `opacity:0` until `loaded`; on Android the transparent canvas layer is
   optimized out of compositing (frames produced, never consumed) → force
   `#application-canvas{opacity:1 !important}` on mobile (visually free:
   opaque #poster paints above the canvas). IF ATTEMPT 2 FAILS: stop
   guessing — build the param-gated GL-call tracer (wrap
   texStorage2D/fenceSync/clientWaitSync/compileShader on
   WebGL2RenderingContext.prototype from a classic script, ring-buffer,
   dump on webglcontextlost; injected scripts run before the deferred
   viewer module so prototype wrapping works) and get one instrumented
   Redmi run. Also `edcade5`: companion halts loads/pins on `devicelost`,
   resumes on `devicerestored`. Research: no upstream match; Adreno
   fence/readback fragility documented (Chromium gpu_driver_bug_list IDs
   110/240/260/280); engine's SOG decode fires 7 sequential PBO/fence
   readbacks per file (generateCenters).
3. Mobile crash FIXED & user-verified ✅ (2026-07-05): attempt 2 `b0b8d2c`
   (canvas kept composited) was the one — the poster's `--canvas-opacity: 0`
   let Android optimize the transparent WebGL canvas layer out of
   compositing. Attempt-1 blur kill kept as a free win.
4. Mobile first-crossing "regions shift" with no overlay — fixed `76b9b54`,
   E2E PENDING: destination was flag-ready at its coarser NEIGHBOUR pin
   depth; the crossing assigns the finer active depth and the refine was
   visible. switchTo now arms the overlay from a live sceneRevealResident
   probe (post-reconcile), so the reveal gate holds until the destination
   is resident at the depth it is actually shown at. Desktop unaffected
   (fully resident probes true → instant crossing).
5. Mobile crossing overlay `76b9b54` user-verified ✅ EXCEPT a stuck
   overlay when crossing BACK to scene 0 — fixed `9aad52d`, E2E PENDING:
   sceneMinLevel[0] is never set (scene 0 lodRange is viewer-owned) so the
   gate fell to deviceMinLevel(0)=0 and waited for the whole desktop-depth
   pyramid; reveal depth now resolves pinDepth (assigned, tracked for ALL
   scenes) → sceneMinLevel → deviceMinLevel. Expected after fix: crossing
   back to an already-resident scene 0 shows NO overlay at all.
6. Field observation (user to check, NOT code): endless CDN retry loop on
   scene-0 fine files (net::ERR_FAILED with status 200 on
   .../0_8/{scales,sh0}.webp) = CORS signature — likely a Spaces CDN
   cached variant missing Access-Control-Allow-Origin; check bucket CORS
   for the CDN endpoint.
7. Final E2E ✅ COMPLETE (2026-07-05): Redmi first-crossing overlay,
   instant no-overlay cross-back to scene 0, and desktop regression all
   user-verified ("Everything is working fine now"). Feature COMPLETE.
   The ERR_FAILED-with-200 churn was re-diagnosed as NOT CORS (page is
   same-origin on the CDN): mobile memory-pressure failures on level-0
   webps the device can't hold — optional follow-up memo'd in
   `docs/superpowers/2026-07-05-mobile-scene0-lod-clamp-followup.md`.

## Branch state (local commits, in order)

- `bcccd87` docs: design spec
- `8f4b87d` docs: implementation plan (pre-revision)
- `babf8f7` docs: spec+plan revised after diagnosis (root cause = viewer UX)
- `1e97101` feat: poster injection module + tests
- `9fcc752` feat: poster through all export/publish paths (browser local,
  server multipart `poster` part, S3 publish; `writeViewerCore(...,
  posterBytes)`; render.poster offscreen JPEG in `src/render.ts`)
- `b818e3a` docs: upstream draft withdrawn/rewritten (no engine bug)
- `c2e1284` fix: crossing overlay per-destination coarse residency gate
- `bc96ecb` fix: percent-encode parens in solid-cover data URI (unquoted CSS url)
- `051bbce` fix: publish typecheck (no-op poster strip removed)
- `a3734b8` docs: this memo
- `e9b872d` fix: crossing overlay held until reveal-depth residency (open issue 1)
- `a54867f` docs: memo update (issue 1 code-complete)
- `edcade5` fix: halt loads/pins while the graphics device is lost
- `f48d7b4` fix: mobile poster blur kill (open issue 2 root cause)

Files touched: `src/viewer-companion/poster.ts` (new), `portals.ts`
(overlay section), `splat-export-core.ts`, `splat-serialize.ts`,
`file-handler.ts`, `export-server-client.ts`, `s3-publish.ts`,
`render.ts` (`render.poster`), `server/src/{index,run-export}.ts`,
`test/poster-injection.test.ts` (new). `viewer-engine-patch.ts` deliberately
untouched.

## Repro/validation tooling (OUTSIDE repo: `C:\Dev\playcanvas\blob-repro\`)

- `gen-export.mts` — headless streaming export of the repro scene
  (`C:\Users\User\Splats\RdC_Maison_Bueil\ply-result\point_cloud\iteration_100\scene.ply`,
  5,588,857 splats, NO SH). Run:
  `cd C:/Dev/playcanvas/blob-repro && NODE_OPTIONS=--max-old-space-size=8192 C:/Dev/playcanvas/supersplat/server/node_modules/.bin/tsx gen-export.mts`
  then `rm -rf www && mkdir www && tar -xf out.zip -C www --force-local`.
  Picks up a rebuilt `dist-shared` automatically (server `npm run build:shared`).
- `throttle-server.mjs` — `node throttle-server.mjs . 8123 2000` from
  blob-repro root; serves `/www/...`, `/user-export/...`, `/harness/...`
  with per-response KB/s cap + no-store.
- `user-export/` — Dimitri's real E2E export (instrumented with `[VIEW]`
  logs), from `C:\Users\User\Downloads\RdC_Maison_Bueil`.
- `harness/` — unminified-engine (2.20.5 dbg) repro page with the
  `[DET]`/`[UNBAKED]` bake detector, `?content=`, `?cam=`, `?target=`,
  `?bg=`, `?debug=lod`, `?gfx=webgl2`, `?nolock`, `?budget=` params.

## Gotchas learned this session

- Synthetic `experienceSettings` MUST carry full `postEffectSettings`
  sub-objects (viewer's `anyPostEffectEnabled` dereferences unconditionally)
  — gen-export.mts already fixed.
- The viewer embeds the poster as **unquoted CSS `url(...)`** → parens in
  data URIs must be percent-encoded (encodeURIComponent doesn't).
- Exported viewer boot: entity `setLocalEulerAngles(0, 0, 180)` (Z-flip),
  `unified: true`, settings camera used raw, FOV is HORIZONTAL when
  width>height.
- `npm run lint` / `tsc` are slow-ish; chaining them in one shell command
  has twice hit the 3-min tool timeout — run separately.

## When feature complete

Squash to one commit (incl. docs), FF-merge to local `main`, do NOT push,
delete branch (superpowers:finishing-a-development-branch). Update
`docs/superpowers/2026-07-04-upstream-blob-issue-draft.md` status if the
optional supersplat-viewer suggestion gets filed.
