// Poster injection for the exported viewer.
//
// The stock viewer ships a complete poster pipeline that superspl.at relies
// on for its "blurry at 0% -> sharp at 100%" load: a #poster element whose
// image is blurred by (100 - progress) while the canvas is held at opacity 0
// until the `loaded` state fires (first valid frame after the coarse-LOD
// batch is fully streamed). Locally exported viewers never activate it: the
// poster URL comes only from a `?poster=` query param, so the canvas is
// visible during the pre-reveal window where octree chunks pop in against the
// scene background (field case: large black regions in a house scan with a
// black background — diagnosed 2026-07-04, see
// docs/superpowers/specs/2026-07-04-streaming-blob-fix-design.md).
//
// injectPoster defaults that query expression to an export-provided poster:
// a real screenshot rendered at export time when available, else a solid
// SVG in the scene background color (still hides the pop-in window; the
// "unblur" of a flat color is invisible, which is exactly the point).
// `?poster=<url>` still overrides, and an EMPTY `?poster=` disables the
// poster entirely (the viewer treats '' as no poster) — upstream behavior
// preserved, with an escape hatch.
//
// Environment-agnostic (compiled for the export server via dist-shared):
// string operations only.

// The exported index.html reads the poster exclusively from the URL query.
// This exact statement is the injection anchor; if upstream changes it the
// injection soft no-ops (export stays valid, just without a default poster).
const POSTER_ANCHOR = 'const posterUrl = url.searchParams.get(\'poster\');';

// Solid single-color poster (SVG data URI) from the viewer settings'
// background color ([r,g,b] floats 0..1; defaults to black like the viewer).
const buildPosterFallbackUrl = (viewerSettingsJson: any): string => {
    const c = viewerSettingsJson?.background?.color;
    const to255 = (v: any) => Math.max(0, Math.min(255, Math.round((typeof v === 'number' ? v : 0) * 255)));
    const rgb = `rgb(${to255(c?.[0])},${to255(c?.[1])},${to255(c?.[2])})`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="${rgb}"/></svg>`;
    // encodeURIComponent leaves ( and ) alone, but the viewer embeds the URL
    // as CSS url(<raw>) without quotes — a raw ')' (from rgb(...)) terminates
    // the CSS token early and the cover silently fails. Percent-encode both.
    const encoded = encodeURIComponent(svg).split('(').join('%28').split(')').join('%29');
    return `data:image/svg+xml;utf8,${encoded}`;
};

// Mobile canvas keepalive. With a poster active the stock viewer holds the
// CANVAS at opacity 0 until `loaded` (--canvas-opacity: 0). A fully
// transparent WebGL canvas layer is optimized out of compositing on
// Android, leaving the context producing frames nothing consumes -- field
// case (Redmi Note 9S / Adreno 618, WebGL2, 2026-07-05): the GL context was
// lost seconds into the load with the poster active, loaded clean with
// `?poster=` empty, and the engine vram tracker showed only 36MB at loss
// (the pressure is browser-side, invisible to it). Forcing the canvas
// composited fixed it (user-verified) and is visually free: the DOM places
// #ui > #poster (opaque JPEG/SVG cover) above the canvas, and `loaded`
// hides the poster. The stock progressive unblur
// (style.filter = blur((100 - progress) * 0.4px)) stays ENABLED: the loss
// reproduced with the blur disabled, so it is exonerated as the crash
// cause -- if a mobile regression ever points back at it, re-add
// `#poster { filter: none !important; }` to the rule below.
//
// The override rides an author-stylesheet !important rule, which beats the
// viewer's inline style writes. The solid-color fallback poster takes the
// same path, so it applies to both poster kinds. UA gate mirrors the
// portals companion's platform split (iPadOS = Mac + multi-touch).
// Template literal: NO backslash escapes (cooked away at build time).
const POSTER_CANVAS_KEEPALIVE = `<script>
(function () {
  var ua = navigator.userAgent || '';
  var mobile = /android|iphone|ipad|ipod|windows phone|mobile/i.test(ua) ||
    ((navigator.maxTouchPoints || 0) > 1 && /mac/i.test(navigator.platform || ''));
  if (!mobile) { return; }
  var s = document.createElement('style');
  s.textContent = '#application-canvas { opacity: 1 !important; }';
  (document.head || document.documentElement).appendChild(s);
})();
</script>`;

// Default the viewer's poster to `posterUrl` (a relative file, e.g.
// './poster.jpg', or a data URI), falling back to the solid background cover
// when null/undefined. Also injects the mobile canvas keepalive (above).
// Returns the input unchanged when the anchor is absent (already injected,
// or upstream drift).
const injectPoster = (html: string, viewerSettingsJson: any, posterUrl?: string | null): string => {
    if (!html.includes(POSTER_ANCHOR)) {
        return html;
    }
    const url = posterUrl ?? buildPosterFallbackUrl(viewerSettingsJson);
    const withDefault = html.replace(
        POSTER_ANCHOR,
        `const posterUrl = url.searchParams.get('poster') ?? ${JSON.stringify(url)};`
    );
    return withDefault.includes('</body>') ?
        withDefault.replace('</body>', `${POSTER_CANVAS_KEEPALIVE}</body>`) :
        withDefault + POSTER_CANVAS_KEEPALIVE;
};

export { buildPosterFallbackUrl, injectPoster };
