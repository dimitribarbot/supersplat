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

let probed: { gpu: boolean } | null = null;

// Cache the in-flight promise (not the resolved device) so concurrent callers
// share a single device init instead of racing to create two GPU devices.
let devicePromise: Promise<GraphicsDevice> | null = null;
const getDevice = (): Promise<GraphicsDevice> => (devicePromise ??= createNodeDevice());

// Probe once at startup. Uses the Dawn (webgpu) package via createNodeDevice.
export const probeGpu = async (): Promise<{ gpu: boolean }> => {
    if (probed) return probed;
    try {
        await getDevice();
        probed = { gpu: true };
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('GPU device init failed; GPU formats unavailable:', err);
        probed = { gpu: false };
    }
    return probed;
};

// Shared device creator handed to the writers. Reuses the single cached device.
// Assumes probeGpu() succeeded first (the server only routes GPU formats here
// when capabilities reported gpu:true), but is safe to call directly: it shares
// the same cached init promise and surfaces any init error to the caller.
export const getDeviceCreator = (): (() => Promise<GraphicsDevice>) => () => getDevice();
