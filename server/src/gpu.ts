import { create, globals } from 'webgpu';
import { WebgpuGraphicsDevice } from 'playcanvas';
import type { GraphicsDevice } from 'playcanvas';

// The @playcanvas/splat-transform library does NOT export its Node device
// creator (it lives only in its CLI bundle), so we replicate it here. This
// mirrors the library's own createDevice, verified against the bundled cli
// implementation: install the Dawn (webgpu) globals, then stand up a
// browser-like `window`/`document` (PlayCanvas reads window.navigator.gpu,
// window.matchMedia and window.location during device init), build a
// WebgpuGraphicsDevice around a stub canvas, point window.navigator.gpu at a
// fresh Dawn GPU instance, and await createDevice().
//
// NOTE: we assign navigator.gpu onto the plain `window` object we create here,
// NOT onto globalThis.navigator. In modern Node, globalThis.navigator is a
// read-only getter, so assigning to it throws. The library uses window for
// exactly this reason.
const createNodeDevice = async (): Promise<GraphicsDevice> => {
    // Set up the global WebGPU objects that PlayCanvas expects.
    Object.assign(globalThis, globals);

    const win: any = {
        navigator: { userAgent: 'node.js' },
        addEventListener() {},
        removeEventListener() {},
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        location: { href: '' }
    };
    (globalThis as any).window = win;

    (globalThis as any).document = {
        createElement(type: string) {
            if (type === 'canvas') {
                return {
                    addEventListener() {},
                    removeEventListener() {},
                    getContext() {
                        return null;
                    }
                };
            }
        }
    };

    const canvas = (globalThis as any).document.createElement('canvas');
    const device = new WebgpuGraphicsDevice(canvas as any, { antialias: false });
    win.navigator.gpu = create([]);
    await (device as any).createDevice();
    return device as unknown as GraphicsDevice;
};

// Tear down a device created by createNodeDevice. The native Dawn (webgpu)
// binding runs a busy-poll loop for as long as a device is alive, pinning a CPU
// core even when completely idle, so every device we create MUST be destroyed
// once its work is done. Destroying the PlayCanvas wrapper and its underlying
// wgpu device stops that poll. Best-effort: never let teardown throw.
const destroyDevice = (device: GraphicsDevice): void => {
    try {
        const wgpu = (device as any).wgpu;
        (device as any).destroy?.();
        wgpu?.destroy?.();
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('GPU device teardown failed:', err);
    }
};

export type GpuSession = {
    // Hand this to runExport as `getDeviceCreator`. The first call stands up a
    // device; later calls within the same session reuse it (one device per job).
    getDeviceCreator: () => (() => Promise<GraphicsDevice>);
    // Destroy the session's device if one was created. Safe to call when no
    // device was ever requested (CPU-only jobs) or when device init failed.
    dispose: () => Promise<void>;
};

// A GPU session owns exactly one device for the lifetime of a single export job.
// We deliberately do NOT keep a long-lived shared device: Dawn busy-polls a CPU
// core while any device is alive, so a cached "warm" device would pin a core for
// the entire server lifetime even while idle. Instead each job gets a fresh
// device that is destroyed when the job ends. `makeDevice` is injectable so the
// lifecycle can be tested without a real GPU.
export const createGpuSession = (makeDevice: () => Promise<GraphicsDevice> = createNodeDevice): GpuSession => {
    // The in-flight promise (not the resolved device) is cached so repeated
    // creator calls within one job share a single init instead of racing.
    let devicePromise: Promise<GraphicsDevice> | null = null;
    return {
        getDeviceCreator: () => () => (devicePromise ??= makeDevice()),
        dispose: async () => {
            if (!devicePromise) return;
            const pending = devicePromise;
            devicePromise = null;
            try {
                destroyDevice(await pending);
            } catch {
                // device init rejected; there is nothing to tear down.
            }
        }
    };
};

let probed: { gpu: boolean } | null = null;

// Probe once at startup to advertise GPU capability. We create a device to prove
// Dawn works, then immediately destroy it — keeping it alive would pin a CPU core
// for the whole server lifetime (see createGpuSession). Each export job stands up
// its own short-lived device via createGpuSession instead.
export const probeGpu = async (): Promise<{ gpu: boolean }> => {
    if (probed) return probed;
    try {
        const device = await createNodeDevice();
        destroyDevice(device);
        probed = { gpu: true };
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('GPU device init failed; GPU formats unavailable:', err);
        probed = { gpu: false };
    }
    return probed;
};
