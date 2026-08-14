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
        if (s.memGb > 0 && s.memGb <= 4) {
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

// One step down the quality ladder: hd -> normal -> perf -> perf@weak,
// bottoming out at the last step. The third step demotes the device CLASS
// rather than the mode: the engine patch picks its budget table with
// `(qualityClass === 'weak') ? budgets.mobile : budgets.desktop`, so a
// `standard`-classed device floors its Performance mode at
// `budgets.desktop.low` = 2M -- the weak table's 1M is unreachable however
// badly the device struggles, unless something also demotes the class. Class
// demotion is applied on desktop too, not only mobile: this step is only ever
// reached after two earlier mode demotions already failed to help, which is
// itself the definition of a struggling device regardless of platform. The
// watchdog is demote-only, so there is deliberately no inverse. Pure and
// self-contained.
const demoteQuality = (mode: QualityMode, cls: QualityClass): { mode: QualityMode; cls: QualityClass } => {
    if (mode === 'hd') {
        return { mode: 'normal', cls };
    }
    if (mode === 'normal') {
        return { mode: 'perf', cls };
    }
    if (cls === 'standard') {
        return { mode: 'perf', cls: 'weak' };
    }
    return { mode: 'perf', cls };   // already at the floor: unchanged
};

// Resolve the startup mode from stored preferences and the heuristic's pick.
//
//   ssQualityMode = perf|normal|hd  -> an explicit user choice: pinned, watchdog off
//   ssQualityMode absent + legacy performanceMode that DIFFERS from the stock
//                                      platform default
//                                   -> migrate once, pin (mirrors the stock
//                                      viewer's own retinaDisplay migration)
//   ssQualityMode absent, no usable legacy -> heuristic, and WRITE 'auto'
//   ssQualityMode = auto            -> heuristic, capped by ssQualityAutoFloor
//
// The PRESENCE of legacy performanceMode is NOT evidence of a user choice. The
// stock viewer writes that key unconditionally at init (updatePerformanceMode()
// runs once immediately, not only on toggle), seeded from `platform.mobile`. So
// anyone who has ever opened any viewer on the origin already holds the key at
// the platform default -- migrating on presence alone would pin every returning
// visitor (desktop stuck on Normal, mobile stuck on Perf) and make the whole
// feature inert for a publish origin's entire existing audience. Only a value
// that DIFFERS from String(isMobile) can have come from a deliberate toggle.
//
// Accepted trade: a user who explicitly selected the value that happens to equal
// their platform default loses that pin and gets the heuristic instead. The
// heuristic is at least as good on average, and the demote watchdog covers the
// downside.
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
    auto: QualityMode,
    isMobile: boolean
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
    const stockDefault = isMobile ? 'true' : 'false';
    if (stored !== 'auto' && (legacy === 'true' || legacy === 'false') && legacy !== stockDefault) {
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

// Classify a frameend-counter observation window against a minimum fps floor.
//
// Four-valued rather than boolean because the caller needs to distinguish two
// different "not a verdict yet" conditions that call for different responses:
//
//   - the window has not run long enough ('wait') -> keep counting, this call
//     contributed nothing and the window stays open
//   - the window ran far too long ('reset') -> something interrupted it (a
//     backgrounded tab, a throttled page), so the rate it would report says
//     nothing about render cost; discard it and open a fresh window
//
// Folding those two together -- treating "interrupted" the same as "not
// finished" -- is exactly how a resumed background tab would misfire: its
// window would carry a near-zero frame count against a huge elapsed time
// (the whole backgrounded gap), which reads as a spuriously low fps and
// would trigger a false demotion the moment the caller judged it instead of
// discarding it.
//
// A frame counter has no equivalent of the old sampler's per-sample discard
// cap, and needs none: one long stall merely costs the window a few frames
// off its count, it cannot hide the device the way discarding an
// over-threshold DELTA could.
//
// Pure and self-contained for stringification.
const classifyFpsWindow = (
    frames: number,
    elapsedMs: number,
    minFps: number,
    minWindowMs: number,
    maxWindowMs: number
): 'wait' | 'reset' | 'ok' | 'demote' => {
    // Guard division by a zero/negative elapsed rather than doing it: a
    // window that has not started accumulating real time yet is simply not
    // finished, i.e. 'wait', regardless of what minWindowMs happens to be.
    if (elapsedMs <= 0 || elapsedMs < minWindowMs) {
        return 'wait';
    }
    if (elapsedMs > maxWindowMs) {
        return 'reset';
    }
    const fps = frames * 1000 / elapsedMs;
    return (fps < minFps) ? 'demote' : 'ok';
};

export { pickQualityClass, pickAutoMode, hdBudgetFor, demoteQuality, resolveQualityMode, classifyFpsWindow, QualityMode, QualityClass, DeviceSignals, ResolvedQuality };
