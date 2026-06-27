import { CubicSpline } from './anim/spline';
import { PortalRect, Vec3, resolveActiveSplat, segmentCrossesRect } from './portal-geom';

// Subset of the serialized AnimTrack (see export-popup.ts assembleViewerOptions)
// that this module needs to reproduce the viewer's camera path.
type PortalAnimTrack = {
    duration: number;
    frameRate: number;
    smoothness?: number;
    keyframes: {
        times: number[];
        values: { position: number[]; target: number[]; fov: number[] };
    };
};

// A change-point in the active scene over the animation timeline. `t` is the
// cursor time in seconds (matching the viewer's state.animationTime); `scene`
// is the scene index active from this `t` until the next entry.
type PortalTimelineEntry = { t: number; scene: number };

// Reproduce the viewer's AnimState.fromTrack spline (index.mjs): interleave
// position/target/fov per keyframe, then build a looping cubic spline over
// (duration + extra) * frameRate frames.
const buildSpline = (track: PortalAnimTrack): CubicSpline => {
    const { duration, frameRate } = track;
    const { times, values } = track.keyframes;
    const { position, target, fov } = values;
    const smoothness = track.smoothness ?? 1;

    const points: number[] = [];
    for (let i = 0; i < times.length; ++i) {
        points.push(position[i * 3], position[i * 3 + 1], position[i * 3 + 2]);
        points.push(target[i * 3], target[i * 3 + 1], target[i * 3 + 2]);
        points.push(fov[i]);
    }

    const extra = (duration === times[times.length - 1] / frameRate) ? 1 : 0;
    return CubicSpline.fromPointsLooping((duration + extra) * frameRate, times, points, smoothness);
};

// Build the time->scene timeline by sampling the camera path and replaying the
// portal crossings (using the same geometry as the runtime companion). Returns
// a compact list of change-points; always begins with { t: 0, scene: startIndex }.
const buildPortalAnimTimeline = (
    track: PortalAnimTrack | null | undefined,
    portals: PortalRect[],
    startIndex: number,
    sampleMult = 2
): PortalTimelineEntry[] => {
    const timeline: PortalTimelineEntry[] = [{ t: 0, scene: startIndex }];

    const times = track?.keyframes?.times;
    if (!track || !times || times.length < 2 || !(track.duration > 0) || portals.length === 0) {
        return timeline;
    }

    const spline = buildSpline(track);
    const { duration, frameRate } = track;

    // Sample finely across [0, duration] so a quick in-and-out crossing is not
    // missed. Sub-frame resolution (sampleMult per frame) keeps boundaries tight.
    const numSamples = Math.max(2, Math.ceil(duration * frameRate * sampleMult) + 1);
    const result: number[] = [];

    const evalPos = (v: number): Vec3 => {
        spline.evaluate(v * frameRate, result);
        return [result[0], result[1], result[2]];
    };

    let active = startIndex;
    let prev = evalPos(0);
    for (let k = 1; k < numSamples; ++k) {
        const v = (k / (numSamples - 1)) * duration;
        const cur = evalPos(v);
        const next = resolveActiveSplat(prev, cur, portals, active, segmentCrossesRect);
        if (next !== null && next !== active) {
            active = next;
            timeline.push({ t: v, scene: active });
        }
        prev = cur;
    }

    return timeline;
};

export { buildPortalAnimTimeline, PortalAnimTrack, PortalTimelineEntry };
