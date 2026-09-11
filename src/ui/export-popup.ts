import { BooleanInput, Button, ColorPicker, Container, Element, Label, SelectInput, SliderInput, TextInput } from '@playcanvas/pcui';

import { collectAnnotationImages } from '../annotation-images';
import { Pose } from '../camera-poses';
import { PerSceneCollisionPanel } from './collision-params';
import { i18n } from './localization';
import { Events } from '../events';
import { probeExportCapabilities } from '../export-server-client';
import { ExportSettings } from '../export-settings';
import { ExportType, SceneExportOptions } from '../file-handler';
import type { BlobReadSource, WriteTarget } from '../io';
import { buildPortalBundle } from '../portal-export';
import { AnimTrack, ExperienceSettings, defaultPostEffectSettings } from '../splat-serialize';
import sceneExport from './svg/export.svg';
import projectSave from './svg/save.svg';

type FileDialogType = ExportType | 'ssproj';
type SaveOptions = Pick<SceneExportOptions, 'filename' | 'fileTarget'>;

const createSvg = (svgString: string, args = {}) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new Element({
        dom: new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement,
        ...args
    });
};

const removeKnownExtension = (filename: string) => {
    // remove known extensions (ordered from longest to shortest for compound extensions)
    const knownExtensions = [
        '.compressed.ply',
        '.ksplat',
        '.splat',
        '.html',
        '.lcc2',
        '.ply',
        '.sog',
        '.spz',
        '.lcc',
        '.zip'
    ];

    for (let i = 0; i < knownExtensions.length; ++i) {
        const ext = knownExtensions[i];
        if (filename.endsWith(ext)) {
            return filename.slice(0, -ext.length);
        }
    }

    return filename;
};

const isValidFilename = (filename: string) => {
    return !!filename.trim() && !/[<>:"/\\|?*]|[. ]$/.test(filename) &&
        !Array.from(filename).some(char => char.charCodeAt(0) < 32) &&
        !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename);
};

class ExportPopup extends Container {
    show: (exportType: FileDialogType, splatNames: string[], settings?: ExportSettings, exclude?: BlobReadSource) => Promise<null | SceneExportOptions | SaveOptions>;
    hide: () => void;
    destroy: () => void;

