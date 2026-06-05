// Compiles the environment-agnostic shared export core (src/events.ts +
// src/splat-export-core.ts, plus whatever they import) to repo-root dist-shared/
// as ESM, then performs the post-emit fixups required for Node to load it at
// runtime:
//
//   1. Writes dist-shared/package.json {"type":"module"} so the emitted .js are
//      treated as ESM regardless of the repo root's (CommonJS) package.json.
//   2. Appends `.js` to every extensionless relative import in the emitted files
//      (e.g. `from './events'` or `from './viewer-companion/annotation-links'`),
//      because Node's ESM resolver requires explicit file extensions on relative
//      specifiers. TypeScript emits the source specifiers verbatim under Bundler
//      resolution, so without this rewrite Node throws "Cannot find module".
//
// ESM (not CommonJS) is deliberate: the installed playcanvas build does not
// expose its API through `require()` (repo-root `require('playcanvas')` returns
// an empty object), so @playcanvas/splat-transform's index.cjs cannot consume
// it. Loading the ESM builds of both works cleanly. The server (also ESM) loads
// dist-shared via dynamic import() at runtime.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tsconfig = join(repoRoot, 'tsconfig.shared.json');
const distDir = join(repoRoot, 'dist-shared');

// Resolve the local tsc binary (works whether invoked from repo root or server/).
const tscBin = join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');

execFileSync(tscBin, ['-p', tsconfig], { stdio: 'inherit', cwd: repoRoot, shell: process.platform === 'win32' });

writeFileSync(join(distDir, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);

// Append `.js` to extensionless relative import/export specifiers so Node's ESM
// resolver can load them. Covers static `from '...'` and dynamic `import('...')`.
const addJsExtensions = (code) => {
    return code.replace(
        /(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.\.?\/[^'"]+?)\2/g,
        (full, prefix, quote, spec) => (
            /\.(?:js|mjs|cjs|json)$/.test(spec) ? full : `${prefix}${quote}${spec}.js${quote}`
        )
    );
};

// Walk every emitted .js file (the export core lives in subdirectories too).
const jsFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
        return jsFiles(full);
    }
    return entry.name.endsWith('.js') ? [full] : [];
});

for (const file of jsFiles(distDir)) {
    const src = readFileSync(file, 'utf8');
    const fixed = addJsExtensions(src);
    if (fixed !== src) {
        writeFileSync(file, fixed);
    }
}

console.log('build-shared: dist-shared ready (ESM)');
