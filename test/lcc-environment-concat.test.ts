/**
 * The LCC/LCC2 skybox restore, post-v3.
 *
 * v3's streaming LCC readers exclude the environment chunk, so the fork decodes
 * it separately (`readLccEnvironment`) and folds it onto the scene source with
 * splat-transform's `concatSource`. `concatSource` refuses sources that disagree
 * on layout -- chunk size, SH bands, available layers, extra columns (compared
 * as an *ordered* key), transform -- and every one of those refusals is a hard
 * failure of the whole file load. The pre-v3 `combine()` unioned columns by name
 * and zero-filled the absent ones, so all of it used to load.
 *
 * The fork-specific behaviour under test is therefore `conformToSceneLayout`:
 * making the environment table's layout equal the scene source's declared one,
 * in every direction it can differ. Each case asserts the *seam* -- data read
 * back through the real composition -- not just that the concat was accepted.
 *
 * The `model` tag is the exception to all of the above: `concatSource` does NOT
 * refuse a disagreement there, it silently resolves one to `'default'`. That
 * makes it the one axis a passing load can get wrong, so it is covered
 * separately, together with two source-level guards on `loader.ts`'s call site
 * for the two silent losses a unit test of the composition cannot reach.
 *
 * The first three cases are a deliberate probe of `concatSource`'s contract:
 * case 3 settles whether it serves the index *gather* that `PermutedChunkSource`
 * (morton ordering) turns every read into, which is what decides whether the
 * concat may sit inside or must sit outside the morton wrapper.
 */

import { readFileSync } from 'fs';

import {
    Column,
    DataTable,
    MemoryReadFileSystem,
    Transform,
    concatSource,
    createChunkDataPool,
    dataTableToChunkSource,
    materializeToDataTable,
    type ChunkSource,
    type ExtraColumn,
    type SplatModel
} from '@playcanvas/splat-transform';
import { describe, expect, it } from 'vitest';

import { conformToSceneLayout, readLccEnvironment } from '../src/io/read/lcc-environment';
import { PermutedChunkSource } from '../src/io/read/loader';

const CHUNK = 256;

// LCC v1 and LCC2 both label their data with this pending transform; the
// environment table carries it too, and `concatSource` throws on a mismatch.
const lccTransform = () => new Transform().fromEulers(90, 0, 180);

// the three `other`-layer extras splat-transform's LCC scene reader declares
const LCC_EXTRAS: ExtraColumn[] = [
    { name: 'nx', type: 'float32' },
    { name: 'ny', type: 'float32' },
    { name: 'nz', type: 'float32' }
];

const NO_NORMALS = { nx: 0, ny: 0, nz: 0 };

// f_rest_* column count for a band count: 3 channels x ((bands+1)^2 - 1)
// coefficients -> 0 / 9 / 24 / 45.
const restCount = (bands: number) => 3 * ((bands + 1) ** 2 - 1);

// a minimal valid splat table of `xs.length` gaussians, x taken from `xs`.
// `extras` are appended in object order with the given fill; `shBands` adds the
// matching run of f_rest_* columns, each filled with `restFill`.
const makeTable = (
    xs: number[],
    opts: { extras?: Record<string, number>, shBands?: number, restFill?: number } = {}
) => {
    const n = xs.length;
    const col = (name: string, fill: number) => new Column(name, new Float32Array(n).fill(fill));
    const rest: Column[] = [];
    for (let i = 0; i < restCount(opts.shBands ?? 0); ++i) {
        rest.push(col(`f_rest_${i}`, opts.restFill ?? 0));
    }
    const table = new DataTable([
        new Column('x', new Float32Array(xs)),
        col('y', 0), col('z', 0),
        col('rot_0', 1), col('rot_1', 0), col('rot_2', 0), col('rot_3', 0),
        col('scale_0', -3), col('scale_1', -3), col('scale_2', -3),
        col('f_dc_0', 0), col('f_dc_1', 0), col('f_dc_2', 0),
        col('opacity', 4),
        ...rest,
        ...Object.entries(opts.extras ?? {}).map(([name, fill]) => col(name, fill))
    ]);
    table.transform = lccTransform();
    return table;
};

