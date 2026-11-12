type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

type Wall = {
    position: Vec3;
    rotation: Quat; // unit quaternion [x, y, z, w]
    width: number;
    height: number;
    infinite?: { top: boolean; right: boolean; bottom: boolean; left: boolean };
};

// Returns the world-space safe point to clamp the camera to (the last safe
// position `prev`) when the segment prev -> cur crosses the wall rectangle,
// otherwise null.
//
// IMPORTANT: this function is self-contained (no imports, no outer references;
// only its parameters and inner helpers). It is injected verbatim into the
// exported viewer via Function.prototype.toString(), so it must stay portable
// plain JS/array math. Do not add module-level dependencies.
const segmentBlockedByWall = (prev: Vec3, cur: Vec3, wall: Wall): Vec3 | null => {
    const cx = wall.position[0],
        cy = wall.position[1],
        cz = wall.position[2];
    const qx = wall.rotation[0],
        qy = wall.rotation[1],
        qz = wall.rotation[2],
        qw = wall.rotation[3];
    const hw = wall.width * 0.5;
    const hh = wall.height * 0.5;

    // Rotate (p - center) into the wall's local frame using the INVERSE rotation
    // (conjugate of the unit quaternion: [-qx, -qy, -qz, qw]).
    const toLocal = (p: Vec3): Vec3 => {
        const x = p[0] - cx,
            y = p[1] - cy,
            z = p[2] - cz;
        const ix = -qx,
            iy = -qy,
            iz = -qz,
            iw = qw;
        // t = 2 * cross(q_vec, v)
        const tx = 2 * (iy * z - iz * y);
        const ty = 2 * (iz * x - ix * z);
        const tz = 2 * (ix * y - iy * x);
        // v' = v + iw * t + cross(q_vec, t)
        return [
            x + iw * tx + (iy * tz - iz * ty),
            y + iw * ty + (iz * tx - ix * tz),
            z + iw * tz + (ix * ty - iy * tx)
        ];
    };

    const a = toLocal(prev);
    const b = toLocal(cur);
    const az = a[2],
        bz = b[2];

    // same side of the wall plane, both on it, or a segment lying within
    // floating-point noise of the plane (e.g. parallel to it) -> no crossing
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
    // Per-edge bounds: an edge flagged `infinite` extends the wall to the scene
    // boundary, so a crossing past that edge still blocks. With no flags this is
    // identical to the original |ix| <= hw && |iy| <= hh test.
    const inf = wall.infinite;
    if (ix > hw && !(inf && inf.right)) return null;
    if (ix < -hw && !(inf && inf.left)) return null;
    if (iy > hh && !(inf && inf.top)) return null;
    if (iy < -hh && !(inf && inf.bottom)) return null;

    // Blocked: clamp back to the last safe (prev) world position.
    return [prev[0], prev[1], prev[2]];
};

// Where to put the XR rig (the camera's parent, which the headset's pose is
// relative to) when the head's move from `safe` to `head` crossed a wall. A
// teleport moves the rig itself in one jump: undo it whole, height included,
// since it may have landed on another level. Otherwise the head moved within
// the rig (walking) or the rig slid (grab-move): push it back horizontally by
// the overshoot, leaving its height alone so the floor does not bob with the
// head. Self-contained, injected verbatim like segmentBlockedByWall.
const xrRigAfterBlock = (safe: Vec3, head: Vec3, prevRig: Vec3, rig: Vec3): Vec3 => {
    const jx = rig[0] - prevRig[0],
        jy = rig[1] - prevRig[1],
        jz = rig[2] - prevRig[2];
    // no walk or grab-move covers half a metre in one frame
    if (jx * jx + jy * jy + jz * jz > 0.25) {
        return [prevRig[0], prevRig[1], prevRig[2]];
    }
    return [rig[0] + safe[0] - head[0], rig[1], rig[2] + safe[2] - head[2]];
};

export { segmentBlockedByWall, xrRigAfterBlock, Wall, Vec3, Quat };
