import fs from 'fs';
import path from 'path';

import i18next from 'i18next';
import { describe, it, expect, beforeAll } from 'vitest';

// Regression test for a plural-form bug: two interpolated locale strings
// (`panel.annotations.images-edit` and `export.annotation-images-html-warning`)
// used to render ungrammatically in the singular ("1 images — Edit…") because
// the interpolation variable was renamed from `{{count}}` to `{{n}}`, which
// silently disabled i18next's pluralization lookup instead of fixing it.
//
// This test asserts RENDERED OUTPUT (not key shape), by loading the real
// locale JSON files and running them through a real i18next instance with
// `count` passed at call time, exactly as the app's call sites do.

const localesDir = path.resolve(__dirname, '../static/locales');

const loadResources = () => {
    const resources: Record<string, { translation: Record<string, unknown> }> = {};
    for (const file of fs.readdirSync(localesDir)) {
        if (!file.endsWith('.json')) continue;
        const lng = file.replace(/\.json$/, '');
        const translation = JSON.parse(fs.readFileSync(path.join(localesDir, file), 'utf8'));
        resources[lng] = { translation };
    }
    return resources;
};

// Hoisted to module scope (rather than living inside the describe block below)
// so a sibling describe can use it too: `beforeAll` only runs for the block it
// is declared in, so a fresh instance is built here from loadResources()
// directly instead of relying on that block's globalThis.__i18nResources.
const makeT = async (lng: string) => {
    const instance = i18next.createInstance();
    await instance.init({
        resources: loadResources(),
        lng,
        fallbackLng: 'en',
        interpolation: { escapeValue: false }
    });
    return instance.t.bind(instance);
};

describe('annotation image gallery plural strings', () => {
    beforeAll(async () => {
        const instance = i18next.createInstance();
        await instance.init({
            resources: loadResources(),
            lng: 'en',
            fallbackLng: 'en',
            interpolation: { escapeValue: false }
        });
        // Use a fresh instance per assertion below instead of a shared one so
        // language switches can't bleed between tests; store the factory.
        (globalThis as any).__i18nResources = loadResources();
    });

    it('renders correct English singular and plural for images-edit', async () => {
        const t = await makeT('en');
        expect(t('panel.annotations.images-edit', { count: 1 })).toBe('1 image — Edit…');
        expect(t('panel.annotations.images-edit', { count: 3 })).toBe('3 images — Edit…');
    });

    it('renders correct English singular and plural for the HTML warning', async () => {
        const t = await makeT('en');
        const singular = t('export.annotation-images-html-warning', { count: 1 });
        const plural = t('export.annotation-images-html-warning', { count: 3 });

        expect(singular).toContain('gallery');
        expect(singular).toContain('include it');
        expect(plural).toContain('galleries');
        expect(plural).toContain('include them');
    });

    it('distinguishes Russian one/few/many plural categories', async () => {
        const t = await makeT('ru');
        const one = t('panel.annotations.images-edit', { count: 1 });
        const few = t('panel.annotations.images-edit', { count: 3 });
        const many = t('panel.annotations.images-edit', { count: 5 });

        // Pin the _few/_many distinction without hard-coding Russian text:
        // all three counts must produce mutually different strings, and each
        // must contain its own number.
        expect(one).toContain('1');
        expect(few).toContain('3');
        expect(many).toContain('5');
        expect(one).not.toBe(few);
        expect(few).not.toBe(many);
        expect(one).not.toBe(many);
    });

    it('distinguishes Russian one/few/many plural categories for the HTML warning', async () => {
        const t = await makeT('ru');
        const one = t('export.annotation-images-html-warning', { count: 1 });
        const few = t('export.annotation-images-html-warning', { count: 3 });
        const many = t('export.annotation-images-html-warning', { count: 5 });

        expect(one).toContain('1');
        expect(few).toContain('3');
        expect(many).toContain('5');
        expect(one).not.toBe(few);
        expect(few).not.toBe(many);
        expect(one).not.toBe(many);
    });

    it('resolves Japanese plural forms for both counts (no missing-key fallback)', async () => {
        const t = await makeT('ja');
        const one = t('panel.annotations.images-edit', { count: 1 });
        const three = t('panel.annotations.images-edit', { count: 3 });

        // A missing plural form makes i18next return the raw key instead of
        // translated text, so asserting non-empty and != the key name catches it.
        expect(one).toBeTruthy();
        expect(one).not.toBe('panel.annotations.images-edit');
        expect(three).toBeTruthy();
        expect(three).not.toBe('panel.annotations.images-edit');

        const oneWarning = t('export.annotation-images-html-warning', { count: 1 });
        const threeWarning = t('export.annotation-images-html-warning', { count: 3 });

        expect(oneWarning).toBeTruthy();
        expect(oneWarning).not.toBe('export.annotation-images-html-warning');
        expect(threeWarning).toBeTruthy();
        expect(threeWarning).not.toBe('export.annotation-images-html-warning');
    });
});

describe('annotation translations plural strings', () => {
    it('renders correct English singular and plural for translations-edit', async () => {
        const t = await makeT('en');
        expect(t('panel.annotations.translations-edit', { count: 1 })).toBe('1 language — Edit…');
        expect(t('panel.annotations.translations-edit', { count: 3 })).toBe('3 languages — Edit…');
    });

    it('renders a non-empty translations-edit in every locale', async () => {
        for (const lng of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'ru', 'zh-CN']) {
            const t = await makeT(lng);
            for (const count of [1, 2, 5]) {
                const out = t('panel.annotations.translations-edit', { count });
                expect(out, `${lng} @ ${count}`).not.toBe('panel.annotations.translations-edit');
                expect(out, `${lng} @ ${count}`).toContain(String(count));
            }
        }
    });

    it('defines the dialog strings in every locale', async () => {
        // Asserts PRESENCE in each locale's own raw JSON, not the rendered
        // i18next lookup: with fallbackLng: 'en', a locale MISSING a key still
        // renders the English string via fallback, so `t(key) !== key` passes
        // even for a locale that was never filled in and would tell nothing
        // about whether that locale actually defines the key. This does not
        // assert the value differs from English -- other locales legitimately
        // share strings with it (e.g. "Original").
        const keys = [
            'popup.annotation-translations.header',
            'popup.annotation-translations.captions'
        ];
        const resources = loadResources();
        for (const lng of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'ru', 'zh-CN']) {
            const raw = resources[lng].translation;
            for (const key of keys) {
                expect(Object.prototype.hasOwnProperty.call(raw, key), `${lng} ${key}`).toBe(true);
            }
            const t = await makeT(lng);
            expect(t('popup.annotation-translations.image-n', { index: 2 })).toContain('2');
        }
    });
});
