import { BooleanInput, Button, ColorPicker, Container, Label, SelectInput, SliderInput, TextInput } from '@playcanvas/pcui';

import { collectAnnotationImages } from '../annotation-images';
import { Pose } from '../camera-poses';
import { PerSceneCollisionPanel } from './collision-params';
import { i18n } from './localization';
import { Events } from '../events';
import { buildPortalBundle } from '../portal-export';
import { AnimTrack, ExperienceSettings, defaultPostEffectSettings } from '../splat-serialize';

// Strip a known splat/scene file extension so the name can serve as the
// destination folder. Mirrors export-popup's removeKnownExtension; kept local
// to avoid coupling the two dialog modules.
const removeKnownExtension = (filename: string) => {
    const exts = ['.compressed.ply', '.ksplat', '.splat', '.html', '.ply', '.sog', '.spz', '.lcc', '.zip'];
    for (const ext of exts) {
        if (filename.endsWith(ext)) return filename.slice(0, -ext.length);
    }
    return filename;
};

export type S3PublishOptions = {
    subfolder: string;
    name: string;
    public: boolean;
    serializeSettings: { maxSHBands: number };
    viewerExportSettings: {
        type: 'zip';
        streaming: boolean;
        collision?: { environment: 'indoor' | 'outdoor'; radius: number; voxelSize: number };
        experienceSettings: ExperienceSettings;
        annotationImages?: { path: string; data: Uint8Array }[];
    };
};

const row = (labelKey: string, widget: any) => {
    const c = new Container({ class: 'row' });
    c.append(new Label({ class: 'label', text: i18n.t(labelKey) }));
    c.append(widget);
    return { c, widget };
};

class S3PublishDialog extends Container {
    show: (splatNames: string[]) => Promise<null | S3PublishOptions>;
    hide: () => void;
    destroy: () => void;

