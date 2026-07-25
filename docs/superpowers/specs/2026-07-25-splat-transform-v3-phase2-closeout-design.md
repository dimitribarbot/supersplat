# Design: splat-transform v3 Phase-2 closeout, dead-code removal, lazy portal-scene extraction

Date: 2026-07-25 · Branch: `merge-upstream-part-2`

Follow-up to the upstream merge + splat-transform 3.1.6 migration (`47e195e`,
spec `2026-07-24-upstream-merge-splat-transform-v3-design.md`, hand-off memo
`docs/superpowers/2026-07-24-upstream-merge-v3-phase1-e2e-and-phase2-handoff.md`).

## Motivation

Two questions opened this work:

1. Does splat-transform 3.1.6's "resident memory is bounded by chunk size rather
   than scene size" apply to the fork, and can it help the portal feature?
2. Are there now-deprecated functions to remove before they become a problem?

Investigation answered both, and turned up one real defect on the way.

### Finding 1 — "bounded by chunk size" is the export side, not the exported viewer

The claim comes from the README's *Library Usage* section and ends "…the same
pipeline the CLI uses to process scenes of hundreds of millions of gaussians".
`@playcanvas/splat-transform` is a build-time conversion library; it ships no
runtime code into the exported viewer. The exported viewer is the PlayCanvas
engine's gsplat renderer (bundled by `writeHtml`) plus our injected companions,
and its residency is already chunk-bounded via the streamed-SOG
(`lod-meta.json`) format, `app.scene.gsplat.splatBudget`, and the fork's own
budget-residency / pinning work in `portal-preload.ts`. **3.1.6 adds nothing for
the end-user viewer.**

### Finding 2 — Phase 2 is complete, not deferred

The hand-off memo recorded Phase 2 as "deferred; mostly NOT worth it". The
evidence is stronger than that: there is nothing left to migrate. Every fork
call site, checked against the 3.1.6 declarations:

| Fork call site | Status in 3.1.6 | Migration value |
| --- | --- | --- |
| `writeSog({dataTable})` | **already a thin adapter over `writeSogSource`** — "Wraps the table as a resident ChunkSource via the migration shim and encodes it through the same path"; `writeSogSource` itself is not re-exported from the package root (`dist/lib/index.d.ts` exports `writeSog`/`writeLodSource` but not it) | **zero** — migrating would inline the adapter, and the adapter's own target isn't even public |
| `writeHtml`, `writeVoxel`, `writeSpz` | DataTable-only: `writeSource` accepts these `outputFormat`s but has no *streaming* writer for them, so it materializes to a `DataTable` right at the writer and delegates to `writeFile` anyway (`writeImage` is also DataTable-only but unused by the fork) | **no benefit** — routing through `writeSource` buys nothing |
| `writeCompressedPly` | its `writeCompressedPlySource` sibling is an adapter that *materializes* — compressed PLY is inherently whole-scene | **impossible** |
| `writeLodSource({mainSource})` | modern source API | already migrated |
| `dataTableToChunkSource` / `bakeTransform` / `stackLods` | modern combinators | already used |
| `processDataTable([{kind:'decimate'}])` | source sibling `decimateSource` is stream-once (its `spill` is optional, only used once an intermediate generation exceeds `memoryBudgetBytes`, which defaults to 24 GiB); `writeLodSource` needs random-access **gathers** over `mainSource`, so each level would still have to be materialized/compacted before it could be read back | server-only, and the parity-risky one |
| server `materializeToDataTable` | required because downstream is `writeHtml`/`writeVoxel`/the `writeSog` adapter | none |

Two further facts:

- **No `@deprecated` tag anywhere in splat-transform 3.1.6.** The DataTable API
  is documented as "compat (secondary)" / "Legacy", which is not deprecation —
  and it cannot be removed while `writeHtml`/`writeVoxel`/`writeSpz` are
  DataTable-only (`writeImage` is also DataTable-only but unused by the fork).
- **Zero of engine 2.21's 53 `@deprecated` symbols are used by the fork.** The
  `splatBudget` references are all `app.scene.gsplat.splatBudget`, which is the
  *recommended* property; the deprecated one is `GSplatComponent#splatBudget`.

