import { spawn } from 'node:child_process';

// The host binary, not an npm package. fluent-ffmpeg would spawn the same
// process; ffmpeg-static ships a binary but is a platform-specific package of
// the kind that has broken this repo's Windows lockfile; ffmpeg.wasm is 10-20x
// slower. FFMPEG_PATH overrides the location.
export const ffmpegPath = (): string => process.env.FFMPEG_PATH ?? 'ffmpeg';

// Spawn ffmpeg with an argv array. Never `shell: true` — paths reach the child
// as discrete tokens, so nothing in a filename can be interpreted as syntax.
export const run = (args: string[], onStdout?: (chunk: string) => void) => {
    const child = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
        // Keep only the tail: a failing encode's stderr is mostly banner noise
        // and the useful error is at the end.
        stderr = (stderr + d.toString()).slice(-4000);
    });
    if (onStdout) {
        child.stdout.on('data', (d: Buffer) => onStdout(d.toString()));
    } else {
        child.stdout.resume();
    }

    const promise = new Promise<void>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
        });
    });

    return { promise, cancel: () => child.kill() };
};

// A bare `-version` check would pass on an ffmpeg built without libvpx and then
// fail every job, so ask for the encoder list and look for the encoder we use.
export const probeFfmpeg = async (): Promise<boolean> => {
    try {
        let out = '';
        const { promise } = run(['-hide_banner', '-encoders'], (chunk) => {
            out += chunk;
        });
        await promise;
        return /\blibvpx-vp9\b/.test(out);
    } catch {
        return false;
    }
};
