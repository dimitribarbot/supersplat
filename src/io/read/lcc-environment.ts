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
    type ChunkSourceMetadata,
    type ExtraColumn,
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
// Hardcoded because neither constant is exported; verified identical in
// splat-transform 3.4.2. RE-CHECK THIS ON EVERY splat-transform BUMP: if
// upstream's transform drifts, concatSource sees two sources whose `transform`
// disagrees and refuses the fold, silently dropping the skybox.
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

// --- conforming the environment table to the scene source's layout ---

// The columns splat-transform's dataTableToChunkSource recognises by name and
// maps to the position/geometric/color layers. Everything else in a table is
// either an f_rest_* SH coefficient or an `other`-layer extra.
const STANDARD_COLUMNS = [
    'x', 'y', 'z',
    'rot_0', 'rot_1', 'rot_2', 'rot_3',
    'scale_0', 'scale_1', 'scale_2',
    'f_dc_0', 'f_dc_1', 'f_dc_2',
    'opacity'
];

// f_rest_* column count for a band count: 3 channels x ((bands + 1)^2 - 1)
// coefficients each, giving 0 / 9 / 24 / 45 for bands 0-3. This is the SH
// definition rather than a transcribed table; splat-transform's equivalent
// (SH_REST_COUNTS) is not part of its public export list, so it can't be reused.
const shRestCount = (shBands: number) => 3 * ((shBands + 1) ** 2 - 1);

// How dataTableToChunkSource classifies a column's storage when it becomes an
// `other`-layer extra: float32 and float64 both narrow to float32, everything
// else is read as raw uint32 words.
const extraTypeOf = (column: Column): ExtraColumn['type'] => {
    return (column.dataType === 'float32' || column.dataType === 'float64') ? 'float32' : 'uint32';
};

/**
 * Make `table`'s layout equal the scene source's declared layout, so the two can
 * be handed to `concatSource`.
 *
 * `concatSource` refuses sources that disagree on SH band count, available
 * layers or extra columns -- and it compares the extras as an *ordered*
 * `name:type` key -- so every one of those disagreements is a hard failure of
 * the whole file load. The pre-v3 `combine()` unioned columns by name and
 * zero-filled the absent ones, which absorbed all of this silently; nothing
 * does that now, so the environment is conformed here instead:
 *
 * - **SH bands** -- `f_rest_*` is padded up to the scene's band count with
 *   zero-filled columns, and any beyond it are dropped. Both directions occur:
 *   an LCC2 environment is an independent `.sog`/`.spz` sub-file whose band
 *   count is free to differ from the scene chunks' in either direction. (LCC v1
 *   cannot diverge -- `lccHasSH` reads the same file-level `shcoef` attribute
 *   that governs the scene -- but this path serves both.)
 *
 *   **Dropping bands beyond the scene's count loses environment SH detail, and
 *   that loss is deliberate.** Do not "fix" the trim: `concatSource` demands one
 *   shared colour layout, and the only alternative -- padding the *scene* up to
 *   the environment's band count -- would mean materialising the scene, which is
 *   exactly the streaming memory win this whole path exists to protect.
 *   Removing the trim reintroduces a hard load failure on every `.lcc2` whose
 *   environment carries more bands than its scene.
 * - **Extras** -- exactly the scene's extras, in the scene's order, matched to
 *   the environment's own columns *by name* (not by position) and re-emitted
 *   zeroed when absent or when the storage type disagrees.
 * - **Env-only extras** -- dropped. The combined source's `other` layout has no
 *   slot for a column the scene does not declare, so carrying it is not an
 *   option; keeping it would make the concat throw.
 *
 * Applied at the `readLccEnvironment` level rather than inside
 * `deserializeEnvironment` so the LCC2 path -- whose table comes from
 * `materializeToDataTable`, not our own decoder -- is covered from one place.
 *
 * @param table - the decoded environment table, conformed in place
 * @param sceneLayout - the scene source's `meta`; only `shBands` and
 * `extraColumns` are read
 */
const conformToSceneLayout = (
    table: DataTable,
    sceneLayout: Pick<ChunkSourceMetadata, 'shBands' | 'extraColumns'>
) => {
    const numRows = table.numRows;
    const zeros = (type: ExtraColumn['type']) => {
        return type === 'uint32' ? new Uint32Array(numRows) : new Float32Array(numRows);
    };

    const columns: Column[] = [];

    // the standard layers, in canonical order, keeping only what is present
    for (const name of STANDARD_COLUMNS) {
        const column = table.getColumnByName(name);
        if (column) {
            columns.push(column);
        }
    }

    // exactly the scene's SH run: reuse, zero-fill, or drop
    for (let i = 0; i < shRestCount(sceneLayout.shBands); ++i) {
        const name = `f_rest_${i}`;
        columns.push(table.getColumnByName(name) ?? new Column(name, zeros('float32')));
    }

    // exactly the scene's extras, in the scene's order
    for (const { name, type } of sceneLayout.extraColumns) {
        const column = table.getColumnByName(name);
        columns.push(column && extraTypeOf(column) === type ?
            column :
            new Column(name, zeros(type)));
    }

    table.columns = columns;
};

/**
 * Read the environment (skybox) splats for an LCC (v1) or LCC2 file, or null if
 * the format has no environment / it can't be loaded. Best-effort by design.
 * @param fileSystem - file system to read from
 * @param filename - path to the meta.lcc / meta.lcc2 file
 * @param sceneLayout - the scene source's `meta`, whose `shBands` and
 * `extraColumns` the environment table is conformed to so the two can be
 * concatenated (see {@link conformToSceneLayout}). Omit to leave the decoded
 * table exactly as it came out of the reader.
 */
const readLccEnvironment = async (
    fileSystem: ReadFileSystem,
    filename: string,
    sceneLayout?: Pick<ChunkSourceMetadata, 'shBands' | 'extraColumns'>
): Promise<DataTable | null> => {
    // getInputFormat rather than a suffix test: it strips any query/hash first,
    // so an `...meta.lcc?v=2` still dispatches instead of silently returning
    // null. Matches loader.ts's gate, which is derived the same way.
    const inputFormat = getInputFormat(filename);
    const table = inputFormat === 'lcc2' ? await readLcc2Environment(fileSystem, filename) :
        inputFormat === 'lcc' ? await readLccV1Environment(fileSystem, filename) :
            null;
    if (table && sceneLayout) {
        conformToSceneLayout(table, sceneLayout);
    }
    return table;
};

export { readLccEnvironment, conformToSceneLayout, deserializeEnvironment, resolveLcc2EnvFile };
