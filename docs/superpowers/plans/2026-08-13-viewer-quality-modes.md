# Exported-Viewer Quality Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the exported viewer three quality modes (Performance / Normal / HD) chosen from a device capability class rather than the mobile/desktop user-agent split, auto-selected at startup and corrected downward by a passive frame-time watchdog.

**Architecture:** All decision logic lives in one new pure TypeScript module (`src/quality-tier.ts`) that is unit-tested and then stringified verbatim into a new always-injected viewer companion via `Function.toString()` — the same pattern `src/portal-preload.ts` already uses. The companion runs as a classic `<script>` (executing before the deferred module bootstrap calls `main()`), publishes three globals, builds the settings-panel control and arms the watchdog. A single two-line engine patch teaches the stock viewer's `applyPerfSettings` to read those globals. `state.performanceMode` keeps its exact current meaning ("is Performance mode"), so resolution scale, `colorUpdateAngle`, stock persistence, and the fork's existing `performanceMode:changed` listener all need no changes.

**Tech Stack:** TypeScript (bundler resolution, `strictNullChecks: false`), Vitest (Node environment), Rollup, `@playcanvas/splat-transform` 3.1.7 (supplies the baked viewer bundle that gets patched).

**Spec:** `docs/superpowers/specs/2026-08-13-viewer-quality-modes-design.md`

## Global Constraints

- **Budget table** (millions of splats), keyed on quality class and mobile-ness:
  ```
                         perf   normal    hd
  weak                    1M      2M      6M
  standard, mobile        2M      4M      6M
  standard, desktop       2M      4M     14M
  ```
  The `perf`/`normal` columns are the stock viewer's own `budgets.mobile` (`{low:1, high:2}`) and `budgets.desktop` (`{low:2, high:4}`) objects reused verbatim — `weak` maps to the former, `standard` to the latter. Never patch the table literal.
- **HD budget rule:** `(qualityClass === 'standard' && !isMobile) ? 14 : 6`.
- **HD changes the splat budget and nothing else.** Canvas resolution scale, `colorUpdateAngle`, and `maxPixelDim` are untouched.
- **The heuristic never auto-selects HD on mobile.** HD remains available there as a manual pick.
- **Companion authoring rules** (the runtime body is a template literal baked verbatim):
  - **No backslash escapes of any kind, anywhere in the template literal** — including inside comments. They are cooked away at build time. Use `indexOf` string tests, never regex character classes.
  - **Hand-written runtime code is ES5** (`var`, `function`, no arrow functions, no `const`/`let`, no nested template literals), matching `device-fallback.ts`.
  - **Stringified helpers are exempt from the ES5 rule.** `Function.toString()` returns whatever TypeScript emitted (ES2022: `const`, arrow functions), and `portals.ts` already injects exactly that from `portal-preload.ts`. Do not write a test asserting the emitted script is free of `const`/`=>` — it would fail on the helpers.
  - Stringified helpers must be **self-contained**: no imports, no calls to sibling stringified functions.
- **localStorage keys:** `ssQualityMode` (`'auto' | 'perf' | 'normal' | 'hd'`), `ssQualityAutoFloor` (`'perf' | 'normal' | 'hd'`), and the stock viewer's pre-existing `performanceMode`.
- **Published globals:** `window.__ssQualityMode`, `window.__ssQualityClass`, `window.__ssHdBudget`.
- **Build gate:** `npm run build` exits 0 even with TypeScript errors. Gate on `npm run build 2>&1 | grep -c "plugin typescript"` being `0`, never on the exit code.
- **Test runs must be foreground and redirected to a file** — never backgrounded, never piped to `grep` (Vitest hangs).
- **Do not touch upstream-owned files** (`rollup.config.mjs`, `src/render.ts`). Every file in this plan is fork-authored.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/quality-tier.ts` | **new** — pure decision functions. Device classing, auto-mode pick, HD budget, stored-preference precedence, demotion. No DOM, no imports. Every function self-contained for stringification. |
| `test/quality-tier.test.ts` | **new** — unit tests for the above. |
| `src/viewer-companion/quality-mode.ts` | **new** — the companion: ES5 runtime template literal + `buildQualityModeInjection()`. Owns mode resolution, globals, the segmented control, and the watchdog. |
| `test/quality-mode-injection.test.ts` | **new** — asserts the emitted injection contains the runtime's load-bearing markers. |
| `src/viewer-engine-patch.ts` | **modify** — one new `PATCHES` entry (count 7 → 8). |
| `test/viewer-engine-patch.test.ts` | **modify** — new anchor snippet, count assertion 7 → 8. |
| `src/splat-export-core.ts` | **modify** — call `injectQualityMode` on all three export paths. |
| `src/viewer-companion/portals.ts` | **modify** — pass a constant reference budget to `computeResidentCeiling` instead of the live `getSplatBudget()`. |

`src/portal-preload.ts` is **not** modified — `computeResidentCeiling` keeps its signature and its existing tests stand.

---

### Task 1: Pure quality-tier decision module

**Files:**
- Create: `src/quality-tier.ts`
- Test: `test/quality-tier.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  type QualityMode = 'perf' | 'normal' | 'hd';
  type QualityClass = 'weak' | 'standard';
  type DeviceSignals = { isMobile: boolean; cores: number; memGb: number; gpu: string };
  type ResolvedQuality = { mode: QualityMode; pinned: boolean; write: string | null };

  pickQualityClass(s: DeviceSignals): QualityClass
  pickAutoMode(s: DeviceSignals, cls: QualityClass): QualityMode
  hdBudgetFor(cls: QualityClass, isMobile: boolean): number      // 6 | 14
  demoteMode(mode: QualityMode): QualityMode
  resolveQualityMode(stored: string, legacy: string, autoFloor: string, auto: QualityMode): ResolvedQuality
  shouldDemote(samples: number[], minSamples: number, thresholdMs: number): boolean
  ```

Note on `cores`/`memGb`: **0 means "unknown"**. `navigator.hardwareConcurrency` and `navigator.deviceMemory` are both absent on some platforms (`deviceMemory` on all of iOS), so every rule that reads them must guard on `> 0` first. This is what lets unknown devices class as `standard`.

- [ ] **Step 1: Write the failing tests**

Create `test/quality-tier.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import { pickQualityClass, pickAutoMode, hdBudgetFor, demoteMode, resolveQualityMode, shouldDemote } from '../src/quality-tier';

// A capable desktop: every "weak" rule misses, every auto-HD rule hits.
const DESKTOP = { isMobile: false, cores: 16, memGb: 8, gpu: 'angle (nvidia, nvidia geforce rtx 4070, d3d11)' };
// A recent phone with no usable capability signal (the iOS shape: deviceMemory
// absent, renderer a generic "apple gpu"). Must class standard.
const IOS = { isMobile: true, cores: 0, memGb: 0, gpu: 'apple gpu' };

