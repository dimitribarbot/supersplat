# Session Handoff — 2026-07-04 (portal viewer budget residency: FEATURE COMPLETE)

**FINAL STATUS (2026-07-04, end of day): feature complete, all Task-4 E2E checks user-verified** (desktop instant crossings; tight-budget eviction/reclaim; SOG package pass; collision + R-reset regression; 5-min phone WebGL2 walkthrough; mobile crash→fallback cycle). Branch squashed to one commit and FF-merged to local `main`, branch deleted, NOT pushed. Still user-owned: file the two upstream drafts (`2026-07-04-upstream-blob-issue-draft.md`, `2026-07-04-upstream-devicelost-issue-draft.md`). The ROUND 1–17 sections below are the development history.

Read this first to resume. Task-by-task history: `.superpowers/sdd/progress.md`. Supersedes `docs/superpowers/2026-07-03-session-handoff.md` (+ its UPDATE sections). All work is **local, nothing pushed**.

## Git state

```
main = 2be2420 (3 ahead of origin, NOT pushed)

feat/portal-viewer-budget-residency @ 715d7fa — 16 commits ahead of main:
  e0d5efa..20b5c05  spec/plan + T1-T3 (selectResidentScenes, runtime wiring, SOG count bake)
  a3b8dcf  E2E r1 fixes: MULT 12 desktop/3 mobile + pin-manage scene 0
  dc10b74  E2E r2 fix: project-aware desktop ceiling (computeResidentCeiling)
  920135a  E2E r3 fixes: hard-cap (active degrades last), coarse-first pinning, defer preload to firstFrame
  c8edae1  E2E r5 fix: wave-based pin pump (PIN_WAVE=4; engine loader is per-scene 2-slot FIFO)
  85900f0  diag: ready-gate state dump at 20s/45s
  fdccd94  ready-gate watchdog + fallback splatBudget backstop
  715d7fa  ENGINE #8998 patch baked into exports + playcanvas 2.20.5 (root+server)
```

Gates at tip: **244/244 root vitest, 47/47 server vitest (incl. byte-parity), tsc clean, lint exit 0, RELEASE build passes.** Release build is in `dist/`. The engine patch is **export-time** — always E2E a FRESH export.

## What is DONE and user-verified (E2E rounds 1–8)

