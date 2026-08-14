import { describe, it, expect } from 'vitest';

import { pickQualityClass, pickAutoMode, hdBudgetFor, demoteQuality, resolveQualityMode, classifyFpsWindow } from '../src/quality-tier';

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

    it('classes <=4GB mobile weak, but leaves the same value standard on desktop', () => {
        expect(pickQualityClass({ ...IOS, memGb: 4 })).toBe('weak');
        expect(pickQualityClass({ ...DESKTOP, memGb: 4 })).toBe('standard');
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

describe('demoteQuality', () => {
    it('steps down the ladder hd -> normal -> perf -> perf@weak, bottoming out there', () => {
        expect(demoteQuality('hd', 'standard')).toEqual({ mode: 'normal', cls: 'standard' });
        expect(demoteQuality('hd', 'weak')).toEqual({ mode: 'normal', cls: 'weak' });
        expect(demoteQuality('normal', 'standard')).toEqual({ mode: 'perf', cls: 'standard' });
        expect(demoteQuality('normal', 'weak')).toEqual({ mode: 'perf', cls: 'weak' });
        expect(demoteQuality('perf', 'standard')).toEqual({ mode: 'perf', cls: 'weak' });
        // the floor: a weak device already at perf is returned unchanged
        expect(demoteQuality('perf', 'weak')).toEqual({ mode: 'perf', cls: 'weak' });
    });

    it('never produces a higher mode or class tier than its input', () => {
        const modeRank = (m: string) => (m === 'hd' ? 2 : (m === 'normal' ? 1 : 0));
        const classRank = (c: string) => (c === 'standard' ? 1 : 0);
        const modes = ['hd', 'normal', 'perf'] as const;
        const classes = ['standard', 'weak'] as const;
        modes.forEach((mode) => {
            classes.forEach((cls) => {
                const next = demoteQuality(mode, cls);
                expect(modeRank(next.mode)).toBeLessThanOrEqual(modeRank(mode));
                expect(classRank(next.cls)).toBeLessThanOrEqual(classRank(cls));
            });
        });
    });
});

describe('resolveQualityMode', () => {
    it('honours an explicit stored pick and pins it', () => {
        expect(resolveQualityMode('hd', null, null, 'normal', false)).toEqual({ mode: 'hd', pinned: true, write: null });
        expect(resolveQualityMode('perf', 'false', 'normal', 'hd', false)).toEqual({ mode: 'perf', pinned: true, write: null });
    });

    it('migrates a legacy performanceMode once, pins it, and persists the migration', () => {
        // Both rows are genuine user choices, i.e. the legacy value differs from
        // the stock platform default (String(isMobile)): 'true' on a DESKTOP
        // means Performance was toggled on; 'false' on MOBILE means it was
        // toggled off.
        expect(resolveQualityMode(null, 'true', null, 'hd', false)).toEqual({ mode: 'perf', pinned: true, write: 'perf' });
        expect(resolveQualityMode(null, 'false', null, 'hd', true)).toEqual({ mode: 'normal', pinned: true, write: 'normal' });
    });

    it('does not migrate a legacy value equal to the stock platform default', () => {
        // The stock viewer writes performanceMode unconditionally at init, seeded
        // from platform.mobile -- so its presence at the platform default is not
        // evidence of a choice, and pinning on it would make the feature inert
        // for every returning visitor.
        expect(resolveQualityMode(null, 'false', null, 'hd', false)).toEqual({ mode: 'hd', pinned: false, write: 'auto' });
        expect(resolveQualityMode(null, 'true', null, 'normal', true)).toEqual({ mode: 'normal', pinned: false, write: 'auto' });
    });

    it('writes auto on a fresh origin so the seeded performanceMode is not misread as legacy next visit', () => {
        expect(resolveQualityMode(null, null, null, 'hd', false)).toEqual({ mode: 'hd', pinned: false, write: 'auto' });
    });

    it('uses the heuristic unpinned when auto is stored', () => {
        expect(resolveQualityMode('auto', 'true', null, 'hd', false)).toEqual({ mode: 'hd', pinned: false, write: null });
    });

    it('caps the heuristic at a stored auto floor but never raises it', () => {
        expect(resolveQualityMode('auto', null, 'normal', 'hd', false).mode).toBe('normal');
        expect(resolveQualityMode('auto', null, 'perf', 'hd', false).mode).toBe('perf');
        expect(resolveQualityMode('auto', null, 'hd', 'normal', false).mode).toBe('normal');
    });

    it('ignores an unrecognised stored value and falls through to the heuristic', () => {
        expect(resolveQualityMode('ultra', null, null, 'normal', false)).toEqual({ mode: 'normal', pinned: false, write: 'auto' });
    });
});

describe('classifyFpsWindow', () => {
    // Fixed params for most cases: a 3000ms window, 10000ms interrupted-window
    // ceiling, 30fps floor -- matching the companion's WD_WINDOW_MS / WD_MAX_WINDOW_MS
    // / WD_MIN_FPS.

    it('waits while the window has not run long enough to judge', () => {
        expect(classifyFpsWindow(50, 2999, 30, 3000, 10000)).toBe('wait');
    });

    it('is inclusive at the minWindowMs boundary -- exactly at it is judged, not waited on', () => {
        // 60 frames over exactly 3000ms = 20fps, under the 30fps floor. If the
        // boundary were exclusive this would still read 'wait'; it must not.
        expect(classifyFpsWindow(60, 3000, 30, 3000, 10000)).toBe('demote');
    });

    it('is healthy just under the interrupted-window ceiling', () => {
        expect(classifyFpsWindow(300, 9999, 30, 3000, 10000)).toBe('ok');
    });

    it('resets once the window ran further than maxWindowMs', () => {
        // A near-zero rate that would otherwise read as 'demote' must instead
        // discard as 'reset': a window this long says the tab was interrupted
        // (backgrounded, throttled), not that the device is struggling.
        expect(classifyFpsWindow(1, 10001, 30, 3000, 10000)).toBe('reset');
    });

    it('is inclusive at the maxWindowMs boundary -- exactly at it is still judged, not reset', () => {
        // 200 frames over exactly 10000ms = 20fps, under the floor. If the
        // boundary were exclusive (reset-on-equal) this would read 'reset'.
        expect(classifyFpsWindow(200, 10000, 30, 3000, 10000)).toBe('demote');
    });

    it('demotes below the fps floor', () => {
        // 60 frames over 3000ms = 20fps.
        expect(classifyFpsWindow(60, 3000, 30, 3000, 10000)).toBe('demote');
    });

    it('is healthy exactly at the fps floor -- "below" is strict', () => {
        // 90 frames over 3000ms = exactly 30fps.
        expect(classifyFpsWindow(90, 3000, 30, 3000, 10000)).toBe('ok');
    });

    it('is healthy comfortably above the floor', () => {
        // 180 frames over 3000ms = 60fps.
        expect(classifyFpsWindow(180, 3000, 30, 3000, 10000)).toBe('ok');
    });

    it('waits rather than dividing by a zero or negative elapsed', () => {
        expect(classifyFpsWindow(0, 0, 30, 3000, 10000)).toBe('wait');
        expect(classifyFpsWindow(5, -100, 30, 3000, 10000)).toBe('wait');
    });

    it('waits on a zero elapsed even with no configured minimum window, rather than dividing by zero', () => {
        // minWindowMs 0 means elapsedMs < minWindowMs cannot itself catch this
        // case (0 < 0 is false) -- only an explicit elapsedMs <= 0 guard does.
        expect(classifyFpsWindow(0, 0, 30, 0, 10000)).toBe('wait');
    });

    it('waits on a negative elapsed below a negative minimum window, rather than dividing by a negative', () => {
        // minWindowMs -1000 means elapsedMs < minWindowMs cannot itself catch
        // this case (-100 < -1000 is false) -- only the explicit elapsedMs <= 0
        // guard does.
        expect(classifyFpsWindow(5, -100, 30, -1000, 10000)).toBe('wait');
    });
});
