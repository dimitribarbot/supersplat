import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { run } from './ffmpeg.js';
import type { ProgressEvent } from './progress.js';
import {
    buildConcatArgs,
    buildPassArgs,
    computePlan,
    correctedKbps,
    PASS1_CPU_USED,
    PASS2_CPU_USED,
    type Plan
} from './video-compress-plan.js';

export type VideoCompressOptions = {
    targetMB: number;
    frameRate: number;
    frames: number;
};

// `-progress pipe:1` emits `key=value` lines; we only need the frame counter.
const parseFrame = (chunk: string): number | null => {
    let last: number | null = null;
    for (const line of chunk.split('\n')) {
        const m = /^frame=(\d+)/.exec(line.trim());
        if (m) last = Number(m[1]);
    }
    return last;
};

export const runVideoCompress = (
    masterPath: string,
    opts: VideoCompressOptions,
    onProgress: (e: ProgressEvent) => void
) => {
    let cancelled = false;
    const children: (() => void)[] = [];

    const cancel = () => {
        cancelled = true;
        for (const kill of children) kill();
    };

    const exec = (args: string[], onFrame?: (n: number) => void) => {
        const child = run(args, onFrame && ((chunk) => {
            const n = parseFrame(chunk);
            if (n !== null) onFrame(n);
        }));
        children.push(child.cancel);
        return child.promise;
    };

    const encode = async (dir: string, plan: Plan, kbps: number): Promise<string> => {
        // Two passes over every chunk, so total work is 2 * frames. Each chunk
        // reports its own frame counter; sum them for a single 0..1 value.
        const done = new Array(plan.chunks.length * 2).fill(0);
        const totalWork = opts.frames * 2;
        const report = () => {
            const sum = done.reduce((a, b) => a + b, 0);
            onProgress({
                kind: 'progress',
                message: 'Compressing video',
                value: 100 * Math.min(1, sum / totalWork),
                // `loc` is the structured form the editor localizes; `message`
                // is the English fallback and the server log line. Same
                // contract the shared export core already uses.
                loc: { segments: [{ key: 'panel.render.compressing' }] }
            });
        };

        try {
            await Promise.all(plan.chunks.map(async (chunk, i) => {
                const logPrefix = join(dir, `p${i}`);
                const out = join(dir, `c${i}.webm`);
                const base = { master: masterPath, chunk, frameRate: opts.frameRate, kbps, logPrefix, out };

                await exec(
                    buildPassArgs({ ...base, pass: 1, cpuUsed: PASS1_CPU_USED }),
                    (n) => { done[i * 2] = n; report(); }
                );
                // Credit the full chunk once a pass resolves: pass 1 writes to the
                // null muxer, and on a fast enough encode ffmpeg's periodic
                // `-progress` emitter never gets a second tick before `progress=end`
                // fires with a stale `frame=0`, which would otherwise cap the
                // combined total at 50% forever.
                done[i * 2] = chunk.frames;
                report();
                if (cancelled) throw new Error('cancelled');
                await exec(
                    buildPassArgs({ ...base, pass: 2, cpuUsed: PASS2_CPU_USED }),
                    (n) => { done[i * 2 + 1] = n; report(); }
                );
                done[i * 2 + 1] = chunk.frames;
                report();
            }));
        } catch (err) {
            // One chunk rejecting (a real ffmpeg failure, not just a user
            // cancel) must not leave its siblings running: they'd keep
            // burning cores and writing into `dir` after control has already
            // unwound to the `finally` below that deletes it.
            cancel();
            throw err;
        }

        // Chunk filenames are server-generated (`c0.webm`, ...), so no quoting
        // or escaping is required in the concat list.
        const listPath = join(dir, 'list.txt');
        const outPath = join(dir, 'out.webm');
        await writeFile(listPath, plan.chunks.map((_, i) => `file 'c${i}.webm'`).join('\n'));
        // writeFile above yields the event loop, so a cancel() landing in that
        // window must still be caught here rather than spawning a concat
        // child for a job that was told to stop.
        if (cancelled) throw new Error('cancelled');
        await exec(buildConcatArgs(listPath, outPath));
        return outPath;
    };

    const promise = (async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ssvc-'));
        try {
            const cores = availableParallelism?.() ?? 4;
            const plan = computePlan(opts.frames, opts.frameRate, opts.targetMB, cores);
            const targetBytes = opts.targetMB * 1e6;

            let outPath = await encode(dir, plan, plan.kbps);
            let size = (await stat(outPath)).size;

            if (size > targetBytes && !cancelled) {
                // Two-pass VP9 usually lands under; this fires rarely. Say so
                // out loud rather than leaving the extra minute unexplained.
                const retryKbps = correctedKbps(plan.kbps, size, targetBytes);
                const actualMB = (size / 1e6).toFixed(2);
                onProgress({
                    kind: 'progress',
                    message: `Over target (${actualMB} MB) — re-encoding at ${retryKbps}k`,
                    value: 0,
                    loc: { segments: [{ key: 'panel.render.compress-retry', params: { size: actualMB, kbps: retryKbps } }] }
                });
                outPath = await encode(dir, plan, retryKbps);
                size = (await stat(outPath)).size;
            }

            return [{ name: 'video.webm', data: new Uint8Array(await readFile(outPath)) }];
        } finally {
            // Each removal gets its own error handling: `force: true` only
            // swallows ENOENT, not e.g. Windows EBUSY/EPERM from a lingering
            // handle, and a throw from the first `rm` must not skip the
            // second — the upload directory can be 150 MB+ and this server
            // runs one job at a time, so a leak here isn't reclaimed until
            // the next restart.
            await rm(dir, { recursive: true, force: true }).catch((err) => {
                console.warn('video-compress: failed to remove working dir:', err);
            });
            // The uploaded master is this job's responsibility once handed over:
            // remove the whole upload directory, not just the file inside it.
            await rm(dirname(masterPath), { recursive: true, force: true }).catch((err) => {
                console.warn('video-compress: failed to remove upload dir:', err);
            });
        }
    })();

    return { promise, cancel };
};
