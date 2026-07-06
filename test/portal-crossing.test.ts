import { describe, it, expect } from 'vitest';

import { crossingReducer, CrossingState } from '../src/portal-crossing';

const idle: CrossingState = { mode: 'idle', target: null };

describe('crossingReducer', () => {
    it('switches immediately on a crossing into a loaded, ready scene', () => {
        const r = crossingReducer(idle, { type: 'crossing', target: 2, loaded: true, ready: true });
        expect(r.state).toEqual({ mode: 'idle', target: null });
        expect(r.actions).toEqual({ switchTo: 2, overlay: 'keep', markReady: null });
    });

    it('switches and arms the reveal poll for a loaded but not-yet-ready streaming scene', () => {
        const r = crossingReducer(idle, { type: 'crossing', target: 1, loaded: true, ready: false });
        expect(r.state).toEqual({ mode: 'loading', target: 1 });
        expect(r.actions).toEqual({ switchTo: 1, overlay: 'poll', markReady: null });
    });

    it('drop-crossing-retry: blocks on an unloaded target, stays idempotent while re-fired, then completes the switch when the target loads', () => {
        // frame 1: crossing detected, scene 1 not loaded -> blocked + overlay shown
        let r = crossingReducer(idle, { type: 'crossing', target: 1, loaded: false, ready: false });
        expect(r.state).toEqual({ mode: 'blocked', target: 1 });
        expect(r.actions).toEqual({ switchTo: null, overlay: 'show', markReady: null });
        // frames 2..n: frozen lastSafe re-fires the same crossing -> pure no-op
        r = crossingReducer(r.state, { type: 'crossing', target: 1, loaded: false, ready: false });
        expect(r.state).toEqual({ mode: 'blocked', target: 1 });
        expect(r.actions).toEqual({ switchTo: null, overlay: 'keep', markReady: null });
        // frame n+1: entity appeared and the scene is ready (e.g. SOG) -> switch + hide
        r = crossingReducer(r.state, { type: 'crossing', target: 1, loaded: true, ready: true });
        expect(r.state).toEqual({ mode: 'idle', target: null });
        expect(r.actions).toEqual({ switchTo: 1, overlay: 'hide', markReady: null });
    });

    it('blocked target that loads but is not yet revealed switches and polls', () => {
        const blocked: CrossingState = { mode: 'blocked', target: 1 };
        const r = crossingReducer(blocked, { type: 'crossing', target: 1, loaded: true, ready: false });
        expect(r.state).toEqual({ mode: 'loading', target: 1 });
        expect(r.actions).toEqual({ switchTo: 1, overlay: 'poll', markReady: null });
    });

    it('cancels the blocked overlay when the user retreats to the known side', () => {
        const blocked: CrossingState = { mode: 'blocked', target: 1 };
        const r = crossingReducer(blocked, { type: 'noCrossing' });
        expect(r.state).toEqual({ mode: 'idle', target: null });
        expect(r.actions).toEqual({ switchTo: null, overlay: 'hide', markReady: null });
    });

    it('blocked retarget: a crossing into a different unloaded scene re-blocks on the new target', () => {
        const blocked: CrossingState = { mode: 'blocked', target: 1 };
        const r = crossingReducer(blocked, { type: 'crossing', target: 2, loaded: false, ready: false });
        expect(r.state).toEqual({ mode: 'blocked', target: 2 });
        expect(r.actions).toEqual({ switchTo: null, overlay: 'show', markReady: null });
    });

    it('A→B→A stale poll: switching back before reveal drops the poll without marking B ready, and a late reveal for B is ignored', () => {
        // cross into streaming scene B (=1): loading + poll armed
        let r = crossingReducer(idle, { type: 'crossing', target: 1, loaded: true, ready: false });
        expect(r.state).toEqual({ mode: 'loading', target: 1 });
        // cross back into A (=0, ready) before B reveals: switch + hide, NO markReady
        r = crossingReducer(r.state, { type: 'crossing', target: 0, loaded: true, ready: true });
        expect(r.state).toEqual({ mode: 'idle', target: null });
        expect(r.actions).toEqual({ switchTo: 0, overlay: 'hide', markReady: null });
        // a stale reveal for B (an un-cancelled poll, or reclaim racing) must be ignored
        r = crossingReducer(r.state, { type: 'revealed', target: 1 });
        expect(r.state).toEqual({ mode: 'idle', target: null });
        expect(r.actions).toEqual({ switchTo: null, overlay: 'keep', markReady: null });
    });

    it('reveal completes: marks the polled target ready and hides the overlay', () => {
        const loading: CrossingState = { mode: 'loading', target: 1 };
        const r = crossingReducer(loading, { type: 'revealed', target: 1 });
        expect(r.state).toEqual({ mode: 'idle', target: null });
        expect(r.actions).toEqual({ switchTo: null, overlay: 'hide', markReady: 1 });
    });

    it('noCrossing while loading keeps the poll running', () => {
        const loading: CrossingState = { mode: 'loading', target: 1 };
        const r = crossingReducer(loading, { type: 'noCrossing' });
        expect(r.state).toEqual({ mode: 'loading', target: 1 });
        expect(r.actions).toEqual({ switchTo: null, overlay: 'keep', markReady: null });
    });

    it('a crossing into another not-yet-ready scene mid-load restarts the poll for the new target', () => {
        const loading: CrossingState = { mode: 'loading', target: 1 };
        const r = crossingReducer(loading, { type: 'crossing', target: 2, loaded: true, ready: false });
        expect(r.state).toEqual({ mode: 'loading', target: 2 });
        expect(r.actions).toEqual({ switchTo: 2, overlay: 'poll', markReady: null });
    });

    it('a crossing into an unloaded scene mid-load drops the poll (no markReady) and blocks on the new target', () => {
        const loading: CrossingState = { mode: 'loading', target: 1 };
        const r = crossingReducer(loading, { type: 'crossing', target: 2, loaded: false, ready: false });
        expect(r.state).toEqual({ mode: 'blocked', target: 2 });
        expect(r.actions).toEqual({ switchTo: null, overlay: 'show', markReady: null });
    });

    it('repeated crossing events for the already-loading target are no-ops', () => {
        const loading: CrossingState = { mode: 'loading', target: 1 };
        const r = crossingReducer(loading, { type: 'crossing', target: 1, loaded: true, ready: false });
        expect(r.state).toEqual({ mode: 'loading', target: 1 });
        expect(r.actions).toEqual({ switchTo: null, overlay: 'keep', markReady: null });
    });

    it('stale revealed events are ignored in idle and blocked', () => {
        let r = crossingReducer(idle, { type: 'revealed', target: 1 });
        expect(r.state).toEqual(idle);
        expect(r.actions).toEqual({ switchTo: null, overlay: 'keep', markReady: null });
        r = crossingReducer({ mode: 'blocked', target: 2 }, { type: 'revealed', target: 2 });
        expect(r.state).toEqual({ mode: 'blocked', target: 2 });
        expect(r.actions).toEqual({ switchTo: null, overlay: 'keep', markReady: null });
    });

    it('blocked target abandoned for a different loaded+ready scene switches and hides', () => {
        const blocked: CrossingState = { mode: 'blocked', target: 1 };
        const r = crossingReducer(blocked, { type: 'crossing', target: 2, loaded: true, ready: true });
        expect(r.state).toEqual({ mode: 'idle', target: null });
        expect(r.actions).toEqual({ switchTo: 2, overlay: 'hide', markReady: null });
    });

    it('a revealed event for a different scene than the one loading is ignored', () => {
        const loading: CrossingState = { mode: 'loading', target: 1 };
        const r = crossingReducer(loading, { type: 'revealed', target: 2 });
        expect(r.state).toEqual({ mode: 'loading', target: 1 });
        expect(r.actions).toEqual({ switchTo: null, overlay: 'keep', markReady: null });
    });

    it('noCrossing in idle is a no-op', () => {
        const r = crossingReducer(idle, { type: 'noCrossing' });
        expect(r.state).toEqual({ mode: 'idle', target: null });
        expect(r.actions).toEqual({ switchTo: null, overlay: 'keep', markReady: null });
    });
});
