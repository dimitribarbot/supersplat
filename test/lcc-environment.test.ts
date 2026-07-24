import { describe, it, expect } from 'vitest';

import { deserializeEnvironment, resolveLcc2EnvFile } from '../src/io/read/lcc-environment';

// Build a single 32-byte (no-SH) environment record with known field values,
// matching splat-transform's layout: x/y/z float32, f_dc0-2 + opacity uint8,
// scale0-2 uint16, rotation uint32, then 6 bytes of (skipped) normals.
const buildNoShRecord = (): Uint8Array => {
    const buf = new Uint8Array(32);
    const dv = new DataView(buf.buffer);
    dv.setFloat32(0, 1.5, true);
    dv.setFloat32(4, -2.25, true);
    dv.setFloat32(8, 3.0, true);
    dv.setUint8(12, 200);
    dv.setUint8(13, 100);
    dv.setUint8(14, 50);
    dv.setUint8(15, 128);       // opacity
    dv.setUint16(16, 0, true);      // scale_0 -> min
    dv.setUint16(18, 65535, true);  // scale_1 -> max
    dv.setUint16(20, 65535, true);  // scale_2 -> max
    dv.setUint32(22, 0xC0000000, true); // rotation: d0=d1=d2=0, d3=3
    return buf;
};

const compressInfo = {
    envScaleMin: { x: 0.5, y: 0.5, z: 0.5 },
    envScaleMax: { x: 2.0, y: 2.0, z: 2.0 },
    envShMin: { x: -1, y: -1, z: -1 },
    envShMax: { x: 1, y: 1, z: 1 }
} as any;

describe('deserializeEnvironment', () => {
    it('decodes a no-SH record with the correct columns and field offsets', () => {
        const table = deserializeEnvironment(buildNoShRecord(), compressInfo, false);

        expect(table.numRows).toBe(1);
        const names = table.columns.map(c => c.name);
        expect(names).toEqual([
            'x', 'y', 'z',
            'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
            'scale_0', 'scale_1', 'scale_2',
            'rot_0', 'rot_1', 'rot_2', 'rot_3'
        ]);

        const col = (n: string) => table.columns.find(c => c.name === n)!.data as Float32Array;

        // positions round-trip exactly (validates the 0/4/8 float32 offsets)
        expect(col('x')[0]).toBe(1.5);
        expect(col('y')[0]).toBe(-2.25);
        expect(col('z')[0]).toBe(3.0);

        // opacity: invSigmoid(128/255)
        expect(col('opacity')[0]).toBeCloseTo(-Math.log((1 - 128 / 255) / (128 / 255)), 6);
        // f_dc_0: invSH0ToColor(200/255) = (200/255 - 0.5) / kSH_C0
        expect(col('f_dc_0')[0]).toBeCloseTo((200 / 255 - 0.5) / 0.28209479177387814, 6);

        // scale_0 uint16=0 -> mix(min,max,0)=0.5 -> log(0.5); scale_1 uint16=65535 -> max=2 -> log(2)
        expect(col('scale_0')[0]).toBeCloseTo(Math.log(0.5), 6);
        expect(col('scale_1')[0]).toBeCloseTo(Math.log(2.0), 6);

        // rotation d3=3 branch: rot_0=qw, rot_1=qx, rot_2=qy, rot_3=qz with
        // qx=qy=qz = -1/sqrt(2), qw = sqrt(1 - min(1, 1.5)) = 0
        expect(col('rot_0')[0]).toBeCloseTo(0, 6);
        expect(col('rot_1')[0]).toBeCloseTo(-0.7071067811865475, 6);
        expect(col('rot_2')[0]).toBeCloseTo(-0.7071067811865475, 6);
        expect(col('rot_3')[0]).toBeCloseTo(-0.7071067811865475, 6);
    });

    it('adds 45 SH columns for a 96-byte SH record', () => {
        const table = deserializeEnvironment(new Uint8Array(96), compressInfo, true);
        expect(table.numRows).toBe(1);
        expect(table.columns.length).toBe(14 + 45);
        expect(table.columns.some(c => c.name === 'f_rest_44')).toBe(true);
    });

    it('throws on a non-integer record count', () => {
        expect(() => deserializeEnvironment(new Uint8Array(40), compressInfo, false)).toThrow('Invalid environment data size');
    });
});

describe('resolveLcc2EnvFile', () => {
    it('resolves the env chunk from the new-protocol meta (root.splatFiles + root.data.env.name)', () => {
        const meta = {
            root: {
                splatFiles: ['chunk0.sog', 'chunk1.sog', 'env.sog'],
                data: { env: { name: 2 } }
            }
        };
        expect(resolveLcc2EnvFile(meta)).toBe('env.sog');
    });

    it('normalizes the legacy protocol (root.files, /-prefixed, missing .sog)', () => {
        const meta = {
            root: {
                files: ['/chunk0', '/env'],
                data: { env: { name: 1 } }
            }
        };
        expect(resolveLcc2EnvFile(meta)).toBe('env.sog');
    });

    it('returns null when there is no environment', () => {
        expect(resolveLcc2EnvFile({ root: { splatFiles: ['a.sog'] } })).toBeNull();
        expect(resolveLcc2EnvFile({ root: { data: { env: { name: 5 } }, splatFiles: ['a.sog'] } })).toBeNull();
    });
});
