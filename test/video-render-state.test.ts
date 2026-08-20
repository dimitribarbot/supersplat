import { describe, it, expect } from 'vitest';

import { Events } from '../src/events';
import { withVideoRenderState } from '../src/video-render-state';

// Stand-ins for the four collaborators, each modelled directly on the real
// source so the ORDERING this module depends on is what is actually tested:
//
//   selection.ts:10       a hidden splat cannot be selected
//   selection.ts:46-50    hiding the selected splat clears the selection
//   splat-list.ts:241-257 solo snapshots visibility on, restores it off
//   scene-panel.ts:61-94  the two toggles are mutually exclusive
//   portals-runtime.ts:48-69  walkthrough snapshots visibility on, restores off
//
// The real versions are PCUI/DOM bound and cannot run under this Node suite;
// the wiring itself still needs an end-to-end check.

class FakeSplat {
    private _visible = true;

    constructor(public uid: number, public name: string, private events: Events) {}

    get visible() {
        return this._visible;
    }

    set visible(value: boolean) {
        if (value !== this._visible) {
            this._visible = value;
            this.events.fire('splat.visibility', this);
        }
    }
}

const makeEditor = (opts: { names: string[]; selected: string | null; solo: boolean; portalCount: number; startName: string }) => {
    const events = new Events();
    const splats = opts.names.map((n, i) => new FakeSplat(i + 1, n, events));
    const byName = (n: string) => splats.find(s => s.name === n)!;
    const startUid = byName(opts.startName).uid;

    // --- selection.ts ---
    let selection: FakeSplat | null = null;
    const setSelection = (splat: FakeSplat | null) => {
        if (splat !== selection && (!splat || splat.visible)) {
            const prev = selection;
            selection = splat;
            events.fire('selection.changed', selection, prev);
        }
    };
    events.on('selection', setSelection);
    events.function('selection', () => selection);
    events.function('scene.allSplats', () => splats);
    events.on('splat.visibility', (s: FakeSplat) => {
        if (s === selection && !s.visible) setSelection(null);
    });

    // --- splat-list.ts (solo) ---
    const soloSaved = new Map<FakeSplat, boolean>();
    let soloMode = false;
    // splat-list.ts:226-239 — in solo mode, changing the selection moves the
    // spotlight
    events.on('selection.changed', (sel: FakeSplat | null, prev: FakeSplat | null) => {
        if (soloMode) {
            if (prev) prev.visible = false;
            if (sel) sel.visible = true;
        }
    });
    events.on('scene.solo', (on: boolean) => {
        soloMode = on;
        if (on) {
            splats.forEach((s) => {
                soloSaved.set(s, s.visible);
                s.visible = s === selection;
            });
        } else {
            splats.forEach((s) => {
                const was = soloSaved.get(s);
                s.visible = was !== undefined ? was : true;
            });
            soloSaved.clear();
        }
    });

    // --- portals-runtime.ts ---
    let runtimeActive = false;
    const snapshot = new Map<number, boolean>();
    events.on('portals.walkthrough', (on: boolean) => {
        if (on === runtimeActive) return;
        runtimeActive = on;
        if (on) {
            snapshot.clear();
            splats.forEach(s => snapshot.set(s.uid, s.visible));
            splats.forEach((s) => {
                s.visible = s.uid === startUid;
            });
        } else {
            splats.forEach((s) => {
                const v = snapshot.get(s.uid);
                if (v !== undefined) s.visible = v;
            });
            snapshot.clear();
        }
    });

    // --- scene-panel.ts (the two toggles + the hooks under test) ---
    let soloActive = false;
    let walkthroughActive = false;
    const setSolo = (on: boolean) => {
        if (on === soloActive) return;
        soloActive = on;
        if (soloActive && walkthroughActive) {
            walkthroughActive = false;
            events.fire('portals.walkthrough', false);
        }
        events.fire('scene.solo', soloActive);
    };
    const setWalkthrough = (on: boolean) => {
        if (on === walkthroughActive) return;
        if (on && opts.portalCount === 0) return;
        walkthroughActive = on;
        if (walkthroughActive && soloActive) {
            soloActive = false;
            events.fire('scene.solo', false);
        }
        events.fire('portals.walkthrough', walkthroughActive);
    };
    events.on('scene.solo.set', setSolo);
    events.on('portals.walkthrough.set', setWalkthrough);
    events.function('scene.solo.active', () => soloActive);
    events.function('portals.walkthrough.active', () => walkthroughActive);
    events.function('portals.count', () => opts.portalCount);

    // --- editor.ts camera.getPose / camera.setPose ---
    // render.video drives the camera along the anim track and never puts it
    // back, so the module has to. Records the order operations happened in so
    // the camera restore can be pinned to AFTER walkthrough is off (while it is
    // on, a camera jump would run the portal crossing test).
    const ops: string[] = [];
    let camera = { position: { x: 1, y: 2, z: 3 }, target: { x: 4, y: 5, z: 6 }, fov: 60 };
    events.function('camera.getPose', () => ({
        position: { ...camera.position },
        target: { ...camera.target },
        fov: camera.fov
    }));
    events.on('camera.setPose', (pose: any) => {
        camera = {
            position: { x: pose.position.x, y: pose.position.y, z: pose.position.z },
            target: { x: pose.target.x, y: pose.target.y, z: pose.target.z },
            fov: pose.fov ?? camera.fov
        };
        ops.push('camera.setPose');
    });
    events.on('portals.walkthrough', (on: boolean) => ops.push(`walkthrough:${on}`));

    // --- editor.ts view freeze ---
    // The still that hides the offscreen blackout and the walkthrough/solo swap.
    events.function('view.freeze', async () => {
        ops.push('freeze');
    });
    events.on('view.unfreeze', () => ops.push('unfreeze'));

    // initial state
    if (opts.selected) events.fire('selection', byName(opts.selected));
    if (opts.solo) setSolo(true);

    // splat-list.ts:273-280 — clicking a row in solo mode reveals it first,
    // THEN selects it (selection.ts refuses to select a hidden splat)
    const clickItem = (name: string) => {
        const s = byName(name);
        if (soloMode && !s.visible) s.visible = true;
        events.fire('selection', s);
    };

    // what render.video does to the camera: leaves it wherever the animation ended
    const driveCameraTo = (x: number) => {
        camera = { position: { x, y: 0, z: 0 }, target: { x, y: 0, z: 0 }, fov: 90 };
    };

    return {
        events,
        byName,
        clickItem,
        setSolo,
        setWalkthrough,
        ops,
        driveCameraTo,
        camera: () => camera,
        visibleNames: () => splats.filter(s => s.visible).map(s => s.name),
        state: () => ({
            visible: splats.filter(s => s.visible).map(s => s.name),
            selection: selection?.name ?? null,
            solo: soloActive,
            walkthrough: walkthroughActive
        })
    };
};

