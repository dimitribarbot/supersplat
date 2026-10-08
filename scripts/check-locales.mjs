/**
 * Locale consistency check.
 *
 * Verifies every translation in static/locales has exactly the same keys in the
 * same order as the English reference (en.json, the i18next fallback language).
 * Reports any key that is:
 *   - missing from a translation (the UI would silently fall back to English), or
 *   - stale (present in a translation but no longer in en.json), or
 *   - out of order (locale files use a shared component/UI layout).
 *
 * Plural keys (i18next `key_one`, `key_other`, ...) are the exception: a key is
 * plural when en.json has `<key>_other`, and each translation must then carry
 * exactly the plural forms its own language uses (Intl.PluralRules), e.g. ja
 * only `_other`, ru `_one`/`_few`/`_many`/`_other`. A plural group is ordered
 * as one key; the order of its forms is not checked.
 *
 * This is a pure JSON key comparison — it does not scan source, so it has no
 * false positives and needs no dependencies. It deliberately does NOT check for
 * unused or undefined keys, since that requires resolving dynamic localize()
 * call sites and is not worth the complexity. Run via `npm run lint:locales`.
 */

import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const localesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'static', 'locales');
const referenceFile = 'en.json';

const keysOf = file => Object.keys(JSON.parse(readFileSync(join(localesDir, file), 'utf8')));

const referenceKeys = keysOf(referenceFile);
const localeFiles = readdirSync(localesDir).filter(f => f.endsWith('.json') && f !== referenceFile);

// i18next plural keys: `<base>_<category>`, a plural group whenever en.json has `<base>_other`
const pluralSuffix = /^(.*)_(zero|one|two|few|many|other)$/;
const pluralBases = new Set(referenceKeys.map(k => k.match(pluralSuffix)).filter(m => m && m[2] === 'other').map(m => m[1]));
const baseOf = (key) => {
    const match = key.match(pluralSuffix);
    return match && pluralBases.has(match[1]) ? match[1] : key;
};

// keys in order, with each plural group collapsed to its base
const groupsOf = keys => keys.map(baseOf).filter((base, index, bases) => index === 0 || base !== bases[index - 1]);
const referenceGroups = groupsOf(referenceKeys);

let failed = false;

for (const file of localeFiles) {
    const categories = new Intl.PluralRules(file.replace(/\.json$/, '')).resolvedOptions().pluralCategories;
    const expectedKeys = referenceGroups.flatMap(k => (pluralBases.has(k) ? categories.map(c => `${k}_${c}`) : [k]));
    const expectedKeySet = new Set(expectedKeys);
    const keys = keysOf(file);
    const keySet = new Set(keys);
    const missing = expectedKeys.filter(k => !keySet.has(k));
    const stale = keys.filter(k => !expectedKeySet.has(k));
    const groups = groupsOf(keys);
    const orderMismatch = missing.length === 0 && stale.length === 0 ?
        groups.findIndex((key, index) => key !== referenceGroups[index]) : -1;

    if (missing.length || stale.length || orderMismatch !== -1) {
        failed = true;
        console.error(`\n${file}:`);
        missing.forEach(k => console.error(`  missing (untranslated): ${k}`));
        stale.forEach(k => console.error(`  stale (not in ${referenceFile}): ${k}`));
        if (orderMismatch !== -1) {
            console.error(`  out of order at key ${orderMismatch + 1}: expected ${referenceGroups[orderMismatch]}, found ${groups[orderMismatch]}`);
        }
    }
}

if (failed) {
    console.error(`\n✖ Locale check failed. Update static/locales so every language has the same keys as ${referenceFile}.`);
    process.exit(1);
}

console.log(`✔ All ${localeFiles.length} locales are in sync with ${referenceFile} (${referenceKeys.length} keys).`);
