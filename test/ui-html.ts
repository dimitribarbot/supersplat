// Renders index.js's `var uiHtml = …;` the way the browser would, for a given
// document title. The brand override turns that initializer into string
// literals joined by `+` around the __brandNameHtml variable (see
// src/viewer-companion/brand.ts); this walks those tokens and decodes each
// literal with JSON.parse, so nothing from the bundle is ever executed.

const BACKSLASH = String.fromCharCode(92);
const DECL = 'var uiHtml = ';
const NAME_VAR = '__brandNameHtml';

const escapeName = (title: string): string => title
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;');

export const renderUiHtml = (js: string, title = 'SuperSplat Viewer'): string => {
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
            let j = i + 1;
            while (js[j] !== '"') {
                j += js[j] === BACKSLASH ? 2 : 1;
            }
            out += JSON.parse(js.slice(i, j + 1)) as string;
            i = j + 1;
        } else if (js.startsWith(NAME_VAR, i)) {
            out += escapeName(title);
            i += NAME_VAR.length;
        } else if (js[i] === ';') {
            return out;
        } else {
            throw new Error(`unexpected token in uiHtml at ${i}: ${js.slice(i, i + 20)}`);
        }
    }
};