describe('withVideoRenderState', () => {
    it('shows only the start scene during the render', async () => {
        const ed = makeEditor({ names: ['A', 'B', 'C'], selected: 'B', solo: false, portalCount: 2, startName: 'A' });
        let during: string[] = [];
        await withVideoRenderState(ed.events, async () => {
            during = ed.visibleNames();
            return true;
        });
        expect(during).toEqual(['A']);
    });

    it('restores visibility, selection and solo after the render', async () => {
        const ed = makeEditor({ names: ['A', 'B', 'C'], selected: 'B', solo: true, portalCount: 2, startName: 'A' });
        const before = ed.state();
        // solo mode really is showing just the selected scene
        expect(before).toEqual({ visible: ['B'], selection: 'B', solo: true, walkthrough: false });

        await withVideoRenderState(ed.events, async () => true);

        expect(ed.state()).toEqual(before);
    });

    // The point of restoring in reverse order rather than forcing visibility
    // back: solo's OWN snapshot has to survive, or switching solo off after a
    // render would strand scenes hidden.
    it('leaves solo able to restore the pre-solo visibility afterwards', async () => {
        const ed = makeEditor({ names: ['A', 'B', 'C'], selected: 'B', solo: false, portalCount: 2, startName: 'A' });
        ed.byName('C').visible = false;         // hidden by hand before solo
        ed.setSolo(true);
        expect(ed.visibleNames()).toEqual(['B']);

        await withVideoRenderState(ed.events, async () => true);

        ed.setSolo(false);
        expect(ed.visibleNames()).toEqual(['A', 'B']);   // C stays hidden, A comes back
    });

    // Regression: solo mode does NOT imply "only the selected scene is
    // visible". splat-list lets extra scenes be revealed on top of the soloed
    // one, and those reveals are exactly what solo's own snapshot does not
    // hold. Reported from the field: four scenes, solo on, two visible; after a
    // render every scene was hidden and the selection was gone.
    it('restores extra scenes revealed on top of solo', async () => {
        const ed = makeEditor({ names: ['RdC', 'Etage', 'Jardin', 'Cour'], selected: null, solo: false, portalCount: 3, startName: 'RdC' });

        // pre-solo visibility: only RdC on
        ['Etage', 'Jardin', 'Cour'].forEach(n => (ed.byName(n).visible = false));
        ed.events.fire('selection', ed.byName('RdC'));
        ed.setSolo(true);

        // ...then, inside solo, click Jardin (reveals + selects it, spotlight
        // moves off RdC) and reveal RdC alongside it via its eye icon
        ed.clickItem('Jardin');
        ed.byName('RdC').visible = true;

        const before = ed.state();
        expect(before).toEqual({ visible: ['RdC', 'Jardin'], selection: 'Jardin', solo: true, walkthrough: false });

        await withVideoRenderState(ed.events, async () => true);

        expect(ed.state()).toEqual(before);
    });

    it('restores a selection that walkthrough cleared', async () => {
        // B is not the start scene, so walkthrough hides it -> selection.ts
        // clears the selection (selection.ts:46-50)
        const ed = makeEditor({ names: ['A', 'B', 'C'], selected: 'B', solo: false, portalCount: 2, startName: 'A' });
        await withVideoRenderState(ed.events, async () => {
            expect(ed.events.invoke('selection')).toBeNull();
            return true;
        });
        expect(ed.state().selection).toBe('B');
    });

    it('restores state when the render throws, and rethrows', async () => {
        const ed = makeEditor({ names: ['A', 'B', 'C'], selected: 'B', solo: true, portalCount: 2, startName: 'A' });
        const before = ed.state();
        await expect(withVideoRenderState(ed.events, async () => {
            throw new Error('render failed');
        })).rejects.toThrow('render failed');
        expect(ed.state()).toEqual(before);
    });

    it('changes nothing when the scene has no portals', async () => {
        const ed = makeEditor({ names: ['A', 'B'], selected: 'B', solo: true, portalCount: 0, startName: 'A' });
        const before = ed.state();
        let during: string[] = [];
        const result = await withVideoRenderState(ed.events, async () => {
            during = ed.visibleNames();
            return 'rendered';
        });
        expect(result).toBe('rendered');
        expect(during).toEqual(['B']);       // untouched: solo still applies
        expect(ed.state()).toEqual(before);
    });

    // src/render.ts leaves the camera wherever the animation ended — its own
    // finally only notes "camera likely moved". For a looping walkthrough that
    // lands on (near) the first frame's pose, which is what users see.
    it('restores the camera pose the render moved', async () => {
        const ed = makeEditor({ names: ['A', 'B'], selected: 'B', solo: false, portalCount: 2, startName: 'A' });
        const before = ed.camera();

        await withVideoRenderState(ed.events, async () => {
            ed.driveCameraTo(999);
            return true;
        });

        expect(ed.camera()).toEqual(before);
    });

    // The camera is displaced by every video render, portals or not, so this
    // must not be gated on the walkthrough branch.
    it('restores the camera pose when the scene has no portals', async () => {
        const ed = makeEditor({ names: ['A', 'B'], selected: 'B', solo: false, portalCount: 0, startName: 'A' });
        const before = ed.camera();

        await withVideoRenderState(ed.events, async () => {
            ed.driveCameraTo(999);
            return true;
        });

        expect(ed.camera()).toEqual(before);
    });

    // Order matters: while walkthrough is still on, moving the camera runs the
    // portal crossing test and could swap the visible scene.
    it('restores the camera only after walkthrough is switched off', async () => {
        const ed = makeEditor({ names: ['A', 'B'], selected: 'B', solo: false, portalCount: 2, startName: 'A' });

        await withVideoRenderState(ed.events, async () => {
            ed.driveCameraTo(999);
            return true;
        });

        expect(ed.ops).toEqual(['freeze', 'walkthrough:true', 'walkthrough:false', 'camera.setPose', 'unfreeze']);
    });

    // The still must go up BEFORE anything changes — the walkthrough/solo swap
    // is itself visible (scene appears, eye icons flip) — and come down only
    // once the camera is back, or the reveal shows the render's last pose.
    it('freezes the view first and reveals it last', async () => {
        const ed = makeEditor({ names: ['A', 'B', 'C'], selected: 'B', solo: true, portalCount: 2, startName: 'A' });

        await withVideoRenderState(ed.events, async () => {
            ed.driveCameraTo(999);
            return true;
        });

        expect(ed.ops[0]).toBe('freeze');
        expect(ed.ops.at(-1)).toBe('unfreeze');
        expect(ed.ops.indexOf('camera.setPose')).toBeLessThan(ed.ops.indexOf('unfreeze'));
    });

    it('reveals the view again when the render throws', async () => {
        const ed = makeEditor({ names: ['A', 'B'], selected: 'B', solo: false, portalCount: 2, startName: 'A' });

        await expect(withVideoRenderState(ed.events, async () => {
            throw new Error('render failed');
        })).rejects.toThrow('render failed');

        expect(ed.ops.at(-1)).toBe('unfreeze');
    });

    // No portals means no walkthrough, but the offscreen blackout still happens
    it('freezes the view even when the scene has no portals', async () => {
        const ed = makeEditor({ names: ['A', 'B'], selected: 'B', solo: false, portalCount: 0, startName: 'A' });

        await withVideoRenderState(ed.events, async () => true);

        expect(ed.ops[0]).toBe('freeze');
        expect(ed.ops.at(-1)).toBe('unfreeze');
    });

    it('restores the camera when the render throws', async () => {
        const ed = makeEditor({ names: ['A', 'B'], selected: 'B', solo: false, portalCount: 2, startName: 'A' });
        const before = ed.camera();

        await expect(withVideoRenderState(ed.events, async () => {
            ed.driveCameraTo(999);
            throw new Error('render failed');
        })).rejects.toThrow('render failed');

        expect(ed.camera()).toEqual(before);
    });

    it('leaves an already-active walkthrough alone', async () => {
        const ed = makeEditor({ names: ['A', 'B'], selected: 'B', solo: false, portalCount: 2, startName: 'A' });
        ed.setWalkthrough(true);
        const before = ed.state();
        await withVideoRenderState(ed.events, async () => true);
        expect(ed.state()).toEqual(before);
        expect(before.walkthrough).toBe(true);
    });
});