describe('pickQualityClass', () => {
    it('classes a capable desktop and an unknown-signal phone as standard', () => {
        expect(pickQualityClass(DESKTOP)).toBe('standard');
        expect(pickQualityClass(IOS)).toBe('standard');
    });

    it('classes software renderers weak on any platform', () => {
        expect(pickQualityClass({ ...DESKTOP, gpu: 'google swiftshader' })).toBe('weak');
        expect(pickQualityClass({ ...DESKTOP, gpu: 'mesa llvmpipe (llvm 15)' })).toBe('weak');
        expect(pickQualityClass({ ...DESKTOP, gpu: 'microsoft basic render driver' })).toBe('weak');
    });

    it('classes <=2 cores or <=2GB weak on any platform', () => {
        expect(pickQualityClass({ ...DESKTOP, cores: 2 })).toBe('weak');
        expect(pickQualityClass({ ...DESKTOP, memGb: 2 })).toBe('weak');
        expect(pickQualityClass({ ...DESKTOP, cores: 4 })).toBe('standard');
    });

    it('treats 0 cores / 0 memGb as unknown, not as low', () => {
        expect(pickQualityClass({ ...DESKTOP, cores: 0, memGb: 0 })).toBe('standard');
    });

    it('classes <=3GB mobile weak, but leaves the same value standard on desktop', () => {
        expect(pickQualityClass({ ...IOS, memGb: 3 })).toBe('weak');
        expect(pickQualityClass({ ...DESKTOP, memGb: 3 })).toBe('standard');
    });

    it('classes old mobile GPU families weak', () => {
        expect(pickQualityClass({ ...IOS, gpu: 'mali-450 mp4' })).toBe('weak');
        expect(pickQualityClass({ ...IOS, gpu: 'mali-t880' })).toBe('weak');
        expect(pickQualityClass({ ...IOS, gpu: 'powervr sgx 544' })).toBe('weak');
    });

    it('classes adreno below 500 weak and 500+ standard', () => {
        expect(pickQualityClass({ ...IOS, gpu: 'adreno 430' })).toBe('weak');
        expect(pickQualityClass({ ...IOS, gpu: 'adreno 618' })).toBe('standard');
        expect(pickQualityClass({ ...IOS, gpu: 'adreno 750' })).toBe('standard');
    });

    it('reads the adreno model through the real "(TM)" renderer format', () => {
        // Android reports e.g. "Adreno (TM) 430" -- the model digits do not
        // immediately follow "adreno ", so the scan must skip the vendor mark.
        expect(pickQualityClass({ ...IOS, gpu: 'adreno (tm) 430' })).toBe('weak');
        expect(pickQualityClass({ ...IOS, gpu: 'adreno (tm) 618' })).toBe('standard');
    });

    it('does not read digits from elsewhere in the string when adreno has no model', () => {
        expect(pickQualityClass({ ...IOS, gpu: 'adreno, opengl es 3.2 build 400' })).toBe('standard');
    });

    it('does not apply the mobile-only GPU rules on desktop', () => {
        expect(pickQualityClass({ ...DESKTOP, gpu: 'mali-t880' })).toBe('standard');
    });
});

describe('pickAutoMode', () => {
    it('picks perf for any weak device', () => {
        expect(pickAutoMode(DESKTOP, 'weak')).toBe('perf');
        expect(pickAutoMode(IOS, 'weak')).toBe('perf');
    });

    it('picks hd for a standard desktop with cores, memory and a strong GPU', () => {
        expect(pickAutoMode(DESKTOP, 'standard')).toBe('hd');
        expect(pickAutoMode({ ...DESKTOP, memGb: 0 }, 'standard')).toBe('hd'); // unknown memory does not block
        expect(pickAutoMode({ ...DESKTOP, gpu: 'apple m3 max' }, 'standard')).toBe('hd');
        expect(pickAutoMode({ ...DESKTOP, gpu: 'amd radeon rx 7900' }, 'standard')).toBe('hd');
        expect(pickAutoMode({ ...DESKTOP, gpu: 'intel arc a770' }, 'standard')).toBe('hd');
    });

    it('withholds hd when any desktop signal falls short', () => {
        expect(pickAutoMode({ ...DESKTOP, cores: 6 }, 'standard')).toBe('normal');
        expect(pickAutoMode({ ...DESKTOP, memGb: 4 }, 'standard')).toBe('normal');
        expect(pickAutoMode({ ...DESKTOP, gpu: 'intel uhd graphics 620' }, 'standard')).toBe('normal');
    });

    it('never picks hd on mobile, however capable the device looks', () => {
        expect(pickAutoMode({ isMobile: true, cores: 16, memGb: 12, gpu: 'apple m2' }, 'standard')).toBe('normal');
        expect(pickAutoMode(IOS, 'standard')).toBe('normal');
    });

    it('does not mistake a generic "apple gpu" for an apple m-series', () => {
        expect(pickAutoMode({ ...DESKTOP, gpu: 'apple gpu' }, 'standard')).toBe('normal');
    });
});

describe('hdBudgetFor', () => {
    it('gives 14 only to a standard desktop', () => {
        expect(hdBudgetFor('standard', false)).toBe(14);
        expect(hdBudgetFor('standard', true)).toBe(6);
        expect(hdBudgetFor('weak', false)).toBe(6);
        expect(hdBudgetFor('weak', true)).toBe(6);
    });
});

describe('demoteMode', () => {
    it('steps down one level and bottoms out at perf', () => {
        expect(demoteMode('hd')).toBe('normal');
        expect(demoteMode('normal')).toBe('perf');
        expect(demoteMode('perf')).toBe('perf');
    });
});

describe('resolveQualityMode', () => {
    it('honours an explicit stored pick and pins it', () => {
        expect(resolveQualityMode('hd', null, null, 'normal')).toEqual({ mode: 'hd', pinned: true, write: null });
        expect(resolveQualityMode('perf', 'false', 'normal', 'hd')).toEqual({ mode: 'perf', pinned: true, write: null });
    });

    it('migrates a legacy performanceMode once, pins it, and persists the migration', () => {
        expect(resolveQualityMode(null, 'true', null, 'hd')).toEqual({ mode: 'perf', pinned: true, write: 'perf' });
        expect(resolveQualityMode(null, 'false', null, 'hd')).toEqual({ mode: 'normal', pinned: true, write: 'normal' });
    });

    it('writes auto on a fresh origin so the seeded performanceMode is not misread as legacy next visit', () => {
        expect(resolveQualityMode(null, null, null, 'hd')).toEqual({ mode: 'hd', pinned: false, write: 'auto' });
    });

    it('uses the heuristic unpinned when auto is stored', () => {
        expect(resolveQualityMode('auto', 'true', null, 'hd')).toEqual({ mode: 'hd', pinned: false, write: null });
    });

    it('caps the heuristic at a stored auto floor but never raises it', () => {
        expect(resolveQualityMode('auto', null, 'normal', 'hd').mode).toBe('normal');
        expect(resolveQualityMode('auto', null, 'perf', 'hd').mode).toBe('perf');
        expect(resolveQualityMode('auto', null, 'hd', 'normal').mode).toBe('normal');
    });

    it('ignores an unrecognised stored value and falls through to the heuristic', () => {
        expect(resolveQualityMode('ultra', null, null, 'normal')).toEqual({ mode: 'normal', pinned: false, write: 'auto' });
    });
});

