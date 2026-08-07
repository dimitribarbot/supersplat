# Portal Viewer Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw a clickable, billboarded icon at every portal centre in the exported ZIP viewer, hidden behind splats, with a localized "portal to another scene" tooltip, visible in walk/fly while moving.

**Architecture:** An export-time patch publishes the exported viewer's module-scope engine classes on `window.__ssPc`. A new companion runtime, spliced into the existing portals companion's IIFE, uses them to build one camera-facing quad per portal in a layer inserted *before* the splats — so splats paint over an occluded icon — plus an invisible DOM hit-target and our own tooltip. All decision logic lives in a pure, unit-tested module that is stringified into the runtime.

**Tech Stack:** TypeScript, Rollup, Vitest, PlayCanvas 2.21 (via `@playcanvas/splat-transform` 3.1.7's baked viewer bundle).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-06-portal-viewer-icon-design.md`. Read it before starting.
- **Scope is the ZIP package export only.** Portals cannot exist in a single-file HTML export.
- `MARKER_SIZE = 48` (screen px). Hit-target is `MARKER_SIZE + 8` = 56px. Texture is 256×256.
- Idle emissive `Color(0.85, 0.85, 0.85)`; hover emissive `Color(1.0, 0.4, 0.0)`. Both `.gamma()`-corrected when `viewer.cameraFrame != null`.
- **No backslashes anywhere in `src/viewer-companion/*.ts` template-literal runtime bodies.** Build-time template-literal cooking eats them: `\d` becomes `d`, `\n` becomes `n`. No regex character-class escapes, no `\n` in strings. Unicode written literally. (Regexes *without* backslashes are fine — `portals.ts` already ships one.)
- **No backticks in comments inside those runtime bodies** — the body is itself a template literal.
- Do not reformat or re-order imports in any file you touch. ESLint 10 crashes on `import/order` autofix in this repo.
- Run `npm run lint` and `npm run test` from the repo root. Run tests **in the foreground with output redirected to a file** — Vitest hangs in this environment when backgrounded or piped.
- Never delete `package-lock.json`.
- Do not modify upstream-owned files (`rollup.config.mjs`, `src/render.ts`).
- `npm run build` exits 0 even with TypeScript errors. Gate on `grep -c "plugin typescript"` being `0`, never on the exit code.

---

### Task 1: Pure marker decision module

The four decisions the runtime needs — which portals to show, how big to draw them, when to suppress them, what the tooltip says — as a playcanvas-free module. It is unit-tested here and later stringified verbatim into the companion runtime via `Function.prototype.toString()`, exactly like `portal-geom` / `portal-crossing` / `portal-transition` already are.

**Files:**
- Create: `src/portal-marker.ts`
- Test: `test/portal-marker.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `MARKER_SIZE: number` (48)
  - `portalsForScene(portals: {front: number|null, back: number|null}[], active: number): number[]`
  - `markerScale(size: number, canvasHeight: number, projData5: number, viewDepth: number): number`
  - `markerVisible(s: {noui: boolean, cameraMode: string, transitionActive: boolean}): boolean`
  - `resolveMarkerTooltip(defaults: Record<string, string>, lang: string): string`
  - `MARKER_TOOLTIPS: Record<string, string>`

- [ ] **Step 1: Write the failing test**

Create `test/portal-marker.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import {
    MARKER_SIZE,
    MARKER_TOOLTIPS,
    markerScale,
    markerVisible,
    portalsForScene,
    resolveMarkerTooltip
} from '../src/portal-marker';

describe('portalsForScene', () => {
    const portals = [
        { front: 0, back: 1 },
        { front: 1, back: 2 },
        { front: 3, back: null }
    ];

    it('matches a portal on its front side', () => {
        expect(portalsForScene(portals, 0)).toEqual([0]);
    });

    it('matches a portal on its back side', () => {
        expect(portalsForScene(portals, 2)).toEqual([1]);
    });

    it('returns every portal touching the scene', () => {
        expect(portalsForScene(portals, 1)).toEqual([0, 1]);
    });

    it('ignores a null side rather than matching it', () => {
        expect(portalsForScene(portals, null as any)).toEqual([]);
    });

    it('returns nothing for a scene no portal touches', () => {
        expect(portalsForScene(portals, 9)).toEqual([]);
    });

    it('tolerates an empty or missing list', () => {
        expect(portalsForScene([], 0)).toEqual([]);
        expect(portalsForScene(null as any, 0)).toEqual([]);
    });
});

describe('markerScale', () => {
    it('reproduces the viewer hotspot formula', () => {
        // (48 / 1000) * (2 * 10 / 2) = 0.48
        expect(markerScale(48, 1000, 2, 10)).toBeCloseTo(0.48, 10);
    });

    it('grows linearly with view depth so screen size stays constant', () => {
        expect(markerScale(48, 1000, 2, 20)).toBeCloseTo(markerScale(48, 1000, 2, 10) * 2, 10);
    });

    it('shrinks as the canvas gets taller', () => {
        expect(markerScale(48, 2000, 2, 10)).toBeCloseTo(markerScale(48, 1000, 2, 10) / 2, 10);
    });

    it('returns 0 for a degenerate canvas or projection', () => {
        expect(markerScale(48, 0, 2, 10)).toBe(0);
        expect(markerScale(48, 1000, 0, 10)).toBe(0);
    });
});

describe('markerVisible', () => {
    const base = { noui: false, cameraMode: 'orbit', transitionActive: false };

    it('is visible in the default state', () => {
        expect(markerVisible(base)).toBe(true);
    });

    it('stays visible in walk and fly, unlike annotations', () => {
        expect(markerVisible({ ...base, cameraMode: 'walk' })).toBe(true);
        expect(markerVisible({ ...base, cameraMode: 'fly' })).toBe(true);
    });

    it('is hidden under noui', () => {
        expect(markerVisible({ ...base, noui: true })).toBe(false);
    });

    it('is hidden during animation playback', () => {
        expect(markerVisible({ ...base, cameraMode: 'anim' })).toBe(false);
    });

    it('is hidden while a portal transition is running', () => {
        expect(markerVisible({ ...base, transitionActive: true })).toBe(false);
    });

    it('is hidden when several suppressors apply at once', () => {
        expect(markerVisible({ noui: true, cameraMode: 'anim', transitionActive: true })).toBe(false);
    });

    it('is visible when given no state at all', () => {
        expect(markerVisible(null as any)).toBe(true);
    });
});

describe('resolveMarkerTooltip', () => {
    it('resolves an exact locale', () => {
        expect(resolveMarkerTooltip(MARKER_TOOLTIPS, 'fr')).toBe(MARKER_TOOLTIPS.fr);
    });

    it('falls back from a region subtag to the base language', () => {
        expect(resolveMarkerTooltip(MARKER_TOOLTIPS, 'fr-CA')).toBe(MARKER_TOOLTIPS.fr);
    });

    it('is case insensitive', () => {
        expect(resolveMarkerTooltip(MARKER_TOOLTIPS, 'PT-BR')).toBe(MARKER_TOOLTIPS.pt);
    });

    it('falls back to English for an unknown language', () => {
        expect(resolveMarkerTooltip(MARKER_TOOLTIPS, 'xx')).toBe(MARKER_TOOLTIPS.en);
    });

    it('falls back to English for a null or empty language', () => {
        expect(resolveMarkerTooltip(MARKER_TOOLTIPS, null as any)).toBe(MARKER_TOOLTIPS.en);
        expect(resolveMarkerTooltip(MARKER_TOOLTIPS, '')).toBe(MARKER_TOOLTIPS.en);
    });

    it('provides a non-empty string for all nine languages', () => {
        const langs = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh'];
        expect(Object.keys(MARKER_TOOLTIPS).sort()).toEqual(langs.sort());
        Object.values(MARKER_TOOLTIPS).forEach(v => expect(v.length).toBeGreaterThan(0));
    });
});

describe('module contract', () => {
    it('exposes the agreed marker size', () => {
        expect(MARKER_SIZE).toBe(48);
    });

    it('keeps every stringified helper self-contained', () => {
        // These four are injected into the companion runtime via toString(),
        // so their bodies must not reference module-scope bindings.
        [portalsForScene, markerScale, markerVisible, resolveMarkerTooltip].forEach((fn) => {
            expect(fn.toString()).not.toContain('MARKER_TOOLTIPS');
            expect(fn.toString()).not.toContain('MARKER_SIZE');
        });
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/portal-marker.test.ts > /tmp/t.log 2>&1; tail -30 /tmp/t.log`
Expected: FAIL — `Failed to resolve import "../src/portal-marker"`.

- [ ] **Step 3: Write the implementation**

Create `src/portal-marker.ts`:

```ts
// Pure, dependency-free decision helpers for the exported viewer's portal
// marker icons. No playcanvas imports: the four functions below are unit-tested
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

// World-space uniform scale that keeps a camera-facing quad at a constant pixel
// size. This is the exported viewer's own hotspot formula
// (Annotation._calculateScreenSpaceScale), extracted so it can be tested.
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
    markerScale,
    markerVisible,
    portalsForScene,
    resolveMarkerTooltip,
    MarkerPortal
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/portal-marker.test.ts > /tmp/t.log 2>&1; tail -30 /tmp/t.log`
Expected: PASS, 24 tests.

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: exit 0, no output about `src/portal-marker.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/portal-marker.ts test/portal-marker.test.ts
git commit -m "feat(portals): pure decision helpers for the exported-viewer portal icon"
```

---

### Task 2: Publish the viewer's engine classes on `window.__ssPc`

The exported `index.js` is a single **unminified** ESM bundle that exports only `main`, and the companion is a classic script, so the only bridge to the engine classes is a `window` publish appended at module scope. Add it as a fourth entry in the existing export-time patch list.

**Files:**
- Modify: `src/viewer-engine-patch.ts` (append to `PATCHES`, before line 137's `];`)
- Test: `test/viewer-engine-patch.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: at runtime in the exported viewer, `window.__ssPc` — an object with `Entity`, `Layer`, `Mesh`, `MeshInstance`, `StandardMaterial`, `Texture`, `Color`, `Vec3`, `BlendState`, `PlaneGeometry`, `PIXELFORMAT_RGBA8`, `FILTER_LINEAR`, `CULLFACE_NONE`, `BLENDEQUATION_ADD`, `BLENDMODE_ONE`, `BLENDMODE_SRC_ALPHA`, `BLENDMODE_ONE_MINUS_SRC_ALPHA`. `VIEWER_ENGINE_PATCH_COUNT` becomes 4.

- [ ] **Step 1: Write the failing test**

In `test/viewer-engine-patch.test.ts`, add this snippet constant just below `INITXR_SNIPPET` (before `const BUNDLE = ...`):

```ts
// Tail of the bundle: the only thing it exports. The fork patch prepends a
// window publish of the engine classes the portal-marker companion needs.
const EXPORT_SNIPPET =
    'console.log(`SuperSplat Viewer`);\n' +
    '\n' +
    'export { main };\n';
```

Change the `BUNDLE` line to include it:

```ts
const BUNDLE = CAMERA_MANAGER_SNIPPET + INITXR_SNIPPET + EXPORT_SNIPPET;
```

Change the count assertion in the first test from `toBe(3)` to `toBe(4)`, and add these assertions at the end of that same `it(...)` block:

```ts
        // fork patch: publish the engine classes the portal-marker companion
        // needs, guarded so a renamed symbol degrades to "no icons" rather than
        // a ReferenceError that kills the whole viewer module
        expect(source).toContain('try { window.__ssPc = {');
        expect(source).toContain('Entity: Entity');
        expect(source).toContain('MeshInstance: MeshInstance');
        expect(source).toContain('StandardMaterial: StandardMaterial');
        expect(source).toContain('PlaneGeometry: PlaneGeometry');
        expect(source).toContain('BLENDMODE_ONE_MINUS_SRC_ALPHA: BLENDMODE_ONE_MINUS_SRC_ALPHA');
        // the original export is preserved after it
        expect(source.indexOf('window.__ssPc')).toBeLessThan(source.indexOf('export { main };'));
```

And add a new test at the end of the `describe` block:

```ts
    it('does not publish engine classes into a bundle with no export tail', () => {
        const { source, patched } = patchViewerEngine(CAMERA_MANAGER_SNIPPET + INITXR_SNIPPET);
        expect(patched).toBe(3);
        expect(source).not.toContain('__ssPc');
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/viewer-engine-patch.test.ts > /tmp/t.log 2>&1; tail -30 /tmp/t.log`
Expected: FAIL — `expected 3 to be 4` and the missing `__ssPc` assertions.

- [ ] **Step 3: Write the implementation**

In `src/viewer-engine-patch.ts`, insert this object as the **last** element of the `PATCHES` array (after the XR-start patch object at lines 127-136, before the closing `];`). Note the leading comma on the preceding entry.

```ts
    // --- fork: publish the engine classes the portal-marker companion needs ---
    // The exported viewer bundles engine + app into one unminified ESM module
    // whose only export is `main`, and the injected companions are classic
    // scripts, so there is no way to reach Entity/Mesh/StandardMaterial/...
    // from a companion. Prepend a window publish at module scope, where every
    // class is in lexical scope under its real name (verified against the
    // splat-transform 3.1.7 bundle).
    //
    // Wrapped in try/catch on purpose: if a future bundle renames a symbol
    // (rollup appends $1 on collisions), the free identifier throws a
    // ReferenceError at module evaluation -- which would kill the ENTIRE
    // viewer. Catching it degrades to "no portal icons" instead.
    //
    // `export { main };` survives its own replacement, so this patch needs the
    // `applied` marker to stay idempotent on a second pass (the other patches
    // self-destruct because their search text does not reappear).
    {
        search: 'export { main };',
        replace:
            'try { window.__ssPc = {\n' +
            '    Entity: Entity, Layer: Layer, Mesh: Mesh, MeshInstance: MeshInstance,\n' +
            '    StandardMaterial: StandardMaterial, Texture: Texture, Color: Color, Vec3: Vec3,\n' +
            '    BlendState: BlendState, PlaneGeometry: PlaneGeometry,\n' +
            '    PIXELFORMAT_RGBA8: PIXELFORMAT_RGBA8, FILTER_LINEAR: FILTER_LINEAR,\n' +
            '    CULLFACE_NONE: CULLFACE_NONE, BLENDEQUATION_ADD: BLENDEQUATION_ADD,\n' +
            '    BLENDMODE_ONE: BLENDMODE_ONE, BLENDMODE_SRC_ALPHA: BLENDMODE_SRC_ALPHA,\n' +
            '    BLENDMODE_ONE_MINUS_SRC_ALPHA: BLENDMODE_ONE_MINUS_SRC_ALPHA\n' +
            '}; } catch (ssPcErr) { console.warn(\'portal markers unavailable:\', ssPcErr); }\n' +
            'export { main };',
        applied: 'window.__ssPc = {'
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/viewer-engine-patch.test.ts > /tmp/t.log 2>&1; tail -30 /tmp/t.log`
Expected: PASS, 5 tests.

- [ ] **Step 5: Verify against the real bundle**

The patch is worthless if it does not match the shipped viewer. Run this one-off check:

```bash
node -e "
const fs=require('fs');
const s=fs.readFileSync('node_modules/@playcanvas/splat-transform/dist/index.mjs','utf8');
const start=s.indexOf('var index = \"');
let i=start+'var index = '.length, j=i+1;
while(true){const c=s[j]; if(c==='\\\\'){j+=2;continue;} if(c==='\"')break; j++;}
const code=new Function('return '+s.slice(i,j+1))();
const names=['Entity','Layer','Mesh','MeshInstance','StandardMaterial','Texture','Color','Vec3','BlendState','PlaneGeometry'];
names.forEach(n=>console.log(n, code.includes('class '+n+' ')||code.includes('class '+n+'{')));
console.log('export tail occurrences', code.split('export { main };').length-1);
"
```

Expected: every class prints `true`, and `export tail occurrences 1`.

- [ ] **Step 6: Lint and commit**

```bash
npm run lint
git add src/viewer-engine-patch.ts test/viewer-engine-patch.test.ts
git commit -m "feat(portals): publish viewer engine classes on window.__ssPc"
```

---

### Task 3: Portal marker companion module

The runtime that builds the icons. Written as plain function declarations (no IIFE of its own) so it can be interpolated **inside** the portals companion's IIFE, where `data`, `activeIndex`, `liveApp`, `transState` and `getState()` are closure variables. This is the `annotation-gallery.ts` → `annotation-links.ts` idiom.

**Files:**
- Create: `src/viewer-companion/portal-markers.ts`
- Test: `test/portal-markers.test.ts`

**Interfaces:**
- Consumes: `MARKER_SIZE`, `MARKER_TOOLTIPS`, `markerScale`, `markerVisible`, `portalsForScene`, `resolveMarkerTooltip` from `../portal-marker` (Task 1); `window.__ssPc` at runtime (Task 2).
- Produces: `markerStyle: string` (CSS, no `<style>` tags) and `markerRuntime: string` (JS fragment). The fragment defines `buildPortalMarkers()` and `refreshPortalMarkers()`, which Task 4 calls, and reads the closure variables `data`, `activeIndex`, `liveApp`, `transState`, `getState`.

- [ ] **Step 1: Write the failing test**

Create `test/portal-markers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import { markerRuntime, markerStyle } from '../src/viewer-companion/portal-markers';

describe('markerStyle', () => {
    it('sizes the hit-target from MARKER_SIZE', () => {
        expect(markerStyle).toContain('width: 56px');
        expect(markerStyle).toContain('height: 56px');
    });

    it('sits below the portal transition covers', () => {
        // loading backdrop 2000, tiles/defocus 1999
        expect(markerStyle).toContain('z-index: 1998');
    });

    it('keeps the container click-through but the hit-target clickable', () => {
        expect(markerStyle).toContain('.ss-portal-markers { position: fixed; inset: 0; z-index: 1998; pointer-events: none; }');
        expect(markerStyle).toContain('pointer-events: auto');
    });
});

describe('markerRuntime', () => {
    it('defines the two entry points the portals companion calls', () => {
        expect(markerRuntime).toContain('function buildPortalMarkers()');
        expect(markerRuntime).toContain('function refreshPortalMarkers()');
    });

    it('ships the stringified pure helpers', () => {
        expect(markerRuntime).toContain('var portalsForScene =');
        expect(markerRuntime).toContain('var markerScale =');
        expect(markerRuntime).toContain('var markerVisible =');
        expect(markerRuntime).toContain('var resolveMarkerTooltip =');
    });

    it('bakes the nine-language tooltip table', () => {
        expect(markerRuntime).toContain('Portal to another scene');
        expect(markerRuntime).toContain('Portail vers une autre scène');
    });

    it('inserts its layer before the splats so occluded icons are painted over', () => {
        expect(markerRuntime).toContain('getOpaqueIndex(world) + 1');
        // there is deliberately NO always-on-top overlay copy
        expect(markerRuntime).not.toContain('getTransparentIndex');
    });

    it('reads the suppression inputs from the viewer, not from annotations', () => {
        expect(markerRuntime).toContain('window.sse.config.noui');
        expect(markerRuntime).toContain("transState.phase !== 'idle'");
        expect(markerRuntime).not.toContain('controlsHidden');
        expect(markerRuntime).not.toContain('gamingControls');
    });

    it('degrades silently when the engine publish patch did not apply', () => {
        expect(markerRuntime).toContain('window.__ssPc');
        expect(markerRuntime).toContain('if (!pcns');
    });

    it('contains no backslashes (build-time template cooking eats them)', () => {
        expect(markerRuntime.includes(String.fromCharCode(92))).toBe(false);
        expect(markerStyle.includes(String.fromCharCode(92))).toBe(false);
    });

    it('contains no surviving template interpolation', () => {
        expect(markerRuntime.includes('$' + '{')).toBe(false);
        expect(markerStyle.includes('$' + '{')).toBe(false);
    });

    it('contains no backticks (it is embedded in a template literal)', () => {
        expect(markerRuntime.includes(String.fromCharCode(96))).toBe(false);
    });

    it('parses as a function body', () => {
        expect(() => new Function(markerRuntime)).not.toThrow();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/portal-markers.test.ts > /tmp/t.log 2>&1; tail -30 /tmp/t.log`
Expected: FAIL — `Failed to resolve import "../src/viewer-companion/portal-markers"`.

- [ ] **Step 3: Write the implementation**

Create `src/viewer-companion/portal-markers.ts`:

```ts
import { MARKER_SIZE, MARKER_TOOLTIPS, markerScale, markerVisible, portalsForScene, resolveMarkerTooltip } from '../portal-marker';

// Billboarded portal icons for the exported viewer.
//
// One camera-facing quad per portal, at the portal centre (the point the
// editor's transform gizmo sits on), at a constant 48px screen size. The quad
// lives in a layer inserted right after World OPAQUE -- i.e. BEFORE the splats,
// which render in World transparent -- so a splat in front of the portal simply
// paints over the icon. That is where the occlusion comes from; there is no
// depth readback and, unlike the viewer's annotation hotspots, no always-on-top
// second copy, so an occluded icon disappears instead of ghosting.
//
// The runtime below is written to be interpolated INSIDE the portals
// companion's IIFE (viewer-companion/portals.ts), so it defines plain functions
// rather than an IIFE of its own and reads that closure's `data`, `activeIndex`,
// `liveApp`, `transState` and `getState()`.
//
// BUILD TRAP: template literals in this directory have their backslash escapes
// eaten at build time, so the runtime below contains no backslashes of any kind
// -- no regex escapes, no newline escapes in strings. The multi-line shader
// chunks are therefore written on one line. No backticks either: this string is
// spliced into another template literal.

const markerStyle = `
.ss-portal-markers { position: fixed; inset: 0; z-index: 1998; pointer-events: none; }
.ss-portal-marker-hit {
  position: absolute; display: none;
  width: ${MARKER_SIZE + 8}px; height: ${MARKER_SIZE + 8}px;
  transform: translate(-50%, -50%);
  cursor: pointer; pointer-events: auto;
}
.ss-portal-marker-tip {
  position: absolute; display: block; box-sizing: border-box;
  width: fit-content; max-width: 220px; padding: 8px;
  border-radius: 4px; background: rgba(0, 0, 0, 0.8); color: #fff;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 14px; word-wrap: break-word; white-space: normal;
  pointer-events: none; opacity: 0; visibility: hidden;
  transition: opacity 200ms ease-in-out;
}
.ss-portal-marker-tip.on { opacity: 1; visibility: visible; }
.ss-portal-marker-tip.arrow-right::before,
.ss-portal-marker-tip.arrow-left::before {
  content: ""; position: absolute; top: var(--ss-tip-arrow, 50%);
  transform: translateY(-50%);
  border-top: 8px solid transparent; border-bottom: 8px solid transparent;
}
.ss-portal-marker-tip.arrow-right::before { left: -8px; border-right: 8px solid rgba(0, 0, 0, 0.8); }
.ss-portal-marker-tip.arrow-left::before { right: -8px; border-left: 8px solid rgba(0, 0, 0, 0.8); }
`;

const markerRuntime = `
  var markerTooltips = ${JSON.stringify(MARKER_TOOLTIPS)};
  var portalsForScene = ${portalsForScene.toString()};
  var markerScale = ${markerScale.toString()};
  var markerVisible = ${markerVisible.toString()};
  var resolveMarkerTooltip = ${resolveMarkerTooltip.toString()};

  var MARKER_SIZE = ${MARKER_SIZE};
  var MARKER_TEX = 256;
  // Clamp the quad's vertices to the near/far planes so it is never plane
  // clipped. Copied from the viewer's own hotspot material; written on ONE line
  // because a multi-line string here would need escapes this file cannot carry.
  var MARKER_CLAMP_GLSL = 'float f = gl_Position.z / gl_Position.w; if (f > 1.0) { gl_Position.z = gl_Position.w; } else if (f < -1.0) { gl_Position.z = -gl_Position.w; }';
  var MARKER_CLAMP_WGSL = 'let f = output.position.z / output.position.w; if (f > 1.0) { output.position.z = output.position.w; } else if (f < -1.0) { output.position.z = -output.position.w; }';

  var markerLayer = null;      // our render Layer, inserted before the splats
  var markerMesh = null;       // one shared unit plane
  var markerTexture = null;    // one shared canvas-drawn disc + door glyph
  var markerBaseColor = null;  // idle emissive
  var markerHoverColor = null; // hover emissive
  var markerCamera = null;     // the viewer's camera Entity
  var markerRoot = null;       // our DOM container (never the viewer's #annotations)
  var markerTip = null;        // our tooltip div
  var markerTipOwner = -1;     // portal index owning the open tooltip, -1 = none
  var markerHovered = -1;
  var markerNoui = false;
  var markers = [];            // portal index -> {entity, dom, material, visible}
  var markerViewPos = null;    // per-frame scratch (no allocation)
  var markerScreenPos = null;

  // Rounded rect via arcTo: ctx.roundRect is too new to rely on.
  function markerRoundRect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Black disc + white ring + the app's door glyph, drawn to a canvas and
  // uploaded once. The glyph is traced from src/ui/svg/portal.svg in its own
  // 38-unit box: rect x=12 y=7 w=14 h=24 rx=1.5 stroked at width 2, plus a
  // filled r=1.2 knob dot at (23, 19).
  function markerMakeTexture(pcns, device) {
    var canvas = document.createElement('canvas');
    canvas.width = MARKER_TEX;
    canvas.height = MARKER_TEX;
    var ctx = canvas.getContext('2d');
    if (!ctx) { return null; }
    var S = MARKER_TEX;
    var c = S / 2;
    // Clear to WHITE at zero alpha: the fixup loop below relies on it.
    ctx.fillStyle = 'white';
    ctx.globalAlpha = 0;
    ctx.fillRect(0, 0, S, S);
    ctx.globalAlpha = 1;
    var ring = S * 0.055;
    var radius = c - ring;
    ctx.beginPath();
    ctx.arc(c, c, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'black';
    ctx.fill();
    ctx.lineWidth = ring;
    ctx.strokeStyle = 'white';
    ctx.stroke();
    var u = (S / 38) * 0.74;             // glyph units -> px, shrunk to sit inside the disc
    var ox = c - 19 * u;
    var oy = c - 19 * u;
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 2 * u;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    markerRoundRect(ctx, ox + 12 * u, oy + 7 * u, 14 * u, 24 * u, 1.5 * u);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ox + 23 * u, oy + 19 * u, 1.2 * u, 0, Math.PI * 2);
    ctx.fillStyle = 'white';
    ctx.fill();
    // Force the colour channels of semi-transparent pixels to white so the
    // ring's antialiased edge blends correctly (the viewer does the same).
    var img = ctx.getImageData(0, 0, S, S);
    var d = img.data;
    for (var i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 255) { d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; }
    }
    return new pcns.Texture(device, {
      width: S,
      height: S,
      format: pcns.PIXELFORMAT_RGBA8,
      magFilter: pcns.FILTER_LINEAR,
      minFilter: pcns.FILTER_LINEAR,
      mipmaps: false,
      levels: [new Uint8Array(d.buffer)]
    });
  }

  // One material per marker: hover re-tints the emissive, and a shared material
  // would tint every icon at once.
  function markerMakeMaterial(pcns, tex, color) {
    var m = new pcns.StandardMaterial();
    m.diffuse = new pcns.Color(0, 0, 0);
    m.emissive.copy(color);
    m.emissiveMap = tex;
    m.opacityMap = tex;
    m.opacity = 1;
    m.alphaTest = 0.01;
    m.blendState = new pcns.BlendState(
      true,
      pcns.BLENDEQUATION_ADD, pcns.BLENDMODE_SRC_ALPHA, pcns.BLENDMODE_ONE_MINUS_SRC_ALPHA,
      pcns.BLENDEQUATION_ADD, pcns.BLENDMODE_ONE, pcns.BLENDMODE_ONE
    );
    m.depthTest = true;
    m.depthWrite = true;
    m.cull = pcns.CULLFACE_NONE;
    m.useLighting = false;
    try {
      m.shaderChunks.glsl.add({ litUserMainEndVS: MARKER_CLAMP_GLSL });
      m.shaderChunks.wgsl.add({ litUserMainEndVS: MARKER_CLAMP_WGSL });
    } catch (chunkErr) {}
    m.update();
    return m;
  }

  // The viewer registers RenderComponentSystem in its appOptions (verified in
  // the 3.1.7 bundle), so addComponent('render') is available even in an export
  // that has no annotations.
  function markerMakeOne(pcns, app, portal, index) {
    var material = markerMakeMaterial(pcns, markerTexture, markerBaseColor);
    var mi = new pcns.MeshInstance(markerMesh, material);
    mi.cull = false;
    var entity = new pcns.Entity('portal-marker-' + index);
    entity.addComponent('render', { layers: [markerLayer.id], meshInstances: [mi] });
    entity.setPosition(portal.position[0], portal.position[1], portal.position[2]);
    entity.enabled = false;
    app.root.addChild(entity);
    var dom = document.createElement('div');
    dom.className = 'ss-portal-marker-hit';
    dom.addEventListener('pointerenter', function () { markerSetHover(index, true); });
    dom.addEventListener('pointerleave', function () { markerSetHover(index, false); });
    dom.addEventListener('click', function (clickEv) {
      clickEv.stopPropagation();
      markerOpenTip(index);
    });
    markerRoot.appendChild(dom);
    return { entity: entity, dom: dom, material: material, visible: false };
  }

  function markerSetHover(index, on) {
    var m = markers[index];
    if (!m || !m.material) { return; }
    if (on) { markerHovered = index; } else if (markerHovered === index) { markerHovered = -1; }
    m.material.emissive.copy(on ? markerHoverColor : markerBaseColor);
    m.material.update();
    if (liveApp) { liveApp.renderNextFrame = true; }
  }

  function markerOpenTip(index) {
    markerTipOwner = index;
    markerTip.classList.add('on');
    if (liveApp) { liveApp.renderNextFrame = true; }
    markerUpdate();          // position immediately, even if the camera is still
  }

  function markerCloseTip() {
    if (markerTipOwner === -1) { return; }
    markerTipOwner = -1;
    markerTip.classList.remove('on');
  }

  // Right of the icon by default, flipped left when it would overflow, clamped
  // to the viewport, arrow pointing back at the icon. Mirrors the viewer's own
  // annotation tooltip placement.
  function markerPositionTip(x, y) {
    var margin = 8;
    var offset = MARKER_SIZE * 0.6;
    var tw = markerTip.offsetWidth;
    var th = markerTip.offsetHeight;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var left = x + offset;
    var flipped = false;
    if (left + tw > vw - margin) { left = x - offset - tw; flipped = true; }
    left = Math.max(margin, Math.min(left, vw - tw - margin));
    var top = Math.max(margin, Math.min(y - th / 2, vh - th - margin));
    markerTip.style.setProperty('--ss-tip-arrow', Math.max(12, Math.min(y - top, th - 12)) + 'px');
    markerTip.classList.toggle('arrow-right', !flipped);
    markerTip.classList.toggle('arrow-left', flipped);
    markerTip.style.left = left + 'px';
    markerTip.style.top = top + 'px';
  }

  // Per-frame: billboard, constant-screen-size scale, DOM hit-target placement.
  // Only enabled markers are touched, so the cost tracks the portals in the
  // ACTIVE scene rather than the whole bundle.
  function markerUpdate() {
    if (!markerLayer || !markerCamera || !liveApp) { return; }
    var cam = markerCamera.camera;
    var canvasHeight = liveApp.graphicsDevice.canvas.clientHeight;
    var viewMatrix = cam.viewMatrix;
    var proj5 = cam.projectionMatrix.data[5];
    var rot = markerCamera.getRotation();
    for (var i = 0; i < markers.length; i++) {
      var m = markers[i];
      if (!m || !m.visible) { continue; }
      var p = m.entity.getPosition();
      viewMatrix.transformPoint(p, markerViewPos);
      if (markerViewPos.z >= 0) {
        m.dom.style.display = 'none';
        if (markerTipOwner === i) { markerTip.classList.remove('on'); }
        continue;
      }
      cam.worldToScreen(p, markerScreenPos);
      m.entity.setRotation(rot);
      m.entity.rotateLocal(90, 0, 0);           // the plane geometry lies in XZ
      var s = markerScale(MARKER_SIZE, canvasHeight, proj5, -markerViewPos.z);
      m.entity.setLocalScale(s, s, s);
      m.dom.style.display = 'block';
      m.dom.style.left = markerScreenPos.x + 'px';
      m.dom.style.top = markerScreenPos.y + 'px';
      if (markerTipOwner === i) {
        markerTip.classList.add('on');
        markerPositionTip(markerScreenPos.x, markerScreenPos.y);
      }
    }
  }

  // Re-evaluate which markers are enabled. Called on scene change, on camera
  // mode change and on every portal transition phase change.
  function refreshPortalMarkers() {
    if (!markerLayer) { return; }
    var st = getState();
    var visible = markerVisible({
      noui: markerNoui,
      cameraMode: (st && st.cameraMode) || 'orbit',
      transitionActive: !!(transState && transState.phase !== 'idle')
    });
    var wanted = visible ? portalsForScene(data.portals || [], activeIndex) : [];
    var on = {};
    for (var w = 0; w < wanted.length; w++) { on[wanted[w]] = true; }
    var changed = false;
    for (var i = 0; i < markers.length; i++) {
      var m = markers[i];
      if (!m) { continue; }
      var want = !!on[i];
      if (m.visible === want) { continue; }
      changed = true;
      m.visible = want;
      m.entity.enabled = want;
      if (!want) {
        m.dom.style.display = 'none';
        if (markerHovered === i) { markerSetHover(i, false); }
        if (markerTipOwner === i) { markerCloseTip(); }
      }
    }
    if (changed && liveApp) { liveApp.renderNextFrame = true; }
  }

  // Build once, after the portals companion has captured the live app. Every
  // failure path is soft: no icons, everything else untouched.
  function buildPortalMarkers() {
    var pcns = window.__ssPc;
    if (!pcns || !liveApp || markerLayer) { return; }
    try {
      var app = liveApp;
      var camComp = app.root.findComponent('camera');
      if (!camComp) { return; }
      var layers = app.scene.layers;
      var world = layers.getLayerByName('World');
      if (!world) { return; }
      markerTexture = markerMakeTexture(pcns, app.graphicsDevice);
      if (!markerTexture) { return; }
      markerCamera = camComp.entity;
      // Inserted right after World OPAQUE: the splats render later and paint
      // over an occluded icon. There is deliberately no always-on-top copy.
      markerLayer = new pcns.Layer({ name: 'PortalMarkers' });
      layers.insert(markerLayer, layers.getOpaqueIndex(world) + 1);
      markerCamera.camera.layers = markerCamera.camera.layers.concat([markerLayer.id]);
      markerBaseColor = new pcns.Color(0.85, 0.85, 0.85);
      markerHoverColor = new pcns.Color(1.0, 0.4, 0.0);
      var viewer = window.__supersplatViewer;
      if (viewer && viewer.cameraFrame) {
        // The viewer gamma-corrects its own hotspot colours when a camera frame
        // (post-processing) is active; match it or the icons read washed out.
        markerBaseColor.gamma();
        markerHoverColor.gamma();
      }
      markerMesh = pcns.Mesh.fromGeometry(app.graphicsDevice, new pcns.PlaneGeometry({ widthSegments: 1, lengthSegments: 1 }));
      markerViewPos = new pcns.Vec3();
      markerScreenPos = new pcns.Vec3();
      markerRoot = document.createElement('div');
      markerRoot.className = 'ss-portal-markers';
      document.body.appendChild(markerRoot);
      markerTip = document.createElement('div');
      markerTip.className = 'ss-portal-marker-tip';
      markerTip.textContent = resolveMarkerTooltip(markerTooltips, navigator.language || 'en');
      markerRoot.appendChild(markerTip);
      markerNoui = !!(window.sse && window.sse.config && window.sse.config.noui);
      var list = data.portals || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].position) { markers[i] = markerMakeOne(pcns, app, list[i], i); }
      }
      app.on('prerender', markerUpdate);
      document.addEventListener('click', function () { markerCloseTip(); });
      refreshPortalMarkers();
    } catch (markerErr) {
      console.warn('portal markers disabled:', markerErr);
    }
  }
