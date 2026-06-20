// Pure (playcanvas-free) point-pair registration math, mirrored from Horn's
// closed-form quaternion solution. Kept separate from alignment.ts so it can be
// unit-tested in a node environment (importing playcanvas hangs there), the same
// way merge-cut-geom.ts isolates the merge-cut geometry.

type Vec3Like = { x: number; y: number; z: number };
type AlignmentMode = 'rigid' | 'similarity';

type AlignmentSolveRaw = {
    rotation: [number, number, number, number]; // x, y, z, w
    translation: [number, number, number];
    scale: number;
    rms: number;
    residuals: number[];
};

// Cyclic Jacobi eigen-decomposition of a 4x4 symmetric matrix. Returns the
// (normalized) eigenvector of the largest eigenvalue, ordered as the matrix rows
// are (w, x, y, z for Horn's matrix). Unlike power iteration, this has no
// dependence on a start vector, so it recovers eigenvectors orthogonal to the
// identity quaternion — the ~180-degree rotation case power iteration misses.
const largestEigenVector4 = (m: number[][]) => {
    const n = 4;
    const a = m.map(row => row.slice());
    const v = [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1]
    ];

    for (let sweep = 0; sweep < 64; sweep++) {
        let off = 0;
        for (let p = 0; p < n; p++) {
            for (let q = p + 1; q < n; q++) {
                off += Math.abs(a[p][q]);
            }
        }
        if (off < 1e-15) {
            break;
        }

        for (let p = 0; p < n; p++) {
            for (let q = p + 1; q < n; q++) {
                const apq = a[p][q];
                if (Math.abs(apq) < 1e-300) {
                    continue;
                }

                // tangent of the rotation that zeros a[p][q] (smaller root, stable)
                const beta = (a[q][q] - a[p][p]) / (2 * apq);
                const t = beta === 0 ? 1 : Math.sign(beta) / (Math.abs(beta) + Math.sqrt(beta * beta + 1));
                const c = 1 / Math.sqrt(t * t + 1);
                const s = t * c;

                // apply the Givens rotation in the (p, q) plane to a (both sides)
                for (let k = 0; k < n; k++) {
                    const akp = a[k][p];
                    const akq = a[k][q];
                    a[k][p] = c * akp - s * akq;
                    a[k][q] = s * akp + c * akq;
                }
                for (let k = 0; k < n; k++) {
                    const apk = a[p][k];
                    const aqk = a[q][k];
                    a[p][k] = c * apk - s * aqk;
                    a[q][k] = s * apk + c * aqk;
                }

                // accumulate the eigenvectors
                for (let k = 0; k < n; k++) {
                    const vkp = v[k][p];
                    const vkq = v[k][q];
                    v[k][p] = c * vkp - s * vkq;
                    v[k][q] = s * vkp + c * vkq;
                }
            }
        }
    }

    let best = 0;
    for (let i = 1; i < n; i++) {
        if (a[i][i] > a[best][best]) {
            best = i;
        }
    }

    const q = [v[0][best], v[1][best], v[2][best], v[3][best]];
    const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return q.map(x => x / len);
};

// rotate a vector by a quaternion given as [x, y, z, w]
const rotateByQuat = (q: number[], x: number, y: number, z: number): [number, number, number] => {
    const [qx, qy, qz, qw] = q;
    // t = 2 * cross(q.xyz, v)
    const tx = 2 * (qy * z - qz * y);
    const ty = 2 * (qz * x - qx * z);
    const tz = 2 * (qx * y - qy * x);
    // v + qw * t + cross(q.xyz, t)
    return [
        x + qw * tx + (qy * tz - qz * ty),
        y + qw * ty + (qz * tx - qx * tz),
        z + qw * tz + (qx * ty - qy * tx)
    ];
};

const solveAlignmentRaw = (source: Vec3Like[], target: Vec3Like[], mode: AlignmentMode): AlignmentSolveRaw | null => {
    const n = Math.min(source.length, target.length);
    if (n < 3) {
        return null;
    }

    let scx = 0, scy = 0, scz = 0;
    let tcx = 0, tcy = 0, tcz = 0;
    for (let i = 0; i < n; i++) {
        scx += source[i].x; scy += source[i].y; scz += source[i].z;
        tcx += target[i].x; tcy += target[i].y; tcz += target[i].z;
    }
    scx /= n; scy /= n; scz /= n;
    tcx /= n; tcy /= n; tcz /= n;

    let sxx = 0, sxy = 0, sxz = 0;
    let syx = 0, syy = 0, syz = 0;
    let szx = 0, szy = 0, szz = 0;
    let sourceVariance = 0;

    for (let i = 0; i < n; i++) {
        const x = source[i].x - scx;
        const y = source[i].y - scy;
        const z = source[i].z - scz;
        const u = target[i].x - tcx;
        const v = target[i].y - tcy;
        const w = target[i].z - tcz;

        sxx += x * u; sxy += x * v; sxz += x * w;
        syx += y * u; syy += y * v; syz += y * w;
        szx += z * u; szy += z * v; szz += z * w;
        sourceVariance += x * x + y * y + z * z;
    }

    if (sourceVariance <= 1e-16) {
        return null;
    }

    const trace = sxx + syy + szz;
    const nmat = [
        [trace, syz - szy, szx - sxz, sxy - syx],
        [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
        [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
        [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz]
    ];

    // eigenvector is ordered (w, x, y, z); rotation quaternion is (x, y, z, w)
    const e = largestEigenVector4(nmat);
    const rotation: [number, number, number, number] = [e[1], e[2], e[3], e[0]];

    let scaleNumerator = 0;
    for (let i = 0; i < n; i++) {
        const [rx, ry, rz] = rotateByQuat(rotation, source[i].x - scx, source[i].y - scy, source[i].z - scz);
        scaleNumerator += (target[i].x - tcx) * rx + (target[i].y - tcy) * ry + (target[i].z - tcz) * rz;
    }

    const scale = mode === 'similarity' ? scaleNumerator / sourceVariance : 1;
    // Hardened guard: a non-positive scale means the solve degenerated (e.g. an
    // anti-correlated cloud). Returning null is safe; clamping to ~0 used to
    // collapse the whole source scene to the target centroid.
    if (!(scale > 0)) {
        return null;
    }

    const [crx, cry, crz] = rotateByQuat(rotation, scx, scy, scz);
    const translation: [number, number, number] = [
        tcx - scale * crx,
        tcy - scale * cry,
        tcz - scale * crz
    ];

    const residuals: number[] = [];
    let residualSum = 0;
    for (let i = 0; i < n; i++) {
        const [rx, ry, rz] = rotateByQuat(rotation, source[i].x, source[i].y, source[i].z);
        const dx = rx * scale + translation[0] - target[i].x;
        const dy = ry * scale + translation[1] - target[i].y;
        const dz = rz * scale + translation[2] - target[i].z;
        const residual = Math.hypot(dx, dy, dz);
        residuals.push(residual);
        residualSum += residual * residual;
    }

    return {
        rotation,
        translation,
        scale,
        rms: Math.sqrt(residualSum / n),
        residuals
    };
};

export {
    AlignmentMode,
    AlignmentSolveRaw,
    Vec3Like,
    largestEigenVector4,
    solveAlignmentRaw
};
