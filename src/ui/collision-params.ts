import { Container, Label, SelectInput, SliderInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { i18n } from './localization';
import { buildPortalBundle } from '../portal-export';

type SceneCollision = { environment: 'indoor' | 'outdoor'; radius: number; voxelSize: number };

const defaults = (): SceneCollision => ({ environment: 'indoor', radius: 50, voxelSize: 0.05 });

// Per-scene collision controls for a portal export, shared by the export popup
// and the S3 publish dialog (which do not otherwise share collision UI).
//
// Values are keyed by scene UID so a choice survives a rebuild (the Streaming
// and Collision toggles both rebuild the rows); the index -> uid map is what
// assembly uses, because the exported arrays are index-aligned with
// portalEnvironments.
class PerSceneCollisionPanel extends Container {
    rebuild: (streaming: boolean) => void;
    valuesAt: (index: number) => SceneCollision;
    sceneCount: () => number;
    reset: () => void;

    constructor(events: Events) {
        super({ class: 'per-scene-collision', flex: true, flexDirection: 'column' });

        const values = new Map<number, SceneCollision>();   // uid -> values
        const order: number[] = [];                          // index -> uid

        const card = (uid: number, index: number, name: string) => {
            const v = values.get(uid) ?? defaults();
            values.set(uid, v);

            const wrap = new Container({ class: 'scene-card', flex: true, flexDirection: 'column' });

            const head = new Container({ class: 'scene-head' });
            const caret = new Label({ class: 'caret', text: '▸' });
            const title = new Label({ class: 'scene-name', text: name });
            title.dom.title = name;                          // tooltip fallback when ellipsised
            const summary = new Label({ class: 'scene-summary' });
            head.append(caret);
            head.append(title);
            head.append(summary);

            const body = new Container({ class: 'scene-body', flex: true, flexDirection: 'column', hidden: true });

            const envSelect = new SelectInput({
                class: 'select',
                defaultValue: v.environment,
                options: [
                    { v: 'indoor', t: i18n.t('popup.export.environment.indoor') },
                    { v: 'outdoor', t: i18n.t('popup.export.environment.outdoor') }
                ]
            });
            const radiusSlider = new SliderInput({ class: 'slider', min: 5, max: 500, precision: 0, value: v.radius });
            const voxelSlider = new SliderInput({ class: 'slider', min: 0.02, max: 0.5, precision: 2, value: v.voxelSize });

            const row = (labelKey: string, widget: any) => {
                const c = new Container({ class: 'row' });
                c.append(new Label({ class: 'label', text: i18n.t(labelKey) }));
                c.append(widget);
                return c;
            };
            body.append(row('popup.export.environment', envSelect));
            body.append(row('popup.export.collision-radius', radiusSlider));
            body.append(row('popup.export.voxel-size', voxelSlider));

            const refreshSummary = () => {
                const envText = i18n.t(v.environment === 'indoor' ? 'popup.export.environment.indoor' : 'popup.export.environment.outdoor');
                summary.text = `${envText} · ${v.radius} · ${v.voxelSize}`;
            };
            refreshSummary();

            envSelect.on('change', () => {
                v.environment = envSelect.value as 'indoor' | 'outdoor';
                refreshSummary();
            });
            radiusSlider.on('change', () => {
                v.radius = radiusSlider.value;
                refreshSummary();
            });
            voxelSlider.on('change', () => {
                v.voxelSize = voxelSlider.value;
                refreshSummary();
            });

            head.dom.addEventListener('click', () => {
                body.hidden = !body.hidden;
                caret.text = body.hidden ? '▸' : '▾';
            });

            wrap.append(head);
            wrap.append(body);
            return wrap;
        };

        this.rebuild = (streaming: boolean) => {
            this.clear();
            order.length = 0;

            const portalsRaw = events.invoke('portals.export') ?? [];
            const startUid = events.invoke('portals.startSplat') ?? null;
            const allSplats = events.invoke('scene.allSplats') ?? [];
            const availableUids = allSplats.map((s: any) => s.uid);
            const preferredStartUid = events.invoke('selection')?.uid ?? null;
            const bundle = (events.invoke('portals.count') ?? 0) > 0 ?
                buildPortalBundle({ portals: portalsRaw, startUid, availableUids, streaming, collision: true, preferredStartUid }) :
                null;
            if (!bundle) {
                this.hidden = true;
                return;
            }
            this.hidden = false;
            bundle.sceneUids.forEach((uid, index) => {
                const splat = allSplats.find((s: any) => s.uid === uid);
                const name = splat ? `${uid}: ${(splat.name ?? splat.asset?.file?.filename ?? uid)}` : `Scene ${index}`;
                order.push(uid);
                this.append(card(uid, index, name));
            });
        };

        this.valuesAt = (index: number) => {
            const uid = order[index];
            return (uid !== undefined && values.get(uid)) || defaults();
        };

        this.sceneCount = () => order.length;

        this.reset = () => {
            values.clear();
            order.length = 0;
            this.clear();
        };
    }
}

export { PerSceneCollisionPanel, type SceneCollision };
