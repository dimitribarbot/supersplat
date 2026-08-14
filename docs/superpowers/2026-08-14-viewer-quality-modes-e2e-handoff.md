# Exported-viewer quality modes — shipped

**Written:** 2026-08-14
**State:** DONE. All six plan tasks implemented and reviewed; a final whole-branch review plus
three further review rounds landed; E2E run and passed on desktop and on a real phone (Xiaomi
Redmi Note 9S, Adreno 618, 6 cores, 4GB, WebGL2), including the watchdog failure recorded below
and its fix. Squashed to a single commit and merged to `main`.
Gates at merge: 829/829 tests, `npm run lint` clean, build gate 0 TypeScript errors.

**One item remains open: the locale review.** Nine locales carry machine-assisted strings that were
never signed off — the `q`/`perf`/`normal` labels, the abbreviated perf labels
(`Perf`, `Rend.`, `Desemp.`, `Произв.`), the Japanese `性能`, and the three per-mode descriptions
in the dropdown (27 strings). English and French are the author's own; the other seven are
machine-assisted. See `LABELS` in `src/viewer-companion/quality-mode.ts`.

---

## What shipped

Three quality modes (Performance / Normal / HD) in the exported viewer, chosen from a *device
capability class* rather than the stock mobile/desktop user-agent split, auto-selected at startup by
a synchronous heuristic and corrected downward by a passive frame-time watchdog.

| File | Change |
|---|---|
| `src/quality-tier.ts` | **new** — pure, unit-tested decision layer (classing, auto pick, HD budget, precedence, demotion). Stringified verbatim into the viewer runtime, so every function is self-contained. |
| `src/viewer-engine-patch.ts` | +1 patch (`VIEWER_ENGINE_PATCH_COUNT` 7 → 8): budget table by device class + the HD tier. |
| `src/viewer-companion/quality-mode.ts` | **new** — the companion: mode resolution, published globals, dropdown settings control (9 locales), demote-only watchdog. |
| `src/splat-export-core.ts` | `injectQualityMode` on all three export paths. |
| `src/viewer-companion/portals.ts` | resident ceiling now derives from a **constant** reference budget, not the live splat budget. |

Budget table: `weak` 1M/2M/6M, `standard`+mobile 2M/4M/6M, `standard`+desktop 2M/4M/14M.

Suite: 829 tests green at merge. Lint clean. Build gate
(`grep -c "plugin typescript"`) = 0.

## Two real bugs the final review caught — read these before touching the code

Both were found only by a whole-branch view, and both had passed their task-scoped reviews.

**1. The settings control raced `initUI()` and could kill the viewer outright.**
`#performanceModeRow` is **static markup in the exported HTML template**, not built by `initUI` —
the plan asserted the opposite and built a 500 ms poll on that false premise. `initUI` merely
*captures* the row by id, unconditionally, after two awaits (`await settings`,
`await createGraphicsDevice`), then derefs it. The companion is a classic inline script, so its poll
starts during parse; if the first tick won, it detached the row and stripped its id, `initUI` threw,
`main()` rejected, and the **whole viewer failed to load** — taking device-fallback, portals and the
iframe API with it. A warm desktop usually won the race; a phone or a cold ZIP fetch did not.
Fixed by gating `buildControl()` on `window.__supersplatViewer`, which `splat-export-core.ts` sets
immediately after `await main(...)` — i.e. strictly after the capture. **Generalisable lesson: verify
whether viewer DOM is static template markup before writing a poll for it.**

