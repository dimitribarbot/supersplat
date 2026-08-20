import { BooleanInput, Container, Label, TextInput } from '@playcanvas/pcui';

import { RenderUploadTarget } from '../render-upload';
import { i18n } from './localization';

// The "Publish to S3" block shared by the image and video render dialogs: a
// toggle plus the same destination fields the Publish menu's S3 dialog uses.
//
// Rows are returned loose rather than wrapped in a Container so each dialog can
// append them straight into its `#content` — the dialog stylesheet reaches rows
// as `#content .row`, and an extra flex parent between the two would reflow the
// whole form.
type RenderS3Rows = {
    // append to `#content`, in this order
    rows: Container[];
    // reveal the block (the server reported an S3 configuration)
    setAvailable: (available: boolean) => void;
    // the render format's extension, shown after the name so the destination
    // the user is typing reads as the object it will become
    setExtension: (ext: string) => void;
    reset: (defaultName: string) => void;
    // null when the toggle is off: the render saves locally instead
    target: () => RenderUploadTarget | null;
    // a destination with no name has nowhere to go, so OK stays inert
    isValid: () => boolean;
};

// The server accepts only [A-Za-z0-9._-] in a destination name (buildPrefix in
// server/src/index.ts), while the default comes from the document or splat name
// and can carry spaces, parentheses and accents. Seed the field with something
// that will actually validate rather than leaving the user to discover the
// rejection.
const toSafeName = (name: string) => {
    const safe = (name ?? '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
    // `.` alone is rejected server-side as a path segment
    return safe && safe !== '.' ? safe : 'render';
};

const row = (widget: any, labelKey: string) => {
    const c = new Container({ class: 'row' });
    const label = new Label({ class: 'label' });
    i18n.bindText(label, labelKey);
    c.append(label);
    c.append(widget);
    return c;
};

// `onChange` fires whenever the destination is switched on or off, so a dialog
// that gates its OK button on the destination (the video dialog checks the
// master against the server's upload ceiling) can re-evaluate.
const createRenderS3Rows = (onChange?: () => void): RenderS3Rows => {
    const publishBoolean = new BooleanInput({ class: 'boolean', value: false });
    const subfolder = new TextInput({ class: 'text-input' });
    const name = new TextInput({ class: 'text-input' });
    const isPublic = new BooleanInput({ class: 'boolean', value: false });

    const publishRow = row(publishBoolean, 'popup.render.s3.publish');
    const subfolderRow = row(subfolder, 'popup.publish.s3.subfolder');

    // the name row carries the extension hint alongside the input, so build it
    // by hand rather than through `row`
    const nameRow = new Container({ class: 'row' });
    const nameLabel = new Label({ class: 'label' });
    i18n.bindText(nameLabel, 'popup.publish.s3.name');
    const extHint = new Label({ class: 'ext-hint' });
    nameRow.append(nameLabel);
    nameRow.append(name);
    nameRow.append(extHint);

    const publicRow = row(isPublic, 'popup.publish.s3.public');

    let available = false;

    const syncVisibility = () => {
        publishRow.hidden = !available;
        const on = available && publishBoolean.value;
        subfolderRow.hidden = !on;
        nameRow.hidden = !on;
        publicRow.hidden = !on;
    };

    publishBoolean.on('change', () => {
        syncVisibility();
        onChange?.();
    });
    syncVisibility();

    return {
        rows: [publishRow, subfolderRow, nameRow, publicRow],

        setAvailable: (value: boolean) => {
            available = value;
            syncVisibility();
            onChange?.();
        },

        setExtension: (ext: string) => {
            extHint.text = `.${ext}`;
        },

        reset: (defaultName: string) => {
            publishBoolean.value = false;
            subfolder.value = '';
            name.value = toSafeName(defaultName);
            isPublic.value = false;
            syncVisibility();
        },

        target: () => (available && publishBoolean.value ? {
            subfolder: subfolder.value.trim(),
            name: name.value.trim(),
            public: isPublic.value
        } : null),

        isValid: () => !available || !publishBoolean.value || !!name.value.trim()
    };
};

export { createRenderS3Rows, RenderS3Rows };
