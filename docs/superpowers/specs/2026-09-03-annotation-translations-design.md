# Annotation translations — design

Date: 2026-09-03
Status: approved (brainstorming), ready for implementation planning

## Goal

Let an author translate an annotation's authored content into any of the
editor's nine locales, and let the exported viewer show each visitor the
annotation in their own language — the browser language by default, overridable
with the `?lang=` query parameter the viewer already accepts.

A single export serves every language. There is no per-language export and no
language picker in the viewer.

## Scope

In scope:

- Editor: a per-annotation translations dialog covering title, text, link URL
  and image gallery captions.
- Project persistence (`.ssproj`).
- Export: every path that already carries annotations — single-file HTML,
  Package (ZIP), Streaming (ZIP), local and server-side, plus S3 / Spaces
  publish.
- Exported-viewer runtime: tooltip, annotation navigator, link chip, gallery
  captions and the iframe API.
- One shared viewer-side language resolver, adopted by the existing companions
  so `?lang=` drives their strings too.

Out of scope:

- A language switcher in the exported viewer. Resolution is automatic
  (`?lang=` → browser → base strings).
- Machine translation of any kind. Every string is author-entered.
- Languages outside the editor's nine locales.
- A declared per-document source language. The existing untranslated fields are
  an unlabelled default, not a language.
- Translating anything other than annotations. The off-limits *custom* message
  and portal names stay single-language; only the off-limits *default* message
  changes, and only to follow the shared resolver instead of
  `navigator.language`.

## Decisions and rationale

| Decision | Rationale |
|---|---|
| Nine editor locales, no free-form codes | The set already exists in `src/ui/localization.ts` **and** upstream's viewer dictionaries. A free-form code would need validation, a native-name lookup and would still have no viewer UI behind it. |
| Existing fields are an unlabelled default | Zero migration; legacy projects keep working; nothing to declare. Translations are a pure add-on. |
| Per-field fallback | One forgotten field must never blank a tooltip or silently discard the rest of a translation. |
| Exact → base → region-variant matching | Byte-for-byte the rule upstream's own `detectLocale` uses, so our companion strings and the viewer's UI strings can never disagree. Also means `pt-PT` and `zh-TW` visitors get a translation rather than the base language. |
| Runtime companion, not per-language export | One artifact serves every language, and `?lang=` works on an already-published URL. |
| Mutate `global.settings.annotations` in place | The nav bar, the link chip and the gallery all read those objects live, so three surfaces localize for free. Only the tooltip needs a DOM write. |
| Not patching settings pre-boot | ZIP/SOG exports fetch an external `settings.json` rather than inlining it, so a bootstrap patch cannot cover every export type. |
| Captions exported positionally | `imageId` does not exist in the export, and `extras.images` is filtered at export time; a parallel array is the only alignment that survives that filter. |
| Captions edited in the translations dialog | Keeps one translation entry point. The scrolling list is the same shape the images dialog already uses at the same scale. |
| One shared resolver for all companions | `?lang=fr` giving a French annotation next to an English "Open link" chip is a bug. Also deletes three duplicated label-table lookups. |

## Background: what upstream already provides

