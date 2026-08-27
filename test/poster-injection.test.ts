import { describe, it, expect } from 'vitest';

import { buildPosterFallbackUrl, injectPoster } from '../src/viewer-companion/poster';

// Minimal stand-in for the exported viewer HTML. The viewer reads its poster
// from the URL query first and the bootstrap block second (upstream default:
// no poster at all), and writeHtml already puts a contentUrl in that block.
// injectPoster adds an export-provided default there so every streaming export
// covers the canvas until `loaded` -- the pre-reveal chunk pop-in phase is
// never visible. test/viewer-html-anchors.test.ts pins the seam's real shape
// against the installed splat-transform; this file pins the behaviour.
const BOOTSTRAP_OPEN = '<script type="application/json" id="sse-bootstrap">';
const HTML = `<html><head>${BOOTSTRAP_OPEN}{"contentUrl":"index.sog"}</script>
        <script type="module">
            const url = new URL(location.href);
            const bootstrap = JSON.parse(document.getElementById('sse-bootstrap').textContent) ?? {};
            const posterUrl = url.searchParams.get('poster') ?? bootstrap.posterUrl ?? null;
        </script></head><body><div id="poster"></div></body></html>`;

// what the viewer's own JSON.parse of the block yields
const bootstrapOf = (html: string) => {
    const start = html.indexOf(BOOTSTRAP_OPEN) + BOOTSTRAP_OPEN.length;
    return JSON.parse(html.slice(start, html.indexOf('</script>', start)));
};

describe('injectPoster', () => {
    it('defaults posterUrl to the provided poster while ?poster= still wins', () => {
        const out = injectPoster(HTML, { background: { color: [0, 0, 0] } }, './poster.jpg');
        expect(bootstrapOf(out).posterUrl).toBe('./poster.jpg');
        // the query param is still read first, and writeHtml's own key survives
        expect(out).toContain("url.searchParams.get('poster') ?? bootstrap.posterUrl");
        expect(bootstrapOf(out).contentUrl).toBe('index.sog');
    });

    // the viewer embeds the URL as unquoted CSS url(...): parens must be
    // percent-encoded or the CSS token ends at rgb(...)'s ')'
    const cssSafe = (s: string) => encodeURIComponent(s).split('(').join('%28').split(')').join('%29');

    it('falls back to a solid background-color poster when no poster is provided', () => {
        const out = injectPoster(HTML, { background: { color: [1, 0.5, 0] } }, null);
        expect(out).toContain('data:image/svg+xml');
        // 1 -> 255, 0.5 -> 128, 0 -> 0
        expect(out).toContain(cssSafe('rgb(255,128,0)'));
        expect(out).not.toContain('rgb(');   // no raw CSS-breaking parens
    });

    it('solid fallback defaults to black when settings carry no background', () => {
        expect(buildPosterFallbackUrl(undefined)).toContain(cssSafe('rgb(0,0,0)'));
        expect(buildPosterFallbackUrl({})).toContain(cssSafe('rgb(0,0,0)'));
    });

    it('a second pass replaces the poster rather than layering a stale one', () => {
        const once = injectPoster(HTML, {}, './poster.jpg');
        const twice = injectPoster(once, {}, './other.jpg');
        expect(bootstrapOf(twice).posterUrl).toBe('./other.jpg');
    });

    it('returns HTML without the bootstrap seam unchanged (soft no-op on upstream drift)', () => {
        const html = '<html><body>no seam here</body></html>';
        expect(injectPoster(html, {}, './poster.jpg')).toBe(html);
    });

    it('escapes the poster URL safely (data URIs with quotes/slashes survive)', () => {
        const dataUri = 'data:image/jpeg;base64,AAAA////====';
        expect(bootstrapOf(injectPoster(HTML, {}, dataUri)).posterUrl).toBe(dataUri);
    });

    // With a poster the viewer holds the canvas at opacity 0 for the whole
    // load; on Android the optimized-out WebGL canvas layer killed the GL
    // context (field case: Redmi/Adreno WebGL2, context lost seconds into
    // the load, fine with ?poster= empty). A mobile-gated !important rule
    // keeps the canvas composited under the opaque poster. The stock
    // progressive blur stays enabled: it was exonerated as the crash cause
    // (the loss reproduced with the blur disabled).
    describe('mobile canvas keepalive', () => {
        it('keeps the canvas composited on mobile (opacity 1 under the opaque poster)', () => {
            const out = injectPoster(HTML, {}, './poster.jpg');
            expect(out).toContain('#application-canvas { opacity: 1 !important; }');
            expect(out).toContain('android|iphone');
            // classic script before </body>: runs ahead of the deferred viewer module
            expect(out.indexOf('opacity: 1 !important')).toBeLessThan(out.indexOf('</body>'));
        });

        it('leaves the stock progressive poster unblur alone', () => {
            const out = injectPoster(HTML, {}, './poster.jpg');
            expect(out).not.toContain('filter: none');
        });

        // blur(40px) at 0% progress fades the poster's outer ~40px to
        // semi-transparent; with the canvas forced composited (opacity 1)
        // the live render bled through at the viewport borders (field case:
        // canvas edges visible behind the blurred poster on mobile).
        // Oversizing the poster pushes the fringe outside the viewport.
        it('oversizes the poster so the blur fringe falls outside the viewport', () => {
            const out = injectPoster(HTML, {}, './poster.jpg');
            expect(out).toContain('top: -80px !important');
            expect(out).toContain('left: -80px !important');
            expect(out).toContain('calc(100% + 160px)');
        });

        it('applies to the solid fallback too', () => {
            const out = injectPoster(HTML, { background: { color: [0, 0, 0] } }, null);
            expect(out).toContain('#application-canvas { opacity: 1 !important; }');
        });

        it('does not inject anything when the anchor is absent (soft no-op)', () => {
            const html = '<html><body>no anchor here</body></html>';
            expect(injectPoster(html, {}, './poster.jpg')).toBe(html);
        });
    });
});
