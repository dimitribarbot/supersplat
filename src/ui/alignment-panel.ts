import { Button, Container, Label, SelectInput } from '@playcanvas/pcui';

import { AlignmentManager, AlignmentPair } from '../alignment';
import { ElementType } from '../element';
import { Events } from '../events';
import { Scene } from '../scene';
import { Splat } from '../splat';
import { localize } from './localization';
import alignSvg from './svg/align.svg';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

const fmt = (v: number) => (Number.isFinite(v) ? v.toFixed(4) : '-');
const fmtPoint = (point?: { position: { x: number, y: number, z: number } }) => {
    return point ? `${fmt(point.position.x)}, ${fmt(point.position.y)}, ${fmt(point.position.z)}` : '-';
};

class AlignmentPanel extends Container {
    constructor(events: Events, scene: Scene, manager: AlignmentManager, args = {}) {
        args = {
            ...args,
            id: 'alignment-panel',
            class: 'panel',
            hidden: true
        };

        super(args);

        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((name) => {
            this.dom.addEventListener(name, (e: Event) => e.stopPropagation());
        });

        const header = new Container({ class: 'panel-header' });
        const headerIcon = new Container({ class: 'panel-header-icon' });
        headerIcon.dom.appendChild(createSvg(alignSvg));
        const headerLabel = new Label({
            text: localize('panel.alignment'),
            class: 'panel-header-label'
        });
        header.append(headerIcon);
        header.append(headerLabel);
        this.append(header);

        const controls = new Container({ class: 'alignment-controls' });
        const sourceSelect = new SelectInput({ class: 'alignment-select', type: 'number', allowNull: true });
        const targetSelect = new SelectInput({ class: 'alignment-select', type: 'number', allowNull: true });
        const modeSelect = new SelectInput({
            class: 'alignment-select',
            options: [
                { v: 'rigid', t: localize('alignment.mode.rigid') },
                { v: 'similarity', t: localize('alignment.mode.similarity') }
            ],
            value: 'rigid'
        });

        const sourceRow = new Container({ class: 'alignment-control-row' });
        sourceRow.append(new Label({ text: localize('alignment.source'), class: 'alignment-control-label' }));
        sourceRow.append(sourceSelect);
        controls.append(sourceRow);

        const targetRow = new Container({ class: 'alignment-control-row' });
        targetRow.append(new Label({ text: localize('alignment.target'), class: 'alignment-control-label' }));
        targetRow.append(targetSelect);
        controls.append(targetRow);

        const modeRow = new Container({ class: 'alignment-control-row' });
        modeRow.append(new Label({ text: localize('alignment.mode'), class: 'alignment-control-label' }));
        modeRow.append(modeSelect);
        controls.append(modeRow);

        this.append(controls);

        const pickRow = new Container({ class: 'alignment-button-row' });
        const pickSourceBtn = new Button({ text: localize('alignment.pick-source'), class: 'alignment-button' });
        const pickTargetBtn = new Button({ text: localize('alignment.pick-target'), class: 'alignment-button' });
        const swapBtn = new Button({ text: localize('alignment.swap'), class: 'alignment-button' });
        const clearBtn = new Button({ text: localize('alignment.clear'), class: 'alignment-button' });
        pickRow.append(pickSourceBtn);
        pickRow.append(pickTargetBtn);
        pickRow.append(swapBtn);
        pickRow.append(clearBtn);
        this.append(pickRow);

        const tableOuter = new Container({ id: 'alignment-pair-list-outer' });
        const table = document.createElement('table');
        table.id = 'alignment-pair-list';
        const th = (text: string) => `<th>${text}</th>`;
        table.innerHTML = `<thead><tr>${th('#')}${th(localize('alignment.source'))}${th(localize('alignment.target'))}${th(localize('alignment.error'))}<th></th></tr></thead>`;
        const tbody = document.createElement('tbody');
        table.appendChild(tbody);
        tableOuter.dom.appendChild(table);
        this.append(tableOuter);

        const resultRow = new Container({ class: 'alignment-result-row' });
        const pairCount = new Label({ text: `${localize('alignment.pairs')}: 0/4`, class: 'alignment-result-label' });
        const rmsLabel = new Label({ text: `${localize('alignment.rms')}: -`, class: 'alignment-result-label' });
        resultRow.append(pairCount);
        resultRow.append(rmsLabel);
        this.append(resultRow);

        const actionRow = new Container({ class: 'alignment-button-row' });
        const previewBtn = new Button({ text: localize('alignment.preview'), class: 'alignment-button' });
        const applyBtn = new Button({ text: localize('alignment.align'), class: 'alignment-button' });
        actionRow.append(previewBtn);
        actionRow.append(applyBtn);
        this.append(actionRow);

        const splatName = (splat: Splat) => {
            const filename = (splat.asset.file as any)?.filename ?? splat.name ?? `Splat ${splat.uid}`;
            return `${splat.uid}: ${filename}`;
        };

        const splats = () => scene.getElementsByType(ElementType.splat) as Splat[];
        const byUid = (uid: number) => splats().find(splat => splat.uid === uid) ?? null;

        const updateSplatOptions = () => {
            const options = splats().map(splat => ({ v: splat.uid, t: splatName(splat) }));
            sourceSelect.options = options;
            targetSelect.options = options;

            if (!manager.source && options.length > 0) {
                manager.setSource(byUid(options[0].v as number));
            }
            if (!manager.target && options.length > 1) {
                manager.setTarget(byUid(options[1].v as number));
            }

            sourceSelect.value = manager.source?.uid ?? null;
            targetSelect.value = manager.target?.uid ?? null;
        };

        const residualForPair = (pair: AlignmentPair) => {
            const complete = manager.completePairs();
            const index = complete.indexOf(pair);
            return index >= 0 ? manager.lastResult?.residuals[index] : null;
        };

        const rebuildPairs = () => {
            while (tbody.firstChild) {
                tbody.removeChild(tbody.firstChild);
            }

            manager.pairs.forEach((pair, index) => {
                const row = document.createElement('tr');
                const residual = residualForPair(pair);
                row.innerHTML = `
                    <td>${index + 1}</td>
                    <td>${fmtPoint(pair.source)}</td>
                    <td>${fmtPoint(pair.target)}</td>
                    <td>${residual === null || residual === undefined ? '-' : fmt(residual)}</td>
                    <td class="alignment-row-actions"></td>
                `;

                const actions = row.querySelector('.alignment-row-actions') as HTMLElement;
                const up = document.createElement('button');
                up.textContent = '↑';
                up.disabled = index === 0;
                up.addEventListener('click', () => manager.movePair(pair.id, -1));
                const down = document.createElement('button');
                down.textContent = '↓';
                down.disabled = index === manager.pairs.length - 1;
                down.addEventListener('click', () => manager.movePair(pair.id, 1));
                const del = document.createElement('button');
                del.textContent = '✕';
                del.addEventListener('click', () => {
                    // on the last (in-progress) pair, deleting a complete pair
                    // removes only the target so the already-placed source is
                    // kept and its target can be re-picked; all other rows delete
                    // the whole pair.
                    const isLast = manager.pairs[manager.pairs.length - 1] === pair;
                    if (isLast && pair.source && pair.target) {
                        manager.removePoint(pair.id, 'target');
                    } else {
                        manager.deletePair(pair.id);
                    }
                });
                actions.appendChild(up);
                actions.appendChild(down);
                actions.appendChild(del);
                tbody.appendChild(row);
            });
        };

        const update = () => {
            updateSplatOptions();
            rebuildPairs();
            const completeCount = manager.completePairs().length;
            pairCount.text = `${localize('alignment.pairs')}: ${completeCount}/4`;
            rmsLabel.text = `${localize('alignment.rms')}: ${manager.lastResult ? fmt(manager.lastResult.rms) : '-'}`;
            previewBtn.text = manager.previewActive ? localize('alignment.revert-preview') : localize('alignment.preview');
            previewBtn.enabled = !!manager.lastResult || manager.previewActive;
            applyBtn.enabled = !!manager.lastResult || manager.previewActive;
            pickSourceBtn.class[manager.pickSide === 'source' ? 'add' : 'remove']('active');
            pickTargetBtn.class[manager.pickSide === 'target' ? 'add' : 'remove']('active');
        };

        sourceSelect.on('change', (value: number) => manager.setSource(byUid(value)));
        targetSelect.on('change', (value: number) => manager.setTarget(byUid(value)));
        modeSelect.on('change', (value: 'rigid' | 'similarity') => manager.setMode(value));
        pickSourceBtn.dom.addEventListener('click', () => manager.setPickSide('source'));
        pickTargetBtn.dom.addEventListener('click', () => manager.setPickSide('target'));
        swapBtn.dom.addEventListener('click', () => manager.swapSourceTarget());
        clearBtn.dom.addEventListener('click', () => manager.clearPairs());
        previewBtn.dom.addEventListener('click', () => {
            if (manager.previewActive) {
                manager.revertPreview();
                manager.lastResult = manager.solve();
                events.fire('alignment.changed');
            } else {
                manager.preview();
            }
        });
        applyBtn.dom.addEventListener('click', () => manager.apply());

        events.on('alignment.active', (active: boolean) => {
            this.hidden = !active;
            update();
        });
        events.on('alignment.changed', update);
        events.on('scene.elementAdded', update);
        events.on('scene.elementRemoved', update);

        update();
    }
}

export { AlignmentPanel };
