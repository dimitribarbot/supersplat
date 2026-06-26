# Portal Viewer Streaming-Scene Loading Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the black frame shown on the first portal crossing into a streaming scene in the exported viewer with a backdrop + spinner + localized "Loading…" overlay that clears the instant the scene's data is renderable.

**Architecture:** All changes live in the exported-viewer companion `src/viewer-companion/portals.ts`. A localized message resolver and overlay CSS are added (mirroring `off-limits-zones.ts`), and the existing companion runtime IIFE gains an overlay driver folded into its current `tick()` rAF loop: on a crossing into a not-yet-ready scene it shows the overlay, polls the scene's active-splat count each frame, and hides the overlay (or gives up after a frame-count safety cap) once data is resident.

**Tech Stack:** TypeScript, Vitest (`vitest run`), PlayCanvas 2.19 (exported viewer runtime), plain DOM/CSS injected as strings.

## Global Constraints

- Changes confined to `src/viewer-companion/portals.ts` + `test/portals-injection.test.ts`. No editor, export-bundle-format, or `portal-export.ts` changes.
- Follow the `off-limits-zones.ts` companion conventions exactly: stringified-helper injection via `Function.toString()`, HTML-escaped payload, `<style>` + payload `<script>` + runtime `<script>` from the `build…Injection` function.
- The companion runtime deliberately does **not** use `Date.now()` / `Math.random()` (resume-safety convention); time the safety cap by counting rAF frames, not wall-clock.
- The runtime must never throw out of `tick()` in a way that kills the rAF loop — new logic stays inside the existing `try/catch`.
- Overlay is **non-blocking** (`pointer-events: none`); it must not intercept viewer input.
- Localized label reuses the same 9 languages as `off-limits-zones.ts`, resolved at runtime from `navigator.language`.

---

### Task 1: Localized loading message + pure resolver

**Files:**
- Modify: `src/viewer-companion/portals.ts` (add `DEFAULT_MESSAGES`, `resolveLoadingMessage`, export both)
- Test: `test/portals-injection.test.ts`

**Interfaces:**
- Produces:
  - `DEFAULT_MESSAGES: Record<string, string>` — language-subtag → "Loading…" text.
  - `resolveLoadingMessage(custom: string, defaults: Record<string, string>, lang: string): string` — returns `custom` if non-empty, else `defaults[lang]` → `defaults[base-subtag]` → `defaults.en`. Pure; injected verbatim into the runtime via `.toString()`.

- [ ] **Step 1: Write the failing tests**

Add to the top of `test/portals-injection.test.ts` (extend the existing import on line 3):

```typescript
import { buildPortalsInjection, resolveLoadingMessage, DEFAULT_MESSAGES } from '../src/viewer-companion/portals';
```

Add a new `describe` block (place it above the existing `describe('buildPortalsInjection', …)`):

```typescript
describe('resolveLoadingMessage', () => {
    it('prefers a non-empty custom message', () => {
        expect(resolveLoadingMessage('Wait!', DEFAULT_MESSAGES, 'fr')).toBe('Wait!');
    });
    it('falls back to the language default', () => {
        expect(resolveLoadingMessage('', DEFAULT_MESSAGES, 'fr')).toBe(DEFAULT_MESSAGES.fr);
    });
    it('falls back from a region subtag to the base language', () => {
        expect(resolveLoadingMessage('', DEFAULT_MESSAGES, 'fr-CA')).toBe(DEFAULT_MESSAGES.fr);
    });
    it('falls back to English for unknown languages', () => {
        expect(resolveLoadingMessage('', DEFAULT_MESSAGES, 'xx')).toBe(DEFAULT_MESSAGES.en);
    });
    it('provides a non-empty English default', () => {
        expect(DEFAULT_MESSAGES.en.length).toBeGreaterThan(0);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/portals-injection.test.ts`
Expected: FAIL — `resolveLoadingMessage`/`DEFAULT_MESSAGES` are not exported (import error / undefined).

- [ ] **Step 3: Add the resolver and messages**

In `src/viewer-companion/portals.ts`, near the top of the file (after the import on line 1, before `const companionRuntime`), add:

