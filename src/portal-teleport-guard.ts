// Guard for viewer-driven camera transitions in the exported portal viewer.
//
// The exported viewer does NOT teleport the camera when an annotation is
// activated (nor on the reset/frame shortcuts): it calls
// controllers.<mode>.goto(pose) followed by startTransition(), which lerps the
// camera from the old pose to the new one over a fixed ~1s (transitionSpeed 1.0,
// easeOut). The companion's free-navigation crossing detection reads that lerp
// as real movement, so any portal quad the straight-line flight happens to punch
// through switches the scene - and plays the transition effect - on top of the
// scene the jump itself asserted. That is why one annotation pair could land in
// the wrong scene in one direction only: the outcome depends on which portals
// the flight path intersects and which side of the last one the DESTINATION pose
// sits on, which is not symmetric between A -> B and B -> A.
//
// So a jump opens a guard window. While it is open the companion skips
// segment-based crossing detection entirely and simply keeps lastSafe primed at
// the camera's current position, so the flight can never resolve a crossing.
// The window also outlives its deadline for as long as the asserted scene is
// still 'blocked' (not loadable yet), re-firing the assertion every frame so the
// jump completes the instant that scene loads. That mirrors the frozen-lastSafe
// re-fire a portal crossing gets for free from geometry - a jump has no segment
// to re-fire from, so without this its blocked crossing would be abandoned by
// the next frame's noCrossing.
//
// Pure and self-contained (no imports, no sibling-function or module-constant
// references, all literals inline) so it can be stringified verbatim into the
// exported viewer runtime - see the constraint note in
// viewer-companion/portals.ts.

type TeleportGuardState = {
    target: number | null,   // scene the jump asserted; null = no guard open
    until: number            // clock deadline (ms, same base as `now`) of the viewer's camera transition
};

type TeleportGuardResult = {
    state: TeleportGuardState,
    active: boolean,   // suppress segment-based crossing detection this frame
    refire: boolean    // re-assert the guarded crossing (its target is still blocked)
};

// Open (or replace) the guard for a jump asserting `target`. durationMs is
// passed in rather than baked so the caller owns the (viewer-derived) transition
// length and this stays a pure function of its arguments.
const beginTeleportGuard = (target: number | null, now: number, durationMs: number): TeleportGuardState => {
    return { target: target, until: now + durationMs };
};

// Per-frame decision. Returns the guard's next state plus what the frame should
// do: `active` suppresses crossing detection, `refire` asks for the guarded
// target to be dispatched again (only while the crossing reducer is blocked on
// it, which keeps the re-fire idempotent and its log line suppressed).
const tickTeleportGuard = (
    state: TeleportGuardState,
    now: number,
    crossMode: string,
    crossTarget: number | null
): TeleportGuardResult => {
    if (!state || state.target === null || state.target === undefined) {
        return { state: { target: null, until: 0 }, active: false, refire: false };
    }
    const held = crossMode === 'blocked' && crossTarget === state.target;
    if (now >= state.until && !held) {
        return { state: { target: null, until: 0 }, active: false, refire: false };
    }
    return { state: state, active: true, refire: held };
};

export { beginTeleportGuard, tickTeleportGuard, TeleportGuardState, TeleportGuardResult };
