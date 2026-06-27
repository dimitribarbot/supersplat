# Portal support for the S3 publish flow

**Date:** 2026-06-27
**Status:** Approved

## Goal

Bring the portal multi-scene walkthrough feature — already available in the ZIP
export — to the **S3 publish** flow. When the scene contains portals, the S3
publish dialog gains per-scene Interior/Exterior collision dropdowns and emits a
portal bundle, so the published custom viewer walks between scenes exactly like a
ZIP-exported viewer does.

Out of scope: the PlayCanvas hosted publish (`publish-settings-dialog.ts` /
`publish.ts`). It uploads a single PLY to superspl.at's own viewer, which has no
multi-scene/collision support, so it is left untouched.

## Background / current state

The "Publish" menu item (`show.publishSettingsDialog`, editor.ts:233) branches:

- **S3 publish** (`s3-publish-dialog.ts` -> `s3-publish.ts`) when the export
  server has S3 configured (`caps?.publish`). It produces the same custom ZIP
  viewer as the ZIP export, already has single-environment collision
  (environment/radius/voxel-size), and goes through `runServerPublish`. **This is
  the portal-capable path.**
- **PlayCanvas hosted publish** otherwise. Single PLY, different viewer. Cannot
  support portals.

The server `/api/publish` endpoint already accepts `extraPly` files and
`portalExtras` metadata (server/src/index.ts:139-165) — identical handling to
`/api/export`. **The server side is done.** All remaining work is client-side.

The ZIP-export portal path is implemented in `writeViaServer` (file-handler.ts)
and `export-popup.ts`, and is the template this design mirrors.

## Components

### 1. Shared upload helper — new file `src/portal-upload.ts`

Extract the multi-scene serialize-to-gzip loop currently inlined in
`writeViaServer` (file-handler.ts:639-676) into one reusable async function.

It cannot live in `portal-export.ts`: that file is deliberately free of
`splat-transform`/`playcanvas` imports so it stays unit-testable in isolation,
and this helper needs `serializePly` + `MemoryFileSystem`.

```ts
type PortalUploadMeta = {
    seed: [number, number, number];
    environment: 'indoor' | 'outdoor';
    collisionUrl: string | null;
    streaming: boolean;
};

buildPortalUpload(args: {
    events: Events;
    es: any;                          // experienceSettings w/ portalScenes/portalCollision/portalEnvironments
    serializeSettings: SerializeSettings;
    streaming: boolean;
}): Promise<{
    startSplat: Splat;
    extraPlyGz: Blob[];
    portalExtras: PortalUploadMeta[];
} | null>
```

Behavior:

- Returns `null` when it is not a portal export (`es.portalScenes` absent or
  length <= 1, or `resolvePortalExtras` yields `null`).
- Otherwise runs `resolvePortalExtras` with the same args used today (portals,
  startUid, availableUids, streaming, collision, authored, startSeed,
  environments), finds the start splat by uid, serializes each extra scene to a
  gzipped PLY, and assembles the `portalExtras` meta array.
- Throws the same descriptive errors as today when a referenced scene uid is not
  found or produces no PLY.
- The `collisionSeedTuple(es)` helper (reads `es.cameras?.[0]?.initial?.position
  ?? [0,0,0]`) moves into this module (or is duplicated as a tiny local) so both
  callers compute the same start seed.

### 2. `file-handler.ts` refactor (behavior-preserving)

Replace the inline block in `writeViaServer` (lines 639-676) with a call to
`buildPortalUpload(...)`. On a non-null result:

```ts
splats = [result.startSplat];
extraPlyGz = result.extraPlyGz;
(wire as any).portalExtras = result.portalExtras;
```

No behavior change. The local-export branch (`scene.write`, lines 770-814) keeps
its own `resolvePortalExtras` call because it returns live `Splat` objects to
`serializeViewer` rather than gzipped blobs — it is not part of this extraction.

### 3. `export-server-client.ts`

`runServerPublish` gains an `extraPlyGz?: Blob[]` parameter (mirroring
`runServerExport`) and appends each blob as an `extraPly` form field.
`portalExtras` rides along inside the `options` object — the server already reads
`options.portalExtras`.

### 4. `s3-publish-dialog.ts`

Mirror the portal UI from `export-popup.ts`:

- Add a `perSceneEnvRow` container + `perSceneEnvSelects` map and a
  `rebuildPerSceneEnv()` that builds one Interior/Exterior selector per portal
  scene, using `buildPortalBundle` to get the scene UIDs and names (index 0 =
  start scene included, same as the export popup).
- When portals exist, hide the single `environmentRow` and show `perSceneEnvRow`
  (only while collision is on). Rebuild on `collision` change, on `streaming`
  change, and on `show`.
- In `assemble()`, when `portals.count > 0`, build the bundle (with
  `collision: collision.value`) and spread `portals`, `portalScenes`,
  `portalStart`, `portalCollision`, and `portalEnvironments` (from the per-scene
  selects, default `'indoor'`) into `experienceSettings` — identical to
  export-popup.ts:726-753.

### 5. `s3-publish.ts`

Before serializing the single scene, call `buildPortalUpload(...)`. If non-null:

- Serialize the **start** splat as the primary `scene.ply` (instead of
  `events.invoke('scene.splats')`), gzip it.
- Pass `extraPlyGz` to `runServerPublish` and add `portalExtras` to
  `publishOptions`.

Non-portal scenes keep today's single-PLY path unchanged.

## Testing

- The pure logic (`buildPortalBundle` / `resolvePortalExtras`) is already covered
  by `test/portal-export.test.ts`; the server side by
  `server/test/portal-extras.test.ts`. Both are exercised unchanged by this path.
- The `file-handler.ts` refactor is behavior-preserving and re-verified by the
  existing export E2E.
- Manual end-to-end verification of a real multi-scene S3 publish against a
  **release build** (per the portal-feature minification gotcha previously hit:
  always E2E a release build, not just dev).

## Locales

No new keys. The per-scene selectors reuse `popup.export.environment.indoor` /
`popup.export.environment.outdoor`, already present in every locale.
