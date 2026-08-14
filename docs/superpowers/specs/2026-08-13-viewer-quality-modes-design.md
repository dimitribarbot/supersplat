# Exported-viewer quality modes (Performance / Normal / HD) + device auto-detection

**Date:** 2026-08-13
**Status:** design approved, implementation plan pending
**Scope:** exported viewer runtime only — no editor UI, no `.ssproj` state, no `settings.json` field

## Field failure (2026-08-14) that drove three follow-up fixes

A Xiaomi Redmi Note 9S (Adreno 618, 6 cores, 4GB, WebGL2) classed `standard`, opened at Normal
(4M, 1.0 resolution scale) and reached 273MB of textures — inside the 200–300MB band where
this exact GPU family previously dropped its device (`device-fallback.ts`) — with no
`[quality] watchdog` line ever appearing in the console. Root causes and fixes, all above:

1. The watchdog's only arming path was `firstFrame`, which an upstream engine ready-gate race
   can withhold forever (see `portals.ts`'s own watchdog for the same race). Fixed with a
   bounded ~30s fallback arm, and a fix to the ready-poll interval's clear condition, which
   previously cleared the moment the `firstFrame` listener was attached — before any fallback
   tick could ever run.
2. The demotion ladder could reach `perf` (2M) but never `weak`'s 1M table, because the engine
   patch keys the budget table off the device CLASS, and the watchdog only ever demoted the
   MODE. Fixed by extending the ladder to a third step, `perf -> perf@weak`, that demotes the
   class.
3. The mobile "weak" memory threshold (`<=3GB`) missed this exact device (`4GB`), which is why
   it opened at Normal instead of Performance in the first place. Raised to `<=4GB`.

## Problem

The exported viewer has two quality levels driven by one boolean, `state.performanceMode`,
defaulting to `platform.mobile` and persisted to `localStorage`. The stock budget table
(splat-transform 3.1.7, in `applyPerfSettings`) is:

```js
const budgets = {
    mobile:  { low: 1, high: 2 },
    desktop: { low: 2, high: 4 }
};
```

Two gaps:

1. **No high-quality tier.** A capable desktop is capped at 4M splats, well below what it
   can render.
2. **The tier is chosen by user-agent, not capability.** A recent phone is pinned to 2M
   even though it comfortably renders 4M; conversely a software-rendering desktop
   (SwiftShader/llvmpipe) gets the full desktop table.

## Solution overview

Three modes — **Performance / Normal / HD** — selected from a *device class* rather than
from the mobile/desktop user-agent split, picked automatically at startup by a synchronous
heuristic, and corrected downward by a passive frame-time watchdog. An explicit choice in
the viewer's settings panel always wins and is persisted.

Implemented as one new always-injected companion plus **one** engine patch line.

## Budget table

```
                       perf   normal    hd
weak                    1M      2M      6M
standard, mobile        2M      4M      6M
standard, desktop       2M      4M     14M
```

The `perf`/`normal` columns are exactly the stock `budgets.mobile` and `budgets.desktop`
objects, reused verbatim — `weak` maps to the former, `standard` to the latter. No patch to
the table literal is required.

HD is the only column that does not follow the `weak`/`standard` split alone, because HD is
the only mode bounded by **memory** rather than by GPU throughput. Its rule is:

```js
__ssHdBudget = (qualityClass === 'standard' && !isMobile) ? 14 : 6;
```

so 14M requires *both* a standard class and a desktop; weak desktops and all phones get 6M.
6M is not arbitrary: it is
exactly the resident ceiling this fork already treats as mobile-safe (`3 × 2M` ≈ 120–150 MB
at the measured ~20–25 bytes/splat). Mobile HD therefore means *use all of the memory the
fork already considers safe on a phone*. The 14M originally proposed for mobile would be
~280–350 MB, above the range where a field Adreno 618 dropped its WebGPU device (the reason
`viewer-companion/device-fallback.ts` exists).

**HD changes the splat budget and nothing else.** Canvas resolution scale (`0.5` in
Performance, `1.0` otherwise), `colorUpdateAngle` (4 / 2), and the pixel-ratio cap
`maxPixelDim` (1080 mobile / 2160 desktop) are all untouched. Splat count is what drives
perceived splat detail; resolution is the dominant fill cost and the most common cause of
stutter, so leaving it alone keeps HD cheap to auto-select and gives the feature one variable
to reason about.

**But the auto-selected mobile default moves, and that change is not budget-only.** Today
every phone defaults to Performance (`platform.mobile`): 0.5 resolution scale,
`colorUpdateAngle` 4, 2M splats. After this work every phone classing `standard` — which is
deliberately *all* iPhones and every Android with unknown signals — defaults to **Normal**:
1.0 scale (**4× the pixels**), `colorUpdateAngle` 2, and 4M splats (2× the budget), all at
once. The "budget only" claim above is a statement about HD-vs-Normal, not about the new
mobile default. This is an accepted, deliberate trade: making signal-less mobile default to
Performance would make the feature inert across all of iOS, and the demote watchdog is the
intended recovery. It does mean the default mobile path now sits materially closer to the
memory/throughput ceiling that motivated `viewer-companion/device-fallback.ts` (a field
Adreno 618 dropping its WebGPU device at ~200–300 MB) for *every* phone user, not only for
those who opt into HD.

## Architecture

### `state.performanceMode` keeps its exact current meaning

`performanceMode` continues to mean **"is Performance mode"** — HD and Normal both leave it
`false`. This is the load-bearing decision of the design: it means the resolution scale,
`colorUpdateAngle`, the stock persistence, and the fork's existing
`performanceMode:changed` listener in `portals.ts:1126` all keep working with no further
patching.

The tri-state lives beside it in `window.__ssQualityMode` (`'perf' | 'normal' | 'hd'`),
published by the companion.

### The single engine patch

Two adjacent lines inside `applyPerfSettings`'s `budget()`, verified to occur exactly once in
the splat-transform 3.1.7 baked bundle:

```js
// search
const quality = platform.mobile ? budgets.mobile : budgets.desktop;
return state.performanceMode ? quality.low : quality.high;
// replace
const quality = (window.__ssQualityClass === 'weak') ? budgets.mobile : budgets.desktop;
return (window.__ssQualityMode === 'hd') ? (window.__ssHdBudget || 14)
                                         : (state.performanceMode ? quality.low : quality.high);
```

Self-destructing (the search text does not reappear), so no `applied` marker is needed —
matching the other nav-guard patches. `?budget=` still wins: `config.budget` returns earlier
in the same function and is untouched.

All policy lives in the companion's published globals, so the patch carries no logic and the
decision rules stay in unit-tested TypeScript.

### Mode changes at runtime

```
set window.__ssQualityMode
set state.performanceMode = (mode === 'perf')     // observe() fires the event if it changed
if the boolean did not change: global.events.fire('performanceMode:changed')
```

Either path re-runs `applyPerfSettings`, which picks up the new globals. Care is needed not
to double-fire: `observe()` fires automatically on a real change, so the manual fire is only
for Normal↔HD, where the boolean is stable. `portals.ts`'s existing listener then handles all
six transitions with no change.

### Companion phases

`src/viewer-companion/quality-mode.ts` is a classic `<script>` injected before `</body>`, so
it executes at parse time — **before** the deferred `<script type="module">` bootstrap calls
`main()`. Two phases:

**Phase 1 (synchronous, at parse time):** resolve the mode, publish
`window.__ssQualityMode` / `__ssQualityClass` / `__ssHdBudget`, and seed
`localStorage.performanceMode` so the stock viewer's own state default lands on the right
boolean.

The heuristic is deliberately synchronous. WebGPU `adapter.info`/`adapter.limits` would be a
better mobile signal but require an async `requestAdapter()`, and `state.performanceMode`'s
initial value is read synchronously early in `main()`. Sync-only signals keep the design
single-phase.

**Phase 2 (after the viewer handle appears, polled as `device-fallback` does):** build the
segmented control and arm the watchdog.

## Device classing

```
weak if:
    gpu contains 'swiftshader' | 'llvmpipe' | 'basic render'   software rendering, any platform
  | cores <= 2
  | memGB known and <= 2
  | mobile and memGB known and <= 4                            budget Android
  | mobile and gpu contains 'mali-4' | 'mali-t' | 'powervr sgx'
  | mobile and gpu contains 'adreno' and its model number < 500
standard otherwise                                             including all iOS and all unknowns
```

All GPU matching is `indexOf` on a lowercased renderer string (see *Authoring constraints*);
the Adreno rule parses the digits following `'adreno '` and compares numerically rather than
pattern-matching a digit range. Adreno 5xx and above class as `standard` under this rule —
including the Adreno 618 of the `device-fallback` field report, whose failure was a memory
ceiling at 200–300 MB, not throughput. That device *was* pushed into that band — it reached
273 MB at Normal (see the Field failure section above); the Adreno rule alone did not save it.
What catches it now is the tightened `<=4 GB` mobile memory rule below, not the Adreno model
rule. The Adreno threshold itself stays at `< 500` regardless: it targets a genuine throughput
cliff in older Adreno generations that cannot sustain the frame budget at all, which is a
separate failure mode from the memory ceiling the 4 GB rule addresses, and tightening it
further would not have caught a 4 GB, Adreno-618 device anyway.

Signals: `platform.mobile` (UA test mirroring `IS_MOBILE` in `portals.ts`),
`navigator.hardwareConcurrency`, `navigator.deviceMemory`, and `UNMASKED_RENDERER_WEBGL`
read from a throwaway 1×1 WebGL context.

**Unknown devices class as `standard` on purpose.** iOS provides no `deviceMemory` and
reports a generic `"Apple GPU"` renderer string for every model, so there is no signal that
separates a recent iPhone from an old one. Classing optimistically is safe in the narrow sense
that — given the resident-ceiling decision below — misclassing a phone's **render budget**
alone is only a **frame-rate** error, never a **memory** one, and frame-rate errors are
exactly what the watchdog recovers from. That does not make misclassing free, though: the
mobile default's move from Performance to Normal also raises resolution scale (1.0 instead of
0.5), and the Field failure section above shows the combination — 4M splats *and* 4× the
pixels — reaching the device-fallback band on a real device. The `<=4 GB` mobile memory
threshold exists precisely to keep devices like that out of `standard` in the first place.

