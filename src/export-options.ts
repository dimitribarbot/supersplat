import { collectAnnotationImages } from './annotation-images';
import type { Pose } from './camera-poses';
import { Events } from './events';
import type { WriteTarget } from './io';
import { buildPortalBundle } from './portal-export';
import { AnimTrack, defaultPostEffectSettings, ExperienceSettings, SerializeSettings, ViewerExportSettings } from './splat-serialize';

type ExportType = 'ply' | 'splat' | 'sog' | 'spz' | 'viewer' | 'viewerSettings';

// per-scene collision parameters, index-aligned with the exported scene bundle
// (index 0 is the start scene). Declared here rather than in ui/collision-params
// so nothing outside the UI has to import a PCUI module.
type SceneCollision = { environment: 'indoor' | 'outdoor'; radius: number; voxelSize: number };

// The export dialog's choices. Everything else in SceneExportOptions is read
// from the scene when the export runs, so repeating an export with the same
// choices picks up the current camera pose and animation.
interface ExportChoices {
    filename: string;
    maxSHBands?: number;

    // ply
    compressedPly?: boolean;

    // sog
    sogIterations?: number;

    // spz
    spzVersion?: 3 | 4;

    // viewer
    viewerType?: 'html' | 'zip';
    includeAnimation?: boolean;
    loopMode?: 'none' | 'repeat' | 'pingpong';
    backgroundColor?: [number, number, number];
    fov?: number;

    // viewer, fork: stream the splat data instead of baking it in
    streaming?: boolean;

    // viewer, fork: bake a voxel collision volume (ZIP exports only)
    collision?: boolean;

    // viewer, fork: per-scene collision parameters for a portal export, in the
    // portal bundle's scene order. Ignored when the scene has no portals.
    perSceneCollision?: SceneCollision[];

    // viewer, fork: collision parameters for a non-portal export
    globalCollision?: SceneCollision;

    // fork: route the export through the export server when one is available
    useServer?: boolean;
}

// what the export dialog resolves: its choices plus, when a folder was chosen,
// the folder and the file to write
type ExportDialogResult = ExportChoices & {
    directory?: FileSystemDirectoryHandle;
    fileTarget?: WriteTarget;
};

interface SceneExportOptions {
    filename: string;
    fileTarget?: WriteTarget;
    splatIdx: 'all' | number;
    serializeSettings: SerializeSettings;

    // ply
    compressedPly?: boolean;

    // sog
    sogIterations?: number;

    // spz
    spzVersion?: 3 | 4;

    // viewer
    viewerExportSettings?: ViewerExportSettings;

    // fork: route export through the server when available (see export-server-client)
    useServer?: boolean;
}

