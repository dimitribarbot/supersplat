import { Mat4, Vec3 } from 'playcanvas';

import { ElementType } from './element';
import { Events } from './events';
import { PortalRect, resolveActiveSplat } from './portal-geom';
import { PortalData } from './portals';
import { Scene } from './scene';
import { Splat } from './splat';

// Drives the in-editor multi-scene walkthrough. While walkthrough mode is on,
// only one splat is visible at a time; crossing a portal rectangle swaps which.
// Mode is a non-destructive overlay: it snapshots each splat's visibility on
// enable and restores it on disable.
const registerPortalsRuntime = (events: Events, scene: Scene) => {
    let active = false;
    let activeUid: number | null = null;
    const prev = new Vec3();
    let havePrev = false;
    const snapshot = new Map<number, boolean>();

    const splats = () => scene.getElementsByType(ElementType.splat) as Splat[];

    const applyVisibility = () => {
        splats().forEach((s) => {
            s.visible = s.uid === activeUid;
        });
    };

    // Cached portal rects for the per-frame crossing test. Rebuilt on
    // walkthrough activation and on portals.changed (fired by every portal
    // mutation - see fireChanged() call sites in portals.ts) instead of
    // re-invoking portals.list + re-mapping every prerender frame.
    let rects: PortalRect[] = [];

    const buildRects = () => {
        const data = events.invoke('portals.list') as PortalData[];
        rects = data.map(p => ({
            position: p.position,
            rotation: p.rotation,
            width: p.width,
            height: p.height,
            frontUid: p.frontUid,
            backUid: p.backUid,
            infinite: p.infinite
        }));
    };

    const enable = () => {
        active = true;
        havePrev = false;
        snapshot.clear();
        const list = splats();
        list.forEach(s => snapshot.set(s.uid, s.visible));
        const start = events.invoke('portals.startSplat') as number | null;
        activeUid = (start !== null && list.some(s => s.uid === start)) ? start : (list[0]?.uid ?? null);
        applyVisibility();
        buildRects();
    };

    const disable = () => {
        active = false;
        splats().forEach((s) => {
            const v = snapshot.get(s.uid);
            if (v !== undefined) {
                s.visible = v;
            }
        });
        snapshot.clear();
    };

    events.on('portals.walkthrough', (on: boolean) => {
        if (on === active) {
            return;
        }
        if (on) {
            enable();
        } else {
            disable();
        }
    });

    events.on('scene.clear', () => {
        active = false;
        snapshot.clear();
        havePrev = false;
        activeUid = null;
    });

    // Per-frame: scene.ts fires 'prerender' with this.camera.worldTransform (a Mat4).
    // Mat4.getTranslation(target) writes the camera's world position into the
    // scratch Vec3 (no per-frame allocation); the two tuples are likewise reused.
    const curVec = new Vec3();
    const prevTuple: [number, number, number] = [0, 0, 0];
    const curTuple: [number, number, number] = [0, 0, 0];
    events.on('prerender', (cameraWorldTransform: Mat4) => {
        if (!active) {
            return;
        }
        const cur = cameraWorldTransform.getTranslation(curVec);
        if (havePrev) {
            prevTuple[0] = prev.x; prevTuple[1] = prev.y; prevTuple[2] = prev.z;
            curTuple[0] = cur.x; curTuple[1] = cur.y; curTuple[2] = cur.z;
            const newUid = resolveActiveSplat(prevTuple, curTuple, rects, activeUid);
            if (newUid !== activeUid) {
                activeUid = newUid;
                applyVisibility();
            }
        }
        prev.copy(cur);
        havePrev = true;
    });

    // Keep the cached rects in sync with portal mutations while walkthrough is
    // on (add/remove/update/setStart/entrypoint/clear/deserialize all fire
    // portals.changed). When walkthrough is off the cache is stale by design;
    // enable() rebuilds it on activation. If all portals get deleted the empty
    // cache simply never crosses; exiting is the panel toggle's job.
    events.on('portals.changed', () => {
        if (active) {
            buildRects();
        }
    });
};

export { registerPortalsRuntime };
