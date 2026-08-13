// Pure planning arithmetic and argv construction for the VP9 size-targeted
// encode. No I/O and no process spawning live here so the numbers can be
// unit-tested on machines without ffmpeg — the same split as
// src/alignment-solve.ts.

export type Chunk = { startFrame: number; frames: number };
export type Plan = { kbps: number; seconds: number; chunks: Chunk[] };

export type PassArgs = {
    master: string;
    chunk: Chunk;
    frameRate: number;
    kbps: number;
    pass: 1 | 2;
    cpuUsed: number;
    logPrefix: string;
    out: string;            // ignored on pass 1
};

// Chunking exists only to cut wall clock. The floor is on chunk *length*, not
// count: each boundary costs a keyframe and an independent rate-control budget,
// which measured at the edge of noise at 10s and ~0.15 VMAF at 4s.
export const MIN_CHUNK_SECONDS = 10;

// libvpx produces garbage below this; a target small enough to reach it is
// already hopeless, but the encode should still complete.
export const MIN_KBPS = 32;

// Budget 3% under the target so container overhead and VBR drift stay inside it.
export const SIZE_SAFETY = 0.97;

// Pass 1 emits no bits — only the stats log pass 2's rate control reads — so it
// runs fast. Pass 2 is where quality is decided.
export const PASS1_CPU_USED = 4;
export const PASS2_CPU_USED = 1;

export const DENOISE = 'hqdn3d=1.5:1.5:6:6';

export const computePlan = (frames: number, frameRate: number, targetMB: number, cores: number): Plan => {
    const seconds = frames / frameRate;
    const kbps = Math.max(MIN_KBPS, Math.floor(targetMB * 8000 / seconds * SIZE_SAFETY));

    const wanted = Math.floor(seconds / MIN_CHUNK_SECONDS);
    const n = Math.min(Math.max(wanted, 1), Math.max(1, cores));

    const base = Math.floor(frames / n);
    const remainder = frames % n;

    const chunks: Chunk[] = [];
    for (let i = 0; i < n; i++) {
        chunks.push({
            // Leading chunks absorb the remainder one frame each, so the counts
            // sum to `frames` exactly and no seam duplicates or drops a frame.
            startFrame: i * base + Math.min(i, remainder),
            frames: base + (i < remainder ? 1 : 0)
        });
    }

    return { kbps, seconds, chunks };
};

// Size scales near-linearly with bitrate at fixed settings, so a proportional
// correction lands close. Floor rather than round so the retry biases under.
export const correctedKbps = (kbps: number, actualBytes: number, targetBytes: number): number => {
    return Math.max(MIN_KBPS, Math.floor(kbps * targetBytes / actualBytes));
};

export const buildPassArgs = (o: PassArgs): string[] => {
    const args = [
        '-y',
        // Input seek: fast. Frame-exactness comes from -frames:v below, not
        // from this. Duration-based chunking (-t) rounds at the seams.
        '-ss', (o.chunk.startFrame / o.frameRate).toFixed(6),
        '-i', o.master,
        '-c:v', 'libvpx-vp9',
        '-row-mt', '1',
        '-pix_fmt', 'yuv420p',
        '-cpu-used', String(o.cpuUsed),
        '-b:v', `${o.kbps}k`,
        '-vf', DENOISE,
        '-frames:v', String(o.chunk.frames),
        '-an',
        '-pass', String(o.pass),
        '-passlogfile', o.logPrefix,
        // Machine-readable `frame=N` lines on stdout. Parsing the human -stats
        // output on stderr would be locale- and version-fragile.
        '-progress', 'pipe:1',
        '-nostats'
    ];

    // The null muxer writes no bytes, so pass 1's stdout carries only progress.
    return o.pass === 1 ? [...args, '-f', 'null', '-'] : [...args, o.out];
};

export const buildConcatArgs = (listPath: string, outPath: string): string[] => {
    return ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath];
};
