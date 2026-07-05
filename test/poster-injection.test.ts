import { describe, it, expect } from 'vitest';

import { buildPosterFallbackUrl, injectPoster } from '../src/viewer-companion/poster';

// Minimal stand-in for the exported viewer HTML: the inline module reads the
// poster from the URL query only (upstream default: no poster unless ?poster=
// is given). injectPoster defaults that expression to an export-provided
// poster so every streaming export covers the canvas until `loaded` — the
// pre-reveal chunk pop-in phase is never visible.
const ANCHOR = 'const posterUrl = url.searchParams.get(\'poster\');';
const HTML = `<html><head><script type="module">
            const url = new URL(location.href);
            ${ANCHOR}
        </script></head><body><div id="poster"></div></body></html>`;

describe('injectPoster', () => {
    it('defaults posterUrl to the provided poster while ?poster= still wins', () => {
        const out = injectPoster(HTML, { background: { color: [0, 0, 0] } }, './poster.jpg');
        expect(out).toContain('const posterUrl = url.searchParams.get(\'poster\') ?? "./poster.jpg";');
        expect(out).not.toContain(ANCHOR);
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

    it('is idempotent (second pass finds no anchor and returns input unchanged)', () => {
        const once = injectPoster(HTML, {}, './poster.jpg');
        const twice = injectPoster(once, {}, './other.jpg');
        expect(twice).toBe(once);
    });

    it('returns HTML without the anchor unchanged (soft no-op on upstream drift)', () => {
        const html = '<html><body>no anchor here</body></html>';
        expect(injectPoster(html, {}, './poster.jpg')).toBe(html);
    });

    it('escapes the poster URL safely (data URIs with quotes/newlines survive)', () => {
        const dataUri = 'data:image/jpeg;base64,AAAA////====';
        const out = injectPoster(HTML, {}, dataUri);
        expect(out).toContain(`?? ${JSON.stringify(dataUri)};`);
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
