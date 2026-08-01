import { Button, Container, Label, TextInput } from '@playcanvas/pcui';

import { encodeAnnotationImage } from '../annotation-images';
import { AnnotationData, AnnotationImage, UpdateAnnotationOp } from '../annotations';
import { Events } from '../events';
import { i18n } from './localization';

const formatSize = (bytes: number): string => {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(0)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// Modal editor for one annotation's image list. Edits a working COPY: the whole
// session (adds, caption edits, reorders, removals) commits as a single
// UpdateAnnotationOp, so it is one undo step rather than one per keystroke.
class AnnotationImagesDialog extends Container {
    show: (id: string) => void;
    hide: () => void;

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'annotation-images-dialog',
            class: ['settings-dialog', 'blocks-shortcuts'],
            hidden: true,
            tabIndex: -1
        };

        super(args);

        const dialog = new Container({ id: 'dialog' });

        const headerText = new Label({ id: 'text' });
        i18n.bindText(headerText, 'popup.annotation-images.header');
        const header = new Container({ id: 'header' });
        header.append(headerText);

        const list = new Container({ class: 'annotation-images-list' });
        const emptyLabel = new Label({ class: 'annotation-images-empty' });
        i18n.bindText(emptyLabel, 'popup.annotation-images.empty');

        const totalLabel = new Label({ class: 'annotation-images-total' });

        const addButton = new Button({ class: 'annotation-images-add' });
        i18n.bindText(addButton, 'popup.annotation-images.add');

        // persistent UI strings are bound, never assigned literally (see the
        // note at the top of ui/localization.ts); popup.ok / popup.cancel are
        // the existing generic keys
        const okButton = new Button({ class: 'button' });
        i18n.bindText(okButton, 'popup.ok');
        const cancelButton = new Button({ class: 'button' });
        i18n.bindText(cancelButton, 'popup.cancel');
        const footer = new Container({ id: 'footer' });
        footer.append(cancelButton);
        footer.append(okButton);

        // the dialog body goes inside #content, like every other settings
        // dialog: settings-dialog.scss hangs the body padding off that id, so
        // without it the rows sit flush against the dialog edge
        const content = new Container({ id: 'content' });
        content.append(list);
        content.append(emptyLabel);
        content.append(addButton);
        content.append(totalLabel);

        dialog.append(header);
        dialog.append(content);
        dialog.append(footer);
        this.append(dialog);

        // --- working state ---

        let annotationId: string | null = null;
        let working: AnnotationImage[] = [];
        // object URLs minted for the row thumbnails; revoked on close so the
        // dialog does not leak a blob per open
        let objectUrls: string[] = [];

        const releaseThumbnails = () => {
            objectUrls.forEach(url => URL.revokeObjectURL(url));
            objectUrls = [];
        };

        const bytesOf = (imageId: string): Uint8Array | null => {
            return events.invoke('annotationImages.get', imageId) as Uint8Array | null;
        };

        const rebuild = () => {
            releaseThumbnails();
            list.clear();

            let total = 0;
            working.forEach((img, index) => {
                const row = new Container({ class: 'annotation-images-row' });

                const data = bytesOf(img.imageId);
                total += data?.length ?? 0;

                const thumb = new Label({ class: 'annotation-images-thumb' });
                if (data) {
                    const url = URL.createObjectURL(new Blob([data as BlobPart], { type: img.mime }));
                    objectUrls.push(url);
                    thumb.dom.style.backgroundImage = `url(${url})`;
                } else {
                    // the document referenced an image whose bytes were not in
                    // the archive: show the row rather than dropping it silently
                    thumb.text = i18n.t('popup.annotation-images.missing');
                }

                const captionLabel = new Label({ class: 'annotation-images-caption-label' });
                i18n.bindText(captionLabel, 'popup.annotation-images.caption');

                // PCUI paints the placeholder as an opaque ::after anchored to the
                // field's right edge and never clears it once set, so it would sit
                // on top of a typed caption. Show it only while the field is empty.
                const placeholder = i18n.t('popup.annotation-images.caption-placeholder');
                const caption = new TextInput({
                    class: 'annotation-images-caption',
                    value: img.caption,
                    placeholder: img.caption ? '' : placeholder
                });
                caption.on('change', (v: string) => {
                    working[index].caption = v;
                });
                const captionInput = caption.dom.querySelector('input') as HTMLInputElement;
                captionInput.addEventListener('input', () => {
                    caption.placeholder = captionInput.value ? '' : placeholder;
                });

                const up = new Button({ class: 'annotation-images-move', text: '▲' });
                up.dom.title = i18n.t('tooltip.annotation-images.move-up');
                up.enabled = index > 0;
                up.on('click', () => {
                    const [moved] = working.splice(index, 1);
                    working.splice(index - 1, 0, moved);
                    rebuild();
                });

                const down = new Button({ class: 'annotation-images-move', text: '▼' });
                down.dom.title = i18n.t('tooltip.annotation-images.move-down');
                down.enabled = index < working.length - 1;
                down.on('click', () => {
                    const [moved] = working.splice(index, 1);
                    working.splice(index + 1, 0, moved);
                    rebuild();
                });

                const remove = new Button({ class: 'annotation-images-remove', text: '✕' });
                remove.dom.title = i18n.t('tooltip.annotation-images.remove');
                remove.on('click', () => {
                    working.splice(index, 1);
                    rebuild();
                });

                row.append(thumb);
                row.append(captionLabel);
                row.append(caption);
                row.append(up);
                row.append(down);
                row.append(remove);
                list.append(row);
            });

            emptyLabel.hidden = working.length > 0;
            totalLabel.text = i18n.t('popup.annotation-images.total-size', { size: formatSize(total) });
        };

        const addFiles = async (files: FileList) => {
            const failed: string[] = [];
            for (const file of Array.from(files)) {
                try {
                    const encoded = await encodeAnnotationImage(file);
                    const imageId = events.invoke('annotationImages.newId') as string;
                    events.fire('annotationImages.put', imageId, encoded.data);
                    working.push({ imageId, ext: encoded.ext, mime: encoded.mime, caption: '' });
                } catch (err) {
                    console.warn(`annotation image import failed for ${file.name}:`, err);
                    failed.push(file.name);
                }
            }
            rebuild();
            if (failed.length > 0) {
                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('popup.annotation-images.header'),
                    message: i18n.t('popup.annotation-images.decode-failed', { files: failed.join(', ') })
                });
            }
        };

        addButton.on('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.multiple = true;
            input.addEventListener('change', () => {
                if (input.files && input.files.length > 0) {
                    addFiles(input.files);
                }
            });
            input.click();
        });

        // --- open / close ---

        this.show = (id: string) => {
            const a = events.invoke('annotations.byId', id) as AnnotationData | null;
            if (!a) {
                return;
            }
            annotationId = id;
            working = a.images.map(img => ({ ...img }));
            rebuild();
            this.hidden = false;
            this.dom.focus();
        };

        this.hide = () => {
            releaseThumbnails();
            this.hidden = true;
            annotationId = null;
        };

        cancelButton.on('click', () => this.hide());

        okButton.on('click', () => {
            const a = annotationId ? (events.invoke('annotations.byId', annotationId) as AnnotationData | null) : null;
            if (a) {
                events.fire('edit.add', new UpdateAnnotationOp(
                    events,
                    a.id,
                    { images: a.images.map(img => ({ ...img })) },
                    { images: working.map(img => ({ ...img })) }
                ));
            }
            this.hide();
        });

        this.dom.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                this.hide();
            }
        });

        events.on('annotation.images.edit', (id: string) => this.show(id));
    }
}

export { AnnotationImagesDialog };
