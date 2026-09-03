# Annotation Translations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an author translate an annotation's title, text, link URL and image captions into the editor's nine locales, and have the exported viewer show each visitor the annotation in their own language (`?lang=` first, then the browser).

**Architecture:** Translations are stored per annotation as `translations: Record<localeCode, {title?, text?, url?, captions?}>`, persisted in `.ssproj`, and exported into the annotation's `extras.i18n`. In the exported viewer a new companion resolves the visitor's language once and mutates `viewer.global.settings.annotations[i]` **in place** — which localizes the annotation navigator, the link chip and the gallery captions for free, because all three read those objects live. Only the tooltip needs an explicit DOM write, because the engine's `Annotation` instances copy title/text at construction. One shared, pure language resolver backs every companion.

**Tech Stack:** TypeScript (bundler resolution, `strictNullChecks: false`), PCUI for editor UI, i18next for editor strings, Rollup, Vitest (Node environment), PlayCanvas engine (editor only — companions are engine-free).

**Spec:** `docs/superpowers/specs/2026-09-03-annotation-translations-design.md`

## Global Constraints

- **Locale set (exactly these nine codes, in this order):** `en`, `de`, `es`, `fr`, `ja`, `ko`, `pt-BR`, `ru`, `zh-CN`. They match both `i18n.languages` in `src/ui/localization.ts` and the exported viewer's own dictionaries.
- **Language resolution rule (must match upstream's `detectLocale` exactly):** for each candidate in order — exact tag (case-insensitive) → base subtag → any key whose base subtag matches → next candidate; `'en'` if nothing matches. Candidates are `?lang=` followed by `navigator.languages`.
- **Companion template build trap:** files in `src/viewer-companion/` author their runtimes inside TypeScript template literals, which **eat backslash escapes at build time**. Inside those template strings use **no backslash escapes of any kind** (`\d`, `\s`, `\\`, `é`…), **no backticks**, and **no `${`** other than the deliberate `${fn.toString()}` / `${JSON.stringify(constant)}` build-time injections. Parse with ES5 string ops (`indexOf`, `split`, `charAt`, `parseInt`). Write non-ASCII characters as literal UTF-8 glyphs — the exported HTML declares `<meta charset="UTF-8">` and is written through `TextEncoder`.
- **Companion runtimes are engine-free and DOM-only**, and must stay compilable for the Node export server via `dist-shared` (no `import 'playcanvas'` at module scope).
- **Untrusted input is dropped, never repaired.** A project file is untrusted; so is a postMessage payload.
- **Injected payloads are escaped** for a `<script>` context: `<` → `<`, `>` → `>`, `&` → `&`, U+2028 → ` `, U+2029 → ` `.
- **Persistent editor UI strings are bound** via `i18n.bindText` / `i18n.bindOptions`, never assigned literally, or they will not update on a live language switch.
- **Locale JSON files must keep their existing line endings.** Edit `static/locales/*.json` with an editor tool, not a shell script — scripted edits have injected bare LF into these CRLF files before.
- **ESLint is pinned to v10 and crashes on `import/order` autofix.** Do not reorder imports; match the surrounding style.
- **Run Vitest in the foreground, redirected to a file — never piped to `grep`** (it hangs when backgrounded or piped).
- **No `cd` / `git -C` / `npm --prefix` pointing at the current working directory** — it triggers permission prompts. Run commands plainly from the repo root.

**Verification commands** (repo root):

```bash
npx vitest run test/<file>.test.ts        # single suite
npm run test                              # full suite
npm run lint                              # eslint src
```

---

### Task 1: Shared viewer language resolver

The one resolver every companion will share. Pure and self-contained so it can be both unit-tested in Node and injected verbatim into a companion runtime via `Function.toString()` — the same technique `resolveOffLimitsMessage` already uses in `src/viewer-companion/off-limits-zones.ts`.

**Files:**
- Create: `src/viewer-companion/viewer-lang.ts`
- Test: `test/viewer-lang.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `VIEWER_LOCALES: string[]` — the nine codes.
  - `resolveLocale(candidates: string[], keys: string[]): string` — pure.
  - `viewerLangRuntime: string` — a guarded IIFE that sets `window.__ssLang` once. Every later task prepends this string to its own injection.

- [ ] **Step 1: Write the failing test**

Create `test/viewer-lang.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import { resolveLocale, VIEWER_LOCALES, viewerLangRuntime } from '../src/viewer-companion/viewer-lang';

// Execute the injected snippet with window/navigator/URL passed as parameters,
// which shadow the globals of the same name inside the function body. This runs
// the string the exporter actually emits rather than a re-implementation.
const runSnippet = (href: string, languages: string[]): string => {
    const win: any = { location: { href } };
    const nav: any = { languages };
    // eslint-disable-next-line no-new-func
    new Function('window', 'navigator', 'URL', viewerLangRuntime)(win, nav, URL);
    return win.__ssLang;
};

describe('resolveLocale', () => {
    it('matches an exact tag, case-insensitively', () => {
        expect(resolveLocale(['pt-br'], VIEWER_LOCALES)).toBe('pt-BR');
        expect(resolveLocale(['DE'], VIEWER_LOCALES)).toBe('de');
        expect(resolveLocale(['zh-CN'], VIEWER_LOCALES)).toBe('zh-CN');
    });

    it('falls back to the base subtag', () => {
        expect(resolveLocale(['fr-CA'], VIEWER_LOCALES)).toBe('fr');
        expect(resolveLocale(['en-GB'], VIEWER_LOCALES)).toBe('en');
    });

    it('falls back to any region variant sharing the base', () => {
        expect(resolveLocale(['pt'], VIEWER_LOCALES)).toBe('pt-BR');
        expect(resolveLocale(['pt-PT'], VIEWER_LOCALES)).toBe('pt-BR');
        expect(resolveLocale(['zh'], VIEWER_LOCALES)).toBe('zh-CN');
        expect(resolveLocale(['zh-TW'], VIEWER_LOCALES)).toBe('zh-CN');
    });

    it('takes the first candidate that matches anything', () => {
        expect(resolveLocale(['xx', 'ja'], VIEWER_LOCALES)).toBe('ja');
    });

    it('skips empty candidates', () => {
        expect(resolveLocale([null as any, '', 'ko'], VIEWER_LOCALES)).toBe('ko');
    });

    it('falls back to english', () => {
        expect(resolveLocale(['xx'], VIEWER_LOCALES)).toBe('en');
        expect(resolveLocale([], VIEWER_LOCALES)).toBe('en');
        expect(resolveLocale(null as any, VIEWER_LOCALES)).toBe('en');
    });

    it('offers exactly the nine editor locales', () => {
        expect(VIEWER_LOCALES).toEqual(['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'ru', 'zh-CN']);
    });
});

describe('viewerLangRuntime', () => {
    it('constructs via new Function without throwing', () => {
        // Construction (not execution) catches syntax-level breakage in the
        // stringified helper and the IIFE template.
        // eslint-disable-next-line no-new-func
        expect(() => new Function(viewerLangRuntime)).not.toThrow();
    });

    it('survives the template build with no cooked-escape remnants', () => {
        expect(viewerLangRuntime).toContain("searchParams.get('lang')");
        expect(viewerLangRuntime).not.toContain('(d+)');
        expect(viewerLangRuntime).not.toContain('u003c');
    });

    it('prefers ?lang= over the browser languages', () => {
        expect(runSnippet('https://x/?lang=fr', ['de-AT', 'en'])).toBe('fr');
    });

    it('uses the browser languages when ?lang= is absent', () => {
        expect(runSnippet('https://x/', ['de-AT', 'en'])).toBe('de');
    });

    it('falls through an unmatched ?lang= to the browser languages', () => {
        expect(runSnippet('https://x/?lang=xx', ['ja'])).toBe('ja');
    });

    it('sets the language only once', () => {
        const win: any = { location: { href: 'https://x/?lang=fr' }, __ssLang: 'ru' };
        const nav: any = { languages: ['ja'] };
        // eslint-disable-next-line no-new-func
        new Function('window', 'navigator', 'URL', viewerLangRuntime)(win, nav, URL);
        expect(win.__ssLang).toBe('ru');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/viewer-lang.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/viewer-companion/viewer-lang"`.

- [ ] **Step 3: Write the implementation**

Create `src/viewer-companion/viewer-lang.ts`:

```ts
// The one language resolver every fork companion shares.
//
// The exported viewer already localizes its OWN chrome: it reads `?lang=`,
// resolves it against nine locale dictionaries and sets
// document.documentElement.lang. This module reproduces that resolution rule
// exactly, so authored content and viewer chrome can never disagree about which
// language the visitor is in.
//
// Environment-agnostic (compiled for the export server via dist-shared): no DOM
// and no engine at module scope. Only the runtime string below touches window.
//
// BUILD TRAP: template literals in this directory have their backslash escapes
// eaten at build time, so the runtime below contains no regex literals and no
// backslash escapes of any kind.

// The locale codes the editor offers and the exported viewer ships dictionaries
// for. Keep in sync with `i18n.languages` in src/ui/localization.ts.
const VIEWER_LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'ru', 'zh-CN'];

// Pure resolver. The first candidate that matches anything wins:
//   1. exact tag, case-insensitive       'pt-br' -> 'pt-BR'
//   2. base subtag                       'fr-CA' -> 'fr'
//   3. any key whose base subtag matches 'pt'    -> 'pt-BR', 'zh-TW' -> 'zh-CN'
// Falls back to 'en'. Self-contained (no module-level references) so it is also
// injected verbatim into companion runtimes via Function.toString().
const resolveLocale = (candidates: string[], keys: string[]): string => {
    const list = keys || [];
    const wanted = candidates || [];
    for (let i = 0; i < wanted.length; i++) {
        const candidate = wanted[i];
        if (!candidate) {
            continue;
        }
        const lc = String(candidate).toLowerCase();
        const base = lc.split('-')[0];
        const match = list.find(k => k.toLowerCase() === lc) ||
            list.find(k => k.toLowerCase() === base) ||
            list.find(k => k.toLowerCase().split('-')[0] === base);
        if (match) {
            return match;
        }
    }
    return 'en';
};

// Publishes window.__ssLang once, from `?lang=` then the browser's languages.
//
// Guarded, so every injection that needs a language prepends this string to its
// own script with no ordering or duplication concern: an export may carry
// several such companions, and none of them may assume another one ran first.
// The two interpolations are the deliberate build-time kind (a stringified pure
// function and a constant array), not runtime template expressions.
const viewerLangRuntime = `
(function () {
  if (window.__ssLang) return;
  var resolveLocale = ${resolveLocale.toString()};
  var locales = ${JSON.stringify(VIEWER_LOCALES)};
  var param = null;
  try { param = new URL(window.location.href).searchParams.get('lang'); } catch (e) {}
  var nav = navigator.languages || (navigator.language ? [navigator.language] : []);
  window.__ssLang = resolveLocale([param].concat(Array.prototype.slice.call(nav)), locales);
})();
`;

export { VIEWER_LOCALES, resolveLocale, viewerLangRuntime };
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run test/viewer-lang.test.ts
```

Expected: PASS, 12 tests.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/viewer-companion/viewer-lang.ts test/viewer-lang.test.ts
git commit -m "Add shared viewer language resolver"
```

---

### Task 2: Adopt the shared resolver in the existing companions

Six companion runtimes each resolve a language from `navigator.language` on their own, so `?lang=fr` would give a French annotation beside an English "Open link" chip. Point them all at `window.__ssLang` and prepend `viewerLangRuntime` to each injection that needs it.

Note the existing label tables are keyed by **primary subtag** (`pt`, `zh`), and their lookups already do `table[lang] || table[lang.split('-')[0]] || table.en`. So handing them `'pt-BR'` instead of `navigator.language` works unchanged — do **not** rewrite the tables.

**Files:**
- Modify: `src/viewer-companion/annotation-links.ts:54` (and its injection builder)
- Modify: `src/viewer-companion/annotation-gallery.ts:38`
- Modify: `src/viewer-companion/off-limits-zones.ts:71` (and its injection builder)
- Modify: `src/viewer-companion/device-fallback.ts:94` (and its injection builder)
- Modify: `src/viewer-companion/portal-markers.ts:428`
- Modify: `src/viewer-companion/portals.ts:155` (and its injection builder)
- Modify: `src/viewer-companion/quality-mode.ts:268` (and its injection builder)
- Test: `test/viewer-lang.test.ts` (extend)

**Interfaces:**
- Consumes: `viewerLangRuntime` from Task 1.
- Produces: every companion injection now begins with the `window.__ssLang` snippet.

> `annotation-gallery.ts`'s `galleryRuntime` is interpolated *inside* `annotation-links.ts`'s IIFE and has no injection of its own, and `portal-markers.ts`'s runtime is interpolated inside `portals.ts`. Neither needs its own prepend — the enclosing injection supplies the snippet.

- [ ] **Step 1: Write the failing test**

Append to `test/viewer-lang.test.ts`:

```ts
import { buildAnnotationLinksInjection } from '../src/viewer-companion/annotation-links';
import { buildDeviceFallbackInjection } from '../src/viewer-companion/device-fallback';
import { buildOffLimitsZonesInjection } from '../src/viewer-companion/off-limits-zones';
import { buildQualityModeInjection } from '../src/viewer-companion/quality-mode';

describe('companions share one language resolver', () => {
    const linkAnnotation = { title: 'T', text: 'X', extras: { url: 'https://example.com' } };
    const zone = {
        position: [0, 0, 0] as [number, number, number],
        rotation: [0, 0, 0, 1] as [number, number, number, number],
        width: 1,
        height: 1
    };

    const injections: [string, string][] = [
        ['annotation-links', buildAnnotationLinksInjection([linkAnnotation])],
        ['off-limits-zones', buildOffLimitsZonesInjection([zone], '')],
        ['device-fallback', buildDeviceFallbackInjection()],
        ['quality-mode', buildQualityModeInjection()]
    ];

    it.each(injections)('%s publishes window.__ssLang', (_name, injection) => {
        expect(injection).toContain('window.__ssLang =');
    });

    it.each(injections)('%s reads no navigator.language of its own', (_name, injection) => {
        // The label tables stay keyed by primary subtag; only the SOURCE of the
        // language changes. A remaining navigator.language read means one
        // surface would ignore ?lang=.
        expect(injection).not.toContain('navigator.language ||');
    });
});
```

The four builder names above are the real exports (`annotation-links.ts:…`, `off-limits-zones.ts:165`, `device-fallback.ts:189`, `quality-mode.ts:694`). `buildDeviceFallbackInjection` and `buildQualityModeInjection` take no arguments.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/viewer-lang.test.ts
```

Expected: FAIL — the `window.__ssLang =` assertions fail for all four.

- [ ] **Step 3: Point every runtime at `window.__ssLang`**

In each of the six runtime templates, replace the language source only:

| File | Before | After |
|---|---|---|
| `annotation-links.ts:54` | `var navLang = (navigator.language \|\| 'en').toLowerCase();` | `var navLang = (window.__ssLang \|\| 'en').toLowerCase();` |
| `annotation-gallery.ts:38` | `var galleryLang = (navigator.language \|\| 'en').toLowerCase();` | `var galleryLang = (window.__ssLang \|\| 'en').toLowerCase();` |
| `off-limits-zones.ts:71` | `resolveOffLimitsMessage(custom, defaults, navigator.language \|\| 'en')` | `resolveOffLimitsMessage(custom, defaults, window.__ssLang \|\| 'en')` |
| `device-fallback.ts:94` | `var l = (navigator.language \|\| 'en').toLowerCase().split('-')[0];` | `var l = (window.__ssLang \|\| 'en').toLowerCase().split('-')[0];` |
| `portal-markers.ts:428` | `resolveMarkerTooltip(markerTooltips, navigator.language \|\| 'en')` | `resolveMarkerTooltip(markerTooltips, window.__ssLang \|\| 'en')` |
| `portals.ts:155` | `resolveLoadingMessage('', data.loadingDefaults \|\| {}, navigator.language \|\| 'en')` | `resolveLoadingMessage('', data.loadingDefaults \|\| {}, window.__ssLang \|\| 'en')` |
| `quality-mode.ts:268` | `var l = (navigator.language \|\| 'en').toLowerCase();` | `var l = (window.__ssLang \|\| 'en').toLowerCase();` |

Also update the stale comment at `annotation-links.ts:46` (it explains the old `navigator.language` behaviour) to say the language comes from the shared resolver, which honours `?lang=`.

- [ ] **Step 4: Prepend the snippet to each standalone injection**

In `annotation-links.ts`, `off-limits-zones.ts`, `device-fallback.ts`, `portals.ts` and `quality-mode.ts`, import the runtime and prepend it to the returned fragment. For example in `buildAnnotationLinksInjection`:

```ts
import { viewerLangRuntime } from './viewer-lang';
```

and change the return from:

```ts
    return `<style>${companionStyle}${galleryStyle}</style>` +
        `<script>window.__supersplatAnnotationLinks = ${tableJson};</script>` +
        `<script>${companionRuntime}</script>`;
```

to:

```ts
    return `<style>${companionStyle}${galleryStyle}</style>` +
        `<script>${viewerLangRuntime}</script>` +
        `<script>window.__supersplatAnnotationLinks = ${tableJson};</script>` +
        `<script>${companionRuntime}</script>`;
```

Apply the same shape in the other four builders: one extra `<script>${viewerLangRuntime}</script>` immediately before the script that needs it. The snippet is self-guarding, so several injections in one document is fine.

> Any existing test that asserts on the *number* of `<script>` tags in one of these injections will now be off by one. Update the expected count; do not remove the assertion.

- [ ] **Step 5: Run the affected suites**

```bash
npx vitest run test/viewer-lang.test.ts test/annotation-links.test.ts test/annotation-gallery.test.ts test/off-limits-zones-injection.test.ts test/device-fallback-injection.test.ts test/quality-mode-injection.test.ts test/portals-injection.test.ts test/portal-markers.test.ts
```

Expected: PASS. Fix any script-count assertions that shifted by one.

- [ ] **Step 6: Lint and commit**

```bash
npm run lint
git add src/viewer-companion test/viewer-lang.test.ts
git commit -m "Resolve every companion's language through one shared resolver"
```

---

### Task 3: Annotation translations data model and persistence

**Files:**
- Modify: `src/annotations.ts` (types, `docSerialize.annotations`, `docDeserialize.annotations`)
- Test: `test/annotations.test.ts` (extend)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type AnnotationTranslation = { title?: string, text?: string, url?: string, captions?: Record<string, string> }`
  - `AnnotationData.translations: Record<string, AnnotationTranslation>`
  - `TRANSLATION_LOCALES: string[]` — exported from `src/annotations.ts`, the same nine codes, for the dialog in Task 7.

- [ ] **Step 1: Write the failing test**

Append to `test/annotations.test.ts`. Add `translations: {}` to the `annotation()` factory's defaults first, then:

```ts
describe('annotation translations persistence', () => {
    it('round-trips translations through document serialize/deserialize', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        const translations = {
            fr: { title: 'Façade', text: 'Construite en 1890', url: 'https://example.com/fr' },
            de: { title: 'Fassade' }
        };
        events.fire('annotations.insertRaw', annotation({ translations }));

        const doc = events.invoke('docSerialize.annotations');
        expect(doc[0].translations).toEqual(translations);

        events.invoke('docDeserialize.annotations', doc);
        const list = events.invoke('annotations.list');
        expect(list[0].translations).toEqual(translations);
    });

    it('defaults a legacy record with no translations to an empty map', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        events.invoke('docDeserialize.annotations', [{
            id: 'annotation_0',
            position: [0, 0, 0],
            title: 'T',
            text: 'X',
            camera: { position: [0, 0, 0], target: [0, 0, 1], fov: 60 }
        }]);
        expect(events.invoke('annotations.list')[0].translations).toEqual({});
    });

    it('drops unknown locale codes', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        events.invoke('docDeserialize.annotations', [{
            id: 'annotation_0',
            position: [0, 0, 0],
            title: 'T',
            text: 'X',
            camera: { position: [0, 0, 0], target: [0, 0, 1], fov: 60 },
            translations: { fr: { title: 'Façade' }, klingon: { title: 'nuqneH' }, 'fr-CA': { title: 'no' } }
        }]);
        expect(events.invoke('annotations.list')[0].translations).toEqual({ fr: { title: 'Façade' } });
    });

    it('drops non-string field values and malformed caption keys', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        events.invoke('docDeserialize.annotations', [{
            id: 'annotation_0',
            position: [0, 0, 0],
            title: 'T',
            text: 'X',
            camera: { position: [0, 0, 0], target: [0, 0, 1], fov: 60 },
            translations: {
                fr: {
                    title: 'Façade',
                    text: 42,
                    url: { evil: true },
                    captions: { annimg_0: 'Mur nord', '../../evil': 'x', annimg_1: 99 }
                }
            }
        }]);
        expect(events.invoke('annotations.list')[0].translations).toEqual({
            fr: { title: 'Façade', captions: { annimg_0: 'Mur nord' } }
        });
    });

    it('drops a language entry that is not an object', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        events.invoke('docDeserialize.annotations', [{
            id: 'annotation_0',
            position: [0, 0, 0],
            title: 'T',
            text: 'X',
            camera: { position: [0, 0, 0], target: [0, 0, 1], fov: 60 },
            translations: { fr: 'Façade', de: null }
        }]);
        expect(events.invoke('annotations.list')[0].translations).toEqual({});
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/annotations.test.ts
```

Expected: FAIL — `translations` is `undefined` on the deserialized records.

- [ ] **Step 3: Add the types and the sanitizer**

In `src/annotations.ts`, beside the existing `IMAGE_ID_RE` / `isSafeImageRecord` block (which this mirrors), add:

```ts
// Locale codes a translation may be stored under. Same nine the editor UI
// offers (src/ui/localization.ts) and the exported viewer ships dictionaries
// for, so a stored translation always has somewhere to be shown.
const TRANSLATION_LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'ru', 'zh-CN'];

// One language's overrides for an annotation. Every field is optional: a
// missing field falls back to the annotation's base value, per field, so a
// half-finished translation never blanks anything.
type AnnotationTranslation = {
    title?: string,
    text?: string,
    url?: string,
    // imageId -> caption. Keyed by id rather than by list position so
    // reordering or removing an image cannot silently reattach a caption to a
    // different picture.
    captions?: Record<string, string>
};

// A translations map read out of a project file is untrusted input, exactly as
// the image records above are: it is baked into an exported viewer's injected
// <script>, so a hand-crafted .ssproj could otherwise smuggle a non-string or
// an unexpected locale key into that payload. Unknown locales, non-string
// values and caption keys that are not real image ids are DROPPED, never
// repaired.
const sanitizeTranslations = (raw: any): Record<string, AnnotationTranslation> => {
    const out: Record<string, AnnotationTranslation> = {};
    if (!raw || typeof raw !== 'object') {
        return out;
    }
    TRANSLATION_LOCALES.forEach((code) => {
        const entry = raw[code];
        if (!entry || typeof entry !== 'object') {
            return;
        }
        const clean: AnnotationTranslation = {};
        (['title', 'text', 'url'] as const).forEach((field) => {
            if (typeof entry[field] === 'string') {
                clean[field] = entry[field];
            }
        });
        if (entry.captions && typeof entry.captions === 'object') {
            const captions: Record<string, string> = {};
            Object.keys(entry.captions).forEach((imageId) => {
                if (IMAGE_ID_RE.test(imageId) && typeof entry.captions[imageId] === 'string') {
                    captions[imageId] = entry.captions[imageId];
                }
            });
            if (Object.keys(captions).length > 0) {
                clean.captions = captions;
            }
        }
        if (Object.keys(clean).length > 0) {
            out[code] = clean;
        }
    });
    return out;
};

// Deep copy for the undo stack and for the working copy the dialog edits.
// UpdateAnnotationOp snapshots old/new values, so a shared nested object would
// let a later edit mutate a value already recorded in history.
const cloneTranslations = (t: Record<string, AnnotationTranslation>): Record<string, AnnotationTranslation> => {
    const out: Record<string, AnnotationTranslation> = {};
    Object.keys(t || {}).forEach((code) => {
        const entry = t[code];
        out[code] = { ...entry };
        if (entry.captions) {
            out[code].captions = { ...entry.captions };
        }
    });
    return out;
};
```

Add the field to `AnnotationData`, immediately after `images`:

```ts
    // Per-language overrides for title/text/url/captions. Empty for an
    // untranslated annotation; the base fields above are the fallback.
    translations: Record<string, AnnotationTranslation>,
```

- [ ] **Step 4: Serialize and deserialize the field**

In `docSerialize.annotations`, add to the `doc` object literal, after `images`:

```ts
                translations: cloneTranslations(a.translations),
```

In `docDeserialize.annotations`, add to the pushed record, after `images`:

```ts
                    translations: sanitizeTranslations(d.translations),
```

Add `translations?: Record<string, AnnotationTranslation>` to `AnnotationDocData`, and extend the module's `export { … }` with `AnnotationTranslation`, `TRANSLATION_LOCALES` and `cloneTranslations`.

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run test/annotations.test.ts
```

Expected: PASS. If pre-existing tests fail because the `annotation()` factory now needs `translations`, that is the factory edit from Step 1 — confirm it was made.

- [ ] **Step 6: Lint and commit**

```bash
npm run lint
git add src/annotations.ts test/annotations.test.ts
git commit -m "Store per-language annotation translations in the document"
```

---

### Task 4: Export translations into `extras.i18n`

**Files:**
- Modify: `src/annotations.ts` (`annotations.export`)
- Modify: `src/splat-export-core.ts:178-192` (`stripHtmlGalleries`)
- Test: `test/annotations.test.ts` (extend), `test/annotation-links.test.ts` (extend — it already imports `stripHtmlGalleries`)

**Interfaces:**
- Consumes: `AnnotationData.translations` from Task 3.
- Produces: `AnnotationExport.extras.i18n?: Record<string, { title?: string, text?: string, url?: string, captions?: string[] }>` — the shape Tasks 5 and 6 read.

- [ ] **Step 1: Write the failing test**

Append to `test/annotations.test.ts`:

```ts
describe('annotation translations export', () => {
    const exportOne = (over: Partial<AnnotationData>, hasImage: (id: string) => boolean = () => true) => {
        const events = makeEvents(hasImage);
        registerAnnotationsEvents(events);
        events.fire('annotations.insertRaw', annotation(over));
        return events.invoke('annotations.export')[0];
    };

    it('omits i18n entirely when nothing is translated', () => {
        expect(exportOne({}).extras.i18n).toBeUndefined();
    });

    it('emits title and text for every translated language', () => {
        const out = exportOne({
            translations: { fr: { title: 'Façade', text: 'Construite' }, de: { title: 'Fassade' } }
        });
        expect(out.extras.i18n).toEqual({
            fr: { title: 'Façade', text: 'Construite' },
            de: { title: 'Fassade' }
        });
    });

    it('drops empty fields and empty language entries', () => {
        const out = exportOne({
            translations: { fr: { title: '', text: '' }, de: { title: 'Fassade' } }
        });
        expect(out.extras.i18n).toEqual({ de: { title: 'Fassade' } });
    });

    it('emits a translated url only in url mode', () => {
        const base = { url: 'https://example.com/en', translations: { fr: { url: 'https://example.com/fr' } } };
        expect(exportOne({ ...base, linkType: 'url' }).extras.i18n).toEqual({
            fr: { url: 'https://example.com/fr' }
        });
        expect(exportOne({ ...base, linkType: 'none' }).extras.i18n).toBeUndefined();
        expect(exportOne({ ...base, linkType: 'images' }).extras.i18n).toBeUndefined();
    });

    it('emits captions positionally, aligned to the filtered image list', () => {
        // annimg_1's bytes are missing, so it is dropped from extras.images --
        // its caption must be dropped from the same position, or every later
        // caption would describe the wrong picture.
        const images: AnnotationImage[] = [
            { imageId: 'annimg_0', ext: 'jpg', mime: 'image/jpeg', caption: 'North' },
            { imageId: 'annimg_1', ext: 'jpg', mime: 'image/jpeg', caption: 'Gone' },
            { imageId: 'annimg_2', ext: 'jpg', mime: 'image/jpeg', caption: 'Roof' }
        ];
        const out = exportOne({
            linkType: 'images',
            images,
            translations: {
                fr: { captions: { annimg_0: 'Mur nord', annimg_1: 'Disparu', annimg_2: 'Toit' } }
            }
        }, id => id !== 'annimg_1');
        expect(out.extras.images.map((i: any) => i.src)).toEqual([
            'annotations/annimg_0.jpg',
            'annotations/annimg_2.jpg'
        ]);
        expect(out.extras.i18n.fr.captions).toEqual(['Mur nord', 'Toit']);
    });

    it('pads untranslated caption slots and trims the trailing empties', () => {
        const images: AnnotationImage[] = [
            { imageId: 'annimg_0', ext: 'jpg', mime: 'image/jpeg', caption: 'A' },
            { imageId: 'annimg_1', ext: 'jpg', mime: 'image/jpeg', caption: 'B' },
            { imageId: 'annimg_2', ext: 'jpg', mime: 'image/jpeg', caption: 'C' }
        ];
        const out = exportOne({
            linkType: 'images',
            images,
            translations: { fr: { captions: { annimg_1: 'Deux' } } }
        });
        expect(out.extras.i18n.fr.captions).toEqual(['', 'Deux']);
    });

    it('emits captions only in images mode', () => {
        const out = exportOne({
            linkType: 'url',
            url: 'https://example.com',
            images: [{ imageId: 'annimg_0', ext: 'jpg', mime: 'image/jpeg', caption: 'A' }],
            translations: { fr: { captions: { annimg_0: 'Mur nord' } } }
        });
        expect(out.extras.i18n).toBeUndefined();
    });
});
```

Append to `test/annotation-links.test.ts`:

```ts
describe('stripHtmlGalleries and translations', () => {
    it('drops translated captions along with the images', () => {
        const settings = {
            annotations: [{
                title: 'T',
                text: 'X',
                extras: {
                    images: [{ src: 'annotations/annimg_0.jpg', caption: 'North' }],
                    i18n: { fr: { title: 'Façade', captions: ['Mur nord'] } }
                }
            }]
        };
        const out = stripHtmlGalleries(settings);
        expect(out.annotations[0].extras.images).toBeUndefined();
        expect(out.annotations[0].extras.i18n).toEqual({ fr: { title: 'Façade' } });
    });

    it('removes a language entry left empty by dropping its captions', () => {
        const settings = {
            annotations: [{
                title: 'T',
                text: 'X',
                extras: {
                    images: [{ src: 'annotations/annimg_0.jpg', caption: 'North' }],
                    i18n: { fr: { captions: ['Mur nord'] } }
                }
            }]
        };
        expect(stripHtmlGalleries(settings).annotations[0].extras.i18n).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run test/annotations.test.ts test/annotation-links.test.ts
```

Expected: FAIL — `extras.i18n` is `undefined` in every case, and `stripHtmlGalleries` leaves `captions` in place.

- [ ] **Step 3: Build `extras.i18n` in `annotations.export`**

Extend the `AnnotationExport` type's `extras` with:

```ts
        i18n?: Record<string, { title?: string, text?: string, url?: string, captions?: string[] }>
```

Inside the `annotations.map((a) => { … })` callback in `annotations.export`, after `images` is computed, add:

```ts
            // Per-language overrides, emitted alongside the base strings the
            // viewer falls back to.
            //
            // Only the LIVE action is translated, mirroring the isUrl/images
            // rule above: an annotation in 'images' mode must never export the
            // url it still carries, and the same is true of that url's
            // translations.
            //
            // Captions are emitted POSITIONALLY rather than as an imageId map,
            // because imageId does not exist in the export and `images` above
            // is filtered -- index i of `captions` describes index i of
            // `extras.images`. Untranslated slots are '' and a trailing run of
            // empties is trimmed, so a language that translated nothing costs
            // nothing.
            const i18n: Record<string, any> = {};
            Object.keys(a.translations ?? {}).forEach((code) => {
                const t = a.translations[code];
                const entry: any = {};
                if (t.title) {
                    entry.title = t.title;
                }
                if (t.text) {
                    entry.text = t.text;
                }
                if (isUrl && t.url) {
                    entry.url = t.url;
                }
                if (images.length > 0 && t.captions) {
                    const captions = a.images
                    .filter(img => events.invoke('annotationImages.has', img.imageId))
                    .map(img => t.captions[img.imageId] ?? '');
                    while (captions.length > 0 && captions[captions.length - 1] === '') {
                        captions.pop();
                    }
                    if (captions.length > 0) {
                        entry.captions = captions;
                    }
                }
                if (Object.keys(entry).length > 0) {
                    i18n[code] = entry;
                }
            });
```

and add to the returned `extras` object:

```ts
                    i18n: Object.keys(i18n).length ? i18n : undefined,
```

> The `.filter(...)` above repeats the filter used to build `images`. Hoist that filtered array into a local (e.g. `const liveImages = a.images.filter(img => events.invoke('annotationImages.has', img.imageId));`) and use it for both `images` and the caption alignment, so the two can never drift.

- [ ] **Step 4: Strip captions in `stripHtmlGalleries`**

`stripHtmlGalleries` (`src/splat-export-core.ts:178`) currently drops `extras.images`. Extend its per-annotation mapper so it also drops `i18n[*].captions`, and removes a language entry that this leaves empty:

```ts
const stripAnnotationI18nCaptions = (i18n: any): any => {
    if (!i18n) {
        return undefined;
    }
    const out: Record<string, any> = {};
    Object.keys(i18n).forEach((code) => {
        const { captions, ...rest } = i18n[code] ?? {};
        if (Object.keys(rest).length > 0) {
            out[code] = rest;
        }
    });
    return Object.keys(out).length ? out : undefined;
};
```

Call it where the mapper rebuilds `extras`, so a single-file HTML export never carries caption translations for images it does not ship.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run test/annotations.test.ts test/annotation-links.test.ts
```

Expected: PASS.

- [ ] **Step 6: Lint and commit**

```bash
npm run lint
git add src/annotations.ts src/splat-export-core.ts test/annotations.test.ts test/annotation-links.test.ts
git commit -m "Export annotation translations as extras.i18n"
```

---

### Task 5: The annotation-i18n viewer companion

The runtime that makes translations visible. It resolves the language, mutates `viewer.global.settings.annotations[i]` in place — which localizes the annotation navigator, the link chip and the gallery captions for free, since all three read those objects live — and writes the shared tooltip's title/text on `annotation.activate`, because the engine's `Annotation` instances copied title/text at construction.

**Files:**
- Create: `src/viewer-companion/annotation-i18n.ts`
- Modify: `src/splat-export-core.ts` (add `injectAnnotationI18n`, call it in both injection chains)
- Test: `test/annotation-i18n-injection.test.ts`, `test/viewer-html-anchors.test.ts` (extend)

**Interfaces:**
- Consumes: `viewerLangRuntime` (Task 1); `extras.i18n` (Task 4).
- Produces:
  - `hasAnnotationTranslations(annotations: AnyAnnotation[]): boolean`
  - `applyAnnotationTranslation(ann: any, lang: string): void` — pure-ish, exported for tests and injected via `Function.toString()`.
  - `buildAnnotationI18nInjection(annotations: AnyAnnotation[]): string`

- [ ] **Step 1: Write the failing test**

Create `test/annotation-i18n-injection.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import {
    applyAnnotationTranslation,
    buildAnnotationI18nInjection,
    hasAnnotationTranslations
} from '../src/viewer-companion/annotation-i18n';

const translated = () => ({
    title: 'Facade',
    text: 'Built in 1890',
    extras: {
        url: 'https://example.com/en',
        images: [
            { src: 'annotations/annimg_0.jpg', caption: 'North wall' },
            { src: 'annotations/annimg_1.jpg', caption: 'Entrance' }
        ],
        i18n: {
            fr: {
                title: 'Façade',
                text: 'Construite en 1890',
                url: 'https://example.com/fr',
                captions: ['Mur nord']
            },
            de: { title: 'Fassade' }
        }
    }
});

describe('hasAnnotationTranslations', () => {
    it('is false without translations', () => {
        expect(hasAnnotationTranslations([{ title: 'T', extras: {} }])).toBe(false);
        expect(hasAnnotationTranslations([])).toBe(false);
        expect(hasAnnotationTranslations(null as any)).toBe(false);
    });

    it('is true when any annotation carries a non-empty i18n map', () => {
        expect(hasAnnotationTranslations([{ title: 'T', extras: {} }, translated()])).toBe(true);
    });

    it('is false for an i18n map with no languages', () => {
        expect(hasAnnotationTranslations([{ title: 'T', extras: { i18n: {} } }])).toBe(false);
    });
});

describe('applyAnnotationTranslation', () => {
    it('overwrites title, text, url and captions in place', () => {
        const ann = translated();
        applyAnnotationTranslation(ann, 'fr');
        expect(ann.title).toBe('Façade');
        expect(ann.text).toBe('Construite en 1890');
        expect(ann.extras.url).toBe('https://example.com/fr');
        expect(ann.extras.images[0].caption).toBe('Mur nord');
    });

    it('falls back per field, not per language', () => {
        const ann = translated();
        applyAnnotationTranslation(ann, 'de');
        expect(ann.title).toBe('Fassade');
        expect(ann.text).toBe('Built in 1890');
        expect(ann.extras.url).toBe('https://example.com/en');
        expect(ann.extras.images[0].caption).toBe('North wall');
    });

    it('leaves everything alone for an untranslated language', () => {
        const ann = translated();
        applyAnnotationTranslation(ann, 'ja');
        expect(ann.title).toBe('Facade');
        expect(ann.extras.images[0].caption).toBe('North wall');
    });

    it('leaves captions past the end of the array alone', () => {
        const ann = translated();
        applyAnnotationTranslation(ann, 'fr');
        expect(ann.extras.images[1].caption).toBe('Entrance');
    });

    it('ignores an annotation with no extras', () => {
        const ann: any = { title: 'T', text: 'X' };
        expect(() => applyAnnotationTranslation(ann, 'fr')).not.toThrow();
        expect(ann.title).toBe('T');
    });
});

const extractScripts = (injection: string): string[] => {
    const out: string[] = [];
    let from = 0;
    for (;;) {
        const open = injection.indexOf('<script>', from);
        if (open === -1) break;
        const close = injection.indexOf('</script>', open);
        out.push(injection.slice(open + '<script>'.length, close));
        from = close + 1;
    }
    return out;
};

describe('buildAnnotationI18nInjection', () => {
    it('is empty when no annotation is translated', () => {
        expect(buildAnnotationI18nInjection([{ title: 'T', extras: {} }])).toBe('');
    });

    it('publishes the language resolver and the runtime', () => {
        const injection = buildAnnotationI18nInjection([translated()]);
        expect(injection).toContain('window.__ssLang =');
        expect(injection).toContain('annotation.activate');
    });

    it('constructs every script via new Function without throwing', () => {
        // Catches syntax-level breakage in the stringified helpers and the IIFE
        // template -- the failure mode a backtick or a `${` inside the template
        // produces.
        const scripts = extractScripts(buildAnnotationI18nInjection([translated()]));
        expect(scripts.length).toBeGreaterThan(0);
        // eslint-disable-next-line no-new-func
        scripts.forEach(s => expect(() => new Function(s)).not.toThrow());
    });

    it('leaves no cooked-escape remnants', () => {
        const injection = buildAnnotationI18nInjection([translated()]);
        expect(injection).not.toContain('(d+)');
        expect(injection).not.toContain('u003cscript');
    });

    it('rewrites the tooltip and the navigator title on activate', () => {
        const injection = buildAnnotationI18nInjection([translated()]);
        const runtime = extractScripts(injection).pop();

        const tooltipTitle = { textContent: 'Facade' };
        const tooltipText = { textContent: 'Built in 1890' };
        const navTitle = { textContent: 'Facade' };
        const nodes: Record<string, any> = {
            '.pc-annotation-title': tooltipTitle,
            '.pc-annotation-text': tooltipText,
            '#annotationNavTitle': navTitle
        };

        const handlers: Record<string, ((...a: any[]) => void)[]> = {};
        const ann = translated();
        const viewer = {
            global: {
                events: {
                    on: (name: string, fn: any) => {
                        (handlers[name] = handlers[name] ?? []).push(fn);
                    }
                },
                settings: { annotations: [ann] }
            }
        };

        const win: any = { __ssLang: 'fr', __supersplatViewer: viewer };
        const doc: any = {
            readyState: 'complete',
            querySelector: (sel: string) => nodes[sel] ?? null,
            addEventListener: () => {}
        };
        // eslint-disable-next-line no-new-func
        new Function('window', 'document', 'requestAnimationFrame', runtime)(
            win, doc, (fn: any) => fn()
        );

        // settings mutated in place: the navigator and the link/gallery
        // companions read these objects live
        expect(ann.title).toBe('Façade');
        expect(ann.extras.url).toBe('https://example.com/fr');
        expect(navTitle.textContent).toBe('Façade');

        // the tooltip needs the explicit write, because the engine's Annotation
        // instances copied title/text at construction
        handlers['annotation.activate'].forEach(fn => fn(ann));
        expect(tooltipTitle.textContent).toBe('Façade');
        expect(tooltipText.textContent).toBe('Construite en 1890');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/annotation-i18n-injection.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/viewer-companion/annotation-i18n"`.

- [ ] **Step 3: Write the companion**

Create `src/viewer-companion/annotation-i18n.ts`:

```ts
import { viewerLangRuntime } from './viewer-lang';

// Export-shaped annotation, as it appears in viewerSettingsJson.annotations
// (produced by annotations.export in src/annotations.ts).
type AnyAnnotation = {
    title?: string,
    text?: string,
    extras?: {
        url?: string,
        images?: { src: string, caption: string }[],
        i18n?: Record<string, { title?: string, text?: string, url?: string, captions?: string[] }>
    }
};

// Injection gate: an export with no translated annotation gets no companion at
// all, which keeps an untranslated export byte-identical to what it was before
// this feature existed.
const hasAnnotationTranslations = (annotations: AnyAnnotation[]): boolean => {
    return (annotations || []).some(a => Object.keys(a?.extras?.i18n ?? {}).length > 0);
};

// Apply one language's overrides to an annotation IN PLACE.
//
// In place is the whole trick. The exported viewer's annotation navigator reads
// `global.settings.annotations[i].title` live on every refresh, the link
// companion reads `extras.url` on every activation and the gallery companion
// reads `extras.images[i].caption` when it opens -- so mutating these objects
// localizes three surfaces without any of them knowing translations exist.
//
// Fallback is PER FIELD: a missing key leaves the base value untouched, so a
// half-finished translation never blanks anything.
//
// Self-contained (no module-level references) so it is injected verbatim into
// the runtime via Function.toString().
const applyAnnotationTranslation = (ann: any, lang: string): void => {
    const extras = (ann && ann.extras) || {};
    const t = (extras.i18n || {})[lang];
    if (!t) {
        return;
    }
    if (t.title) {
        ann.title = t.title;
    }
    if (t.text) {
        ann.text = t.text;
    }
    if (t.url && extras.url) {
        extras.url = t.url;
    }
    const captions = t.captions;
    const images = extras.images;
    if (captions && images) {
        for (let i = 0; i < images.length && i < captions.length; i++) {
            if (captions[i]) {
                images[i].caption = captions[i];
            }
        }
    }
};

// The runtime companion. Kept as a plain string so it is injected verbatim.
//
// BUILD TRAP: no backslash escapes, no backticks and no `${` other than the
// deliberate Function.toString() injection below.
const companionRuntime = `
(function () {
  var applyAnnotationTranslation = ${applyAnnotationTranslation.toString()};

  var lang = window.__ssLang || 'en';

  // The shared tooltip is rewritten by the viewer on every activation from the
  // engine Annotation instance's OWN copies of title/text, taken when the
  // instances were constructed -- before this companion could touch anything.
  // So the settings mutation below cannot reach it and the divs are written
  // here instead, on 'annotation.activate', which the viewer fires AFTER
  // writing them. Same hook and same ordering guarantee the link companion
  // relies on.
  function paint(ann) {
    if (!ann) return;
    var title = document.querySelector('.pc-annotation-title');
    if (title) title.textContent = ann.title || '';
    var text = document.querySelector('.pc-annotation-text');
    if (text) text.textContent = ann.text || '';
    var nav = document.querySelector('#annotationNavTitle');
    if (nav) nav.textContent = ann.title || '';
  }

  function start() {
    var viewer = window.__supersplatViewer;
    var global = viewer && viewer.global;
    var ev = global && global.events;
    var list = global && global.settings && global.settings.annotations;
    if (!ev || !ev.on || !list) { requestAnimationFrame(start); return; }

    for (var i = 0; i < list.length; i++) {
      applyAnnotationTranslation(list[i], lang);
    }

    // The navigator ran its initial refresh against the base strings, possibly
    // before this companion started, so paint the first one now. Every later
    // refresh reads the mutated objects and needs no help.
    var nav = document.querySelector('#annotationNavTitle');
    if (nav && list.length > 0) nav.textContent = list[0].title || '';

    ev.on('annotation.activate', paint);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
`;

// Produce the full HTML fragment to inject before </body>, or '' when nothing
// is translated.
const buildAnnotationI18nInjection = (annotations: AnyAnnotation[]): string => {
    if (!hasAnnotationTranslations(annotations)) {
        return '';
    }
    return `<script>${viewerLangRuntime}</script>` +
        `<script>${companionRuntime}</script>`;
};

export { applyAnnotationTranslation, buildAnnotationI18nInjection, hasAnnotationTranslations };
export type { AnyAnnotation };
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run test/annotation-i18n-injection.test.ts
```

Expected: PASS.

- [ ] **Step 5: Wire the injection into both export chains**

In `src/splat-export-core.ts`, add the import beside the other companion imports and a wrapper beside `injectAnnotationLinks`:

```ts
// Inject the annotation-translation companion into an HTML string before
// </body>. No-op when no annotation carries translations, which keeps an
// untranslated export byte-identical to what it was before the feature.
//
// Chain position: this must run BEFORE nothing in particular -- it polls for
// the viewer handle like every other companion -- but it must be present on
// every path that carries annotations, which is both of them.
const injectAnnotationI18n = (html: string, viewerSettingsJson: any): string => {
    const injection = buildAnnotationI18nInjection(viewerSettingsJson?.annotations ?? []);
    if (!injection) {
        return html;
    }
    return insertBeforeBodyClose(html, injection);
};
```

Then add it to **both** injection chains. At `src/splat-export-core.ts:942` (`writeViewerCore`), where `injectAnnotationLinks(withPoster, settingsWithLods)` appears, wrap it:

```ts
    const withLinks = injectAnnotationI18n(injectAnnotationLinks(withPoster, settingsWithLods), settingsWithLods);
```

And in `writeSogCore` at both `:1047` and `:1091`, wrap the `injectAnnotationLinks(...)` call the same way, passing the same settings object that call already uses (`viewerSettingsJson` at `:1047`, `sogSettings` at `:1091`).

- [ ] **Step 6: Extend the upstream drift guard**

`test/viewer-html-anchors.test.ts` asserts against the **real** splat-transform bundle, so it is what will catch an upstream rename of the selectors this companion depends on. Add:

```ts
    // src/viewer-companion/annotation-i18n.ts -- the companion overwrites these
    // three nodes to show an annotation in the visitor's language. A rename
    // upstream would silently ship untranslated tooltips, so pin them here
    // against the real bundle rather than against a fixture.
    it('keeps the annotation tooltip and navigator nodes the i18n companion writes', () => {
        expect(jsSource).toContain("className = 'pc-annotation-title'");
        expect(jsSource).toContain("className = 'pc-annotation-text'");
        expect(jsSource).toContain('annotationNavTitle');
    });

    // The same companion, and annotation-links.ts, depend on the viewer firing
    // 'annotation.activate' AFTER it has written those divs.
    it('fires annotation.activate from the annotation show handler', () => {
        expect(jsSource).toContain("fire('annotation.activate'");
    });
```

If any assertion fails, the exact string in the bundle has changed — read the bundle and update the assertion to the new literal **and** fix the companion's selector. Do not relax the assertion.

- [ ] **Step 7: Run the affected suites**

```bash
npx vitest run test/annotation-i18n-injection.test.ts test/viewer-html-anchors.test.ts test/annotation-links.test.ts
```

Expected: PASS.

- [ ] **Step 8: Lint and commit**

```bash
npm run lint
git add src/viewer-companion/annotation-i18n.ts src/splat-export-core.ts test/annotation-i18n-injection.test.ts test/viewer-html-anchors.test.ts
git commit -m "Show annotations in the visitor's language in the exported viewer"
```

---

### Task 6: Resolve iframe API strings to the viewer's language

**Files:**
- Modify: `src/viewer-companion/iframe-api.ts`
- Test: `test/viewer-iframe-api.test.ts` (extend)

**Interfaces:**
- Consumes: `extras.i18n` (Task 4), `resolveLocale` / `viewerLangRuntime` (Task 1).
- Produces: `AnnotationEntry` gains `i18n?: Record<string, {title?: string, text?: string}>`; new pure `localizeAnnotationTable(table: AnnotationEntry[], lang: string): AnnotationEntry[]`.

- [ ] **Step 1: Write the failing test**

Append to `test/viewer-iframe-api.test.ts`:

The file already imports `buildAnnotationIndex` and `resolveAnnotationRef` from that module at line 4 — add `localizeAnnotationTable` to **that existing import**, do not add a second import line (ESLint 10 crashes on `import/order` autofix, so keep import blocks as they are).

```ts
describe('iframe api annotation translations', () => {
    const annotations = [{
        title: 'Facade',
        text: 'Built in 1890',
        extras: { id: 'annotation_0', i18n: { fr: { title: 'Façade', text: 'Construite en 1890' } } }
    }, {
        title: 'Roof',
        text: 'Slate',
        extras: { id: 'annotation_1' }
    }];

    it('bakes the i18n map into the table', () => {
        const table = buildAnnotationIndex(annotations);
        expect(table[0].i18n).toEqual({ fr: { title: 'Façade', text: 'Construite en 1890' } });
        expect(table[1].i18n).toBeUndefined();
    });

    it('resolves titles and text to the requested language', () => {
        const out = localizeAnnotationTable(buildAnnotationIndex(annotations), 'fr');
        expect(out[0].title).toBe('Façade');
        expect(out[0].text).toBe('Construite en 1890');
    });

    it('falls back per field and per annotation', () => {
        const partial = [{
            title: 'Facade',
            text: 'Built in 1890',
            extras: { id: 'annotation_0', i18n: { de: { title: 'Fassade' } } }
        }];
        const out = localizeAnnotationTable(buildAnnotationIndex(partial), 'de');
        expect(out[0].title).toBe('Fassade');
        expect(out[0].text).toBe('Built in 1890');
    });

    it('leaves the table untouched for an untranslated language', () => {
        const out = localizeAnnotationTable(buildAnnotationIndex(annotations), 'ja');
        expect(out[0].title).toBe('Facade');
        expect(out[1].title).toBe('Roof');
    });

    it('drops the i18n map from what is sent to the host', () => {
        const out = localizeAnnotationTable(buildAnnotationIndex(annotations), 'fr');
        expect(out[0].i18n).toBeUndefined();
    });

    it('resolves a reference by the base title or the translated one', () => {
        const localized = localizeAnnotationTable(buildAnnotationIndex(annotations), 'fr');
        // a host keyed on the base title must keep working after a visitor
        // switches language, so BOTH names resolve
        expect(resolveAnnotationRef(localized, { name: 'Façade' }).index).toBe(0);
        expect(resolveAnnotationRef(localized, { name: 'Facade' }).index).toBe(0);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/viewer-iframe-api.test.ts
```

Expected: FAIL — `localizeAnnotationTable` is not exported.

- [ ] **Step 3: Implement**

In `src/viewer-companion/iframe-api.ts`:

1. Extend `AnyAnnotation.extras` with `i18n?: Record<string, { title?: string, text?: string }>` and `AnnotationEntry` with two optional fields:

```ts
    // Baked so the runtime can resolve to the visitor's language. Stripped
    // before anything is sent to the host.
    i18n?: Record<string, { title?: string, text?: string }>,
    // The untranslated title, kept so goto-by-name still matches a host that
    // was keyed on it before the visitor's language changed.
    baseTitle?: string,
```

2. In `buildAnnotationIndex`, carry `i18n` through **only when the annotation has a non-empty one**. Setting the key unconditionally (even to `undefined`) is fine for `toEqual`, but omitting it keeps the baked JSON free of `"i18n":null` noise for untranslated exports. The existing `toEqual` assertions at the top of this suite keep passing either way.

3. Add the pure resolver, placed beside `resolveAnnotationRef` and, like it, self-contained so it can be injected via `Function.toString()`:

```ts
// Resolve a baked table to one language. Returns a NEW array -- the runtime
// keeps the baked table intact so a later request can resolve differently.
// Per-field fallback: a missing key keeps the base string. `baseTitle` records
// the untranslated title so goto-by-name accepts either form, and `i18n` is
// dropped so nothing sent to the host carries the whole dictionary.
const localizeAnnotationTable = (table: AnnotationEntry[], lang: string): AnnotationEntry[] => {
    return (table || []).map((entry) => {
        const t = (entry.i18n || {})[lang] || {};
        const out: AnnotationEntry = {
            index: entry.index,
            id: entry.id,
            title: t.title || entry.title,
            text: t.text || entry.text,
            scene: entry.scene
        };
        if (t.title && t.title !== entry.title) {
            out.baseTitle = entry.title;
        }
        return out;
    });
};
```

4. In `resolveAnnotationRef`'s name branch, match `baseTitle` as well as `title` — same case- and whitespace-insensitive comparison, `title` tried first:

```ts
            if (entries[i].title.trim().toLowerCase() === want ||
                (entries[i].baseTitle || '').trim().toLowerCase() === want) {
```

5. In the runtime, inject `localizeAnnotationTable` via `${localizeAnnotationTable.toString()}` beside the existing `resolveAnnotationRef` injection, and derive the table it answers from once at startup:

```js
  var table = localizeAnnotationTable(window.__supersplatIframeApi || [], window.__ssLang || 'en');
```

Replace the runtime's existing reads of the raw baked global with this `table`.

6. Prepend the language snippet in `buildIframeApiInjection`, which is injected unconditionally:

```ts
import { viewerLangRuntime } from './viewer-lang';
```

```ts
    return `<script>${viewerLangRuntime}</script>` +
        `<script>window.__supersplatIframeApi = ${tableJson};</script>` +
        `<script>${companionRuntime}</script>`;
```

7. Add `localizeAnnotationTable` to the module's `export { … }`.

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run test/viewer-iframe-api.test.ts
```

Expected: PASS. Any pre-existing assertion counting the injection's `<script>` tags is now off by one — update the count, do not delete the assertion.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/viewer-companion/iframe-api.ts test/viewer-iframe-api.test.ts
git commit -m "Return annotation strings in the viewer's language from the iframe API"
```

---

### Task 7: Editor translations dialog

**Files:**
- Create: `src/ui/annotation-translations-dialog.ts`
- Modify: `src/ui/editor.ts:7` (import), `:225` (construct), and the `topContainer.append(...)` block
- Modify: `src/tools/annotation-tool.ts` (add the button)
- Modify: `src/ui/scss/annotation-overlay.scss` (dialog layout)
- Modify: `static/locales/*.json` (all nine)
- Test: `test/localization-plurals.test.ts` (extend)

**Interfaces:**
- Consumes: `AnnotationTranslation`, `TRANSLATION_LOCALES`, `cloneTranslations` (Task 3); `UpdateAnnotationOp`, `AnnotationData` (existing).
- Produces: the `annotation.translations.edit` event (payload: annotation id).

- [ ] **Step 1: Add the locale strings**

Add these keys to all nine `static/locales/*.json` files, in the same objects the sibling `panel.annotations.*` and `popup.annotation-images.*` keys already live in. **Use an editor tool, not a shell script** — these files must keep their existing line endings.

For `panel.annotations.translations-edit`, mirror **exactly** the plural-form suffixes that `panel.annotations.images-edit` already uses in that same file (`en/de/es/fr` use `_one`/`_other`; `ja/ko/zh-CN` use `_other` only; `pt-BR` uses `_one`/`_other`/`_many`; `ru` uses `_one`/`_few`/`_many`/`_other`). Copy the plural shape from that key rather than guessing.

The non-plural keys, per locale:

| key | en | de | es | fr |
|---|---|---|---|---|
| `popup.annotation-translations.header` | Annotation Translations | Anmerkungsübersetzungen | Traducciones de la anotación | Traductions de l'annotation |
| `popup.annotation-translations.base` | Original | Original | Original | Original |
| `popup.annotation-translations.captions` | Image Captions | Bildunterschriften | Descripciones de imágenes | Descriptions des images |
| `popup.annotation-translations.image-n` | Image {{index}} | Bild {{index}} | Imagen {{index}} | Image {{index}} |

| key | ja | ko | pt-BR | ru | zh-CN |
|---|---|---|---|---|---|
| `popup.annotation-translations.header` | 注釈の翻訳 | 주석 번역 | Traduções da anotação | Переводы аннотации | 注释翻译 |
| `popup.annotation-translations.base` | 原文 | 원문 | Original | Оригинал | 原文 |
| `popup.annotation-translations.captions` | 画像の説明 | 이미지 설명 | Descrições das imagens | Подписи к изображениям | 图片说明 |
| `popup.annotation-translations.image-n` | 画像 {{index}} | 이미지 {{index}} | Imagem {{index}} | Изображение {{index}} | 图片 {{index}} |

And the plural key's singular/plural text:

| locale | singular | plural |
|---|---|---|
| en | `{{count}} language — Edit…` | `{{count}} languages — Edit…` |
| de | `{{count}} Sprache — Bearbeiten…` | `{{count}} Sprachen — Bearbeiten…` |
| es | `{{count}} idioma — Editar…` | `{{count}} idiomas — Editar…` |
| fr | `{{count}} langue — Modifier…` | `{{count}} langues — Modifier…` |
| ja | — | `{{count}} 言語 — 編集…` |
| ko | — | `{{count}}개 언어 — 편집…` |
| pt-BR | `{{count}} idioma — Editar…` | `{{count}} idiomas — Editar…` (also for `_many`) |
| ru | `{{count}} язык — Редактировать…` | `_few`: `{{count}} языка — Редактировать…`; `_many` and `_other`: `{{count}} языков — Редактировать…` |
| zh-CN | — | `{{count}} 种语言 — 编辑…` |

The em dash and the `…` are the same characters the neighbouring `images-edit` values use — copy them from that line rather than typing them.

Reuse the existing `panel.annotations.title`, `panel.annotations.text` and `panel.annotations.url` keys for the field labels. Do not add new ones.

- [ ] **Step 2: Write the failing test**

Append to `test/localization-plurals.test.ts`:

```ts
describe('annotation translations plural strings', () => {
    it('renders correct English singular and plural for translations-edit', async () => {
        const t = await makeT('en');
        expect(t('panel.annotations.translations-edit', { count: 1 })).toBe('1 language — Edit…');
        expect(t('panel.annotations.translations-edit', { count: 3 })).toBe('3 languages — Edit…');
    });

    it('renders a non-empty translations-edit in every locale', async () => {
        for (const lng of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'ru', 'zh-CN']) {
            const t = await makeT(lng);
            for (const count of [1, 2, 5]) {
                const out = t('panel.annotations.translations-edit', { count });
                expect(out, `${lng} @ ${count}`).not.toBe('panel.annotations.translations-edit');
                expect(out, `${lng} @ ${count}`).toContain(String(count));
            }
        }
    });

    it('defines the dialog strings in every locale', async () => {
        const keys = [
            'popup.annotation-translations.header',
            'popup.annotation-translations.base',
            'popup.annotation-translations.captions'
        ];
        for (const lng of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'ru', 'zh-CN']) {
            const t = await makeT(lng);
            for (const key of keys) {
                // fallbackLng is 'en', so a missing key returns the English
                // string rather than the key -- compare against English to
                // catch a locale that simply has not been filled in.
                expect(t(key), `${lng} ${key}`).not.toBe(key);
            }
            expect(t('popup.annotation-translations.image-n', { index: 2 })).toContain('2');
        }
    });
});
```

- [ ] **Step 3: Run the test to verify it passes**

```bash
npx vitest run test/localization-plurals.test.ts
```

Expected: PASS — the strings were added in Step 1. If a plural form renders as the raw key, that locale's suffix set does not match `images-edit`; fix the JSON.

- [ ] **Step 4: Build the dialog**

Create `src/ui/annotation-translations-dialog.ts`:

```ts
import { Button, Container, Label, TextInput } from '@playcanvas/pcui';

import {
    AnnotationData,
    AnnotationTranslation,
    cloneTranslations,
    TRANSLATION_LOCALES,
    UpdateAnnotationOp
} from '../annotations';
import { Events } from '../events';
import { i18n } from './localization';

// Modal editor for one annotation's translations. Edits a working COPY: the
// whole session (every language, every field) commits as a single
// UpdateAnnotationOp, so it is one undo step rather than one per keystroke.
// Same contract as AnnotationImagesDialog, which this is modelled on.
class AnnotationTranslationsDialog extends Container {
    show: (id: string) => void;
    hide: () => void;

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'annotation-translations-dialog',
            class: ['settings-dialog', 'blocks-shortcuts'],
            hidden: true,
            tabIndex: -1
        };

        super(args);

        const dialog = new Container({ id: 'dialog' });

        const headerText = new Label({ id: 'text' });
        i18n.bindText(headerText, 'popup.annotation-translations.header');
        const header = new Container({ id: 'header' });
        header.append(headerText);

        const body = new Container({ class: 'annotation-translations-body' });
        const langList = new Container({ class: 'annotation-translations-langs' });
        const fields = new Container({ class: 'annotation-translations-fields' });
        body.append(langList);
        body.append(fields);

        const okButton = new Button({ class: 'button' });
        i18n.bindText(okButton, 'popup.ok');
        const cancelButton = new Button({ class: 'button' });
        i18n.bindText(cancelButton, 'popup.cancel');
        const footer = new Container({ id: 'footer' });
        footer.append(cancelButton);
        footer.append(okButton);

        // the body goes inside #content like every other settings dialog:
        // settings-dialog.scss hangs the body padding off that id
        const content = new Container({ id: 'content' });
        content.append(body);

        dialog.append(header);
        dialog.append(content);
        dialog.append(footer);
        this.append(dialog);

        // --- working state ---

        let annotationId: string | null = null;
        let base: AnnotationData | null = null;
        let working: Record<string, AnnotationTranslation> = {};
        let selected = TRANSLATION_LOCALES[0];
        let objectUrls: string[] = [];

        const releaseThumbnails = () => {
            objectUrls.forEach(url => URL.revokeObjectURL(url));
            objectUrls = [];
        };

        // A language "has content" when any field is non-empty. This is also
        // what the toolbar button counts, so the two can never disagree.
        const hasContent = (t: AnnotationTranslation | undefined): boolean => {
            if (!t) {
                return false;
            }
            if (t.title || t.text || t.url) {
                return true;
            }
            return Object.values(t.captions ?? {}).some(c => !!c);
        };

        const entry = (): AnnotationTranslation => {
            working[selected] = working[selected] ?? {};
            return working[selected];
        };

        const rebuildLangs = () => {
            langList.clear();
            i18n.languages.forEach((lang) => {
                const row = new Container({
                    class: hasContent(working[lang.code]) ?
                        ['annotation-translations-lang', 'translated'] :
                        ['annotation-translations-lang']
                });
                if (lang.code === selected) {
                    row.class.add('selected');
                }
                // native names, so a user who cannot read the current UI
                // language still recognises their own
                row.append(new Label({ text: lang.name }));
                row.dom.addEventListener('click', () => {
                    selected = lang.code;
                    rebuildLangs();
                    rebuildFields();
                });
                langList.append(row);
            });
        };

        // A labelled row: read-only base string above, translation input below.
        const addRow = (labelKey: string, baseText: string, value: string, onChange: (v: string) => void) => {
            const row = new Container({ class: 'annotation-translations-row' });
            const label = new Label({ class: 'annotation-translations-label' });
            i18n.bindText(label, labelKey);
            const baseLabel = new Label({ class: 'annotation-translations-base', text: baseText });
            const input = new TextInput({ class: 'annotation-translations-input', value });
            input.on('change', onChange);
            row.append(label);
            row.append(baseLabel);
            row.append(input);
            fields.append(row);
        };

        const rebuildFields = () => {
            releaseThumbnails();
            fields.clear();
            if (!base) {
                return;
            }
            const t = entry();

            addRow('panel.annotations.title', base.title, t.title ?? '', (v) => {
                entry().title = v;
                rebuildLangs();
            });
            addRow('panel.annotations.text', base.text, t.text ?? '', (v) => {
                entry().text = v;
                rebuildLangs();
            });

            // only the LIVE action is translatable, matching the export rule
            if (base.linkType === 'url') {
                addRow('panel.annotations.url', base.url, t.url ?? '', (v) => {
                    entry().url = v;
                    rebuildLangs();
                });
            }

            if (base.linkType === 'images' && base.images.length > 0) {
                const heading = new Label({ class: 'annotation-translations-heading' });
                i18n.bindText(heading, 'popup.annotation-translations.captions');
                fields.append(heading);

                // Scrolling list, same shape as .annotation-images-list: an
                // annotation may carry dozens of images and the dialog must not
                // grow with them.
                const list = new Container({ class: 'annotation-translations-captions' });
                base.images.forEach((img, index) => {
                    const row = new Container({ class: 'annotation-translations-caption-row' });

                    const data = events.invoke('annotationImages.get', img.imageId) as Uint8Array | null;
                    const thumb = new Label({ class: 'annotation-images-thumb' });
                    if (data) {
                        const url = URL.createObjectURL(new Blob([data as BlobPart], { type: img.mime }));
                        objectUrls.push(url);
                        thumb.dom.style.backgroundImage = `url(${url})`;
                    } else {
                        thumb.text = i18n.t('popup.annotation-images.missing');
                    }

                    const baseCaption = img.caption ||
                        i18n.t('popup.annotation-translations.image-n', { index: index + 1 });
                    const baseLabel = new Label({
                        class: 'annotation-translations-base',
                        text: baseCaption
                    });

                    const input = new TextInput({
                        class: 'annotation-translations-input',
                        value: t.captions?.[img.imageId] ?? ''
                    });
                    input.on('change', (v: string) => {
                        const e = entry();
                        e.captions = e.captions ?? {};
                        e.captions[img.imageId] = v;
                        rebuildLangs();
                    });

                    row.append(thumb);
                    row.append(baseLabel);
                    row.append(input);
                    list.append(row);
                });
                fields.append(list);
            }
        };

        // --- open / close ---

        this.show = (id: string) => {
            const a = events.invoke('annotations.byId', id) as AnnotationData | null;
            if (!a) {
                return;
            }
            annotationId = id;
            base = a;
            working = cloneTranslations(a.translations);
            selected = TRANSLATION_LOCALES[0];
            rebuildLangs();
            rebuildFields();
            this.hidden = false;
            this.dom.focus();
        };

        this.hide = () => {
            releaseThumbnails();
            this.hidden = true;
            annotationId = null;
            base = null;
        };

        cancelButton.on('click', () => this.hide());

        okButton.on('click', () => {
            const a = annotationId ? (events.invoke('annotations.byId', annotationId) as AnnotationData | null) : null;
            if (a) {
                // strip languages the session left empty, so an opened-and-
                // cancelled-into language never persists as a hollow entry
                const next: Record<string, AnnotationTranslation> = {};
                Object.keys(working).forEach((code) => {
                    const t = working[code];
                    const clean: AnnotationTranslation = {};
                    if (t.title) clean.title = t.title;
                    if (t.text) clean.text = t.text;
                    if (t.url) clean.url = t.url;
                    const captions: Record<string, string> = {};
                    Object.keys(t.captions ?? {}).forEach((imageId) => {
                        if (t.captions[imageId]) {
                            captions[imageId] = t.captions[imageId];
                        }
                    });
                    if (Object.keys(captions).length > 0) {
                        clean.captions = captions;
                    }
                    if (Object.keys(clean).length > 0) {
                        next[code] = clean;
                    }
                });
                events.fire('edit.add', new UpdateAnnotationOp(
                    events,
                    a.id,
                    { translations: cloneTranslations(a.translations) },
                    { translations: next }
                ));
            }
            this.hide();
        });

        this.dom.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                this.hide();
            }
        });

        events.on('annotation.translations.edit', (id: string) => this.show(id));
    }
}

export { AnnotationTranslationsDialog };
```

- [ ] **Step 5: Add the toolbar button**

In `src/tools/annotation-tool.ts`, beside `imagesButton`:

```ts
        const translationsButton = new Button({ class: 'annotations-toolbar-button' });
```

Append it after `imagesButton` in the `bar.append(...)` sequence, and in `refreshBar()`, after the `imagesButton.text = ...` line:

```ts
            // count languages carrying any non-empty field -- the same
            // definition the dialog's "translated" marker uses
            const translatedCount = Object.values(a.translations ?? {}).filter((t: any) => {
                return !!(t.title || t.text || t.url) ||
                    Object.values(t.captions ?? {}).some((c: any) => !!c);
            }).length;
            translationsButton.text = i18n.t('panel.annotations.translations-edit', { count: translatedCount });
```

and the click handler beside the `imagesButton` one:

```ts
        translationsButton.on('click', () => {
            const a = selected();
            if (a) {
                events.fire('annotation.translations.edit', a.id);
            }
        });
```

- [ ] **Step 6: Mount the dialog**

In `src/ui/editor.ts`, mirror the three places `AnnotationImagesDialog` appears: the import at the top, the construction beside `annotationImagesDialog` (`:225`), and a `topContainer.append(annotationTranslationsDialog);` in the same append block.

- [ ] **Step 7: Style the dialog**

In `src/ui/scss/annotation-overlay.scss`, inside the same block that styles `#annotation-images-dialog`, add:

```scss
#annotation-translations-dialog {
    .annotation-translations-body {
        display: flex;
        gap: 12px;
    }

    .annotation-translations-langs {
        display: flex;
        flex-direction: column;
        flex-shrink: 0;
        width: 140px;
    }

    .annotation-translations-lang {
        padding: 4px 8px;
        cursor: pointer;

        &.selected {
            background-color: #2c2c2c;
        }

        // a dot marks a language that already carries content, so the author
        // can see at a glance what is done without clicking through nine rows
        &.translated > .pcui-label::after {
            content: ' •';
        }
    }

    .annotation-translations-fields {
        display: flex;
        flex-direction: column;
        flex-grow: 1;
        gap: 8px;
        min-width: 320px;
    }

    .annotation-translations-base {
        opacity: 0.6;
    }

    .annotation-translations-captions {
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-height: 260px;
        overflow-y: auto;
    }

    // flex-shrink: 0 for the reason documented above .annotation-images-list:
    // .pcui-label carries overflow: hidden, which zeroes a flex item's
    // automatic minimum size, so without it the rows compress instead of
    // scrolling once the list passes its max-height.
    .annotation-translations-caption-row {
        display: flex;
        align-items: center;
        flex-shrink: 0;
        gap: 8px;
    }
}
```

Check the surrounding file for the exact selection colour and spacing values it already uses, and match them rather than the placeholders above.

- [ ] **Step 8: Verify the whole suite and the build**

```bash
npm run lint
npm run test > /tmp/vitest.log 2>&1; tail -40 /tmp/vitest.log
npm run build > /tmp/build.log 2>&1; grep -c "plugin typescript" /tmp/build.log
```

Expected: lint clean; all suites pass; the `grep -c` prints `0`. **Gate the build on that count, not on the exit code** — Rollup reports TypeScript errors as warnings and still exits 0.

- [ ] **Step 9: Manual check**

```bash
npm run develop
```

Open http://localhost:3333, load any splat, place an annotation, open `Translations…`, fill in French title/text, export a ZIP, and open the exported `index.html` with `?lang=fr` and then with `?lang=de`. Confirm the tooltip, the navigator title and the link chip all follow the parameter, and that an untranslated field falls back to the base string.

- [ ] **Step 10: Commit**

```bash
git add src/ui/annotation-translations-dialog.ts src/ui/editor.ts src/tools/annotation-tool.ts src/ui/scss/annotation-overlay.scss static/locales test/localization-plurals.test.ts
git commit -m "Add the annotation translations dialog"
```

---

## Finishing

When every task is committed and green, use `superpowers:finishing-a-development-branch`. Per the project convention the branch squashes to a single commit summarising the feature, including the spec and plan documents.

## Self-review notes

- **Spec coverage:** §1 data model → Task 3. §2 export shape → Task 4. §3.1 shared resolver → Tasks 1–2. §3.2 companion → Task 5. §3.3 iframe API → Task 6. §4 editor UI → Task 7. §5 testing → distributed across every task, with the anchor drift guard in Task 5 Step 6. §6 edge cases → escaping is inherited from the existing builders (Task 5 reuses them unchanged, and no new payload global is introduced); unmatched `?lang=` is Task 1 Step 1; the server path needs no change because the new companion is reached through `splat-export-core`'s existing imports.
- **Deviation from the spec, deliberate:** the spec named three companions with their own `navigator.language` lookups; there are six (`device-fallback`, `portal-markers`, `portals` and `quality-mode` as well). Task 2 converts all of them — the change is mechanical and the coherence argument is identical.
- **Naming is consistent across tasks:** `translations` (editor field), `extras.i18n` (export), `window.__ssLang` (runtime), `resolveLocale` / `VIEWER_LOCALES` (Task 1), `TRANSLATION_LOCALES` (Task 3, the editor-side copy), `applyAnnotationTranslation` (Task 5), `localizeAnnotationTable` (Task 6).
