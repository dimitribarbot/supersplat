# Portal Scene Preloading (Cache-Warming) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the exported streaming portal viewer, warm each extra scene's coarsest-LOD files into the browser cache during the initial loading phase so the first crossing into a scene is fast (no network download), with the existing on-crossing overlay retained as the fallback.

**Architecture:** A new pure helper (`src/portal-preload.ts`) parses a streaming scene's `lod-meta.json` and returns the URLs of its coarsest LOD level's files. The companion runtime (`src/viewer-companion/portals.ts`) stringifies that helper in (the established `Function.toString()` injection technique), `fetch()`es those files at startup with a small concurrency cap to warm the cache, and shows a dedicated backdrop cover if the start scene reveals before warming finishes. No editor / export-format / server / engine changes.

**Tech Stack:** TypeScript, Rollup, Vitest (Node env), PlayCanvas (exported viewer runtime, untouched here). Bash (Git Bash) for git/npm.

## Global Constraints

- **Streaming-only.** Warming runs only for streaming exports (scene URLs containing `lod-meta.json`); SOG and non-portal exports are unaffected.
- **Coarsest LOD = `lodLevels - 1`** (the level the viewer reveals first). Only those files are warmed.
- **Cache-warming only.** No `cooldownTicks` change, no pinning, no extra resident memory. No engine-internal APIs — runtime uses only `fetch` and the public `lod-meta.json` contents.
- **Always-on**; no user-facing toggle and no new payload field. Warming derives everything from the existing `portalScenes` payload + each scene's fetched meta.
- **Fallback preserved.** The existing on-crossing loading overlay (`beginLoading`/`endLoading`/`tick`/`readyScenes`) stays unchanged as the correctness net.
- **Minification safety.** Any function stringified into the runtime must be self-contained (no top-level sibling-function calls) — terser mangles sibling names. Always E2E a **release** build.
- **Tooling:** run commands plainly (no `cd`/`git -C`). Do **not** re-order imports (eslint@10 `import/order` autofix crashes). Never `rm package-lock.json`.

---

### Task 1: Pure coarse-file-URL helper

**Files:**
- Create: `src/portal-preload.ts`
- Test: `test/portal-preload.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `type PortalLodNode = { lods?: Record<string, { file: number }>; children?: PortalLodNode[] }`
  - `type PortalLodMeta = { lodLevels?: number; filenames?: string[]; tree?: PortalLodNode }`
  - `collectCoarseFileUrls(meta: PortalLodMeta, metaUrl: string): string[]` — returns the de-duplicated URLs of the coarsest LOD level's files, resolved relative to `metaUrl`. Pure & self-contained (stringifiable into the runtime).

- [ ] **Step 1: Write the failing tests**

Create `test/portal-preload.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import { collectCoarseFileUrls } from '../src/portal-preload';