const columnOf = async (source: ChunkSource, name = 'x') => {
    const pool = createChunkDataPool({ chunkSize: source.meta.chunkSize });
    try {
        const table = await materializeToDataTable(source, pool);
        return Array.from(table.getColumnByName(name).data as Float32Array);
    } finally {
        pool.destroy();
    }
};

/**
 * The whole production composition in one call: derive the scene source, conform
 * the environment table to its layout, concatenate, optionally morton-permute,
 * and read one column back through the result. Returns the column values plus
 * the combined metadata so a case can assert both the seam and the layout.
 */
const seam = async (
    sceneTable: DataTable,
    envTable: DataTable,
    opts: { column?: string, order?: number[], model?: SplatModel, tagEnvModel?: boolean } = {}
) => {
    const scene = dataTableToChunkSource(sceneTable, CHUNK, undefined, opts.model);
    conformToSceneLayout(envTable, scene.meta);
    // mirrors loader.ts: a DataTable carries no model tag, so the environment
    // source is given the scene's. `tagEnvModel: false` reproduces omitting it.
    const env = dataTableToChunkSource(
        envTable, CHUNK, undefined, opts.tagEnvModel === false ? undefined : scene.meta.model
    );
    const pool = createChunkDataPool({ chunkSize: CHUNK });
    try {
        const concatenated = concatSource([scene, env], pool);
        const combined: ChunkSource = opts.order ?
            new PermutedChunkSource(concatenated, new Uint32Array(opts.order)) :
            concatenated;
        return { values: await columnOf(combined, opts.column), meta: concatenated.meta };
    } finally {
        pool.destroy();
    }
};

// --- a single-record LCC v1 environment on a memory filesystem ---

// one environment record: x/y/z float32, f_dc0-2 + opacity uint8, scale0-2
// uint16, packed rotation uint32, then 6 bytes of (skipped) normals -- 32 bytes,
// or 96 with the 15 packed SH words appended.
const buildEnvRecord = (x: number, hasSH: boolean): Uint8Array => {
    const buf = new Uint8Array(hasSH ? 96 : 32);
    const dv = new DataView(buf.buffer);
    dv.setFloat32(0, x, true);
    dv.setUint8(12, 200);
    dv.setUint8(13, 100);
    dv.setUint8(14, 50);
    dv.setUint8(15, 128);
    dv.setUint16(16, 0, true);
    dv.setUint16(18, 0, true);
    dv.setUint16(20, 0, true);
    dv.setUint32(22, 0xC0000000, true);
    return buf;
};

const envFileSystem = (xs: number[], hasSH = false, metaName = 'scene/meta.lcc') => {
    const fileSystem = new MemoryReadFileSystem();
    fileSystem.set(metaName, new TextEncoder().encode(JSON.stringify({
        // 'Quality' means "has SH" to lccHasSH; 'Portable' means "has none"
        fileType: hasSH ? 'Quality' : 'Portable',
        attributes: [
            { name: 'scale', min: [0.5, 0.5, 0.5], max: [2, 2, 2] },
            { name: 'shcoef', min: [-1, -1, -1], max: [1, 1, 1] }
        ]
    })));
    const stride = hasSH ? 96 : 32;
    const raw = new Uint8Array(stride * xs.length);
    xs.forEach((x, i) => raw.set(buildEnvRecord(x, hasSH), i * stride));
    fileSystem.set('scene/environment.bin', raw);
    return fileSystem;
};

// the scene layout `readLccEnvironment` conforms to, as ChunkSourceMetadata does
const sceneLayout = (shBands: number, extraColumns: readonly ExtraColumn[] = []) => {
    return { shBands, extraColumns } as any;
};

