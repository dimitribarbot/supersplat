import { Vec3 } from 'playcanvas';

import { Events } from './events';

// Force the portal walkthrough on for the duration of a video render.
//
// Why: in a multi-scene portal project every loaded scene renders superimposed
// unless walkthrough is on. Walkthrough keeps exactly one scene visible and
// swaps it as the animated camera crosses a portal (portals-runtime.ts), which
// is precisely what a walkthrough video should show.
//
// Restoring has to satisfy two things at once: the visible set the user could
// see, AND solo's private snapshot of the visibility it will restore to when
// switched off later (splat-list.ts). They are not the same set — solo mode
// lets extra scenes be revealed on top of the soloed one, and those reveals are
// exactly what solo's snapshot does not hold. Hence this order:
//
//   1. walkthrough off - the runtime restores the visibility it snapshotted,
//                        which is the pre-solo set
//   2. solo back on    - re-snapshots that set, so a later solo-off still
//                        reveals the right scenes
//   3. visibility back - the real pre-render visible set, written on top. Safe
//                        now: solo already took its snapshot in step 2
//   4. selection back  - LAST. Walkthrough hides the selected scene when it is
//                        not the start scene, and selection.ts clears the
//                        selection when its splat is hidden; it also refuses to
//                        select a hidden splat, so the splats must be visible
//                        again before this runs
const withWalkthrough = async <T>(events: Events, render: () => Promise<T>): Promise<T> => {
    const portalCount = (events.invoke('portals.count') as number) ?? 0;

    // Nothing to do for a single-scene project, and nothing to restore if the
    // user already has walkthrough on — it is already showing one scene at a
    // time, and solo cannot be on at the same time.
    if (portalCount === 0 || events.invoke('portals.walkthrough.active')) {
        return render();
    }

    const splats = () => (events.invoke('scene.allSplats') as { uid: number; visible: boolean }[]) ?? [];

    const soloWas = !!events.invoke('scene.solo.active');
    const selectionWas = events.invoke('selection') ?? null;
    const visibleWas = new Map(splats().map(s => [s.uid, s.visible]));

    events.fire('portals.walkthrough.set', true);

    try {
        return await render();
    } finally {
        events.fire('portals.walkthrough.set', false);

        if (soloWas) {
            events.fire('scene.solo.set', true);
        }

        splats().forEach((s) => {
            const was = visibleWas.get(s.uid);
            if (was !== undefined && s.visible !== was) {
                s.visible = was;
            }
        });

        if ((events.invoke('selection') ?? null) !== selectionWas) {
            events.fire('selection', selectionWas);
        }
    }
};

// Save and restore everything a video render disturbs.
//
// The camera restore is unconditional, unlike the walkthrough above: src/render.ts
// drives the camera along the animation track and never puts it back — its
// finally block only notes "camera likely moved, finish with normal render".
// For a looping walkthrough the animation ends on (near) its first frame's pose,
// which is where the editor was left stranded. That happens with or without
// portals, so it must sit outside the walkthrough branch.
//
// Ordered after the walkthrough restore on purpose: while walkthrough is still
// on, moving the camera runs the portal crossing test (portals-runtime.ts fires
// on prerender) and could swap which scene is visible. Nesting gives that
// ordering for free — the inner finally settles first.
//
// speed 0 means no fly-to tween: the editor should simply be where it was.
const withVideoRenderState = async <T>(events: Events, render: () => Promise<T>): Promise<T> => {
    const cameraWas = events.invoke('camera.getPose') as
        { position: { x: number, y: number, z: number }, target: { x: number, y: number, z: number }, fov: number } | null;

    // Freeze the on-screen view FIRST — before any state changes — and reveal it
    // LAST. Two separate things would otherwise be visible: the walkthrough/solo
    // swap (scenes appear/disappear, the scene panel's eye icons flip), and then
    // the canvas going black for the whole render, because the video render
    // disables the camera's final pass (camera.ts startOffscreenMode) and
    // nothing is written to the canvas until it is re-enabled.
    await events.invoke('view.freeze');

    try {
        return await withWalkthrough(events, render);
    } finally {
        if (cameraWas) {
            events.fire('camera.setPose', {
                position: new Vec3(cameraWas.position.x, cameraWas.position.y, cameraWas.position.z),
                target: new Vec3(cameraWas.target.x, cameraWas.target.y, cameraWas.target.z),
                fov: cameraWas.fov
            }, 0);
        }

        // after the camera restore, so the reveal never shows the render's
        // final pose
        events.fire('view.unfreeze');
    }
};

export { withVideoRenderState };
