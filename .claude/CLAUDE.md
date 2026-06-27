# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SuperSplat is a browser-based 3D Gaussian Splat editor (view, edit, optimize, publish `.ply` splats), built on the PlayCanvas engine and PCUI. It runs entirely client-side. This repo also contains an optional **export server** (`server/`) for GPU-accelerated server-side export, and a set of custom subsystems beyond upstream (collision, off-limits zones, portals, splat alignment).

## Commands

Run from the repo root (front-end app):

- `npm run build` — production build via Rollup → `dist/` (default `BUILD_TYPE=release`).
- `npm run watch` — rebuild on change (no HMR; refresh the browser manually).
- `npm run develop` — debug build (`BUILD_TYPE=debug`) + static server on **http://localhost:3333**. Use this for pure front-end work.
- `npm run lint` — ESLint over `src` (`eslint src`).
- `npm run test` — Vitest (`test/**/*.test.ts`), Node environment.
- Single test: `npx vitest run test/portals.test.ts` (or `npx vitest run -t "<name>"` to filter by test name; drop `run` to watch).

Build types (`BUILD_TYPE` env): `debug` (no minify, uses `playcanvas.dbg`), `profile`, `release` (strips `Debug.exec` calls + terser). `prod` is aliased to `release`.

Export server (run from `server/`):

- `npm run dev` — build shared code, then `tsx watch src/index.ts` on **http://localhost:3334** (also serves the repo-root `dist/` so the app and `/api/export*` are same-origin — required for the "Export on server" toggle to appear).
- `npm run build && npm start` — production.
- `npm run test` — server Vitest (includes the byte-parity guarantee test).

Note: there is no root vitest config; the server has its own (`server/vitest.config.ts`).

## Environment notes (from project memory)

- Prefer Bash (Git Bash) over PowerShell for git/npm/npx. Run commands plainly — no `cd`/`git -C`/`npm --prefix` pointing at the cwd (triggers permission prompts).
- ESLint is pinned to v10 and **crashes on `import/order` autofix**; don't re-attempt import-x reordering. Leave import ordering as-is.
- Never `rm package-lock.json` to apply a dependency change on Windows — it prunes cross-platform binaries. Use targeted `npm install <pkg>`.

## Architecture

### Event bus is the backbone

`src/events.ts` defines `Events` (extends PlayCanvas `EventHandler`). A single root `events` instance is created in `src/main.ts` and threaded into nearly every module. Two distinct mechanisms:

- **Events** (`events.fire(name, ...)` / `events.on(name, cb)`) — fire-and-forget pub/sub.
- **Functions** (`events.function(name, fn)` / `events.invoke(name, ...args)`) — a registered, queryable callback that returns a value. `events.invoke` is how modules *ask* for state (e.g. `events.invoke('import', ...)`, `events.invoke('selection.add', ...)`).

Modules expose themselves via `registerXxxEvents(events, ...)` functions called from `main.ts`. To add cross-cutting behavior, register events/functions rather than importing modules directly. `main.ts` is the single wiring point — read it first to understand how a subsystem is hooked up.

### Entry & boot

`src/index.ts` → `src/main.ts` `main()`. `main()` constructs `Events`, `CommandQueue`, `EditHistory`, localization, the WebGL2 graphics device, the `Scene`, the `EditorUI`, the `ToolManager` (registers all selection/transform tools), and all the `registerXxxEvents` modules, then `scene.start()`.

### Scene & elements

`src/scene.ts` owns the PlayCanvas app (`PCApp`), render layers, and an `elements: Element[]` list. `src/element.ts` is the base class: everything renderable/serializable (splats, camera, debug shapes) extends `Element` and implements lifecycle hooks (`add`, `remove`, `onUpdate`, `onPreRender`, `onPostRender`, `serialize`, `move`). A loaded splat is a `Splat` element (`src/splat.ts`). Elements have a monotonic `uid`.

### Async work, history & undo

`src/command-queue.ts` is a shared serial queue for all async splat work (GPU readbacks + history mutations); exposed as the `queue` function on the event bus. `src/edit-history.ts` builds undo/redo on top of it. Anything that mutates splat data asynchronously should enqueue through the shared queue so ordering relative to history is preserved.

### Tools

