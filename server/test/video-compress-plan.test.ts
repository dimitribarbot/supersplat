import { describe, expect, it } from 'vitest';
import {
    buildConcatArgs,
    buildPassArgs,
    computePlan,
    correctedKbps,
    PASS1_CPU_USED,
    PASS2_CPU_USED
} from '../src/video-compress-plan.js';

// A 60s clip at 30fps as the editor counts it: render.ts:734 computes
// `floor(duration * frameRate) + 1`, so a 0..1800 frame range yields 1801.
const FRAMES_60S = 1801;

describe('computePlan', () => {
    it('splits a 60s clip into 6 chunks of ~10s', () => {
        const plan = computePlan(FRAMES_60S, 30, 6, 32);
        expect(plan.chunks).toHaveLength(6);
    });

    it('per-chunk frame counts sum exactly to the total', () => {
        // The script produced 1351 frames from a 1350-frame source until chunk
        // boundaries became frame-exact. A seam off by one duplicates a frame
        // and is invisible without this assertion.
        for (const frames of [1801, 1800, 1799, 907, 601]) {
            const plan = computePlan(frames, 30, 6, 32);
            const total = plan.chunks.reduce((sum, c) => sum + c.frames, 0);
            expect(total).toBe(frames);
        }
    });

    it('lays chunks end to end with no gap or overlap', () => {
        const plan = computePlan(FRAMES_60S, 30, 6, 32);
        let expected = 0;
        for (const chunk of plan.chunks) {
            expect(chunk.startFrame).toBe(expected);
            expected += chunk.frames;
        }
        expect(expected).toBe(FRAMES_60S);
    });

    it('spreads the remainder across the leading chunks', () => {
        const plan = computePlan(FRAMES_60S, 30, 6, 32);   // 1801 = 300*6 + 1
        expect(plan.chunks[0].frames).toBe(301);
        expect(plan.chunks[1].frames).toBe(300);
    });

    it('uses a single chunk below 20 seconds', () => {
        const plan = computePlan(30 * 19, 30, 6, 32);
        expect(plan.chunks).toHaveLength(1);
        expect(plan.chunks[0]).toEqual({ startFrame: 0, frames: 570 });
    });

    it('caps the chunk count at the core count', () => {
        const plan = computePlan(30 * 600, 30, 6, 4);      // 600s would want 60
        expect(plan.chunks).toHaveLength(4);
    });

    it('computes kbps from the target size with a 3% safety margin', () => {
        const plan = computePlan(FRAMES_60S, 30, 6, 32);
        const seconds = FRAMES_60S / 30;
        expect(plan.seconds).toBeCloseTo(seconds, 6);
        expect(plan.kbps).toBe(Math.floor(6 * 8000 / seconds * 0.97));
    });

    it('floors kbps at 32 for absurdly small targets', () => {
        const plan = computePlan(FRAMES_60S, 30, 0.05, 32);
        expect(plan.kbps).toBe(32);
    });
});

describe('correctedKbps', () => {
    it('shrinks proportionally when the output overshot', () => {
        expect(correctedKbps(1000, 1200, 1000)).toBe(833);
    });

    it('never returns below the floor', () => {
        expect(correctedKbps(100, 1e9, 1)).toBe(32);
    });
});

describe('buildPassArgs', () => {
    const chunk = { startFrame: 300, frames: 300 };
    const base = {
        master: '/tmp/x/master.mp4',
        chunk,
        frameRate: 30,
        kbps: 776,
        logPrefix: '/tmp/x/p1',
        out: '/tmp/x/c1.webm'
    };

    it('seeks by frame index converted to seconds', () => {
        const args = buildPassArgs({ ...base, pass: 1, cpuUsed: PASS1_CPU_USED });
        expect(args[args.indexOf('-ss') + 1]).toBe('10.000000');
    });

    it('limits by exact frame count, never by duration', () => {
        const args = buildPassArgs({ ...base, pass: 2, cpuUsed: PASS2_CPU_USED });
        expect(args[args.indexOf('-frames:v') + 1]).toBe('300');
        expect(args).not.toContain('-t');
    });

    it('carries the fixed encoder settings', () => {
        const args = buildPassArgs({ ...base, pass: 2, cpuUsed: PASS2_CPU_USED });
        expect(args[args.indexOf('-c:v') + 1]).toBe('libvpx-vp9');
        expect(args[args.indexOf('-row-mt') + 1]).toBe('1');
        expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p');
        expect(args[args.indexOf('-vf') + 1]).toBe('hqdn3d=1.5:1.5:6:6');
        expect(args[args.indexOf('-b:v') + 1]).toBe('776k');
        expect(args).toContain('-an');
    });

    it('discards output on pass 1 and writes the file on pass 2', () => {
        const p1 = buildPassArgs({ ...base, pass: 1, cpuUsed: PASS1_CPU_USED });
        expect(p1.slice(-3)).toEqual(['-f', 'null', '-']);
        expect(p1[p1.indexOf('-cpu-used') + 1]).toBe('4');
        expect(p1).not.toContain('/tmp/x/c1.webm');

        const p2 = buildPassArgs({ ...base, pass: 2, cpuUsed: PASS2_CPU_USED });
        expect(p2[p2.length - 1]).toBe('/tmp/x/c1.webm');
        expect(p2[p2.indexOf('-cpu-used') + 1]).toBe('1');
    });

    it('requests machine-readable progress', () => {
        const args = buildPassArgs({ ...base, pass: 2, cpuUsed: PASS2_CPU_USED });
        expect(args[args.indexOf('-progress') + 1]).toBe('pipe:1');
        expect(args).toContain('-nostats');
    });

    it('returns every argument as its own array element', () => {
        // A single concatenated string would reintroduce shell-injection risk
        // via the master path. Every element must be a discrete token.
        const args = buildPassArgs({ ...base, pass: 2, cpuUsed: PASS2_CPU_USED });
        expect(args.every(a => typeof a === 'string')).toBe(true);
        expect(args.some(a => a.includes(' -'))).toBe(false);
    });
});

describe('buildConcatArgs', () => {
    it('uses the concat demuxer with stream copy', () => {
        expect(buildConcatArgs('/tmp/x/list.txt', '/tmp/x/out.webm')).toEqual([
            '-y', '-f', 'concat', '-safe', '0',
            '-i', '/tmp/x/list.txt', '-c', 'copy', '/tmp/x/out.webm'
        ]);
    });
});
