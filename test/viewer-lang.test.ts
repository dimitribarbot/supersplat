import { describe, it, expect } from 'vitest';

import { buildAnnotationI18nInjection } from '../src/viewer-companion/annotation-i18n';
import { buildAnnotationLinksInjection } from '../src/viewer-companion/annotation-links';
import { buildDeviceFallbackInjection } from '../src/viewer-companion/device-fallback';
import { buildIframeApiInjection } from '../src/viewer-companion/iframe-api';
import { buildOffLimitsZonesInjection } from '../src/viewer-companion/off-limits-zones';
import { buildPortalsInjection } from '../src/viewer-companion/portals';
import { buildQualityModeInjection } from '../src/viewer-companion/quality-mode';
import { resolveLocale, VIEWER_LOCALES, viewerLangRuntime } from '../src/viewer-companion/viewer-lang';
import { i18n } from '../src/ui/localization';

// Execute the injected snippet with window/navigator/URL passed as parameters,
// which shadow the globals of the same name inside the function body. This runs
// the string the exporter actually emits rather than a re-implementation.
const runSnippet = (href: string, languages: string[]): string => {
    const win: any = { location: { href } };
    const nav: any = { languages };
    // eslint-disable-next-line no-new-func
    new Function('window', 'navigator', 'URL', viewerLangRuntime)(win, nav, URL);
    return win.__ssLang;
};

describe('resolveLocale', () => {
    it('matches an exact tag, case-insensitively', () => {
        expect(resolveLocale(['pt-br'], VIEWER_LOCALES)).toBe('pt-BR');
        expect(resolveLocale(['DE'], VIEWER_LOCALES)).toBe('de');
        expect(resolveLocale(['zh-CN'], VIEWER_LOCALES)).toBe('zh-CN');
    });

    it('falls back to the base subtag', () => {
        expect(resolveLocale(['fr-CA'], VIEWER_LOCALES)).toBe('fr');
        expect(resolveLocale(['en-GB'], VIEWER_LOCALES)).toBe('en');
    });

    it('falls back to any region variant sharing the base', () => {
        expect(resolveLocale(['pt'], VIEWER_LOCALES)).toBe('pt-BR');
        expect(resolveLocale(['pt-PT'], VIEWER_LOCALES)).toBe('pt-BR');
        expect(resolveLocale(['zh'], VIEWER_LOCALES)).toBe('zh-CN');
        expect(resolveLocale(['zh-TW'], VIEWER_LOCALES)).toBe('zh-CN');
    });

    it('takes the first candidate that matches anything', () => {
        expect(resolveLocale(['xx', 'ja'], VIEWER_LOCALES)).toBe('ja');
    });

    it('skips empty candidates', () => {
        expect(resolveLocale([null as any, '', 'ko'], VIEWER_LOCALES)).toBe('ko');
    });

    it('falls back to english', () => {
        expect(resolveLocale(['xx'], VIEWER_LOCALES)).toBe('en');
        expect(resolveLocale([], VIEWER_LOCALES)).toBe('en');
        expect(resolveLocale(null as any, VIEWER_LOCALES)).toBe('en');
    });

    it('offers exactly the nine editor locales', () => {
        expect(VIEWER_LOCALES).toEqual(['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'ru', 'zh-CN']);
    });

    it('matches the editor language selector exactly (src/ui/localization.ts)', () => {
        // Guards the third unenforced copy of the locale set: if a language is
        // added to i18n.languages without a matching VIEWER_LOCALES update,
        // sanitizeTranslations (src/annotations.ts) silently drops that
        // language's translations on the next project load.
        expect(i18n.languages.map(l => l.code)).toEqual(VIEWER_LOCALES);
    });
});

describe('viewerLangRuntime', () => {
    it('constructs via new Function without throwing', () => {
        // Construction (not execution) catches syntax-level breakage in the
        // stringified helper and the IIFE template.
        // eslint-disable-next-line no-new-func
        expect(() => new Function(viewerLangRuntime)).not.toThrow();
    });

    it('survives the template build with no cooked-escape remnants', () => {
        expect(viewerLangRuntime).toContain("searchParams.get('lang')");
        expect(viewerLangRuntime).not.toContain('(d+)');
        expect(viewerLangRuntime).not.toContain('u003c');
    });

    it('contains no backslash escapes at all (this runtime is baked into every export)', () => {
        // General guard, not just the two historical artifacts above: this
        // string is prepended into all five standalone companion injections,
        // so ANY backslash surviving the template build (e.g. a regex literal
        // cooked from \d to d) silently ships broken into effectively every
        // export. Do not narrow this back to a specific substring.
        expect(viewerLangRuntime).not.toMatch(/\\/);
    });

    it('contains no template-literal backticks (would truncate the outer template)', () => {
        expect(viewerLangRuntime).not.toContain('`');
    });

    it('prefers ?lang= over the browser languages', () => {
        expect(runSnippet('https://x/?lang=fr', ['de-AT', 'en'])).toBe('fr');
    });

    it('uses the browser languages when ?lang= is absent', () => {
        expect(runSnippet('https://x/', ['de-AT', 'en'])).toBe('de');
    });

    it('falls through an unmatched ?lang= to the browser languages', () => {
        expect(runSnippet('https://x/?lang=xx', ['ja'])).toBe('ja');
    });

    it('sets the language only once', () => {
        const win: any = { location: { href: 'https://x/?lang=fr' }, __ssLang: 'ru' };
        const nav: any = { languages: ['ja'] };
        // eslint-disable-next-line no-new-func
        new Function('window', 'navigator', 'URL', viewerLangRuntime)(win, nav, URL);
        expect(win.__ssLang).toBe('ru');
    });
});

describe('companions share one language resolver', () => {
    const linkAnnotation = { title: 'T', text: 'X', extras: { url: 'https://example.com' } };
    const zone = {
        position: [0, 0, 0] as [number, number, number],
        rotation: [0, 0, 0, 1] as [number, number, number, number],
        width: 1,
        height: 1
    };
    const translatedAnnotation = { title: 'T', extras: { i18n: { fr: { title: 'Titre' } } } };
    const portalViewerSettings = {
        portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 1, height: 1, front: 0, back: 1 }]
    };

    const injections: [string, string][] = [
        ['annotation-links', buildAnnotationLinksInjection([linkAnnotation])],
        ['off-limits-zones', buildOffLimitsZonesInjection([zone], '')],
        ['device-fallback', buildDeviceFallbackInjection()],
        ['quality-mode', buildQualityModeInjection()],
        ['portals', buildPortalsInjection(portalViewerSettings)],
        ['iframe-api', buildIframeApiInjection([linkAnnotation])],
        ['annotation-i18n', buildAnnotationI18nInjection([translatedAnnotation])]
    ];

    it.each(injections)('%s publishes window.__ssLang', (_name, injection) => {
        expect(injection).toContain('window.__ssLang =');
    });

    it.each(injections)('%s reads no navigator.language of its own', (_name, injection) => {
        // The label tables stay keyed by primary subtag; only the SOURCE of the
        // language changes. A remaining navigator.language read means one
        // surface would ignore ?lang=.
        expect(injection).not.toContain('navigator.language ||');
    });
});
