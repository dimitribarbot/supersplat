import { describe, it, expect } from 'vitest';

import { buildPortalsInjection, resolveLoadingMessage, DEFAULT_MESSAGES } from '../src/viewer-companion/portals';

describe('resolveLoadingMessage', () => {
    it('prefers a non-empty custom message', () => {
        expect(resolveLoadingMessage('Wait!', DEFAULT_MESSAGES, 'fr')).toBe('Wait!');
    });
    it('falls back to the language default', () => {
        expect(resolveLoadingMessage('', DEFAULT_MESSAGES, 'fr')).toBe(DEFAULT_MESSAGES.fr);
    });
    it('falls back from a region subtag to the base language', () => {
        expect(resolveLoadingMessage('', DEFAULT_MESSAGES, 'fr-CA')).toBe(DEFAULT_MESSAGES.fr);
    });
    it('falls back to English for unknown languages', () => {
        expect(resolveLoadingMessage('', DEFAULT_MESSAGES, 'xx')).toBe(DEFAULT_MESSAGES.en);
    });
    it('provides non-empty defaults for every language', () => {
        Object.values(DEFAULT_MESSAGES).forEach(v => expect(v.length).toBeGreaterThan(0));
    });
    it('handles a null/undefined language by falling back to English', () => {
        expect(resolveLoadingMessage('', DEFAULT_MESSAGES, null as any)).toBe(DEFAULT_MESSAGES.en);
        expect(resolveLoadingMessage('', DEFAULT_MESSAGES, undefined as any)).toBe(DEFAULT_MESSAGES.en);
    });
});

