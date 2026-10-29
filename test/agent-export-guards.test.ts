import { BoundingBox, Entity, Mat4 } from 'playcanvas';
import { describe, it, expect, vi } from 'vitest';

import { CommandQueue } from '../src/command-queue';
import { EditHistory } from '../src/edit-history';
import { createEditorAPI } from '../src/editor-api';
import { Events } from '../src/events';
import { GaussianInstances } from '../src/gaussian-instances';

// The portal check reads the experience settings buildExportOptions produces;
// stub it so the test controls whether the export is a portal walkthrough.
const exportOptions = vi.hoisted(() => ({ portalScenes: undefined as string[] | undefined }));
vi.mock('../src/export-options', () => ({
    buildExportOptions: () => ({
        filename: 'out.html',
        splatIdx: 'all',
        serializeSettings: {},
        viewerExportSettings: { type: 'html', experienceSettings: { portalScenes: exportOptions.portalScenes } }
    })
}));

// Same fakes as upstream's test/editor-commands.mjs: real instance mutators,
// inert GPU uploads.
const setup = (exporting = false) => {
    const events = new Events();
    const queue = new CommandQueue();
    const history = new EditHistory(events, queue);
    const device = {
        buffers: new Set(),
        _vram: { sb: 0 },
        createBufferImpl: () => ({ allocate() {}, write() {}, destroy() {} })
    };
    const layers: any[] = [];
    const scene: any = { getElementsByType: () => layers, camera: { fov: 60 } };
    for (let uid = 0; uid < 2; uid++) {
        layers.push({
            uid, scene, visible: true, name: `layer-${uid}`,
            resource: { numRows: 3, shBands: 0 },
            entity: new Entity(), worldBound: new BoundingBox(), selectionBound: new BoundingBox(), worldTransform: new Mat4(),
            instances: new GaussianInstances(device as any, 3),
            async updateState() {
                this.instances.flush();
                events.fire('splat.stateChanged', this);
            }
        });
    }
    events.function('selection', () => layers[0]);
    events.function('scene.exporting', () => exporting);
    events.function('bgClr', () => ({ r: 0, g: 0, b: 0 }));
    const write = vi.fn(async () => true);
    events.function('scene.write', write);
    const api = createEditorAPI(events, scene, history, queue);
    return { api, layers, write };
};

describe('agent commands during an export', () => {
    it('deletes the selection when no export is running', async () => {
        const { api, layers } = setup(false);
        await api.selection.all(0);
        const result = await api.selection.delete(0);
        expect(result.affected).toBe(3);
        expect(layers[0].instances.numRemoved).toBe(3);
    });

    it('refuses to delete while an export is running', async () => {
        const { api, layers } = setup(true);
        await api.selection.all(0);
        await expect(api.selection.delete(0)).rejects.toMatchObject({ code: 'busy' });
        expect(layers[0].instances.numRemoved).toBe(0);
        // the queue stays usable
        await expect(api.selection.none(0)).resolves.toBeDefined();
    });
});

describe('agent viewer export of a portal walkthrough', () => {
    it('rejects a layer- or selection-scoped viewer export', async () => {
        exportOptions.portalScenes = ['', 'scenes/1/meta.json'];
        try {
            const { api, write } = setup();
            await api.selection.all(0);
            for (const scope of ['layer', 'selection'] as const) {
                await expect(api.files.export({ filename: 'out.html', format: 'viewer-html', scope, layer: 0 } as any))
                .rejects.toMatchObject({ code: 'unsupported_scope' });
            }
            expect(write).not.toHaveBeenCalled();
        } finally {
            exportOptions.portalScenes = undefined;
        }
    });

    it('exports the whole walkthrough for scope visible_layers', async () => {
        exportOptions.portalScenes = ['', 'scenes/1/meta.json'];
        try {
            const { api, write } = setup();
            await api.files.export({ filename: 'out.html', format: 'viewer-html', scope: 'visible_layers' } as any);
            expect(write).toHaveBeenCalledTimes(1);
        } finally {
            exportOptions.portalScenes = undefined;
        }
    });

    it('still honours a layer scope without portals', async () => {
        const { api, write } = setup();
        await api.files.export({ filename: 'out.html', format: 'viewer-html', scope: 'layer', layer: 1 } as any);
        expect(write).toHaveBeenCalledTimes(1);
    });
});