    constructor(events: Events, args = {}) {
        args = {
            id: 'export-popup',
            class: 'blocks-shortcuts',
            hidden: true,
            tabIndex: -1,
            ...args
        };

        super(args);

        const hasFilePicker = !!window.showDirectoryPicker;

        // UI

        const dialog = new Container({
            id: 'dialog'
        });

        // header

        const header = new Container({
            id: 'header'
        });

        const headerText = new Label({
            id: 'header'
        });
        const exportIcon = createSvg(sceneExport, { id: 'icon' });
        const saveIcon = createSvg(projectSave, { id: 'save-icon', hidden: true });
        header.append(exportIcon);
        header.append(saveIcon);

        header.append(headerText);

        // content

        const content = new Container({ id: 'content' });

        let currentExportType: FileDialogType;

        // type

        const viewerTypeRow = new Container({
            class: 'row'
        });

        const viewerTypeLabel = new Label({
            class: 'label'
        });
        i18n.bindText(viewerTypeLabel, 'popup.export.type');

        const viewerTypeSelect = new SelectInput({
            class: 'select',
            defaultValue: 'html'
        });
        i18n.bindOptions(viewerTypeSelect, () => [
            { v: 'html', t: i18n.t('popup.export.html') },
            { v: 'zip', t: i18n.t('popup.export.package') }
        ]);

        viewerTypeRow.append(viewerTypeLabel);
        viewerTypeRow.append(viewerTypeSelect);

        // Galleries cannot ride in a single-file HTML export; say so rather
        // than dropping them silently.
        const galleryWarning = new Label({ class: 'export-warning' });
        galleryWarning.hidden = true;

        const refreshGalleryWarning = () => {
            const count = ((events.invoke('annotations.list') ?? []) as { linkType?: string, images?: unknown[] }[])
            .filter(a => a.linkType === 'images' && (a.images?.length ?? 0) > 0).length;
            galleryWarning.hidden = !(currentExportType === 'viewer' && viewerTypeSelect.value === 'html' && count > 0);
            if (!galleryWarning.hidden) {
                galleryWarning.text = i18n.t('export.annotation-images-html-warning', { count });
            }
        };

        // viewer: animation

        const animationLabel = new Label({ class: 'label' });
        i18n.bindText(animationLabel, 'popup.export.animation');
        const animationToggle = new BooleanInput({ class: 'boolean', type: 'toggle', value: false });
        const animationRow = new Container({ class: 'row' });
        animationRow.append(animationLabel);
        animationRow.append(animationToggle);

        // viewer: loop mode

        const loopLabel = new Label({ class: 'label' });
        i18n.bindText(loopLabel, 'popup.export.loop-mode');
        const loopSelect = new SelectInput({
            class: 'select',
            defaultValue: 'repeat'
        });
        i18n.bindOptions(loopSelect, () => [
            { v: 'none', t: i18n.t('popup.export.loop-mode.none') },
            { v: 'repeat', t: i18n.t('popup.export.loop-mode.repeat') },
            { v: 'pingpong', t: i18n.t('popup.export.loop-mode.pingpong') }
        ]);
        const loopRow = new Container({ class: 'row' });
        loopRow.append(loopLabel);
        loopRow.append(loopSelect);

        // viewer: clear color

        const colorRow = new Container({
            class: 'row'
        });

        const colorLabel = new Label({
            class: 'label'
        });
        i18n.bindText(colorLabel, 'popup.export.background-color');

        const colorPicker = new ColorPicker({
            class: 'color-picker',
            value: [1, 1, 1, 1]
        });

        colorRow.append(colorLabel);
        colorRow.append(colorPicker);

        // viewer: fov

        const fovRow = new Container({
            class: 'row'
        });

        const fovLabel = new Label({
            class: 'label'
        });
        i18n.bindText(fovLabel, 'popup.export.fov');

        const fovSlider = new SliderInput({
            class: 'slider',
            min: 10,
            max: 120,
            precision: 0,
            value: 60
        });

        fovRow.append(fovLabel);
        fovRow.append(fovSlider);

        // compress

        const compressRow = new Container({
            class: 'row'
        });

        const compressLabel = new Label({
            class: 'label'
        });
        i18n.bindText(compressLabel, 'popup.export.compress-ply');

        const compressBoolean = new BooleanInput({
            class: 'boolean',
            type: 'toggle'
        });

        compressRow.append(compressLabel);
        compressRow.append(compressBoolean);

        // spherical harmonic bands

        const bandsRow = new Container({
            class: 'row'
        });

        const bandsLabel = new Label({
            class: 'label'
        });
        i18n.bindText(bandsLabel, 'popup.export.sh-bands');

        const bandsSlider = new SliderInput({
            class: 'slider',
            min: 0,
            max: 3,
            precision: 0,
            value: 3
        });

        bandsRow.append(bandsLabel);
        bandsRow.append(bandsSlider);

        // sog iterations

        const iterationsRow = new Container({
            class: 'row'
        });

        const iterationsLabel = new Label({
            class: 'label'
        });
        i18n.bindText(iterationsLabel, 'popup.export.iterations');

        const iterationsSlider = new SliderInput({
            class: 'slider',
            min: 1,
            max: 20,
            precision: 0,
            value: 10
        });

        iterationsRow.append(iterationsLabel);
        iterationsRow.append(iterationsSlider);

        // viewer: streaming (zip only)

        const streamingRow = new Container({
            class: 'row'
        });

        const streamingLabel = new Label({
            class: 'label',
            text: i18n.t('popup.export.streaming')
        });

        const streamingToggle = new BooleanInput({
            class: 'boolean',
            type: 'toggle',
            value: true
        });

        streamingRow.append(streamingLabel);
        streamingRow.append(streamingToggle);

        // viewer: collision detection (zip only)

        const collisionRow = new Container({
            class: 'row'
        });

        const collisionLabel = new Label({
            class: 'label',
            text: i18n.t('popup.export.collision')
        });

        const collisionToggle = new BooleanInput({
            class: 'boolean',
            type: 'toggle',
            value: true
        });

        collisionRow.append(collisionLabel);
        collisionRow.append(collisionToggle);

        // viewer: collision environment (shown only when collision is enabled)

        const environmentRow = new Container({
            class: 'row'
        });

        const environmentLabel = new Label({
            class: 'label',
            text: i18n.t('popup.export.environment')
        });

        const environmentSelect = new SelectInput({
            class: 'select',
            defaultValue: 'indoor',
            options: [
                { v: 'indoor', t: i18n.t('popup.export.environment.indoor') },
                { v: 'outdoor', t: i18n.t('popup.export.environment.outdoor') }
            ]
        });

        environmentRow.append(environmentLabel);
        environmentRow.append(environmentSelect);

        // viewer: per-scene collision params (portals only). One collapsible card
        // per portal-referenced scene; falls back to the single environment /
        // radius / voxel rows below when there are no portals.
        const perSceneCollision = new PerSceneCollisionPanel(events);

        // viewer: collision radius (shown only when collision is enabled)

        const radiusRow = new Container({
            class: 'row'
        });

        const radiusLabel = new Label({
            class: 'label',
            text: i18n.t('popup.export.collision-radius')
        });

        const radiusSlider = new SliderInput({
            class: 'slider',
            min: 5,
            max: 500,
            precision: 0,
            value: 50
        });

        radiusRow.append(radiusLabel);
        radiusRow.append(radiusSlider);

        // viewer: collision voxel size (shown only when collision is enabled)

        const voxelSizeRow = new Container({
            class: 'row'
        });

        const voxelSizeLabel = new Label({
            class: 'label',
            text: i18n.t('popup.export.voxel-size')
        });

        const voxelSizeSlider = new SliderInput({
            class: 'slider',
            min: 0.02,
            max: 0.5,
            precision: 2,
            value: 0.05
        });

        voxelSizeRow.append(voxelSizeLabel);
        voxelSizeRow.append(voxelSizeSlider);

        // export on server (shown only when the server supports the selected type)

        const serverRow = new Container({
            class: 'row'
        });

        const serverLabel = new Label({
            class: 'label',
            text: i18n.t('popup.export.use-server')
        });

        const serverToggle = new BooleanInput({
            class: 'boolean',
            type: 'toggle',
            value: true
        });

        serverRow.append(serverLabel);
        serverRow.append(serverToggle);

        // spz version

        const spzVersionRow = new Container({
            class: 'row'
        });

        const spzVersionLabel = new Label({
            class: 'label'
        });
        i18n.bindText(spzVersionLabel, 'popup.export.spz-version');

        const spzVersionSelect = new SelectInput({
            class: 'select',
            defaultValue: '4'
        });
        i18n.bindOptions(spzVersionSelect, () => [
            { v: '4', t: i18n.t('popup.export.spz-version.4') },
            { v: '3', t: i18n.t('popup.export.spz-version.3') }
        ]);

        spzVersionRow.append(spzVersionLabel);
        spzVersionRow.append(spzVersionSelect);

        // location

        const locationRow = new Container({ class: 'row' });
        const locationLabel = new Label({ class: 'label' });
        i18n.bindText(locationLabel, 'popup.export.location');
        const locationValue = new Container({ class: 'location' });
        const locationName = new Label({ class: 'location-name' });
        const changeLocationButton = new Button({ class: 'change-location' });
        locationValue.append(locationName);
        locationValue.append(changeLocationButton);
        locationRow.append(locationLabel);
        locationRow.append(locationValue);

        // filename

        const filenameRow = new Container({
            class: 'row'
        });

        const filenameLabel = new Label({
            class: 'label'
        });
        i18n.bindText(filenameLabel, 'popup.export.filename');

        const filenameEntry = new TextInput({
            class: 'text-input',
            blurOnEnter: false
        });

        const filenameMessage = new Label({ id: 'export-filename-message', hidden: true });
        filenameMessage.dom.setAttribute('role', 'tooltip');
        filenameMessage.dom.setAttribute('aria-live', 'polite');
        filenameEntry.input.setAttribute('aria-describedby', 'export-filename-message');

        const filenameField = new Container({ class: 'filename-field' });
        filenameField.append(filenameEntry);
        filenameField.append(filenameMessage);
        filenameRow.append(filenameLabel);
        filenameRow.append(filenameField);

        // content

        content.append(locationRow);
        content.append(filenameRow);
        content.append(viewerTypeRow);
        content.append(galleryWarning);
        content.append(animationRow);
        content.append(loopRow);
        content.append(colorRow);
        content.append(fovRow);
        content.append(compressRow);
        content.append(bandsRow);
        content.append(iterationsRow);
        content.append(streamingRow);
        content.append(collisionRow);
        content.append(environmentRow);
        content.append(perSceneCollision);
        content.append(radiusRow);
        content.append(voxelSizeRow);
        content.append(serverRow);
        content.append(spzVersionRow);

        // footer

        const footer = new Container({ id: 'footer' });

        const cancelButton = new Button({
            class: 'button'
        });
        i18n.bindText(cancelButton, 'popup.cancel');

        const exportButton = new Button({
            class: 'button'
        });

        footer.append(cancelButton);
        footer.append(exportButton);

        dialog.append(header);
        dialog.append(content);
        dialog.append(footer);

        this.append(dialog);

        // handlers

        let onCancel: () => void;
        let onExport: () => void;
        let directory: FileSystemDirectoryHandle;
        let validationId = 0;
        let existingHandle: FileSystemFileHandle;
        let submitting = false;
        let saveProject = false;
        let filenameExtension: string;
        let excludedSource: BlobReadSource;

        const getFilename = () => {
            const filename = filenameEntry.value;
            return filename && !filename.toLowerCase().endsWith(filenameExtension) ? `${filename}${filenameExtension}` : filename;
        };

        const validateFilename = async (suggest = false): Promise<void> => {
            if (this.hidden) return;
            const id = ++validationId;
            const filename = getFilename();
            const actionKey = saveProject ? 'menu.file.save' : 'popup.export';
            headerText.text = i18n.t(saveProject ? 'popup.save-as' : 'popup.export.header');
            locationName.hidden = !directory;
            locationName.text = directory ? `…/${directory.name}` : '';
            locationName.dom.title = locationName.text;
            changeLocationButton.text = i18n.t(directory ? 'popup.export.change-location' : 'popup.export.choose-location');
            exportButton.enabled = false;
            exportButton.text = i18n.t(actionKey);

            let message = '';
            let handle: FileSystemFileHandle;
            let needsSuggestion = false;
            if (!isValidFilename(filenameEntry.value)) {
                message = i18n.t('popup.export.invalid-filename');
                needsSuggestion = true;
            } else if (directory) {
                try {
                    handle = await directory.getFileHandle(filename);
                    const sources = await events.invoke('scene.sourcesOf', handle) as BlobReadSource[];
                    if (sources.some(source => source !== excludedSource)) {
                        message = i18n.t('popup.overwrite-source');
                        needsSuggestion = true;
                    }
                } catch (error) {
                    if (error.name === 'TypeError' || error.name === 'TypeMismatchError') {
                        message = i18n.t('popup.export.invalid-filename');
                        needsSuggestion = true;
                    } else if (error.name !== 'NotFoundError') {
                        message = `${error.message ?? error}`;
                    }
                }
            }

            if (suggest && needsSuggestion) {
                let stem = removeKnownExtension(filename);
                if (stem === filename && filename.lastIndexOf('.') > 0) {
                    stem = filename.slice(0, filename.lastIndexOf('.'));
                }
                const extension = filename.slice(stem.length);
                let base = Array.from(stem).map(char => (char.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(char) ? '_' : char))
                .join('').trim().replace(/[. ]+$/, '') || 'scene';
                if (!isValidFilename(`${base}_cleaned${extension}`)) base = 'scene';

                let index = 1;
                while (true) {
                    if (id !== validationId) return;
                    const candidate = `${base}_cleaned${index === 1 ? '' : `_${index}`}${extension}`;
                    let available = !directory;
                    if (directory) {
                        try {
                            await directory.getFileHandle(candidate);
                        } catch (error) {
                            if (error.name === 'NotFoundError') {
                                available = true;
                            } else if (error.name === 'TypeError' && base !== 'scene') {
                                base = 'scene';
                                index = 1;
                                continue;
                            } else if (error.name !== 'TypeMismatchError') {
                                message = `${error.message ?? error}`;
                                break;
                            }
                        }
                    }
                    if (id !== validationId) return;
                    if (available) {
                        filenameEntry.value = candidate;
                        if (document.activeElement === filenameEntry.input) filenameEntry.focus(true);
                        await validateFilename();
                        return;
                    }
                    index++;
                }
            }

            // Ignore results for an older filename, folder or closed dialog.
            if (id !== validationId) return;
            existingHandle = handle;
            filenameMessage.text = message || (handle ? i18n.t('popup.export.overwrite-message') : '');
            filenameMessage.hidden = !filenameMessage.text;
            filenameMessage.dom.classList.toggle('error', !!message);
            filenameEntry.input.setAttribute('aria-invalid', String(!!message));
            exportButton.text = i18n.t(handle && !message ? 'popup.export.overwrite' : actionKey);
            exportButton.enabled = !message && (!hasFilePicker || !!directory) && changeLocationButton.enabled && !submitting;
        };

        i18n.onChange(validateFilename, this);
        filenameEntry.input.addEventListener('input', () => validateFilename());

        changeLocationButton.on('click', async () => {
            validationId++;
            changeLocationButton.enabled = false;
            exportButton.enabled = false;
            const selected = await events.invoke('scene.pickExportDirectory', !directory);
            if (selected) {
                directory = selected;
            }
            changeLocationButton.enabled = true;
            validateFilename(!!selected);
        });

        cancelButton.on('click', () => onCancel());
        exportButton.on('click', () => onExport());

        const keydown = (e: KeyboardEvent) => {
            e.stopPropagation();
            if (e.isComposing) return;
            switch (e.key) {
                case 'Escape':
                    e.preventDefault();
                    onCancel();
                    break;
                case 'Enter':
                    if (!e.shiftKey && !(e.target as HTMLElement).closest('button')) {
                        e.preventDefault();
                        onExport();
                    }
                    break;
            }
        };
        filenameEntry.on('keydown', keydown);

        const updateExtension = (ext: string) => {
            filenameExtension = ext === '.compressed.ply' ? '.ply' : ext;
            filenameEntry.value = removeKnownExtension(filenameEntry.value) + ext;
            validateFilename();
        };

        // server export capabilities (probed once, asynchronously). Until the probe
        // resolves the server row stays hidden; it appears on the next popup open or
        // export-type change once capabilities are known.
        type Capabilities = Awaited<ReturnType<typeof probeExportCapabilities>>;
        let capabilities: Capabilities = null;
        probeExportCapabilities().then((caps) => {
            capabilities = caps;
        });

        const updateStreamingVisibility = () => {
            streamingRow.hidden = currentExportType !== 'viewer' || viewerTypeSelect.value !== 'zip';
        };

        const updateCollisionVisibility = () => {
            const isZipViewer = currentExportType === 'viewer' && viewerTypeSelect.value === 'zip';
            collisionRow.hidden = !isZipViewer;
            const showSub = !isZipViewer || !collisionToggle.value;
            perSceneCollision.rebuild(streamingToggle.value);
            const hasCards = !perSceneCollision.hidden && perSceneCollision.sceneCount() > 0;
            // with portals, the three shared rows are replaced by the per-scene cards
            environmentRow.hidden = showSub || hasCards;
            radiusRow.hidden = showSub || hasCards;
            voxelSizeRow.hidden = showSub || hasCards;
            perSceneCollision.hidden = perSceneCollision.hidden || showSub;
        };

        const updateServerVisibility = () => {
            const serverSupports = (() => {
                if (!capabilities?.enabled) return false;
                if (currentExportType === 'splat') return false;             // always client-side
                if (currentExportType === 'viewerSettings') return false;    // pure JSON, no server benefit
                if (currentExportType === 'viewer') {
                    return capabilities.formats.includes('htmlViewer') || capabilities.formats.includes('packageViewer');
                }
                if (currentExportType === 'ply') {
                    return compressBoolean.value && capabilities.formats.includes('compressedPly');
                }
                return capabilities.formats.includes(currentExportType);
            })();
            serverRow.hidden = !serverSupports;
            serverToggle.value = serverSupports;   // default on when shown
        };

        compressBoolean.on('change', () => {
            updateExtension(compressBoolean.value ? '.compressed.ply' : '.ply');
            updateServerVisibility();
        });

        viewerTypeSelect.on('change', () => {
            updateExtension(viewerTypeSelect.value === 'html' ? '.html' : '.zip');
            updateStreamingVisibility();
            updateCollisionVisibility();
            refreshGalleryWarning();
        });

        collisionToggle.on('change', () => {
            updateCollisionVisibility();
        });

        streamingToggle.on('change', () => {
            updateCollisionVisibility();
        });

        animationToggle.on('change', (value: boolean) => {
            loopSelect.enabled = value;
        });

        const reset = (exportType: FileDialogType, splatNames: string[], hasPoses: boolean) => {
            currentExportType = exportType;

            const allRows = [
                viewerTypeRow, animationRow, loopRow, colorRow, fovRow, compressRow, bandsRow, iterationsRow, streamingRow, collisionRow, environmentRow, perSceneCollision, radiusRow, voxelSizeRow, serverRow, spzVersionRow, filenameRow
            ];

            const activeRows: Container[] = {
                ply: [compressRow, bandsRow, serverRow, filenameRow],
                splat: [filenameRow],
                ssproj: [filenameRow],
                sog: [bandsRow, iterationsRow, serverRow, filenameRow],
                spz: [bandsRow, spzVersionRow, filenameRow],
                viewer: [viewerTypeRow, animationRow, loopRow, colorRow, fovRow, bandsRow, streamingRow, collisionRow, environmentRow, perSceneCollision, radiusRow, voxelSizeRow, serverRow, filenameRow],
                viewerSettings: [animationRow, loopRow, colorRow, fovRow, filenameRow]
            }[exportType];

            allRows.forEach((r) => {
                r.hidden = activeRows.indexOf(r) === -1;
            });

            bandsSlider.value = events.invoke('view.bands');

            // ply
            compressBoolean.value = false;

            // sog
            iterationsSlider.value = 10;

            // streaming (viewer zip only)
            streamingToggle.value = true;
            updateStreamingVisibility();

            // collision detection (viewer zip only)
            collisionToggle.value = true;
            environmentSelect.value = 'indoor';
            perSceneCollision.reset();
            radiusSlider.value = 50;
            voxelSizeSlider.value = 0.05;
            updateCollisionVisibility();

            // server-export row: only when the server actually supports the selected type
            updateServerVisibility();

            // spz
            spzVersionSelect.value = '4';

            // filename
            filenameEntry.value = splatNames[0];
            switch (exportType) {
                case 'ply':
                    updateExtension('.ply');
                    break;
                case 'splat':
                    updateExtension('.splat');
                    break;
                case 'sog':
                    updateExtension('.sog');
                    break;
                case 'spz':
                    updateExtension('.spz');
                    break;
                case 'viewer':
                    updateExtension(viewerTypeSelect.value === 'html' ? '.html' : '.zip');
                    break;
                case 'viewerSettings':
                    updateExtension('.json');
                    break;
                case 'ssproj':
                    // Not `updateExtension`: '.ssproj' is absent from
                    // `removeKnownExtension`'s table, so it would turn the
                    // incoming 'scene.ssproj' into 'scene.ssproj.ssproj'.
                    // `getFilename` only appends when it is missing.
                    filenameExtension = '.ssproj';
                    filenameEntry.value = getFilename();
                    break;
            }
            // viewer
            const bgClr = events.invoke('bgClr');

            animationToggle.value = hasPoses;
            animationToggle.enabled = hasPoses;
            loopSelect.value = events.invoke('timeline.loop') ? 'repeat' : 'none';
            loopSelect.enabled = hasPoses;

            colorPicker.value = [bgClr.r, bgClr.g, bgClr.b];

            fovSlider.value = events.invoke('camera.fov');

            refreshGalleryWarning();
        };

        this.show = (exportType: FileDialogType, splatNames: string[], settings: ExportSettings = {}, exclude?: BlobReadSource) => {
            saveProject = exportType === 'ssproj';
            excludedSource = exclude;
            exportIcon.hidden = saveProject;
            saveIcon.hidden = !saveProject;

            const frames = events.invoke('timeline.frames');
            const frameRate = events.invoke('timeline.frameRate');
            const smoothness = events.invoke('timeline.smoothness');
            const orderedPoses = (events.invoke('camera.poses') as Pose[])
            .slice()
            .filter(p => p.frame >= 0 && p.frame < frames)
            .sort((a, b) => a.frame - b.frame);

            reset(exportType, splatNames, orderedPoses.length > 0);

            directory = settings.directory;
            locationRow.hidden = !hasFilePicker;

            filenameMessage.text = '';
            filenameMessage.hidden = true;
            this.hidden = false;
            validateFilename(true);
            this.dom.addEventListener('keydown', keydown);
            filenameEntry.focus(true);

            const assemblePlyOptions = () : SceneExportOptions => {
                return {
                    filename: getFilename(),
                    splatIdx: 'all',
                    serializeSettings: {
                        maxSHBands: bandsSlider.value
                    },
                    compressedPly: compressBoolean.value,
                    useServer: !serverRow.hidden && serverToggle.value
                };
            };

            const assembleSplatOptions = () : SceneExportOptions => {
                return {
                    filename: getFilename(),
                    splatIdx: 'all',
                    serializeSettings: { },
                    useServer: !serverRow.hidden && serverToggle.value
                };
            };

            const assembleSogOptions = () : SceneExportOptions => {
                return {
                    filename: getFilename(),
                    splatIdx: 'all',
                    serializeSettings: {
                        maxSHBands: bandsSlider.value
                    },
                    sogIterations: iterationsSlider.value,
                    useServer: !serverRow.hidden && serverToggle.value
                };
            };

            const assembleSpzOptions = () : SceneExportOptions => {
                return {
                    filename: getFilename(),
                    splatIdx: 'all',
                    serializeSettings: {
                        maxSHBands: bandsSlider.value
                    },
                    spzVersion: spzVersionSelect.value === '3' ? 3 : 4
                };
            };

            const assembleViewerOptions = () : SceneExportOptions => {
                const fov = fovSlider.value;

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

                const includeAnimation = animationToggle.value;
                const animTracks: AnimTrack[] = [];

                if (includeAnimation && orderedPoses.length > 0) {
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
                        loopMode: loopSelect.value as 'none' | 'repeat' | 'pingpong',
                        interpolation: 'spline',
                        smoothness,
                        keyframes: {
                            times,
                            values: { position, target, fov: fovKeys }
                        }
                    });
                }

                const bgColor = colorPicker.value.slice(0, 3) as [number, number, number];

                // portal multi-scene bundle (absent when no portals)
                const portalsRaw = events.invoke('portals.export') ?? [];
                const startUid = events.invoke('portals.startSplat') ?? null;
                const allSplats = events.invoke('scene.allSplats') ?? [];
                const availableUids = allSplats.map((s: any) => s.uid);
                const collisionOn = viewerTypeSelect.value === 'zip' && collisionToggle.value;
                const preferredStartUid = events.invoke('selection')?.uid ?? null;
                const bundle = (events.invoke('portals.count') ?? 0) > 0 ?
                    buildPortalBundle({ portals: portalsRaw, startUid, availableUids, streaming: streamingToggle.value, collision: collisionOn, preferredStartUid }) :
                    null;

                const experienceSettings: ExperienceSettings = {
                    version: 2,
                    tonemapping: events.invoke('camera.tonemapping') ?? 'none',
                    highPrecisionRendering: false,
                    background: { color: bgColor },
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
                        portalEnvironments: bundle.sceneUids.map((_, i) => perSceneCollision.valuesAt(i).environment),
                        portalRadii: bundle.sceneUids.map((_, i) => perSceneCollision.valuesAt(i).radius),
                        portalVoxelSizes: bundle.sceneUids.map((_, i) => perSceneCollision.valuesAt(i).voxelSize)
                    } : {}),
                    startMode: includeAnimation ? 'animTrack' : 'default'
                };

                return {
                    filename: getFilename(),
                    splatIdx: 'all',
                    serializeSettings: {
                        maxSHBands: bandsSlider.value
                    },
                    viewerExportSettings: {
                        type: viewerTypeSelect.value,
                        streaming: streamingToggle.value,
                        // For a portal export the start scene (index 0) is hidden from the
                        // global environmentSelect and chosen via its per-scene card, so
                        // source its environment from there (portalEnvironments[0]); fall back
                        // to the global select for a non-portal export.
                        collision: (viewerTypeSelect.value === 'zip' && collisionToggle.value) ? (bundle ? {
                            environment: perSceneCollision.valuesAt(0).environment,
                            radius: perSceneCollision.valuesAt(0).radius,
                            voxelSize: perSceneCollision.valuesAt(0).voxelSize
                        } : {
                            environment: environmentSelect.value as 'indoor' | 'outdoor',
                            radius: radiusSlider.value,
                            voxelSize: voxelSizeSlider.value
                        }) : undefined,
                        experienceSettings,
                        // ZIP only: the single-file HTML export has nowhere to
                        // put them (the warning below tells the user)
                        annotationImages: viewerTypeSelect.value === 'zip' ? collectAnnotationImages(events) : undefined
                    },
                    useServer: !serverRow.hidden && serverToggle.value
                };
            };

            const assembleViewerSettingsOptions = (): SceneExportOptions => {
                const viewerOptions = assembleViewerOptions();
                return {
                    filename: viewerOptions.filename,
                    splatIdx: 'all',
                    serializeSettings: {},
                    viewerExportSettings: viewerOptions.viewerExportSettings
                };
            };

            return new Promise<null | SceneExportOptions | SaveOptions>((resolve) => {
                onCancel = () => {
                    resolve(null);
                };

                onExport = async () => {
                    if (!exportButton.enabled || submitting) return;
                    const id = validationId;
                    const overwriteHandle = existingHandle;
                    submitting = true;
                    exportButton.enabled = false;
                    try {
                        const options = exportType === 'ssproj' ? { filename: getFilename() } : {
                            ply: assemblePlyOptions,
                            splat: assembleSplatOptions,
                            sog: assembleSogOptions,
                            spz: assembleSpzOptions,
                            viewer: assembleViewerOptions,
                            viewerSettings: assembleViewerSettingsOptions
                        }[exportType]();
                        let fileTarget: WriteTarget;
                        // Every export this dialog can start writes a local file, the
                        // 'export on server' ones included: the server only runs the
                        // writers, and the bytes it returns are saved through this very
                        // target (see writeViaServer in file-handler.ts). So there is no
                        // export type to exempt from the folder request here. The S3
                        // publish flow, which really does only stream to HTTP, never
                        // comes through this dialog -- it runs off 'scene.publishS3'.
                        if (directory) {
                            const target = await events.invoke('scene.pickWriteTarget', directory, getFilename(),
                                async (handle: FileSystemFileHandle) => !!overwriteHandle && await handle.isSameEntry(overwriteHandle), excludedSource);

                            // A newly detected file needs an explicit Overwrite click.
                            // Keep the dialog open if its filename or folder changed while checking.
                            if (!target || id !== validationId || this.hidden) {
                                await target?.discard?.();
                                submitting = false;
                                await validateFilename();
                                return;
                            }
                            fileTarget = target;
                        }
                        resolve({ ...options, fileTarget });
                    } catch (error) {
                        submitting = false;
                        await validateFilename();
                        filenameMessage.text = `${error.message ?? error}`;
                        filenameMessage.hidden = false;
                        filenameMessage.dom.classList.add('error');
                        filenameEntry.focus();
                    } finally {
                        submitting = false;
                    }
                };
            }).finally(() => {
                this.dom.removeEventListener('keydown', keydown);
                this.hide();
            });
        };

        this.hide = () => {
            validationId++;
            this.hidden = true;
        };

        this.destroy = () => {
            this.hide();
            super.destroy();
        };
    }
}

export { ExportPopup };
