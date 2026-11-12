// Keeps a companion's page-level overlays drawn in fullscreen.
//
// The exported viewer's fullscreen button fullscreens its own root
// (.sse-viewer), and a fullscreen page draws only that element's subtree: an
// overlay mounted on document.body is not drawn at all, whatever its z-index.
// The overlays mount at script load, before the viewer root exists, so rather
// than mounting into the root they follow the fullscreen element: moved into it
// on entry (appended after the viewer's own ui, so their z-index still puts
// them on top) and back to body on exit. Outside fullscreen nothing changes.
//
// `elements` is read on every change, so overlays created later are covered;
// one that is not mounted yet (no parent) is left alone. Call the returned
// function after mounting an overlay while fullscreen may already be on.
//
// Injected into the companions via Function.toString(): self-contained, and no
// backslash escapes (the companion templates eat them).
const followFullscreen = (doc: Document, elements: () => HTMLElement[]): (() => void) => {
    const place = () => {
        const target = doc.fullscreenElement || doc.body;
        if (!target) return;
        elements().forEach((el) => {
            if (el && el.parentNode && el.parentNode !== target) target.appendChild(el);
        });
    };
    doc.addEventListener('fullscreenchange', place);
    return place;
};

export { followFullscreen };