`;

export { markerRuntime, markerStyle };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/portal-markers.test.ts > /tmp/t.log 2>&1; tail -40 /tmp/t.log`
Expected: PASS, 13 tests.

If the "no backslashes" test fails, find the offending escape — it is almost always a `\n` inside a string or a regex escape — and rewrite it without one.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/viewer-companion/portal-markers.ts test/portal-markers.test.ts
git commit -m "feat(portals): exported-viewer portal marker companion runtime"
```

---

### Task 4: Wire the markers into the portals companion

Splice the style and runtime in, and call the two entry points from the four places the companion already owns: startup, scene change, transition phase change, camera mode change.

**Files:**
- Modify: `src/viewer-companion/portals.ts` (imports; `applyActive` ~line 995; `start()` ~line 1122; `transDispatch` ~line 586; the `cameraMode:changed` listener ~line 1101; the runtime tail ~line 2181; `buildPortalsInjection` ~line 2231)
- Test: `test/portals-injection.test.ts`

**Interfaces:**
- Consumes: `markerRuntime`, `markerStyle` from `./portal-markers` (Task 3).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing test**

Append this `describe` block to the end of `test/portals-injection.test.ts`:

```ts
describe('portal marker icons', () => {
    const payload = {
        portals: [{ position: [1, 2, 3], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
        portalScenes: ['', 'scenes/1/scene.sog'],
        portalStart: 0,
        portalCollision: [],
        portalEnvironments: ['indoor', 'indoor'],
        portalSceneLodCounts: [[1000], [1000]]
    };

    it('ships the marker style and runtime', () => {
        const out = buildPortalsInjection(payload);
        expect(out).toContain('.ss-portal-marker-hit');
        expect(out).toContain('function buildPortalMarkers()');
        expect(out).toContain('Portal to another scene');
    });

    it('ships nothing when there are no portals', () => {
        expect(buildPortalsInjection({ portals: [] })).toBe('');
    });

    it('builds the markers once at startup, right after applyActive', () => {
        const out = buildPortalsInjection(payload);
        expect(out).toContain('applyActive();\n    buildPortalMarkers();');
    });

    it('refreshes the markers from every state-change site', () => {
        const out = buildPortalsInjection(payload);
        // applyActive, transDispatch, the cameraMode:changed listener, and the
        // tail of buildPortalMarkers itself
        const calls = out.split('refreshPortalMarkers();').length - 1;
        expect(calls).toBeGreaterThanOrEqual(4);
    });

    it('refreshes right after the transition collision swap', () => {
        const out = buildPortalsInjection(payload);
        const swap = out.indexOf('swapCollision(collisionScene());');
        expect(swap).toBeGreaterThan(-1);
        expect(out.slice(swap, swap + 280)).toContain('refreshPortalMarkers();');
    });

    it('refreshes when the camera mode changes', () => {
        const out = buildPortalsInjection(payload);
        const mode = out.indexOf('spawnScene = activeIndex; }');
        expect(mode).toBeGreaterThan(-1);
        expect(out.slice(mode, mode + 120)).toContain('refreshPortalMarkers();');
    });

    it('defines the marker runtime before start() runs', () => {
        const out = buildPortalsInjection(payload);
        expect(out.indexOf('function buildPortalMarkers()')).toBeLessThan(out.indexOf('requestAnimationFrame(start);'));
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/portals-injection.test.ts > /tmp/t.log 2>&1; tail -40 /tmp/t.log`
Expected: FAIL — 6 new failures, `.ss-portal-marker-hit` not found etc.

- [ ] **Step 3: Add the import**

In `src/viewer-companion/portals.ts`, add to the existing import block (keep it adjacent to the other `../portal-*` imports; do **not** reorder anything else):

```ts
import { markerRuntime, markerStyle } from './portal-markers';
```

- [ ] **Step 4: Refresh markers when the active scene changes**

In `applyActive()` (~line 995), add the refresh call before the render request:

```js
  // Enable exactly the active scene; disable the rest (avoids overlapping haze).
  function applyActive() {
    for (var i = 0; i < entities.length; i++) {
      if (entities[i]) entities[i].enabled = (i === activeIndex);
    }
    refreshPortalMarkers();
    var app = getApp(window.__supersplatViewer);
    if (app) app.renderNextFrame = true;
  }
```

- [ ] **Step 5: Refresh markers on every transition phase change**

In `transDispatch(ev)` (~line 586), add the refresh call immediately after the `swapCollision(collisionScene());` line:

```js
    swapCollision(collisionScene());
    // Markers are suppressed for the whole cover, so every phase change
    // (dismantle, covered, reconstruct, idle) has to re-evaluate them.
    refreshPortalMarkers();
```

- [ ] **Step 6: Refresh markers on camera mode change, and build them at startup**

In the `cameraMode:changed` listener (~line 1101), add the refresh so entering and leaving `anim` takes effect:

```js
      ev.on('cameraMode:changed', function (mode) {
        if (mode === 'walk' || mode === 'fly') { spawnScene = activeIndex; }
        refreshPortalMarkers();
      });
```

In `start()`, immediately after `applyActive();` (~line 1131), add the build call:

```js
    noteVisit(activeIndex);
    applyActive();
    buildPortalMarkers();
    reconcileFrontier();
```

`applyActive()` runs first and its `refreshPortalMarkers()` is a no-op while `markerLayer` is null; `buildPortalMarkers()` ends with its own refresh.

- [ ] **Step 7: Splice the runtime into the IIFE**

At the tail of `companionRuntime` (~line 2181), insert the fragment just before the bootstrap:

```js
${markerRuntime}

  requestAnimationFrame(start);
})();
```

- [ ] **Step 8: Splice the style into the injection**

In `buildPortalsInjection` (~line 2231), change the style tag:

```ts
    return `<style>${companionStyle}${markerStyle}</style>` +
        `<script>window.__supersplatPortals = ${payloadJson};</script>` +
        `<script>${companionRuntime}</script>`;
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npx vitest run test/portals-injection.test.ts > /tmp/t.log 2>&1; tail -40 /tmp/t.log`
Expected: PASS, all tests including the pre-existing `keeps the runtime free of template-literal hazards`, `runtime script body constructs via new Function without throwing` and `emits exactly two scripts`.

If `new Function` throws, the marker fragment has a syntax error; if the hazard test fails, a `${` survived into the output.

- [ ] **Step 10: Lint and commit**

```bash
npm run lint
git add src/viewer-companion/portals.ts test/portals-injection.test.ts
git commit -m "feat(portals): wire portal marker icons into the viewer companion"
```

---

### Task 5: Full verification and end-to-end check

**Files:**
- No source changes expected. If E2E turns up a defect, fix it in the owning file and re-run this task.

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: a verified build.

- [ ] **Step 1: Run the whole test suite**

Run: `npm run test > /tmp/all.log 2>&1; tail -30 /tmp/all.log`
Expected: all files pass, zero failures. Do not background this and do not pipe it to `grep` — Vitest hangs here when backgrounded or piped.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: exit 0.

- [ ] **Step 3: Release build, gated on TypeScript output**

```bash
npm run build > /tmp/build.log 2>&1
grep -c "plugin typescript" /tmp/build.log
```

Expected: `0`. The build's exit code is **not** a type gate in this repo — Rollup reports TS errors as warnings and still exits 0.

- [ ] **Step 4: Rebuild the shared export core for the server path**

```bash
node scripts/build-shared.mjs > /tmp/shared.log 2>&1; tail -5 /tmp/shared.log
ls dist-shared/portal-marker.js dist-shared/viewer-companion/portal-markers.js
```

Expected: both files exist. They are pulled in transitively via `splat-export-core.ts` → `viewer-companion/portals.ts`.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "chore(portals): verification fixes for the portal icon"
```

Skip if nothing changed.

- [ ] **Step 6: End-to-end in a real exported viewer**

Start the app (`npm run develop`, http://localhost:3333), load a multi-scene project with at least two portals, and export a **ZIP package**. Serve the unzipped output and walk this list:

1. An icon appears at each portal centre in the start scene, at the same place as the editor's portal gizmo.
2. The disc is noticeably larger than an annotation hotspot, with the door glyph legible.
3. Occlusion: standing so a wall is between camera and portal hides the icon entirely; through a thin haze it dims rather than vanishing.
4. Orbit mode: hover tints the icon orange; clicking opens the tooltip; clicking elsewhere closes it; the tooltip flips to the left near the right edge of the window.
5. Walk mode and fly mode: the icon stays visible **while moving**, including with gaming controls enabled (where annotations disappear). Under pointer lock it is not clickable — expected.
6. Cross a portal: the icons swap to the new scene's portals, and an open tooltip closes.
7. The icons are hidden for the whole of a tiles transition and a defocus transition, and come back after.
8. Play the camera animation: no icons during `anim` playback.
9. Append `?noui=1` (or whatever `config.noui` the export uses): no icons at all.
10. Repeat 1-3 against an export produced by the export server (`server/`: `npm run dev`, http://localhost:3334) to confirm the `dist-shared` path matches.

- [ ] **Step 7: Report**

Report the outcome of every numbered E2E item, with the failures stated plainly rather than summarised as a pass.

---

## Self-Review

**Spec coverage**

| spec requirement | task |
| --- | --- |
| active-scene filter | 1 (`portalsForScene`), 3 (`refreshPortalMarkers`) |
| occlusion: single pre-splat layer, no ghost copy | 3 (`getOpaqueIndex(world) + 1`, no overlay), asserted in Task 3 tests |
| generic localized tooltip, 9 languages | 1 (`MARKER_TOOLTIPS`, `resolveMarkerTooltip`), 3 (tooltip DOM) |
| no toggle | nothing to build; markers are unconditional |
| `MARKER_SIZE = 48`, 256² texture, 56px hit-target | 1, 3 |
| disc + ring + `portal.svg` door glyph | 3 (`markerMakeTexture`) |
| visible in walk/fly while moving | 1 (`markerVisible` ignores `controlsHidden`/`gamingControls`), asserted in Tasks 1 and 3 |
| suppressed on `noui` / `anim` / transition | 1, 3, 4 (the three call sites) |
| hover tint | 3 (`markerSetHover`), per-marker material |
| depth-clamp chunk, GLSL **and** WGSL | 3 (`markerMakeMaterial`) |
| `.gamma()` when `cameraFrame != null` | 3 (`buildPortalMarkers`) |
| engine-class publish patch, `applied` marker, count 3→4 | 2 |
| soft failure on every path | 2 (try/catch), 3 (early returns + try/catch) |
| build traps: no backslashes, no backticks | Global Constraints, asserted in Task 3 |
| `dist-shared` rebuild for the server | 5 |
| unit + injection + E2E tests | 1, 2, 3, 4, 5 |

**Type consistency** — `buildPortalMarkers()` / `refreshPortalMarkers()` / `markerUpdate()` are spelled identically in Tasks 3 and 4. `markerViewPos` and `markerScreenPos` are declared in the same fragment that uses them. `markerScale(size, canvasHeight, projData5, viewDepth)` is called with exactly that argument order in Task 3. `MARKER_SIZE` is defined once in Task 1 and imported by Task 3 for both the CSS and the runtime.

**Deliberate deviation from the spec** — `portalsForScene` guards against a `null` `front` matching a `null` `active`; the spec did not say. A portal side is `null` when its scene was deleted, and `active` is always a real index, so this only hardens against a malformed payload.
