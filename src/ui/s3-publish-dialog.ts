import { BooleanInput, Button, ColorPicker, Container, Label, SelectInput, SliderInput, TextInput } from '@playcanvas/pcui';

import { Pose } from '../camera-poses';
import { localize } from './localization';
import { Events } from '../events';
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
    };
};

const row = (labelKey: string, widget: any) => {
    const c = new Container({ class: 'row' });
    c.append(new Label({ class: 'label', text: localize(labelKey) }));
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
        header.append(new Label({ id: 'header', text: localize('popup.publish.s3.header') }));

        const content = new Container({ id: 'content' });

        const streaming = new BooleanInput({ class: 'boolean', type: 'toggle', value: true });
        const collision = new BooleanInput({ class: 'boolean', type: 'toggle', value: true });
        const environment = new SelectInput({ class: 'select',
            defaultValue: 'indoor',
            options: [
                { v: 'indoor', t: localize('popup.export.environment.indoor') },
                { v: 'outdoor', t: localize('popup.export.environment.outdoor') }
            ] });
        const radius = new SliderInput({ class: 'slider', min: 5, max: 500, precision: 0, value: 50 });
        const voxelSize = new SliderInput({ class: 'slider', min: 0.02, max: 0.5, precision: 2, value: 0.05 });
        const animation = new BooleanInput({ class: 'boolean', type: 'toggle', value: false });
        const loop = new SelectInput({ class: 'select',
            defaultValue: 'repeat',
            options: [
                { v: 'none', t: localize('popup.export.loop-mode.none') },
                { v: 'repeat', t: localize('popup.export.loop-mode.repeat') },
                { v: 'pingpong', t: localize('popup.export.loop-mode.pingpong') }
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

        [streamingRow, collisionRow, environmentRow, radiusRow, voxelRow, animationRow, loopRow, colorRow, fovRow, bandsRow, subfolderRow, nameRow, publicRow]
        .forEach(r => content.append(r.c));

        const footer = new Container({ id: 'footer' });
        const cancelButton = new Button({ class: 'button', text: localize('popup.cancel') });
        const publishButton = new Button({ class: 'button', text: localize('popup.publish.ok') });
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
            environmentRow.c.hidden = hide;
            radiusRow.c.hidden = hide;
            voxelRow.c.hidden = hide;
        };
        collision.on('change', updateCollisionVisibility);
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
                const experienceSettings: ExperienceSettings = {
                    version: 2,
                    tonemapping: events.invoke('camera.tonemapping') ?? 'none',
                    highPrecisionRendering: false,
                    background: { color: color.value.slice(0, 3) as [number, number, number] },
                    postEffectSettings: defaultPostEffectSettings,
                    animTracks,
                    cameras,
                    annotations: events.invoke('annotations.export') ?? [],
                    offLimitsZones: events.invoke('offLimitsZones.export') ?? [],
                    offLimitsMessage: events.invoke('offLimitsZones.message') ?? '',
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
                        collision: collision.value ? { environment: environment.value as 'indoor' | 'outdoor', radius: radius.value, voxelSize: voxelSize.value } : undefined,
                        experienceSettings
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