1. **Budget residency works on desktop** — the headline feature. User quote (r8): *"if I wait for all files to be downloaded on startup on desktop: then I can go wherever I want without any loading time."* Field log proved the math exact: `ceiling=62856632 costs=[10.9M,10.2M,24.9M,16.8M] resident=[0,1,2,3] depths all 0, deviceFinest=0`.
2. **Stuck-at-95% loading bar FIXED** (was pre-existing, even single-scene): upstream engine bug — playcanvas PR **#8998** ("gsplat loading progress permanently stuck after a cancelled mid-flight load"), shipped in 2.20.5. But splat-transform 2.7.1 **bakes engine 2.20.2 as a string** into the exported viewer, so `715d7fa` string-patches both #8998 fixes into the baked bundle at export time (`src/viewer-engine-patch.ts`, patterns verified exactly-once, TDD'd) in all 3 export paths (streaming ZIP / package ZIP / single-file HTML). `playcanvas` bumped to **2.20.5 exact** in root + server. Removal path: delete `viewer-engine-patch.ts` + the runtime watchdog when splat-transform ships engine ≥ 2.20.5.
3. All the residency plumbing along the way (each was a real E2E-found bug): scene 0 pin-managed (engine frees a disabled scene's blocks); project-aware desktop ceiling; hard cap (active scene degrades as last resort); level-major coarse-first pinning; preload deferred to viewer `firstFrame`; wave pump so pins never starve the engine's per-scene 2-concurrent FIFO block loader.

## What REMAINS (2 issues, in user priority order)

### 1. Mobile OOM (priority 1) — Xiaomi Redmi Note 9S (6GB+2GB), still crashes when navigating scenes

Status: **undiagnosed on the CURRENT build.** Everything known bounded is now bounded: mobile ceiling = 3 × splatBudget hard cap (active degrades too), warming capped to 2 coarsest levels, splatBudget backstop if ready-gate ever fails. The r8 mobile test still "seems OOM" — but note the stuck-bar fix landed in the same round; **first confirm the crash reproduces on a FRESH export** (before r8, `splatBudget=0` disabled the engine's balancer entirely, which fully explained OOM; that path is closed now).

Evidence to collect (Chrome remote debugging, `chrome://inspect` from desktop → phone):
- The `[portals]` console lines on the phone: ceiling/costs/resident/depths + `deviceFinest` (if `deviceFinest=0` on this phone, pins are far bigger than intended — the depths line shows it).
- What the "OOM" actually is: tab reload ("Aw, Snap" / error code) vs page freeze vs browser kill. `chrome://crashes` on the phone.
- Memory curve: DevTools Performance monitor while walking; note whether the jump correlates with a crossing (scheduleRefine sets the crossed scene's `lodRangeMin = sceneMinLevel` → if that is 0 on the phone, the engine streams level-0 per-view — bounded by splatBudget for RENDERED splats but resident per-view files add up).
- Lever for bisecting: `?residentBudget=1` (pins ≈ nothing) and `?budget=1` (viewer sets splatBudget=1M). If it still OOMs with both → the leak is engine-side per-view streaming, not our pins.

### 2. Black splat blob (priority 2) — at startup and on crossings while downloads are still in flight

Symptom: a large region of dark garbled/coarse splats (screenshot in r3 report); appears while splats are still streaming; desktop steady-state (everything downloaded) never shows it. So it is a **transient streaming-time rendering artifact**, not residency.

Ruled out: ready-gate bug (fixed, blob persists), pin-queue starvation of interactive loads (wave pump landed, blob persists — though verify the r8 blob was on a FRESH export).

Hypotheses to test next (in order) — **UPDATED 2026-07-04 (resumed session): the engine-delta hypothesis is CLOSED**. Full `npm pack playcanvas@2.20.2` build diff vs 2.20.5 + release-page research (details in `.superpowers/sdd/progress.md` "ROUND 9 PREP"): the whole 2.20.3–2.20.5 delta is 7 PRs and contains **no rendering/sort/work-buffer/color fix** — only #8998 (patched), #9000 (headless), #9011 (unload-crash guards), MSDF *font* shader fixes, and doc/API trivia. splat-transform still 2.7.1, playcanvas 2.21 not released, and no upstream issue matches the blob symptom. Remaining discriminators:
- **LOD debug colorize**: the viewer supports `?colorize` (config.colorize → `GSPLAT_DEBUG_LOD`). If the blob region shows as a distinct LOD color, it's a node rendering a stale/wrong LOD entry (or just plain coarse-LOD appearance); if it's uncolored garbage, it's work-buffer/sort/color corruption.
- **Deferred SH color updates, not copy lag**: engine read shows `rebuildWorkBuffer` renders all pending splats into the work buffer in ONE call per world-state application (`bufferCopyUploaded/Total` are cumulative stats — the "per-frame-capped partial copy" framing was wrong). But SH **color** updates are deferred via `colorUpdateAngle` accumulation (`applyWorkBufferUpdates`) — a plausible dark-region mechanism for freshly streamed blocks.
- **Stock repro**: does the blob reproduce in a plain single-scene streaming export (no portals)? The stuck bar did — same trisection. If yes → unfixed upstream 2.20.x bug; file the issue with the `?colorize` evidence.

New findings held as **optional patches, awaiting user decision** (see progress.md ROUND 9 PREP, Conclusion 2): (i) #9011 guards are missing from the baked viewer engine and our SOG-mode `unloadScene` (entity.destroy) is exactly the race they fix — consider extending `viewer-engine-patch.ts` before the SOG E2E pass; (ii) our #8998 string patch omits upstream's `_failed` set, so a permanently-404 file re-downloads forever instead of parking.

**ROUND 9 UPDATE (2026-07-04, later same day):** user approved both patches — **SHIPPED** (`5fb66d1`: `patchViewerEngine`, 9 patterns, gsplat code now byte-identical to 2.20.5 — verified by patching the real 2.20.2 build and diffing; `882b9a3`: pre-existing lint error fix in `portal-preload.ts`). User E2E evidence: **mobile OOM reproduces on a fresh export** (remote debug still blocked — user is on Brave; try `brave://inspect/#devices` typed directly or Edge `edge://inspect/#devices`); **blob is 100% upstream** (uncolored under `?colorize` during streaming, reproduces single-scene AND on an unmodified branch) — upstream issue drafted at `docs/superpowers/2026-07-04-upstream-blob-issue-draft.md`, user to file. Full detail in progress.md "ROUND 9". Gates at `882b9a3`: 245/245 root, 47/47 server, tsc/lint clean, RELEASE build passed.

**ROUND 17 UPDATE (2026-07-04): phone walkthrough ✅ (5 min on WebGL2, user-verified). 3 Task-4 checks remain (A tight-budget eviction/reclaim, B SOG pass, C collision+R regression — exact steps in progress.md ROUND 17), then squash+finish.** Draft squash message for the whole branch (update the last line with A/B/C results before using):

```
feat(portals): budget-bounded resident scenes, engine-2.20.5 parity patch, WebGPU crash fallback

Exported streaming portal viewers keep as many scenes resident as fit a
device-derived budget: crossings are instant once the startup preload
completes (desktop-verified: zero re-streaming anywhere, incl. back to
start).

Residency: pure selectResidentScenes/assignPinDepths/computeResidentCeiling
(portal-preload.ts) — scene 0 + active force-admitted, neighbours by
recency, degradation coarsest-first with the active scene last (hard cap);
ceiling = ?residentBudget override, else mobile 3x splatBudget, else
desktop max(12x budget, min(project pyramid total, deviceMemoryGB x 16M,
128M)); RESIDENT_BUDGET_MULT 12 desktop / 3 mobile. Runtime: level-major
coarse-first wave pinning (PIN_WAVE=4; engine block loader is a per-scene
2-slot FIFO), scene-0 pin management, preload gated on viewer firstFrame,
mobile warming capped to 2 coarsest levels, [portals] ceiling/vram field
diagnostics, ready-gate watchdog + splatBudget backstop. SOG package
exports bake per-scene counts.

Engine patch (export-time, viewer-engine-patch.ts): splat-transform 2.7.1
bakes engine 2.20.2; patchViewerEngine applies 9 verified string patches
making its gsplat code byte-identical to 2.20.5 — PR #8998 incl. _failed
set (loading bar stuck at ~95% on cold cache, single-scene too) + PR #9011
unload-race guards. playcanvas 2.20.5 exact in root + server. REMOVAL:
delete viewer-engine-patch.ts + the companion watchdog when splat-transform
ships an engine >= 2.20.5.

WebGPU crash fallback (viewer-companion/device-fallback.ts, injected into
ALL exports): field case Adreno 618 loses the WebGPU device under
streaming churn at ~200-300MB tracked VRAM and engine 2.20.2 cannot
recover (handleDeviceLost null-adapter crash). First devicelost stamps
localStorage + navigates to the viewer's ?webgl; stamped devices boot
WebGL2 directly (sticky; ?webgpu clears). Chromium blocks 3D APIs
per-hostname after the crash and no JS reload can unblock
(source-verified), so recovery = one auto-reload then a localized overlay
(tap + browser-menu-reload hint). One crash ever per device.

Also fixed: ?residentBudget override was silently dead (template literal
cooked the regex digit escape — companion templates must never contain
backslash escapes; regression-tested) + a pre-existing lint error in
portal-preload.ts.

Known upstream (drafts: docs/superpowers/2026-07-04-upstream-*.md):
transient dark blob during streaming windows (reproduces on stock
single-scene exports; no fix through 2.20.5) and the handleDeviceLost
null-adapter crash.

User-verified E2E: desktop instant crossings; cold-cache bar completion;
mobile crash -> fallback -> stable 5-min WebGL2 walkthrough; tight-budget
eviction/reclaim; SOG package pass; collision + R-reset regression.
```

**ROUND 16 UPDATE (2026-07-04): MOBILE ISSUE CLOSED — user-verified working.** Field answers: tap-JS-reload does NOT unblock; pull-to-refresh unavailable (canvas suppresses overscroll); recovery = browser-menu reload. Polish `aad21dc`: overlay names the browser-menu path and shows the hint immediately. Final UX on a WebGPU-unsuitable device: one crash ever → overlay → one browser-menu reload → sticky WebGL2. REMAINING before squash/finish: Task-4 residual checklist (desktop `?residentBudget=200000` eviction re-check, SOG pass, collision+R regression, 5-min phone walk) + user files the two upstream drafts. Detail: progress.md "ROUND 16".

**ROUND 15 UPDATE (2026-07-04): auto-reloads can never clear Chromium's 3D-API domain block — recovery ladder shipped (`c8836d1`).** Chromium source research: after a GPU crash the hostname is blocked browser-wide; only a user/browser-initiated reload is confirmed to unblock (infobar `UnblockDomainFrom3DAPIs`); JS reloads aren't privileged. New ladder on the `?webgl` page: one auto-reload (2s) → localized tap-to-restart overlay → after a failed tap, add the pull-to-refresh hint. Worst case per device ever: one crash + one tap (+ one pull-to-refresh on strict builds), then sticky WebGL2. Detail: progress.md "ROUND 15".

**ROUND 14 UPDATE (2026-07-04): in-page probing disproved by field evidence — replaced with reload-backoff (`1adbd48`).** The round-13 probe loop failed for 60s while an immediate manual reload worked: repeated failed `getContext` attempts get the page instance blocked from context creation. Now: one probe per page load; on failure the `?webgl` page reloads itself with increasing backoff (1–6s, 6 attempts, sessionStorage counter so a no-webgl2 device never loops); the crashed page just waits 1s and navigates. Expected console on recovery: `reload n/6` lines, then the viewer up on webgl2 with no manual action. Detail: progress.md "ROUND 14".

**ROUND 13 UPDATE (2026-07-04): fallback verified on a true fresh export (`ceiling=1` — override fix works) but the reload landed in the GPU-process restart window** — the webgl boot threw 'WebGL not supported' until a manual reload. Fixed in `18eaad4`: both sides of the handoff now probe for a *creatable* webgl2 context (throwaway canvas per attempt, released via WEBgl_lose_context — see file for exact casing): the crashed page waits for it before navigating (15s cap), and the `?webgl` page reloads itself when the GPU process is back (60s cap). Expected UX: one crash, a few seconds black, automatic recovery — never a manual reload. Also: the previous round's "fresh" export was proven stale by curl (deployed page still had the cooked regex; log line numbers 2112/1225/1623 unmoved). Gates: 248/248 root, 47/47 server, tsc/lint clean, release build. PENDING: user E2E of the full crash→auto-recovery cycle; then the mobile issue closes. Detail: progress.md "ROUND 13".

**ROUND 12 UPDATE (2026-07-04): mobile issue root-caused and mitigated.** User confirmed `?webgl` is fully stable on the Redmi while WebGPU dies at 213MB tracked vram — Adreno 618 WebGPU (Dawn) churn instability confirmed; not memory, not residency. Per user decision (WebGPU default where it works, WebGL only where unsuitable), shipped `1d2a923`: an always-injected crash-fallback companion (`src/viewer-companion/device-fallback.ts`, all 3 export paths) — first WebGPU `devicelost` stamps localStorage and reloads with the viewer's `?webgl`; stamped devices boot straight into WebGL2; `?webgpu` clears the stamp; WebGL losses never loop; plain exports covered. Second upstream draft: `2026-07-04-upstream-devicelost-issue-draft.md` (handleDeviceLost null-adapter crash). PENDING: user fresh-export E2E of the fallback (at most one crash, then stable), then only the Task-4 residual checklist remains (incl. re-verifying the now-fixed `?residentBudget` lever on desktop). Detail: progress.md "ROUND 12".

**ROUND 11 UPDATE (2026-07-04): override lever was dead + hypothesis shifted to Adreno WebGPU instability.** The vram-instrumented runs revealed `?residentBudget` never applied — the companion runtime is a template literal, which cooked the regex `\d` escape to plain `d` at build time (shipped as a never-matching matcher). Fixed in `7b6bd21` (string-ops parser + regression test; repo lesson: **no backslash escapes inside the stringified companion templates**). The two runs (identical residency, since the "bisect" wasn't one) died at 200–305MB *tracked* VRAM — far below device capacity, correlated with streaming churn not a high-water mark (test 1 died with tex falling). Leading hypothesis now: **Adreno 618 WebGPU (Dawn) device-loss under gsplat streaming churn**, unrecoverable because 2.20.2's `handleDeviceLost` crashes on a null adapter. Discovery: the viewer already supports **`?webgl`** (WebGL2, works on the deployed export, no re-export). Next tests: (a) `?webgl` walkthrough — stable ⇒ WebGPU-stack issue ⇒ consider mobile-default-WebGL2 export patch; (b) fresh export → real `?residentBudget=1` bisect with vram curve. Full detail in progress.md "ROUND 11".

**ROUND 10 UPDATE (2026-07-04): mobile "OOM" root class identified — WebGPU DEVICE LOSS.** Remote logs (Brave inspect worked): residency ceiling held perfectly on the phone (3M cap, heavy degradation, scene 3 never admitted), then at/after the crossing to scene 1 Dawn dropped the device ("A valid external Instance reference no longer exists"), and engine 2.20.2's `handleDeviceLost` restore path itself crashed (null adapter → `requireFeature` TypeError). So the killer allocation is NOT the pinned set — suspects are the crossed scene's per-view fine streaming + the old scene's file resources awaiting cooldown (transient double-residency), or work-buffer growth. **Instrumentation shipped** (`6fe6fc7`): the companion now logs the engine's own VRAM accounting (`[portals] vram ... total=..MB`, 5s self-muting sampler + forced sample per crossing + `DEVICE LOST` line with last numbers). **Next mobile run needs**: FRESH export, capture the vram curve to the crash; then a `?residentBudget=1` bisect run; and confirm whether the crashed run had `?budget=1` (its ceiling read 3M = 3×1M, but the mobile default budget should be 2M). Full detail in progress.md "ROUND 10".

## Diagnostics available in the exported viewer (keep until stable)

- `[portals] ceiling=… costs=[…] resident=[…] depths=… deviceFinest=… active=…` — residency decision (deduped, on every reconcile).
- `[portals] startup not ready after 20s/45s: files=… env… loaderQueue=… | ver=… awaitingLod=… pendingLoad=… sortJobs=…` — ready-gate dump.
- `[portals] ready-gate watchdog repaired N…` / `…applied fallback splatBudget=…` — should NEVER appear now that the engine patch ships; if it does, the baked engine changed and `viewer-engine-patch.ts` missed (its console.warn at export time will also have fired).
- URL levers: `?residentBudget=<splats>` (resident ceiling override — unit = resident splats across ALL pinned LOD levels ≈ 1.9× finest sum), `?budget=<millions>` (viewer splatBudget), `?colorize` (LOD debug colors).

## After both issues close

Remaining plan-Task-4 checklist before squash/merge: tight-budget eviction re-check (`?residentBudget=200000` desktop), SOG (package) export mode pass, collision + `R`-reset regression, real-phone 5-min walkthrough. Then: squash the 16 branch commits to one (record final `RESIDENT_BUDGET_MULT` values + the engine-patch removal path in the message), `superpowers:finishing-a-development-branch` → FF-merge to local `main`. **Do NOT push.** Also consider filing the upstream engine issue for anything the blob investigation turns up, and remember plans #4–#6 of the portal series remain (see `portal-feature-audit-2026-07-02` memory).
