/**
 * Unified loader for all splat file formats using splat-transform.
 */

import {
    ChunkData,
    ChunkDataPool,
    ChunkLayer,
    ChunkSource,
    ChunkSourceMetadata,
    Options,
    ReadFileSystem,
    ReadRequest,
    Transform,
    ZipReadFileSystem,
    concatSource,
    createChunkDataPool,
    dataTableToChunkSource,
    getInputFormat,
    materializeToDataTable,
    readFile,
    selectLod,
    sortMortonOrder
} from '@playcanvas/splat-transform';

import { readLccEnvironment } from './lcc-environment';

type LoadResult = {
    source: ChunkSource;
    transform: Transform;
};

// invoked when a file contains multiple LODs. returns the LOD index to load,
// or null to cancel the load.
type PickLod = (lodCounts: readonly number[]) => Promise<number | null>;

// maximum splat count considered reasonable to load, used to select a default
// LOD level for multi-LOD formats (e.g. LCC)
const LOD_MAX_SPLATS = 20_000_000;

// pick the most detailed LOD under the splat limit, or the least detailed
// when all levels exceed it
const defaultLodIndex = (lodCounts: readonly number[]) => {
    const candidates = lodCounts.map((count, index) => ({ count, index }));
    const under = candidates.filter(c => c.count < LOD_MAX_SPLATS);
    if (under.length > 0) {
        return under.reduce((a, b) => (b.count > a.count ? b : a)).index;
    }
    return candidates.reduce((a, b) => (b.count < a.count ? b : a)).index;
};

/**
 * Default options for readFile.
 */
const defaultOptions: Options = {
    iterations: 10,
    lodSelect: [],
    unbundled: false,
    lodChunkCount: 512,
    lodChunkExtent: 16
};

/**
 * Presents `parent` reordered by `order` (`order[row]` is the parent row that
 * appears at `row`). `parent` and `order` are public so consumers doing bulk
 * sequential work (e.g. the initial texture upload) can iterate the parent in
 * its native order — fast sequential reads — and scatter rows to their
 * permuted destination, instead of gathering the whole file in permuted order.
 */
class PermutedChunkSource implements ChunkSource {
    readonly meta: ChunkSourceMetadata;

    constructor(readonly parent: ChunkSource, readonly order: Uint32Array) {
        this.meta = {
            ...parent.meta,
            numGaussians: order.length,
            numLods: 1,
            lodCounts: [order.length],
            numChunks: [Math.ceil(order.length / parent.meta.chunkSize)]
        };
    }

    read(request: ReadRequest): Promise<void> {
        const target = {
            position: request.position,
            geometric: request.geometric,
            color: request.color,
            other: request.other
        };
        if ('indices' in request) {
            const mapped = new Uint32Array(request.count);
            for (let i = 0; i < request.count; ++i) {
                mapped[i] = this.order[request.indices[request.indexOffset + i]];
            }
            return this.parent.read({
                ...target,
                indices: mapped,
                indexOffset: 0,
                count: mapped.length
            });
        }

        const anyData = (request.position ?? request.geometric ?? request.color ?? request.other) as ChunkData;
        const indexOffset = request.chunkIndex * this.meta.chunkSize;
        return this.parent.read({
            ...target,
            indices: this.order,
            indexOffset,
            count: anyData.count
        });
    }

    close(): Promise<void> {
        return this.parent.close();
    }
}

class OwnedChunkSource implements ChunkSource {
    readonly meta: ChunkSourceMetadata;
    private closed = false;

    constructor(private readonly parent: ChunkSource, private readonly onClose: () => void | Promise<void>) {
        this.meta = parent.meta;
    }

    read(request: ReadRequest): Promise<void> {
        return this.parent.read(request);
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        try {
            await this.parent.close();
        } finally {
            await this.onClose();
        }
    }
}

const selectFirst = async (sources: ChunkSource[], pickLod?: PickLod) => {
    const first = sources[0];
    for (let i = 1; i < sources.length; ++i) await sources[i].close();
    if (first.meta.numLods <= 1) return first;

    const lod = pickLod ? await pickLod(first.meta.lodCounts) : defaultLodIndex(first.meta.lodCounts);
    if (lod === null) {
        await first.close();
        return null;
    }
    return new OwnedChunkSource(selectLod(first, lod), () => first.close());
};

const mortonOrderSource = async (source: ChunkSource) => {
    const pool = createChunkDataPool({ chunkSize: source.meta.chunkSize });
    try {
        const positions = await materializeToDataTable(source, pool, new Set<ChunkLayer>(['position']));
        const indices = new Uint32Array(source.meta.numGaussians);
        for (let i = 0; i < indices.length; ++i) indices[i] = i;
        sortMortonOrder(positions, indices);
        return new PermutedChunkSource(source, indices);
    } finally {
        pool.destroy();
    }
};

const validateSplatSource = (source: ChunkSource): void => {
    const required: ChunkLayer[] = ['position', 'geometric', 'color'];
    const missing = required.filter(layer => !source.meta.availableLayers.has(layer));
    if (missing.length > 0) {
        throw new Error(`This file does not contain gaussian splatting data. The following layers are missing: ${missing.join(', ')}`);
    }
};

/**
 * Open a lazy ChunkSource and keep it alive for the lifetime of the loaded Splat.
 * Returns null if the user cancels LOD selection.
 */
