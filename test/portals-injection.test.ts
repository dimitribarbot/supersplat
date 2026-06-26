import { describe, it, expect } from 'vitest';

import { buildPortalsInjection, resolveLoadingMessage, DEFAULT_MESSAGES } from '../src/viewer-companion/portals';

describe('resolveLoadingMessage', () => {
    it('prefers a non-empty custom message', () => {
        expect(resolveLoadingMessage('Wait!', DEFAULT_MESSAGES, 'fr')).toBe('Wait!');
    });
    it('falls back to the language default', () => {
        expect(resolveLoadingMessage('', DEFAULT_MESSAGES, 'fr')).toBe(DEFAULT_MESSAGES.fr);
    });
    it('falls back from a region subtag to the base language', () => {
        expect(resolveLoadingMessage('', DEFAULT_MESSAGES, 'fr-CA')).toBe(DEFAULT_MESSAGES.fr);
    });
    it('falls back to English for unknown languages', () => {
        expect(resolveLoadingMessage('', DEFAULT_MESSAGES, 'xx')).toBe(DEFAULT_MESSAGES.en);
    });
    it('provides non-empty defaults for every language', () => {
        Object.values(DEFAULT_MESSAGES).forEach(v => expect(v.length).toBeGreaterThan(0));
    });
    it('handles a null/undefined language by falling back to English', () => {
        expect(resolveLoadingMessage('', DEFAULT_MESSAGES, null as any)).toBe(DEFAULT_MESSAGES.en);
        expect(resolveLoadingMessage('', DEFAULT_MESSAGES, undefined as any)).toBe(DEFAULT_MESSAGES.en);
    });
});

describe('buildPortalsInjection', () => {
    it('returns empty string when there are no portals', () => {
        expect(buildPortalsInjection({})).toBe('');
        expect(buildPortalsInjection({ portals: [] })).toBe('');
    });

    it('emits the payload global and a runtime script when portals exist', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/scene.sog'],
            portalStart: 0,
            portalCollision: [],
            portalEnvironments: ['indoor', 'indoor'],
            portalSceneLodCounts: [[1000000, 250000, 62500], [800000, 200000]]
        });
        expect(out).toContain('window.__supersplatPortals');
        expect(out).toContain('scenes/1/scene.sog');
        expect(out).toContain('<script>');
        expect(out).toContain('<style>');
        expect(out.indexOf('<style>')).toBeLessThan(out.indexOf('window.__supersplatPortals'));
        expect(out).toContain('ss-portal-loading-backdrop');
        expect(out).toContain('ss-portal-spin'); // spinner keyframes present
        expect(out).toContain('loadingDefaults');
        // payload is HTML-escaped (no raw </script> break-out)
        expect(out).not.toContain('</script>'.replace('>', '>') + 'window');
        expect(out).toContain('portalSceneLodCounts');
        expect(out).toContain('62500');
    });

    it('escapes angle brackets so a payload cannot break out of the script tag', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['</script><b>inject', 'scenes/1/scene.sog'],
            portalStart: 0,
            portalCollision: [],
            portalEnvironments: ['indoor', 'indoor']
        });
        expect(out).not.toContain('</script><b>inject');
        expect(out).toContain('\\u003c');
    });
});
