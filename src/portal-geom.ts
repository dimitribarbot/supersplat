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
//
// Runs every rAF frame for every portal in the exported viewer, so the
// no-crossing path is allocation-free: the quaternion-conjugate rotation into
// the local frame is inlined as scalar math (no arrays, no closures); the only
// allocation is the result object on an actual crossing (rare).
const segmentCrossesRect = (prev: Vec3, cur: Vec3, rect: PortalRect): { side: 'front' | 'back', t: number } | null => {
    const cx = rect.position[0], cy = rect.position[1], cz = rect.position[2];
    const qx = rect.rotation[0], qy = rect.rotation[1], qz = rect.rotation[2], qw = rect.rotation[3];
    const hw = rect.width * 0.5;
    const hh = rect.height * 0.5;

    // Inverse (conjugate) rotation, applied inline to both endpoints:
    // local = v + qw*t + (qv x t) with t = 2*(qv x v), qv = (-qx,-qy,-qz).
    const ivx = -qx, ivy = -qy, ivz = -qz;

    let x = prev[0] - cx, y = prev[1] - cy, z = prev[2] - cz;
    let tx = 2 * (ivy * z - ivz * y);
    let ty = 2 * (ivz * x - ivx * z);
    let tz = 2 * (ivx * y - ivy * x);
    const ax = x + qw * tx + (ivy * tz - ivz * ty);
    const ay = y + qw * ty + (ivz * tx - ivx * tz);
    const az = z + qw * tz + (ivx * ty - ivy * tx);

    x = cur[0] - cx; y = cur[1] - cy; z = cur[2] - cz;
    tx = 2 * (ivy * z - ivz * y);
    ty = 2 * (ivz * x - ivx * z);
    tz = 2 * (ivx * y - ivy * x);
    const bx = x + qw * tx + (ivy * tz - ivz * ty);
    const by = y + qw * ty + (ivz * tx - ivx * tz);
    const bz = z + qw * tz + (ivx * ty - ivy * tx);

    const eps = 1e-9;
    if (az * bz > 0 || az === bz || (Math.abs(az) < eps && Math.abs(bz) < eps)) {
        return null;
    }

    const t = az / (az - bz);
    if (t < 0 || t > 1) {
        return null;
    }

    const hx = ax + t * (bx - ax);
    const hy = ay + t * (by - ay);
    // Per-edge bounds: an edge flagged `infinite` extends to the scene boundary,
    // so a crossing past that edge still counts. With no flags this is identical
    // to the original |hx| <= hw && |hy| <= hh test.
    const inf = rect.infinite;
    if (hx > hw && !(inf && inf.right)) return null;
    if (hx < -hw && !(inf && inf.left)) return null;
    if (hy > hh && !(inf && inf.top)) return null;
    if (hy < -hh && !(inf && inf.bottom)) return null;

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
//
// Hot path: called every rAF frame. The crossings array is created lazily so the
// steady state (no crossing this frame) allocates nothing; indexed loops avoid
// the for..of iterator allocation.
const resolveActiveSplat = (prev: Vec3, cur: Vec3, portals: PortalRect[], currentUid: number | null, cross = segmentCrossesRect): number | null => {
    let crossings: { t: number, uid: number | null }[] = null;
    for (let i = 0; i < portals.length; i++) {
        const p = portals[i];
        const c = cross(prev, cur, p);
        if (c) {
            if (!crossings) {
                crossings = [];
            }
            crossings.push({ t: c.t, uid: c.side === 'front' ? p.frontUid : p.backUid });
        }
    }
    if (!crossings) {
        return currentUid;
    }
    crossings.sort((m, n) => m.t - n.t);
    let active = currentUid;
    for (let i = 0; i < crossings.length; i++) {
        // a crossing into a side with no bound scene (null uid) leaves the active scene unchanged
        if (crossings[i].uid !== null) {
            active = crossings[i].uid;
        }
    }
    return active;
};

export { segmentCrossesRect, resolveActiveSplat, PortalRect, InfiniteEdges, Vec3, Quat };