So there is no deprecation exposure to close, and the DataTable path is the
supported end state rather than scaffolding.

A streamed LOD chain is additionally blocked by shape, not just by cost:
`decimateSource` "supports a single sequential pass — the PLY-terminal
consumption model", while `writeLodSource` needs random-access **gathers** over
`mainSource`. Feeding a stream-once source into a random-access gather means
each level would have to be materialized (and, once the resident budget forces
it, spilled/compacted) before `writeLodSource` could read it back — landing on
the same memory profile the fork already has, not a smaller one. The CLI
never builds an LOD chain by decimating at all: for `lod` output it requires
input that already carries structural LODs, so there is no upstream pattern to
copy.

### Finding 3 — the real memory cliff is eager portal-scene extraction

While measuring where portal-export memory actually goes,
`src/splat-serialize.ts:1485-1493`:

```ts
const extraScenes = ... options.portalScenes?.map(entry => ({
    ..., dataTable: extractDataTable([entry.splat], serializeSettings)   // eager, every scene
}))
```

Every portal scene's DataTable is materialized **up front** and held for the
whole export. At SH degree 3 that is ~236 B/gaussian (59 float32 columns), so a
4-scene walkthrough at 5M gaussians each is ~4.7 GB resident before a single
chunk is written — plus, per scene transiently, its decimated LOD chain (~1×
more), plus `MemoryFileSystem` accumulating every output byte of every scene
until the ZIP is written at the end. `server/src/run-export.ts:178-199` has the
same eager shape.

This is unrelated to `ChunkSource` and is the largest available win. It carries
no byte-parity risk: no writer input changes, only *when* each table is built.

## Scope

Three parts. Part A is documentation, Part B is dead/incorrect code, Part C is
the memory fix. Each is independently shippable; C is the only behavioural
change.

Explicitly **out** of scope: converting any producer to `writeSource` /
`decimateSource` (Findings 1-2 show no benefit and real parity risk), and
streaming output straight into the ZIP instead of accumulating in
`MemoryFileSystem` (a larger redesign; noted for a future session).

## Part A — Close Phase 2 (documentation only)

Replace §3 of
`docs/superpowers/2026-07-24-upstream-merge-v3-phase1-e2e-and-phase2-handoff.md`
with the Finding-2 table and an explicit verdict: **Phase 2 is complete by
analysis; do not re-open.** Keep the existing §3 note about the vendored LCC v1
environment codec (`src/io/read/lcc-environment.ts`), which is still an open
upstream request — 3.1.6 still does not export `readLccEnvironmentSource`
(confirmed against `dist/lib/readers/index.d.ts`).

Update the `upstream-merge-splat-transform-v3-done` memory to match, so a future
session does not re-litigate this.

No code changes.

## Part B — Dead / incorrect code

**B1 — dead locale key.** Delete `popup.lod-upload-note` from all 9 locale files
in `static/locales/`. Verified 0 references in `src/`; the LOD-dialog note that
used it was removed during the merge.

**B2 — stale name.** Rename `buildStreamingLodTable` → `buildStreamingLodSource`
in `src/splat-export-core.ts`. It returns `{ mainSource, levelCounts }`, not a
table; the name predates the v3 signature change. It is currently exported but
nothing imports it (the server destructures only `writeSogCore` and
`writeViewerCore` from `dist-shared`), so drop it from the export list and make
it module-private.

**B3 — unreleased `ChunkSource`s.** `server/src/run-export.ts` never calls
`close()` on the sources returned by `readFile` (lines 89 and 188), so the input
PLY bytes stay pinned for the whole export. `src/io/read/loader.ts:131` already
does this correctly, so the server is the outlier. Add `await source.close()`
after each `materializeToDataTable`. Same fix in
`src/io/read/lcc-environment.ts` at lines 253 and 259 (line 65 in the same file
already does it).

## Part C — Lazy portal-scene extraction

### Contract

In `src/splat-export-core.ts`, `ExtraPortalScene` changes:

```ts
type ExtraPortalScene = {
    loadDataTable: () => Promise<DataTable>;   // was: dataTable: DataTable
    streaming: boolean;
    collisionUrl: string | null;
    environment: 'indoor' | 'outdoor';
    seed: [number, number, number];
};
```

This is the shared editor ↔ server contract (the server builds these objects
structurally and reaches the core through `dist-shared`), so both callers change
in lockstep and `dist-shared` must be rebuilt before the server tests run.

### `writePortalScene`

Awaits `scene.loadDataTable()` into a local, then proceeds exactly as today
(voxel first on the pristine table, then streaming LOD or `writeSog`). The local
dies with the call, so scene *i*'s table is collectable before scene *i+1*
loads. Peak drops from N tables to 1.

It also gains `await mainSource.close()` after `writeLodSource`, which the CLI
does and the fork does not — without it the whole decimated LOD chain stays
referenced through the namespacing step.

Return value becomes the counts to bake: `levelCounts` when streaming,
`[dataTable.numRows]` otherwise. Today the non-streaming branch returns `[]` and
the package branch computes the count itself; unifying it here is what makes the
package branch work without a resident table.

### Package-branch reorder

`src/splat-export-core.ts:839` currently reads `s.dataTable.numRows` for *all*
extras before any scene is written:

```ts
portalSceneLodCounts: [[dataTable.numRows], ...(extraScenes!.map(s => [s.dataTable.numRows]))]
```

Lazy loading makes that impossible, so the package branch is reordered to: run
the scene loop first → collect the returned count arrays → build `sogSettings` →
`applyPoster` / inject → `patchEngineLoaderInMemFs` → `repointCollisionUrl` →
ZIP. Safe because `writePortalScene` writes only under `scenes/<N>/`, so it
cannot collide with `index.html` / `index.js`; `repointCollisionUrl` must still
run after injection.

The streaming branch (`writeStreamingViewerCore`) already collects
`extraLodCounts` in the loop before injection and needs no reorder.

### Callers

- Browser (`src/splat-serialize.ts:1485`):
  `loadDataTable: async () => extractDataTable([entry.splat], serializeSettings)`.
  The `Splat` elements referenced by `entry.splat` are already resident in the
  editor, so the descriptor itself costs nothing.
- Server (`server/src/run-export.ts:178`): `buildExtraScenes` stops materializing
  and returns descriptors whose `loadDataTable` performs the gunzip + `readFile`
  + `materializeToDataTable` + `close()` for that one scene. The gzipped upload
  buffers stay resident (small relative to float32 tables).

The primary scene's table stays eager — it is needed immediately and is the
unavoidable 1×.

### Progress

Extraction is currently silent, up front, in `serializeViewer` — it runs before
`writeViewerCore` installs a progress renderer, so today the export looks like it
has not started yet. Moving it into the loop turns that into a per-scene pause,
so it gets a label: one new i18n key `export.progress.extracting-scene`
("Extracting scene data") across all 9 locales, rendering as "Scene 2/4:
Extracting scene data".

**Mechanism (not the `PHASES` table).** The `PHASES` entries are *prefixes*
applied by `createProgressRenderer` only when splat-transform's logger fires a
`scopeStart`/`barStart` event (`src/splat-export-core.ts:286-309`). Our
extraction is a plain JS loop that fires no library events, so a
`PHASES.extractingScene()` would never render. The label must therefore be a
**direct** `events.fire('progressUpdate', ...)` carrying a segments-only `loc` —
the same shape the server already uses for `export.progress.preparing-gpu`
(`server/src/run-export.ts:113`), and consumed by the handler at
`src/ui/editor.ts:423-438`, which joins translated segments with ": " and appends
no step name when none is given:

```ts
events?.fire('progressStart', header, undefined, headerKey);   // re-open the dialog; see below
events?.fire('progressUpdate', {
    text: `Scene ${index}/${total}: Extracting scene data`,   // English fallback (server/log)
    progress: 0,
    loc: { segments: [
        { key: 'export.progress.scene', params: { index, total } },
        { key: 'export.progress.extracting-scene' }
    ] }
});
```

