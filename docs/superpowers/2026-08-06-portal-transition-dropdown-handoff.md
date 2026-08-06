# Portal transition dropdown — hand-off

**Date:** 2026-08-06
**Branch:** `feat/portal-transition-dropdown` (12 implementation commits + docs, off `main` at `88a300c`)
**Spec:** `docs/superpowers/specs/2026-08-06-portal-transition-dropdown-design.md`
**Plan:** `docs/superpowers/plans/2026-08-06-portal-transition-dropdown.md`
**Status:** code complete, all automated gates green, **end-to-end pass NOT yet run**

## What shipped

The portal editor bar's `⧉` on/off toggle is now a three-way dropdown:

| choice | effect in the exported viewer |
| --- | --- |
| **None** | no cover; the scene switches immediately |
| **Defocus Dip** | **the default.** New: the whole frame blurs, desaturates and darkens, then comes back |
| **Tiles** | the existing tile dismantle/reconstruct, retimed and on a much finer grid; now opt-in |

**Defocus is the default and Tiles is opt-in.** `absent` resolves to Defocus, so
a pre-dropdown project whose portals played Tiles by virtue of having no field
now plays Defocus. Deliberate: nothing on disk is rewritten, only how absence is
read. A consequence worth knowing during E2E — the ~1200-div tile grid is not
built at all unless some portal explicitly selects Tiles, so the tile cover's
cost no longer applies to projects that never opt in.

### Final timings

| | dismantle | hold | reconstruct | total |
| --- | --- | --- | --- | --- |
| Tiles (was 375 / 100 / 375 = 850ms) | 250ms (150 sweep + 100 per-tile) | 67ms | 250ms | **567ms** |
| Defocus Dip | 213ms, `cubic-bezier(.32,0,.67,0)` | 67ms | 373ms, `cubic-bezier(.22,1,.36,1)` | **653ms** |

Defocus endpoints: `blur(26px) saturate(.45)`, veil `rgba(7,10,14,.9)`.

### Final grid

26px target, capped at 1200 tiles, minimum 6 × 4:

| viewport | before | after |
| --- | --- | --- |
| 390×844 phone | 6×13 = 78 | 15×32 = 480 (26px exact) |
| 1366×768 | 12×7 = 84 | 46×26 = 1196 |
| 1920×1080 | 17×10 = 170 | 45×26 = 1170 |
| 2560×1440 | 20×16 = 320 | 46×25 = 1150 |

Tile fly distance dropped 140px → 86.5px, tracking the smaller tiles.

### Data model

`PortalData.transition` is `'none' | 'tiles' | 'defocus' | undefined`, where **absent means `'defocus'`** — only an explicit `'tiles'` selects the tile cover. Legacy booleans are absorbed on read (`false` → `none`, `true` → the default). A document that never used the feature loads and re-saves **without gaining the field** — verified by test, and worth re-confirming by hand (see E2E below).

## Automated gates — all green at `e9664ba`

- `npm run test` — 50 files, **613 tests**, 0 failures
- `npm run lint` — exit 0
- `npm run build` (release) — exit 0, **0** `plugin typescript` warnings (was 6 mid-branch)
- Release-build survival of the stringified helpers in minified `dist/index.js`: `tileGrid`, `tileGeometry`, `tileDelay`, `transitionReducer`, `transitionKind`, `startDefocusIn`, `ss-portal-defocus`, `blur(26px) saturate(.45)` — all present

> **`npm run build` exiting 0 is not a type-check gate.** `@rollup/plugin-typescript` reports type errors as *warnings*. Always `grep -c "plugin typescript"` and require 0.

## PENDING REVIEW — 24 machine-assisted locale strings

`portals.transition` and `portals.transition.tooltip` were reused unchanged. English is authoritative; the other eight sets are machine-assisted and want a native read:

| locale | none | tiles | defocus |
| --- | --- | --- | --- |
| en | None | Tiles | Defocus Dip |
| fr | Aucune | Tuiles | Flou progressif |
| de | Keiner | Kacheln | Weichzeichnen |
| es | Ninguna | Mosaico | Desenfoque |
| pt-BR | Nenhuma | Mosaico | Desfoque |
| ru | Нет | Плитки | Расфокусировка |
| ja | なし | タイル | デフォーカス |
| ko | 없음 | 타일 | 디포커스 |
| zh-CN | 无 | 瓦片 | 失焦 |

Two worth a second look: **de "Keiner"** was chosen to agree with masculine *Übergang* — check it reads right in a dropdown. **es/pt-BR "Mosaico"** is a reasonable but not obvious rendering of "Tiles".

