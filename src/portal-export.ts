// Pure, dependency-free helpers that turn the editor's session-scoped portal
// records (splat-uid references) into the exported bundle's index-based shape:
// a per-scene identity scheme (0 = primary/start), rewritten portal references,
// and the relative scene/collision URLs the viewer companion loads. No
// playcanvas / splat-transform imports so it is unit-testable in isolation.

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

type ExportPortal = {
    position: Vec3,
    rotation: Quat,
    width: number,
    height: number,
    frontUid: number | null,
    backUid: number | null
};

type PortalBundle = {
    sceneUids: number[];                 // index -> editor uid (index 0 = start)
    portals: { position: Vec3, rotation: Quat, width: number, height: number, front: number | null, back: number | null }[];
    portalScenes: string[];              // index -> relative asset URL (index 0 = '')
    portalStart: number;                 // always 0
    portalCollision: (string | null)[];  // index -> voxel URL, or [] when collision off
};

const sceneUrl = (index: number, streaming: boolean): string => {
    if (index === 0) return '';
    return streaming ? `scenes/${index}/lod-meta.json` : `scenes/${index}/scene.sog`;
};

const collisionUrl = (index: number): string => {
    return index === 0 ? 'index.voxel.json' : `scenes/${index}/scene.voxel.json`;
};

const buildPortalBundle = (args: {
    portals: ExportPortal[],
    startUid: number | null,
    availableUids: number[],
    streaming: boolean,
    collision: boolean
}): PortalBundle | null => {
    const { portals, startUid, availableUids, streaming, collision } = args;
    const exists = (uid: number | null): uid is number => uid !== null && availableUids.includes(uid);

    // collect referenced, existing scene uids
    const referenced: number[] = [];
    const add = (uid: number | null) => {
        if (exists(uid) && !referenced.includes(uid)) referenced.push(uid);
    };
    portals.forEach((p) => { add(p.frontUid); add(p.backUid); });

    // choose the start scene: explicit start if valid, else first referenced
    const start = exists(startUid) ? startUid : (referenced[0] ?? null);
    if (start === null) return null;

    // index order: start first, then the rest in first-seen order
    const sceneUids: number[] = [start, ...referenced.filter(u => u !== start)];
    if (sceneUids.length < 2) return null;

    const indexOf = (uid: number | null): number | null => {
        const i = exists(uid) ? sceneUids.indexOf(uid) : -1;
        return i >= 0 ? i : null;
    };

    const rewritten = portals.map(p => ({
        position: [p.position[0], p.position[1], p.position[2]] as Vec3,
        rotation: [p.rotation[0], p.rotation[1], p.rotation[2], p.rotation[3]] as Quat,
        width: p.width,
        height: p.height,
        front: indexOf(p.frontUid),
        back: indexOf(p.backUid)
    }));

    const portalScenes = sceneUids.map((_, i) => sceneUrl(i, streaming));
    const portalCollision = collision ? sceneUids.map((_, i) => collisionUrl(i)) : [];

    return { sceneUids, portals: rewritten, portalScenes, portalStart: 0, portalCollision };
};

export { buildPortalBundle, sceneUrl, collisionUrl, ExportPortal, PortalBundle, Vec3, Quat };

const EYE_HEIGHT = 1.6;
const SIDE_NUDGE = 0.5;

// Rotate vector v by unit quaternion q (q * v * q^-1).
const rotateByQuat = (q: Quat, v: Vec3): Vec3 => {
    const [x, y, z, w] = q;
    const tx = 2 * (y * v[2] - z * v[1]);
    const ty = 2 * (z * v[0] - x * v[2]);
    const tz = 2 * (x * v[1] - y * v[0]);
    return [
        v[0] + w * tx + (y * tz - z * ty),
        v[1] + w * ty + (z * tx - x * tz),
        v[2] + w * tz + (x * ty - y * tx)
    ];
};

const resolveCollisionSeed = (args: {
    sceneIndex: number,
    sceneUid: number,
    portals: ExportPortal[],
    authored: Record<string, Vec3>,
    startSeed: Vec3
}): { seed: Vec3, estimated: boolean } => {
    const { sceneIndex, sceneUid, portals, authored, startSeed } = args;

    if (sceneIndex === 0) {
        return { seed: [startSeed[0], startSeed[1], startSeed[2]], estimated: false };
    }

    const a = authored[String(sceneUid)];
    if (a && a.length >= 3) {
        return { seed: [a[0], a[1], a[2]], estimated: false };
    }

    // portal-derived best-effort: first portal whose front/back is this scene
    const p = portals.find(pt => pt.frontUid === sceneUid || pt.backUid === sceneUid);
    if (!p) {
        // no portal references it (shouldn't happen for an exported scene) -> fall back to start seed
        return { seed: [startSeed[0], startSeed[1], startSeed[2]], estimated: true };
    }
    const up = rotateByQuat(p.rotation, [0, 1, 0]);
    const n = rotateByQuat(p.rotation, [0, 0, 1]);
    const sign = p.frontUid === sceneUid ? 1 : -1;
    const hh = p.height * 0.5;
    // S = C - (H/2)*up (bottom edge) + h*worldUp + sign*d*n
    const seed: Vec3 = [
        p.position[0] - hh * up[0] + sign * SIDE_NUDGE * n[0],
        p.position[1] - hh * up[1] + EYE_HEIGHT + sign * SIDE_NUDGE * n[1],
        p.position[2] - hh * up[2] + sign * SIDE_NUDGE * n[2]
    ];
    return { seed, estimated: true };
};

export { resolveCollisionSeed, EYE_HEIGHT, SIDE_NUDGE };

// Start-scene collision seed = the start camera's initial position (or origin).
// Pure (no playcanvas) so both the export and publish upload paths share it.
const collisionSeedTuple = (es: { cameras?: { initial?: { position?: [number, number, number] } }[] }): [number, number, number] => {
    return es.cameras?.[0]?.initial?.position ?? [0, 0, 0];
};

export { collisionSeedTuple };

type PortalExtra = {
    index: number,
    uid: number,
    collisionUrl: string | null,
    environment: 'indoor' | 'outdoor',
    seed: Vec3,
    estimated: boolean
};

// Resolve the per-extra-scene export inputs shared by BOTH the local writer
// (file-handler -> serializeViewer) and the server upload path. Pure: takes
// already-extracted primitives (no playcanvas / Splat objects), so it is
// unit-testable and guarantees the local and server paths compute an identical
// bundle + ordering. Index 0 (primary/start) is excluded from `extras`.
const resolvePortalExtras = (args: {
    portals: ExportPortal[],
    startUid: number | null,
    availableUids: number[],
    streaming: boolean,
    collision: boolean,
    authored: Record<string, Vec3>,
    startSeed: Vec3,
    environments: ('indoor' | 'outdoor')[]
}): { bundle: PortalBundle, extras: PortalExtra[] } | null => {
    const { portals, startUid, availableUids, streaming, collision, authored, startSeed, environments } = args;
    const bundle = buildPortalBundle({ portals, startUid, availableUids, streaming, collision });
    if (!bundle) return null;

    const extras: PortalExtra[] = bundle.sceneUids.slice(1).map((uid, i) => {
        const index = i + 1;
        const { seed, estimated } = resolveCollisionSeed({ sceneIndex: index, sceneUid: uid, portals, authored, startSeed });
        return {
            index,
            uid,
            collisionUrl: collision ? (bundle.portalCollision[index] ?? null) : null,
            environment: environments[index] ?? 'indoor',
            seed,
            estimated
        };
    });

    return { bundle, extras };
};

export { resolvePortalExtras, PortalExtra };