describe('concatSource over a scene plus an environment table', () => {
    it('presents scene rows then environment rows, in order', async () => {
        const pool = createChunkDataPool({ chunkSize: CHUNK });
        const scene = dataTableToChunkSource(makeTable([1, 2, 3]), CHUNK);
        const env = dataTableToChunkSource(makeTable([4, 5]), CHUNK);
        const combined = concatSource([scene, env], pool);
        expect(combined.meta.numGaussians).toBe(5);
        expect(await columnOf(combined)).toEqual([1, 2, 3, 4, 5]);
        pool.destroy();
    });

    it('throws when the two sources disagree on extra columns', () => {
        const pool = createChunkDataPool({ chunkSize: CHUNK });
        const scene = dataTableToChunkSource(makeTable([1, 2, 3], { extras: NO_NORMALS }), CHUNK);
        const env = dataTableToChunkSource(makeTable([4, 5]), CHUNK);
        expect(() => concatSource([scene, env], pool)).toThrow();
        pool.destroy();
    });

    // The verdict this file exists for: PermutedChunkSource turns *every* read --
    // chunk reads included -- into an index gather on its parent, so putting the
    // concat underneath morton ordering only works if concatSource serves gathers.
    it('serves the index gather PermutedChunkSource issues for every read', async () => {
        const pool = createChunkDataPool({ chunkSize: CHUNK });
        const scene = dataTableToChunkSource(makeTable([1, 2, 3]), CHUNK);
        const env = dataTableToChunkSource(makeTable([4, 5]), CHUNK);
        const combined = concatSource([scene, env], pool);
        // a permutation that straddles the seam in both directions
        const permuted = new PermutedChunkSource(combined, new Uint32Array([4, 0, 3, 1, 2]));
        expect(await columnOf(permuted)).toEqual([5, 1, 4, 2, 3]);
        pool.destroy();
    });
});

describe('conformToSceneLayout: SH bands', () => {
    it('pads the environment up to the scene\'s band count, zero-filling', async () => {
        const scene = makeTable([1, 2, 3], { shBands: 3, restFill: 9 });
        const env = makeTable([7, 8]);
        const { values, meta } = await seam(scene, env, { column: 'f_rest_0' });
        expect(meta.shBands).toBe(3);
        // the scene keeps its coefficients; the environment reads back as zeros
        expect(values).toEqual([9, 9, 9, 0, 0]);
        // every band the scene declares is present, not just the first
        expect(env.hasColumn('f_rest_44')).toBe(true);
        expect(await seam(scene, makeTable([7, 8]), { column: 'f_rest_44' })).toMatchObject({
            values: [9, 9, 9, 0, 0]
        });
    });

    it('trims environment bands the scene does not have', async () => {
        const scene = makeTable([1, 2, 3]);
        const env = makeTable([7, 8], { shBands: 3, restFill: 5 });
        const { values, meta } = await seam(scene, env);
        expect(meta.shBands).toBe(0);
        expect(env.hasColumn('f_rest_0')).toBe(false);
        expect(values).toEqual([1, 2, 3, 7, 8]);
    });

    it('pads to an intermediate band count without over- or under-shooting', async () => {
        const scene = makeTable([1], { shBands: 2, restFill: 4 });
        const env = makeTable([7]);
        const { meta } = await seam(scene, env);
        expect(meta.shBands).toBe(2);
        expect(env.hasColumn('f_rest_23')).toBe(true);
        expect(env.hasColumn('f_rest_24')).toBe(false);
    });
});

describe('conformToSceneLayout: extra columns', () => {
    it('reorders the environment extras into the scene\'s declared order', async () => {
        const scene = makeTable([1, 2, 3], { extras: NO_NORMALS });
        // same three names, declared in a different order, with distinguishable
        // values -- concatSource compares extras as an ordered key, so this
        // throws unless the environment is re-emitted in the scene's order
        const env = makeTable([7, 8], { extras: { nz: 30, nx: 10, ny: 20 } });
        const { values, meta } = await seam(scene, env, { column: 'ny' });
        expect(meta.extraColumns.map(c => c.name)).toEqual(['nx', 'ny', 'nz']);
        // reuse is by NAME: 'ny' must read 20, not nz's 30 or nx's 10
        expect(values).toEqual([0, 0, 0, 20, 20]);
        expect(await seam(
            makeTable([1, 2, 3], { extras: NO_NORMALS }),
            makeTable([7, 8], { extras: { nz: 30, nx: 10, ny: 20 } }),
            { column: 'nz' }
        )).toMatchObject({ values: [0, 0, 0, 30, 30] });
    });

    it('drops extras the scene does not declare', async () => {
        const scene = makeTable([1, 2, 3], { extras: NO_NORMALS });
        const env = makeTable([7, 8], { extras: { nx: 10, ny: 20, nz: 30, blind: 99 } });
        const { values, meta } = await seam(scene, env);
        expect(meta.extraColumns.map(c => c.name)).toEqual(['nx', 'ny', 'nz']);
        expect(env.hasColumn('blind')).toBe(false);
        expect(values).toEqual([1, 2, 3, 7, 8]);
    });

    it('zero-fills extras the environment lacks', async () => {
        const scene = makeTable([1, 2, 3], { extras: { nx: 1, ny: 1, nz: 1 } });
        const env = makeTable([7, 8]);
        const { values, meta } = await seam(scene, env, { column: 'nx' });
        expect(meta.extraColumns.map(c => c.name)).toEqual(['nx', 'ny', 'nz']);
        expect(values).toEqual([1, 1, 1, 0, 0]);
    });

    it('replaces an extra whose storage type disagrees with the scene\'s', async () => {
        const scene = makeTable([1, 2, 3]);
        scene.addColumn(new Column('id', new Uint32Array([5, 6, 7])));
        const env = makeTable([7, 8]);
        // the environment's 'id' is float32 where the scene's is uint32; the two
        // cannot share an `other` layout, so it is re-emitted zeroed as uint32
        env.addColumn(new Column('id', new Float32Array([1, 2])));
        const { meta } = await seam(scene, env);
        expect(meta.extraColumns).toEqual([{ name: 'id', type: 'uint32' }]);
    });
});

