import { describe, it, expect } from 'vitest';

import { patchViewerBootstrap } from '../src/viewer-companion/viewer-bootstrap';

// The seam as splat-transform renders it: `renderViewerHtml` replaces the whole
// block's contents with the embedder's json (writeHtml unbundled passes just
// `{ contentUrl }`), and ships `null` when no embedder supplied anything.
const withBootstrap = (inner: string) => {
    return `<html><head><script type="application/json" id="sse-bootstrap">${inner}</script>` +
        '<script type="module">const bootstrap = JSON.parse(document.getElementById(\'sse-bootstrap\').textContent) ?? {};</script>' +
        '</head><body></body></html>';
};

// What the viewer itself does with the block.
const readBootstrap = (html: string) => {
    const open = '<script type="application/json" id="sse-bootstrap">';
    const start = html.indexOf(open) + open.length;
    const raw = html.slice(start, html.indexOf('</script>', start));
    // undo the block-safety escaping the viewer's JSON.parse handles natively
    return JSON.parse(raw);
};

describe('patchViewerBootstrap', () => {
    it('merges into an existing bootstrap object, keeping what writeHtml put there', () => {
        const out = patchViewerBootstrap(withBootstrap('{"contentUrl":"index.sog"}'), { posterUrl: './poster.jpg' });
        expect(readBootstrap(out)).toEqual({ contentUrl: 'index.sog', posterUrl: './poster.jpg' });
    });

    it('the patch wins over a key already present (last-one-wins on parse)', () => {
        const out = patchViewerBootstrap(withBootstrap('{"contentUrl":"index.sog"}'), { contentUrl: './lod-meta.json' });
        expect(readBootstrap(out).contentUrl).toBe('./lod-meta.json');
    });

    it('handles the standalone document, whose block is literal null', () => {
        const out = patchViewerBootstrap(withBootstrap('\n            null\n        '), { posterUrl: './p.jpg' });
        expect(readBootstrap(out)).toEqual({ posterUrl: './p.jpg' });
    });

    it('handles an empty object block', () => {
        const out = patchViewerBootstrap(withBootstrap('{}'), { collisionUrl: './index.voxel.json' });
        expect(readBootstrap(out)).toEqual({ collisionUrl: './index.voxel.json' });
    });

    it('writes several keys at once', () => {
        const out = patchViewerBootstrap(withBootstrap('{}'), { contentUrl: './lod-meta.json', posterUrl: './p.jpg' });
        expect(readBootstrap(out)).toEqual({ contentUrl: './lod-meta.json', posterUrl: './p.jpg' });
    });

    // The block is script-content: a raw `</script` would end it early and a raw
    // `<!--` flips the tokenizer into the double-escaped state, where the block's
    // own close tag is consumed as text and the rest of the page is swallowed.
    // Values here are export-baked and can carry user-authored text.
    it('escapes every `<` so the value cannot break out of the script block', () => {
        const nasty = './p.jpg?t=</script><!--<script>';
        const out = patchViewerBootstrap(withBootstrap('{}'), { posterUrl: nasty });
        const open = '<script type="application/json" id="sse-bootstrap">';
        const start = out.indexOf(open) + open.length;
        const raw = out.slice(start, out.indexOf('</script>', start));
        expect(raw).not.toContain('<');
        expect(raw).toContain('\\u003c');
        // and it still round-trips byte-exact
        expect(readBootstrap(out).posterUrl).toBe(nasty);
    });

    it('escapes U+2028/U+2029, legal in json but line terminators to some parsers', () => {
        const value = `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`;
        const out = patchViewerBootstrap(withBootstrap('{}'), { posterUrl: value });
        const open = '<script type="application/json" id="sse-bootstrap">';
        const start = out.indexOf(open) + open.length;
        const raw = out.slice(start, out.indexOf('</script>', start));
        expect(raw).toContain('\\u2028');
        expect(raw).toContain('\\u2029');
        expect(readBootstrap(out).posterUrl).toBe(value);
    });

    it('returns null when the seam is absent, so callers choose hard or soft failure', () => {
        expect(patchViewerBootstrap('<html><body></body></html>', { posterUrl: './p.jpg' })).toBeNull();
    });

    it('returns null on an unexpected block shape rather than emitting broken json', () => {
        expect(patchViewerBootstrap(withBootstrap('[1,2,3]'), { posterUrl: './p.jpg' })).toBeNull();
    });
});
