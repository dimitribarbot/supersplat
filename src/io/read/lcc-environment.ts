/**
 * LCC / LCC2 environment (skybox) loading.
 *
 * splat-transform v3's streaming LCC readers deliberately exclude the optional
 * environment chunk (readLcc[2]Source return an environment-less source), and
 * the functions that fetch it (readLcc[2]EnvironmentSource) are not part of the
 * public API and are tree-shaken out of the runtime bundle. Before v3 the fork's
 * loader relied on readFile returning the environment as a second table and
 * combine()-ing it into the scene; this module restores that.
 *
 * - LCC v1: `environment.bin` uses LCC's internal quantized record format. The
 *   decoder here is a faithful port of splat-transform's `deserializeEnvironment`
 *   (+ its dequant helpers), so a future splat-transform bump that changes the
 *   format would require updating this file. Guarded so any mismatch degrades to
 *   "no environment" rather than a crash.
 * - LCC2: the environment is a standard SOG/SPZ chunk referenced by `meta.lcc2`,
 *   so it is read through the public API (no custom codec).
 *
 * Every entry point is best-effort: a missing environment (the common "no
 * skybox" case) or any decode failure returns null so the main scene still loads.
 */

import {
    Column,
    DataTable,
    Transform,
    getInputFormat,
    readFile,
    createChunkDataPool,
    materializeToDataTable,
    type Options,
    type ReadFileSystem
} from '@playcanvas/splat-transform';
import { Vec3 } from 'playcanvas';

// --- constants (mirrors splat-transform) ---
const kSH_C0 = 0.28209479177387814;
const SQRT_2 = 1.414213562373095;
const SQRT_2_INV = 0.7071067811865475;

const defaultOptions: Options = {
    iterations: 10,
    lodSelect: [],
    unbundled: false,
    lodChunkCount: 512,
    lodChunkExtent: 16
};

// LCC v1 and LCC2 share the same fixed coordinate transform (Y-up -> engine),
// applied lazily on consume. Mirrors splat-transform's LCC_TRANSFORM/LCC2_TRANSFORM.
const LCC_TRANSFORM = () => new Transform().fromEulers(90, 0, 180);

// directory portion of a "dir/name" path (returns "" for a bare filename).
const dirOf = (p: string): string => {
    const i = p.lastIndexOf('/');
    return i < 0 ? '' : p.slice(0, i + 1);
};

// read a file's raw bytes through a ReadFileSystem.
const readBytes = async (fileSystem: ReadFileSystem, filename: string): Promise<Uint8Array> => {
    const source = await fileSystem.createSource(filename);
    try {
        return await source.read().readAll();
    } finally {
        source.close();
    }
};

// --- LCC v1 quantized-record decode (faithful port) ---

const invSigmoid = (v: number) => -Math.log((1.0 - v) / v);
const invSH0ToColor = (v: number) => (v - 0.5) / kSH_C0;
const invLinearScale = (v: number) => Math.log(v);
const mix = (min: number, max: number, s: number) => (1.0 - s) * min + s * max;

type CompressInfo = {
    envScaleMin: Vec3;
    envScaleMax: Vec3;
    envShMin: Vec3;
    envShMax: Vec3;
};

// parse the min/max quantization ranges from meta.lcc (env variants fall back to
// the scene ranges). Mirrors splat-transform's parseMeta (env fields only).
const parseMeta = (obj: any): CompressInfo => {
    const attributes: Record<string, any> = {};
    obj.attributes.forEach((attr: any) => {
        attributes[attr.name] = attr;
    });
    const envScaleMin = new Vec3(attributes.envscale?.min ?? attributes.scale.min);
    const envScaleMax = new Vec3(attributes.envscale?.max ?? attributes.scale.max);
    const envShMin = new Vec3(attributes.envshcoef?.min ?? attributes.shcoef.min);
    const envShMax = new Vec3(attributes.envshcoef?.max ?? attributes.shcoef.max);
    return { envScaleMin, envScaleMax, envShMin, envShMax };
};

// whether the LCC scene carries spherical harmonics. Mirrors splat-transform's lccHasSH.
const lccHasSH = (lccJson: any): boolean => {
    if (lccJson.fileType === 'Portable') return false;
    if (lccJson.fileType === 'Quality') return true;
    return lccJson.attributes.findIndex((attr: any) => attr.name === 'shcoef') !== -1;
};

