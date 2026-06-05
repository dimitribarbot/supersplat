# Annotations with Links — Design

**Date:** 2026-06-04
**Status:** Approved (pending spec review)

## Goal

Let a user author **annotations** in the SuperSplat Editor — a text label (title + body) anchored
above a point on the 3D Gaussian Splat, with an **optional clickable link** (free-form URL, e.g. the
same viewer with a different `?content=` file, or any other page). Annotations must:

- be authored in the editor (place + edit + delete),
- persist in the project file,
- appear in the **exported/published viewer** as hotspots (text already supported by the viewer),
- expose a working clickable link in the exported viewer.

The annotations are **only rendered in the exported/published viewer**, not in the editor viewport.
The editor shows lightweight marker gizmos purely to support authoring.

## Background / constraints (verified)

- The upstream **`supersplat-viewer`** already renders annotation hotspots from
  `ExperienceSettings.annotations` (`title`, `text`, `position`, `camera`, `extras?`). The data
  contract is already defined in this editor at `src/splat-serialize.ts:68` (`Annotation` type) and
  `src/splat-serialize.ts:126` (`ExperienceSettings.annotations`), and `startMode` already supports
  `'annotation'` (`src/splat-serialize.ts:127`).
- Today the editor **hardcodes `annotations: []`** at export: `src/ui/export-popup.ts:576` and
  `src/ui/publish-settings-dialog.ts:375`. There is no authoring UI and no project-file persistence.
- The upstream viewer renders annotation `title`/`text` via **`textContent`** (plain text —
  embedding `<a>` in text would be escaped), has **no anchor/href handling**, and **ignores the
  `extras` field**. Its annotation lifecycle events fire on a **private internal emitter**
  (`global.events`), not on `window`/`document`.
- **Constraint:** do **not** modify/fork the upstream `supersplat-viewer`. The link feature is
  therefore delivered by the editor **injecting a companion (JS + CSS + link table) into the
  exported HTML**.

## Architecture

Annotations become a first-class, editor-owned concept following the **existing camera-poses
pattern** (`src/camera-poses.ts`): a self-contained manager that owns the data, exposes it via
`events`, persists into the project document, and is read at export time.

```
[Authoring]   click-to-place (picker) ──▶ AnnotationManager (src/annotations.ts)
                                           │  ├─ marker gizmos in editor viewport (editor-only)
                                           │  └─ side panel (list + edit title/text/url/newTab)
[Persistence] doc.ts ◀─ docSerialize.annotations / docDeserialize.annotations
[Export]      export-popup / publish-settings-dialog ─▶ ExperienceSettings.annotations
                                           │
              serializeViewer / writeViewerCore ─▶ inject companion (JS + CSS + link table)
                                           ▼
              exported index.html  ──(runtime)──▶ companion appends clickable <a> to tooltips
```

## Data model

The upstream `Annotation` type is **unchanged** (`position`, `title`, `text`, `camera`,
`extras?: any`). The link travels inside `extras`, which the viewer transports but ignores:

```ts
extras: { url?: string, newTab?: boolean }
```

The editor manager holds a richer internal record:

```ts
type AnnotationItem = {
    id: string,            // stable id for selection/undo
    position: Vec3,
    title: string,
    text: string,
    url?: string,
    newTab?: boolean,
    camera: { position: Vec3, target: Vec3, fov: number }  // fly-to view
};
```

- `camera` is **required** by the viewer's `Annotation` type, so each annotation **auto-captures the
  current editor camera** at creation time, re-capturable later via a panel button. No mandatory
  extra UI; gives a sensible fly-to view.

## Components

### New: `src/annotations.ts` (editor manager)

- `registerAnnotationsEvents(events)`, mirroring `src/camera-poses.ts`.
- Owns the `AnnotationItem[]`; exposes events:
  `annotations.add`, `annotations.remove`, `annotations.update`, `annotations.list`,
  `annotations.get` (export-shaped), and fires `annotations.changed`, `annotations.selected`.
- Implements `docSerialize.annotations` / `docDeserialize.annotations` (packing `Vec3`→`[x,y,z]`,
  same style as `src/camera-poses.ts:274`).
- `scene.clear` resets the list.

### New: marker gizmos (editor-only)

- An `Element` subclass modelled on `src/camera-pose-gizmos.ts`, rendering a simple billboarded pin
  per annotation so the user can see / select / drag them.
- Rendered on a debug/editor layer only — **never** part of any exported artifact.

### New: click-to-place tool

