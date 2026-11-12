import { describe, it, expect } from 'vitest';

import { tickXrSession, type XrSessionState } from '../src/portal-xr-session';

const idle: XrSessionState = { inXr: false, startScene: null };

describe('tickXrSession', () => {
    it('does nothing outside a session', () => {
        const r = tickXrSession(idle, false, 2);
        expect(r).toEqual({ state: idle, changed: false, returnTo: null });
    });

    it('records the scene a session starts in, and flags the jump', () => {
        const r = tickXrSession(idle, true, 2);
        expect(r.state).toEqual({ inXr: true, startScene: 2 });
        // the camera jumps from the desktop pose to the headset's: not a walk
        expect(r.changed).toBe(true);
        expect(r.returnTo).toBeNull();
    });

    it('keeps the start scene across the session, whatever is crossed', () => {
        const inside = tickXrSession(idle, true, 0).state;
        const r = tickXrSession(inside, true, 3);
        expect(r).toEqual({ state: inside, changed: false, returnTo: null });
    });

    it('returns to the start scene on exit when a crossing changed it', () => {
        const inside = tickXrSession(idle, true, 0).state;
        // the viewer puts the camera back where the session started
        const r = tickXrSession(inside, false, 2);
        expect(r.state).toEqual(idle);
        expect(r.changed).toBe(true);
        expect(r.returnTo).toBe(0);
    });

    it('asserts nothing on exit in the scene the session started in', () => {
        const inside = tickXrSession(idle, true, 1).state;
        const r = tickXrSession(inside, false, 1);
        expect(r.changed).toBe(true);
        expect(r.returnTo).toBeNull();
    });

    it('is injectable verbatim: no backslash escapes for the companion templates to eat', () => {
        expect(tickXrSession.toString()).not.toContain(String.fromCharCode(92));
    });
});
