import { describe, it, expect } from 'vitest';

import { buildOffLimitsZonesInjection, resolveOffLimitsMessage, DEFAULT_MESSAGES } from '../src/viewer-companion/off-limits-zones';

const zone = {
    position: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0, 1] as [number, number, number, number],
    width: 2,
    height: 2
};

describe('resolveOffLimitsMessage', () => {
    it('prefers a non-empty custom message', () => {
        expect(resolveOffLimitsMessage('Stop!', DEFAULT_MESSAGES, 'fr')).toBe('Stop!');
    });
    it('falls back to the language default', () => {
        expect(resolveOffLimitsMessage('', DEFAULT_MESSAGES, 'fr')).toBe(DEFAULT_MESSAGES.fr);
    });
    it('falls back from a region subtag to the base language', () => {
        expect(resolveOffLimitsMessage('', DEFAULT_MESSAGES, 'fr-CA')).toBe(DEFAULT_MESSAGES.fr);
    });
    it('falls back to English for unknown languages', () => {
        expect(resolveOffLimitsMessage('', DEFAULT_MESSAGES, 'xx')).toBe(DEFAULT_MESSAGES.en);
    });
});

describe('buildOffLimitsZonesInjection', () => {
    it('returns empty string when there are no zones', () => {
        expect(buildOffLimitsZonesInjection([], 'msg')).toBe('');
        expect(buildOffLimitsZonesInjection(null as any, 'msg')).toBe('');
    });

    it('embeds the payload and runtime when zones exist', () => {
        const out = buildOffLimitsZonesInjection([zone], 'Custom');
        expect(out).toContain('window.__supersplatOffLimitsZones =');
        expect(out).toContain('"width":2');
        expect(out).toContain('"message":"Custom"');
        expect(out).toContain('<style>');
        expect(out).toContain('<script>');
    });

    it('escapes angle brackets so a payload cannot break out of the script tag', () => {
        const out = buildOffLimitsZonesInjection([zone], '</script><b>x');
        expect(out).not.toContain('</script><b>x');
        expect(out).toContain('\\u003c');
    });

    // The viewer fullscreens its own root, and a fullscreen page draws only
    // that subtree: the red flash and the message follow the fullscreen
    // element, or they vanish in fullscreen.
    it('keeps the flash and the message drawn in fullscreen', () => {
        const out = buildOffLimitsZonesInjection([zone], 'msg');
        expect(out).toContain('var followFullscreen = ');
        expect(out).toContain('followFullscreen(document, function () { return [overlay, msgEl]; });');
    });

    // In XR the viewer leaves its camera manager alone and window rAF need not
    // run: the clamp must follow the headset-driven camera from the app's
    // update event, and push the rig (the camera's parent) back.
    it('blocks the headset at a wall in an XR session, from the app update event', () => {
        const out = buildOffLimitsZonesInjection([zone], 'msg');
        const scripts = [...out.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
        const el = () => ({ classList: { add() {}, remove() {} }, parentNode: null as unknown });
        const doc = { body: { appendChild() {} }, createElement: el, addEventListener() {}, fullscreenElement: null as unknown };
        const frames: (() => void)[] = [];
        const updates: (() => void)[] = [];
        const head = { x: 0, y: 0.5, z: 1 };
        const rig = { x: 3, y: 0, z: 1, getPosition: () => ({ x: rig.x, y: rig.y, z: rig.z }), setPosition(x: number, y: number, z: number) { rig.x = x; rig.y = y; rig.z = z; } };
        const camera = { parent: rig, getPosition: () => ({ ...head }) };
        const app = { xr: { active: true }, on: (name: string, fn: () => void) => name === 'update' && updates.push(fn) };
        const win: Record<string, unknown> = { __supersplatViewer: { global: { app, camera } } };
        new Function('window', 'document', 'requestAnimationFrame', scripts.join(';'))(win, doc, (fn: () => void) => frames.push(fn));

        frames.shift()(); // the rAF loop hooks the app's update event
        expect(updates.length).toBe(1);
        updates[0](); // safe, in front of the wall (the wall is the z = 0 plane)
        head.z = -0.1; // walked through it
        updates[0]();
        expect(rig.z).toBeCloseTo(2.1); // pushed back by the 1.1 m overshoot
        expect(rig.x).toBe(3);
        expect(rig.y).toBe(0);
    });

    it('prefers the spawn-preserving reseat() over snap() when clamping', () => {
        const out = buildOffLimitsZonesInjection([zone], '');
        // uses reseat() (added by the engine patch) with a snap() fallback
        expect(out).toContain("typeof cm.reseat === 'function'");
        expect(out).toContain('cm.reseat()');
        expect(out).toContain("typeof cm.snap === 'function'");
    });
});