**2. The legacy migration pinned every returning visitor, making the feature inert.**
The stock viewer calls `updatePerformanceMode()` *unconditionally at init*, which does
`localStorage.setItem('performanceMode', ...)`. So anyone who has ever opened any SuperSplat viewer
on that origin already holds the key at the platform default — and the migration then treated it as
a deliberate choice and pinned them, disabling auto-HD and the watchdog for a publish origin's whole
existing audience (and for the developer's own machine). Fixed by threading `isMobile` into
`resolveQualityMode` and migrating **only when the stored value differs from the platform default**.
**Lesson: presence of a persisted key is not evidence of a user choice.**

## E2E verification — run and passed

Kept as the regression list for any future change to this feature. Re-run it on a RELEASE build
(`npm run build`) — stringified helpers behave differently under debug builds, and this fork has
been bitten by that before. Serve via `npm run dev` from `server/` (port 3334) so the export paths
and the app are same-origin.

**Clear `localStorage` between runs.** Otherwise bug 2's old behaviour is indistinguishable from a
pin you set yourself, and scenarios 1 and 4 will read as "the heuristic doesn't work".

Scenario 4 is the one that failed in the field; its root cause and fix are recorded inline below,
and it passed on re-test along with everything else.

- [x] **1. Desktop single-scene.** The Quality dropdown appears in the settings panel. Console logs
      `[quality] class=standard mode=hd hd=14M`. Switching modes re-runs `applyPerfSettings` with no
      reload; `app.scene.gsplat.splatBudget` reads 2000000 / 4000000 / 14000000 for perf / normal / hd.
- [x] **2. Desktop portal export.** HD reaches 14M. The `[portals] ceiling/costs/resident/depths`
      line reports the same ceiling in all three modes, and that ceiling matches what `main` reported
      before this branch.
- [x] **3. Mobile portal export, real phone — use a MID-RANGE OR OLDER handset, not only a recent
      one.** Heuristic picks perf or normal, never hd. Manual HD reaches 6M on a small project. The
      ceiling stays 6M in all three modes. Walk the full portal chain twice: no new eviction or
      re-streaming versus `main`, and **the device-fallback overlay must not appear** — every
      standard-class phone now defaults to Normal, which is 1.0 resolution scale (4× the pixels of
      the old mobile default) *and* 4M, together.
- [x] **4. Watchdog — FAILED, then FIXED.** First run (Xiaomi Redmi Note 9S, Adreno 618, 6 cores,
      4GB): no `[quality] watchdog` line ever appeared. Root cause: the watchdog's only arming
      path was `g.events.on('firstFrame', ...)`, and an upstream engine ready-gate race can
      withhold `firstFrame` forever on cold/slow loads (the same race `portals.ts` already
      documents and works around) — and separately, the demotion ladder could reach `perf` (2M)
      but never `weak`'s 1M table, because the class stayed `standard` no matter how many mode
      demotions fired. Fixed by (a) a bounded ~30s fallback arm plus a `wdArmed`-based interval
      clear condition (the previous clear condition cleared the moment the `firstFrame` listener
      attached, before any fallback tick could run), and (b) a third ladder step,
      `perf -> perf@weak`, that demotes the device class. See
      `docs/superpowers/specs/2026-08-13-viewer-quality-modes-design.md`'s "Field failure"
      section. **Re-test required:** on a struggling device or a deliberately heavy scene,
      confirm exactly one demotion step at a time (up to three total, ending `perf@weak`), no
      oscillation, `ssQualityAutoFloor` + `ssQualityAutoClass` written, reload starts at the
      demoted tier. Then pick a mode manually and confirm the watchdog stops firing.
- [x] **5. Legacy migration.** With only `performanceMode` in localStorage **at a value differing
      from the platform default** (`'true'` on desktop, `'false'` on mobile), confirm it migrates
      once, pins, and writes `ssQualityMode`. With it at the platform default, confirm it does NOT
      pin and the heuristic runs. On a fresh origin confirm `ssQualityMode` is written as `'auto'`
      and the heuristic re-runs on reload.
- [x] **6. `?budget=` still wins.** `?budget=8` → 8M in every mode, while the segments still change
      the resolution scale.
- [x] **7. Locale check.** Non-English browser locale: the control's labels render (they come from
      the companion's own table, not the viewer's i18n).
- [x] **8. Cold-cache ZIP export (new — direct regression test for bug 1).** Throttle the network or
      use a cold cache on a ZIP export and confirm the viewer still boots and the Quality row still
      appears. This is the scenario that would have caught the `initUI` race.
