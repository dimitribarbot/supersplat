import { Button, Container, Label } from '@playcanvas/pcui';

import { COLLISION_OVERSIZE_BYTES, formatBytes } from '../collision-size-report';
import { Events } from '../events';
import { i18n } from './localization';
import { Tooltips } from './tooltips';

type ExportSummary = {
    header: string;
    message?: string;
    link?: string;
    sizes: { sceneIndex: number; name: string; bytes: number }[];
    // Caller-supplied caveat about what the sizes mean. Publish passes one
    // because it gzips .bin on upload (server/src/s3.ts GZIP_EXTS), so the
    // figures below overstate what a visitor actually downloads.
    sizeNote?: string;
};

// Post-export report of each scene's collision binary size. Shown after an
// export or publish that had collision enabled, so the operator can tune the
// per-scene voxel size against the real number rather than an estimate.
class ExportSummaryDialog extends Container {
    show: (summary: ExportSummary) => Promise<void>;
    hide: () => void;
    destroy: () => void;

    constructor(events: Events, tooltips: Tooltips, args = {}) {
        super({ id: 'export-summary-dialog', hidden: true, tabIndex: -1, ...args });

        const dialog = new Container({ id: 'dialog' });
        const header = new Container({ id: 'header' });
        const headerLabel = new Label({ id: 'header', text: '' });
        header.append(headerLabel);

        const content = new Container({ id: 'content' });
        const message = new Label({ class: 'summary-message', hidden: true });
        // The published URL is long and unbreakable, so it is ellipsised inside a
        // flex row rather than allowed to widen the dialog into a horizontal
        // scrollbar. The copy button restores the affordance the shared popup
        // offers, since the ellipsised text can no longer be usefully selected.
        const link = new Container({ class: 'summary-link', hidden: true });
        const linkText = new Container({ class: 'summary-link-text' });
        const linkAnchor = document.createElement('a');
        linkAnchor.target = '_blank';
        linkAnchor.rel = 'noopener';
        linkText.dom.appendChild(linkAnchor);
        const linkCopy = new Button({ class: 'summary-link-copy', icon: 'E352' });
        link.append(linkText);
        link.append(linkCopy);
        const sectionLabel = new Label({ class: 'summary-section', text: i18n.t('popup.export.summary.collision') });
        const list = new Container({ class: 'summary-list', flex: true, flexDirection: 'column' });
        const oversizeNote = new Label({ class: 'summary-oversize', text: i18n.t('popup.export.summary.oversize'), hidden: true });
        const sizeNote = new Label({ class: 'summary-size-note', hidden: true });
        content.append(message);
        content.append(link);
        content.append(sectionLabel);
        content.append(list);
        content.append(oversizeNote);
        content.append(sizeNote);

        const footer = new Container({ id: 'footer' });
        const okButton = new Button({ class: 'button', text: i18n.t('popup.ok') });
        footer.append(okButton);

        dialog.append(header);
        dialog.append(content);
        dialog.append(footer);
        this.append(dialog);

        let onOk: () => void;
        okButton.on('click', () => onOk());

        // Tracked separately from the anchor so the handler cannot copy a stale
        // URL after a show() that supplied none.
        let currentLink: string | null = null;
        linkCopy.on('click', () => {
            if (currentLink) navigator.clipboard.writeText(currentLink);
        });

        const keydown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' || e.key === 'Enter') onOk();
            else e.stopPropagation();
        };

        this.show = (summary: ExportSummary) => {
            headerLabel.text = summary.header;

            message.hidden = !summary.message;
            if (summary.message) message.text = summary.message;

            link.hidden = !summary.link;
            currentLink = summary.link ?? null;
            if (summary.link) {
                linkAnchor.href = summary.link;
                linkAnchor.textContent = summary.link;
                // the visible text is ellipsised, so expose the full URL on hover
                linkAnchor.title = summary.link;
            } else {
                // clear so no stale URL/text survives on the instance once hidden
                linkAnchor.removeAttribute('href');
                linkAnchor.removeAttribute('title');
                linkAnchor.textContent = '';
            }

            list.clear();
            let anyOversize = false;
            for (const s of summary.sizes) {
                const row = new Container({ class: 'summary-row' });
                row.append(new Label({ class: 'summary-scene', text: i18n.t('popup.export.summary.scene', { index: s.sceneIndex }) }));
                const nameLabel = new Label({ class: 'summary-name', text: s.name });
                nameLabel.dom.title = s.name;
                row.append(nameLabel);
                row.append(new Label({ class: 'summary-bytes', text: formatBytes(s.bytes) }));
                if (s.bytes > COLLISION_OVERSIZE_BYTES) {
                    anyOversize = true;
                    row.append(new Label({ class: 'summary-warn', text: '⚠' }));
                }
                list.append(row);
            }
            oversizeNote.hidden = !anyOversize;

            sizeNote.hidden = !summary.sizeNote;
            if (summary.sizeNote) sizeNote.text = summary.sizeNote;

            this.hidden = false;
            this.dom.addEventListener('keydown', keydown);
            this.dom.focus();

            return new Promise<void>((resolve) => {
                onOk = () => resolve();
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

        events.function('showExportSummary', (summary: ExportSummary) => {
            return this.show(summary);
        });

        tooltips.register(linkCopy, () => i18n.t('popup.copy-to-clipboard'));
    }
}

export { ExportSummaryDialog, type ExportSummary };
