// Pure, dependency-free decision helpers for the exported viewer's portal
// marker icons. No playcanvas imports: the pure functions below are unit-tested
// here AND stringified verbatim into the injected companion runtime
// (Function.toString()), exactly like portal-geom / portal-crossing /
// portal-transition. That means each one must be SELF-CONTAINED -- no
// references to module-scope constants, no imports.

type MarkerPortal = { front: number | null, back: number | null };

// Icon size in screen pixels. Deliberately larger than the viewer's own
// annotation hotspot (25px) so a doorway marker reads as a distinct affordance.
const MARKER_SIZE = 48;

// Indices of the portals that touch the active scene. A portal is only drawn
// while the camera stands in one of the two scenes it connects -- otherwise its
// icon would float in geometry that is not loaded or not visible.
// A portal side is null when the scene it referenced was deleted, so reject a
// null/undefined active index up front rather than letting null match null.
const portalsForScene = (portals: MarkerPortal[], active: number): number[] => {
    const out: number[] = [];
    const list = portals || [];
    if (active === null || active === undefined) return out;
    for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (!p) continue;
        if (p.front === active || p.back === active) out.push(i);
    }
    return out;
};

// World-space uniform scale that keeps the quad at a constant world size whose
// face-on projection is `size` px. This is the exported viewer's own hotspot
// formula (Annotation._calculateScreenSpaceScale), extracted so it can be
// tested.
// projData5 is projectionMatrix.data[5] (= 1 / tan(fovY / 2)); viewDepth is the
// POSITIVE view-space depth (the caller negates the view-space z).
const markerScale = (size: number, canvasHeight: number, projData5: number, viewDepth: number): number => {
    if (!canvasHeight || !projData5) return 0;
    return (size / canvasHeight) * (2 * viewDepth / projData5);
};

// Suppression rule. Deliberately NOT a function of controlsHidden or
// gamingControls: unlike the viewer's annotations, portal markers stay visible
// while the user is moving in walk or fly mode. That divergence is the whole
// reason this cannot reuse the viewer's Annotation class, whose opacity is a
// static shared by every instance.
const markerVisible = (s: { noui: boolean, cameraMode: string, transitionActive: boolean }): boolean => {
    if (!s) return true;
    if (s.noui) return false;
    if (s.cameraMode === 'anim') return false;
    if (s.transitionActive) return false;
    return true;
};

// Whether the icons respond to the pointer at all. Deliberately SEPARATE from
// markerVisible: with gaming controls on the icons stay on screen, they just
// stop reacting -- which is what the hand-off memo has always promised and what
// the runtime did not do.
//
// Gaming controls in walk or fly means the pointer is not an aim point. On
// touch a tap there is the viewer's jump (raised inside the touch input source,
// so neither engine click guard can see it, and it would fire alongside the
// tooltip). On desktop the same state is what PointerLockManager locks on, and
// under pointer lock clientX/clientY are FROZEN at the lock position -- so a
// click would open the tooltip of whatever icon sat under a stale point, and a
// pointermove would latch the hover tint there forever. Because the lock only
// ever engages in this state, testing it here needs no pointerLockElement read.
const markerInteractive = (s: { cameraMode: string, gamingControls: boolean }): boolean => {
    if (!s) return true;
    if (s.gamingControls && (s.cameraMode === 'walk' || s.cameraMode === 'fly')) return false;
    return true;
};

// Index of the topmost marker whose icon covers (x, y), or -1.
//
// The icon lies flat in the portal plane, so it projects to an ELLIPSE, not a
// circle: foreshortening compresses one axis only. `u` and `v` are the screen
// images of the quad's two in-plane half-axes, so they are the ellipse's
// conjugate half-axes, and undoing that 2x2 map turns the test back into the
// unit disc. Three things fall out of the geometry rather than needing code:
// edge-on collapses the determinant to zero so an invisible icon is
// unclickable with no angle threshold; a tilted doorway gives a rotated
// ellipse; and the normalised distance doubles as the nearest-centre tie-break
// for overlapping icons.
const markerHitTest = (markers: { sx: number, sy: number, ux: number, uy: number, vx: number, vy: number, onScreen: boolean }[], x: number, y: number): number => {
    const list = markers || [];
    let best = -1;
    let bestDist = -1;
    for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (!m || !m.onScreen) continue;
        const det = m.ux * m.vy - m.uy * m.vx;
        // Degenerate: the two axes are collinear, so the icon is edge-on and
        // draws nothing. Also keeps the division below off NaN.
        if (Math.abs(det) < 1e-6) continue;
        const dx = x - m.sx;
        const dy = y - m.sy;
        const k1 = (m.vy * dx - m.vx * dy) / det;
        const k2 = (m.ux * dy - m.uy * dx) / det;
        const d = k1 * k1 + k2 * k2;
        if (d <= 1 && (best === -1 || d < bestDist)) {
            best = i;
            bestDist = d;
        }
    }
    return best;
};

// Tooltip text for the viewer's language: exact locale, then base subtag, then
// English. Same shape as resolveLoadingMessage in viewer-companion/portals.ts.
const resolveMarkerTooltip = (defaults: Record<string, string>, lang: string): string => {
    const l = (lang || 'en').toLowerCase();
    return defaults[l] || defaults[l.split('-')[0]] || defaults.en;
};

// Viewer-side strings (not static/locales/*.json), keyed by primary language
// subtag. Same language set as DEFAULT_MESSAGES in viewer-companion/portals.ts
// and galleryLabels in viewer-companion/annotation-gallery.ts.
// TRANSLATIONS ARE MACHINE-ASSISTED AND PENDING REVIEW.
const MARKER_TOOLTIPS: Record<string, string> = {
    en: 'Portal to another scene',
    de: 'Portal zu einer anderen Szene',
    es: 'Portal a otra escena',
    fr: 'Portail vers une autre scène',
    ja: '別のシーンへのポータル',
    ko: '다른 장면으로 가는 포털',
    pt: 'Portal para outra cena',
    ru: 'Портал в другую сцену',
    zh: '通往另一个场景的传送门'
};

export {
    MARKER_SIZE,
    MARKER_TOOLTIPS,
    markerHitTest,
    markerInteractive,
    markerScale,
    markerVisible,
    portalsForScene,
    resolveMarkerTooltip,
    MarkerPortal
};
