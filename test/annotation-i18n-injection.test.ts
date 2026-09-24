import { describe, it, expect } from 'vitest';

import {
    applyAnnotationTranslation,
    buildAnnotationI18nInjection,
    hasAnnotationTranslations
} from '../src/viewer-companion/annotation-i18n';

const translated = () => ({
    title: 'Facade',
    text: 'Built in 1890',
    extras: {
        url: 'https://example.com/en',
        images: [
            { src: 'annotations/annimg_0.jpg', caption: 'North wall' },
            { src: 'annotations/annimg_1.jpg', caption: 'Entrance' }
        ],
        i18n: {
            fr: {
                title: 'Façade',
                text: 'Construite en 1890',
                url: 'https://example.com/fr',
                captions: ['Mur nord']
            },
            de: { title: 'Fassade' }
        }
    }
});

describe('hasAnnotationTranslations', () => {
    it('is false without translations', () => {
        expect(hasAnnotationTranslations([{ title: 'T', extras: {} }])).toBe(false);
        expect(hasAnnotationTranslations([])).toBe(false);
        expect(hasAnnotationTranslations(null as any)).toBe(false);
    });

    it('is true when any annotation carries a non-empty i18n map', () => {
        expect(hasAnnotationTranslations([{ title: 'T', extras: {} }, translated()])).toBe(true);
    });

    it('is false for an i18n map with no languages', () => {
        expect(hasAnnotationTranslations([{ title: 'T', extras: { i18n: {} } }])).toBe(false);
    });
});

describe('applyAnnotationTranslation', () => {
    it('overwrites title, text, url and captions in place', () => {
        const ann = translated();
        applyAnnotationTranslation(ann, 'fr');
        expect(ann.title).toBe('Façade');
        expect(ann.text).toBe('Construite en 1890');
        expect(ann.extras.url).toBe('https://example.com/fr');
        expect(ann.extras.images[0].caption).toBe('Mur nord');
    });

    it('falls back per field, not per language', () => {
        const ann = translated();
        applyAnnotationTranslation(ann, 'de');
        expect(ann.title).toBe('Fassade');
        expect(ann.text).toBe('Built in 1890');
        expect(ann.extras.url).toBe('https://example.com/en');
        expect(ann.extras.images[0].caption).toBe('North wall');
    });

    it('leaves everything alone for an untranslated language', () => {
        const ann = translated();
        applyAnnotationTranslation(ann, 'ja');
        expect(ann.title).toBe('Facade');
        expect(ann.extras.images[0].caption).toBe('North wall');
    });

    it('leaves captions past the end of the array alone', () => {
        const ann = translated();
        applyAnnotationTranslation(ann, 'fr');
        expect(ann.extras.images[1].caption).toBe('Entrance');
    });

    it('ignores an annotation with no extras', () => {
        const ann: any = { title: 'T', text: 'X' };
        expect(() => applyAnnotationTranslation(ann, 'fr')).not.toThrow();
        expect(ann.title).toBe('T');
    });
});

const extractScripts = (injection: string): string[] => {
    const out: string[] = [];
    let from = 0;
    for (;;) {
        const open = injection.indexOf('<script>', from);
        if (open === -1) break;
        const close = injection.indexOf('</script>', open);
        out.push(injection.slice(open + '<script>'.length, close));
        from = close + 1;
    }
    return out;
};

describe('buildAnnotationI18nInjection', () => {
    it('is empty when no annotation is translated', () => {
        expect(buildAnnotationI18nInjection([{ title: 'T', extras: {} }])).toBe('');
    });

    it('emits the runtime and no language resolver of its own', () => {
        // The resolver is injected once per export by injectViewerLang; see
        // test/viewer-lang.test.ts.
        const injection = buildAnnotationI18nInjection([translated()]);
        expect(injection).not.toContain('window.__ssLang =');
        expect(injection).toContain('__ssOnViewer');
    });

    it('constructs every script via new Function without throwing', () => {
        // Catches syntax-level breakage in the stringified helpers and the IIFE
        // template -- the failure mode a backtick or a `${` inside the template
        // produces.
        const scripts = extractScripts(buildAnnotationI18nInjection([translated()]));
        expect(scripts.length).toBeGreaterThan(0);
        // eslint-disable-next-line no-new-func
        scripts.forEach(s => expect(() => new Function(s)).not.toThrow());
    });

    it('leaves no cooked-escape remnants', () => {
        const injection = buildAnnotationI18nInjection([translated()]);
        expect(injection).not.toContain('(d+)');
        expect(injection).not.toContain('u003cscript');
    });

    it('contains no backslash escapes at all (this companion is baked into every export)', () => {
        // General guard, not just the two historical artifacts above: this
        // companion lives in src/viewer-companion/, where template literals
        // have their backslash escapes eaten at build time, so ANY backslash
        // surviving the build (e.g. a regex literal cooked from \d to d) ships
        // broken. Do not narrow this back to a specific substring.
        expect(buildAnnotationI18nInjection([translated()])).not.toMatch(/\\/);
    });

    it('contains no template-literal backticks (would truncate the outer template)', () => {
        expect(buildAnnotationI18nInjection([translated()])).not.toContain('`');
    });

    it('translates the settings annotations from the pre-UI viewer hook', () => {
        const runtime = extractScripts(buildAnnotationI18nInjection([translated()])).pop();
        const ann = translated();
        const viewer = { global: { settings: { annotations: [ann] } } };
        const win: any = { __ssLang: 'fr' };
        // no document parameter: the runtime must not touch the DOM at all
        // eslint-disable-next-line no-new-func
        new Function('window', runtime)(win);
        expect(typeof win.__ssOnViewer).toBe('function');

        win.__ssOnViewer(viewer);
        expect(ann.title).toBe('Façade');
        expect(ann.text).toBe('Construite en 1890');
        expect(ann.extras.url).toBe('https://example.com/fr');
    });

    it('chains a hook installed before it', () => {
        const runtime = extractScripts(buildAnnotationI18nInjection([translated()])).pop();
        const calls: string[] = [];
        const win: any = { __ssLang: 'fr', __ssOnViewer: () => calls.push('earlier') };
        // eslint-disable-next-line no-new-func
        new Function('window', runtime)(win);
        win.__ssOnViewer({ global: { settings: { annotations: [] } } });
        expect(calls).toEqual(['earlier']);
    });

    it('tolerates a viewer with no annotations', () => {
        const runtime = extractScripts(buildAnnotationI18nInjection([translated()])).pop();
        const win: any = { __ssLang: 'fr' };
        // eslint-disable-next-line no-new-func
        new Function('window', runtime)(win);
        expect(() => win.__ssOnViewer({ global: { settings: {} } })).not.toThrow();
        expect(() => win.__ssOnViewer(null)).not.toThrow();
    });
});
