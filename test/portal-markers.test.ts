import { describe, it, expect } from 'vitest';

import { markerRuntime, markerStyle } from '../src/viewer-companion/portal-markers';

describe('markerStyle', () => {
    it('sits below the portal transition covers', () => {
        // loading backdrop 2000, tiles/defocus 1999
        expect(markerStyle).toContain('z-index: 1998');
    });

    it('keeps the whole overlay click-through: hit-testing is a canvas concern, not a DOM one', () => {
        expect(markerStyle).toContain('.ss-portal-markers { position: fixed; inset: 0; z-index: 1998; pointer-events: none; }');
        expect(markerStyle).not.toContain('pointer-events: auto');
    });

    it('no longer ships a per-marker DOM hit-target (replaced by a canvas hit-test)', () => {
        expect(markerStyle).not.toContain('.ss-portal-marker-hit');
    });
});

describe('markerRuntime', () => {
    it('defines the two entry points the portals companion calls', () => {
        expect(markerRuntime).toContain('function buildPortalMarkers()');
        expect(markerRuntime).toContain('function refreshPortalMarkers()');
    });

    it('ships the stringified pure helpers', () => {
        expect(markerRuntime).toContain('var portalsForScene =');
        expect(markerRuntime).toContain('var markerScale =');
        expect(markerRuntime).toContain('var markerVisible =');
        expect(markerRuntime).toContain('var markerHitTest =');
        expect(markerRuntime).toContain('var resolveMarkerTooltip =');
    });

    it('closes the tooltip on a scene change, independent of per-marker visibility', () => {
        // a portal touches both scenes it connects, so it can stay wanted
        // across a crossing; the close must not be gated on going invisible
        expect(markerRuntime).toContain('markerScene');
        expect(markerRuntime).toContain('activeIndex !== markerScene');
    });

    it('hit-tests the canvas instead of per-marker DOM divs', () => {
        expect(markerRuntime).toContain('markerCanvas.addEventListener(\'pointerdown\'');
        expect(markerRuntime).toContain('markerCanvas.addEventListener(\'pointerup\'');
        expect(markerRuntime).toContain('markerCanvas.addEventListener(\'pointermove\'');
        expect(markerRuntime).toContain('getBoundingClientRect');
        expect(markerRuntime).not.toContain('.dom');
        expect(markerRuntime).not.toContain('document.addEventListener(\'click\'');
    });

    it('registers the canvas listeners as passive and never blocks the camera controllers', () => {
        expect(markerRuntime).toContain('{ passive: true }');
        expect(markerRuntime).not.toContain('preventDefault');
        expect(markerRuntime).not.toContain('stopPropagation');
    });

    it('clears hover on pointerleave/pointercancel so a stuck tint cannot survive the pointer leaving the canvas', () => {
        // pointermove alone cannot catch this: it stops firing the moment the
        // pointer exits the canvas (or the browser cancels the pointer), so a
        // hover left active there would stick the tint and cursor -- the DOM-div
        // implementation got this for free from pointerenter/pointerleave on
        // the div itself.
        expect(markerRuntime).toContain('markerCanvas.addEventListener(\'pointerleave\'');
        expect(markerRuntime).toContain('markerCanvas.addEventListener(\'pointercancel\'');
        expect(markerRuntime).toContain('markerSetHover(markerHovered, false)');
    });

    it('bakes the nine-language tooltip table', () => {
        expect(markerRuntime).toContain('Portal to another scene');
        expect(markerRuntime).toContain('Portail vers une autre scène');
    });

    it('inserts its layer before the splats so occluded icons are painted over', () => {
        expect(markerRuntime).toContain('getOpaqueIndex(world) + 1');
        // there is deliberately NO always-on-top overlay copy
        expect(markerRuntime).not.toContain('getTransparentIndex');
    });

    it('lies in the portal plane instead of billboarding', () => {
        // orientation comes from the portal's own quaternion, set once at
        // creation; the camera rotation is no longer consulted at all
        expect(markerRuntime).toContain('entity.setRotation(new pcns.Quat(');
        expect(markerRuntime).toContain('entity.rotateLocal(90, 0, 0)');
        expect(markerRuntime).not.toContain('markerCamera.getRotation()');
        expect(markerRuntime).not.toContain('m.entity.setRotation(rot)');
    });

    it('projects the two in-plane half-axes for the elliptical hit test', () => {
        expect(markerRuntime).toContain('m.ux =');
        expect(markerRuntime).toContain('m.uy =');
        expect(markerRuntime).toContain('m.vx =');
        expect(markerRuntime).toContain('m.vy =');
        // the half-extent of a 1x1 PlaneGeometry at uniform scale s
        expect(markerRuntime).toContain('var half = s * 0.5');
    });

    it('calls the hit test without a shared radius', () => {
        expect(markerRuntime).not.toContain(', MARKER_SIZE / 2)');
    });

    it('reads the suppression inputs from the viewer, not from annotations', () => {
        expect(markerRuntime).toContain('window.sse.config.noui');
        expect(markerRuntime).toContain("transState.phase !== 'idle'");
        expect(markerRuntime).not.toContain('controlsHidden');
        // Visibility is deliberately NOT a function of gamingControls -- icons
        // stay on screen while the joystick / pointer lock is active, and only
        // their pointer response goes away (markerInteractive, a separate
        // predicate). Assert the exact argument object rather than the bare
        // string, which now legitimately appears elsewhere in the runtime.
        expect(markerRuntime).toContain(
            '    var visible = markerVisible({\n' +
            '      noui: markerNoui,\n' +
            "      cameraMode: (st && st.cameraMode) || 'orbit',\n" +
            "      transitionActive: !!(transState && transState.phase !== 'idle')\n" +
            '    });'
        );
    });

    it('degrades silently when the engine publish patch did not apply', () => {
        expect(markerRuntime).toContain('window.__ssPc');
        expect(markerRuntime).toContain('if (!pcns');
    });

    it('contains no backslashes (build-time template cooking eats them)', () => {
        expect(markerRuntime.includes(String.fromCharCode(92))).toBe(false);
        expect(markerStyle.includes(String.fromCharCode(92))).toBe(false);
    });

    it('contains no surviving template interpolation', () => {
        expect(markerRuntime.includes('$' + '{')).toBe(false);
        expect(markerStyle.includes('$' + '{')).toBe(false);
    });

    it('contains no backticks (it is embedded in a template literal)', () => {
        expect(markerRuntime.includes(String.fromCharCode(96))).toBe(false);
    });

    it('parses as a function body', () => {
        expect(() => new Function(markerRuntime)).not.toThrow();
    });

    it('publishes the hit test for the viewer-engine click guards', () => {
        // The two engine patches call this to decide whether a click landed on
        // an icon; without it they short-circuit and the viewer behaves as
        // before, so a patch/companion mismatch is never fatal.
        expect(markerRuntime).toContain('window.__ssPortalMarkerAt = function (x, y)');
        expect(markerRuntime).toContain('markerHitTest(markers, x, y) !== -1');
    });

    it('uses the same click slop as the viewer, so no gesture falls between them', () => {
        // The viewer treats a click as a click below TAP_EPSILON = 15. A
        // smaller slop here left a 5-15px dead zone where the movement was
        // suppressed and no tooltip opened.
        expect(markerRuntime).toContain('MARKER_CLICK_SLOP = 15');
        expect(markerRuntime).toContain('>= MARKER_CLICK_SLOP)');
    });

    it('hit-tests the press position, the same sample the engine guard reads', () => {
        // The viewer assigns _lastPointerOffsetX/Y only in _onPointerDown, so the
        // guard sees the press. If the tooltip hit-tested the release instead, a
        // click that crossed an icon's edge inside the slop could both navigate
        // and open a tooltip.
        expect(markerRuntime).toContain('markerHitTest(markers, markerDownX - rect.left, markerDownY - rect.top)');
        expect(markerRuntime).not.toContain('markerHitTest(markers, upEv.clientX - rect.left');
    });

    it('gates pointer interaction on the gaming-controls state', () => {
        // With gaming controls on, a mobile tap is the viewer's jump and a
        // desktop click carries frozen pointer-lock coordinates. The icons stay
        // visible; only their pointer response goes away.
        expect(markerRuntime).toContain('var markerInteractive =');
        expect(markerRuntime).toContain('function markerCanInteract()');
        expect(markerRuntime).toContain('if (!markerCanInteract()) { return; }');
    });

    it('gates the engine-side guard from the same choke point', () => {
        // Both existing click guards and the nav-hover-ring guard call this, so
        // gating it once here means none of them re-derives the rule.
        expect(markerRuntime).toContain('return markerCanInteract() && markerHitTest(markers, x, y) !== -1;');
    });

    it('tears down an open tooltip and hover when the state goes non-interactive', () => {
        // Pressing G with a tooltip open fires gamingControls:changed and
        // nothing else; without this the tooltip would hang around.
        expect(markerRuntime).toContain(
            '    if (!markerCanInteract()) {\n' +
            '      markerCloseTip();\n' +
            '      if (markerHovered !== -1) { markerSetHover(markerHovered, false); }\n' +
            '    }'
        );
    });

    it('closes an open tooltip when its own icon is clicked again', () => {
        // Click the open marker -> close; a different marker -> switch; the
        // canvas -> close. The closing click is still swallowed by the engine
        // guards, so re-clicking to dismiss does not move the camera either.
        expect(markerRuntime).toContain('if (hit === -1 || hit === markerTipOwner) { markerCloseTip(); } else { markerOpenTip(hit); }');
    });

    it('restores the viewer cursor on hover-out instead of clearing it', () => {
        // The viewer sets its own 'pointer' whenever a click can target
        // something (NavInteraction._updateCursor). Clearing to '' left a
        // default arrow behind until the user's next click.
        expect(markerRuntime).toContain('markerCursorSaved = markerCanvas.style.cursor;');
        expect(markerRuntime).toContain('markerCanvas.style.cursor = markerCursorSaved;');
        expect(markerRuntime).not.toContain("markerCanvas.style.cursor = '';");
    });
});
