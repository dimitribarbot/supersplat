// Crossing/overlay lifecycle state machine for the exported portal viewer.
//
// The exported-viewer runtime (viewer-companion/portals.ts) detects portal
// crossings each frame and must decide: switch scenes now, hold a crossing
// into a scene whose entity has not loaded yet, arm or drop the streaming
// loading-overlay reveal poll, and record reveal completion. Keeping those
// decisions in the injected IIFE made them untestable and produced two bugs
// (a dropped never-retried crossing; a stale poll falsely marking an
// abandoned scene ready), so they live here as a pure reducer instead. The
// IIFE stringifies this function in (Function.toString()) and just applies
// the returned actions.
//
// Modes:
//   idle    - nothing pending.
//   blocked - a crossing was detected but the target scene cannot be switched
//             to yet (neither loaded nor load-in-flight). The wiring shows
//             the overlay backdrop and FREEZES lastSafe on the known side of
//             the portal, so the same crossing re-fires every frame (this
//             reducer is idempotent for it) and the switch completes on the
//             first frame the target is loaded - no load-callback plumbing
//             needed.
//   loading - the switch happened but the streaming target has not revealed
//             yet; the wiring runs its gsplat-count reveal poll for `target`.
//
// Overlay directives: 'keep' = leave backdrop/poll as they are; 'show' =
// backdrop visible, poll stopped (blocked phase); 'poll' = (re)arm the reveal
// poll for the new state.target; 'hide' = backdrop hidden + poll stopped
// WITHOUT marking anything ready (an abandoned target must not be marked
// ready - only an explicit markReady may do that).
//
// Pure and self-contained (no imports, no sibling-function or module-variable
// references; all literals inline) so it can be stringified verbatim into the
// exported viewer runtime - see the constraint note in viewer-companion/portals.ts.

type CrossingMode = 'idle' | 'blocked' | 'loading';

type CrossingState = {
    mode: CrossingMode,
    target: number | null   // blocked: scene awaited; loading: scene polled; idle: null
};

type CrossingEvent =
    // A crossing (or anim-timeline / camera-reset assertion) wants `target`
    // active. loaded = the switch can be performed now (its entity exists or its load is in flight); ready = no overlay needed (SOG
    // scenes once loaded; streaming scenes once revealed or pinned resident).
    { type: 'crossing', target: number, loaded: boolean, ready: boolean } |
    // A frame with no pending crossing (only blocked reacts: user retreated).
    { type: 'noCrossing' } |
    // The wiring's reveal poll decided `target` is visibly present.
    { type: 'revealed', target: number };

type OverlayDirective = 'keep' | 'show' | 'poll' | 'hide';

type CrossingActions = {
    switchTo: number | null,    // perform the scene switch (entities/collision/pins)
    overlay: OverlayDirective,
    markReady: number | null    // record this scene as revealed
};

type CrossingResult = { state: CrossingState, actions: CrossingActions };

const crossingReducer = (state: CrossingState, event: CrossingEvent): CrossingResult => {
    const none: CrossingActions = { switchTo: null, overlay: 'keep', markReady: null };
    if (event.type === 'crossing') {
        const u = event.target;
        if (!event.loaded) {
            // Target not switchable yet (neither loaded nor loading): hold the
            // crossing as blocked. Idempotent for the per-frame re-fire
            // produced by the frozen lastSafe.
            if (state.mode === 'blocked' && state.target === u) {
                return { state: state, actions: none };
            }
            return {
                state: { mode: 'blocked', target: u },
                actions: { switchTo: null, overlay: 'show', markReady: null }
            };
        }
        if (event.ready) {
            // Loaded + ready: switch now. Any pending overlay/poll is dropped
            // WITHOUT marking its abandoned target ready (stale-poll fix).
            if (state.mode === 'loading' && state.target === u) {
                return { state: state, actions: none };   // already active + polling
            }
            return {
                state: { mode: 'idle', target: null },
                actions: { switchTo: u, overlay: state.mode === 'idle' ? 'keep' : 'hide', markReady: null }
            };
        }
        // Loaded but not yet revealed (streaming): switch and run the reveal poll.
        if (state.mode === 'loading' && state.target === u) {
            return { state: state, actions: none };       // poll already running
        }
        return {
            state: { mode: 'loading', target: u },
            actions: { switchTo: u, overlay: 'poll', markReady: null }
        };
    }
    if (event.type === 'noCrossing') {
        // Only blocked reacts: the user retreated to the known side before the
        // target loaded. loading keeps polling; idle is a no-op.
        if (state.mode === 'blocked') {
            return {
                state: { mode: 'idle', target: null },
                actions: { switchTo: null, overlay: 'hide', markReady: null }
            };
        }
        return { state: state, actions: none };
    }
    // 'revealed'
    if (state.mode === 'loading' && state.target === event.target) {
        return {
            state: { mode: 'idle', target: null },
            actions: { switchTo: null, overlay: 'hide', markReady: event.target }
        };
    }
    // Stale reveal (a poll result for an abandoned target) -> ignore.
    return { state: state, actions: none };
};

export { crossingReducer, CrossingState, CrossingEvent, CrossingActions, CrossingResult, CrossingMode, OverlayDirective };