**Known uncertainty:** `navigator.hardwareConcurrency` values on iOS Safari are not reliably
documented and Safari may clamp them. The rules above are written so iOS never depends on
it — `cores <= 2` would only catch a genuinely ancient device, and every mobile-specific rule
requires a signal iOS does not provide. If this is wrong in the field, the failure mode on an
old phone is not the 4M budget alone: classing `standard` also means defaulting to Normal,
so the device gets **4M splats *and* a 4× pixel count** (1.0 resolution scale instead of
0.5), plus `colorUpdateAngle` 2 instead of 4. Both land together, and the watchdog's demotion
to Performance is what reverses both.

### The heuristic never auto-selects HD on mobile

HD is fully available on mobile as a manual pick, but the heuristic only reaches for it on
desktop:

```
hd if:  standard and not mobile
        and cores >= 8
        and (memGB unknown or >= 8)
        and gpu contains 'nvidia' | 'geforce' | 'rtx' | 'gtx'
                       | 'radeon rx' | 'apple m' | 'arc a'
```

Rationale: iOS gives no usable capability signal, and the mobile HD gain is a modest 4M→6M,
so guessing wrong costs more than guessing right wins.

## The demote-only watchdog

```
arm      : firstFrame + 3s settle, OR a bounded 30s fallback if firstFrame never fires
sample   : count app.on('frameend') ticks over a rolling window, via performance.now()
discard  : window > 10s (WD_MAX_WINDOW_MS)   (interrupted, not a rate -- a backgrounded
           tab or a throttled page); a visibilitychange transition resets the window
           outright, since a hidden tab fires no rAF ticks at all
decide   : a closed 3s (WD_WINDOW_MS) window's rate < 30fps (WD_MIN_FPS)  =>  demote one step
re-arm   : zero the counter, restamp the window start, settle 3s, may fire again
bounds   : hd -> normal -> perf -> perf@weak, at most three steps; never promotes
```