- A small "Add annotation" mode that raycasts the splat (reusing the existing picker, as in
  `src/tools/measure-tool.ts`) and drops an annotation at the hit point, capturing the current
  camera. New annotations are auto-selected for immediate editing.

### New: `src/ui/annotations-panel.ts` (PCUI side panel)

- List of annotations; selecting one focuses/highlights its marker.
- Editable fields: **title, text, URL, "open in new tab"**.
- Buttons: **delete**, **re-capture camera**.

### New: viewer companion `src/viewer-companion/annotation-links.ts`

- Self-contained runtime script (compiled/inlined or embedded as a string asset) injected into the
  exported HTML. See "Companion runtime behaviour".

### Modified files

- `src/ui/export-popup.ts:576` and `src/ui/publish-settings-dialog.ts:375` — replace
  `annotations: []` with the manager's serialized annotations
  (`{position, title, text, camera, extras:{url,newTab}}`). `startMode` left unchanged.
- `src/splat-export-core.ts` — add companion injection for **all three** viewer export types
  (`html`, `package`, `streaming`), extending the existing post-process hook
  (`src/splat-export-core.ts:265`).
- `src/doc.ts` — add `annotations` to serialize (`src/doc.ts:160`) and deserialize
  (`src/doc.ts:124`).
- `src/editor.ts` (or the central registration site) — register annotations events and tool.
- `static/locales/*.json` — new UI strings (panel labels, menu/tool entry).

## Persistence (project file)

- Serialize: add `annotations: events.invoke('docSerialize.annotations')` alongside `poseSets` at
  `src/doc.ts:160`.
- Deserialize: add `events.invoke('docDeserialize.annotations', document.annotations)` alongside
  `src/doc.ts:124`.
- Backward compatible: documents without `annotations` load zero annotations, no errors.

## Export population + companion injection

- **Populate**: map each `AnnotationItem` to the export `Annotation`
  (`{position, title, text, camera, extras:{url,newTab}}`) at the two export sites.
- **Inject** (in `src/splat-export-core.ts`), before `</body>` of the exported `index.html`, only
  when at least one annotation has a URL:
  - a `<style>` block for the link element,
  - `<script>window.__supersplatAnnotationLinks = [...]</script>` — link table indexed by annotation
    order: `{ label, url, newTab }`, only for annotations with a URL,
  - the companion `<script>`.
- If **no** annotation has a URL, inject **nothing** (zero overhead / zero behavioural change for
  existing exports).

## Companion runtime behaviour (exported viewer)

1. On load, **attempt Approach 2 first**: if the viewer exposes its event emitter / app on `window`,
   subscribe to `annotation.activate` / `annotation.deactivate` and render the link element through
   that. (Reachability verified at implementation time; if unavailable, fall through.)
2. **Approach 1 (primary)**: observe the `#annotations` container; for each annotation tooltip the
   viewer creates, match it to the link table by **label number**, and **append** a styled
   `<a>` ("Open link ↗") below the text.
   - `newTab` true → `target="_blank" rel="noopener noreferrer"`.
   - `newTab` false → same-tab navigation (covers the `?content=` swap case).
3. If the container/tooltip structure isn't found (viewer changed), **`console.warn` once** with a
   clear message and no-op — annotations still show their text; only the link is absent.

## Edge cases & error handling

- Empty / no-URL annotations → text-only hotspot, no link element.
- Old project files without `annotations` → load empty, no errors.
- Companion can't attach (viewer DOM changed) → graceful degrade, warn once, text remains.
- **URL sanitation**: companion only emits `href` for `http:`, `https:`, or relative URLs; anything
  else (e.g. `javascript:`) is dropped, so the injected link can't introduce unsafe navigation.
- Marker gizmos must never leak into exported artifacts (editor-only layer).

## Testing / verification posture

This repo has **no test framework** (only `npm run lint`), consistent with the existing plan at
`docs/superpowers/plans/2026-05-27-export-viewer-settings.md`. Verification is therefore:

- `npm run lint` clean.
- Manual browser verification:
  1. Place annotations (click-to-place); confirm markers and panel editing.
  2. Save project, reload — annotations persist.
  3. Export **HTML**, **package**, and **streaming** — hotspots show text; link appears; new-tab
     toggle behaves; same-tab `?content=` swap loads another splat.
  4. Export with **no** URLs — output unaffected by the companion (no injected script).

## Out of scope (YAGNI)

- Rendering full annotation tooltips inside the editor viewport (markers only).
- Forking / modifying the upstream `supersplat-viewer`.
- Forcing `startMode: 'annotation'` / guided-tour autoplay.
- Rich-text / HTML bodies, images, or multiple links per annotation.
