import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';

import { describe, it, expect } from 'vitest';

import { BRAND_HTML_ANCHORS, BRAND_JS_ANCHORS, injectBrand, injectBrandJs } from '../src/viewer-companion/brand';
import { brandFragments, resolveBrandView } from '../src/viewer-companion/brand-rules';
import { runBrandRuntime } from './brand-runtime-stub';
import { renderUiHtml } from './ui-html';
import { VIEWER_LOCALES } from '../src/viewer-companion/viewer-lang';
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

const htmlSource = extractLiteralAround('id=\\"sse-bootstrap\\"');
const jsSource = extractLiteralAround('export { createViewer };');

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe(`exported viewer anchors (@playcanvas/splat-transform ${version})`, () => {
    it('extracted the two documents the fork injects into', () => {
        expect(htmlSource).toContain('<html');
        expect(jsSource).toContain('export { createViewer };');
    });

    // viewer-bootstrap.ts / poster.ts / streaming repoint
    it('renders exactly one sse-bootstrap json block', () => {
        expect(occurrences(htmlSource, '<script type="application/json" id="sse-bootstrap">')).toBe(1);
        expect(htmlSource).toContain("JSON.parse(document.getElementById('sse-bootstrap').textContent)");
    });

    it('reads posterUrl, contentUrl and collisionUrl from that block', () => {
        expect(htmlSource).toContain("url.searchParams.get('poster') ?? bootstrap.posterUrl");
        expect(htmlSource).toContain("url.searchParams.get('content') ?? bootstrap.contentUrl");
        expect(htmlSource).toContain('bootstrap.collisionUrl');
    });

    it('ignores a bootstrap contentFilename when ?content= overrides the url', () => {
        expect(htmlSource).toContain("url.searchParams.has('content') ? null : (bootstrap.contentFilename ?? null)");
    });

    it('keeps the collision url query chain repointCollisionUrl extends', () => {
        expect(occurrences(htmlSource, "url.searchParams.get('collision') ?? url.searchParams.get('voxel')")).toBe(1);
    });

    // portal-markers.ts reads window.sse.options.ui; loading-bar/iframe-api read ?noui
    it('publishes window.sse.options with ui driven by ?noui', () => {
        expect(htmlSource).toContain('window.sse = {');
        expect(htmlSource).toContain('options: sseOptions,');
        expect(htmlSource).toContain("ui: !url.searchParams.has('noui')");
    });

    it('closes its head and body tags once', () => {
        expect(occurrences(htmlSource, '</head>')).toBe(1);
        expect(occurrences(htmlSource, '</body>')).toBe(1);
    });

    // viewer-engine-patch.ts -- all nine patches, including the required handle publish
    it('matches every engine patch, publishes the handle, and re-applying is a no-op', () => {
        const once = patchViewerEngine(jsSource);
        expect(once.patched).toBe(VIEWER_ENGINE_PATCH_COUNT);
        expect(once.handlePublished).toBe(true);
        expect(patchViewerEngine(once.source).patched).toBe(0);
    });

    // The __ssOnViewer hook must run before initUI copies annotation title/text
    // (annotation-i18n.ts). Pin that createViewer constructs the Viewer and then
    // reaches initUI with no await in between.
    it('builds the UI synchronously after constructing the Viewer', () => {
        const at = jsSource.indexOf('const viewer = new Viewer(global, gsplatLoad, skyboxLoad, collisionLoad);');
        const ui = jsSource.indexOf('initUI(global, handle', at);
        expect(at).toBeGreaterThan(-1);
        expect(ui).toBeGreaterThan(at);
        expect(jsSource.slice(at, ui)).not.toContain('await');
    });

    // Runtime fields and methods the companions read on the internal Viewer.
    it('keeps the internal Viewer surface the companions use', () => {
        expect(jsSource).toContain('this.global = global;');
        expect(jsSource).toContain('this.cameraManager = new CameraManager(global, sceneBound);');
        expect(jsSource).toContain('this.inputController.collision = collision;');
        expect(jsSource).toContain('this.voxelOverlay = new VoxelDebugOverlay(app, collision, camera);');
        expect(jsSource).toContain('selectAnnotation(index) {');
        expect(jsSource).toContain('state.selectedAnnotation = index;');
        expect(jsSource).toContain('selectAnnotation: (index) => viewer.selectAnnotation(index)');
        expect(jsSource).toContain("script.on('select', () => viewer.selectAnnotation(i));");
    });

    // VoxelCollision private fields portals.ts's snapshot()/applyVoxel() read
    // and write directly (a scene-swap collision snapshot/restore, bypassing
    // the class's public getters, which are read-only). A rename here breaks
    // that companion silently -- pin every field's constructor assignment.
    it('keeps the VoxelCollision private fields portals.ts snapshots and restores', () => {
        for (const field of ['_gridMinX', '_gridMinY', '_gridMinZ', '_numVoxelsX', '_numVoxelsY', '_numVoxelsZ', '_voxelResolution', '_leafSize', '_treeDepth', '_nodes', '_leafData']) {
            expect(jsSource, field).toContain(`this.${field} = `);
        }
    });

    // iframe-api.ts's readiness gate (isLoaded/isNoUi, ~lines 211-222) reads
    // global.state.loaded and global.config.ui === false directly, rather than
    // through a method, so pin the two fields it depends on at their source:
    // the load gate the bridge mirrors, and how config.ui is resolved from the
    // caller's options and then gates whether the built-in UI is even built.
    it('keeps the loaded/config.ui fields the iframe-api readiness gate reads', () => {
        expect(jsSource).toContain('if (!this.global.state.loaded) {');
        expect(jsSource).toContain('state.loaded = true;');
        expect(jsSource).toContain('ui: options.ui ?? true,');
        expect(jsSource).toContain([
            'const disposeUI = config.ui',
            '        ? initUI(global, handle, () => viewer.picker, () => viewer.cameraManager?.transitionProgress() ?? 1)',
            '        : null;'
        ].join('\n'));
    });

    // portals.ts restores the start scene's LOD floor after every event the
    // viewer re-runs applyPerfSettings on, because that reopens lodRangeMin.
    // A new trigger here wipes the floor with nothing putting it back.
    it('re-runs applyPerfSettings only on the events portals.ts re-clamps after', () => {
        expect(jsSource).toContain('gsplatComponent.lodRangeMin = 0;');
        const triggers = [...jsSource.matchAll(/events\.on\('([^']+)', applyPerfSettings\)/g)].map(m => m[1]);
        expect(triggers.sort()).toEqual(['performanceMode:changed', 'xrMode:changed']);
    });

    // portals.ts switches the XR grab off by disabling the script on the
    // camera rig (global.camera's parent) when a session starts. That only
    // works while the grab is a Script created there, by that name, before XR
    // can start, and acting in update() -- which a disabled script never runs.
    it('keeps the XR grab script portals.ts disables', () => {
        expect(jsSource).toContain("static scriptName = 'xrManipulation';");
        expect(jsSource).toContain('const { app, events, state, camera, renderer, root } = global;');
        expect(jsSource).toContain('const parent = camera.parent;');
        expect(jsSource).toContain('manipulation = parent.script.create(XrManipulation, {');
        expect(jsSource).toContain('this.xr.setManipulationTarget(results[0]);');
        expect(jsSource).toContain('this._startGrab(target, left, right);');
    });

    // annotation-links.ts injects its chip when the shared tooltip is SHOWN
    // (class sse-visible), not on selection: since 1.37 a selection only hides
    // the tooltip and revealTooltip rewrites it once the camera lands. It
    // looks the tooltip up once, so it must exist when the handle is published.
    it('keeps the tooltip reveal the annotation chip waits for', () => {
        expect(jsSource).toContain("this.tooltipDom.className = 'sse-annotation';");
        expect(jsSource).toContain('const annotations = new Annotations(viewer, root, global.camera, getPicker, getCameraProgress);');
        expect(jsSource).toContain('revealTooltip() {');
        expect(jsSource).toContain("ctx.tooltipDom.classList.remove('sse-visible');");
        expect(jsSource).toContain("tooltip.classList.add('sse-visible');");
    });

    it('keeps the events the companions listen to', () => {
        for (const name of ['selectedAnnotation:changed', 'progress:changed', 'loaded:changed', 'firstFrame', 'collisionOverlayEnabled:changed', 'cameraMode:changed', 'gamingControls:changed', 'performanceMode:changed', 'inputEvent']) {
            expect(jsSource, name).toContain(`'${name}'`);
        }
        expect(jsSource).toContain("'frame:ready'");
    });

    // DOM classes the companions query or style (all live in uiHtml now)
    it('keeps the sse- classes the companions touch', () => {
        for (const cls of ['sse-annotation', 'sse-annotation-title', 'sse-annotation-text', 'sse-performanceModeRow', 'sse-settingsGroup', 'sse-settingsRow', 'sse-loadingWrap', 'sse-loadingBar', 'sse-loadingText', 'sse-poster', 'sse-viewerBranding', 'sse-viewerTitle', 'sse-title-name', 'sse-infoGpu']) {
            expect(jsSource, cls).toContain(cls);
        }
        expect(jsSource).toContain("root.className = 'sse-viewer';");
        expect(jsSource).toContain("root.style.setProperty('--canvas-opacity', '0');");
    });

    // annotation-i18n.ts relies on the viewer copying title/text out of settings
    it('copies annotation title and text from the settings when building the UI', () => {
        expect(jsSource).toContain('script.title = ann.title;');
        expect(jsSource).toContain('script.text = ann.text;');
    });

    // viewer-lang.ts reproduces the viewer's locale rule over the same nine keys
    it('ships dictionaries for exactly the locales viewer-lang resolves against', () => {
        const start = jsSource.indexOf('const dictionaries = {');
        const block = jsSource.slice(start, jsSource.indexOf('};', start));
        // keys appear as `de: deJson,`, `'pt-BR': ptBRJson,` or shorthand `en,`
        const hasKey = (code: string) => block.includes(`    ${code}:`) || block.includes(`    '${code}':`) || block.includes(`    ${code},`) || block.includes(`    ${code}\n`);
        for (const code of VIEWER_LOCALES) {
            expect(hasKey(code), code).toBe(true);
        }
    });

    it('keeps every brand surface the override rewrites', () => {
        for (const anchor of BRAND_HTML_ANCHORS) {
            expect(occurrences(htmlSource, anchor), anchor).toBe(1);
        }
        for (const anchor of BRAND_JS_ANCHORS) {
            expect(occurrences(jsSource, anchor), anchor).toBe(1);
        }
        expect(htmlSource, 'the brand runtime updates the first icon link; the stock page must have none').not.toContain('rel="icon"');
    });

    it('renders the stock uiHtml through the test helper', () => {
        expect(renderUiHtml(jsSource)).toContain('<span>SuperSplat</span>');
    });

    it('never writes document.title (the brand runtime script owns it)', () => {
        expect(jsSource).not.toContain('document.title');
    });

    it('renders the exact stock uiHtml when the brand runtime left no fragments', () => {
        expect(renderUiHtml(injectBrandJs(jsSource))).toBe(renderUiHtml(jsSource));
    });

    it('leaves one deliberate SuperSplat mention in the UI under an operator brand', () => {
        const view = resolveBrandView({ name: 'Acme', iconHref: './brand-icon.png', iconMime: 'image/png', url: 'https://acme.example/' }, {})!;
        const ui = renderUiHtml(injectBrandJs(jsSource), brandFragments(view));
        expect(ui).toContain('<a class="sse-viewerBranding sse-hidden" title="Acme" target="_blank" rel="noopener noreferrer">');
        expect(ui).toContain('<img id="brandBadgeIcon" src="./brand-icon.png" alt="" />');
        expect(ui).toContain('<a class="sse-viewerTitle" href="https://acme.example/" target="_blank" rel="noopener noreferrer">');
        expect(ui).toContain('<img id="brandTitleIcon" src="./brand-icon.png" alt="" />');
        expect(ui).toContain('<span class="sse-title-name">Acme</span>');
        expect(ui).toContain('PlayCanvas SuperSplat Viewer</a>');
        expect(ui).not.toContain('github.com/playcanvas/supersplat-viewer');
        // Only the attribution line still says SuperSplat inside the UI markup.
        // (The <symbol id="supersplatIcon"> id is an identifier, not branding.)
        expect(occurrences(ui.split('id="supersplatIcon"').join(''), 'SuperSplat')).toBe(1);
    });

    it('renders both brand elements as non-links in client mode', () => {
        const view = resolveBrandView(
            { name: 'Acme', url: 'https://acme.example/' },
            { name: 'Client Co', iconUrl: 'https://cdn.example/client/icon.png', logoUrl: 'https://cdn.example/client/logo.png' }
        )!;
        const ui = renderUiHtml(injectBrandJs(jsSource), brandFragments(view));
        expect(ui).toContain('<div class="sse-viewerBranding sse-hidden" title="Client Co">');
        expect(ui).toContain('<div class="sse-viewerTitle">');
        expect(ui).toContain('<img id="brandTitleLogo" src="https://cdn.example/client/logo.png" alt="Client Co" />');
        expect(ui).toContain('Powered by <a href="https://acme.example/" target="_blank" rel="noopener noreferrer">Acme</a>');
        expect(ui).not.toContain('github.com/playcanvas/supersplat-viewer');
    });

    it('brands the real page and resolves it at runtime into the real uiHtml', () => {
        const operator = { name: 'Acme', iconHref: './brand-icon.png', iconMime: 'image/png', url: 'https://acme.example/' };
        const page = injectBrand(htmlSource, { operator, client: { name: 'Client Co', iconUrl: 'https://cdn.example/client/icon.png' } });
        expect(page).toContain('<title>Client Co</title>');
        const r = runBrandRuntime(page);
        expect(r.title).toBe('Client Co');
        expect(r.favicon).toEqual({ rel: 'icon', href: 'https://cdn.example/client/icon.png' });
        const ui = renderUiHtml(injectBrandJs(jsSource), r.ui);
        expect(ui).toContain('<div class="sse-viewerBranding sse-hidden" title="Client Co">');
        expect(ui).toContain('<span class="sse-title-name">Client Co</span>');
    });
});
