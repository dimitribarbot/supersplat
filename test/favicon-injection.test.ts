import { describe, it, expect } from 'vitest';

import { faviconLinkTag } from '../src/viewer-companion/favicon';

describe('faviconLinkTag', () => {
    it('builds the icon link with its type', () => {
        expect(faviconLinkTag('./brand-icon.png', 'image/png')).toBe('<link rel="icon" type="image/png" href="./brand-icon.png">');
    });

    it('omits the type attribute when the mime is unknown (hotlinked icon)', () => {
        expect(faviconLinkTag('https://cdn.example/client/icon.png')).toBe('<link rel="icon" href="https://cdn.example/client/icon.png">');
    });

    it('escapes the href', () => {
        expect(faviconLinkTag('https://cdn.example/i.png?a=1&b="x"')).toContain('href="https://cdn.example/i.png?a=1&amp;b=&quot;x&quot;"');
    });
});