describe('buildPortalsInjection', () => {
    it('returns empty string when there are no portals', () => {
        expect(buildPortalsInjection({})).toBe('');
        expect(buildPortalsInjection({ portals: [] })).toBe('');
    });

    it('emits the payload global and a runtime script when portals exist', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/scene.sog'],
            portalStart: 0,
            portalCollision: [],
            portalEnvironments: ['indoor', 'indoor'],
            portalSceneLodCounts: [[1000000, 250000, 62500], [800000, 200000]]
        });
        expect(out).toContain('window.__supersplatPortals');
        expect(out).toContain('scenes/1/scene.sog');
        expect(out).toContain('<script>');
        expect(out).toContain('<style>');
        expect(out.indexOf('<style>')).toBeLessThan(out.indexOf('window.__supersplatPortals'));
        expect(out).toContain('ss-portal-loading-backdrop');
        expect(out).toContain('ss-portal-spin'); // spinner keyframes present
        expect(out).toContain('loadingDefaults');
        // payload is HTML-escaped (no raw </script> break-out)
        expect(out).not.toContain('</script>'.replace('>', '>') + 'window');
        expect(out).toContain('portalSceneLodCounts');
        expect(out).toContain('62500');
    });

    it('escapes angle brackets so a payload cannot break out of the script tag', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['</script><b>inject', 'scenes/1/scene.sog'],
            portalStart: 0,
            portalCollision: [],
            portalEnvironments: ['indoor', 'indoor']
        });
        expect(out).not.toContain('</script><b>inject');
        expect(out).toContain('\\u003c');
    });

    it('bakes a portalAnimTimeline computed from the animation track', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 10, height: 10, front: 1, back: 0 }],
            portalScenes: ['', 'scenes/1/scene.sog'],
            portalStart: 0,
            animTracks: [{
                name: 'cameraAnim',
                duration: 1,
                frameRate: 30,
                loopMode: 'repeat',
                interpolation: 'spline',
                smoothness: 0,
                keyframes: { times: [0, 30], values: { position: [0, 0, -5, 0, 0, 5], target: [0, 0, 0, 0, 0, 0], fov: [60, 60] } }
            }]
        });
        expect(out).toContain('portalAnimTimeline');
        // crossing into scene 1 is recorded (path goes back -> front through the portal)
        expect(out).toContain('"scene":1');
    });

    it('bakes a start-only timeline when there is no animation track', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/scene.sog'],
            portalStart: 0
        });
        expect(out).toContain('portalAnimTimeline');
        expect(out).toContain('[{"t":0,"scene":0}]');
    });

    it('includes incremental distance-2 warming and budget-capped pinning in the runtime', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/lod-meta.json'],
            portalStart: 0
        });
        // frontier-shift warming replaces the startup warm-everything pass
        expect(out).toContain('warmFrontier');
        expect(out).toContain('computeWarmSet');
        expect(out).not.toContain('warmExtraScenes');
        // both warm stages' helpers are stringified in: lod-meta -> block-metas -> webps
        expect(out).toContain('collectLodFileUrls');
        expect(out).toContain('collectSogBlockFileUrls');
        // adjacent scenes are pinned resident at budget-capped, device-observed depths
        // and reclaimed when they leave the portal-adjacency frontier
        expect(out).toContain('assignPinDepths');
        expect(out).toContain('pinSceneToLevel');
        expect(out).toContain('incRefCount');
        expect(out).toContain('buildPortalAdjacency');
        expect(out).toContain('updateDeviceFinest');
    });

    it('drives residency from a device budget (selectResidentScenes wired in)', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/lod-meta.json'],
            portalStart: 0
        });
        expect(out).toContain('selectResidentScenes');
        expect(out).toContain('getResidentCeiling');
        expect(out).toContain('residentScenes');
        // still budget-capped for per-scene depth, still pins/reclaims
        expect(out).toContain('assignPinDepths');
        expect(out).toContain('pinSceneToLevel');
        // platform-split resident multiplier: desktop must hold several full
        // LOD pyramids resident; mobile stays conservative (never-OOM first)
        expect(out).toContain('IS_MOBILE ? 3 : 12');
        // desktop ceiling is project-aware (whole project resident when the
        // RAM-derived cap allows), and the residency decision is logged
        expect(out).toContain('computeResidentCeiling');
        expect(out).toContain('deviceMemory');
        expect(out).toContain('[portals] ');
        // scene 0 is pin-managed too (the engine frees a disabled scene's
        // blocks, so the start scene is NOT inherently resident)
        expect(out).toContain('comps[0] = startComp');
        expect(out).toContain('admit(0, true)');
        // preload waits for the viewer's initial load (firstFrame) so it never
        // competes with the loading bar's own coarse start-scene load
        expect(out).toContain('viewerReady');
        expect(out).toContain("'firstFrame'");
        // level-major coarse-first pinning: the scene is marked ready only when
        // its FINEST pinned batch (the reveal-depth floor) is resident, so a
        // mid-preload crossing keeps the overlay up instead of revealing a
        // mixed-quality scene
        expect(out).toContain('lv === pmin');
        expect(out).not.toContain('lv === pcoarse');
        // wave-based pin pump: the engine's per-scene block loader is a
        // 2-concurrent FIFO, so pins load a few files at a time instead of
        // burying interactive requests behind the whole preload backlog
        expect(out).toContain('pumpPins');
        expect(out).toContain('PIN_WAVE');
        // stuck-loading-bar field diagnostic
        expect(out).toContain('startup not ready after 20s');
        // ready-gate watchdog: repairs the upstream pendingLoadCount leak and
        // applies a fallback splatBudget so the engine is never unbounded
        expect(out).toContain('unstickInstances');
        expect(out).toContain('ready-gate watchdog');
        expect(out).toContain('fallback splatBudget');
        // GPU-memory field diagnostic: vram curve (periodic + per-crossing)
        // and a devicelost hook logging the last-known numbers -- evidence
        // for the mobile device-lost ("OOM") investigation
        expect(out).toContain('_vram');
        expect(out).toContain('[portals] vram');
        expect(out).toContain('DEVICE LOST');
        expect(out).toContain("'devicelost'");
        // ?residentBudget= override: the runtime lives inside a template
        // literal, where a regex escape like \d cooks to plain 'd' (the
        // override regex shipped as /residentBudget=(d+)/ and never matched).
        // The parser must use string ops only -- no cooked-escape remnants.
        expect(out).toContain("'residentBudget='");
        expect(out).not.toContain('(d+)');
    });

    it('gates the crossing overlay on reveal-depth residency, not coarse-only', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/lod-meta.json'],
            portalStart: 0
        });
        // pure gate helper stringified in, wrapped by the runtime's per-scene probe
        expect(out).toContain('sceneResidentToDepth');
        expect(out).toContain('sceneRevealResident');
        // the old coarsest-level-only gate is gone (it revealed mixed quality)
        expect(out).not.toContain('sceneCoarseResident');
        // gate depth: only an ASSIGNED pin depth (budget-degraded devices,
        // which never load finer blocks) may raise the gate; the early-session
        // sceneMinLevel placeholder (coarsest until deviceFinest is observed)
        // must not
        expect(out).toContain('pin != null && pin > acceptable');
        // the anti-stick caps survive as the overlay's only other exits
        expect(out).toContain('LOADING_MAX_FRAMES');
    });

    it('arms the crossing overlay from a live residency probe, not the ready flag alone', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/lod-meta.json'],
            portalStart: 0
        });
        // budget-degraded devices pin neighbours coarser than the active depth
        // the crossing itself assigns: the scene is "ready" at the old depth
        // but visibly refines after the swap (field: mobile first crossing
        // drew regions in with no overlay). Streaming scenes probe residency
        // at the live reveal depth; SOG scenes keep the flag (no octree).
        expect(out).toContain('octrees[idx] ? sceneRevealResident(idx) : readyScenes[idx]');
    });

    it('clamps scene 0\'s LOD floor to its pin depth only when budget-degraded', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/lod-meta.json'],
            portalStart: 0
        });
        // pure decision helper stringified in, applied via applyStartFloor
        expect(out).toContain('startSceneLodFloor');
        expect(out).toContain('applyStartFloor');
        // the clamp survives the viewer's applyPerfSettings re-run (which
        // reopens the start component's lodRangeMin to 0 on this event)
        expect(out).toContain("'performanceMode:changed'");
        // ...and the toggle also re-reconciles pins under the NEW budget, so
        // a raised budget releases the clamp without waiting for a crossing
        expect(out).toContain('if (pinReady) { pinDesired(); }');
    });

    it('halts GPU-feeding work on devicelost and resumes on devicerestored', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/lod-meta.json'],
            portalStart: 0
        });
        // a lost context makes every load/pin a no-op that still costs
        // decode CPU + error spam (field case: pin pump kept feeding
        // ensureFileResource into a dead device for 45s+)
        expect(out).toContain('deviceDead');
        expect(out).toContain("'devicerestored'");
    });

    it('frontier-manages SOG scenes: load on entry, full unload on exit', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/scene.sog'],
            portalStart: 0
        });
        expect(out).toContain('reconcileFrontier');
        expect(out).toContain('unloadScene');
        expect(out).toContain('assets.remove');   // asset deregistered so a re-load creates a fresh Asset
        expect(out).toContain('.unload()');       // resource destroyed (engine defers until sorter releases)
        expect(out).toContain('sceneLoading');
    });

    it('frontier-manages collision voxels and guards the start snapshot', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/scene.sog'],
            portalStart: 0,
            portalCollision: ['index.voxel.json', 'scenes/1/scene.voxel.json']
        });
        expect(out).toContain('reconcileCollisions');
        expect(out).toContain('snapshotTaken');
        expect(out).not.toContain('preloadCollisions');
    });

    it('routes crossings through the pure crossing reducer', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/lod-meta.json'],
            portalStart: 0
        });
        // the reducer is stringified into the runtime and driven via dispatch
        expect(out).toContain('crossingReducer');
        expect(out).toContain('noCrossing');
        expect(out).toContain('revealed');
        // blocked crossings freeze lastSafe so the crossing re-fires until the target loads
        expect(out).toContain("mode !== 'blocked'");
        // switching away mid-load must never keep the old arming/ready paths
        // (scoped past pumpPins' unrelated own "pendingIndex !== idx" yield check)
        expect(out).not.toContain('!showable && pendingIndex !== idx');
        expect(out).not.toContain('function endLoading');
    });

    it('never re-arms the overlay for a scene already shown this session', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/lod-meta.json'],
            portalStart: 0
        });
        // a scene the user has already seen displays at its current quality
        expect(out).toContain('if (shown[idx]) return true;');
        // reveal (incl. the anti-stick cap) marks the scene shown
        expect(out).toContain('shown[a.markReady] = true');
        // frontier reclaim invalidates shown so a freed scene overlays again
        expect(out).toContain('shown[idx] = false;');
    });

    it('the anti-stick cap only reveals once every region has coarse coverage', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/lod-meta.json'],
            portalStart: 0
        });
        // the 60s cap is gated on no-missing-regions; a longer absolute cap
        // remains the only unconditional exit
        expect(out).toContain('sceneCoverageResident');
        expect(out).toContain('LOADING_ABS_MAX_FRAMES');
    });

    it('reveals at a near-coarse acceptable level and aligns the streaming floor with it', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/lod-meta.json'],
            portalStart: 0
        });
        // the overlay gate never waits finer than REVEAL_MARGIN levels above coarsest
        expect(out).toContain('REVEAL_MARGIN');
        expect(out).toContain('revealLevel');
        // while loading, the destination renders at the finest fully-resident
        // level (held floor), so bandwidth and rendering track the gate
        expect(out).toContain('applySceneFloor');
    });

    it('an unassigned pin depth gates at the acceptable margin, not the coarsest placeholder', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/lod-meta.json'],
            portalStart: 0
        });
        // only a genuinely ASSIGNED pin depth may raise the gate above the margin
        expect(out).toContain('pin != null && pin > acceptable');
    });

    it('a crossed-into scene renders at the finest FULLY resident level, opening as levels complete', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/lod-meta.json'],
            portalStart: 0
        });
        // floor invariant: never render a level whose files are not all resident
        expect(out).toContain('finestFullLevel');
        expect(out).toContain('heldFloor');
        // the floor descends progressively and opens at the canonical pin floor
        expect(out).toContain('pumpFloor');
        // the old poll-scoped clamp is gone (superseded by the invariant)
        expect(out).not.toContain('pendingFloor');
    });

    it('watchdog treats a stuck ready gate as ready so the start scene gets pinned', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/lod-meta.json'],
            portalStart: 0
        });
        // firstFrame never firing left scene 0 unpinned; the engine frees a
        // disabled scene's unpinned blocks, so retreating came back black
        expect(out).toContain('treating viewer as ready');
        expect(out).toContain('idx === 0 && !viewerReady');
    });

    it('the floor invariant covers the start scene on crossings back into it', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/lod-meta.json'],
            portalStart: 0
        });
        // scene 0's canonical floor stays viewer-owned (startFloor clamp or open)
        expect(out).toContain('(startFloor !== null) ? startFloor : 0');
        // scheduleRefine no longer exempts the start scene
        expect(out).not.toContain('if (idx === 0) return;');
        // direct writes to scene 0's floor are held-floor-aware
        expect(out).toContain('Math.max(base, heldFloor[0])');
    });

    it('keys the startup collision snapshot by the start scene index, not activeIndex', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/lod-meta.json'],
            portalStart: 0,
            portalCollision: ['', 'scenes/1/collision.voxel.json']
        });
        expect(out).toContain('voxels[snapshotIdx] = snapshot(live)');
        expect(out).not.toContain('voxels[activeIndex] = snapshot');
    });
});

