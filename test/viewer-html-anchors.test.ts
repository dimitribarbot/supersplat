import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';

import { describe, it, expect } from 'vitest';

import { patchViewerEngine, VIEWER_ENGINE_PATCH_COUNT } from '../src/viewer-engine-patch';

// Drift guard against the REAL baked viewer, not a fixture.
//
// Every other injection test in this suite feeds the injectors a synthetic
// snippet, so it verifies the injector and says nothing about whether the
// anchor still exists in the viewer splat-transform actually ships. That gap is
// not theoretical: the 3.1.7 -> 3.3.3 bump rewrote the viewer's inline module
// (asset urls moved into a json bootstrap block), which SILENTLY turned
// injectPoster into a no-op -- every export would have lost its default poster
// and its Android canvas keepalive, with the whole suite green.
//
// So assert here, against the installed package, that everything the fork
// reaches into the exported document for is still there. A failure means an
// upstream bump moved a seam: fix the injector, do not relax the assertion.

const require = createRequire(import.meta.url);
// the package exports no './package.json' subpath, so locate dist/ from the
// resolved entry point instead of from the manifest
const distDir = dirname(require.resolve('@playcanvas/splat-transform'));
const bundle = readFileSync(join(distDir, 'index.mjs'), 'utf8');
const version = JSON.parse(readFileSync(join(distDir, '..', 'package.json'), 'utf8')).version as string;

const BACKSLASH = String.fromCharCode(92);

// The viewer's html, css and js are stored in dist/index.mjs as escaped
// double-quoted string literals, so searching the bundle text for a fragment
// containing a quote finds nothing even when the fragment is present -- and a
// fragment that IS found may have been matched inside splat-transform's own
// code rather than inside the shipped document. Both are avoided by pulling
// the literal back out and asserting against the decoded document.
const extractLiteralAround = (marker: string): string => {
    const at = bundle.indexOf(marker);
    expect(at, `marker not found in the bundle: ${marker}`).toBeGreaterThan(-1);

    const isEscaped = (i: number) => {
        let n = 0;
        let p = i - 1;
        while (p >= 0 && bundle[p] === BACKSLASH) {
            n++;
            p--;
        }
        return n % 2 === 1;
    };
    const seek = (step: number) => {
        for (let i = at; i >= 0 && i < bundle.length; i += step) {
            if (bundle[i] === '"' && !isEscaped(i)) {
                return i;
            }
        }
        return -1;
    };

    const start = seek(-1);
    const end = seek(1);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    // Every escape a double-quoted js string literal uses here is valid json
    // too, so JSON.parse decodes it exactly. Deliberately not eval: nothing
    // from the bundle is executed to run this check.
    return JSON.parse(bundle.slice(start, end + 1)) as string;
};

// The first `sse-bootstrap` in the bundle is the shipped document's own block;
// the second is renderViewerHtml's replacement template.
const htmlSource = extractLiteralAround('id=\\"sse-bootstrap\\"');
const jsSource = extractLiteralAround('export { main };');

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe(`exported viewer anchors (@playcanvas/splat-transform ${version})`, () => {
    it('extracted the two documents the fork injects into', () => {
        expect(htmlSource).toContain('<html');
        expect(jsSource).toContain('export { main };');
    });

    // src/viewer-companion/viewer-bootstrap.ts -- the seam the poster default,
    // the streaming content url and any future export-time default go through.
    it('renders exactly one sse-bootstrap json block', () => {
        expect(occurrences(htmlSource, '<script type="application/json" id="sse-bootstrap">')).toBe(1);
        expect(htmlSource).toContain("JSON.parse(document.getElementById('sse-bootstrap').textContent)");
    });

    it('reads posterUrl, contentUrl and collisionUrl from that block', () => {
        expect(htmlSource).toContain("url.searchParams.get('poster') ?? bootstrap.posterUrl");
        expect(htmlSource).toContain("url.searchParams.get('content') ?? bootstrap.contentUrl");
        expect(htmlSource).toContain('bootstrap.collisionUrl');
    });

    // The streaming export leaves contentFilename unset on purpose, so that a
    // `?content=` override drives the parser as well as the fetch (the viewer
    // picks the parser off the url's basename). Guard that it still works that
    // way -- a bootstrap.contentFilename that survived an override would pin
    // every override to the sog parser.
    it('ignores a bootstrap contentFilename when ?content= overrides the url', () => {
        expect(htmlSource).toContain("url.searchParams.has('content') ? null : (bootstrap.contentFilename ?? null)");
    });

    // src/splat-export-core.ts repointCollisionUrl -- appends the bundled voxel
    // file as a further fallback on this exact expression.
    it('keeps the collision url query chain repointCollisionUrl extends', () => {
        expect(occurrences(htmlSource, "url.searchParams.get('collision') ?? url.searchParams.get('voxel')")).toBe(1);
    });

    // src/splat-export-core.ts injectDeviceFallback -- soft-replaces this line
    // to publish window.__supersplatViewer, which every companion polls for.
    it('keeps the viewer-handle line the companions are published from', () => {
        expect(occurrences(htmlSource, 'const viewer = await main(canvas, settingsJson, config);')).toBe(1);
    });

    // src/splat-export-core.ts insertBeforeBodyClose -- every companion lands here.
    it('closes its body tag', () => {
        expect(occurrences(htmlSource, '</body>')).toBe(1);
    });

    // src/viewer-engine-patch.ts -- the 8 fork patches, applied to the baked
    // index.js of every export. The sibling viewer-engine-patch.test.ts pins
    // their behaviour on snippets; this pins that they still MATCH.
    it('matches every engine patch, and re-applying them is a no-op', () => {
        const once = patchViewerEngine(jsSource);
        expect(once.patched).toBe(VIEWER_ENGINE_PATCH_COUNT);
        expect(patchViewerEngine(once.source).patched).toBe(0);
    });
});