const buildViewerSettings = (events: Events, choices: ExportChoices): ViewerExportSettings => {
    const fov = choices.fov;

    // use current viewport as start pose
    const pose = events.invoke('camera.getPose');
    const p = pose?.position;
    const t = pose?.target;
    const cameras = (p && t) ? [{
        initial: {
            position: [p.x, p.y, p.z] as [number, number, number],
            target: [t.x, t.y, t.z] as [number, number, number],
            fov
        }
    }] : [];

    const animTracks: AnimTrack[] = [];

    if (choices.includeAnimation) {
        const frames = events.invoke('timeline.frames');
        const frameRate = events.invoke('timeline.frameRate');
        const smoothness = events.invoke('timeline.smoothness');
        const orderedPoses = (events.invoke('camera.poses') as Pose[])
        .filter(entry => entry.frame >= 0 && entry.frame < frames)
        .sort((a, b) => a.frame - b.frame);

        if (orderedPoses.length > 0) {
            const times: number[] = [];
            const position: number[] = [];
            const target: number[] = [];
            const fovKeys: number[] = [];
            for (let i = 0; i < orderedPoses.length; ++i) {
                const op = orderedPoses[i];
                times.push(op.frame);
                position.push(op.position.x, op.position.y, op.position.z);
                target.push(op.target.x, op.target.y, op.target.z);
                fovKeys.push(op.fov ?? fov);
            }

            animTracks.push({
                name: 'cameraAnim',
                duration: frames / frameRate,
                frameRate,
                loopMode: choices.loopMode,
                interpolation: 'spline',
                smoothness,
                keyframes: {
                    times,
                    values: { position, target, fov: fovKeys }
                }
            });
        }
    }

    // fork: collision is a ZIP-only feature, and the portal bundle has to know
    // whether it was asked for so it can emit per-scene collision urls
    const collisionOn = choices.viewerType === 'zip' && !!choices.collision;

    // fork: portal multi-scene bundle (absent when the scene has no portals)
    const portalsRaw = events.invoke('portals.export') ?? [];
    const startUid = events.invoke('portals.startSplat') ?? null;
    const allSplats = events.invoke('scene.allSplats') ?? [];
    const availableUids = allSplats.map((s: any) => s.uid);
    const preferredStartUid = events.invoke('selection')?.uid ?? null;
    const bundle = (events.invoke('portals.count') ?? 0) > 0 ?
        buildPortalBundle({ portals: portalsRaw, startUid, availableUids, streaming: choices.streaming, collision: collisionOn, preferredStartUid }) :
        null;

    // fork: per-scene collision values chosen in the dialog, index-aligned with
    // the bundle. Fall back to the start scene's values for any scene the
    // choices do not cover (a portal added after the dialog collected them).
    const perScene = choices.perSceneCollision ?? [];
    const fallbackCollision: SceneCollision = { environment: 'indoor', radius: 50, voxelSize: 0.05 };
    const collisionAt = (index: number): SceneCollision => perScene[index] ?? perScene[0] ?? choices.globalCollision ?? fallbackCollision;

    const experienceSettings: ExperienceSettings = {
        version: 2,
        tonemapping: events.invoke('camera.tonemapping') ?? 'none',
        highPrecisionRendering: false,
        background: { color: choices.backgroundColor },
        postEffectSettings: defaultPostEffectSettings(),
        animTracks,
        cameras,
        annotations: events.invoke('annotations.export', bundle?.sceneUids) ?? [],
        offLimitsZones: events.invoke('offLimitsZones.export') ?? [],
        offLimitsMessage: events.invoke('offLimitsZones.message') ?? '',
        ...(bundle ? {
            portals: bundle.portals,
            portalScenes: bundle.portalScenes,
            portalStart: bundle.portalStart,
            portalCollision: bundle.portalCollision,
            portalEnvironments: bundle.sceneUids.map((_, i) => collisionAt(i).environment),
            portalRadii: bundle.sceneUids.map((_, i) => collisionAt(i).radius),
            portalVoxelSizes: bundle.sceneUids.map((_, i) => collisionAt(i).voxelSize)
        } : {}),
        startMode: animTracks.length > 0 ? 'animTrack' : 'default'
    };

    return {
        type: choices.viewerType,
        streaming: choices.streaming,
        // For a portal export the start scene (index 0) is hidden from the
        // global environment select and chosen via its per-scene card, so
        // source its collision from there; fall back to the dialog's global
        // values for a non-portal export.
        collision: collisionOn ? (bundle ? collisionAt(0) : choices.globalCollision) : undefined,
        experienceSettings,
        // ZIP only: the single-file HTML export has nowhere to put them (the
        // export popup warns about this)
        annotationImages: choices.viewerType === 'zip' ? collectAnnotationImages(events) : undefined
    };
};

// turn the dialog's choices into export options against the current scene
const buildExportOptions = (events: Events, exportType: ExportType, choices: ExportChoices): SceneExportOptions => {
    const options: SceneExportOptions = {
        filename: choices.filename,
        splatIdx: 'all',
        serializeSettings: { maxSHBands: choices.maxSHBands },
        useServer: choices.useServer
    };

    switch (exportType) {
        case 'ply':
            options.compressedPly = choices.compressedPly;
            break;
        case 'sog':
            options.sogIterations = choices.sogIterations;
            break;
        case 'spz':
            options.spzVersion = choices.spzVersion;
            break;
        case 'viewer':
            options.viewerExportSettings = buildViewerSettings(events, choices);
            break;
        case 'viewerSettings':
            // fork: writes only the experience json, so the splat data is never
            // serialized and there is nothing for the server to do
            options.serializeSettings = {};
            options.viewerExportSettings = buildViewerSettings(events, choices);
            break;
    }

    return options;
};

export { buildExportOptions, ExportChoices, ExportDialogResult, ExportType, SceneCollision, SceneExportOptions };
