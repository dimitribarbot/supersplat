import { MemoryFileSystem } from '@playcanvas/splat-transform';

import { Events } from './events';
import { checkPublishExists, PublishExistsError, runServerPublish } from './export-server-client';
import { buildPortalUpload } from './portal-upload';
import { serializePly, SerializeSettings } from './splat-serialize';
import { localize } from './ui/localization';
import type { S3PublishOptions } from './ui/s3-publish-dialog';

const registerS3PublishEvents = (events: Events) => {
    events.function('scene.publishS3', async (options: S3PublishOptions) => {
        try {
            // overwrite check
            const { exists } = await checkPublishExists(options.subfolder, options.name);
            if (exists) {
                const res = await events.invoke('showPopup', {
                    type: 'okcancel',
                    header: localize('popup.publish.s3.overwrite-header'),
                    message: localize('popup.publish.s3.overwrite-message')
                });
                if (res.action === 'cancel') return;
            }

            events.fire('progressStart', localize('popup.publish.s3.publishing'));
            await new Promise<void>((resolve) => {
                setTimeout(resolve);
            });

            // browser-side PLY extraction (same path as server export)
            const serializeSettings: SerializeSettings = { ...options.serializeSettings };

            // portal multi-scene upload: when the scene has portals, the PRIMARY
            // scene is the START scene alone; each extra scene uploads its own
            // gzipped PLY + metadata for the server to assemble (mirrors writeViaServer).
            const es = options.viewerExportSettings.experienceSettings as any;
            const upload = await buildPortalUpload({
                events,
                es,
                serializeSettings,
                streaming: !!options.viewerExportSettings.streaming
            });
            const splats = upload ? [upload.startSplat] : events.invoke('scene.splats');

            const memFs = new MemoryFileSystem();
            await serializePly(splats, serializeSettings, memFs, 'scene.ply');
            const plyBytes = memFs.results.get('scene.ply');
            if (!plyBytes) {
                events.fire('progressEnd');
                await events.invoke('showPopup', { type: 'error', header: localize('popup.publish.failed'), message: localize('popup.publish.s3.nothing-to-publish') });
                return;
            }

            const plyGz = await new Response(
                new Blob([plyBytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))
            ).blob();

            const publishOptions = {
                subfolder: options.subfolder,
                name: options.name,
                public: options.public,
                overwrite: true,   // already confirmed (or didn't exist)
                serializeSettings: options.serializeSettings,
                viewerExportSettings: options.viewerExportSettings,
                ...(upload ? { portalExtras: upload.portalExtras } : {})
            };
            const result = await runServerPublish(plyGz, publishOptions, p => events.fire('progressUpdate', { text: p.message, progress: p.value }), upload?.extraPlyGz);

            events.fire('progressEnd');
            await events.invoke('showPopup', {
                type: 'info',
                header: localize('popup.publish.succeeded'),
                message: result.url ? localize('popup.publish.s3.public-message') : `${localize('popup.publish.s3.private-message')} ${result.prefix}`,
                link: result.url
            });
        } catch (error) {
            events.fire('progressEnd');
            const message = error instanceof PublishExistsError ? localize('popup.publish.s3.exists-message') : (error.message ?? String(error));
            await events.invoke('showPopup', { type: 'error', header: localize('popup.publish.failed'), message });
        }
    });
};

export { registerS3PublishEvents };
