import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeFfmpeg, run } from '../src/ffmpeg.js';
import { runVideoCompress } from '../src/video-compress.js';

const hasFfmpeg = await probeFfmpeg();

describe.skipIf(!hasFfmpeg)('runVideoCompress', () => {
    let dir: string;
    let master: string;

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'ssvc-test-'));
        master = join(dir, 'master.mp4');
        // 3 seconds of moving, noisy 640x360 content at 30fps = 90 frames.
        // Noise matters: a flat synthetic gradient compresses to almost
        // nothing and would pass a size assertion without exercising anything.
        await run([
            '-y', '-f', 'lavfi', '-i', 'mandelbrot=size=640x360:rate=30',
            '-vf', 'noise=alls=20:allf=t+u', '-frames:v', '90',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', master
        ]).promise;
    }, 120000);

    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    // runVideoCompress deletes dirname(masterPath) once it's done, so no two
    // calls can share the same input file or directory: every test needs its
    // own private copy of the master, in its own directory.
    const copyMaster = async (name: string): Promise<string> => {
        const uploadDir = join(dir, name);
        await mkdir(uploadDir);
        const copy = join(uploadDir, 'master.mp4');
        await writeFile(copy, await readFile(master));
        return copy;
    };

    it('produces a webm at or under the target size', async () => {
        const input = await copyMaster('upload1');
        const { promise } = runVideoCompress(
            input,
            { targetMB: 0.5, frameRate: 30, frames: 90 },
            () => {}
        );
        const files = await promise;

        expect(files).toHaveLength(1);
        expect(files[0].name).toBe('video.webm');
        expect(files[0].data.byteLength).toBeLessThanOrEqual(0.5 * 1e6);
        expect(files[0].data.byteLength).toBeGreaterThan(1000);
        // WebM/Matroska magic number
        expect(Array.from(files[0].data.slice(0, 4))).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    }, 300000);

    it('reports progress that ends at 1', async () => {
        const input = await copyMaster('upload2');
        const values: number[] = [];
        const { promise } = runVideoCompress(
            input,
            { targetMB: 0.5, frameRate: 30, frames: 90 },
            (e) => {
                if (e.kind === 'progress' && e.value !== undefined) values.push(e.value);
            }
        );
        await promise;

        expect(values.length).toBeGreaterThan(0);
        expect(Math.max(...values)).toBeLessThanOrEqual(100);
        expect(values.at(-1)).toBeCloseTo(100, 1);
    }, 300000);

    it('deletes the uploaded master directory when done', async () => {
        const copy = await copyMaster('upload3');

        const { promise } = runVideoCompress(
            copy,
            { targetMB: 0.5, frameRate: 30, frames: 90 },
            () => {}
        );
        await promise;

        await expect(stat(dirname(copy))).rejects.toThrow();
    }, 300000);

    it('honors cancel() in the window between finishing encode and concat', async () => {
        const input = await copyMaster('upload-cancel');
        let triggered = false;

        const { promise, cancel } = runVideoCompress(
            input,
            { targetMB: 0.5, frameRate: 30, frames: 90 },
            (e) => {
                // With a single chunk, progress hits exactly 100 right after
                // pass 2 finishes and before the concat step spawns. Cancel
                // landing in that exact window must still be honored, not
                // let a concat child through for a job that was told to stop.
                if (!triggered && e.kind === 'progress' && e.value === 100) {
                    triggered = true;
                    cancel();
                }
            }
        );

        await expect(promise).rejects.toThrow();
        expect(triggered).toBe(true);
        // Cleanup must still happen even though the job was cancelled rather
        // than completed.
        await expect(stat(dirname(input))).rejects.toThrow();
    }, 60000);

    it('rejects and cleans up when ffmpeg cannot open the input', async () => {
        // No real encode happens here (ffmpeg fails to open the input almost
        // instantly), so this is fast and deterministic without needing a
        // multi-minute clip. If computePlan produces more than one chunk on
        // this machine's core count, every chunk fails the same way; the
        // point of this test is that the job as a whole rejects cleanly and
        // cleans up rather than hanging or leaking its working directory.
        const uploadDir = join(dir, 'natural-fail');
        await mkdir(uploadDir);
        const missing = join(uploadDir, 'does-not-exist.mp4');

        const { promise } = runVideoCompress(
            missing,
            { targetMB: 0.5, frameRate: 30, frames: 600 },
            () => {}
        );

        await expect(promise).rejects.toThrow();
        await expect(stat(uploadDir)).rejects.toThrow();
    }, 20000);
});