The exported viewer (splat-transform's baked `index.js`) already ships a
complete i18n system:

- The same nine locale dictionaries, keyed `de, en, es, fr, ja, ko, pt-BR, ru,
  zh-CN`.
- `?lang=` is already read in the viewer's HTML shell and passed to
  `initLocalization(config.lang)`.
- `detectLocale(lang)` resolves `[lang, ...navigator.languages]` by exact tag,
  then base subtag, then any region variant sharing the base, then `'en'`.
- `document.documentElement.lang` is set to the resolved locale.

So `?lang=` already localizes the viewer's *own* UI. This feature adds authored
content to what that parameter controls, and reuses the same resolution rule
rather than inventing a second one.

Two more upstream facts the design depends on:

- The tooltip is a single shared DOM node. `Annotation` writes
  `.pc-annotation-title` / `.pc-annotation-text` from its **own copies** of
  title/text (taken at construction), then fires `show` →
  `annotation.activate`. Writing the divs inside an `annotation.activate`
  handler is therefore correctly ordered — the same guarantee
  `annotation-links.ts` already relies on.
- The navigator (`initAnnotationNav`) reads
  `global.settings.annotations[i].title` **live** on every `updateDisplay()`,
  so mutating those objects is enough for it — except for the initial
  `updateDisplay()`, which may already have run.

## 1. Data model

`AnnotationData` (`src/annotations.ts`) gains:

```ts
type AnnotationTranslation = {
    title?: string,
    text?: string,
    url?: string,
    captions?: Record<string, string>   // imageId -> caption
};

type AnnotationData = {
    ...,
    translations: Record<string, AnnotationTranslation>   // locale code -> fields
};
```

- Locale keys are restricted to the nine codes in `i18n.languages`.
- Captions are keyed by `imageId`, not by array index, so reordering or removing
  an image cannot silently reattach a caption to a different picture.
- `translations` is snapshotted whole by `UpdateAnnotationOp`, like `images`
  is, so one dialog session is one undo step.
- `title` / `text` / `url` remain the base strings and the per-field fallback.
- Legacy documents deserialize to `{}`. No migration.

### Untrusted input

`docDeserialize.annotations` already treats a project file as untrusted (see
`isSafeImageRecord`). Translations get the same treatment, at the same door:

- Drop any locale key not in the nine.
- Drop any non-string `title` / `text` / `url`.
- Drop any caption key that does not match the existing `^annimg_\d+$` id
  pattern, and any non-string caption value.
- Records that fail are **dropped, never repaired**.

## 2. Export shape

`annotations.export` emits translations into `extras.i18n`, beside the existing
`url` / `newTab` / `images` / `scene` / `id`:

```jsonc
"extras": {
  "url": "https://example.com/en",
  "images": [{ "src": "annotations/annimg_0.jpg", "caption": "North wall" }],
  "i18n": {
    "fr": {
      "title": "Façade",
      "text": "Construite en 1890",
      "url": "https://example.com/fr",
      "captions": ["Mur nord"]
    },
    "de": { "title": "Fassade" }
  }
}
```

Rules:

- **Only the live action is translated.** `i18n[lang].url` is emitted only when
  `linkType === 'url'`; `captions` only when `linkType === 'images'`. This
  mirrors the existing rule that an annotation in `images` mode must never fall
  back to the url its record still carries. A translation for the dormant mode
  is retained in the document but never exported.
- **`captions` is positional.** It is built against the *filtered*
  `extras.images` array (images whose bytes are missing from the session store
  are dropped from the export), so index `i` of `captions` always describes
  index `i` of `extras.images`. Untranslated slots are `""`; a trailing run of
  empties is trimmed.
- **Empty is omitted at every level:** an empty field, an empty language entry,
  and an empty `i18n` object. An export with no translations is byte-identical
  to today's, which keeps the existing injection tests and the server byte-parity
  guarantee honest.
- `stripHtmlGalleries` (the single-file HTML path, which drops galleries) must
  also drop `i18n[*].captions`, or an HTML export would carry caption
  translations for images it does not ship.

Document serialization gains `AnnotationDocData.translations`, written verbatim
and validated on read per §1.

## 3. Viewer runtime

### 3.1 Shared resolver — new `src/viewer-companion/viewer-lang.ts`

Environment-agnostic, playcanvas-free, in the same spirit as the other
companions:

- `VIEWER_LOCALES` — the nine codes, matching both the editor and upstream's
  dictionary keys.
- `resolveLocale(candidates: string[], keys: string[]): string` — **pure**, and
  exported so it is unit-tested in Node. Exact tag (case-insensitive) → base
  subtag → any region variant sharing the base → `'en'`.
- A runtime snippet that sets `window.__ssLang` **once**, from `?lang=`
  followed by `navigator.languages`.

Every injection that needs a language — the annotation-i18n companion, the link
chip, the off-limits default message — prepends this snippet to its own script.
It is guarded (`if (!window.__ssLang) { … }`) so the repetition is harmless and
no injection depends on another being present or on the order they are applied.
In particular, the link and off-limits companions still resolve a language on an
export that carries no translations at all, where the annotation-i18n companion
is not injected.

The resolver is injected via `${resolveLocale.toString()}` — the one legitimate
interpolation form in a companion template — so the function that is tested is
literally the function that ships.

`annotation-links.ts` and `off-limits-zones.ts` swap their `navigator.language`
lookups for `window.__ssLang`. Their label tables stay where they are.

> Companion-template rule (see the project memory): no backslash escapes, no
> backticks and no `${` inside these stringified runtimes, other than the
> deliberate `${fn.toString()}` injections. Use literal UTF-8 glyphs — the
> exported HTML declares `<meta charset="UTF-8">` and is written through
> `TextEncoder`.

### 3.2 New `src/viewer-companion/annotation-i18n.ts`

Injected only when at least one annotation carries `extras.i18n`. At start it
resolves the language and applies translations **in place** on
`viewer.global.settings.annotations[i]`:

| Field mutated | Picked up for free by |
|---|---|
| `ann.title` / `ann.text` | the annotation navigator |
| `ann.extras.url` | the existing link companion's chip |
| `ann.extras.images[i].caption` | the existing gallery companion |

So links and galleries need no translation logic of their own. Translated URLs
also need no new sanitising: the existing `safeHref` http(s) check already
guards `extras.url`.

The tooltip is the one surface that needs an explicit write, because the
engine's `Annotation` instances copied title/text at construction. An
`annotation.activate` handler writes `.pc-annotation-title` and
`.pc-annotation-text` from the (already-mutated) annotation object. The
navigator title is additionally written once at start, since its initial
`updateDisplay()` may have already run against the base strings.

Per-field fallback falls out of the design: a missing key leaves the base value
untouched.

### 3.3 iframe API

`src/viewer-companion/iframe-api.ts` bakes its annotation table at build time.
The table gains the `i18n` map, and:

- `supersplat:annotation.list` returns `title` / `text` resolved to the viewer's
  language.
- goto-by-name matches against the base title **or** the resolved title, so host
  pages keyed on the base title keep working.

## 4. Editor UI

### 4.1 Toolbar

`src/tools/annotation-tool.ts` gains a `Translations…` button beside the
existing `Images…` button, labelled with a count (`Translations (2)`) so the bar
shows at a glance whether an annotation is translated. It fires
`annotation.translations.edit` with the annotation id — the pattern
`annotation.images.edit` already uses.

### 4.2 New `src/ui/annotation-translations-dialog.ts`

Modelled on `annotation-images-dialog.ts`: same `settings-dialog
blocks-shortcuts` shell, same `#header` / `#content` / `#footer` structure, same
`popup.ok` / `popup.cancel` buttons.

```
Translations — Annotation 3
┌─────────┬────────────────────────────────┐
│ English │ Base    Title: Facade          │
│ Deutsch │         Text:  Built in 1890   │
│ Español │                                │
│>Français│ Title  [Façade             ]   │
│ 日本語   │ Text   [Construite en 1890 ]   │
│ 한국어   │                                │
│ Portug•│ Captions            ▂▂▂▂▂▂▂▂   │
│ Pусс•  │ [img] North wall           │   │
│ 中文    │       [Mur nord         ]  │   │
│         │ [img] Entrance            │   │
│         │       [Entrée           ]  │   │
│         │ [img] Roof detail         ▓   │
│         │       [                 ]  │   │
└─────────┴────────────────────────────────┘
                          [Cancel] [ OK ]
```

- **Left:** the nine languages by native name (from `i18n.languages`), each row
  marked when it holds content. Clicking selects.
- **Right:** the base strings read-only at the top — you translate against the
  source, not from memory — then the editable fields for the selected language:
  - Title, Text — always.
  - Link URL — only when `linkType === 'url'`.
  - Captions — only when `linkType === 'images'`: a scrolling list
    (`max-height` + `overflow-y: auto`) of thumbnail + read-only base caption +
    translation input, one row per image, keyed by `imageId`. This is the same
    shape and the same CSS pattern as `.annotation-images-list`
    (`annotation-overlay.scss:112`), which already handles arbitrarily many
    images. An image whose base caption is empty is labelled `Image N`.
- An empty field means "not translated" and falls back to the base. No separate
  clear action.
- Edits go to a **working copy**. `OK` commits a single `UpdateAnnotationOp` —
  one undo step for the whole session — and `Cancel` discards. Same contract as
  the images dialog.

> `flex-shrink: 0` on the caption rows, for the reason already documented above
> `.annotation-images-list`: `.pcui-label` carries `overflow: hidden`, which
> zeroes a flex item's automatic minimum size, so without it the rows compress
> instead of scrolling.

### 4.3 Strings

All persistent UI strings bound via `i18n.bindText` / `i18n.bindOptions` — never
assigned literally — per the reactive-localization rule at the top of
`src/ui/localization.ts`. New keys:

- `popup.annotation-translations.*` (header, base-title, base-text, empty-caption
  placeholder, `image-n`).
- `panel.annotations.translations-edit_one` / `_other`.

Added to all nine `static/locales/*.json`, written with CRLF-consistent tooling —
scripted locale edits have injected bare LF into these files before.

## 5. Testing

- `test/viewer-lang.test.ts` — `resolveLocale` matrix: exact tag,
  case-insensitivity (`pt-br` → `pt-BR`), base subtag (`fr-CA` → `fr`), region
  variant (`pt-PT` / `pt` → `pt-BR`, `zh-TW` → `zh-CN`), unknown → `en`, and
  `?lang=` winning over `navigator.languages`.
- `test/annotations.test.ts` (extend) — `translations` round-trips through
  document serialize/deserialize; unknown locale codes, non-string values and
  malformed caption keys are dropped; export emits `extras.i18n` only for the
  live `linkType`; `captions` stays index-aligned with the *filtered*
  `extras.images`; no translations ⇒ export byte-identical to today.
- `test/annotation-i18n-injection.test.ts` — gating (no `i18n` ⇒ empty
  injection); `new Function(script)` on the built injection to catch template
  truncation; an assertion that no cooked-escape remnants survive (both traps
  from `portals-injection.test.ts`); a jsdom check that the
  `annotation.activate` handler rewrites the tooltip divs and the navigator
  title.
- `test/viewer-iframe-api.test.ts` (extend) — `annotation.list` returns resolved
  strings; goto-by-name matches base **or** resolved title.
- `test/viewer-html-anchors.test.ts` (extend) — the long-term guard. It checks
  anchors against the **real** splat-transform bundle, so add
  `.pc-annotation-title`, `.pc-annotation-text` and `#annotationNavTitle`. An
  upstream bump that renames them then fails a test instead of silently
  shipping untranslated tooltips.

## 6. Edge cases

- Translation strings are baked into an injected `<script>`, so they go through
  the same `<` / `>` / `&` / U+2028 / U+2029 escaping
  `buildAnnotationLinksInjection` already applies.
- `?lang=xx` with no match falls through to `navigator.languages`, then to the
  base strings — never blank.
- An annotation with translations but no base title still shows the translation;
  the base being empty is not a reason to suppress anything.
- The server export path needs no special handling: translations ride inside
  `viewerSettingsJson`, and `scripts/build-shared.mjs` picks up the new
  companion module automatically as an import of `splat-export-core`.
- Payload size: nine languages × (60-char title + 280-char text) × 25
  annotations is ~76 KB worst case, and only non-empty entries are emitted.
  No mitigation needed.