```typescript
// Localized default loading labels, keyed by primary language subtag. Mirrors
// the language set used by off-limits-zones.ts / annotation-links.ts.
const DEFAULT_MESSAGES: Record<string, string> = {
    en: 'Loading…',
    de: 'Wird geladen…',
    es: 'Cargando…',
    fr: 'Chargement…',
    ja: '読み込み中…',
    ko: '로딩 중…',
    pt: 'Carregando…',
    ru: 'Загрузка…',
    zh: '加载中…'
};

// Pure default-message resolver. Custom text wins; otherwise pick the viewer's
// language (region subtag -> base subtag -> English). Self-contained so it is
// also injected verbatim into the runtime via Function.toString().
const resolveLoadingMessage = (custom: string, defaults: Record<string, string>, lang: string): string => {
    if (custom) {
        return custom;
    }
    const l = (lang || 'en').toLowerCase();
    return defaults[l] || defaults[l.split('-')[0]] || defaults.en;
};
```

Update the export line at the bottom of the file from:

```typescript
export { buildPortalsInjection };
```

to:

```typescript
export { buildPortalsInjection, resolveLoadingMessage, DEFAULT_MESSAGES };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/portals-injection.test.ts`
Expected: PASS (all `resolveLoadingMessage` tests + the existing `buildPortalsInjection` tests).

- [ ] **Step 5: Commit**

```bash
git add src/viewer-companion/portals.ts test/portals-injection.test.ts
git commit -m "feat(portals): localized loading-overlay message resolver"
```

---

### Task 2: Overlay CSS + `<style>` injection

**Files:**
- Modify: `src/viewer-companion/portals.ts` (add `companionStyle`; emit `<style>` and `loadingDefaults` from `buildPortalsInjection`)
- Test: `test/portals-injection.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_MESSAGES` (Task 1).
- Produces:
  - `companionStyle: string` — CSS for `.ss-portal-loading-backdrop`, `.ss-portal-loading-spinner`, `.ss-portal-loading-label`, the `.active` modifier, and the `@keyframes ss-portal-spin` animation.
  - `buildPortalsInjection` output now begins with `<style>${companionStyle}</style>` and the payload global gains a `loadingDefaults` field (= `DEFAULT_MESSAGES`).

- [ ] **Step 1: Write the failing tests**

In `test/portals-injection.test.ts`, extend the existing test `'emits the payload global and a runtime script when portals exist'` by adding these assertions inside it (after the existing `expect(out).toContain('<script>');`):

```typescript
        expect(out).toContain('<style>');
        expect(out).toContain('ss-portal-loading-backdrop');
        expect(out).toContain('ss-portal-spin'); // spinner keyframes present
        expect(out).toContain('loadingDefaults');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/portals-injection.test.ts`
Expected: FAIL — `<style>` / `ss-portal-loading-backdrop` / `ss-portal-spin` / `loadingDefaults` not present in output.

- [ ] **Step 3: Add the CSS and wire the injection**

In `src/viewer-companion/portals.ts`, add the style constant just before `const companionRuntime = ` (so it sits with the other injected strings):

```typescript
// CSS for the streaming-scene loading overlay (backdrop covers the viewer's
// clear color, a CSS-only spinner + label sit centered). Non-blocking
// (pointer-events: none) and fades via the `active` class, matching the
// 200ms timing used by off-limits-zones.ts.
const companionStyle = `
.ss-portal-loading-backdrop {
  position: fixed; inset: 0; z-index: 2000; pointer-events: none;
  background: #1a1a1a; opacity: 0; transition: opacity 200ms ease-out;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
}
.ss-portal-loading-backdrop.active { opacity: 1; }
.ss-portal-loading-spinner {
  width: 42px; height: 42px; border-radius: 50%;
  border: 4px solid rgba(255,255,255,0.25); border-top-color: #fff;
  animation: ss-portal-spin 0.9s linear infinite;
}
.ss-portal-loading-label {
  margin-top: 16px; color: #fff; font-family: sans-serif; font-size: 15px;
}
@keyframes ss-portal-spin { to { transform: rotate(360deg); } }
`;
```

Then, in `buildPortalsInjection`, add `loadingDefaults` to the `payload` object (after the `portalEnvironments` line):