// `model` is the one axis concatSource does NOT validate: on a disagreement
// resolveSplatModel silently returns 'default' and only logger.warn's. So an
// antialiased or 2dgs .lcc2 (whose scene model comes from its first sub-file)
// would be retagged as ordinary gaussians scene-wide, purely because it has a
// skybox. A DataTable carries no model tag, so the scene's must be passed in.
describe('the splat model tag survives the concat', () => {
    it('keeps a non-default scene model when the environment carries it too', async () => {
        const { meta } = await seam(
            makeTable([1, 2, 3], { extras: NO_NORMALS }),
            makeTable([7, 8]),
            { model: 'antialiased' }
        );
        expect(meta.model).toBe('antialiased');
    });

    // shows the argument is load-bearing rather than incidental: omit it and the
    // whole scene silently degrades, with no throw to notice
    it('silently degrades to \'default\' when the environment is left untagged', async () => {
        const { meta } = await seam(
            makeTable([1, 2, 3], { extras: NO_NORMALS }),
            makeTable([7, 8]),
            { model: 'antialiased', tagEnvModel: false }
        );
        expect(meta.model).toBe('default');
    });

    it('leaves an already-default scene model alone', async () => {
        const { meta } = await seam(makeTable([1, 2, 3]), makeTable([7, 8]));
        expect(meta.model).toBe('default');
    });
});

