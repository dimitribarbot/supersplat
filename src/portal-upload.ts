// Shared "serialize each extra portal scene to a gzipped PLY + build the
// portalExtras upload meta" step for the server-upload paths (ZIP export and
// S3 publish). Lives outside portal-export.ts because it needs serializePly
// (which pulls in splat-transform/playcanvas); portal-export.ts stays pure.

import { MemoryFileSystem } from '@playcanvas/splat-transform';

import { Events } from './events';
import { collisionSeedTuple, resolvePortalExtras } from './portal-export';
import { Splat } from './splat';
import { serializePly, SerializeSettings } from './splat-serialize';

type PortalUploadMeta = {
    seed: [number, number, number];
    environment: 'indoor' | 'outdoor';
    collisionUrl: string | null;
    streaming: boolean;
};

// Returns null when `es` is not a portal export (no portalScenes, single scene,
// or resolvePortalExtras yields null). Otherwise returns the start splat (to be
// serialized by the caller as the primary scene.ply) plus the gzipped extra
// scene PLYs and their upload metadata, in the same index order as portalScenes.
const buildPortalUpload = async (args: {
    events: Events;
    es: any;
    serializeSettings: SerializeSettings;
    streaming: boolean;
}): Promise<{ startSplat: Splat; extraPlyGz: Blob[]; portalExtras: PortalUploadMeta[] } | null> => {
    const { events, es, serializeSettings, streaming } = args;

    if (!es?.portalScenes || es.portalScenes.length <= 1) return null;

    const all = events.invoke('scene.allSplats') as Splat[];
    const resolved = resolvePortalExtras({
        portals: events.invoke('portals.export') ?? [],
        startUid: events.invoke('portals.startSplat') ?? null,
        availableUids: all.map(s => s.uid),
        streaming,
        collision: !!es.portalCollision && es.portalCollision.length > 0,
        authored: events.invoke('portals.exportEntrypoints') ?? {},
        startSeed: collisionSeedTuple(es),
        environments: es.portalEnvironments ?? []
    });
    if (!resolved) return null;

    const startUid = resolved.bundle.sceneUids[0];
    const startSplat = all.find(s => s.uid === startUid);
    if (!startSplat) throw new Error(`Portal export: start scene uid ${startUid} not found among loaded splats.`);

    const extraPlyGz: Blob[] = [];
    const portalExtras: PortalUploadMeta[] = [];
    for (const ex of resolved.extras) {
        const splat = all.find(s => s.uid === ex.uid);
        if (!splat) throw new Error(`Portal export: scene uid ${ex.uid} not found among loaded splats.`);
        const sFs = new MemoryFileSystem();
        await serializePly([splat], serializeSettings, sFs, 'scene.ply');
        const bytes = sFs.results.get('scene.ply');
        if (!bytes) throw new Error(`Portal export: scene uid ${ex.uid} produced no PLY.`);
        const gz = await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
        extraPlyGz.push(gz);
        portalExtras.push({ seed: ex.seed, environment: ex.environment, collisionUrl: ex.collisionUrl, streaming });
    }

    return { startSplat, extraPlyGz, portalExtras };
};

export { buildPortalUpload, PortalUploadMeta };