It forces nothing to render. `app.autoRender = false` (set at the ready gate) only gates
`app.render()` — in the engine's frame loop `this.fire('frameend')` sits OUTSIDE that check, so
it fires on every requestAnimationFrame tick regardless. A still camera therefore still
produces `frameend` events, just cheap ones: an idle device reads close to its display refresh
rate (60fps, comfortably above the 30fps floor, no demotion), while a device that is genuinely
struggling reads its true, low rate even while the camera happens to be still. That is what
makes a passive frame counter work here. A window that mixes idle ticks with camera-driven
rendering averages toward "healthy", though — a run of cheap idle ticks outweighs a handful of
laggy rendered ones in the same window — so a verdict still needs sustained interaction to be
trustworthy. That is intentional, and it is the same behaviour the previous per-frame-delta
sampler had: a user who barely moved the camera has not demonstrated a problem.

**Arming.** `firstFrame` is the preferred trigger, but it is not reliable: an upstream engine
ready-gate race can retain a pending octree entry forever, so `world.pendingLoadCount` never
reaches 0, the viewer's ready gate never fires, and `firstFrame` never fires with it. This is
the same race `portals.ts` already documents and works around with its own ready-gate
watchdog (around its "engine ready-gate watchdog" comment) and a ~30s frame-capped fallback
("in case firstFrame never fires"). It happens on cold/slow loads — exactly the struggling
devices this watchdog exists to correct — so without a fallback, a device stuck in that race
would never get a demotion. The quality watchdog now carries the matching ~30s fallback:
`wdFallbackAt` is recorded when the `firstFrame` listener is attached, and the ready-poll
interval checks it on every tick, calling `armWatchdog()` once it elapses. `armWatchdog()` is
idempotent, so a late real `firstFrame` after a fallback arm is a harmless no-op. Arming
mid-load is acceptable: a frame counter has no per-sample discard cap to blind it — a stall
simply holds the window's count down instead — and on a device whose load never completes,
demoting is the right response anyway (a lower budget means less
streaming).