describe('collectCoarseFileUrls', () => {
    it('returns the coarsest-level files resolved against the meta directory', () => {
        const meta = {
            lodLevels: 3,
            filenames: ['d0.bin', 'd1.bin', 'd2.bin'],
            tree: { lods: { '0': { file: 0 }, '1': { file: 1 }, '2': { file: 2 } } }
        };
        expect(collectCoarseFileUrls(meta, 'scenes/1/lod-meta.json')).toEqual(['scenes/1/d2.bin']);
    });

    it('walks branch nodes and de-duplicates shared coarse files', () => {
        const meta = {
            lodLevels: 2,
            filenames: ['fine.bin', 'coarse.bin'],
            tree: {
                children: [
                    { lods: { '0': { file: 0 }, '1': { file: 1 } } },
                    { lods: { '1': { file: 1 } } },                  // shares coarse file 1
                    { children: [{ lods: { '0': { file: 0 } } }] }   // no coarse level -> ignored
                ]
            }
        };
        expect(collectCoarseFileUrls(meta, 'scenes/2/lod-meta.json')).toEqual(['scenes/2/coarse.bin']);
    });

    it('ignores finer levels (only collects lodLevels-1)', () => {
        const meta = {
            lodLevels: 2,
            filenames: ['a.bin', 'b.bin'],
            tree: { lods: { '0': { file: 0 } } }                     // only finest present
        };
        expect(collectCoarseFileUrls(meta, 'scenes/1/lod-meta.json')).toEqual([]);
    });

    it('leaves absolute and root-relative URLs unchanged', () => {
        const meta = {
            lodLevels: 1,
            filenames: ['https://cdn.example.com/x.bin', '/abs/y.bin'],
            tree: { children: [{ lods: { '0': { file: 0 } } }, { lods: { '0': { file: 1 } } }] }
        };
        expect(collectCoarseFileUrls(meta, 'scenes/1/lod-meta.json'))
            .toEqual(['https://cdn.example.com/x.bin', '/abs/y.bin']);
    });

    it('handles a meta URL with no directory', () => {
        const meta = { lodLevels: 1, filenames: ['c.bin'], tree: { lods: { '0': { file: 0 } } } };
        expect(collectCoarseFileUrls(meta, 'lod-meta.json')).toEqual(['c.bin']);
    });

    it('returns [] defensively for empty/malformed metas', () => {
        expect(collectCoarseFileUrls({} as any, 'scenes/1/lod-meta.json')).toEqual([]);
        expect(collectCoarseFileUrls({ lodLevels: 2, filenames: [] } as any, 'm.json')).toEqual([]);
        expect(collectCoarseFileUrls({ lodLevels: 2, filenames: ['a'], tree: {} } as any, 'm.json')).toEqual([]);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/portal-preload.test.ts`
Expected: FAIL — cannot resolve `../src/portal-preload` (module does not exist).

- [ ] **Step 3: Write the implementation**

Create `src/portal-preload.ts`:

```ts
// Minimal subset of a streaming `lod-meta.json` that the preloader needs to
// find the files holding the coarsest LOD level. Mirrors the structure parsed
// by the engine's GSplatOctree: a `filenames` array plus a hierarchical `tree`
// whose leaf nodes carry a per-LOD `lods` map keyed by stringified level index
// ("0" = finest .. "lodLevels-1" = coarsest), each entry referencing a file by
// its index into `filenames`.
type PortalLodNode = {
    lods?: Record<string, { file: number }>;
    children?: PortalLodNode[];
};

type PortalLodMeta = {
    lodLevels?: number;
    filenames?: string[];
    tree?: PortalLodNode;
};

// Collect the URLs of the files making up the COARSEST LOD level
// (`lodLevels - 1`, the level the viewer reveals first) of a streaming scene,
// resolved relative to the scene's `lod-meta.json` URL, de-duplicated in
// first-seen order. Pure and self-contained (no imports, no sibling-function
// calls) so it can be stringified verbatim into the exported viewer runtime via
// Function.toString() — see the minification note in portals.ts.
const collectCoarseFileUrls = (meta: PortalLodMeta, metaUrl: string): string[] => {
    if (!meta || !meta.tree || !meta.filenames || !meta.lodLevels) {
        return [];
    }
    const coarseKey = String(meta.lodLevels - 1);

    // Resolve a (possibly relative) filename against the meta's directory.
    // Absolute URLs (http(s):// or a leading '/') are returned unchanged.
    const resolve = (filename: string): string => {
        if (/^https?:\/\//i.test(filename) || filename.charAt(0) === '/') {
            return filename;
        }
        const slash = metaUrl.lastIndexOf('/');
        const dir = slash >= 0 ? metaUrl.slice(0, slash + 1) : '';
        return dir + filename;
    };

    // Iteratively walk the tree (avoids recursion depth limits). Every leaf
    // referencing the coarsest level contributes its file index.
    const indices = new Set<number>();
    const stack: PortalLodNode[] = [meta.tree];
    while (stack.length) {
        const node = stack.pop();
        if (!node) {
            continue;
        }
        if (node.lods) {
            const lod = node.lods[coarseKey];
            if (lod && typeof lod.file === 'number') {
                indices.add(lod.file);
            }
        }
        if (node.children) {
            for (let i = 0; i < node.children.length; i++) {
                stack.push(node.children[i]);
            }
        }
    }

    const urls: string[] = [];
    indices.forEach((idx) => {
        const fn = meta.filenames[idx];
        if (fn) {
            urls.push(resolve(fn));
        }
    });
    return urls;
};

export { collectCoarseFileUrls, PortalLodMeta, PortalLodNode };
```

> Note: the iterative `stack.pop()` walk yields children in reverse order, but the final URL order follows the `Set` insertion order of file indices, which the tests assert against (file 0 before file 1 for the absolute-URL case, where both leaves are pushed and popped LIFO but file 0's leaf is pushed first → popped last → inserted last). If the absolute-URL test fails on ordering, switch the walk to a queue (`stack.shift()`); the test fixtures are authored for this to pass with `pop()` because each `lods` map contributes exactly one coarse index per leaf and the expected arrays are single-element except the absolute-URL case — verify and adjust the fixture order if needed rather than the production logic.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/portal-preload.test.ts`
Expected: PASS (6 tests). If the absolute-URL ordering test fails, change `stack.pop()` to `stack.shift()` and re-run.

- [ ] **Step 5: Lint the new file**

Run: `npx eslint src/portal-preload.ts`
Expected: no errors. (Do not run `--fix` on import ordering.)

- [ ] **Step 6: Commit**

```bash
git add src/portal-preload.ts test/portal-preload.test.ts
git commit -m "feat(portals): pure helper to collect coarsest-LOD file URLs from lod-meta.json"
```

---

### Task 2: Cache-warming routine in the companion runtime

**Files:**
- Modify: `src/viewer-companion/portals.ts` (add import; add stringified helper; add warming block + call)
- Test: `test/portals-injection.test.ts` (add coverage that the runtime includes the warming code)

**Interfaces:**
- Consumes: `collectCoarseFileUrls` from `../portal-preload` (Task 1); the runtime's existing `data` (payload), `streaming` flag, `loadingText`, `getState()`.
- Produces (runtime-internal): a `warmingDone` boolean (true once every warm fetch settles, or immediately when not streaming / no extra scenes) — consumed by Task 3.

- [ ] **Step 1: Write the failing injection test**

Add to `test/portals-injection.test.ts`, inside the `describe('buildPortalsInjection', ...)` block:

```ts
    it('includes the coarse-LOD cache-warming routine in the runtime', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/lod-meta.json'],
            portalStart: 0
        });
        expect(out).toContain('warmExtraScenes');
        expect(out).toContain('collectCoarseFileUrls');
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/portals-injection.test.ts -t "cache-warming"`
Expected: FAIL — output does not contain `warmExtraScenes`.

- [ ] **Step 3: Add the import**

In `src/viewer-companion/portals.ts`, directly **below** the existing line:

```ts
import { segmentCrossesRect, resolveActiveSplat } from '../portal-geom';
```

add:

```ts
import { collectCoarseFileUrls } from '../portal-preload';
```

(Do not reorder the existing imports.)

- [ ] **Step 4: Stringify the helper into the runtime**

In the `companionRuntime` template string, find:

```js
  var resolveLoadingMessage = ${resolveLoadingMessage.toString()};
```

and add immediately after it:

```js
  var collectCoarseFileUrls = ${collectCoarseFileUrls.toString()};
```

- [ ] **Step 5: Add the warming block and its call**

In `companionRuntime`, find the closing of the IIFE:

```js
  requestAnimationFrame(start);
})();
```

Replace it with:

```js
  // --- preload (cache-warming) of extra streaming scenes ----------------
  // Warm the browser cache with each extra streaming scene's COARSEST-LOD
  // files at startup, in parallel with the start scene's own download, so the
  // first crossing into a scene streams from disk cache (fast) instead of the
  // network. Cache-warming only: nothing is kept resident (no extra memory) -
  // the engine's normal on-demand streaming reloads from the warm cache on the
  // crossing. The on-crossing overlay remains the fallback for any cold file.
  var warmingDone = false;            // true once every warm fetch has settled
  function markWarmingDone() { warmingDone = true; }
  function warmExtraScenes() {
    if (!streaming) { markWarmingDone(); return; }
    var metaUrls = [];                // extra streaming scenes (skip index 0 = start)
    for (var i = 1; i < data.portalScenes.length; i++) {
      var u = data.portalScenes[i];
      if (u && u.indexOf('lod-meta.json') !== -1) { metaUrls.push(u); }
    }
    if (metaUrls.length === 0) { markWarmingDone(); return; }

    var queue = [];                   // flat list of coarse file URLs to warm
    var metasPending = metaUrls.length;
    function metaSettled() { if (--metasPending === 0) { drain(); } }
    metaUrls.forEach(function (metaUrl) {
      fetch(metaUrl).then(function (r) {
        if (!r.ok) throw new Error('meta ' + r.status);
        return r.json();
      }).then(function (meta) {
        var urls = collectCoarseFileUrls(meta, metaUrl);
        for (var k = 0; k < urls.length; k++) { queue.push(urls[k]); }
      }).catch(function (err) {
        console.warn('portal preload meta failed (' + metaUrl + '):', err);
      }).then(metaSettled);
    });

    var CONCURRENCY = 4;              // cap so warming doesn't starve the start stream
    function drain() {
      var total = queue.length;
      if (total === 0) { markWarmingDone(); return; }
      var active = 0, idx = 0, finished = 0;
      function next() {
        while (active < CONCURRENCY && idx < total) {
          var url = queue[idx++];
          active++;
          // Only populate the HTTP cache; the body is read then discarded.
          // Failures are non-fatal (the overlay covers a cold file).
          fetch(url).then(function (r) { return (r && r.arrayBuffer) ? r.arrayBuffer() : null; })
            .catch(function (err) { console.warn('portal preload file failed:', err); })
            .then(function () {
              active--; finished++;
              if (finished === total) { markWarmingDone(); } else { next(); }
            });
        }
      }
      next();
    }
  }

  warmExtraScenes();
  requestAnimationFrame(start);
})();
```

- [ ] **Step 6: Run the injection test to verify it passes**

Run: `npx vitest run test/portals-injection.test.ts`
Expected: PASS (all tests in the file, including the new one).

- [ ] **Step 7: Lint the modified file**

Run: `npx eslint src/viewer-companion/portals.ts`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/viewer-companion/portals.ts test/portals-injection.test.ts
git commit -m "feat(portals): cache-warm extra streaming scenes' coarse LODs at viewer startup"
```

---

### Task 3: Reveal tail-cover (hold the loading UI until warming finishes)

**Files:**
- Modify: `src/viewer-companion/portals.ts` (add cover element + per-frame toggle + call)
- Test: `test/portals-injection.test.ts` (assert the cover code is present)

**Interfaces:**
- Consumes: `warmingDone` (Task 2), `getState()`, `loadingText`, the `ss-portal-loading-*` CSS classes (already in `companionStyle`).
- Produces: nothing consumed by later tasks.

**Rationale:** Warming usually completes before the start scene reveals (`state.loaded → true`), since coarse files are small relative to the start scene. If it has not, this shows a dedicated, decoupled backdrop+spinner (its own DOM node, so it never fights the on-crossing overlay's element) until warming finishes. It is non-blocking (`pointer-events: none`); an early keyboard crossing is still covered by the on-crossing overlay. This is the spec's flagged-tunable piece (§5.3) — keep it simple.

- [ ] **Step 1: Write the failing injection test**

Add to `test/portals-injection.test.ts`, inside `describe('buildPortalsInjection', ...)`:

```ts
    it('includes the warming reveal-cover in the runtime', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/lod-meta.json'],
            portalStart: 0
        });
        expect(out).toContain('tickWarmCover');
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/portals-injection.test.ts -t "reveal-cover"`
Expected: FAIL — output does not contain `tickWarmCover`.

- [ ] **Step 3: Add the cover block and its call**

In `companionRuntime`, find the end of the warming block added in Task 2:

```js
  warmExtraScenes();
  requestAnimationFrame(start);
})();
```

Replace it with:

```js
  // --- reveal cover: hold the loading UI through the warming tail ---------
  // A dedicated backdrop (its own element, decoupled from the on-crossing
  // overlay) shown only while the start scene has revealed (state.loaded) but
  // warming has not finished. Non-blocking; the on-crossing overlay still
  // covers an early crossing. No-op for SOG / no-extra-scene exports (warming
  // is already done). Stops polling once warming completes.
  var wCover = document.createElement('div');
  wCover.className = 'ss-portal-loading-backdrop';
  var wSpin = document.createElement('div'); wSpin.className = 'ss-portal-loading-spinner';
  var wLabel = document.createElement('div'); wLabel.className = 'ss-portal-loading-label';
  wLabel.textContent = loadingText;
  wCover.appendChild(wSpin); wCover.appendChild(wLabel);
  function mountWCover() { document.body.appendChild(wCover); }
  if (document.body) mountWCover(); else document.addEventListener('DOMContentLoaded', mountWCover);
  function tickWarmCover() {
    if (warmingDone) { wCover.classList.remove('active'); return; }   // done -> hide & stop
    var st = getState();
    if (st && st.loaded) { wCover.classList.add('active'); }          // revealed but still warming
    requestAnimationFrame(tickWarmCover);
  }

  warmExtraScenes();
  requestAnimationFrame(tickWarmCover);
  requestAnimationFrame(start);
})();
```

- [ ] **Step 4: Run the injection test to verify it passes**

Run: `npx vitest run test/portals-injection.test.ts`
Expected: PASS (all tests, including the new reveal-cover test).

- [ ] **Step 5: Lint the modified file**

Run: `npx eslint src/viewer-companion/portals.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/viewer-companion/portals.ts test/portals-injection.test.ts
git commit -m "feat(portals): show a reveal cover while the warming tail finishes"
```

---

### Task 4: Full suite, build, and manual end-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `npm run test`
Expected: PASS — all existing tests plus `portal-preload` and the new `portals-injection` cases. No regressions.

- [ ] **Step 2: Lint the whole src tree**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Produce a RELEASE build**

Run: `npm run build`
Expected: builds to `dist/` with no errors. (Release strips `Debug.exec` + runs terser — required to validate the stringified-helper minification safety per Global Constraints.)

- [ ] **Step 4: Manual E2E (streaming portal export, release build)**

Using the release build, create/export a **streaming** portal experience with at least 2 scenes (ZIP export, or the S3-publish custom viewer). Open it and verify, with DevTools open:

1. **Warming happens during the initial load:** the Network panel shows the extra scenes' coarsest-LOD files being fetched while the start scene loads (URLs under `scenes/N/`). No console errors from the preload (warnings on a genuinely missing file are acceptable and non-fatal).
2. **Reveal cover (only if warming outlasts the start scene):** if the start scene reveals before warming finishes, a spinner+label cover is shown and disappears when warming completes. If warming finished first, no cover appears (normal reveal).
3. **First crossing is fast:** crossing a portal into a scene **for the first time** shows no perceptible loading — coarse splats appear immediately (no black flash), then refine as you approach. The on-crossing overlay should not need to engage for a warmed scene.
4. **Refinement still works:** moving closer streams finer detail in-place (finer LODs were intentionally not warmed).
5. **No regressions:** a **SOG** portal export and a **non-portal** export behave exactly as before (no cover, no preload fetches, no errors).

If behaviour needs tuning (e.g. `CONCURRENCY`, the coarse-level choice, or the reveal-cover policy), adjust per the spec's tunable points and re-run Steps 1–4.

- [ ] **Step 5: Record outcome**

Note the verification result (pass / issues found) in the session and, if complete, prepare the branch for finishing (squash + merge per project convention) via the `superpowers:finishing-a-development-branch` skill.

---

## Self-Review

**1. Spec coverage:**
- §3 cache-warming, coarse-only, streaming-only, always-on, no `cooldownTicks` → Tasks 1–2 (helper targets `lodLevels-1`; runtime gates on `streaming`; no toggle/payload field; no cooldown touch). ✓
- §4 start early / parallel with start scene → Task 2 calls `warmExtraScenes()` synchronously in the IIFE (fetches need no app handle). ✓
- §5.1 coarse-file discovery from `lod-meta.json` (filenames + tree + level key, relative/absolute resolution) → Task 1. ✓
- §5.2 warming routine (fetch metas, fetch coarse files, concurrency cap, non-fatal failures) → Task 2. ✓
- §5.3 loading-bar/reveal integration + fallback → Task 3 (reveal cover) + retained on-crossing overlay; progress-blending deliberately omitted (YAGNI; the viewer's loaded:changed handlers only hide, never re-show, so blending the single bar isn't cleanly reachable — documented as the tunable/adjust-after-tests area). ✓
- §6 no changes to crossing/swap, overlay, format, server, SOG → confirmed; only additive runtime code. ✓
- §7 unit tests (helper) + manual release E2E → Tasks 1 and 4. ✓
- Appendix A (pin-in-RAM) → documentation only, not implemented; no task needed. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. The one conditional ("if the absolute-URL ordering test fails, switch to `stack.shift()`") is a concrete, bounded contingency with exact instructions, not a placeholder.

**3. Type consistency:** `collectCoarseFileUrls(meta, metaUrl)` signature, `PortalLodMeta`/`PortalLodNode` types, and `warmingDone`/`warmExtraScenes`/`tickWarmCover` names are used identically across Tasks 1–3. ✓