## E2E checklist — NOT YET RUN

### Export paths

- [ ] **Browser export.** From `npm run develop`, export a portal ZIP with one portal on Tiles and another on Defocus Dip. In the unzipped `index.html`: `grep -o 'ss-portal-defocus'`, `grep -o '"transition":"[a-z]*"'`, `grep -o 'blur(26px) saturate(.45)'` — all present, none mangled by minification.
- [ ] **Server export.** The export server bakes the viewer from a **separately compiled** `dist-shared/`. Rebuild `dist-shared` + `dist`, restart 3334, export, and grep the server-produced ZIP for the same markers. **A stale `dist-shared` ships the old cover with no test failing.** S3 publish shares `buildPortalBundle`, so one pass covers both.

### Behaviour, per cover

- [ ] Tiles portal, desktop — ~1170 fine tiles fly in edges→centre in ~250ms, swap, out centre→edges. Noticeably snappier and finer than before.
- [ ] **Tiles, no vertical seams at rest.** Reported and fixed once already: at the 26px target `scale(1.02)` gave only ~0.34px of overlap per side (it was ~1.09px at 110px tiles), so the scene showed through the `1fr` tracks' fractional pixel boundaries as full-height hairlines every ~4 columns. Now covered by an absolute `margin: -1px` bleed. Re-check at a few window widths and at DPR ≠ 1 — the failure is width-dependent, so one size proves little.
- [ ] Defocus portal, desktop — whole frame blurs and darkens over 213ms, swaps, returns over 373ms. No grid visible.
- [ ] None portal — instant switch, no cover at all.
- [ ] **Walk back mid-dismantle, once per cover kind** — cover reopens on the original scene, no swap. The defocus cancel path (dismantle → 67ms hold → reconstruct with no switch) has zero behavioural coverage.
- [ ] **Reset (R) mid-crossing, once per cover kind** — cover clears immediately, no stuck blur, no flash. `clearDefocus`'s flush sequence is the newest code on the branch.
- [ ] Cold streaming scene behind a **Defocus** portal — the `covered` phase is unbounded, so the blur holds for the *entire* load, not the budgeted ~590ms. Watch frame rate, heat and battery, and whether the opaque loading backdrop (z-index 2000) lets the compositor skip the blur beneath it.
- [ ] **Desktop drag-resize with a Tiles portal** — should be smooth; the resize handler is now coalesced at 150ms. Also resize *mid-crossing*: the rebuild is gated on `phase === 'idle'`, so tiles stretch non-square but must still cover.

### Platforms — the two real unknowns

- [ ] **Android, Defocus** — `backdrop-filter` over the WebGL canvas forces a per-frame compositor snapshot of the canvas backdrop. This is the effect's one genuine unknown. Watch for dropped frames, a black frame, or context loss.
- [ ] **Android, Tiles** — a *separate* failure mode: ~480 animated elements on a phone (was 78). **Tiles is the default every existing portal inherits**, so this ships to far more users than Defocus does. `will-change` has already been removed from both covers (see below), so this measures the version that would actually ship.
- [ ] iOS Safari — Defocus renders blurred (the `-webkit-` prefix carries it).
- [ ] A browser with `backdrop-filter` disabled (Firefox, `layout.css.backdrop-filter.enabled=false`) — should degrade to a plain dark fade via the 0.9 veil, not break.
- [ ] Reduced motion (OS setting on) — both covers become plain cross-fades: no tile motion, no blur, veil only.

### Editor UI

- [ ] Dropdown appears between the bounds button and Width; disabled with no portal selected, enabled with one.
- [ ] Switch to None, then Defocus Dip. Ctrl+Z twice walks back through None to Tiles; Ctrl+Y forward.
- [ ] Save, reload, reopen the portal — still reads Defocus Dip.
- [ ] Open a project saved before this change that had the transition disabled — reads **None**.
- [ ] Open a project saved before this change that had the transition *enabled* (no field) — reads **Defocus Dip**, and crossing it plays the defocus cover, not tiles. This is the intended re-pointing of the default; confirm it looks right rather than surprising.
- [ ] A fresh portal defaults to **Defocus Dip**, and the dropdown lists None / Defocus Dip / Tiles in that order.
- [ ] **The no-write path:** open a portal that never touched the field, open the dropdown, re-select Tiles, save. The `.ssproj` must still have **no** `transition` key on that portal. This is the invariant the whole migration story rests on.
- [ ] `?lng=fr` shows localized option labels.
- [ ] **Narrow window** — the dropdown replaces a 38px icon button with a ~200px label+select group in a bar already carrying six such groups. Check it wraps sanely (this repo has prior form here: `96d5a6a`).

