import { Container, Element, Label } from '@playcanvas/pcui';

import { Events } from '../events';
import { i18n } from './localization';
import { SplatList } from './splat-list';
import sceneImportSvg from './svg/import.svg';
import sceneNewSvg from './svg/new.svg';
import portalSvg from './svg/portal-small.svg';
import soloSvg from './svg/solo.svg';
import { Tooltips } from './tooltips';
import { Transform } from './transform';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

class ScenePanel extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'scene-panel',
            class: 'panel'
        };

        super(args);

        // stop pointer events bubbling
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        const sceneHeader = new Container({
            class: 'panel-header'
        });

        const sceneIcon = new Label({
            text: '\uE344',
            class: 'panel-header-icon'
        });

        const sceneLabel = new Label({
            class: 'panel-header-label'
        });
        i18n.bindText(sceneLabel, 'panel.scene');

        let soloActive = false;

        const soloToggle = new Container({
            class: 'panel-header-button'
        });
        soloToggle.dom.appendChild(createSvg(soloSvg));

        let walkthroughActive = false;

        const walkthroughToggle = new Container({
            class: 'panel-header-button'
        });
        walkthroughToggle.dom.appendChild(createSvg(portalSvg));

        const setSolo = (on: boolean) => {
            if (on === soloActive) {
                return;
            }
            soloActive = on;
            soloToggle.class[soloActive ? 'add' : 'remove']('active');
            if (soloActive && walkthroughActive) {
                walkthroughActive = false;
                walkthroughToggle.class.remove('active');
                events.fire('portals.walkthrough', false);
            }
            events.fire('scene.solo', soloActive);
        };

        const setWalkthrough = (on: boolean) => {
            if (on === walkthroughActive) {
                return;
            }
            // guarded on the way IN only: with no portals there is nothing to
            // walk through, but a walkthrough already running must always be
            // switchable off — including by the video render's restore, which
            // would otherwise leave the toggle stuck on
            if (on && (events.invoke('portals.count') as number) === 0) {
                return;
            }
            walkthroughActive = on;
            walkthroughToggle.class[walkthroughActive ? 'add' : 'remove']('active');
            if (walkthroughActive && soloActive) {
                soloActive = false;
                soloToggle.class.remove('active');
                events.fire('scene.solo', false);
            }
            events.fire('portals.walkthrough', walkthroughActive);
        };

        soloToggle.on('click', () => setSolo(!soloActive));
        walkthroughToggle.on('click', () => setWalkthrough(!walkthroughActive));

        // Programmatic control of the two toggles. A video render forces
        // walkthrough on so the animated camera swaps scenes at portals instead
        // of rendering every scene superimposed, then puts both toggles back as
        // it found them (src/render-walkthrough.ts). Routed through the same
        // setters so the buttons keep reflecting the real state.
        events.on('scene.solo.set', setSolo);
        events.on('portals.walkthrough.set', setWalkthrough);
        events.function('scene.solo.active', () => soloActive);
        events.function('portals.walkthrough.active', () => walkthroughActive);

        const refreshWalkthroughEnabled = () => {
            const count = events.invoke('portals.count') as number;
            walkthroughToggle.class[count > 0 ? 'remove' : 'add']('disabled');
        };

        events.on('portals.changed', refreshWalkthroughEnabled);
        refreshWalkthroughEnabled();

        events.on('scene.clear', () => {
            walkthroughActive = false;
            walkthroughToggle.class.remove('active');
            refreshWalkthroughEnabled();
        });

        const sceneImport = new Container({
            class: 'panel-header-button'
        });
        sceneImport.dom.appendChild(createSvg(sceneImportSvg));

        const sceneNew = new Container({
            class: 'panel-header-button'
        });
        sceneNew.dom.appendChild(createSvg(sceneNewSvg));

        sceneHeader.append(sceneIcon);
        sceneHeader.append(sceneLabel);
        sceneHeader.append(soloToggle);
        sceneHeader.append(walkthroughToggle);
        sceneHeader.append(sceneImport);
        sceneHeader.append(sceneNew);

        sceneImport.on('click', async () => {
            await events.invoke('scene.import');
        });

        sceneNew.on('click', () => {
            events.invoke('doc.new');
        });

        tooltips.register(soloToggle, () => i18n.t('tooltip.scene.solo'), 'top');
        tooltips.register(walkthroughToggle, () => i18n.t('tooltip.scene.walkthrough'), 'top');
        tooltips.register(sceneImport, () => i18n.t('tooltip.scene.import'), 'top');
        tooltips.register(sceneNew, () => i18n.t('tooltip.scene.new'), 'top');

        const splatList = new SplatList(events);

        const splatListContainer = new Container({
            class: 'splat-list-container'
        });
        splatListContainer.append(splatList);

        const transformHeader = new Container({
            class: 'panel-header'
        });

        const transformIcon = new Label({
            text: '\uE111',
            class: 'panel-header-icon'
        });

        const transformLabel = new Label({
            class: 'panel-header-label'
        });
        i18n.bindText(transformLabel, 'panel.scene.transform');

        transformHeader.append(transformIcon);
        transformHeader.append(transformLabel);

        this.append(sceneHeader);
        this.append(splatListContainer);
        this.append(transformHeader);
        this.append(new Transform(events));
        this.append(new Element({
            class: 'panel-header',
            height: 20
        }));
    }
}

export { ScenePanel };
