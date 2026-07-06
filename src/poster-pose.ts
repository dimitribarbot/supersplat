import type { ExperienceSettings } from './splat-serialize';

// The camera pose the export-time poster is rendered from: the first frame of
// the exported walkthrough. Plain-number arrays (playcanvas-free) so this stays
// trivially unit-testable; the render side converts to Vec3.
type PosterPose = {
    position: [number, number, number];
    target: [number, number, number];
    fov: number;
};

// Extract the first-frame camera pose of an exported walkthrough from the
// already-built ExperienceSettings, or null when there is no walkthrough (the
// caller then keeps today's behavior: poster = current viewport).
//
// A walkthrough exists when startMode === 'animTrack' and the camera anim track
// (animTracks[0], the only one built — 'cameraAnim') has at least one keyframe.
// Keyframe values are flattened per-axis: position/target are [x,y,z, x,y,z,...]
// and the first frame is index 0..2; fov is one value per keyframe (index 0).
const firstWalkthroughPose = (experienceSettings: ExperienceSettings): PosterPose | null => {
    if (!experienceSettings || experienceSettings.startMode !== 'animTrack') {
        return null;
    }

    const track = experienceSettings.animTracks?.[0];
    const kf = track?.keyframes;
    const pos = kf?.values?.position;
    const tgt = kf?.values?.target;

    if (!kf?.times?.length || !pos || pos.length < 3 || !tgt || tgt.length < 3) {
        return null;
    }

    const fovKeys = kf.values?.fov;
    const fallbackFov = experienceSettings.cameras?.[0]?.initial?.fov ?? 60;
    const fov = (fovKeys && fovKeys.length > 0) ? fovKeys[0] : fallbackFov;

    return {
        position: [pos[0], pos[1], pos[2]],
        target: [tgt[0], tgt[1], tgt[2]],
        fov
    };
};

export { firstWalkthroughPose, PosterPose };
