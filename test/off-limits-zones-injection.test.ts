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
});