// decode a packed rotation quaternion into the four rot columns at index `idx`.
// 3 components at 10 bits each + a 2-bit index of the omitted (largest) component.
const decodeRotationInto = (
    v: number,
    rot0: Float32Array, rot1: Float32Array, rot2: Float32Array, rot3: Float32Array,
    idx: number
) => {
    const d0 = (v & 1023) / 1023.0;
    const d1 = ((v >> 10) & 1023) / 1023.0;
    const d2 = ((v >> 20) & 1023) / 1023.0;
    const d3 = (v >> 30) & 3;
    const qx = d0 * SQRT_2 - SQRT_2_INV;
    const qy = d1 * SQRT_2 - SQRT_2_INV;
    const qz = d2 * SQRT_2 - SQRT_2_INV;
    const qw = Math.sqrt(1 - Math.min(1.0, qx * qx + qy * qy + qz * qz));
    if (d3 === 0) {
        rot0[idx] = qz; rot1[idx] = qw; rot2[idx] = qx; rot3[idx] = qy;
    } else if (d3 === 1) {
        rot0[idx] = qz; rot1[idx] = qx; rot2[idx] = qw; rot3[idx] = qy;
    } else if (d3 === 2) {
        rot0[idx] = qz; rot1[idx] = qx; rot2[idx] = qy; rot3[idx] = qw;
    } else {
        rot0[idx] = qw; rot1[idx] = qx; rot2[idx] = qy; rot3[idx] = qz;
    }
};

// decode environment.bin into a DataTable. Faithful port of splat-transform's
// deserializeEnvironment: 32-byte records (96 with SH), see field offsets below.
const deserializeEnvironment = (raw: Uint8Array, compressInfo: CompressInfo, hasSH: boolean): DataTable => {
    const stride = hasSH ? 96 : 32;
    const numGaussians = raw.length / stride;
    if (!Number.isInteger(numGaussians)) {
        throw new Error('Invalid environment data size');
    }
    const columns = [
        'x', 'y', 'z',
        'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
        'scale_0', 'scale_1', 'scale_2',
        'rot_0', 'rot_1', 'rot_2', 'rot_3'
    ].concat(hasSH ? new Array(45).fill('').map((_, i) => `f_rest_${i}`) : [])
    .map(name => new Column(name, new Float32Array(numGaussians)));

    const { envScaleMin: scaleMin, envScaleMax: scaleMax, envShMin: shMin, envShMax: shMax } = compressInfo;
    const rot0 = columns[10].data as Float32Array;
    const rot1 = columns[11].data as Float32Array;
    const rot2 = columns[12].data as Float32Array;
    const rot3 = columns[13].data as Float32Array;

    const dataView = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let i = 0; i < numGaussians; i++) {
        const off = i * stride;
        (columns[0].data as Float32Array)[i] = dataView.getFloat32(off + 0, true);
        (columns[1].data as Float32Array)[i] = dataView.getFloat32(off + 4, true);
        (columns[2].data as Float32Array)[i] = dataView.getFloat32(off + 8, true);
        (columns[3].data as Float32Array)[i] = invSH0ToColor(dataView.getUint8(off + 12) / 255.0);
        (columns[4].data as Float32Array)[i] = invSH0ToColor(dataView.getUint8(off + 13) / 255.0);
        (columns[5].data as Float32Array)[i] = invSH0ToColor(dataView.getUint8(off + 14) / 255.0);
        (columns[6].data as Float32Array)[i] = invSigmoid(dataView.getUint8(off + 15) / 255.0);
        (columns[7].data as Float32Array)[i] = invLinearScale(mix(scaleMin.x, scaleMax.x, dataView.getUint16(off + 16, true) / 65535.0));
        (columns[8].data as Float32Array)[i] = invLinearScale(mix(scaleMin.y, scaleMax.y, dataView.getUint16(off + 18, true) / 65535.0));
        (columns[9].data as Float32Array)[i] = invLinearScale(mix(scaleMin.z, scaleMax.z, dataView.getUint16(off + 20, true) / 65535.0));
        decodeRotationInto(dataView.getUint32(off + 22, true), rot0, rot1, rot2, rot3, i);
        // bytes 26-32: normals (skipped, matching splat-transform)
        if (hasSH) {
            for (let j = 0; j < 15; ++j) {
                const enc = dataView.getUint32(off + 32 + j * 4, true);
                const nx = (enc & 0x7FF) / 2047.0;
                const ny = ((enc >> 11) & 0x3FF) / 1023.0;
                const nz = ((enc >> 21) & 0x7FF) / 2047.0;
                (columns[14 + j].data as Float32Array)[i] = mix(shMin.x, shMax.x, nx);
                (columns[14 + j + 15].data as Float32Array)[i] = mix(shMin.y, shMax.y, ny);
                (columns[14 + j + 30].data as Float32Array)[i] = mix(shMin.z, shMax.z, nz);
            }
        }
    }
    return new DataTable(columns);
};

