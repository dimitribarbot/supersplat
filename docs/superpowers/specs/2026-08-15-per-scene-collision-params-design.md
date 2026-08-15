# Per-scene collision parameters + post-export collision size report

Date: 2026-08-15
Status: APPROVED — ready for an implementation plan
Supersedes the open questions in `docs/superpowers/2026-08-15-per-scene-collision-params.md`.
Prerequisite reading: `docs/superpowers/2026-08-15-viewer-load-critical-path-findings.md`.

## Problem

`radius` and `voxelSize` are single shared scalars for an entire export, but a
portal bundle mixes scenes of wildly different scale. lauterbrunnen's
`index.voxel.bin` reached 39.4 MB because a 5 cm voxel grid was applied to an
outdoor scan; a house interior in the same bundle genuinely needs 5 cm. One
value cannot serve both.

That binary is on the exported viewer's critical path — the loading bar cannot
appear until it has fully downloaded (see the findings memo). Gzip-on-publish
already landed (`a951a4d`, 3.53x verified in production); this change gives the
operator per-scene control over the uncompressed size that gzip then acts on.

## Decisions taken

Recorded here because several reverse earlier proposals in the hand-off memo.

1. **Per-scene `radius` and `voxelSize`**, alongside the already per-scene
   `environment`. This was the user's explicit requirement.
