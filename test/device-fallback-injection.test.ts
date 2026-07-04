import { describe, it, expect } from 'vitest';

import { buildDeviceFallbackInjection } from '../src/viewer-companion/device-fallback';

describe('buildDeviceFallbackInjection', () => {
    it('emits the crash-triggered WebGPU -> WebGL2 fallback runtime', () => {
        const out = buildDeviceFallbackInjection();
        expect(out).toContain('<script>');
        // sticky per-device stamp + the devicelost trigger
        expect(out).toContain("'ssViewerForceWebgl'");
        expect(out).toContain("'devicelost'");
        // reloads via the viewer's own ?webgl param; ?webgpu clears the stamp
        expect(out).toContain("'webgl'");
        expect(out).toContain('webgpu');
        expect(out).toContain('localStorage');
        // only a WebGPU device falls back (a lost WebGL context must not loop)
        expect(out).toContain("deviceType !== 'webgpu'");
    });

    it('recovers via one auto-reload then a tap-to-restart overlay (Chromium 3D-API domain block)', () => {
        const out = buildDeviceFallbackInjection();
        // Chromium blocks 3D APIs per HOSTNAME browser-wide after a GPU
        // crash, and only a user/browser-initiated reload is confirmed to
        // unblock (three_d_api_observer.cc infobar) -- JS reloads are not
        // privileged (field: 6 auto-reloads failed, one pull-to-refresh
        // worked instantly). So: one probe per page load; ONE automatic
        // reload for the merely-restarting-GPU case; then a visible overlay
        // whose tap reloads (may unblock on gesture-honoring builds) and,
        // after a failed tap, tells the user to reload via the browser.
        expect(out).toContain("getContext('webgl2')");
        expect(out).toContain("'WEBGL_lose_context'");
        expect(out).toContain("'ssViewerWebglRetry'");
        expect(out).toContain('sessionStorage');
        expect(out).toContain('location.reload()');
        // overlay with localized text (literal UTF-8, no unicode escapes);
        // the hint points at the browser-menu reload button: field-confirmed
        // that a tap-driven JS reload does NOT unblock and pull-to-refresh
        // is unavailable (the viewer canvas suppresses overscroll)
        expect(out).toContain('Tap to restart');
        expect(out).toContain('Appuyez pour redémarrer');
        expect(out).toContain('browser menu');
        // the poisoning in-page probe loop must not come back
        expect(out).not.toContain('bootTimer');
        expect(out).not.toContain('webglReady() || waited');
    });

    it('is template-cooking safe: ES5 only, no backslash escapes at all', () => {
        const out = buildDeviceFallbackInjection();
        // the companion templates cook backslash escapes at build time (the
        // residentBudget override shipped dead that way) -- forbid them outright
        expect(out).not.toMatch(/\\/);
        // stringified-runtime constraints (terser-safe ES5)
        expect(out).not.toContain('=>');
        expect(out).not.toContain('const ');
        expect(out).not.toContain('let ');
        expect(out).not.toContain('`');
    });
});