**Demote-only** is deliberate. Promoting mid-session raises the budget, which makes the
engine stream finer LOD — visible pop-in plus a portal pin reconcile. Demoting makes things
lighter, which is what a struggling device wants. One-way also makes oscillation impossible.

**The third step demotes the CLASS, not just the mode.** The engine patch picks its budget
table with `(qualityClass === 'weak') ? budgets.mobile : budgets.desktop`, so a
`standard`-classed device floors its Performance mode at `budgets.desktop.low` = 2M — the
`weak` table's 1M is unreachable however badly the device struggles, unless something also
demotes the class. `demoteQuality(mode, cls)` therefore returns both fields: `hd -> normal`
and `normal -> perf` carry the class through unchanged; `perf` with a `standard` class steps
to `perf` with a `weak` class (2M → 1M); `perf` already `weak` is returned unchanged (the
floor). Class demotion applies on desktop too, not only mobile — this step is only ever
reached after two earlier mode demotions already failed to help, which is itself the
definition of a struggling device regardless of platform.

A demotion writes `ssQualityAutoFloor` (mode) and `ssQualityAutoClass` (class) so a returning
visitor starts at the corrected tier instead of re-earning the slow first minute. Because a
`perf -> perf@weak` step leaves the MODE identical, `__ssQualityApply`'s "fire
`performanceMode:changed` manually only when the mode changed" condition is extended to also
fire when the CLASS changed — otherwise the re-apply would be skipped and the lower HD budget
would never take effect. Exactly one of the two re-apply paths (the `state.performanceMode`
setter, or the manual event fire) still fires per call, never both.