2. **No adaptive default.** An earlier design derived each scene's voxel size
   from its extent (cap the grid's longest axis at ~1024 voxels). Rejected on
   field evidence: at a 100 m radius on lauterbrunnen, 0.10 m voxels are
   noticeably less smooth to walk than 0.05 m. The comfort/size trade-off is a
   judgement the operator must make per scene, and an auto-derived value would
   silently degrade walkability. Defaults stay **indoor / 50 m / 0.05** for
   every scene.
3. **No in-dialog size estimate.** A live byte figure cannot be produced
   honestly: only two field samples exist, the two memos disagree on
   lauterbrunnen's grid dimensions (3948x1008x3792 vs 4435x3753x4426), and the
   `.voxel.bin` encodes an octree of *surface* voxels after floor/external fill,
   so its size depends on scene geometry rather than on the bounding grid. A
   formula fitted to two points from differently-shaped scenes would print a
   confident number that could be several-fold wrong.
4. **Report the actual size after export instead.** Exact, no modelling, and it
   is the number the operator tunes against: export, read the true size, adjust,
   repeat.
5. **Parallel arrays, not a new object array.** `portalRadii` / `portalVoxelSizes`
   sit beside the existing `portalEnvironments`. Replacing `portalEnvironments`
   with a single `portalCollisionParams` object array was considered and
   rejected — not for back-compat (the user regenerates exports at will) but
   because it rewrites a shipped field across the editor, the server and the
   exported viewer companion for no functional gain.
6. **Collapsible per-scene cards** for the UI, in a module shared by both
   dialogs.

## Scope

In scope: both export dialogs, the serializer, the export core, the S3 publish
path, the server, and a new post-export summary dialog.

Out of scope: the voxel resolution ladder / `COLLISION_VOXEL_FLOOR` (that is the
failure fallback and still starts from whatever base it is handed); the
`collision-voxel-options.ts` pure helpers (untouched); anything else on the
viewer load critical path (tasks 3 and 4 have their own memos).

## Architecture

### Data flow

```
export-popup.ts / s3-publish-dialog.ts
    (per-scene cards, uid-keyed state)
  -> ExperienceSettings.portalRadii[] / .portalVoxelSizes[]   (index-aligned)
  -> resolvePortalExtras()  ->  PortalExtra { radius, voxelSize }
  -> ViewerExportSettings.portalScenes[] { radius, voxelSize }   [local path]
     PortalUploadMeta { radius, voxelSize }                      [server path]
  -> ExtraPortalScene { radius, voxelSize }
  -> writePortalScene()  ->  writeCollisionVoxel()
```

`ViewerExportSettings.collision` keeps its current shape,
`{ environment, radius, voxelSize }`, and continues to mean **scene 0** — which
is already what it means for `environment` today
(`export-popup.ts:845` sources it from `perSceneEnvSelects.get(0)`). The
single-scene export path is therefore unchanged by construction, which is what
protects the server's byte-parity guarantee.

### Component boundaries

- `src/ui/collision-params.ts` (new) — owns per-scene collision state and its
  presentation. Depends on PCUI and `Events` only; knows nothing about
  serialization or export. Consumers ask it for values by scene index.
- `src/ui/export-summary-dialog.ts` (new) — displays a completed export's
  collision sizes. Pure presentation; takes a list, returns nothing.
- `splat-export-core.ts` — for the size report it is **unchanged**: it already
  broadcasts every written entry's byte length via `exportFile`. Its only edits
  here are the per-scene `radius` / `voxelSize` plumbing.

## Detailed design

### 1. Type changes

| File | Change |
|---|---|
| `src/splat-serialize.ts:148` | add `portalRadii?: number[]`, `portalVoxelSizes?: number[]` beside `portalEnvironments` |
| `src/splat-serialize.ts:160` | `ViewerExportSettings.portalScenes[]` entries gain `radius: number`, `voxelSize: number` |
| `src/portal-export.ts:180` | `PortalExtra` gains `radius: number`, `voxelSize: number` |
| `src/portal-export.ts:194` | `resolvePortalExtras` args gain `radii: number[]`, `voxelSizes: number[]` |
| `src/splat-export-core.ts:916` | `ExtraPortalScene` gains `radius: number`, `voxelSize: number` |
| `src/portal-upload.ts` | `PortalUploadMeta` gains both |
| `server/src/run-export.ts:23` | `portalExtras[]` gains both |

`ViewerExportSettings.collision` and the server's mirror of it are **not**
changed.

### 2. Export core

`writePortalScene` (`splat-export-core.ts:654`) drops its `radius: number,
voxelSize: number` positional parameters and reads `scene.radius` /
`scene.voxelSize`. The two call sites that currently compute shared
`collRadius` / `collVoxelSize` locals (around lines 835-846 and 1012-1017) lose
those locals.

Per-index fallbacks in `resolvePortalExtras` are `radii[index] ?? 50` and
`voxelSizes[index] ?? 0.05`, matching the defaults `writeCollisionVoxel` already
applies at `splat-export-core.ts:601-602`.

### 3. Collision size reporting

**The export core already emits exactly this data and needs no change at all.**
Both ZIP-writing loops (`splat-export-core.ts:893` in `writeStreamingViewerCore`
and `:1039` in the package branch of `writeViewerCore`) already fire, per entry:

```ts
events?.fire('exportFile', { name: entry, bytes: data.length });
```

`server/src/run-export.ts:150` already subscribes to it for its console
summaries. Collision entries are named `index.voxel.bin` (primary) and
`scenes/<N>/scene.voxel.bin` (extras), so a scene index falls out of:

```ts
/^(?:scenes\/(\d+)\/scene|index)\.voxel\.bin$/     // capture undefined => scene 0
```

Collision is ZIP-only (the dialogs gate it on `viewerType === 'zip'`), and both
ZIP paths fire the event, so coverage is complete.

Consequently **no signature changes** to `writeViewerCore`,
`writeStreamingViewerCore` or `writePortalScene`, and no new callback parameter.
This supersedes an earlier draft of this section that added an
`onCollisionSize?: (sceneIndex, bytes) => void` parameter to all three.

**Local export path.** `serializeViewer` already receives the root `Events` bus
and passes it into the core, so `file-handler.ts` subscribes to `exportFile`
for the duration of the export, filters on the regex above, and resolves scene
names from the bundle order it already holds.

**Server paths.** `server/src/progress.ts` — the `progress` variant of
`ProgressEvent` gains `collision?: { index: number; bytes: number }`.
`server/src/run-export.ts` emits one such event per collision entry from inside
its **existing** `exportFile` listener at line 150. No new event kind, so the
SSE serializer is unchanged. Both browser-side
consumers already own a per-event progress callback and each accumulates there:

- server **export** — `file-handler.ts` (around line 711, inside
  `runServerExport`).
- S3 **publish** — `s3-publish.ts` (around line 81, inside `runServerPublish`).
  This is a *different* file from the export path, not a shared one.

So there are three accumulation sites in total (local export, server export, S3
publish) feeding one dialog.

### 4. Shared per-scene UI — `src/ui/collision-params.ts`

Replaces the `perSceneEnvRow` / `perSceneEnvSelects` / `perSceneEnvValues` /
`rebuildPerSceneEnv` blocks duplicated in `export-popup.ts:324-364` and
`s3-publish-dialog.ts:97-137`.

State:

- `Map<uid, { environment, radius, voxelSize }>` — survives a rebuild, so a
  choice is not lost when the Streaming/Collision toggles rebuild the rows.
- `Map<index, uid>` — used at assembly time.

This preserves the uid/index split the hand-off memo calls out: values keyed by
**uid** so they survive a scene-list rebuild, lookup keyed by **index** so the
parallel arrays can be assembled in order.

Presentation: one collapsible card per scene. (The differing values below are
operator-set — every scene still *starts* at indoor / 50 / 0.05.)

```
Detection de collision                    (o)

v 11 . RdC_Maison_Bueil        Int 50 0.05
     Environnement    [Interieur       v]
     Rayon (m)        [ 50] [====|------]
     Taille de voxel  [0.05] [==|-------]
> 12 . Etage_Maison_Bueil      Int 50 0.10
> 13 . Jardin_Maison_Bueil     Ext 50 0.19
> 14 . Cour_Maison_Bueil       Ext 50 0.12
```

Collapsed by default, with a summary on the header line so every scene's values
are readable without expanding. The scene name gets a full-width row rather than
sharing a 180 px label column with a control, which is what causes today's
ellipsis (`11: RdC_Maison_B...`); `title` remains set as a tooltip fallback.

Single-scene (non-portal) exports keep the existing flat `environmentRow` /
`radiusRow` / `voxelSizeRow` — one scene needs no grouping.

### 5. Export summary dialog — `src/ui/export-summary-dialog.ts`

Modelled on `s3-publish-dialog.ts` (a fork-authored dialog), listing per-scene
collision sizes after a completed export or publish.

```
Export termine - RdC_Maison_Bueil.zip

  Collision
    scene 0  RdC_Maison_B...    3.5 Mo
    scene 1  Etage_Maison...    2.1 Mo
    scene 2  Jardin_Maison...  18.7 Mo   (!)
    scene 3  Cour_Maison_B...   4.2 Mo
```

Inputs: a header, an optional message, an optional link, and the
`{ sceneIndex, name, bytes }[]` list.

- Shown after every viewer export/publish **where collision was enabled** — not
  only when something is oversized, because comparing a good value against a
  previous one is the point.
- The `(!)` marker triggers above **15 MB raw** (~4 MB over the wire after the
  landed gzip fix). A single named constant.
- For the publish path this dialog **replaces** the existing success popup at
  `s3-publish.ts:88-94`, which is why it must carry the message and the `link`
  — that link is how the operator opens the published scene, and losing it would
  be a regression. When collision is disabled, publish keeps using the current
  `showPopup` unchanged.

A separate dialog rather than the existing `showPopup`: that popup renders its
`message` into one PCUI `Label`, which is single-line-with-ellipsis by default,
so a per-scene table would require CSS changes inside `src/ui/popup.ts` /
`src/ui/scss/popup.scss` — both upstream-owned, and every gratuitous edit there
is a future merge conflict.

### 6. SCSS — `src/ui/scss/export-popup.scss`

- `.per-scene-env` -> `.per-scene-collision` (one rule block, already shared by
  both dialogs via the `#export-popup, #s3-publish-dialog` selector).
- Card header: full-width flex row; name with `text-overflow: ellipsis`; summary
  right-aligned, dimmed, `flex-shrink: 0`.
- `#content { max-height: calc(100vh - 200px); overflow-y: auto; }` — three
  controls per scene across four scenes would otherwise grow the dialog past the
  viewport, and `#dialog` is `overflow: hidden`.

### 7. Localization

Reused as-is: `popup.export.environment`, `popup.export.collision-radius`,
`popup.export.voxel-size`.

New keys for the summary dialog, each needing all nine locales in
`static/locales/*.json`:

| key | purpose |
|---|---|
| `popup.export.summary.header` | dialog header ("Export complete") |
| `popup.export.summary.collision` | section label ("Collision") |
| `popup.export.summary.scene` | per-scene row label, takes an index param |
| `popup.export.summary.oversize` | note explaining the `(!)` marker |

## Error handling

No new failure modes. `writeCollisionVoxel` already throws an actionable error
when a region cannot be voxelised even at the floor resolution, and the ladder
already auto-coarsens; per-scene values only change which base each scene starts
from. `onCollisionSize` is optional and never throws — a missing size simply
omits that row from the summary. Sizes are reported only for scenes that
actually wrote a voxel (`scene.collisionUrl` non-null).

## Testing

1. `test/portal-export.test.ts` — `resolvePortalExtras` carries per-index
   `radius` / `voxelSize`, and falls back to 50 / 0.05 when the arrays are
   shorter than the scene list.
2. `server/test/portal-extras.test.ts` — both values round-trip through
   `portalExtras` into `ExtraPortalScene`.
3. New server test — `run-export` emits one `collision` progress event per scene
   carrying the right index and byte count.
4. `server/test/parity-compressed.test.ts` — must still pass unchanged; the
   single-scene path is untouched by construction.
5. Manual E2E — export a portal bundle with deliberately different per-scene
   values; assert each `scenes/N/scene.voxel.json` reports the `voxelResolution`
   it was given, and that the summary dialog's sizes match the files in the ZIP.

No new unit tests in `test/collision-voxel-options.test.ts`: dropping the
adaptive default means that module is untouched by this change.

## Risks

- **`exportFile` is fired only from the two ZIP loops.** If a future format
  writes collision outside a ZIP, the summary silently loses those rows. Safe
  today because the dialogs gate collision on `viewerType === 'zip'`, but the
  coupling is implicit and worth a comment at the listener.
- **Summary dialog frequency.** Showing it after every collision-enabled export
  is a behaviour change beyond the original ask. Accepted deliberately; easy to
  gate on the oversize threshold instead if it proves noisy.
