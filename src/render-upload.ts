import { Events } from './events';
import { checkUploadExists, uploadRender, UploadExistsError } from './export-server-client';
import { i18n } from './ui/localization';

// Destination chosen in the image/video render dialogs when "Publish to S3" is
// on. The extension is not part of `name`: it comes from the render format, so
// the object lands at `<subfolder>/<name>.<ext>`.
export type RenderUploadTarget = {
    subfolder: string;
    name: string;
    public: boolean;
};

const registerRenderUploadEvents = (events: Events) => {
    // Resolve the destination BEFORE the render runs. Discovering a collision
    // afterwards would throw away a multi-minute video render, so the overwrite
    // prompt happens up front — the same question the publish flow asks, just
    // earlier in the sequence.
    events.function('render.s3.confirm', async (target: RenderUploadTarget, ext: string): Promise<boolean> => {
        let exists: boolean;
        try {
            exists = await checkUploadExists(target.subfolder, target.name, ext);
        } catch (error) {
            await events.invoke('showPopup', {
                type: 'error',
                header: i18n.t('popup.render.s3.failed'),
                message: error.message ?? String(error)
            });
            return false;
        }

        if (!exists) return true;

        const res = await events.invoke('showPopup', {
            type: 'okcancel',
            header: i18n.t('popup.render.s3.overwrite-header'),
            message: i18n.t('popup.render.s3.overwrite-message')
        });
        return res.action !== 'cancel';
    });

    events.function('render.s3.upload', async (file: Blob, target: RenderUploadTarget, ext: string): Promise<boolean> => {
        // header names the operation, the text line names the current phase:
        // "Uploading to Storage..." while the body transfers, then "Saving to
        // Storage..." for the server's PutObject
        events.fire('progressStart', i18n.t('popup.render.s3.publish'));
        events.fire('progressUpdate', { text: i18n.t('popup.render.s3.uploading') });

        try {
            const result = await uploadRender(
                file,
                // overwrite is already settled by render.s3.confirm above
                { ...target, ext, overwrite: true },
                fraction => events.fire('progressUpdate', { progress: 100 * fraction }),
                () => events.fire('progressUpdate', { text: i18n.t('popup.render.s3.storing') })
            );

            events.fire('progressEnd');

            await events.invoke('showPopup', {
                type: 'info',
                header: i18n.t('popup.render.s3.succeeded'),
                message: result.url ?
                    i18n.t('popup.render.s3.public-message') :
                    `${i18n.t('popup.render.s3.private-message')} ${result.key}`,
                link: result.url
            });
            return true;
        } catch (error) {
            events.fire('progressEnd');
            const message = error instanceof UploadExistsError ?
                i18n.t('popup.render.s3.exists-message') :
                (error.message ?? String(error));
            await events.invoke('showPopup', {
                type: 'error',
                header: i18n.t('popup.render.s3.failed'),
                message
            });
            return false;
        }
    });
};

export { registerRenderUploadEvents };