## Persistence and precedence

```
?budget=<n>          -> forces the numeric budget (stock behaviour, untouched)
ssQualityMode set    -> manual pick, pinned, watchdog off
ssQualityMode absent
  + legacy performanceMode DIFFERING from the stock platform default
                     -> migrate once to perf/normal, pin
ssQualityMode='auto' -> heuristic (capped by ssQualityAutoFloor) + watchdog
```

**`ssQualityAutoClass`.** Written alongside `ssQualityAutoFloor` on every watchdog demotion
that survives past the current session (see the persistence gate below), holding the demoted
class (`'weak'` once the third ladder step has fired). Unlike the mode floor, it is read and
applied **unconditionally at startup** — right after `pickQualityClass` runs and before
`pickAutoMode` — not gated on the `'auto'` path: it is a measurement of the DEVICE, not a mode
preference, so a returning visitor's next session starts from it even without a manual pick.
A manual pick, however, wipes both `ssQualityAutoFloor` and `ssQualityAutoClass` and reverts
the live class to the heuristic's own answer immediately, in the same session — a deliberate
choice already pins the mode and switches the watchdog off, so the stored auto-correction is
dead weight from that point on, and leaving it in place would silently cap an explicit HD pick
at the weak budget (6M) instead of 14M. This is a deliberate reversal of an earlier design
decision: a manual pick was previously specified to keep the demoted class (yielding 6M for a
manual HD pick), which left the state permanently sticky per origin with no reset path short
of clearing `localStorage` by hand.

**A watchdog demotion taken before `firstFrame` has fired is session-only.** The fallback
arm (above) can act on a demotion mid-load, and that action is correct — a device stuck
mid-load genuinely benefits from a lower budget — but the reading may say more about the load
than about the device, so it must not be written to `ssQualityAutoFloor` /
`ssQualityAutoClass`. The write is gated on a flag set only inside the real `firstFrame`
listener; if `firstFrame` fires late, after a fallback arm, later demotions persist normally.

The legacy migration keys on the legacy **value**, not on its presence. The stock viewer
writes `localStorage.performanceMode` unconditionally at init (its `updatePerformanceMode()`
runs once immediately, not only on toggle), seeded from `platform.mobile` — so everyone who
has ever opened any viewer on the origin already holds the key at the platform default.
Migrating on presence alone would pin that entire existing audience (returning desktops stuck
on Normal, returning phones stuck on Performance) and make the feature inert. Only a value
that differs from `String(isMobile)` can have come from a deliberate toggle. Accepted trade:
a user who explicitly selected the value equal to their platform default loses that pin and
gets the heuristic; the watchdog covers the downside.

Writing `'auto'` explicitly on first run is required for correctness: without it, the
`performanceMode` value the companion seeds for the stock viewer's default would be misread
as a legacy manual pick on the next visit.

The legacy migration mirrors the `retinaDisplay` → `performanceMode` migration the stock
viewer already performs, and respects choices returning visitors have already made.

With `?budget=` present the segmented control still sets the mode (so resolution scale still
responds) but the budget stays pinned to the URL value.

## Settings-panel UI

A single "Quality" row holding three exclusive segments, replacing the stock
`#performanceModeRow`:

```
┌─ Settings ─────────────────┐
│ Quality  [Perf|Normal| HD ] │
│ ─────────────────────────── │
│ Gaming Controls        (●)  │
└─────────────────────────────┘
```

The row must be **clone-replaced**, not `innerHTML`-rewritten: the stock click listener is
bound to the row element itself and would otherwise keep flipping `performanceMode` on every
click inside it. The stale `dom.performanceModeCheck` reference the stock code retains then
points at a detached node, so its `classList.toggle` is a harmless no-op.

Labels ship in the same nine languages as `DEFAULT_MESSAGES` in `portals.ts` (en, de, es, fr,
ja, ko, pt, ru, zh), using the same region-subtag → base-subtag → English resolution.

## Portal resident ceiling: decoupled from the render budget