Because this bypasses the phase machinery, the *event* fires in **both** the
streaming and package branches — so the package branch gets the label too,
without touching its deliberately phase-free prefix wiring
(`src/splat-export-core.ts:782-783`).

Firing the event is not enough to make it *render*, though. The progress dialog
is only visible between `progressStart`/`progressEnd`, which
`createProgressRenderer` fires on the library's depth-0 scopes, and extraction
runs *between* writers — exactly when the dialog is hidden and the next
writer's own `progressStart` would wipe the text anyway. `fireExtracting`
therefore fires its own `progressStart` (with the same header/headerKey each
writer already passes to `createProgressRenderer`) before the `progressUpdate`,
re-opening the dialog the same way the library's own depth-0 scopes do between
writers. The existing macrotask yield (`setTimeout(resolve, 0)`) between
`onExtract?.()` and `scene.loadDataTable()` is what then lets the browser
actually paint the now-visible label before the synchronous per-gaussian
extraction loop blocks the main thread; on the server path it is a no-op since
`file-handler.ts` already keeps one dialog open for the whole export.
`writePortalScene` stays unaware of `Events`: it takes a new `onExtract?: () =>
void` callback and invokes it immediately before awaiting the loader, and each
caller supplies the closure that fires the event with its own scene index and
the header/headerKey it already gives `createProgressRenderer`.

## Testing

The riskiest change — the package-branch reorder — has no automated coverage
today: `server/test/portal-extras.test.ts` is CPU-plumbing only, and
`streaming.gpu.test.ts` exports a single scene. Two new server GPU tests, written
to fail against the current code first:

1. **Streaming, 2 scenes** — `fileType: 'packageViewer'`,
   `viewerExportSettings.streaming: true`, one `extraPlyGz` + one `portalExtras`
   entry. Assert the ZIP contains `scenes/1/lod-meta.json` and a
   `scenes/1/0_0/` chunk folder, and that the baked `index.html` carries a
   `portalSceneLodCounts` with 2 entries.
2. **Package (non-streaming), 2 scenes** — same but `streaming: false`. Assert
   `scenes/1/scene.sog` exists and `portalSceneLodCounts` is `[[n], [n]]`. This
   is the test that covers the reorder.

Both reuse the existing `makePlyGz` / `zipEntryNames` / `zipReadEntry` helpers in
`server/test/streaming.gpu.test.ts` and follow its GPU-probe skip pattern.

Test 1 additionally asserts the **lazy timing** directly, which is otherwise
invisible: the streaming test already collects every progress event, so scene 2's
`export.progress.extracting-scene` event must appear *after* a scene-1
`export.progress.packaging-chunks` event. Under the current eager code that
extraction happens before the export starts, so this ordering can only hold once
extraction is lazy.

A CPU-only (GPU-free) laziness probe is not possible: `getDeviceCreator()` is
called at `server/src/run-export.ts:122`, which is before extras are reached in
both the eager and lazy versions, so the existing `noGpu` pattern in
`server/test/portal-extras.test.ts` cannot distinguish them.

Memory itself is not asserted — peak RSS is not stable enough to gate on. The
tests pin the *observable contract* the refactor must preserve; the memory win
follows from the structure.

### Gates

`npm run lint` · `npm run lint:locales` · `npx tsc --noEmit` · front-end
`npm run test` · then `npm run test --prefix server`, whose `pretest` hook
rebuilds `dist-shared/` (the server bakes its runtime from there, so a stale
build would test the old contract). Run vitest in the foreground with output
redirected to a file — it hangs when backgrounded or piped.

`npm run lint:locales` matters more than usual here: it enforces identical keys
in identical *order* across all 9 locales, so both the deleted key and the new
one must be applied at the same position in every file. Baseline is 459 keys.

### E2E (user)

Export a portal walkthrough with ≥2 scenes, both streaming and package (ZIP),
and confirm: every scene loads in the exported viewer, crossings still work, and
per-scene collision still works. The progress bar should now show "Scene N/M:
Extracting scene data" between scenes.
