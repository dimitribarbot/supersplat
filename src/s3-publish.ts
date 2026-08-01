import { MemoryFileSystem } from '@playcanvas/splat-transform';

import { Events } from './events';
import { checkPublishExists, PublishExistsError, runServerPublish } from './export-server-client';
import { buildPortalUpload } from './portal-upload';
import { firstWalkthroughPose } from './poster-pose';
import { serializePly, SerializeSettings } from './splat-serialize';
import { i18n } from './ui/localization';
import type { S3PublishOptions } from './ui/s3-publish-dialog';

const registerS3PublishEvents = (events: Events) => {
    events.function('scene.publishS3', async (options: S3PublishOptions) => {
        try {
            // overwrite check
            const { exists } = await checkPublishExists(options.subfolder, options.name);
            if (exists) {
                const res = await events.invoke('showPopup', {
                    type: 'okcancel',
                    header: i18n.t('popup.publish.s3.overwrite-header'),
                    message: i18n.t('popup.publish.s3.overwrite-message')
                });
                if (res.action === 'cancel') return;
            }

            events.fire('progressStart', i18n.t('popup.publish.s3.publishing'));
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
                await events.invoke('showPopup', { type: 'error', header: i18n.t('popup.publish.failed'), message: i18n.t('popup.publish.s3.nothing-to-publish') });
                return;
            }

            const plyGz = await new Response(
                new Blob([plyBytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))
            ).blob();

            // Load-time poster against the publish background: the walkthrough's
            // first frame when an animation is included (matches what the viewer
            // opens on), else the current view (== published start pose). Travels
            // as its own multipart part (never inside the JSON options).
            const bg = (es?.background?.color ?? [0, 0, 0]) as [number, number, number];
            const pose = firstWalkthroughPose(es);
            const posterBytes = await events.invoke('render.poster', 1920, 1080, bg, pose) as Uint8Array | null;

            const annotationImages = options.viewerExportSettings.annotationImages;
            const publishOptions = {
                subfolder: options.subfolder,
                name: options.name,
                public: options.public,
                overwrite: true,   // already confirmed (or didn't exist)
                serializeSettings: options.serializeSettings,
                // S3PublishOptions.viewerExportSettings never carries poster or
                // image bytes (they travel as their own multipart parts below)
                viewerExportSettings: { ...options.viewerExportSettings, annotationImages: undefined as { path: string; data: Uint8Array }[] | undefined },
                ...(upload ? { portalExtras: upload.portalExtras } : {})
            };
            const result = await runServerPublish(
                plyGz,
                publishOptions,
                p => events.fire('progressUpdate', { text: p.message, progress: p.value, loc: p.loc }),
                upload?.extraPlyGz,
                posterBytes ? new Blob([posterBytes as BlobPart], { type: 'image/jpeg' }) : undefined,
                (annotationImages ?? []).map(img => ({ name: img.path.replace(/^annotations\//, ''), data: img.data }))
            );

            events.fire('progressEnd');
            await events.invoke('showPopup', {
                type: 'info',
                header: i18n.t('popup.publish.succeeded'),
                message: result.url ? i18n.t('popup.publish.s3.public-message') : `${i18n.t('popup.publish.s3.private-message')} ${result.prefix}`,
                link: result.url
            });
        } catch (error) {
            events.fire('progressEnd');
            const message = error instanceof PublishExistsError ? i18n.t('popup.publish.s3.exists-message') : (error.message ?? String(error));
            await events.invoke('showPopup', { type: 'error', header: i18n.t('popup.publish.failed'), message });
        }
    });
};

export { registerS3PublishEvents };