```typescript
    const payload = {
        portals,
        portalScenes: viewerSettingsJson.portalScenes ?? [],
        portalStart: viewerSettingsJson.portalStart ?? 0,
        portalCollision: viewerSettingsJson.portalCollision ?? [],
        portalEnvironments: viewerSettingsJson.portalEnvironments ?? [],
        loadingDefaults: DEFAULT_MESSAGES
    };
```

And change the final `return` of `buildPortalsInjection` from:

```typescript
    return `<script>window.__supersplatPortals = ${payloadJson};</script>` +
        `<script>${companionRuntime}</script>`;
```

to:

```typescript
    return `<style>${companionStyle}</style>` +
        `<script>window.__supersplatPortals = ${payloadJson};</script>` +
        `<script>${companionRuntime}</script>`;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/portals-injection.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/viewer-companion/portals.ts test/portals-injection.test.ts
git commit -m "feat(portals): inject loading-overlay styles into exported viewer"
```

---

### Task 3: Runtime overlay driver (spike-confirmed readiness + wiring)

**Files:**
- Modify: `src/viewer-companion/portals.ts` (the `companionRuntime` IIFE string)

**Interfaces:**
- Consumes: `resolveLoadingMessage` (Task 1, stringified into the runtime), `companionStyle` classes (Task 2), `data.loadingDefaults` (Task 2 payload). Uses existing runtime state: `entities`, `activeIndex`, `getApp`, `applyActive`, the `tick()` loop, and the crossing block at `src/viewer-companion/portals.ts:171-180`.
- Produces: no exported symbol — purely augments the injected runtime. Verified by console spike + release-build E2E (no unit test possible; runtime touches live `pc.AppBase` internals).

This task is runtime-internal and cannot be unit-tested (same constraint the portal Task 8/9 work hit). **Step 1 is a console spike that confirms the one unknown — the active-splat-count property path — before the wiring is finalized.**

- [ ] **Step 1: Console spike — confirm the active-splat-count property path**

Produce a real streaming multi-scene export to test against:

```bash
npm run build
```

Then, in the running app, export a portal scene as a **streaming** ZIP package (two+ scenes referenced by portals, streaming toggle ON), unzip it, and serve the folder over HTTP (e.g. `npx http-server . -p 8080`). Open the viewer, cross a portal into a never-visited scene, and in the browser console inspect the freshly enabled gsplat to find the resident-splat count. Run, in order, until one returns a number that is `0` immediately after enabling and `> 0` once the scene visibly resolves:

```js
// `app` and the extra-scene entity, reached the same way the runtime does:
const v = window.__supersplatViewer;
const app = (v.debugPanel && v.debugPanel._global && v.debugPanel._global.app) || (v.navCursor && v.navCursor.app);
const e = app.root.findByName('portalScene1'); // the entity the runtime names per extra scene
const gs = e && e.gsplat;
// Candidate property paths — log each:
console.log('a', gs && gs.instance && gs.instance.activeSplats);
console.log('b', gs && gs.instance && gs.instance.numSplats);
console.log('c', gs && gs.instance && gs.instance.meshInstance && gs.instance.meshInstance.gsplat && gs.instance.meshInstance.gsplat.activeSplats);
console.log('d', app.scene.gsplat && app.scene.gsplat.activeSplats);
```

Record the winning expression. In the wiring below it is written as `readySplatCount`'s body — replace the placeholder expression there with the confirmed one. Expected: exactly one candidate transitions `0 → >0` as the scene streams in.

- [ ] **Step 2: Add the resolver + overlay state into the runtime**

In `src/viewer-companion/portals.ts`, inside the `companionRuntime` template string. First, after the existing stringified helpers (the `resolveActiveSplat` line at `:15`), add the message resolver and resolved label:

```javascript
  var resolveLoadingMessage = ${resolveLoadingMessage.toString()};
  var loadingText = resolveLoadingMessage('', data.loadingDefaults || {}, navigator.language || 'en');
```

Then, after the `var lastSafe = null;` declaration (`:22`), add the overlay state + DOM + helpers:

```javascript
  // --- streaming loading overlay ---------------------------------------
  // First crossing into a streaming scene enables an entity whose splat data
  // has not streamed yet (LOD is camera-driven; disabled scenes stream
  // nothing), so the viewer briefly shows its clear color. Cover that with a
  // backdrop+spinner+label until the scene reports resident splats.
  var readyScenes = {};            // scene index -> true once renderable
  var pendingIndex = null;         // scene index currently showing the overlay
  var pendingFrames = 0;           // frames the current overlay has been up
  var LOADING_MAX_FRAMES = 600;    // ~10s safety cap (rAF-counted; no Date.now)

  var lBackdrop = document.createElement('div');
  lBackdrop.className = 'ss-portal-loading-backdrop';
  var lSpinner = document.createElement('div');
  lSpinner.className = 'ss-portal-loading-spinner';
  var lLabel = document.createElement('div');
  lLabel.className = 'ss-portal-loading-label';
  lLabel.textContent = loadingText;
  lBackdrop.appendChild(lSpinner);
  lBackdrop.appendChild(lLabel);
  function mountLoading() { document.body.appendChild(lBackdrop); }
  if (document.body) mountLoading(); else document.addEventListener('DOMContentLoaded', mountLoading);
  function showLoading() { lBackdrop.classList.add('active'); }
  function hideLoading() { lBackdrop.classList.remove('active'); }

  // Resident-splat count for scene idx's gsplat. PROPERTY PATH CONFIRMED BY
  // THE TASK 3 SPIKE - replace the expression below with the winning candidate.
  function readySplatCount(idx) {
    var e = entities[idx];
    if (!e || !e.gsplat) return 0;
    var gs = e.gsplat;
    return (gs.instance && gs.instance.activeSplats) || 0; // <-- spike-confirmed path
  }
```

- [ ] **Step 3: Trigger the overlay on a crossing into a not-ready scene**

In the crossing block at `src/viewer-companion/portals.ts:175-179`, extend the body that runs when a crossing is accepted. Change:

```javascript
          if (next !== activeIndex && next !== null && entities[next]) {
            activeIndex = next;
            applyActive();
            swapCollision(next);
          }
```

to:

```javascript
          if (next !== activeIndex && next !== null && entities[next]) {
            activeIndex = next;
            applyActive();
            swapCollision(next);
            // Show the loading overlay if the just-entered scene has no
            // resident splats yet (first visit). Ready scenes never re-show.
            if (!readyScenes[next] && readySplatCount(next) === 0) {
              pendingIndex = next;
              pendingFrames = 0;
              showLoading();
            }
          }
```

- [ ] **Step 4: Poll + clear the overlay each frame**

Still in `tick()`, immediately before the closing `requestAnimationFrame(tick);` (i.e. after the `try/catch` block at `:185`, before `:186`), add the poll/clear logic. It must sit **outside** the camera-pose `if` but **inside** `tick()` so it runs every frame:

```javascript
    // Advance the loading overlay (outside the pose guard so it polls every
    // frame). Force renders while pending so streaming + polling keep going.
    if (pendingIndex !== null) {
      pendingFrames++;
      var app2 = getApp(window.__supersplatViewer);
      if (app2) app2.renderNextFrame = true;
      if (readySplatCount(pendingIndex) > 0 || pendingFrames > LOADING_MAX_FRAMES) {
        readyScenes[pendingIndex] = true;
        hideLoading();
        pendingIndex = null;
      }
    }
```

Note: the `try { … } catch` in `tick()` wraps the crossing logic; this poll block is added after that catch but before the `requestAnimationFrame(tick)` call, so a transient `readySplatCount` error cannot leave the overlay stuck (the safety cap still fires) and cannot kill the loop.

- [ ] **Step 5: Build and run the release-build E2E walkthrough**

Run: `npm run build`
Then re-export the streaming multi-scene ZIP from the freshly built app, serve it, and verify in the browser:
- Crossing a portal into a **never-visited** streaming scene shows the dark backdrop + spinner + localized "Loading…" label, which disappears the moment the scene resolves.
- Re-crossing into that same scene shows **no** overlay (instant).
- A **non-streaming** (SOG) export shows no overlay on any crossing.
- The overlay never blocks navigation (you can keep moving), and it never stays stuck (even if you force a slow network via DevTools throttling, it clears within the safety cap).