- [x] **9. Redmi Note 9S re-test (new — direct regression test for the scenario-4 field failure).**
      Same device as the field failure (Adreno 618, 6 cores, 4GB, WebGL2), fresh `localStorage`.
      Confirm the console now logs `[quality] class=weak mode=perf hd=6M` (the `<=4GB` mobile
      threshold now classes this device `weak` directly, so it should open at Performance / 1M /
      0.5 resolution scale without ever needing a demotion) and that texture memory does not
      approach the 200–300MB band that previously triggered the device-fallback overlay on this
      GPU family.

## Locale review — STILL OUTSTANDING (the one open item)

The nine label sets in `quality-mode.ts` ("Quality" / "Performance" / "Normal"; HD is untranslated by
design) are machine-assisted and need sign-off per this repo's convention: de, es, fr, ja, ko, pt,
ru, zh. Note the unit test only asserts the "Quality" noun for 8 of 9 locales — the per-mode labels
are unverified by any test.

## Parked / deferred, with the reasoning

- **`portals.ts` ready-gate fallback comment** calls `(IS_MOBILE ? 2 : 4) * 1000000` "the
  platform-split Normal-mode budget". Imprecise: for a *standard*-class phone Normal is 4M, not 2M —
  2M is `weak`-class Normal or `standard`-class Perf. Comment only, zero behavioural effect. The
  constant itself is deliberately a physical-platform split and must NOT become class-aware.
- **`ssQualityAutoFloor` is per-origin and permanent.** One heavy model demoting on a shared publish
  origin (an S3 bucket serving many exports) caps every other model on that origin forever, with no
  expiry and no user-visible explanation. Worth a design decision: stamp it with a timestamp and
  expire it, or key it by content URL.
- **`deviceFinest` does not un-ratchet.** It is a running minimum, so time spent in HD ratchets it
  finer for the rest of the session; after a demotion the neighbour pin depths stay degraded until
  reload. Memory-safe and self-healing on reload. Recorded in the spec.
- **The stock `retinaDisplay` → `performanceMode` migration is preempted** by the companion seeding
  `performanceMode` at parse time, so an old `retinaDisplay` preference is silently dropped. Affects
  only pre-`performanceMode` viewers.
- **With `localStorage` unavailable**, `__ssQualityMode` and `state.performanceMode` disagree for the
  session (the UI says Normal while the viewer runs Perf's 0.5 scale). Conservative, not dangerous.
- **Nothing reconciles `__ssQualityMode` if the stock toggle is somehow clicked without
  replacement** — near-moot now the control gates on the viewer handle and the row is static markup.
- **Watchdog details:** the sample buffer trims at 240 rather than a strict rolling 120 (bounded,
  recency-biased); there is no retry or log if `armWatchdog`'s single precondition check fails.

## Traps worth carrying forward

1. **The budget logic is not in this repo.** `applyPerfSettings`, the `budgets` table and
   `state.performanceMode` live in the stock viewer bundle inside `@playcanvas/splat-transform`.
2. **That bundle is escape-encoded inside a JS string literal** (0-based line 21312 of
   `node_modules/@playcanvas/splat-transform/dist/index.mjs`); the **static HTML template is the
   previous line, 21310**. Grepping `index.mjs` directly gives false negatives — decode first.
   Re-run the anchor check on any splat-transform bump: patch #8 is as bump-fragile as the other 7.
3. **Companions are classic `<script>`, so they run BEFORE `main()`** — that is what makes a
   synchronous startup heuristic possible, and why it must stay synchronous.
4. **`app.autoRender = false` after the ready gate**, so a still camera draws nothing and a passive
   FPS benchmark measures nothing. The watchdog samples only naturally occurring frames.
5. **Stringified helpers are NOT ES5** — `Function.toString()` emits whatever TypeScript produced.
   The ES5 rule binds hand-written runtime code only.
6. **No backslash escapes anywhere in a companion template literal, including in comments.**
