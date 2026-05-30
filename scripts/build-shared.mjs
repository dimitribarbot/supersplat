// Compiles the environment-agnostic shared export core (src/events.ts +
// src/splat-export-core.ts) to repo-root dist-shared/ as ESM, then performs the
// post-emit fixups required for Node to load it at runtime:
//
//   1. Writes dist-shared/package.json {"type":"module"} so the emitted .js are
//      treated as ESM regardless of the repo root's (CommonJS) package.json.
//   2. If the emit contains a relative `from './events'` import, rewrites it to
//      `from './events.js'` because Node's ESM resolver requires explicit file
//      extensions. With the current source, splat-export-core only imports
//      `Events` as a type, so TypeScript elides the import entirely and there is
//      nothing to rewrite; the fixup is therefore best-effort, not mandatory.
//
// ESM (not CommonJS) is deliberate: the installed playcanvas build does not
// expose its API through `require()` (repo-root `require('playcanvas')` returns
// an empty object), so @playcanvas/splat-transform's index.cjs cannot consume
// it. Loading the ESM builds of both works cleanly. The server (also ESM) loads
// dist-shared via dynamic import() at runtime.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tsconfig = join(repoRoot, 'tsconfig.shared.json');
const distDir = join(repoRoot, 'dist-shared');

// Resolve the local tsc binary (works whether invoked from repo root or server/).
const tscBin = join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');

execFileSync(tscBin, ['-p', tsconfig], { stdio: 'inherit', cwd: repoRoot, shell: process.platform === 'win32' });

writeFileSync(join(distDir, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);

const coreFile = join(distDir, 'splat-export-core.js');
const src = readFileSync(coreFile, 'utf8');
const fixed = src.replace(/from (['"])\.\/events\1/g, 'from $1./events.js$1');
if (fixed !== src) {
    writeFileSync(coreFile, fixed);
}

console.log('build-shared: dist-shared ready (ESM)');