// read the LCC v1 environment (environment.bin next to meta.lcc) as a DataTable,
// or null if there is no skybox / it can't be decoded.
const readLccV1Environment = async (fileSystem: ReadFileSystem, filename: string): Promise<DataTable | null> => {
    let lccJson: any;
    try {
        lccJson = JSON.parse(new TextDecoder().decode(await readBytes(fileSystem, filename)));
    } catch {
        return null;
    }
    let envData: Uint8Array;
    try {
        envData = await readBytes(fileSystem, `${dirOf(filename)}environment.bin`);
    } catch {
        // a missing environment.bin is the normal "no skybox" case
        return null;
    }
    try {
        const hasSH = lccHasSH(lccJson);
        const compressInfo = parseMeta(lccJson);
        const envTable = deserializeEnvironment(envData, compressInfo, hasSH);
        if (envTable.numRows === 0) {
            return null;
        }
        envTable.transform = LCC_TRANSFORM();
        return envTable;
    } catch {
        return null;
    }
};

// --- LCC2 environment (standard SOG/SPZ chunk via the public API) ---

// resolve the LCC2 env chunk filename from meta.lcc2, tolerating the legacy
// protocol (root.files, needing a '.sog' suffix). Returns null if no env chunk.
const resolveLcc2EnvFile = (meta: any): string | null => {
    // env detection: meta.root.data.env.name is the index into the splat files.
    const envIndex = meta?.root?.data?.env?.name;
    if (envIndex === undefined || envIndex === null) {
        return null;
    }
    let splatFiles: string[] | undefined = meta?.root?.splatFiles;
    if (!Array.isArray(splatFiles)) {
        // legacy protocol: root.files, drop leading '/', append '.sog'
        const legacy = meta?.root?.files;
        if (Array.isArray(legacy)) {
            splatFiles = legacy.map((f: string) => {
                let p = f.startsWith('/') ? f.slice(1) : f;
                if (!p.endsWith('.sog')) p = `${p}.sog`;
                return p;
            });
        }
    }
    if (!Array.isArray(splatFiles) || !splatFiles[envIndex]) {
        return null;
    }
    return splatFiles[envIndex];
};

// materialize a single splat file (the env chunk) to a DataTable via the public
// API, handling bundled .sog (needs a zip wrapper) and .spz/other formats.
const materializeChunk = async (fileSystem: ReadFileSystem, chunkPath: string): Promise<DataTable | null> => {
    const inputFormat = getInputFormat(chunkPath);
    const pool = createChunkDataPool();
    try {
        if (inputFormat === 'sog' && chunkPath.toLowerCase().endsWith('.sog')) {
            // bundled SOG: wrap the file as its own read filesystem, read meta.json
            const { ZipReadFileSystem } = await import('@playcanvas/splat-transform');
            const source = await fileSystem.createSource(chunkPath);
            const zipFs = new ZipReadFileSystem(source);
            try {
                const sources = await readFile({ filename: 'meta.json', inputFormat: 'sog', options: defaultOptions, params: [], fileSystem: zipFs });
                const table = await materializeToDataTable(sources[0], pool);
                await sources[0].close();
                return table;
            } finally {
                zipFs.close();
            }
        }
        const sources = await readFile({ filename: chunkPath, inputFormat, options: defaultOptions, params: [], fileSystem });
        const table = await materializeToDataTable(sources[0], pool);
        await sources[0].close();
        return table;
    } finally {
        pool.destroy();
    }
};

// read the LCC2 environment chunk as a DataTable, or null if there is no skybox.
const readLcc2Environment = async (fileSystem: ReadFileSystem, filename: string): Promise<DataTable | null> => {
    let meta: any;
    try {
        meta = JSON.parse(new TextDecoder().decode(await readBytes(fileSystem, filename)));
    } catch {
        return null;
    }
    const envFile = resolveLcc2EnvFile(meta);
    if (!envFile) {
        return null;
    }
    try {
        const envTable = await materializeChunk(fileSystem, `${dirOf(filename)}${envFile}`);
        if (!envTable || envTable.numRows === 0) {
            return null;
        }
        envTable.transform = LCC_TRANSFORM();
        return envTable;
    } catch {
        return null;
    }
};

/**
 * Read the environment (skybox) splats for an LCC (v1) or LCC2 file, or null if
 * the format has no environment / it can't be loaded. Best-effort by design.
 * @param fileSystem - file system to read from
 * @param filename - path to the meta.lcc / meta.lcc2 file
 */
const readLccEnvironment = async (fileSystem: ReadFileSystem, filename: string): Promise<DataTable | null> => {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.lcc2')) {
        return await readLcc2Environment(fileSystem, filename);
    }
    if (lower.endsWith('.lcc')) {
        return await readLccV1Environment(fileSystem, filename);
    }
    return null;
};

export { readLccEnvironment, deserializeEnvironment, resolveLcc2EnvFile };
