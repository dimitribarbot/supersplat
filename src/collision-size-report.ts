// Maps a written export entry name to the scene it belongs to, so the
// post-export summary can report each scene's collision binary size.
//
// The export core already broadcasts every ZIP entry as
// `events.fire('exportFile', { name, bytes })` (splat-export-core.ts, both ZIP
// loops); this module is the shared filter over that stream. Deliberately free
// of playcanvas / PCUI imports so it can be unit-tested in isolation.

// Primary scene writes `index.voxel.bin`; extras are namespaced under
// `scenes/<N>/` and renamed to `scene.voxel.bin` by writePortalScene.
const COLLISION_ENTRY = /^(?:scenes\/(\d+)\/scene|index)\.voxel\.bin$/;

const collisionSceneIndex = (entryName: string): number | null => {
    const m = COLLISION_ENTRY.exec(entryName);
    if (!m) return null;
    return m[1] === undefined ? 0 : parseInt(m[1], 10);
};

// Raw size above which the summary flags a scene as expensive. ~4 MB over the
// wire once the publish path's gzip (server/src/s3.ts) has been applied.
//
// This 15 MB value is also written as literal text in the
// "popup.export.summary.oversize" string in all nine static/locales/*.json
// files (deliberately not interpolated — formatBytes() emits English unit
// suffixes, which would read wrong in translated sentences). If this value
// changes, update those nine strings too.
const COLLISION_OVERSIZE_BYTES = 15 * 1024 * 1024;

const UNITS = ['B', 'KB', 'MB', 'GB'];

const formatBytes = (bytes: number): string => {
    let v = bytes;
    let u = 0;
    while (v >= 1024 && u < UNITS.length - 1) {
        v /= 1024;
        u++;
    }
    return u === 0 ? `${v} B` : `${v.toFixed(1)} ${UNITS[u]}`;
};

// Build the post-export summary rows: sorted by scene index, falling back to
// `#N` when the scene has no resolved name. Shared by the local/server export
// path (file-handler.ts) and the S3 publish path (s3-publish.ts) so the
// ordering + fallback contract has one implementation and one set of tests.
const collisionRows = (sizes: Map<number, number>, sceneNames: string[]) => [...sizes.entries()]
.sort((a, b) => a[0] - b[0])
.map(([sceneIndex, bytes]) => ({ sceneIndex, name: sceneNames[sceneIndex] ?? `#${sceneIndex}`, bytes }));

export { collisionSceneIndex, formatBytes, collisionRows, COLLISION_OVERSIZE_BYTES };