    constructor(events: Events, args = {}) {
        super({ id: 's3-publish-dialog', hidden: true, tabIndex: -1, ...args });

        const dialog = new Container({ id: 'dialog' });
        const header = new Container({ id: 'header' });
        header.append(new Label({ id: 'header', text: i18n.t('popup.publish.s3.header') }));

        const content = new Container({ id: 'content' });

        const streaming = new BooleanInput({ class: 'boolean', type: 'toggle', value: true });
        const collision = new BooleanInput({ class: 'boolean', type: 'toggle', value: true });
        const environment = new SelectInput({ class: 'select',
            defaultValue: 'indoor',
            options: [
                { v: 'indoor', t: i18n.t('popup.export.environment.indoor') },
                { v: 'outdoor', t: i18n.t('popup.export.environment.outdoor') }
            ] });
        const radius = new SliderInput({ class: 'slider', min: 5, max: 500, precision: 0, value: 50 });
        const voxelSize = new SliderInput({ class: 'slider', min: 0.02, max: 0.5, precision: 2, value: 0.05 });
        const animation = new BooleanInput({ class: 'boolean', type: 'toggle', value: false });
        const loop = new SelectInput({ class: 'select',
            defaultValue: 'repeat',
            options: [
                { v: 'none', t: i18n.t('popup.export.loop-mode.none') },
                { v: 'repeat', t: i18n.t('popup.export.loop-mode.repeat') },
                { v: 'pingpong', t: i18n.t('popup.export.loop-mode.pingpong') }
            ] });
        const color = new ColorPicker({ class: 'color-picker', value: [1, 1, 1, 1] });
        const fov = new SliderInput({ class: 'slider', min: 10, max: 120, precision: 0, value: 60 });
        const bands = new SliderInput({ class: 'slider', min: 0, max: 3, precision: 0, value: 3 });
        const subfolder = new TextInput({ class: 'text-input' });
        const name = new TextInput({ class: 'text-input' });
        const isPublic = new BooleanInput({ class: 'boolean', type: 'toggle', value: false });

        const streamingRow = row('popup.export.streaming', streaming);
        const collisionRow = row('popup.export.collision', collision);
        const environmentRow = row('popup.export.environment', environment);
        const radiusRow = row('popup.export.collision-radius', radius);
        const voxelRow = row('popup.export.voxel-size', voxelSize);
        const animationRow = row('popup.export.animation', animation);
        const loopRow = row('popup.export.loop-mode', loop);
        const colorRow = row('popup.export.background-color', color);
        const fovRow = row('popup.export.fov', fov);
        const bandsRow = row('popup.export.sh-bands', bands);
        const subfolderRow = row('popup.publish.s3.subfolder', subfolder);
        const nameRow = row('popup.publish.s3.name', name);
        const publicRow = row('popup.publish.s3.public', isPublic);

        // per-scene collision params (portals only); one collapsible card per
        // portal-referenced scene, replacing the shared environment/radius/voxel rows.
        const perSceneCollision = new PerSceneCollisionPanel(events);

        [streamingRow, collisionRow, environmentRow].forEach(r => content.append(r.c));
        content.append(perSceneCollision);
        [radiusRow, voxelRow, animationRow, loopRow, colorRow, fovRow, bandsRow, subfolderRow, nameRow, publicRow]
        .forEach(r => content.append(r.c));

        const footer = new Container({ id: 'footer' });
        const cancelButton = new Button({ class: 'button', text: i18n.t('popup.cancel') });
        const publishButton = new Button({ class: 'button', text: i18n.t('popup.publish.ok') });
        footer.append(cancelButton);
        footer.append(publishButton);

        dialog.append(header);
        dialog.append(content);
        dialog.append(footer);
        this.append(dialog);

        let onCancel: () => void;
        let onPublish: () => void;
        cancelButton.on('click', () => onCancel());
        publishButton.on('click', () => onPublish());

        const updateCollisionVisibility = () => {
            const hide = !collision.value;
            perSceneCollision.rebuild(streaming.value);
            const hasCards = !perSceneCollision.hidden && perSceneCollision.sceneCount() > 0;
            // with portals, the shared rows are replaced by the per-scene cards
            environmentRow.c.hidden = hide || hasCards;
            radiusRow.c.hidden = hide || hasCards;
            voxelRow.c.hidden = hide || hasCards;
            perSceneCollision.hidden = perSceneCollision.hidden || hide;
        };
        collision.on('change', updateCollisionVisibility);
        streaming.on('change', updateCollisionVisibility);
        animation.on('change', (v: boolean) => {
            loop.enabled = v;
        });

        const keydown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onCancel();
            else if (e.key === 'Enter' && !e.shiftKey) onPublish();
            else e.stopPropagation();
        };

