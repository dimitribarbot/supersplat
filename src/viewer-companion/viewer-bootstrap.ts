// The exported viewer's single documented injection seam.
//
// splat-transform 3.3.x moved every embedder-supplied asset url out of the
// inline module script and into one JSON block:
//
//     <script type="application/json" id="sse-bootstrap">{...}</script>
//
// which the viewer reads as `bootstrap`, with URL query params taking
// precedence:
//
//     const posterUrl  = url.searchParams.get('poster')  ?? bootstrap.posterUrl  ?? null;
//     const contentUrl = url.searchParams.get('content') ?? bootstrap.contentUrl ?? './scene.compressed.ply';
//
// Upstream's own comment on the block says anything generating a page around
// the viewer should go through that seam "rather than pattern-matching this
// document", so the fork's export-time defaults are written here instead of
// rewriting the statements that read them. That is also what makes them
// survive an upstream bump: the seam is a stable contract, the statements were
// not (the 2.32.3 -> 3.3.3 rewrite silently broke the poster anchor).
//
// Environment-agnostic (compiled for the export server via dist-shared):
// string operations only, no DOM and no engine.

const BOOTSTRAP_OPEN = '<script type="application/json" id="sse-bootstrap">';
const BOOTSTRAP_CLOSE = '</script>';

// Serialize for embedding in a `<script type="application/json">` block,
// matching splat-transform's own jsonForScriptBlock: every `<` becomes its
// json unicode escape (so `</script` cannot end the block early and `<!--`
// cannot flip the tokenizer into the double-escaped state), and U+2028/U+2029
// are escaped because they are legal in json strings but terminate a line for
// some js parsers.
// U+2028/U+2029 by code point: a raw one in this source file is exactly the
// hazard being escaped, and invisible in an editor.
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

const jsonForScriptBlock = (value: any): string => {
    return JSON.stringify(value)
    .split('<').join('\\u003c')
    .split(LINE_SEP).join('\\u2028')
    .split(PARA_SEP).join('\\u2029');
};

// Merge `patch` into the exported viewer's bootstrap block. Returns null when
// the seam is absent or has an unexpected shape, so each caller decides
// whether that is a hard failure (the streaming content url, without which the
// export loads nothing) or a soft one (the default poster).
//
// The existing block is spliced rather than parsed and re-serialized: for a
// single-file export it holds the whole scene as a base64 data uri, and a
// JSON.parse/stringify round trip of that would cost two extra full copies of
// the payload. Patch keys are appended last, so they win the duplicate-key
// race that JSON.parse resolves last-one-wins.
const patchViewerBootstrap = (html: string, patch: Record<string, any>): string | null => {
    const openIdx = html.indexOf(BOOTSTRAP_OPEN);
    if (openIdx === -1) {
        return null;
    }
    const innerStart = openIdx + BOOTSTRAP_OPEN.length;
    const closeIdx = html.indexOf(BOOTSTRAP_CLOSE, innerStart);
    if (closeIdx === -1) {
        return null;
    }

    const pairs = Object.keys(patch)
    .map(key => `${jsonForScriptBlock(key)}:${jsonForScriptBlock(patch[key])}`)
    .join(',');

    const trimmed = html.slice(innerStart, closeIdx).trim();

    let inner: string;
    if (trimmed === '' || trimmed === 'null') {
        // the document splat-transform ships standalone, with no embedder yet
        inner = `{${pairs}}`;
    } else if (trimmed.charAt(0) === '{' && trimmed.charAt(trimmed.length - 1) === '}') {
        const body = trimmed.slice(1, -1);
        inner = `{${body.trim() === '' ? '' : `${body},`}${pairs}}`;
    } else {
        return null;
    }

    return html.slice(0, innerStart) + inner + html.slice(closeIdx);
};

export { patchViewerBootstrap };