describe('shouldDemote', () => {
    const fill = (n: number, ms: number) => new Array(n).fill(ms);

    it('waits for the minimum sample count', () => {
        expect(shouldDemote(fill(119, 50), 120, 33)).toBe(false);
        expect(shouldDemote(fill(120, 50), 120, 33)).toBe(true);
    });

    it('stays quiet on a comfortably fast device', () => {
        expect(shouldDemote(fill(120, 16), 120, 33)).toBe(false);
    });

    it('uses p90, so a minority of slow frames does not trigger it', () => {
        // 100 samples: 85 fast + 15 slow -> p90 lands in the slow tail
        expect(shouldDemote(fill(85, 10).concat(fill(15, 200)), 100, 33)).toBe(true);
        // 95 fast + 5 slow -> p90 lands in the fast body
        expect(shouldDemote(fill(95, 10).concat(fill(5, 200)), 100, 33)).toBe(false);
    });

    it('is exclusive at the threshold', () => {
        expect(shouldDemote(fill(120, 33), 120, 33)).toBe(false);
        expect(shouldDemote(fill(120, 34), 120, 33)).toBe(true);
    });

    it('handles an empty sample set', () => {
        expect(shouldDemote([], 120, 33)).toBe(false);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- quality-tier > /tmp/qt.txt 2>&1; tail -30 /tmp/qt.txt`
Expected: FAIL — `Failed to resolve import "../src/quality-tier"`.

- [ ] **Step 3: Write the implementation**

Create `src/quality-tier.ts`:

```ts
// Device-capability quality tiering for the exported viewer.
//
// The exported viewer ships three quality modes (Performance / Normal / HD)
// whose splat budgets are chosen from a device CLASS rather than from the
// stock viewer's mobile/desktop user-agent split -- a recent phone renders 4M
// comfortably while a software-rendering desktop should not be handed the full
// desktop table.
//
//                        perf   normal    hd
//   weak                  1M      2M      6M
//   standard, mobile      2M      4M      6M
//   standard, desktop     2M      4M     14M
//
// The perf/normal columns are the stock viewer's own `budgets.mobile` and
// `budgets.desktop` objects reused verbatim (weak -> mobile, standard ->
// desktop), so the engine patch never touches the table literal. HD is the
// only column that does not follow the class split alone, because HD is the
// only mode bounded by MEMORY rather than by GPU throughput: 6M is exactly the
// resident ceiling this fork already treats as mobile-safe (3 x 2M, ~120-150MB
// at ~20-25 bytes/splat), while 14M would be ~280-350MB -- above the range
// where a field Adreno 618 dropped its WebGPU device (see
// viewer-companion/device-fallback.ts).
//
// `cores` and `memGb` use 0 for UNKNOWN. navigator.hardwareConcurrency and
// navigator.deviceMemory are both absent on some platforms (deviceMemory on all
// of iOS), so every rule reading them guards on > 0 first. That is what makes
// unknown devices class `standard`: with the resident ceiling decoupled from
// the render budget, misclassing a phone is only a FRAME-RATE error, never a
// MEMORY one, and frame-rate errors are exactly what the demote watchdog
// recovers from.
//
// Every function here is pure and self-contained (no imports, no
// sibling-function calls) so it can be stringified verbatim into the exported
// viewer runtime via Function.toString(), the same way portal-preload.ts is.

type QualityMode = 'perf' | 'normal' | 'hd';
type QualityClass = 'weak' | 'standard';

type DeviceSignals = {
    isMobile: boolean;
    cores: number;      // navigator.hardwareConcurrency; 0 = unknown
    memGb: number;      // navigator.deviceMemory; 0 = unknown
    gpu: string;        // lowercased UNMASKED_RENDERER_WEBGL; '' = unknown
};

type ResolvedQuality = {
    mode: QualityMode;
    pinned: boolean;        // true = an explicit user choice; the watchdog stays off
    write: string | null;   // value to persist to ssQualityMode, or null for nothing
};

// Classify the device as `weak` (old phones, 2-core / 2GB machines, software
// renderers) or `standard` (everything else, including every device whose
// signals are unavailable). Pure and self-contained for stringification.
const pickQualityClass = (s: DeviceSignals): QualityClass => {
    const gpu = (s && s.gpu ? s.gpu : '').toLowerCase();
    const has = (needle: string): boolean => gpu.indexOf(needle) !== -1;
    // software rendering, any platform
    if (has('swiftshader') || has('llvmpipe') || has('basic render')) {
        return 'weak';
    }
    if (s.cores > 0 && s.cores <= 2) {
        return 'weak';
    }
    if (s.memGb > 0 && s.memGb <= 2) {
        return 'weak';
    }
    if (s.isMobile) {
        if (s.memGb > 0 && s.memGb <= 3) {
            return 'weak';
        }
        if (has('mali-4') || has('mali-t') || has('powervr sgx')) {
            return 'weak';
        }
        // Adreno below 500. Parsed numerically rather than pattern-matched: the
        // companion runtime forbids backslash escapes, so a digit-class regex
        // would silently lose its backslash at build time and never match.
        // Android reports the vendor mark ("Adreno (TM) 430"), so scan forward
        // to the first digit rather than assuming it follows "adreno " -- but
        // bound the scan so a model-less string cannot pick up unrelated digits
        // further along (e.g. an "OpenGL ES 3.2 build 400" suffix).
        const a = gpu.indexOf('adreno');
        if (a !== -1) {
            let i = a + 6;
            const limit = Math.min(gpu.length, a + 16);
            while (i < limit && (gpu.charAt(i) < '0' || gpu.charAt(i) > '9')) {
                i++;
            }
            if (i < limit) {
                const model = parseInt(gpu.substring(i), 10);
                if (model > 0 && model < 500) {
                    return 'weak';
                }
            }
        }
    }
    return 'standard';
};

// The mode the heuristic starts the viewer in. HD is desktop-only: iOS reports
// no deviceMemory and a generic "apple gpu" renderer string for every model, so
// there is no signal separating a recent iPhone from an old one, and the mobile
// HD gain is a modest 4M -> 6M. Pure and self-contained for stringification.
const pickAutoMode = (s: DeviceSignals, cls: QualityClass): QualityMode => {
    if (cls === 'weak') {
        return 'perf';
    }
    if (s.isMobile) {
        return 'normal';
    }
    const gpu = (s && s.gpu ? s.gpu : '').toLowerCase();
    const has = (needle: string): boolean => gpu.indexOf(needle) !== -1;
    // 'apple m' deliberately excludes the generic 'apple gpu' Safari reports
    const strong = has('nvidia') || has('geforce') || has('rtx') || has('gtx') ||
        has('radeon rx') || has('apple m') || has('arc a');
    if (s.cores >= 8 && (s.memGb === 0 || s.memGb >= 8) && strong) {
        return 'hd';
    }
    return 'normal';
};

// HD's budget in millions of splats. 14 requires BOTH a standard class and a
// desktop; weak desktops and every phone get 6. Pure and self-contained.
const hdBudgetFor = (cls: QualityClass, isMobile: boolean): number => {
    return (cls === 'standard' && !isMobile) ? 14 : 6;
};

// One step down the quality ladder; bottoms out at perf. The watchdog is
// demote-only, so there is deliberately no inverse. Pure and self-contained.
const demoteMode = (mode: QualityMode): QualityMode => {
    if (mode === 'hd') {
        return 'normal';
    }
    if (mode === 'normal') {
        return 'perf';
    }
    return 'perf';
};

// Resolve the startup mode from stored preferences and the heuristic's pick.
//
//   ssQualityMode = perf|normal|hd  -> an explicit user choice: pinned, watchdog off
//   ssQualityMode absent + legacy performanceMode present
//                                   -> migrate once, pin (mirrors the stock
//                                      viewer's own retinaDisplay migration)
//   ssQualityMode absent, no legacy -> heuristic, and WRITE 'auto'
//   ssQualityMode = auto            -> heuristic, capped by ssQualityAutoFloor
//
// Writing 'auto' on a fresh origin is required for correctness: the companion
// seeds localStorage.performanceMode so the stock viewer's own state default
// lands on the right boolean, and without the 'auto' marker that seeded value
// would be misread as a legacy manual pick on the next visit.
//
// The auto floor is a tier the watchdog previously demoted to; it caps the
// heuristic (never raises it) so a returning visitor does not re-earn a slow
// first minute. Pure and self-contained for stringification.
const resolveQualityMode = (
    stored: string,
    legacy: string,
    autoFloor: string,
    auto: QualityMode
): ResolvedQuality => {
    const rank = (m: string): number => {
        if (m === 'hd') {
            return 2;
        }
        if (m === 'normal') {
            return 1;
        }
        return 0;
    };
    if (stored === 'perf' || stored === 'normal' || stored === 'hd') {
        return { mode: stored, pinned: true, write: null };
    }
    if (stored !== 'auto' && (legacy === 'true' || legacy === 'false')) {
        const migrated: QualityMode = (legacy === 'true') ? 'perf' : 'normal';
        return { mode: migrated, pinned: true, write: migrated };
    }
    let mode = auto;
    if (autoFloor === 'perf' || autoFloor === 'normal' || autoFloor === 'hd') {
        if (rank(autoFloor) < rank(auto)) {
            mode = autoFloor as QualityMode;
        }
    }
    return { mode, pinned: false, write: (stored === 'auto') ? null : 'auto' };
};

// True when the sampled frame times justify stepping the mode down one level.
// Uses the 90th percentile so a handful of slow frames (a GC pause, a streaming
// batch) cannot trigger a demotion on an otherwise smooth device. The
// percentile is computed inline rather than via a helper because this function
// is stringified into the viewer runtime, where sibling-function calls are not
// available. Pure and self-contained.
const shouldDemote = (samples: number[], minSamples: number, thresholdMs: number): boolean => {
    if (!samples || samples.length < minSamples || samples.length === 0) {
        return false;
    }
    const sorted = samples.slice().sort((a, b) => a - b);
    let idx = Math.ceil(sorted.length * 0.9) - 1;
    if (idx < 0) {
        idx = 0;
    }
    if (idx > sorted.length - 1) {
        idx = sorted.length - 1;
    }
    return sorted[idx] > thresholdMs;
};

export { pickQualityClass, pickAutoMode, hdBudgetFor, demoteMode, resolveQualityMode, shouldDemote, QualityMode, QualityClass, DeviceSignals, ResolvedQuality };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- quality-tier > /tmp/qt.txt 2>&1; tail -30 /tmp/qt.txt`
Expected: PASS, all describes green.

- [ ] **Step 5: Lint**

Run: `npm run lint > /tmp/lint.txt 2>&1; tail -20 /tmp/lint.txt; echo "exit=$?"`
Expected: exit 0, no errors in `src/quality-tier.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/quality-tier.ts test/quality-tier.test.ts
git commit -m "feat(viewer): pure device-capability quality tiering"
```

---

### Task 2: Engine patch for the HD budget

**Files:**
- Modify: `src/viewer-engine-patch.ts` (append to the `PATCHES` array, after the `updateCursor` entry ending at line 258)
- Test: `test/viewer-engine-patch.test.ts` (add a snippet const, extend `BUNDLE`, bump the count assertion at line 75)

**Interfaces:**
- Consumes: the globals Task 3 publishes — `window.__ssQualityClass`, `window.__ssQualityMode`, `window.__ssHdBudget`. This task only emits the *reader*; the writer arrives in Task 3. The patch is written so a missing global degrades to today's exact behaviour.
- Produces: nothing importable. `VIEWER_ENGINE_PATCH_COUNT` becomes 8.

- [ ] **Step 1: Write the failing test**

In `test/viewer-engine-patch.test.ts`, add this snippet const alongside the existing ones (place it after `MOBILE_TAP_SNIPPET`):

```ts
// applyPerfSettings' budget() (fork patch: pick the budget table from the
// device capability class instead of the mobile/desktop UA split, and add the
// HD tier). 20-space indented (viewer app code, inside a nested arrow).
const BUDGET_SNIPPET =
    '                    const quality = platform.mobile ? budgets.mobile : budgets.desktop;\n' +
    '                    return state.performanceMode ? quality.low : quality.high;\n';
```

Add `BUDGET_SNIPPET` to the composite `BUNDLE` const, then add these two tests inside the existing `describe('patchViewerEngine', ...)` block (line 71):

```ts
it('routes the budget table through the quality class and adds the HD tier', () => {
    const { source } = patchViewerEngine(BUNDLE);
    expect(source).toContain(
        "                    const quality = (window.__ssQualityClass === 'weak') ? budgets.mobile : budgets.desktop;\n" +
        "                    return (window.__ssQualityMode === 'hd') ? (window.__ssHdBudget || 14) : (state.performanceMode ? quality.low : quality.high);\n"
    );
    // the stock table literal is never touched
    expect(source).not.toContain('budgets.hd');
});

it('leaves budget selection at today behaviour when the globals are absent', () => {
    // The patch must degrade safely: with no companion, __ssQualityClass is
    // undefined -> budgets.desktop, and __ssQualityMode is undefined -> the
    // stock performanceMode branch. Asserted structurally on the emitted text.
    const { source } = patchViewerEngine(BUDGET_SNIPPET);
    expect(source).toContain("(window.__ssQualityClass === 'weak') ? budgets.mobile : budgets.desktop");
    expect(source).toContain('(state.performanceMode ? quality.low : quality.high)');
});
```

Update the count assertion at line 75 from `expect(VIEWER_ENGINE_PATCH_COUNT).toBe(7);` to `expect(VIEWER_ENGINE_PATCH_COUNT).toBe(8);`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- viewer-engine-patch > /tmp/vep.txt 2>&1; tail -30 /tmp/vep.txt`
Expected: FAIL — the count is 7, not 8, and the replacement text is absent.

- [ ] **Step 3: Add the patch**

In `src/viewer-engine-patch.ts`, append this entry to `PATCHES` (after the `updateCursor` entry, before the closing `];`):

```ts
    // --- fork: budget table by device capability class, plus the HD tier ---
    // applyPerfSettings' budget(). Two changes on two adjacent lines:
    //
    //   1. The table is chosen by the companion's device CLASS instead of the
    //      mobile/desktop user-agent split. The stock objects are reused
    //      verbatim -- budgets.mobile {low:1,high:2} IS the weak table and
    //      budgets.desktop {low:2,high:4} IS the standard table -- so the table
    //      literal itself is never patched and a recent phone gets 2M/4M while
    //      a software-rendering desktop drops to 1M/2M.
    //   2. An HD tier reading window.__ssHdBudget (6 on mobile and weak
    //      desktops, 14 on standard desktops -- see src/quality-tier.ts).
    //
    // All policy lives in the companion's globals, so this patch carries no
    // logic of its own and the decision rules stay in unit-tested TypeScript.
    //
    // Degrades safely with no companion present: undefined __ssQualityClass
    // takes budgets.desktop and undefined __ssQualityMode takes the stock
    // performanceMode branch -- i.e. exactly today's desktop behaviour. (A
    // phone without the companion would get the desktop table, which cannot
    // happen in practice: the companion is injected into every export.)
    //
    // `?budget=` still wins -- config.budget returns earlier in the same
    // function and is untouched. Self-destructing (neither line survives the
    // replacement), so no `applied` marker is needed. Verified to occur
    // exactly once in the splat-transform 3.1.7 baked viewer.
    {
        search:
            '                    const quality = platform.mobile ? budgets.mobile : budgets.desktop;\n' +
            '                    return state.performanceMode ? quality.low : quality.high;\n',
        replace:
            '                    const quality = (window.__ssQualityClass === \'weak\') ? budgets.mobile : budgets.desktop;\n' +
            '                    return (window.__ssQualityMode === \'hd\') ? (window.__ssHdBudget || 14) : (state.performanceMode ? quality.low : quality.high);\n'
    }
```

Also update the file's header comment: change "seven fork-specific patches" to "eight fork-specific patches" and add an item `8.` to the numbered list describing the budget-table patch.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- viewer-engine-patch > /tmp/vep.txt 2>&1; tail -30 /tmp/vep.txt`
Expected: PASS. The pre-existing partial-bundle tests asserting `patched` of 2 and 5 must still pass — their snippets do not contain the new anchor.

- [ ] **Step 5: Verify the anchor against the real baked bundle**

The bundle lives escape-encoded inside a JS string literal, so it must be decoded before searching (searching `index.mjs` directly gives false negatives). Run:

```bash
node --input-type=module -e "
import fs from 'fs';
const src = fs.readFileSync('node_modules/@playcanvas/splat-transform/dist/index.mjs','utf8');
const l = src.split('\n')[21312];
const s = l.indexOf('\"');
const bundle = JSON.parse(l.slice(s, l.lastIndexOf('\"')+1));
const anchor = '                    const quality = platform.mobile ? budgets.mobile : budgets.desktop;\n' +
               '                    return state.performanceMode ? quality.low : quality.high;\n';
console.log('anchor occurrences:', bundle.split(anchor).length - 1);
"
```

Expected: `anchor occurrences: 1`. If it prints 0, the bundled viewer changed shape — stop and re-derive the anchor before continuing.

- [ ] **Step 6: Commit**

```bash
git add src/viewer-engine-patch.ts test/viewer-engine-patch.test.ts
git commit -m "feat(viewer): engine patch for class-based budget table + HD tier"
```

---

### Task 3: Companion — mode resolution, globals, and export wiring

**Files:**
- Create: `src/viewer-companion/quality-mode.ts`
- Modify: `src/splat-export-core.ts` (add `injectQualityMode`; call it at lines 852, 956, 1002)
- Test: `test/quality-mode-injection.test.ts`

**Interfaces:**
- Consumes: `pickQualityClass`, `pickAutoMode`, `hdBudgetFor`, `resolveQualityMode`, `demoteMode`, `shouldDemote` from `../quality-tier` (Task 1). The engine patch from Task 2 reads the globals this task publishes.
- Produces: `buildQualityModeInjection(): string` — returns `'<style>…</style><script>…</script>'`, always non-empty (unlike the portals/zones injectors, this one never no-ops). Also establishes `window.__ssQualityApply(mode, pinned)`, which Tasks 4 and 5 call.

This task delivers phase 1 only: the runtime resolves the mode, publishes the globals, and exposes `__ssQualityApply`. The settings control (Task 4) and watchdog (Task 5) build on it. The `<style>` block is emitted empty here and filled in Task 4.

- [ ] **Step 1: Write the failing test**

Create `test/quality-mode-injection.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import { buildQualityModeInjection } from '../src/viewer-companion/quality-mode';

describe('buildQualityModeInjection', () => {
    it('emits a classic script so it runs before the deferred module bootstrap', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain('<script>');
        // NOT type="module" -- a module would be deferred past main()
        expect(out).not.toContain('<script type="module">');
    });

    it('publishes the three globals the engine patch reads', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain('__ssQualityMode');
        expect(out).toContain('__ssQualityClass');
        expect(out).toContain('__ssHdBudget');
    });

    it('inlines the pure tier helpers rather than importing them', () => {
        const out = buildQualityModeInjection();
        // stringified via Function.toString() -- the bodies must be present
        expect(out).toContain('swiftshader');
        expect(out).toContain('powervr sgx');
        expect(out).toContain('ssQualityAutoFloor');
    });

    it('uses the documented localStorage keys', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain("'ssQualityMode'");
        expect(out).toContain("'ssQualityAutoFloor'");
        // seeds the stock viewer's own key so its state default lands right
        expect(out).toContain("'performanceMode'");
    });

    it('exposes the apply entry point the UI and watchdog call', () => {
        expect(buildQualityModeInjection()).toContain('__ssQualityApply');
    });

    it('contains no backslash escapes (they are cooked away at build time)', () => {
        // The runtime is authored inside a template literal; any backslash that
        // survives into the emitted text means a regex or escape was used that
        // will silently lose it. See companion-template-no-backslash-escapes.
        expect(buildQualityModeInjection()).not.toContain('\\');
    });

    it('wraps the runtime in an IIFE so nothing leaks to global scope but the published names', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain('(function () {');
        expect(out).toContain('})();');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- quality-mode-injection > /tmp/qmi.txt 2>&1; tail -30 /tmp/qmi.txt`
Expected: FAIL — `Failed to resolve import "../src/viewer-companion/quality-mode"`.

- [ ] **Step 3: Write the companion**

Create `src/viewer-companion/quality-mode.ts`:

```ts
// Quality-mode companion for the exported viewer.
//
// Gives the viewer three modes (Performance / Normal / HD) chosen from a device
// capability class rather than the stock mobile/desktop user-agent split, and
// corrects a wrong guess downward with a passive frame-time watchdog.
//
// Injected into EVERY export as a classic <script>, so it executes at parse
// time -- BEFORE the deferred <script type="module"> bootstrap calls main().
// That ordering is load-bearing: the stock viewer reads
// localStorage.performanceMode synchronously while building its state, so the
// mode must be resolved before then. It is also why the heuristic is
// synchronous: WebGPU adapter.info would be a better mobile signal but needs an
// async requestAdapter().
//
// The engine patch in viewer-engine-patch.ts reads the three globals published
// here; all decision logic lives in ../quality-tier (unit-tested) and is
// stringified in verbatim via Function.toString().
//
// state.performanceMode keeps its exact stock meaning -- "is Performance mode",
// false for BOTH Normal and HD -- so the viewer's resolution scale (0.5),
// colorUpdateAngle (4/2), its own persistence, and the portals companion's
// existing performanceMode:changed listener all keep working untouched.
//
// Authoring constraints (the runtime body is a template literal baked
// verbatim): NO backslash escapes of any kind, including inside comments (they
// are cooked away at build time -- the residentBudget override once shipped as
// a permanently dead regex that way), and ES5 only.

import { pickQualityClass, pickAutoMode, hdBudgetFor, demoteMode, resolveQualityMode, shouldDemote } from '../quality-tier';

const companionStyle = '';

const companionRuntime = `
(function () {
  var pickQualityClass = ${pickQualityClass.toString()};
  var pickAutoMode = ${pickAutoMode.toString()};
  var hdBudgetFor = ${hdBudgetFor.toString()};
  var demoteMode = ${demoteMode.toString()};
  var resolveQualityMode = ${resolveQualityMode.toString()};
  var shouldDemote = ${shouldDemote.toString()};

  var KEY_MODE = 'ssQualityMode';
  var KEY_FLOOR = 'ssQualityAutoFloor';
  var KEY_LEGACY = 'performanceMode';

  function readStore(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function writeStore(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { }
  }

  // Mobile detection, mirroring the viewer's own platform split and the
  // portals companion's IS_MOBILE (iPadOS reports as Mac + multi-touch).
  var isMobile = (function () {
    try {
      var ua = navigator.userAgent || '';
      if (/android|iphone|ipad|ipod|windows phone|mobile/i.test(ua)) { return true; }
      return ((navigator.maxTouchPoints || 0) > 1 && /mac/i.test(navigator.platform || ''));
    } catch (e) { return false; }
  })();

  // Unmasked GPU renderer string from a throwaway context. Lowercased here so
  // every rule downstream is a plain indexOf.
  function readGpu() {
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) { return ''; }
      var ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (!ext) { return ''; }
      var r = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
      return (typeof r === 'string') ? r.toLowerCase() : '';
    } catch (e) { return ''; }
  }

  var signals = {
    isMobile: isMobile,
    cores: (function () { try { return navigator.hardwareConcurrency || 0; } catch (e) { return 0; } })(),
    memGb: (function () { try { return navigator.deviceMemory || 0; } catch (e) { return 0; } })(),
    gpu: readGpu()
  };

  var qualityClass = pickQualityClass(signals);
  var autoMode = pickAutoMode(signals, qualityClass);
  var resolved = resolveQualityMode(readStore(KEY_MODE), readStore(KEY_LEGACY), readStore(KEY_FLOOR), autoMode);

  if (resolved.write) { writeStore(KEY_MODE, resolved.write); }

  var pinned = resolved.pinned;

  // Publish the globals the engine patch reads, and seed the stock viewer's own
  // key so the state default it builds a moment from now lands on the right
  // boolean. performanceMode means "is Performance mode": false for BOTH
  // Normal and HD.
  function publish(mode) {
    window.__ssQualityMode = mode;
    window.__ssQualityClass = qualityClass;
    window.__ssHdBudget = hdBudgetFor(qualityClass, isMobile);
    writeStore(KEY_LEGACY, String(mode === 'perf'));
  }
  publish(resolved.mode);

  function getViewer() { return window.__supersplatViewer || null; }
  function getGlobal() { var v = getViewer(); return (v && v.global) || null; }

  // Apply a mode at runtime. Setting state.performanceMode fires
  // performanceMode:changed through the viewer's observe() proxy, which re-runs
  // applyPerfSettings; for Normal <-> HD the boolean does not move, so the event
  // is fired manually. Exactly one of the two paths fires, never both.
  window.__ssQualityApply = function (mode, isManual) {
    if (mode !== 'perf' && mode !== 'normal' && mode !== 'hd') { return; }
    var prev = window.__ssQualityMode;
    publish(mode);
    if (isManual) {
      pinned = true;
      writeStore(KEY_MODE, mode);
    }
    var g = getGlobal();
    if (!g || !g.state) { return; }
    var wantPerf = (mode === 'perf');
    if (g.state.performanceMode !== wantPerf) {
      g.state.performanceMode = wantPerf;         // observe() fires the event
    } else if (prev !== mode && g.events) {
      g.events.fire('performanceMode:changed');   // normal <-> hd
    }
    if (window.__ssQualityOnChange) { window.__ssQualityOnChange(mode, pinned); }
  };
  window.__ssQualityPinned = function () { return pinned; };

  console.info('[quality] class=' + qualityClass + ' mode=' + resolved.mode +
    ' hd=' + window.__ssHdBudget + 'M pinned=' + pinned +
    ' cores=' + signals.cores + ' memGb=' + signals.memGb + ' gpu=' + (signals.gpu || 'unknown'));
})();
`;

// Produce the HTML fragment to inject before </body>. Always injected: every
// export benefits, and unlike the portals/zones injectors this one never
// no-ops.
const buildQualityModeInjection = (): string => {
    return `<style>${companionStyle}</style><script>${companionRuntime}</script>`;
};

export { buildQualityModeInjection };
```

Note the `demoteMode` and `shouldDemote` helpers are stringified in now but not yet called — Task 5 wires them to the watchdog. This keeps the runtime's helper block in one place rather than editing it twice.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- quality-mode-injection > /tmp/qmi.txt 2>&1; tail -40 /tmp/qmi.txt`
Expected: PASS.

If the "no backslash escapes" test fails, the cause is the `isMobile` regex literals (`/android|iphone.../i`). Those contain no backslashes and are safe as written — but if the test still trips, find the offending escape and replace it with `indexOf` logic. Do not weaken the assertion.

- [ ] **Step 5: Wire the injection into all three export paths**

In `src/splat-export-core.ts`, add the import next to the other companion imports (they are alphabetical by module path; `quality-mode` sorts after `poster`):

```ts
import { buildQualityModeInjection } from './viewer-companion/quality-mode';
```

Add this function next to `injectDeviceFallback` (after it, around line 203):

```ts
// Inject the quality-mode companion into an HTML string before </body>.
// ALWAYS injected: every export gets the three modes and the device heuristic,
// and the engine patch's budget() reads globals this publishes. It needs no
// viewer handle at parse time (it resolves the mode from localStorage and
// device signals alone) but its UI and watchdog phase reaches for
// window.__supersplatViewer, which injectDeviceFallback already publishes
// unconditionally on every path.
const injectQualityMode = (html: string): string => {
    return insertBeforeBodyClose(html, buildQualityModeInjection());
};
```

Then wrap it around each of the three existing injection chains:

- Line 852: `const withApi = injectIframeApi(injectDeviceFallback(withPortals), settingsWithLods);`
  becomes
  `const withApi = injectIframeApi(injectQualityMode(injectDeviceFallback(withPortals)), settingsWithLods);`
- Line 956: wrap the `injectDeviceFallback(...)` call in `injectQualityMode(...)`, i.e.
  `injectIframeApi(injectQualityMode(injectDeviceFallback(injectPortals(...))), viewerSettingsJson)`
- Line 1002: the same wrap, i.e.
  `injectIframeApi(injectQualityMode(injectDeviceFallback(injectPortals(...))), sogSettings)`

- [ ] **Step 6: Verify the whole suite and the build**

Run: `npm run test > /tmp/all.txt 2>&1; tail -30 /tmp/all.txt`
Expected: PASS, no regressions.

Run: `npm run build > /tmp/build.txt 2>&1; grep -c "plugin typescript" /tmp/build.txt`
Expected: `0`. (Do not trust the exit code — Rollup reports TypeScript errors as warnings.)

- [ ] **Step 7: Commit**

```bash
git add src/viewer-companion/quality-mode.ts test/quality-mode-injection.test.ts src/splat-export-core.ts
git commit -m "feat(viewer): quality-mode companion with device heuristic"
```

---

### Task 4: Segmented quality control in the settings panel

**Files:**
- Modify: `src/viewer-companion/quality-mode.ts` (fill `companionStyle`; add a UI block to `companionRuntime`)
- Test: `test/quality-mode-injection.test.ts` (extend)

**Interfaces:**
- Consumes: `window.__ssQualityApply(mode, isManual)` and `window.__ssQualityPinned()` from Task 3.
- Produces: `window.__ssQualityOnChange` is assigned by this task so the control re-renders when the watchdog (Task 5) demotes.

The stock markup being replaced is:

```html
<div id="performanceModeRow" class="settingsRow">
    <div id="performanceModeOption" data-i18n="settings.performance-mode">Performance Mode</div>
    <div id="performanceModeCheck" class="toggleSwitch">…</div>
</div>
```

- [ ] **Step 1: Write the failing tests**

Add to `test/quality-mode-injection.test.ts`:

```ts
describe('buildQualityModeInjection settings control', () => {
    it('targets the stock performance-mode row', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain('performanceModeRow');
    });

    it('clone-replaces the row so the stock click listener is dropped', () => {
        // Rewriting innerHTML would leave the stock listener bound to the row
        // element itself, which keeps flipping performanceMode on every click.
        const out = buildQualityModeInjection();
        expect(out).toContain('cloneNode');
        expect(out).toContain('replaceChild');
    });

    it('emits three exclusive segments', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain('ssQualitySeg');
        expect(out).toContain("'perf'");
        expect(out).toContain("'normal'");
        expect(out).toContain("'hd'");
    });

    it('ships labels for the same nine languages as the portals companion', () => {
        const out = buildQualityModeInjection();
        // literal UTF-8, no unicode escapes
        expect(out).toContain('Qualité');
        expect(out).toContain('Qualität');
        expect(out).toContain('Calidad');
        expect(out).toContain('Qualidade');
        expect(out).toContain('Качество');
        expect(out).toContain('画質');
        expect(out).toContain('품질');
        expect(out).toContain('画质');
    });

    it('carries styles for the segmented control', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain('<style>');
        expect(out).toContain('.ssQualitySeg');
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- quality-mode-injection > /tmp/qmi.txt 2>&1; tail -40 /tmp/qmi.txt`
Expected: FAIL — `performanceModeRow`, `cloneNode`, `.ssQualitySeg` and the labels are all absent.

- [ ] **Step 3: Fill in the style block**

Replace `const companionStyle = '';` in `src/viewer-companion/quality-mode.ts` with:

```ts
// Segmented control styling. Deliberately minimal and inherited-colour based so
// it sits inside the viewer's own settings panel without restating its theme.
const companionStyle = `
.ssQualityRow { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ssQualitySeg { display: flex; border: 1px solid rgba(255,255,255,0.25); border-radius: 4px; overflow: hidden; }
.ssQualitySeg > div { padding: 3px 10px; cursor: pointer; user-select: none; white-space: nowrap; opacity: 0.65; }
.ssQualitySeg > div + div { border-left: 1px solid rgba(255,255,255,0.25); }
.ssQualitySeg > div.active { background: rgba(255,255,255,0.22); opacity: 1; }
`;
```

- [ ] **Step 4: Add the UI block to the runtime**

In `companionRuntime`, insert this before the closing `console.info(...)` line:

```js
  // --- settings panel: replace the stock Performance Mode toggle ----------
  var LABELS = {
    en: { q: 'Quality', perf: 'Performance', normal: 'Normal', hd: 'HD' },
    de: { q: 'Qualität', perf: 'Leistung', normal: 'Normal', hd: 'HD' },
    es: { q: 'Calidad', perf: 'Rendimiento', normal: 'Normal', hd: 'HD' },
    fr: { q: 'Qualité', perf: 'Performance', normal: 'Normal', hd: 'HD' },
    ja: { q: '画質', perf: 'パフォーマンス', normal: '標準', hd: 'HD' },
    ko: { q: '품질', perf: '성능', normal: '보통', hd: 'HD' },
    pt: { q: 'Qualidade', perf: 'Desempenho', normal: 'Normal', hd: 'HD' },
    ru: { q: 'Качество', perf: 'Производительность', normal: 'Обычное', hd: 'HD' },
    zh: { q: '画质', perf: '性能', normal: '标准', hd: 'HD' }
  };
  function labels() {
    var l = (navigator.language || 'en').toLowerCase();
    return LABELS[l] || LABELS[l.split('-')[0]] || LABELS.en;
  }

  var segEls = null;
  function paint(mode) {
    if (!segEls) { return; }
    for (var k in segEls) {
      if (segEls[k]) { segEls[k].className = (k === mode) ? 'active' : ''; }
    }
  }
  window.__ssQualityOnChange = function (mode) { paint(mode); };

  function buildControl() {
    var row = document.getElementById('performanceModeRow');
    if (!row || segEls) { return !!segEls; }
    var t = labels();
    // Clone-replace rather than rewrite innerHTML: the stock click listener is
    // bound to the ROW element, so keeping it would flip performanceMode on
    // every click inside the new control. Cloning drops all listeners. The
    // stock code retains a stale performanceModeCheck reference afterwards,
    // which then points at a detached node -- its classList.toggle is a
    // harmless no-op.
    var fresh = row.cloneNode(false);
    fresh.className = 'settingsRow ssQualityRow';
    fresh.removeAttribute('id');
    var label = document.createElement('div');
    label.textContent = t.q;
    fresh.appendChild(label);
    var seg = document.createElement('div');
    seg.className = 'ssQualitySeg';
    segEls = {};
    var order = ['perf', 'normal', 'hd'];
    for (var i = 0; i < order.length; i++) {
      (function (mode) {
        var el = document.createElement('div');
        el.textContent = t[mode];
        el.addEventListener('click', function (ev) {
          ev.stopPropagation();
          window.__ssQualityApply(mode, true);
          paint(mode);
        });
        seg.appendChild(el);
        segEls[mode] = el;
      })(order[i]);
    }
    fresh.appendChild(seg);
    row.parentNode.replaceChild(fresh, row);
    paint(window.__ssQualityMode);
    return true;
  }

  // The settings panel is built inside main() by initUI, so poll for it the way
  // device-fallback polls for the viewer handle. 240 tries x 500ms = 2 minutes,
  // then give up (the stock toggle simply stays).
  var uiTries = 0;
  var uiTimer = setInterval(function () {
    uiTries++;
    if (buildControl() || uiTries > 240) { clearInterval(uiTimer); }
  }, 500);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -- quality-mode-injection > /tmp/qmi.txt 2>&1; tail -40 /tmp/qmi.txt`
Expected: PASS, including the ES5-only and no-backslash assertions from Task 3.

- [ ] **Step 6: Commit**

```bash
git add src/viewer-companion/quality-mode.ts test/quality-mode-injection.test.ts
git commit -m "feat(viewer): segmented quality control in the settings panel"
```

---

### Task 5: Frame-time demote watchdog

**Files:**
- Modify: `src/viewer-companion/quality-mode.ts` (add a watchdog block to `companionRuntime`)
- Test: `test/quality-mode-injection.test.ts` (extend)

**Interfaces:**
- Consumes: `shouldDemote` and `demoteMode` (already stringified in by Task 3), `window.__ssQualityApply` (Task 3), `window.__ssQualityPinned` (Task 3), `window.__ssQualityOnChange` (Task 4).
- Produces: writes `ssQualityAutoFloor` on each demotion.

Constants: settle 3000 ms, 120 samples, 33 ms p90 threshold, 500 ms discard cap, at most 2 demotions.

- [ ] **Step 1: Write the failing tests**

Add to `test/quality-mode-injection.test.ts`:

```ts
describe('buildQualityModeInjection watchdog', () => {
    it('samples real frames rather than forcing renders', () => {
        const out = buildQualityModeInjection();
        // app.autoRender is false after the ready gate, so a still camera draws
        // nothing; forcing frames would burn battery measuring an idle state.
        expect(out).toContain("'frameend'");
        expect(out).not.toContain('renderNextFrame = true');
    });

    it('arms only after firstFrame plus a settle delay', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain("'firstFrame'");
        expect(out).toContain('3000');
    });

    it('carries the documented sampling constants', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain('120');   // min samples
        expect(out).toContain('33');    // p90 threshold in ms
        expect(out).toContain('500');   // per-sample discard cap
    });

    it('discards frames the user was not watching', () => {
        expect(buildQualityModeInjection()).toContain('document.hidden');
    });

    it('persists the demoted tier so a return visit starts there', () => {
        expect(buildQualityModeInjection()).toContain('ssQualityAutoFloor');
    });

    it('is demote-only and bounded', () => {
        const out = buildQualityModeInjection();
        expect(out).toContain('demoteMode');
        // a pinned manual choice disables it entirely
        expect(out).toContain('__ssQualityPinned');
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- quality-mode-injection > /tmp/qmi.txt 2>&1; tail -40 /tmp/qmi.txt`
Expected: FAIL — `'frameend'`, `'firstFrame'` and `ssQualityAutoFloor` are absent from the runtime.

- [ ] **Step 3: Add the watchdog block**

In `companionRuntime`, insert this after the UI block and before the closing `console.info(...)`:

```js
  // --- demote-only frame-time watchdog -----------------------------------
  // Corrects a wrong heuristic guess downward. It forces nothing to render:
  // the viewer sets app.autoRender = false at the ready gate, so a still camera
  // draws no frames and sampling only the frames it was ALREADY drawing
  // measures exactly what the user experiences. The trade is that the decision
  // lands whenever they first move the camera rather than at a fixed time.
  //
  // Demote-only on purpose: promoting mid-session raises the budget, which
  // makes the engine stream finer LOD (visible pop-in plus a portal pin
  // reconcile). Demoting makes things lighter, which is what a struggling
  // device wants, and one-way makes oscillation impossible.
  var WD_SETTLE_MS = 3000;
  var WD_MIN_SAMPLES = 120;
  var WD_THRESHOLD_MS = 33;      // ~30fps at the 90th percentile
  var WD_MAX_SAMPLE_MS = 500;    // above this is a GC pause or load stall, not render cost
  var WD_MAX_DEMOTIONS = 2;      // hd -> normal -> perf

  var wdSamples = [];
  var wdArmed = false;
  var wdDemotions = 0;
  var wdLast = 0;
  var wdSettleUntil = 0;   // sampling is suspended until this timestamp

  function armWatchdog() {
    if (wdArmed || window.__ssQualityPinned()) { return; }
    var g = getGlobal();
    if (!g || !g.app || !g.app.on) { return; }
    wdArmed = true;
    wdLast = 0;
    g.app.on('frameend', function () {
      if (window.__ssQualityPinned() || wdDemotions >= WD_MAX_DEMOTIONS) { return; }
      var now = (window.performance && window.performance.now) ? window.performance.now() : Date.now();
      var prev = wdLast;
      wdLast = now;
      // post-demotion settle: the budget change re-streams LOD, so those frames
      // say nothing about steady-state cost
      if (wdSettleUntil && Date.now() < wdSettleUntil) { wdSamples.length = 0; return; }
      if (!prev) { return; }
      if (document.hidden) { wdSamples.length = 0; return; }
      var delta = now - prev;
      if (delta <= 0 || delta > WD_MAX_SAMPLE_MS) { return; }
      wdSamples.push(delta);
      if (!shouldDemote(wdSamples, WD_MIN_SAMPLES, WD_THRESHOLD_MS)) {
        if (wdSamples.length > WD_MIN_SAMPLES * 2) { wdSamples.splice(0, wdSamples.length - WD_MIN_SAMPLES); }
        return;
      }
      var next = demoteMode(window.__ssQualityMode);
      wdSamples.length = 0;
      if (next === window.__ssQualityMode) { wdDemotions = WD_MAX_DEMOTIONS; return; }
      wdDemotions++;
      console.info('[quality] watchdog demoting ' + window.__ssQualityMode + ' -> ' + next);
      writeStore(KEY_FLOOR, next);
      window.__ssQualityApply(next, false);
      wdSettleUntil = Date.now() + WD_SETTLE_MS;
    });
  }

  // firstFrame is the viewer's initial-load-done signal; give streaming decode a
  // settle window past it before believing any frame time.
  var readyTries = 0;
  var readyTimer = setInterval(function () {
    readyTries++;
    var g = getGlobal();
    if (g && g.events && !window.__ssQualityReadyHooked) {
      window.__ssQualityReadyHooked = true;
      g.events.on('firstFrame', function () {
        setTimeout(armWatchdog, WD_SETTLE_MS);
      });
    }
    if (window.__ssQualityReadyHooked || readyTries > 240) { clearInterval(readyTimer); }
  }, 500);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- quality-mode-injection > /tmp/qmi.txt 2>&1; tail -40 /tmp/qmi.txt`
Expected: PASS, including the ES5-only and no-backslash assertions.

- [ ] **Step 5: Run the whole suite and lint**

Run: `npm run test > /tmp/all.txt 2>&1; tail -30 /tmp/all.txt`
Expected: PASS.

Run: `npm run lint > /tmp/lint.txt 2>&1; tail -20 /tmp/lint.txt`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/viewer-companion/quality-mode.ts test/quality-mode-injection.test.ts
git commit -m "feat(viewer): demote-only frame-time watchdog"
```

---

### Task 6: Decouple the portal resident ceiling from the live budget

**Files:**
- Modify: `src/viewer-companion/portals.ts:1529-1540` (the `getResidentCeiling` function)
- Test: `test/portals-injection.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing importable. `src/portal-preload.ts` and `computeResidentCeiling`'s signature are **unchanged**, so `test/portal-preload.test.ts` must stay green untouched.

Why: `computeResidentCeiling` derives the cross-scene residency ceiling from the live engine splat budget (`floor = splatBudget * mult`, `mult` 3 mobile / 12 desktop). Left alone, HD would drive that to `3 × 14M = 42M` on mobile and `12 × 14M = 168M` on desktop — the latter overriding the RAM-derived 128M cap entirely. Passing a constant reference budget reproduces today's ceilings exactly (6M mobile, 48M desktop floor) while stopping HD and the capable-mobile 2M→4M bump from inflating residency.

- [ ] **Step 1: Write the failing test**

Add to `test/portals-injection.test.ts`:

```ts
describe('portal resident ceiling is decoupled from the live splat budget', () => {
    // Minimal two-scene streaming payload: buildPortalsInjection returns '' for
    // fewer than two scenes, so the injection must be non-empty to assert on.
    const payload = {
        portals: [
            { position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }
        ],
        portalScenes: ['', 'scenes/1/lod-meta.json'],
        portalStart: 0,
        portalSceneLodCounts: [[1000000, 250000], [800000, 200000]]
    };

    it('passes a constant reference budget, not getSplatBudget()', () => {
        // HD (14M) must not inflate cross-scene residency: 3 x 14M = 42M on
        // mobile (~0.9-1GB, near-certain OOM) and 12 x 14M = 168M on desktop,
        // which would override the RAM-derived 128M cap. The reference is
        // pinned to the Normal-mode budgets so today's ceilings are unchanged.
        const out = buildPortalsInjection(payload);
        expect(out).toContain('CEILING_REFERENCE_BUDGET');
        expect(out).toContain('2000000');
        expect(out).toContain('4000000');
        expect(out).not.toContain('computeResidentCeiling(residentBudgetOverride, getSplatBudget()');
    });
});
```

The existing `buildPortalsInjection smoke` describe (around line 580) has its own local `payload` const with the same shape — this new describe deliberately declares its own rather than reaching into that scope.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- portals-injection > /tmp/pi.txt 2>&1; tail -30 /tmp/pi.txt`
Expected: FAIL — `CEILING_REFERENCE_BUDGET` is absent and the old call text is present.

- [ ] **Step 3: Make the change**

In `src/viewer-companion/portals.ts`, add this constant next to `RESIDENT_BUDGET_MULT` (around line 181):

```js
  // Reference render budget the resident ceiling is derived from -- a CONSTANT,
  // deliberately not the live engine budget. The viewer now has three quality
  // modes (see quality-tier.ts) and HD is 14M; deriving the ceiling from the
  // live budget would put it at 3 x 14M = 42M on mobile (~0.9-1GB of GPU
  // textures at ~20-25 bytes/splat -- near-certain OOM on a phone) and
  // 12 x 14M = 168M on desktop, which overrides the RAM-derived cap entirely.
  // Pinning it to the Normal-mode budgets keeps the ceiling bit-for-bit what it
  // is today (6M mobile, 48M desktop floor), so HD raises only what the engine
  // RENDERS per frame, never what stays resident across scenes. Device class is
  // deliberately not consulted here either, for the same reason.
  var CEILING_REFERENCE_BUDGET = IS_MOBILE ? 2000000 : 4000000;
```

Then in `getResidentCeiling` (around line 1539), replace

```js
    return computeResidentCeiling(residentBudgetOverride, getSplatBudget(), RESIDENT_BUDGET_MULT, IS_MOBILE, total, mem);
```

with

```js
    return computeResidentCeiling(residentBudgetOverride, CEILING_REFERENCE_BUDGET, RESIDENT_BUDGET_MULT, IS_MOBILE, total, mem);
```

Also update the comment above `getResidentCeiling` (lines 1529-1532): change "mobile = MULT x render budget" to "mobile = MULT x the CONSTANT reference budget (see CEILING_REFERENCE_BUDGET)" and drop the "0 until the budget is known" sentence — with a constant reference the ceiling is known immediately.

`getSplatBudget()` has other callers in the file; leave it and them alone.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- portals > /tmp/p.txt 2>&1; tail -40 /tmp/p.txt`
Expected: PASS for `portals-injection`, `portals`, `portals-runtime` and `portal-preload` alike. `computeResidentCeiling` is untouched, so `test/portal-preload.test.ts` needs no edits.

- [ ] **Step 5: Full suite, lint and build**

Run: `npm run test > /tmp/all.txt 2>&1; tail -30 /tmp/all.txt`
Expected: PASS.

Run: `npm run lint > /tmp/lint.txt 2>&1; tail -20 /tmp/lint.txt`
Expected: no errors.

Run: `npm run build > /tmp/build.txt 2>&1; grep -c "plugin typescript" /tmp/build.txt`
Expected: `0`.

- [ ] **Step 6: Commit**

```bash
git add src/viewer-companion/portals.ts test/portals-injection.test.ts
git commit -m "fix(portals): decouple resident ceiling from the live splat budget"
```

---

## E2E verification (after all tasks)

These require a **RELEASE build** (`npm run build`) — stringified helpers behave differently under debug builds, and this fork has been bitten by that before. Serve via `npm run dev` from `server/` (port 3334) so the export paths and the app are same-origin.

- [ ] **1. Desktop single-scene export.** Settings panel shows three segments. Console logs `[quality] class=standard mode=hd hd=14M`. Switching modes re-runs `applyPerfSettings` with no reload; confirm `app.scene.gsplat.splatBudget` reads 2000000 / 4000000 / 14000000 for perf / normal / hd.
- [ ] **2. Desktop portal export.** HD reaches 14M. The `[portals] ceiling/costs/resident/depths` line reports the same ceiling in all three modes, and that ceiling matches what `main` reported before this change.
- [ ] **3. Mobile portal export, real phone.** Heuristic picks perf or normal, never hd. Manual HD reaches 6M on a small project. The ceiling stays 6M in all three modes. Walk the full portal chain twice and confirm no new eviction or re-streaming versus `main`.
- [ ] **4. Watchdog.** On a device that struggles (or with a deliberately heavy scene), confirm exactly one demotion step, no oscillation, `ssQualityAutoFloor` written, and that reloading starts at the demoted tier. Then pick a mode manually and confirm the watchdog stops firing.
- [ ] **5. Legacy migration.** With only `performanceMode` in localStorage for the origin, load and confirm it migrates once, pins, and writes `ssQualityMode`. On a fresh origin confirm `ssQualityMode` is written as `'auto'` and the heuristic re-runs on reload (i.e. the seeded `performanceMode` is not misread as a legacy pick).
- [ ] **6. `?budget=` still wins.** Load with `?budget=8` and confirm the splat budget is 8M in every mode, while the segments still change the resolution scale.
- [ ] **7. Locale check.** Load with a non-English browser locale and confirm the control's labels render (they come from the companion's own table, not the viewer's i18n).

## Locale review

The nine label sets in Task 4 are machine-assisted translations and follow this repo's convention of being flagged for review. After E2E, ask the user to sign off on the `de/es/fr/ja/ko/pt/ru/zh` strings for "Quality", "Performance" and "Normal" before the branch is finished.