        this.show = (splatNames: string[]) => {
            const frames = events.invoke('timeline.frames');
            const frameRate = events.invoke('timeline.frameRate');
            const smoothness = events.invoke('timeline.smoothness');
            const orderedPoses = (events.invoke('camera.poses') as Pose[])
            .slice().filter(p => p.frame >= 0 && p.frame < frames).sort((a, b) => a.frame - b.frame);
            const hasPoses = orderedPoses.length > 0;

            // reset
            streaming.value = true;
            collision.value = true;
            environment.value = 'indoor';
            perSceneCollision.reset();
            radius.value = 50;
            voxelSize.value = 0.05;
            updateCollisionVisibility();
            animation.value = hasPoses;
            animation.enabled = hasPoses;
            loop.value = 'repeat';
            loop.enabled = hasPoses;
            const bgClr = events.invoke('bgClr');
            color.value = [bgClr.r, bgClr.g, bgClr.b];
            fov.value = events.invoke('camera.fov');
            bands.value = events.invoke('view.bands');
            subfolder.value = '';
            // the name becomes the destination folder, so strip any file extension
            name.value = removeKnownExtension(splatNames[0] ?? 'scene');
            isPublic.value = false;

            this.hidden = false;
            this.dom.addEventListener('keydown', keydown);
            this.dom.focus();

            const assemble = (): S3PublishOptions => {
                const pose = events.invoke('camera.getPose');
                const p = pose?.position;
                const t = pose?.target;
                const cameras = (p && t) ? [{ initial: { position: [p.x, p.y, p.z] as [number, number, number], target: [t.x, t.y, t.z] as [number, number, number], fov: fov.value } }] : [];
                const animTracks: AnimTrack[] = [];
                if (animation.value && hasPoses) {
                    const times: number[] = [];
                    const position: number[] = [];
                    const target: number[] = [];
                    const fovKeys: number[] = [];
                    for (const op of orderedPoses) {
                        times.push(op.frame);
                        position.push(op.position.x, op.position.y, op.position.z);
                        target.push(op.target.x, op.target.y, op.target.z);
                        fovKeys.push(op.fov ?? fov.value);
                    }
                    animTracks.push({ name: 'cameraAnim', duration: frames / frameRate, frameRate, loopMode: loop.value as 'none' | 'repeat' | 'pingpong', interpolation: 'spline', smoothness, keyframes: { times, values: { position, target, fov: fovKeys } } });
                }
                // portal multi-scene bundle (absent when the scene has no portals)
                const portalsRaw = events.invoke('portals.export') ?? [];
                const startUid = events.invoke('portals.startSplat') ?? null;
                const allSplats = events.invoke('scene.allSplats') ?? [];
                const availableUids = allSplats.map((s: any) => s.uid);
                const preferredStartUid = events.invoke('selection')?.uid ?? null;
                const bundle = (events.invoke('portals.count') ?? 0) > 0 ?
                    buildPortalBundle({ portals: portalsRaw, startUid, availableUids, streaming: streaming.value, collision: collision.value, preferredStartUid }) :
                    null;
                const experienceSettings: ExperienceSettings = {
                    version: 2,
                    tonemapping: events.invoke('camera.tonemapping') ?? 'none',
                    highPrecisionRendering: false,
                    background: { color: color.value.slice(0, 3) as [number, number, number] },
                    postEffectSettings: defaultPostEffectSettings,
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
                        portalEnvironments: bundle.sceneUids.map((_, i) => perSceneCollision.valuesAt(i).environment),
                        portalRadii: bundle.sceneUids.map((_, i) => perSceneCollision.valuesAt(i).radius),
                        portalVoxelSizes: bundle.sceneUids.map((_, i) => perSceneCollision.valuesAt(i).voxelSize)
                    } : {}),
                    startMode: animation.value ? 'animTrack' : 'default'
                };
                return {
                    subfolder: subfolder.value.trim(),
                    name: name.value.trim(),
                    public: isPublic.value,
                    serializeSettings: { maxSHBands: bands.value },
                    viewerExportSettings: {
                        type: 'zip',
                        streaming: streaming.value,
                        // For a portal publish the start scene (index 0) is hidden from the
                        // global environment select and chosen via its per-scene card, so
                        // source its environment from there (portalEnvironments[0]); fall back
                        // to the global select for a non-portal publish.
                        collision: collision.value ? (bundle ? {
                            environment: perSceneCollision.valuesAt(0).environment,
                            radius: perSceneCollision.valuesAt(0).radius,
                            voxelSize: perSceneCollision.valuesAt(0).voxelSize
                        } : {
                            environment: environment.value as 'indoor' | 'outdoor',
                            radius: radius.value,
                            voxelSize: voxelSize.value
                        }) : undefined,
                        experienceSettings,
                        annotationImages: collectAnnotationImages(events)
                    }
                };
            };

            return new Promise<null | S3PublishOptions>((resolve) => {
                onCancel = () => resolve(null);
                onPublish = () => {
                    if (!name.value.trim()) return;   // name is required
                    resolve(assemble());
                };
            }).finally(() => {
                this.dom.removeEventListener('keydown', keydown);
                this.hide();
            });
        };

        this.hide = () => {
            this.hidden = true;
        };

        this.destroy = () => {
            this.hide();
            super.destroy();
        };
    }
}

export { S3PublishDialog };
