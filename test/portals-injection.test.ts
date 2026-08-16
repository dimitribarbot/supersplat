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
        expect(out).toContain('pinBatchAllowed'); // active-scene-first gate helper baked into the runtime
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
        // the octree scan is throttled+stopped by the pure cadence helper
        expect(out).toContain('shouldSampleDeviceFinest');
        expect(out).toContain('sampleDeviceFinest');
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
        // ?budget= override honored by the watchdog fallback (the viewer applies
        // it only via ready-gated applyPerfSettings, so a stuck firstFrame would
        // otherwise drop it). Pure parser stringified in, read once into
        // budgetOverride, used ahead of the hardcoded 2M/4M default.
        expect(out).toContain('parseBudgetParam');
        expect(out).toContain('budgetOverride');
        expect(out).toContain('(from ?budget)');
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
        // gate depth resolution (device-finest target, active+ready pin as last
        // resort) is delegated to the pure, separately unit-tested computeRevealLevel
        expect(out).toContain('computeRevealLevel');
        expect(out).toContain('computeRevealLevel(coarse, REVEAL_MARGIN, deviceFinest, idx === activeIndex, pinReady, pinDepth[idx])');
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

    it('reveals at the scene coarsest level and aligns the streaming floor with it', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/lod-meta.json'],
            portalStart: 0
        });
        // margin 0: the gate is the coarsest level -- the batch the pin pump
        // completes first -- not two further, progressively larger levels
        expect(out).toContain('var REVEAL_MARGIN = 0;');
        expect(out).toContain('revealLevel');
        // while loading, the destination renders at the finest fully-resident
        // level (held floor), so bandwidth and rendering track the gate
        expect(out).toContain('applySceneFloor');
    });

    it('revealLevel passes the per-scene pin depth (not a stale placeholder) to computeRevealLevel', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/lod-meta.json'],
            portalStart: 0
        });
        // whether an unassigned pin may raise the gate above the margin is now
        // computeRevealLevel's own, separately unit-tested contract
        expect(out).toContain('computeRevealLevel(coarse, REVEAL_MARGIN, deviceFinest, idx === activeIndex, pinReady, pinDepth[idx])');
    });

    it('the render floor is never finer than what is resident, and a promotion re-arms the descent', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/lod-meta.json'],
            portalStart: 0
        });
        // the floor decision is delegated to the pure, separately unit-tested
        // sceneRenderFloor -- never assigned raw, so no path can hand the engine
        // a floor finer than the finest fully-resident level (blob fallbacks)
        expect(out).toContain('var sceneRenderFloor =');
        expect(out).toContain('comp.lodRangeMin = sceneRenderFloor(canonicalFloor(idx), heldFloor[idx], fine);');
        // pinDesired moves the ACTIVE scene's canonical floor FINER on promotion,
        // so it must re-derive the held floor (and restart the descent) rather
        // than apply the new depth over a released hold
        expect(out).toContain('if (idx === active) {');
        expect(out).toContain('scheduleRefine(idx);');
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

    it('binds the annotation-activation scene switch', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/scene.sog'],
            portalStart: 0
        });
        expect(out).toContain('annotation.activate');
        expect(out).toContain("ev.on('annotation.activate'");
        expect(out).toContain('idx >= data.portalScenes.length');
    });

    it('guards viewer-driven camera transitions against free-nav crossing detection', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/scene.sog'],
            portalStart: 0
        });
        // the pure guard helpers are stringified in
        expect(out).toContain('var beginTeleportGuard =');
        expect(out).toContain('var tickTeleportGuard =');
        // every viewer-driven camera lerp opens the guard: annotation jump,
        // reset (R / menu) and frame all goto + startTransition
        expect(out).toContain('function beginTeleport(idx)');
        expect(out).toContain('beginTeleport(known ? idx : activeIndex)');
        expect(out).toContain('beginTeleport(sIdx)');
        expect(out).toContain("name === 'frame'");
        // and the guard is consulted before free-nav detection each frame
        expect(out).toContain('tickTeleportGuard(teleportGuard');
    });

    it('ships the transition helpers, CSS and payload flag', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1, transition: false }],
            portalScenes: ['', 'scenes/1/scene.sog'],
            portalStart: 0,
            portalCollision: [],
            portalEnvironments: ['indoor', 'indoor'],
            portalSceneLodCounts: [[1000], [1000]]
        });
        // the per-portal flag reaches the viewer payload
        expect(out).toContain('"transition":false');
        // the pure helpers are stringified in
        expect(out).toContain('var transitionReducer =');
        expect(out).toContain('var tileGrid =');
        expect(out).toContain('var tileGeometry =');
        expect(out).toContain('var tileDelay =');
        expect(out).toContain('var resolvePortalCrossing =');
        // the tile layer CSS ships
        expect(out).toContain('ss-portal-tiles');
        expect(out).toContain('#0a0c10');
        expect(out).toContain('opacity: .7');
        // the design's 0.75x playback: 150ms sweep + 100ms per tile, 67ms hold
        expect(out).toContain('transition: opacity 100ms ease-out, transform 100ms cubic-bezier(.2,.75,.3,1)');
        // absolute 1px bleed past each grid track: scale(1.02) alone leaves
        // ~0.34px of overlap at a 26px target, under one device pixel, which
        // lets the scene show through the fractional track boundaries
        expect(out).toContain('margin: -1px;');
        expect(out).toContain('var T_SWEEP = REDUCED_MOTION ? 0 : 150;');
        expect(out).toContain('var T_HOLD = 67;');
        // 26px tiles fly proportionally less far than the old 110px ones:
        // 140 * (0.5 + 0.5 * 26/110) = 86.5. Assert the whole expression so the
        // test cannot pass on an unrelated 86.5 elsewhere in the bundle.
        expect(out).toContain("'translate(' + (t.ux * 86.5) + 'px,' + (t.uy * 86.5) + 'px) scale(.25) rotate('");
        expect(out).not.toContain('t.ux * 140');
    });

    it('resolves the cover kind per portal and keeps the legacy-boolean branch in the runtime', () => {
        const out = buildPortalsInjection({
            portals: [
                { position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1, transition: 'none' },
                { position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 1, back: 0, transition: 'tiles' }
            ],
            portalScenes: ['', 'scenes/1/scene.sog'],
            portalStart: 0,
            portalCollision: [],
            portalEnvironments: ['indoor', 'indoor'],
            portalSceneLodCounts: [[1000], [1000]]
        });
        // the kinds reach the viewer payload verbatim
        expect(out).toContain('"transition":"none"');
        expect(out).toContain('"transition":"tiles"');
        // the runtime resolves them, and still honours the legacy boolean
        expect(out).toContain('function transitionKind(');
        expect(out).toContain("if (v === false || v === 'none') { return 'none'; }");
        // Defocus is the default: only an explicit 'tiles' selects the tile
        // cover, and everything else (absent, legacy true, junk) falls through
        // to defocus. Asserted as one sequence so flipping the fallback back to
        // tiles cannot pass.
        expect(out).toContain("if (v === 'tiles') { return 'tiles'; }\n    return 'defocus';");
        // the in-flight crossing's cover is captured, not re-derived
        expect(out).toContain('var coverKind =');
        expect(out).not.toContain('function transitionEnabled(');
    });

    it('ships the defocus cover with the design endpoints and curves', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1, transition: 'defocus' }],
            portalScenes: ['', 'scenes/1/scene.sog'],
            portalStart: 0,
            portalCollision: [],
            portalEnvironments: ['indoor', 'indoor'],
            portalSceneLodCounts: [[1000], [1000]]
        });
        expect(out).toContain('"transition":"defocus"');
        // CSS: one full-screen layer, blur + veil at the design's endpoints
        expect(out).toContain('.ss-portal-defocus');
        expect(out).toContain('blur(26px) saturate(.45)');
        expect(out).toContain('rgba(7,10,14,.9)');
        // both vendor prefixes ship, so Safari gets the effect
        expect(out).toContain('-webkit-backdrop-filter: blur(26px) saturate(.45)');
        // idle must be `none`, not blur(0px): a non-none backdrop-filter creates
        // a permanent stacking context even at zero blur. Anchored to the
        // preceding background-color line -- the bare filter string alone also
        // matches the unrelated .reduced.armed rule further down the CSS.
        expect(out).toContain('background-color: rgba(7,10,14,0);\n  -webkit-backdrop-filter: none; backdrop-filter: none;');
        expect(out).toContain('backdrop-filter: blur(0px) saturate(1)');
        // the defocus layer is actually mounted, not just constructed
        expect(out).toContain('document.body.appendChild(defocusLayer)');
        // Neither cover declares will-change anywhere in the injected viewer.
        // Browsers promote a running transform/opacity or backdrop-filter
        // transition on their own, and the tile grid is up to 1200 cells --
        // hinting every one of them costs more than it buys. The CSS comments
        // explaining the absence deliberately avoid the hyphenated token so
        // this can stay an exact-token check.
        expect(out).not.toContain('will-change');
        // timing: 213ms cubicIn in, 373ms quintOut out
        expect(out).toContain('var T_DEFOCUS_IN = REDUCED_MOTION ? 150 : 213;');
        expect(out).toContain('var T_DEFOCUS_OUT = REDUCED_MOTION ? 150 : 373;');
        // full constant lines, not bare curve strings: each curve also appears
        // in the CSS base rule, so a bare toContain would pass even if both JS
        // constants below were deleted
        expect(out).toContain("var DEFOCUS_IN_EASE = REDUCED_MOTION ? 'linear' : 'cubic-bezier(.32,0,.67,0)';");
        expect(out).toContain("var DEFOCUS_OUT_EASE = REDUCED_MOTION ? 'linear' : 'cubic-bezier(.22,1,.36,1)';");
        // the dispatchers route to it
        expect(out).toContain("if (coverKind === 'defocus') { startDefocusIn(); }");
        expect(out).toContain("if (coverKind === 'defocus') { startDefocusOut(); }");
        expect(out).toContain("if (coverKind === 'defocus') { clearDefocus(); }");
    });

    it('swaps collision at the start of the dismantle, not at the commit', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/scene.sog'],
            portalStart: 0,
            portalCollision: ['scenes/0/scene.voxel.json', 'scenes/1/scene.voxel.json'],
            portalEnvironments: ['indoor', 'indoor'],
            portalSceneLodCounts: [[1000], [1000]]
        });
        // The crossing is detected the frame the camera passes the doorway, so
        // the destination's voxel field must go live when the dismantle starts.
        // Leaving it until the commit clamps the movers against a region the
        // outgoing scene never carved (measured: 2.6 -> 0.7 m/s over the last
        // ~250 ms of the sweep, recovering on the commit frame).
        expect(out).toContain('function collisionScene()');
        // one invariant re-asserted on every phase change: swap forward on the
        // dismantle, restore on cancel / abort / a crossing abandoned blocked
        expect(out).toContain('swapCollision(collisionScene());');
        // A voxel fetch landing mid-dismantle must apply to the field that
        // should be live now, not to the not-yet-switched active scene.
        expect(out).toContain('if (idx === collisionScene()) swapCollision(idx);');
    });

    it('keeps the runtime free of template-literal hazards', () => {
        const out = buildPortalsInjection({
            portals: [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
            portalScenes: ['', 'scenes/1/scene.sog'],
            portalStart: 0,
            portalCollision: [],
            portalEnvironments: ['indoor', 'indoor'],
            portalSceneLodCounts: [[1000], [1000]]
        });
        // A hand-authored '${' in the runtime body would interpolate at build
        // time and can never reach the output; this guards the OTHER source --
        // that no stringified helper's body contains a template literal with
        // its own interpolation (which WOULD survive verbatim into the string).
        expect(out.includes('$' + '{')).toBe(false);
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

describe('portal resident ceiling is decoupled from the live splat budget', () => {
    // Minimal two-scene streaming payload: buildPortalsInjection returns '' for
    // fewer than two scenes, so the injection must be non-empty to assert on.
    const payload = {
        portals: [
            { position: [0, 0, 0], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }
        ],
        portalScenes: ['', 'scenes/1/lod-meta.json'],
        portalStart: 0,
        portalSceneLodCounts: [[1000000, 250000], [800000, 200000]]
    };

    it('passes a constant reference budget, not getSplatBudget()', () => {
        // HD (14M) must not inflate cross-scene residency: 3 x 14M = 42M on
        // mobile (~0.9-1GB, near-certain OOM) and 12 x 14M = 168M on desktop,
        // which would override the RAM-derived 128M cap. The reference is
        // pinned to the Normal-mode budgets so today's ceilings are unchanged.
        const out = buildPortalsInjection(payload);
        expect(out).toContain('CEILING_REFERENCE_BUDGET');
        expect(out).toContain('2000000');
        expect(out).toContain('4000000');
        expect(out).not.toContain('computeResidentCeiling(residentBudgetOverride, getSplatBudget()');
    });
});

describe('portal marker icons', () => {
    const payload = {
        portals: [{ position: [1, 2, 3], rotation: [0, 0, 0, 1], width: 2, height: 2, front: 0, back: 1 }],
        portalScenes: ['', 'scenes/1/scene.sog'],
        portalStart: 0,
        portalCollision: [],
        portalEnvironments: ['indoor', 'indoor'],
        portalSceneLodCounts: [[1000], [1000]]
    };

    it('ships the marker style and runtime', () => {
        const out = buildPortalsInjection(payload);
        expect(out).toContain('.ss-portal-markers');
        expect(out).toContain('function buildPortalMarkers()');
        expect(out).toContain('Portal to another scene');
    });

    it('ships nothing when there are no portals', () => {
        expect(buildPortalsInjection({ portals: [] })).toBe('');
    });

    it('builds the markers once at startup, right after applyActive', () => {
        const out = buildPortalsInjection(payload);
        expect(out).toContain('applyActive();\n    buildPortalMarkers();');
    });

    it('refreshes the markers from every state-change site', () => {
        const out = buildPortalsInjection(payload);
        // applyActive, transDispatch, the cameraMode:changed listener, and the
        // tail of buildPortalMarkers itself
        const calls = out.split('refreshPortalMarkers();').length - 1;
        expect(calls).toBeGreaterThanOrEqual(4);
    });

    it('refreshes right after the transition collision swap', () => {
        const out = buildPortalsInjection(payload);
        const swap = out.indexOf('swapCollision(collisionScene());');
        expect(swap).toBeGreaterThan(-1);
        expect(out.slice(swap, swap + 280)).toContain('refreshPortalMarkers();');
    });

    it('refreshes when the camera mode changes', () => {
        const out = buildPortalsInjection(payload);
        const mode = out.indexOf('spawnScene = activeIndex; }');
        expect(mode).toBeGreaterThan(-1);
        expect(out.slice(mode, mode + 120)).toContain('refreshPortalMarkers();');
    });

    it('refreshes when the gaming-controls state changes', () => {
        const out = buildPortalsInjection(payload);
        const gc = out.indexOf("ev.on('gamingControls:changed'");
        expect(gc).toBeGreaterThan(-1);
        expect(out.slice(gc, gc + 120)).toContain('refreshPortalMarkers();');
    });

    it('refreshes from applyActive, the site that enables the active scene', () => {
        const out = buildPortalsInjection(payload);
        const active = out.indexOf('function applyActive() {');
        expect(active).toBeGreaterThan(-1);
        expect(out.slice(active, active + 200)).toContain('refreshPortalMarkers();');
    });

    it('defines the marker runtime before start() runs', () => {
        const out = buildPortalsInjection(payload);
        // start() contains its own self-retry `requestAnimationFrame(start);`
        // guards (fired while waiting for the viewer app/camera to exist), so
        // indexOf would match one of those instead of the real bootstrap call
        // at the tail of the IIFE. Only the LAST occurrence is the bootstrap.
        expect(out.indexOf('function buildPortalMarkers()')).toBeLessThan(out.lastIndexOf('requestAnimationFrame(start);'));
    });
});
