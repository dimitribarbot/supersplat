// Pure geometry + lifecycle for the exported viewer's portal transition effect
// (a tile cover that dismantles the outgoing scene and reconstructs the
// incoming one).
//
// tileGrid, tileGeometry, tileDelay and transitionReducer are stringified into
// the exported viewer (Function.toString()) and evaluated in a separate scope,
// so each of those four must be SELF-CONTAINED: no imports, no references to
// sibling functions or module constants, all literals inline. The runtime body
// that hosts them is authored inside a template literal, so this file must also
// contain no backslash escapes and no '${' sequences in code that is
// stringified. normalizePortalTransition is NOT stringified; it is a plain
// import used by the editor and the export builder.

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

// Which cover the exported viewer plays when a portal is crossed. NOT
// stringified into the viewer -- this is a plain import used by the editor UI,
// the document reader and the export payload builder.
type PortalTransition = 'none' | 'tiles' | 'defocus';

// Single reader for every stored shape of the field. Documents written before
// the dropdown stored a boolean, where absent meant "enabled", so anything that
// is not an explicit off resolves to the DEFAULT cover -- which is defocus.
// Note this also re-points pre-dropdown documents: a portal that played tiles
// by virtue of having no field now plays defocus. That is deliberate; nothing
// on disk is rewritten, only how absence is read. Only an explicit 'tiles'
// selects the tile cover. Mirrored (not imported -- see the file header) by
// transitionKind in viewer-companion/portals.ts; keep both in sync when a
// fourth kind is added, including which one is the fallback.
const normalizePortalTransition = (v: unknown): PortalTransition => {
    if (v === false || v === 'none') {
        return 'none';
    }
    if (v === 'tiles') {
        return 'tiles';
    }
    return 'defocus';
};

// Tile grid for a viewport: roughly square tiles around a 26px target, floored
// so a phone does not get one giant tile and capped on total count so a large
// display does not animate several thousand composited divs. Phones and small
// laptops hit 26px exactly; only big displays fall back to a coarser grid, and
// they land around 40-56px -- still ~4x finer than the 110px this replaced.
const tileGrid = (width: number, height: number): { cols: number, rows: number } => {
    const TARGET = 26;
    const MAX_TILES = 1200;
    const w = (typeof width === 'number' && width > 0) ? width : TARGET;
    const h = (typeof height === 'number' && height > 0) ? height : TARGET;
    let cols = Math.round(w / TARGET);
    if (cols < 6) {
        cols = 6;
    }
    let rows = Math.round(cols * h / w);
    if (rows < 4) {
        rows = 4;
    }
    if (cols * rows > MAX_TILES) {
        // scale both axes by the same factor so the tiles stay roughly square
        const k = Math.sqrt(MAX_TILES / (cols * rows));
        cols = Math.floor(cols * k);
        rows = Math.floor(rows * k);
        if (cols < 6) {
            cols = 6;
        }
        if (rows < 4) {
            rows = 4;
        }
        // An axis already sitting at its minimum before the cap gets scaled
        // down and then reclamped straight back up, re-inflating the product
        // past MAX_TILES. Give the long axis whatever the short one leaves.
        if (cols * rows > MAX_TILES) {
            if (cols >= rows) {
                cols = Math.floor(MAX_TILES / rows);
                if (cols < 6) {
                    cols = 6;
                }
            } else {
                rows = Math.floor(MAX_TILES / cols);
                if (rows < 4) {
                    rows = 4;
                }
            }
        }
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
    normalizePortalTransition,
    PortalTransition,
    TilePhase,
    TransitionPhase,
    TransitionState,
    TransitionEvent,
    TransitionActions,
    TransitionResult
};
