import { Button, Container, Label, TextInput } from '@playcanvas/pcui';

import {
    AnnotationData,
    AnnotationTranslation,
    cloneTranslations,
    hasTranslationContent,
    TRANSLATION_LOCALES,
    UpdateAnnotationOp
} from '../annotations';
import { Events } from '../events';
import { i18n } from './localization';

// Modal editor for one annotation's translations. Edits a working COPY: the
// whole session (every language, every field) commits as a single
// UpdateAnnotationOp, so it is one undo step rather than one per keystroke.
// Same contract as AnnotationImagesDialog, which this is modelled on.
class AnnotationTranslationsDialog extends Container {
    show: (id: string) => void;
    hide: () => void;

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'annotation-translations-dialog',
            class: ['settings-dialog', 'blocks-shortcuts'],
            hidden: true,
            tabIndex: -1
        };

        super(args);

        const dialog = new Container({ id: 'dialog' });

        const headerText = new Label({ id: 'text' });
        i18n.bindText(headerText, 'popup.annotation-translations.header');
        const header = new Container({ id: 'header' });
        header.append(headerText);

        const body = new Container({ class: 'annotation-translations-body' });
        const langList = new Container({ class: 'annotation-translations-langs' });
        const fields = new Container({ class: 'annotation-translations-fields' });
        body.append(langList);
        body.append(fields);

        const okButton = new Button({ class: 'button' });
        i18n.bindText(okButton, 'popup.ok');
        const cancelButton = new Button({ class: 'button' });
        i18n.bindText(cancelButton, 'popup.cancel');
        const footer = new Container({ id: 'footer' });
        footer.append(cancelButton);
        footer.append(okButton);

        // the body goes inside #content like every other settings dialog:
        // settings-dialog.scss hangs the body padding off that id
        const content = new Container({ id: 'content' });
        content.append(body);

        dialog.append(header);
        dialog.append(content);
        dialog.append(footer);
        this.append(dialog);

        // --- working state ---

        let annotationId: string | null = null;
        let base: AnnotationData | null = null;
        let working: Record<string, AnnotationTranslation> = {};
        let selected = TRANSLATION_LOCALES[0];
        let objectUrls: string[] = [];

        const releaseThumbnails = () => {
            objectUrls.forEach(url => URL.revokeObjectURL(url));
            objectUrls = [];
        };

        const entry = (): AnnotationTranslation => {
            working[selected] = working[selected] ?? {};
            return working[selected];
        };

        // rebuildLangs and rebuildFields call each other (selecting a language
        // rebuilds the fields; editing a field rebuilds the language list's
        // "translated" dot), so both are hoisted function declarations rather
        // than const arrow functions -- otherwise whichever is defined second
        // would be referenced before its declaration in the other.
        function rebuildLangs() {
            langList.clear();
            i18n.languages.forEach((lang) => {
                const row = new Container({
                    class: hasTranslationContent(working[lang.code]) ?
                        ['annotation-translations-lang', 'translated'] :
                        ['annotation-translations-lang']
                });
                if (lang.code === selected) {
                    row.class.add('selected');
                }
                // native names, so a user who cannot read the current UI
                // language still recognises their own
                row.append(new Label({ text: lang.name }));
                row.dom.addEventListener('click', () => {
                    selected = lang.code;
                    rebuildLangs();
                    rebuildFields();
                });
                langList.append(row);
            });
        }

        // A labelled row: field name and the untranslated base string on one
        // header line, the translation input on its own line below.
        //
        // The header is its own container rather than three siblings in a
        // wrapping row: as siblings, a SHORT label+base pair leaves room for
        // the input on the same line while a long one pushes it to the next,
        // so Title and Text laid out differently purely by string length.
        const addRow = (labelKey: string, baseText: string, value: string, onChange: (v: string) => void) => {
            const row = new Container({ class: 'annotation-translations-row' });
            const header = new Container({ class: 'annotation-translations-row-header' });
            const label = new Label({ class: 'annotation-translations-label' });
            i18n.bindText(label, labelKey);
            const baseLabel = new Label({ class: 'annotation-translations-base', text: baseText });
            const input = new TextInput({ class: 'annotation-translations-input', value });
            input.on('change', onChange);
            header.append(label);
            header.append(baseLabel);
            row.append(header);
            row.append(input);
            fields.append(row);
        };

        function rebuildFields() {
            releaseThumbnails();
            fields.clear();
            if (!base) {
                return;
            }
            const t = entry();

            addRow('panel.annotations.title', base.title, t.title ?? '', (v) => {
                entry().title = v;
                rebuildLangs();
            });
            addRow('panel.annotations.text', base.text, t.text ?? '', (v) => {
                entry().text = v;
                rebuildLangs();
            });

            // only the LIVE action is translatable, matching the export rule.
            // Also requires a non-empty base url: an empty base url can never
            // export a link (see the isUrl comment in annotations.ts), so
            // offering a translation row here would let the editor claim a
            // save that export silently discards.
            if (base.linkType === 'url' && base.url) {
                addRow('panel.annotations.url', base.url, t.url ?? '', (v) => {
                    entry().url = v;
                    rebuildLangs();
                });
            }

            if (base.linkType === 'images' && base.images.length > 0) {
                const heading = new Label({ class: 'annotation-translations-heading' });
                i18n.bindText(heading, 'popup.annotation-translations.captions');
                fields.append(heading);

                // Scrolling list, same shape as .annotation-images-list: an
                // annotation may carry dozens of images and the dialog must not
                // grow with them.
                const list = new Container({ class: 'annotation-translations-captions' });
                base.images.forEach((img, index) => {
                    const row = new Container({ class: 'annotation-translations-caption-row' });

                    const data = events.invoke('annotationImages.get', img.imageId) as Uint8Array | null;
                    const thumb = new Label({ class: 'annotation-images-thumb' });
                    if (data) {
                        const url = URL.createObjectURL(new Blob([data as BlobPart], { type: img.mime }));
                        objectUrls.push(url);
                        thumb.dom.style.backgroundImage = `url(${url})`;
                    } else {
                        thumb.text = i18n.t('popup.annotation-images.missing');
                    }

                    const baseCaption = img.caption ||
                        i18n.t('popup.annotation-translations.image-n', { index: index + 1 });
                    const baseLabel = new Label({
                        class: 'annotation-translations-base',
                        text: baseCaption
                    });

                    const input = new TextInput({
                        class: 'annotation-translations-input',
                        value: t.captions?.[img.imageId] ?? ''
                    });
                    input.on('change', (v: string) => {
                        const e = entry();
                        e.captions = e.captions ?? {};
                        e.captions[img.imageId] = v;
                        rebuildLangs();
                    });

                    // Thumbnail and the image's own caption sit side by side on
                    // a header line (top-aligned, so a caption spanning several
                    // lines grows downward beside the thumbnail rather than
                    // re-centring it), with the translation input full-width
                    // underneath the pair. Mirrors addRow's header/input shape.
                    const header = new Container({ class: 'annotation-translations-caption-header' });
                    header.append(thumb);
                    header.append(baseLabel);
                    row.append(header);
                    row.append(input);
                    list.append(row);
                });
                fields.append(list);
            }
        }

        // --- open / close ---

        this.show = (id: string) => {
            const a = events.invoke('annotations.byId', id) as AnnotationData | null;
            if (!a) {
                return;
            }
            annotationId = id;
            base = a;
            working = cloneTranslations(a.translations);
            selected = TRANSLATION_LOCALES[0];
            rebuildLangs();
            rebuildFields();
            this.hidden = false;
            this.dom.focus();
        };

        this.hide = () => {
            releaseThumbnails();
            this.hidden = true;
            annotationId = null;
            base = null;
        };

        cancelButton.on('click', () => this.hide());

        okButton.on('click', () => {
            const a = annotationId ? (events.invoke('annotations.byId', annotationId) as AnnotationData | null) : null;
            if (a) {
                // strip languages the session left empty, so an opened-and-
                // cancelled-into language never persists as a hollow entry.
                // Each field is trimmed before the truthiness test, so a
                // whitespace-only entry counts as "not translated" and falls
                // back to the base -- rather than shipping as a
                // visually-blank override in exactly one language.
                const next: Record<string, AnnotationTranslation> = {};
                Object.keys(working).forEach((code) => {
                    const t = working[code];
                    const clean: AnnotationTranslation = {};
                    const title = (t.title ?? '').trim();
                    if (title) clean.title = title;
                    const text = (t.text ?? '').trim();
                    if (text) clean.text = text;
                    const url = (t.url ?? '').trim();
                    if (url) clean.url = url;
                    const captions: Record<string, string> = {};
                    Object.keys(t.captions ?? {}).forEach((imageId) => {
                        const caption = (t.captions[imageId] ?? '').trim();
                        if (caption) {
                            captions[imageId] = caption;
                        }
                    });
                    if (Object.keys(captions).length > 0) {
                        clean.captions = captions;
                    }
                    if (hasTranslationContent(clean)) {
                        next[code] = clean;
                    }
                });
                events.fire('edit.add', new UpdateAnnotationOp(
                    events,
                    a.id,
                    { translations: cloneTranslations(a.translations) },
                    { translations: next }
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

        events.on('annotation.translations.edit', (id: string) => this.show(id));
    }
}

export { AnnotationTranslationsDialog };