### `will-change` removed from both covers

Applied after the branch review, not held back as a mitigation:

- `.ss-portal-tiles.armed .ss-portal-tile` used to carry `will-change: transform, opacity` (pre-existing, from `acb5dd4`). At up to 1200 cells that is far past the point the hint helps, and it had no lead time to work with — `startTileDismantle` adds `.armed` and starts the transition in the same frame. Browsers already promote an element with a running transform/opacity transition, so it was redundant for exactly the properties being animated.
- `.ss-portal-defocus.armed` used to carry `will-change: backdrop-filter, background-color` (added by this branch). A backdrop-filter transition composites regardless, and `background-color` is a paint property no compositor fast path covers — naming it bought a layer for nothing.

`expect(out).not.toContain('will-change')` on the injected viewer keeps either from creeping back; verified to fail when the tile rule is restored. Confirmed absent from the release bundle. The CSS comments explaining the absence deliberately avoid the hyphenated token so the assertion can stay an exact-token check.

### If Android still bites

Nothing needs reverting — Defocus is one element against the tile cover's ~1200, so switching a heavy scene's portals from Tiles to Defocus is the escape hatch (and None remains for anything pathological).

## Known deviations and accepted limits

- **Tiles can look different sizes across the two halves of a crossing on Android.** Verified as a rendering-speed artifact, not a geometry bug: on a slow compositor the staggered tiles land at visibly different scales mid-sweep. The grid itself cannot differ between the phases — `buildTiles()` runs only at startup and from the resize handler, which is gated on an idle phase, so one `cols × rows` drives both halves. Reproduced in the viewer's fullscreen mode (no URL bar, so no viewport change at all during the crossing) and *not* reproducible in a desktop DevTools mobile viewport, both of which point at compositing throughput rather than layout.
- **A resize during a crossing silently discards its grid rebuild.** Separate from the above and never observed — noted only because the code path is real. The coalesced resize handler fires 150ms after the last resize event; if the phase is not `idle` by then it returns without rebuilding *and without rescheduling*. The layer is `position: fixed; inset: 0` with `1fr` tracks, so it would restretch to the new viewport while `cols × rows` stayed frozen. The fix, if it ever surfaces, is to remember that a rebuild is owed and run it when the phase returns to idle.
- **Defocus hold is 67ms, not the 73ms the spec's arithmetic derives.** It reuses the tile cover's `T_HOLD` rather than minting a second constant. 6ms, imperceptible, deliberate.
- **Rolling back to an older build turns None into Tiles.** The old test is `transition !== false`, and `'none' !== false`. An author who deliberately disabled the transition gets it back. No encoding satisfies both directions; accepted, not solved.
- **`transitionKind` (viewer runtime) duplicates `normalizePortalTransition`.** Forced by the injection boundary — the normalizer is deliberately not stringified. Cross-referencing comments were added at both sites; a future fourth kind must be added in both places.
- **No unit-test seam for either animation's runtime behaviour.** `src/viewer-companion/portals.ts` is a template literal injected verbatim, so string assertions against the injected source are the only automated coverage possible. Same for the editor UI: this repo has no PCUI test harness.
- **The base `.ss-portal-defocus` CSS duplicates `T_DEFOCUS_IN` / `DEFOCUS_IN_EASE`.** Always overridden inline by the drivers; kept as a documented pre-arm default and commented as such.

## Process notes worth keeping

Three defects were caught that automated gates would not have found:

1. **The plan's tile cap did not cap.** An axis already pinned to its 6/4 minimum was scaled down and reclamped straight back up, re-inflating the product — `tileGrid(100, 5000)` returned `6 × 244 = 1464` against a stated 1200 ceiling. Caught by a reviewer hand-executing the arithmetic. Fixed in `c0fc752` with a regression test.
2. **The spec's risk figure was optimistic by half.** The tile-count delta was measured against the old grid's 320 *ceiling* rather than what it actually returned (170 at 1920×1080). Real delta: ~6.9×, not ~3.7×. Corrected in `c68e396` before the Android verdict gets judged against it.
3. **Four assertions passed even when the thing they protected was deleted** — including one written *for* the fix wave, which matched an identical string in an unrelated CSS rule. Only break-and-restore verification exposed it. Fixed in `e9664ba`.
