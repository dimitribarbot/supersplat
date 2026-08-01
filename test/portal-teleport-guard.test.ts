import { describe, it, expect } from 'vitest';

import { beginTeleportGuard, tickTeleportGuard, TeleportGuardState } from '../src/portal-teleport-guard';

const IDLE: TeleportGuardState = { target: null, until: 0 };
const GUARD_MS = 1250;

describe('beginTeleportGuard', () => {
    it('opens a window of the given duration for the asserted scene', () => {
        const g = beginTeleportGuard(2, 1000, GUARD_MS);
        expect(g.target).toBe(2);
        expect(g.until).toBe(2250);
    });

    it('replaces an open guard when a second jump happens mid-flight', () => {
        const first = beginTeleportGuard(2, 1000, GUARD_MS);
        const second = beginTeleportGuard(3, 1400, GUARD_MS);
        expect(first.until).toBe(2250);
        expect(second).toEqual({ target: 3, until: 2650 });
    });

    it('guards a jump that stays in the active scene (target === active)', () => {
        // the flight can still punch through a doorway even when the destination
        // annotation lives in the scene we are already in
        const g = beginTeleportGuard(0, 0, GUARD_MS);
        expect(tickTeleportGuard(g, 500, 'idle', null).active).toBe(true);
    });
});

describe('tickTeleportGuard', () => {
    it('is inert with no guard open', () => {
        const r = tickTeleportGuard(IDLE, 5000, 'idle', null);
        expect(r.active).toBe(false);
        expect(r.refire).toBe(false);
        expect(r.state.target).toBeNull();
    });

    it('suppresses crossing detection for the whole transition window', () => {
        const g = beginTeleportGuard(1, 1000, GUARD_MS);
        // every frame of the ~1s camera lerp
        for (const t of [1000, 1016, 1500, 2000, 2249]) {
            const r = tickTeleportGuard(g, t, 'idle', null);
            expect(r.active).toBe(true);
            expect(r.refire).toBe(false);
            expect(r.state).toBe(g);
        }
    });

    it('closes on the first frame at or past the deadline', () => {
        const g = beginTeleportGuard(1, 1000, GUARD_MS);
        const r = tickTeleportGuard(g, 2250, 'idle', null);
        expect(r.active).toBe(false);
        expect(r.state.target).toBeNull();
    });

    it('closes at the deadline while a crossing is blocked on a DIFFERENT scene', () => {
        const g = beginTeleportGuard(1, 1000, GUARD_MS);
        const r = tickTeleportGuard(g, 2250, 'blocked', 4);
        expect(r.active).toBe(false);
        expect(r.refire).toBe(false);
        expect(r.state.target).toBeNull();
    });

    it('re-fires the assertion while its own target is blocked', () => {
        const g = beginTeleportGuard(3, 1000, GUARD_MS);
        const r = tickTeleportGuard(g, 1100, 'blocked', 3);
        expect(r.active).toBe(true);
        expect(r.refire).toBe(true);
    });

    it('holds the guard open past the deadline while its target is still blocked', () => {
        // a jump into a scene that is not loadable yet: nothing else would ever
        // re-assert it, and the next unguarded frame would abandon it
        const g = beginTeleportGuard(3, 1000, GUARD_MS);
        const late = tickTeleportGuard(g, 9000, 'blocked', 3);
        expect(late.active).toBe(true);
        expect(late.refire).toBe(true);
        expect(late.state).toBe(g);
    });

    it('closes once a held target stops being blocked (the switch happened)', () => {
        const g = beginTeleportGuard(3, 1000, GUARD_MS);
        expect(tickTeleportGuard(g, 9000, 'blocked', 3).active).toBe(true);
        const done = tickTeleportGuard(g, 9016, 'loading', 3);
        expect(done.active).toBe(false);
        expect(done.refire).toBe(false);
        expect(done.state.target).toBeNull();
    });

    it('keeps suppressing (without re-firing) while the target is merely loading', () => {
        const g = beginTeleportGuard(2, 1000, GUARD_MS);
        const r = tickTeleportGuard(g, 1500, 'loading', 2);
        expect(r.active).toBe(true);
        expect(r.refire).toBe(false);
    });

    it('tolerates a missing/undefined guard state', () => {
        expect(tickTeleportGuard(undefined as any, 0, 'idle', null).active).toBe(false);
        expect(tickTeleportGuard({ target: undefined, until: 0 } as any, 0, 'idle', null).active).toBe(false);
    });
});