const loadSplatSource = async (
    filename: string,
    fileSystem: ReadFileSystem,
    skipReorder?: boolean,
    pickLod?: PickLod
): Promise<LoadResult | null> => {
    const inputFormat = getInputFormat(filename);
    const lowerFilename = filename.toLowerCase();
    let source: ChunkSource;

    if (inputFormat === 'sog' && lowerFilename.endsWith('.sog')) {
        const archive = await fileSystem.createSource(filename);
        const zipFs = new ZipReadFileSystem(archive);
        try {
            const sources = await readFile({
                filename: 'meta.json',
                inputFormat: 'sog',
                options: defaultOptions,
                params: [],
                fileSystem: zipFs
            });
            const selected = await selectFirst(sources, pickLod);
            if (!selected) {
                zipFs.close();
                return null;
            }
            source = new OwnedChunkSource(selected, () => zipFs.close());
        } catch (err) {
            zipFs.close();
            throw err;
        }
    } else {
        const sources = await readFile({
            filename,
            inputFormat,
            options: defaultOptions,
            params: [],
            fileSystem
        });
        source = await selectFirst(sources, pickLod);
        if (!source) return null;
    }

    try {
        validateSplatSource(source);

        // Restore the LCC/LCC2 environment (skybox) splats. v3's streaming LCC
        // readers exclude the environment chunk (splat-transform's own
        // readLccEnvironmentSource is not publicly exported), so we decode it
        // ourselves and concatenate it on. Best-effort: readLccEnvironment
        // returns null when there is no skybox or it can't be decoded.
        //
        // concatSource refuses sources whose layouts disagree, so the scene's
        // meta goes in and readLccEnvironment conforms the environment table's
        // SH bands and extra columns to it (see conformToSceneLayout).
        //
        // The concat sits *below* the morton reorder, as combine() did pre-v3, so
        // the skybox is reordered along with the scene: concatSource serves the
        // index gather PermutedChunkSource turns every read into (asserted in
        // test/lcc-environment-concat.test.ts).
        //
        // Gated on inputFormat rather than the filename suffix: getInputFormat
        // strips any query/hash first, so a suffix test would load an
        // `...meta.lcc?v=2` as LCC and then silently skip its skybox.
        if (inputFormat === 'lcc' || inputFormat === 'lcc2') {
            const envTable = await readLccEnvironment(fileSystem, filename, source.meta);
            if (envTable) {
                const chunkSize = source.meta.chunkSize;
                // Declared outside the try so the catch can release whichever of
                // the two was actually built. The guarded region covers the whole
                // fold -- pool, env source AND concat -- because a throw from any
                // of the three has the same consequence, and each leaves a
                // different amount to tear down (see the catch).
                let pool: ChunkDataPool;
                let envSource: ChunkSource;
                try {
                    pool = createChunkDataPool({ chunkSize });
                    // The model tag is the one axis concatSource does NOT validate:
                    // it silently resolves a disagreement to 'default' (with only a
                    // logger.warn), which would retag an antialiased or 2dgs .lcc2
                    // scene-wide just because it has a skybox. A DataTable carries no
                    // model, so the scene's has to be passed in explicitly.
                    envSource = dataTableToChunkSource(envTable, chunkSize, undefined, source.meta.model);
                    // concatSource reads through the pool lazily, so the pool must
                    // outlive the source: hand it to OwnedChunkSource, which
                    // destroys it when the loaded source is finally closed.
                    source = new OwnedChunkSource(
                        concatSource([source, envSource], pool),
                        () => pool.destroy()
                    );
                } catch (err) {
                    // Nothing took ownership of the pool or the env source on this
                    // path (only the OwnedChunkSource above ever does), so whatever
                    // exists is released here. The optional calls are load-bearing:
                    // createChunkDataPool throwing leaves neither, and
                    // dataTableToChunkSource throwing leaves a pool but no env
                    // source. concatSource validates layout agreement synchronously,
                    // so its refusal leaves both.
                    //
                    // Deliberately NOT rethrown: the skybox is best-effort (see
                    // readLccEnvironment), and conformToSceneLayout only covers the
                    // SH-band and extra-column axes. Any other disagreement
                    // concatSource checks -- availableLayers, transform, chunkSize --
                    // would otherwise turn "no skybox" into "this .lcc2 will not open
                    // at all", which is what the pre-v3 combine() could never do. The
                    // same goes for a throw out of dataTableToChunkSource, which
                    // repacks the caller-supplied column data.
                    // `source` is still the un-concatenated scene source (the
                    // assignment above never ran), so the load continues without the
                    // environment. Only this fold is swallowed; a failure of the
                    // scene source itself still propagates to the outer catch.
                    pool?.destroy();
                    // a rejecting close must not resurrect the hard failure this
                    // catch exists to prevent
                    await envSource?.close().catch(() => { /* nothing consumed it */ });
                    console.warn('LCC environment could not be folded in; loading without skybox:', err);
                }
            }
        }

        const isCompressedPly = lowerFilename.endsWith('.compressed.ply');
        if (inputFormat !== 'sog' && !isCompressedPly && !skipReorder) {
            source = await mortonOrderSource(source);
        }

        return { source, transform: source.meta.transform };
    } catch (err) {
        await source.close();
        throw err;
    }
};

export {
    defaultLodIndex,
    loadSplatSource,
    PermutedChunkSource,
    validateSplatSource
};