In portal (multi-scene) exports this fork bounds cross-scene residency with
`computeResidentCeiling` (`src/portal-preload.ts:345`), derived from the live engine splat
budget:

```js
const floor = splatBudget * mult;        // mult = 3 mobile, 12 desktop
if (isMobile) return floor;              // no RAM cap on mobile
const cap  = gb * 16_000_000;
return Math.max(floor, Math.min(totalCost, cap));
```

Left as-is, HD would drive this to `3 × 14M = 42M` on mobile and `12 × 14M = 168M` on
desktop — the latter overriding the RAM-derived 128M cap entirely, undoing the protection the
budget-residency work established.

**Change:** the call site in `portals.ts` passes a **constant reference budget**
(`IS_MOBILE ? 2_000_000 : 4_000_000`) instead of `getSplatBudget()`. `computeResidentCeiling`
itself is unchanged, so its existing unit tests stand.

This reproduces today's values exactly (6M mobile, 48M desktop floor), so no current portal
behaviour regresses. It only stops HD — and the capable-mobile 2M→4M bump — from inflating
residency. Device class is deliberately *not* consulted here: keeping the reference purely
platform-based means the ceiling is bit-for-bit what it is today.

### Known limitation: large mobile portal projects

The ceiling bounds what stays resident, and the fork enforces "never render finer than
resident" — `assignPinDepths` degrades pin depth to fit the ceiling, then
`startSceneLodFloor` (`portal-preload.ts:531`) clamps `lodRangeMin` to that depth.

Degradation order matters and works in the user's favour: neighbours are squeezed to their
coarsest **first**, and only then does the active scene degrade
(`portal-preload.ts:299-324`) — so ceiling pressure falls on preloading before it falls on
what you are looking at.

Nonetheless, in a **large** mobile portal project the ceiling binds and every mode converges
on the same clamped detail. Worked example using the project the budget-residency work
measured (pyramid `[5.82M, 2.91M, 1.45M, 0.73M]`, 10.9M total), 6M ceiling, two neighbours:

```
neighbours degraded to coarsest : 2 x 0.73M = 1.46M
active at level 0 -> 10.9M      total 12.4M  > 6M
active at level 1 ->  5.09M     total  6.55M > 6M
active at level 2 ->  2.18M     total  3.64M <= 6M   accept
=> lodRangeMin floored at 2; ~2.18M renderable regardless of a 2M/4M/6M/14M budget
```

This is accepted, not fixed. It is pre-existing behaviour (Normal is clamped identically),
HD is not uniquely penalised, and the alternative — raising the mobile ceiling — reintroduces
the OOM risk the ceiling exists to prevent. Small mobile portal projects, where the ceiling
does not bind, get the full 4M→6M HD step.

### Known limitation: `deviceFinest` does not un-ratchet after a demotion

In portal exports `deviceFinest` (`viewer-companion/portals.ts`) is a **running minimum** —
the finest LOD level the engine has ever been observed to load — and neighbour pin depths are
derived from it. A period spent in HD therefore ratchets it finer for the rest of the
session, and after a manual or watchdog demotion the neighbour pin depths stay at that
degraded (finer, more expensive) setting until the page is reloaded.

This is accepted, not fixed: it is memory-safe (the resident ceiling is derived from the
fixed `CEILING_REFERENCE_BUDGET`, not from the live budget, so residency cannot inflate) and
it self-heals on reload, where `ssQualityAutoFloor` also starts the visitor at the corrected
tier.

Where HD is fully effective:

| Export | Resident ceiling | HD effective? |
|---|---|---|
| Desktop, single-scene | none | ✅ 14M |
| Desktop, portal | ≥48M floor, RAM-capped | ✅ 14M |
| Mobile, single-scene | none | ✅ 6M |
| Mobile, portal, small project | 6M, does not bind | ✅ up to 6M |
| Mobile, portal, large project | 6M, binds | ⚠️ converges with Normal |

## Files touched