Expected: all four behaviors hold. (This is manual E2E — there is no automated assertion for runtime-internal behavior, matching the prior portal tasks.)

- [ ] **Step 6: Commit**

```bash
git add src/viewer-companion/portals.ts
git commit -m "feat(portals): show loading overlay during first streaming-scene crossing"
```

---

## Self-Review

**Spec coverage:**
- §3 "overlay only when not renderable" → Task 3 Step 3 (`readySplatCount(next) === 0` gate) + Step 4 (clear when `> 0`). ✓
- §3 "shown once per scene" → `readyScenes` set, Task 3 Steps 2–4. ✓
- §3 overlay style (backdrop + CSS spinner + localized label, 200ms) → Task 2 `companionStyle`, Task 1 messages. ✓
- §3 localization via `navigator.language` → Task 1 resolver + Task 3 Step 2 `loadingText`. ✓
- §3 non-blocking (`pointer-events: none`) → Task 2 `.ss-portal-loading-backdrop`. ✓
- §5 `readySplatCount` isolating the `activeSplats` uncertainty + spike → Task 3 Step 1 + Step 2. ✓
- §5 `readyScenes`, `pendingIndex`/`pendingFrames`, frame-counted safety cap → Task 3 Steps 2–4. ✓
- §5 folded into existing `tick()` loop, force `renderNextFrame` while pending → Task 3 Step 4. ✓
- §7 stays inside `try/catch`; safety cap guarantees clear → Task 3 Step 4 + note. ✓
- §8 unit test for `resolveLoadingMessage`; console spike; release-build E2E → Task 1 Step 1, Task 3 Step 1, Task 3 Step 5. ✓

**Placeholder scan:** The only intentional "replace this" is Task 3 Step 2's `readySplatCount` body, which Step 1 (the spike) resolves first and explicitly instructs to replace. Every other step has complete code. No TBD/TODO. ✓

**Type/name consistency:** `resolveLoadingMessage` / `DEFAULT_MESSAGES` (Task 1) match their import and runtime use (Tasks 2–3). `companionStyle` class names (`ss-portal-loading-backdrop`, `ss-portal-loading-spinner`, `ss-portal-loading-label`, `ss-portal-spin`) match the DOM `className`s in Task 3 Step 2. `loadingDefaults` payload field (Task 2) matches `data.loadingDefaults` read (Task 3 Step 2). `readyScenes` / `pendingIndex` / `pendingFrames` / `readySplatCount` used consistently across Task 3 Steps 2–4. ✓

---

## As-built deviations (post-spike + user feedback)

Tasks 1 and 2 shipped as written. **Task 3's readiness mechanism changed** after the Step-1 console spike disproved its premise — see the spec's **§2b (As-built design)** for the authoritative final mechanism. In short:

- **No per-scene splat count exists** for unified/streaming gsplats, so `readySplatCount(idx)` (Task 3) was replaced by the **global** `app.renderer._gsplatCount` (valid as a per-scene proxy under the one-scene-enabled invariant), with a `crossedBelow` guard for the post-swap frame-lag.
- **Reveal threshold = a chosen LOD level's exact splat count** (`portalSceneLodCounts[next][len-1-REVEAL_LOD]`, `REVEAL_LOD=1`), which required a follow-on export-pipeline change (Task A) to bake per-LOD counts into the payload — beyond this plan's single-file scope. This replaced an interim `floor × REVEAL_FACTOR` heuristic.
- Plateau detection + a frame-count safety cap remain the fallbacks; the poll block degrades to `endLoading()` on error.
- **Streaming-only** (SOG exports never show the overlay), **`SHOW_DELAY = 0`** (show immediately), and the **start scene is pre-marked ready**.

Commits: `68efb14` (T1), `fb2ddcd` (T2), `88322cc`+`2e2afea`+`d0afcb9`+`0e4a1a3`+`cd5262c`+`a8962d3` (T3 + as-built rework + export plumbing). Each task/rework was reviewed clean; the final combined review (`0e4a1a3..a8962d3`) approved with no Critical/Important findings. User-verified E2E on a release build with `REVEAL_LOD=1`.
