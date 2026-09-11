import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

// `src/viewer-companion/` is DELIBERATELY excluded and must stay excluded.
// Its shaders run in the exported HTML viewer, on that page's own WebGL2
// device -- not in the editor. Their GLSL is correct, and "fixing" this
// exclusion would break every export. It is load-bearing, not prophylactic:
// `src/viewer-companion/portal-markers.ts:72` holds MARKER_CLAMP_GLSL (a
// `gl_Position` snippet) and registers it at `:185` via
// `shaderChunks.glsl.add`, alongside a WGSL twin for the editor-side device.
const EXCLUDED = ['viewer-companion'];

const walk = (dir: string, acc: string[] = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!EXCLUDED.includes(entry.name)) walk(p, acc);
        } else if (entry.name.endsWith('.ts')) {
            acc.push(p);
        }
    }
    return acc;
};

describe('the editor is WebGPU-only, so no editor-side shader may be GLSL', () => {
    const files = walk('src');
    const sources = new Map(files.map(f => [f, fs.readFileSync(f, 'utf8')]));
    const offenders = (re: RegExp) => files.filter(f => re.test(sources.get(f)));

    it('finds source files to check', () => {
        expect(files.length).toBeGreaterThan(100);
    });

    // route 1: ShaderMaterial's GLSL props. `vertexGLSL` and `vertexWGSL` both
    // exist on the type, so the wrong one compiles clean and renders nothing.
    it('declares no vertexGLSL or fragmentGLSL outside viewer-companion', () => {
        expect(offenders(/\b(vertex|fragment)GLSL\b/)).toEqual([]);
    });

    it('tags no shader source as glsl outside viewer-companion', () => {
        expect(offenders(/\/\*\s*glsl\s*\*\//)).toEqual([]);
    });

    // route 2: a raw Shader / Compute built with the GLSL language enum. Every
    // one of the editor's 15 `shaderLanguage:` sites passes SHADERLANGUAGE_WGSL
    // (data-processor/*, projected-splat-renderer.ts), so there is no
    // legitimate GLSL use to carve out -- the assertion is flat on purpose.
    it('selects no SHADERLANGUAGE_GLSL outside viewer-companion', () => {
        expect(offenders(/\bSHADERLANGUAGE_GLSL\b/)).toEqual([]);
    });

    // route 3: chunk overrides on a standard material. `shaderChunks.glsl` and
    // `shaderChunks.wgsl` are separate registries and neither errors when the
    // device cannot use it, so a GLSL-only override silently does nothing.
    it('registers no shaderChunks.glsl override outside viewer-companion', () => {
        expect(offenders(/\bshaderChunks\s*\.\s*glsl\b/)).toEqual([]);
    });
});
