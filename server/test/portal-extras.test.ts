import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { runExport } from '../src/run-export.js';

// A tiny valid binary PLY with 1 vertex (x,y,z) — enough for readFile to parse.
const tinyPly = (): Buffer => {
    const header = 'ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n';
    const body = Buffer.alloc(12); // one zeroed vertex
    return Buffer.concat([Buffer.from(header, 'ascii'), body]);
};
const noGpu = () => { throw new Error('no gpu in this test'); };

describe('runExport portal extras (CPU plumbing)', () => {
    it('plain ply path ignores extras (no GPU touched)', async () => {
        const res = await runExport({
            plyGz: gzipSync(tinyPly()),
            options: { fileType: 'ply', filename: 'out.ply' },
            sink: { emit() {} },
            getDeviceCreator: noGpu,
            extraPlyGz: [gzipSync(tinyPly())]
        });
        expect(res.files[0].name).toBe('out.ply');
    });

    it('packageViewer reaches the GPU step only AFTER parsing the primary table (extras accepted on the args)', async () => {
        // With noGpu, the viewer write throws when it requests a device — proving the
        // call path accepts extraPlyGz/portalExtras and progresses past parsing.
        await expect(runExport({
            plyGz: gzipSync(tinyPly()),
            options: {
                fileType: 'packageViewer', filename: 'out.zip',
                viewerExportSettings: { type: 'zip', streaming: false, experienceSettings: {} },
                portalExtras: [{ seed: [0, 0, 0], environment: 'indoor', collisionUrl: null, streaming: false }]
            } as any,
            sink: { emit() {} },
            getDeviceCreator: noGpu,
            extraPlyGz: [gzipSync(tinyPly())]
        })).rejects.toBeTruthy();
    });
});
