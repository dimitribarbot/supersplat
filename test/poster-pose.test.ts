import { describe, it, expect } from 'vitest';

import { firstWalkthroughPose } from '../src/poster-pose';

// Minimal ExperienceSettings-shaped fixtures. Only the fields the helper reads
// are populated; the helper must ignore everything else and never throw on
// missing optional data.
const withTrack = (overrides: any = {}) => ({
    startMode: 'animTrack',
    cameras: [{ initial: { position: [9, 9, 9], target: [8, 8, 8], fov: 42 } }],
    animTracks: [{
        name: 'cameraAnim',
        keyframes: {
            times: [0, 30, 60],
            values: {
                position: [1, 2, 3, 10, 11, 12, 20, 21, 22],
                target: [4, 5, 6, 13, 14, 15, 23, 24, 25],
                fov: [50, 55, 60]
            }
        }
    }],
    ...overrides
} as any);

describe('firstWalkthroughPose', () => {
    it('returns the first keyframe pose when a walkthrough is included', () => {
        expect(firstWalkthroughPose(withTrack())).toEqual({
            position: [1, 2, 3],
            target: [4, 5, 6],
            fov: 50
        });
    });

    it('returns null when startMode is not animTrack', () => {
        expect(firstWalkthroughPose(withTrack({ startMode: 'default' }))).toBeNull();
    });

    it('returns null when there are no anim tracks', () => {
        expect(firstWalkthroughPose(withTrack({ animTracks: [] }))).toBeNull();
    });

    it('returns null when keyframe times are empty', () => {
        const es = withTrack();
        es.animTracks[0].keyframes.times = [];
        expect(firstWalkthroughPose(es)).toBeNull();
    });

    it('returns null when the position values are too short', () => {
        const es = withTrack();
        es.animTracks[0].keyframes.values.position = [1, 2];
        expect(firstWalkthroughPose(es)).toBeNull();
    });

    it('falls back to the start-pose fov when the keyframe fov array is missing', () => {
        const es = withTrack();
        delete es.animTracks[0].keyframes.values.fov;
        expect(firstWalkthroughPose(es)).toEqual({
            position: [1, 2, 3],
            target: [4, 5, 6],
            fov: 42
        });
    });

    it('falls back to 60 when neither keyframe fov nor start-pose fov exist', () => {
        const es = withTrack({ cameras: [] });
        delete es.animTracks[0].keyframes.values.fov;
        expect(firstWalkthroughPose(es)?.fov).toBe(60);
    });
});
