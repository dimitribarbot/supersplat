// XR session tracking for the exported portal viewer's crossing detection.
//
// In an XR session supersplat-viewer stops updating its camera manager ("in xr
// mode we leave the camera alone"), so the desktop pose the companion reads for
// crossings freezes for the whole session; the companion reads the camera
// entity, which the headset drives, instead. The pose source switches at the
// session's edges, and the camera jumps there (to the headset's pose on start,
// back to the pre-session pose on end): neither jump is a walk, so `changed`
// asks the caller to drop the swept segment for that frame.
//
// On exit the viewer puts the camera back where the session started, so the
// scene must go back to the one the session started in: `returnTo` names it
// when a crossing during the session changed the active scene.
//
// Pure and self-contained (no imports, no sibling-function or module-constant
// references) so it can be stringified verbatim into the exported viewer
// runtime - see the constraint note in viewer-companion/portals.ts.

type XrSessionState = {
    inXr: boolean;
    startScene: number | null; // scene active when the session started; null outside one
};

type XrSessionResult = {
    state: XrSessionState;
    changed: boolean; // a session started or ended this frame
    returnTo: number | null; // scene to switch back to on exit; null = none
};

const tickXrSession = (state: XrSessionState, xrActive: boolean, activeIndex: number): XrSessionResult => {
    if (xrActive === state.inXr) {
        return { state: state, changed: false, returnTo: null };
    }
    if (xrActive) {
        return { state: { inXr: true, startScene: activeIndex }, changed: true, returnTo: null };
    }
    const back = state.startScene !== null && state.startScene !== activeIndex ? state.startScene : null;
    return { state: { inXr: false, startScene: null }, changed: true, returnTo: back };
};

export { tickXrSession, XrSessionState, XrSessionResult };
