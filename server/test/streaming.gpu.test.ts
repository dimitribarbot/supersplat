import { Column, DataTable, Transform, writeFile, MemoryFileSystem } from '@playcanvas/splat-transform';
import { gzipSync, inflateRawSync } from 'node:zlib';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { probeGpu, createGpuSession } from '../src/gpu.js';
import { runExport, type RunResult } from '../src/run-export.js';
import type { ProgressEvent } from '../src/progress.js';

const NAMES = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

const makePlyGz = async (n = 2048): Promise<Buffer> => {
    const cols = NAMES.map((name, i) => new Column(name, Float32Array.from({ length: n }, (_, r) => Math.fround(Math.sin((i + 1) + r * 0.001)))));
    const memFs = new MemoryFileSystem();
    await writeFile({ filename: 'p.ply', outputFormat: 'ply', dataTable: new DataTable(cols, Transform.PLY), options: {} }, memFs);
    return Buffer.from(gzipSync(Buffer.from(memFs.results.get('p.ply')!)));
};

// Extract entry names from a ZIP via its central directory (robust against
// arbitrary compressed payloads, unlike scanning local headers).
const zipEntryNames = (buf: Buffer): string[] => {
    let eocd = buf.length - 22;
    while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
    if (eocd < 0) throw new Error('zip: end-of-central-directory not found');
    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('zip: bad central directory header');
        const fnLen = buf.readUInt16LE(off + 28);
        const exLen = buf.readUInt16LE(off + 30);
        const cmLen = buf.readUInt16LE(off + 32);
        names.push(buf.toString('utf8', off + 46, off + 46 + fnLen));
        off += 46 + fnLen + exLen + cmLen;
    }
    return names;
};

// Read and decompress a single named entry from a ZIP (store or deflate).
const zipReadEntry = (buf: Buffer, want: string): Buffer => {
    let eocd = buf.length - 22;
    while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
    if (eocd < 0) throw new Error('zip: end-of-central-directory not found');
    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    for (let i = 0; i < count; i++) {
        const method = buf.readUInt16LE(off + 10);
        const compSize = buf.readUInt32LE(off + 20);
        const fnLen = buf.readUInt16LE(off + 28);
        const exLen = buf.readUInt16LE(off + 30);
        const cmLen = buf.readUInt16LE(off + 32);
        const lho = buf.readUInt32LE(off + 42);
        const name = buf.toString('utf8', off + 46, off + 46 + fnLen);
        if (name === want) {
            const lfnLen = buf.readUInt16LE(lho + 26);
            const lexLen = buf.readUInt16LE(lho + 28);
            const dataStart = lho + 30 + lfnLen + lexLen;
            const comp = buf.subarray(dataStart, dataStart + compSize);
            return method === 0 ? Buffer.from(comp) : inflateRawSync(comp);
        }
        off += 46 + fnLen + exLen + cmLen;
    }
    throw new Error(`zip: entry not found: ${want}`);
};

const experienceSettings = {
    version: 2,
    tonemapping: 'none',
    highPrecisionRendering: false,
    background: { color: [0, 0, 0] },
    postEffectSettings: {},
    animTracks: [],
    cameras: [],
    annotations: [],
    startMode: 'default'
};

describe('runExport streaming packageViewer (GPU)', () => {
    let gpu = false;
    let res: RunResult | undefined;
    const events: ProgressEvent[] = [];
    const logs: string[] = [];

    beforeAll(async () => {
        gpu = (await probeGpu()).gpu;
        if (!gpu) return;
        const plyGz = await makePlyGz(2048);
        const spy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { logs.push(a.join(' ')); });
        const session = createGpuSession();
        try {
            res = await runExport({
                plyGz,
                options: {
                    fileType: 'packageViewer',
                    filename: 'out.zip',
                    viewerExportSettings: { type: 'zip', streaming: true, experienceSettings }
                },
                sink: { emit: e => events.push(e) },
                getDeviceCreator: session.getDeviceCreator
            });
        } finally {
            await session.dispose();
            spy.mockRestore();
        }
    }, 180000);

    it('zip entries are all relative (no absolute / cwd-prefixed paths)', () => {
        if (!gpu) { console.warn('No GPU available; skipping streaming GPU test'); return; }
        const names = zipEntryNames(Buffer.from(res!.files[0].data));
        for (const nm of names) {
            expect(nm).not.toMatch(/^[A-Za-z]:[\\/]/);   // C:\ or C:/
            expect(nm).not.toContain('supersplat/server');
            expect(nm.startsWith('/')).toBe(false);
        }
    });

    it('includes lod-meta.json and a 0_0 chunk folder', () => {
        if (!gpu) return;
        const names = zipEntryNames(Buffer.from(res!.files[0].data));
        expect(names).toContain('lod-meta.json');
        expect(names.some(n => /^0_0\//.test(n))).toBe(true);
    });

    it('emits progress events carrying a numeric value (the bar can move)', () => {
        if (!gpu) return;
        expect(events.some(e => e.kind === 'progress' && typeof e.value === 'number')).toBe(true);
    });

    it('logs a per-chunk summary line for chunk 0_0', () => {
        if (!gpu) return;
        expect(logs.some(l => /Created streaming chunk 0_0 \(\d+ files?, /.test(l))).toBe(true);
    });

    it('viewer index.html fetches contentUrl (so ?content= can override) with lod-meta.json default', () => {
        if (!gpu) return;
        const html = zipReadEntry(Buffer.from(res!.files[0].data), 'index.html').toString('utf8');
        // content fetch is driven by contentUrl, not a hardcoded URL
        expect(html).toContain('fetch(contentUrl)');
        expect(html).not.toContain('fetch("./lod-meta.json")');
        expect(html).not.toContain('fetch("index.sog")');
        // default content (when ?content is absent) is the streaming bundle
        expect(html).toContain("'./lod-meta.json'");
    });
});
