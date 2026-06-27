type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

type InfiniteEdges = { top: boolean, right: boolean, bottom: boolean, left: boolean };

type PortalRect = {
    position: Vec3,
    rotation: Quat,   // unit quaternion [x, y, z, w]
    width: number,
    height: number,
    frontUid: number | null,  // scene on the local +Z side
    backUid: number | null,   // scene on the local -Z side
    infinite?: InfiniteEdges  // edges extended to the scene boundary (absent = none)
};

// Crossing test for the segment prev -> cur against the portal rectangle.
// Adapted from the off-limits viewer collision (segmentBlockedByWall): same
// local-frame transform (rectangle in local XY, normal local Z), but instead of
// clamping it reports which side the camera ended on and the segment parameter t.
const segmentCrossesRect = (prev: Vec3, cur: Vec3, rect: PortalRect): { side: 'front' | 'back', t: number } | null => {
    const cx = rect.position[0], cy = rect.position[1], cz = rect.position[2];
    const qx = rect.rotation[0], qy = rect.rotation[1], qz = rect.rotation[2], qw = rect.rotation[3];
    const hw = rect.width * 0.5;
    const hh = rect.height * 0.5;

    // Rotate (p - center) into local frame using the inverse (conjugate) rotation.
    const toLocal = (p: Vec3): Vec3 => {
        const x = p[0] - cx, y = p[1] - cy, z = p[2] - cz;
        const ix = -qx, iy = -qy, iz = -qz, iw = qw;
        const tx = 2 * (iy * z - iz * y);
        const ty = 2 * (iz * x - ix * z);
        const tz = 2 * (ix * y - iy * x);
        return [
            x + iw * tx + (iy * tz - iz * ty),
            y + iw * ty + (iz * tx - ix * tz),
            z + iw * tz + (ix * ty - iy * tx)
        ];
    };

    const a = toLocal(prev);
    const b = toLocal(cur);
    const az = a[2], bz = b[2];

    const eps = 1e-9;
    if (az * bz > 0 || az === bz || (Math.abs(az) < eps && Math.abs(bz) < eps)) {
        return null;
    }

    const t = az / (az - bz);
    if (t < 0 || t > 1) {
        return null;
    }

    const ix = a[0] + t * (b[0] - a[0]);
    const iy = a[1] + t * (b[1] - a[1]);
    // Per-edge bounds: an edge flagged `infinite` extends to the scene boundary,
    // so a crossing past that edge still counts. With no flags this is identical
    // to the original |ix| <= hw && |iy| <= hh test.
    const inf = rect.infinite;
    if (ix > hw && !(inf && inf.right)) return null;
    if (ix < -hw && !(inf && inf.left)) return null;
    if (iy > hh && !(inf && inf.top)) return null;
    if (iy < -hh && !(inf && inf.bottom)) return null;

    // The camera ends on the side of `cur`: local +Z is front, -Z is back.
    return { side: bz > 0 ? 'front' : 'back', t };
};

// Walk all portals, apply each crossing in order along the segment, and return
// the resulting active splat uid (or the unchanged current uid if none cross).
//
// `cross` defaults to segmentCrossesRect and exists only so the exported-viewer
// companion can stringify this function (resolveActiveSplat.toString()) and inject
// it into a SEPARATE scope: after terser minification this body would otherwise
// call segmentCrossesRect by its mangled top-level name (e.g. `ZD`), which is not
// declared inside the injected IIFE -> ReferenceError that kills the runtime's
// rAF loop. The companion passes segmentCrossesRect explicitly (so the stringified
// default is never evaluated); the editor preview (portals-runtime.ts) and the
// unit tests run in-bundle and use the default.
const resolveActiveSplat = (prev: Vec3, cur: Vec3, portals: PortalRect[], currentUid: number | null, cross = segmentCrossesRect): number | null => {
    const crossings: { t: number, uid: number | null }[] = [];
    for (const p of portals) {
        const c = cross(prev, cur, p);
        if (c) {
            crossings.push({ t: c.t, uid: c.side === 'front' ? p.frontUid : p.backUid });
        }
    }
    crossings.sort((m, n) => m.t - n.t);
    let active = currentUid;
    for (const c of crossings) {
        // a crossing into a side with no bound scene (null uid) leaves the active scene unchanged
        if (c.uid !== null) {
            active = c.uid;
        }
    }
    return active;
};

export { segmentCrossesRect, resolveActiveSplat, PortalRect, InfiniteEdges, Vec3, Quat };