`src/tools/` + `ToolManager` (`tool-manager.ts`). Selection tools (rect/brush/flood/polygon/lasso/sphere/box/eyedropper), transform tools (move/rotate/scale, sharing `transform-tool.ts`), plus measure, annotation, off-limits-zone, portal, and alignment tools. Only one tool is active at a time.

### UI

`src/ui/` — PCUI-based components (`editor.ts` is the root `EditorUI`). Styling is SCSS under `src/ui/scss`, compiled by Rollup to `index.css`. SVG icons under `src/ui/svg`. Localization is i18next; strings live in `static/locales/<lang>.json` and the active locale list is in `src/ui/localization.ts`. Test a locale with `?lng=<code>`.

Gotcha (memory): a global `* { font-size: 12px }` overrides the SVG `font-size` attribute — size SVG text via inline `style.fontSize`, not the attribute.

### Other subsystems

- `src/data-processor/` — GPU-accelerated readbacks: bounds, histograms, point positions, range selection (`calc-*.ts`, `select-by-range.ts`).
- `src/io/` — read/write abstraction (`read/`, `write/`) over the File System Access API.
- `src/shaders/` — GLSL shader sources used by overlays, picking, bounds, histograms.
- `src/sw.ts` — service worker, built as a **separate** Rollup output (see `rollup.config.mjs`).
- `src/iframe-api.ts` — embedding/postMessage API.
- Splat export/serialization: `splat-serialize.ts`, `splat-export-core.ts`, `serializer.ts`, `png-compressor.ts`.

### Custom subsystems (this fork)

Beyond upstream SuperSplat, this repo adds editor tools + an exported-viewer runtime for:

- **Off-limits zones** — `off-limits-zones.ts`, `off-limits-zone-shape.ts`, `tools/off-limits-zone-tool.ts`.
- **Portals** — render one scene and swap when the camera crosses a doorway: `portals.ts`, `portals-runtime.ts`, `portal-export.ts`, `portal-geom.ts`, `portal-shape.ts`, `portal-anim-timeline.ts`, `portal-upload.ts`, `tools/portal-tool.ts`.
- **Splat alignment** — `alignment.ts`, `alignment-solve.ts` (pure Jacobi-eigensolver math, unit-tested), `ui/alignment-panel.ts`, `tools/alignment-tool.ts`.
- **Collision / voxel** — `collision-voxel-options.ts`, voxel collision used by the exported viewer walkthrough.

These have their own design docs and session hand-off memos under `docs/superpowers/`.

### Shared code: editor ↔ exported viewer ↔ server

`src/viewer-companion/` holds **playcanvas-free** runtime helpers (off-limits collision, portals, annotation links) that are baked into the exported HTML viewer *and* compiled for the Node export server. The split exists so the same logic runs in three environments without dragging in the engine.

`scripts/build-shared.mjs` compiles the environment-agnostic export core (`src/events.ts`, `src/splat-export-core.ts`, and their imports) to repo-root `dist-shared/` as ESM (writing a `{"type":"module"}` package.json and appending `.js` to relative imports so Node's ESM resolver can load it). The server imports `dist-shared` via dynamic `import()`. ESM is deliberate — the installed `playcanvas` build is not consumable via `require()`.

### Export server & parity guarantee

`server/` is a Node + Fastify service that runs the `@playcanvas/splat-transform` writers on a host GPU (Dawn/WebGPU) for formats the browser can't produce locally. The **parity guarantee**: the browser does all quality-critical prep and ships an uncompressed float32 PLY; the server reads that back bit-exact and runs the *same* writers, so server output is byte-identical to a local export. This is locked down by a parity test. The server has no built-in auth — deploy behind your own access controls. S3/Spaces publish is gated on `S3_*` env vars (see `server/README.md`).

## TypeScript / lint config

- `tsconfig.json`: `strictNullChecks: false`, `strictPropertyInitialization: false`, `noImplicitAny: true`, bundler resolution, targets ES2022 + DOM + WebWorker. `src/debug.ts` is excluded (test scratch file).
- ESLint extends `@playcanvas/eslint-config`; `no-explicit-any`, `no-unused-vars`, and most jsdoc rules are turned off. Match the surrounding import ordering and style rather than reformatting.
