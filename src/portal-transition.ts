// Pure geometry + lifecycle for the exported viewer's portal transition effect
// (a tile cover that dismantles the outgoing scene and reconstructs the
// incoming one).
//
// Every function here is stringified into the exported viewer
// (Function.toString()) and evaluated in a separate scope, so each one must be
// SELF-CONTAINED: no imports, no references to sibling functions or module
// constants, all literals inline. The runtime body that hosts them is authored
// inside a template literal, so this file must also contain no backslash
// escapes and no '${' sequences in code that is stringified.

type TilePhase = 'dismantle' | 'reconstruct';

type TransitionPhase = 'idle' | 'dismantling' | 'covered' | 'reconstructing';

type TransitionState = {
    phase: TransitionPhase,
    target: number | null   // scene index the crossing is heading for
};

type TransitionEvent =
    // A transition-enabled portal crossing was detected (only acts when idle).
    { type: 'crossing', target: number } |
    // The dismantle sweep finished. `target` is the crossing re-resolved at that
    // instant: null when the user walked back through the doorway (cancel).
    { type: 'covered', target: number | null } |
    // The destination scene is on screen behind the cover (switched and ready,
    // or the loading overlay just hid).
    { type: 'sceneShown' } |
    // The reconstruct sweep finished.
    { type: 'done' } |
    // Error/watchdog path: drop the cover immediately.
    { type: 'abort' };

type TransitionActions = {
    cover: 'none' | 'dismantle' | 'reconstruct' | 'clear',
    dispatchTarget: number | null   // hand this crossing to crossingReducer
};

type TransitionResult = { state: TransitionState, actions: TransitionActions };

// Tile grid for a viewport: roughly square tiles around a 110px target, clamped
// so a phone does not get one giant tile and an ultrawide does not get hundreds.
const tileGrid = (width: number, height: number): { cols: number, rows: number } => {
    const TARGET = 110;
    const w = (typeof width === 'number' && width > 0) ? width : TARGET;
    const h = (typeof height === 'number' && height > 0) ? height : TARGET;
    let cols = Math.round(w / TARGET);
    if (cols < 6) {
        cols = 6;
    }
    if (cols > 20) {
        cols = 20;
    }
    let rows = Math.round(cols * h / w);
    if (rows < 4) {
        rows = 4;
    }
    if (rows > 16) {
        rows = 16;
    }
    return { cols: cols, rows: rows };
};

// Normalised radial geometry of tile `index` in a cols x rows grid:
// dist 0 at the screen centre, approaching but never reaching 1 at a corner
// for a finite grid (the `> 1` clamp below is defensive, not reachable in
// practice); (ux, uy) is the outward unit vector used for the fly-in / fly-out
// translation.
const tileGeometry = (cols: number, rows: number, index: number): { dist: number, ux: number, uy: number } => {
    const c = index % cols;
    const r = Math.floor(index / cols);
    const dx = (c + 0.5) / cols - 0.5;
    const dy = (r + 0.5) / rows - 0.5;
    const len = Math.sqrt(dx * dx + dy * dy) || 1e-6;
    const maxLen = Math.sqrt(0.5);
    let dist = len / maxLen;
    if (dist > 1) {
        dist = 1;
    }
    return { dist: dist, ux: dx / len, uy: dy / len };
};

// Stagger for one tile. Dismantle runs edges -> centre (the centre of the
// outgoing scene is covered last); reconstruct runs centre -> edges.
const tileDelay = (dist: number, sweep: number, phase: TilePhase): number => {
    return (phase === 'dismantle') ? (1 - dist) * sweep : dist * sweep;
};

// Transition lifecycle. The wiring applies the returned actions; it never makes
// a phase decision itself.
const transitionReducer = (state: TransitionState, event: TransitionEvent): TransitionResult => {
    const none: TransitionActions = { cover: 'none', dispatchTarget: null };
    if (event.type === 'crossing') {
        if (state.phase !== 'idle') {
            return { state: state, actions: none };
        }
        return {
            state: { phase: 'dismantling', target: event.target },
            actions: { cover: 'dismantle', dispatchTarget: null }
        };
    }
    if (event.type === 'covered') {
        if (state.phase !== 'dismantling') {
            return { state: state, actions: none };
        }
        if (event.target === null || event.target === undefined) {
            // walked back before the cover closed: no switch, just reopen
            return {
                state: { phase: 'reconstructing', target: null },
                actions: { cover: 'reconstruct', dispatchTarget: null }
            };
        }
        return {
            state: { phase: 'covered', target: event.target },
            actions: { cover: 'none', dispatchTarget: event.target }
        };
    }
    if (event.type === 'sceneShown') {
        if (state.phase !== 'covered') {
            return { state: state, actions: none };
        }
        return {
            state: { phase: 'reconstructing', target: state.target },
            actions: { cover: 'reconstruct', dispatchTarget: null }
        };
    }
    if (event.type === 'done') {
        if (state.phase !== 'reconstructing') {
            return { state: state, actions: none };
        }
        return { state: { phase: 'idle', target: null }, actions: none };
    }
    // 'abort'
    return {
        state: { phase: 'idle', target: null },
        actions: { cover: 'clear', dispatchTarget: null }
    };
};

export {
    tileGrid,
    tileGeometry,
    tileDelay,
    transitionReducer,
    TilePhase,
    TransitionPhase,
    TransitionState,
    TransitionEvent,
    TransitionActions,
    TransitionResult
};