describe('buildPortalsInjection smoke', () => {
    // Representative 3-scene streaming payload: chained portals 0-1-2, collision
    // on, per-level counts present (finest -> coarsest).
    const payload = {
        portals: [
            { position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 },
            { position: [5, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 1, back: 2 }
        ],
        portalScenes: ['', 'scenes/1/lod-meta.json', 'scenes/2/lod-meta.json'],
        portalStart: 0,
        portalCollision: ['index.voxel.json', 'scenes/1/scene.voxel.json', 'scenes/2/scene.voxel.json'],
        portalEnvironments: ['indoor', 'indoor', 'indoor'],
        portalSceneLodCounts: [[1000000, 250000, 62500], [800000, 200000, 50000], [600000, 150000, 37500]]
    };

    const extractScripts = (html: string): string[] => {
        const out: string[] = [];
        const re = /<script>([\s\S]*?)<\/script>/g;
        let m;
        while ((m = re.exec(html)) !== null) {
            out.push(m[1]);
        }
        return out;
    };

    it('emits exactly two scripts: payload global then runtime', () => {
        const scripts = extractScripts(buildPortalsInjection(payload));
        expect(scripts.length).toBe(2);
        expect(scripts[0]).toContain('window.__supersplatPortals');
        expect(scripts[1]).toContain('function');
    });

    it('runtime script body constructs via new Function without throwing', () => {
        const scripts = extractScripts(buildPortalsInjection(payload));
        // Construction (not execution) catches syntax-level breakage in the
        // stringified helpers and the IIFE template.
        expect(() => new Function(scripts[1])).not.toThrow();
    });

    it('payload global round-trips through JSON.parse', () => {
        const scripts = extractScripts(buildPortalsInjection(payload));
        const m = scripts[0].match(/^window\.__supersplatPortals = ([\s\S]*);$/);
        expect(m).not.toBeNull();
        const parsed = JSON.parse(m![1]);
        expect(parsed.portalScenes).toEqual(payload.portalScenes);
        expect(parsed.portalSceneLodCounts).toEqual(payload.portalSceneLodCounts);
        expect(parsed.portalCollision).toEqual(payload.portalCollision);
        expect(parsed.portalStart).toBe(0);
        expect(Array.isArray(parsed.portalAnimTimeline)).toBe(true);
        expect(parsed.loadingDefaults.en).toBeTruthy();
    });
});