// The two silent-loss guards above and below cannot be reached through a unit
// test of the composition, because both live at loader.ts's call site and
// driving loadSplatSource would need a byte-valid LCC container. Guard the call
// site's source text instead -- the same approach test/viewer-html-anchors.test.ts
// takes for the exported viewer's injection anchors.
describe('loader.ts call site', () => {
    const loaderSource = readFileSync('src/io/read/loader.ts', 'utf8');

    it('passes the scene model to the environment source', () => {
        expect(loaderSource).toMatch(
            /dataTableToChunkSource\(\s*envTable,\s*chunkSize,\s*undefined,\s*source\.meta\.model\s*\)/
        );
    });

    it('gates the environment branch on inputFormat, not the filename suffix', () => {
        expect(loaderSource).toMatch(/inputFormat === 'lcc' \|\| inputFormat === 'lcc2'/);
        expect(loaderSource).not.toMatch(/endsWith\('\.lcc/);
    });
});

describe('conformToSceneLayout: both axes at once, through morton ordering', () => {
    it('conforms bands and extras together and survives the permutation', async () => {
        const scene = makeTable([1, 2, 3], { shBands: 1, restFill: 2, extras: NO_NORMALS });
        const env = makeTable([7, 8], { shBands: 3, restFill: 5, extras: { nz: 30, blind: 99 } });
        const { values, meta } = await seam(scene, env, { order: [3, 2, 4, 1, 0] });
        expect(meta.shBands).toBe(1);
        expect(meta.extraColumns.map(c => c.name)).toEqual(['nx', 'ny', 'nz']);
        expect(values).toEqual([7, 3, 8, 2, 1]);
    });
});

describe('readLccEnvironment', () => {
    it('conforms the decoded environment to the scene layout it is handed', async () => {
        const table = await readLccEnvironment(
            envFileSystem([7, 8]), 'scene/meta.lcc', sceneLayout(0, LCC_EXTRAS)
        );
        expect(table).not.toBeNull();
        expect(table.numRows).toBe(2);
        // the normals the LCC scene reader declares but the environment lacks,
        // appended in the scene's declared order so the `other` layouts agree
        expect(table.columns.slice(-3).map(c => c.name)).toEqual(['nx', 'ny', 'nz']);
        for (const name of ['nx', 'ny', 'nz']) {
            expect(Array.from(table.getColumnByName(name).data as Float32Array)).toEqual([0, 0]);
        }
        // the real columns are untouched
        expect(Array.from(table.getColumnByName('x').data as Float32Array)).toEqual([7, 8]);
    });

    it('trims a decoded SH environment down to a scene with no SH', async () => {
        const table = await readLccEnvironment(
            envFileSystem([7], true), 'scene/meta.lcc', sceneLayout(0, LCC_EXTRAS)
        );
        // the decoder emitted 45 f_rest_* columns; the scene declares none
        expect(table.hasColumn('f_rest_0')).toBe(false);
        expect(table.columns.slice(-3).map(c => c.name)).toEqual(['nx', 'ny', 'nz']);
    });

    // getInputFormat strips query and hash before matching, so a suffix test
    // here would return null for a URL-ish filename that loader.ts had already
    // classified as LCC -- losing the skybox with nothing to notice.
    it('dispatches on a filename carrying a query string', async () => {
        const table = await readLccEnvironment(
            envFileSystem([7, 8], false, 'scene/meta.lcc?v=2'),
            'scene/meta.lcc?v=2',
            sceneLayout(0, LCC_EXTRAS)
        );
        expect(table).not.toBeNull();
        expect(Array.from(table.getColumnByName('x').data as Float32Array)).toEqual([7, 8]);
        expect(table.columns.slice(-3).map(c => c.name)).toEqual(['nx', 'ny', 'nz']);
    });

    it('dispatches on a filename carrying a hash', async () => {
        const table = await readLccEnvironment(
            envFileSystem([9], false, 'scene/meta.lcc#frag'),
            'scene/meta.lcc#frag',
            sceneLayout(0, LCC_EXTRAS)
        );
        expect(table).not.toBeNull();
        expect(Array.from(table.getColumnByName('x').data as Float32Array)).toEqual([9]);
    });

    it('leaves the table alone when handed no scene layout', async () => {
        const table = await readLccEnvironment(envFileSystem([7]), 'scene/meta.lcc');
        expect(table.columns.some(c => c.name === 'nx')).toBe(false);
        // the decoder's own column order, unconformed
        expect(table.columns.slice(0, 4).map(c => c.name)).toEqual(['x', 'y', 'z', 'f_dc_0']);
    });

    it('concatenates onto a normals-carrying scene source, preserving the seam', async () => {
        const scene = dataTableToChunkSource(makeTable([1, 2, 3], { extras: NO_NORMALS }), CHUNK);
        const envTable = await readLccEnvironment(envFileSystem([7, 8]), 'scene/meta.lcc', scene.meta);
        const pool = createChunkDataPool({ chunkSize: CHUNK });
        const env = dataTableToChunkSource(envTable, CHUNK);
        // the conforming is what makes this call legal at all -- without it the
        // sources disagree on `other`/extraColumns and concatSource throws
        const combined = concatSource([scene, env], pool);
        expect(combined.meta.extraColumns.map(c => c.name)).toEqual(['nx', 'ny', 'nz']);
        expect(await columnOf(combined)).toEqual([1, 2, 3, 7, 8]);
        pool.destroy();
    });

    it('is still morton-orderable once the environment is folded in', async () => {
        const scene = dataTableToChunkSource(makeTable([1, 2, 3], { extras: NO_NORMALS }), CHUNK);
        const envTable = await readLccEnvironment(envFileSystem([7, 8]), 'scene/meta.lcc', scene.meta);
        const pool = createChunkDataPool({ chunkSize: CHUNK });
        const env = dataTableToChunkSource(envTable, CHUNK);
        const combined = concatSource([scene, env], pool);
        const permuted = new PermutedChunkSource(combined, new Uint32Array([3, 2, 4, 1, 0]));
        expect(await columnOf(permuted)).toEqual([7, 3, 8, 2, 1]);
        pool.destroy();
    });
});