| File | Change |
|---|---|
| `src/quality-tier.ts` | **new** — pure, unit-tested: `pickQualityClass`, `pickQualityMode`, `resolveStoredMode`, `classifyFpsWindow` |
| `src/viewer-companion/quality-mode.ts` | **new** — companion runtime + segmented control + watchdog |
| `test/quality-tier.test.ts` | **new** — table-driven over the classing ladder, precedence, and demotion |
| `src/viewer-engine-patch.ts` | +1 patch; `VIEWER_ENGINE_PATCH_COUNT` 7 → 8 |
| `src/splat-export-core.ts` | inject always, alongside `injectDeviceFallback` |
| `src/viewer-companion/portals.ts` | ceiling reference becomes a constant instead of `getSplatBudget()` |

No editor changes. No `settings.json` field. No `.ssproj` state.

## Authoring constraints (companion runtime)

The companion body is authored inside a template literal and baked verbatim, so the
established fork rules apply:

- **No backslash escapes of any kind** — they are cooked away at build time. String
  operations only, never regex character classes like `\d`. (The `residentBudget` override
  once shipped as a permanently-dead regex this way.) All GPU-string matching therefore uses
  `indexOf` on a lowercased renderer string, and the Adreno model test parses digits with
  `parseInt` on the substring after `'adreno '`.
- **ES5 only.**
- Pure decision functions live in `src/quality-tier.ts` and are stringified in via
  `Function.toString()`, matching `portal-preload.ts`.

## Testing

**Unit (`test/quality-tier.test.ts`, Vitest):**

- classing ladder: each `weak` rule fires in isolation; unknown/iOS-shaped signals class
  `standard`; software-renderer strings class `weak` on desktop
- auto-HD: fires only for desktop + standard + cores/memory/GPU all satisfied; never on
  mobile
- precedence: `?budget=` / manual pin / legacy migration / `'auto'`, including the
  first-run `'auto'` write that prevents the seeded `performanceMode` being misread as a
  legacy pick
- `ssQualityAutoFloor` caps the heuristic on a later visit
- `classifyFpsWindow`: the four verdicts (`wait`/`reset`/`ok`/`demote`), both window
  boundaries, the fps floor, one-step demotion, the three-demotion bound (including the
  class-demoting third step), and that promotion never
  occurs

**Existing tests that must stay green:** `test/portal-preload.test.ts` — `computeResidentCeiling`
is unchanged, and the constant reference reproduces today's ceilings.

**Build gate:** `npm run build` exits 0 even with type errors; gate on
`grep -c "plugin typescript"` == 0, never the exit code.

**E2E (RELEASE build — stringified helpers are minified in debug-only builds):**

1. Desktop single-scene export: control shows three segments; HD reaches 14M; switching
   modes re-runs `applyPerfSettings` without reload.
2. Desktop portal export: HD effective; `[portals] ceiling/costs/resident/depths` shows the
   ceiling unchanged from today (48M floor) across all three modes.
3. Mobile portal export on a real phone — use a **mid-range or older** handset, not only a
   recent flagship, because the standard-class default now means 1.0 resolution scale as well
   as 4M: heuristic picks Perf or Normal, never HD; manual HD reaches 6M in a small project;
   ceiling stays 6M in all modes; and the WebGPU **device-fallback overlay must not appear**
   (if it does, the new mobile default is pushing that device past its memory ceiling).
4. Watchdog: force a demotion (heavy scene or `?budget=` raised) and confirm exactly one
   step down, no oscillation, and `ssQualityAutoFloor` honoured on reload.
5. Legacy migration: with only `performanceMode` in `localStorage` set to the value that
   DIFFERS from the platform default (`'true'` on desktop, `'false'` on mobile), confirm it
   migrates once and pins; with it at the platform default, confirm it does NOT pin and the
   heuristic runs; confirm a fresh origin writes `'auto'` and re-runs the heuristic on reload.
6. Engine patch: confirm the patched bundle contains the replacement exactly once and that
   `VIEWER_ENGINE_PATCH_COUNT` matches the applied count.
