import { describe, it, expect, vi } from 'vitest';
import { createGpuSession } from '../src/gpu.js';

// A stand-in for the PlayCanvas device that createNodeDevice returns. The real
// thing wraps a Dawn (webgpu) device that busy-polls a CPU core while alive, so
// the only behaviour we assert here is that the session tears it down.
const makeFakeDevice = () => ({ destroy: vi.fn(), wgpu: { destroy: vi.fn() } });

describe('createGpuSession', () => {
    it('never creates a device if the creator is not invoked (CPU-only job), and dispose is a no-op', async () => {
        const makeDevice = vi.fn(async () => makeFakeDevice());
        const session = createGpuSession(makeDevice);
        await session.dispose();
        expect(makeDevice).not.toHaveBeenCalled();
    });

    it('creates exactly one device per session and reuses it across calls', async () => {
        const dev = makeFakeDevice();
        const makeDevice = vi.fn(async () => dev);
        const session = createGpuSession(makeDevice);
        const create = session.getDeviceCreator();
        const a = await create();
        const b = await create();
        expect(a).toBe(dev);
        expect(b).toBe(dev);
        expect(makeDevice).toHaveBeenCalledTimes(1);
    });

    it('destroys the device (and its underlying wgpu device) on dispose', async () => {
        const dev = makeFakeDevice();
        const session = createGpuSession(async () => dev);
        await session.getDeviceCreator()();
        await session.dispose();
        expect(dev.destroy).toHaveBeenCalledTimes(1);
        expect(dev.wgpu.destroy).toHaveBeenCalledTimes(1);
    });

    it('dispose tolerates a device whose init rejected', async () => {
        const session = createGpuSession(async () => { throw new Error('no gpu'); });
        await expect(session.getDeviceCreator()()).rejects.toThrow('no gpu');
        await expect(session.dispose()).resolves.toBeUndefined();
    });
});
