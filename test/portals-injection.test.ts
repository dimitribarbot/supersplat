import { describe, it, expect } from 'vitest';

import { buildPortalsInjection } from '../src/viewer-companion/portals';

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
            portalEnvironments: ['indoor', 'indoor']
        });
        expect(out).toContain('window.__supersplatPortals');
        expect(out).toContain('scenes/1/scene.sog');
        expect(out).toContain('<script>');
        // payload is HTML-escaped (no raw </script> break-out)
        expect(out).not.toContain('</script>'.replace('>', '>') + 'window');
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
