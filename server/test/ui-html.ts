// Copy of test/ui-html.ts (the server suite does not import root tests).
// Renders index.js's `var uiHtml = …;` the way the browser would, given the
// fragments the brand runtime script left in window.__brandUi (null: none, so
// every surface keeps its stock markup). The brand override turns that
// initializer into string literals joined by `+` around
// `__brandPart("key","stock")` calls (see src/viewer-companion/brand.ts); this
// walks those tokens and decodes each literal with JSON.parse, so nothing from
// the bundle is ever executed.

const BACKSLASH = String.fromCharCode(92);
const DECL = 'var uiHtml = ';
const PART = '__brandPart(';

// Decodes the double-quoted literal starting at `i`; returns it and the index
// just past its closing quote.
const readLiteral = (js: string, i: number): [string, number] => {
    if (js[i] !== '"') {
        throw new Error(`expected a string literal in uiHtml at ${i}: ${js.slice(i, i + 20)}`);
    }
    let j = i + 1;
    while (js[j] !== '"') {
        j += js[j] === BACKSLASH ? 2 : 1;
    }
    return [JSON.parse(js.slice(i, j + 1)) as string, j + 1];
};

export const renderUiHtml = (js: string, ui: Record<string, string> | null = null): string => {
    const start = js.indexOf(DECL);
    if (start < 0) {
        throw new Error('no `var uiHtml = ` in index.js');
    }
    let i = start + DECL.length;
    let out = '';
    for (;;) {
        while (js[i] === ' ' || js[i] === '+') {
            i++;
        }
        if (js[i] === '"') {
            const [text, next] = readLiteral(js, i);
            out += text;
            i = next;
        } else if (js.startsWith(PART, i)) {
            const [key, afterKey] = readLiteral(js, i + PART.length);
            if (js[afterKey] !== ',') {
                throw new Error(`expected , in __brandPart at ${afterKey}`);
            }
            const [stock, afterStock] = readLiteral(js, afterKey + 1);
            if (js[afterStock] !== ')') {
                throw new Error(`expected ) in __brandPart at ${afterStock}`);
            }
            // same semantics as the injected __brandPart
            out += ui && typeof ui[key] === 'string' ? ui[key] : stock;
            i = afterStock + 1;
        } else if (js[i] === ';') {
            return out;
        } else {
            throw new Error(`unexpected token in uiHtml at ${i}: ${js.slice(i, i + 20)}`);
        }
    }
};
