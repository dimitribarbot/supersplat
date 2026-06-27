import { Mat4, Vec3 } from 'playcanvas';

import { ElementType } from './element';
import { Events } from './events';
import { PortalData } from './portals';
import { PortalRect, resolveActiveSplat } from './portal-geom';
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

    const buildRects = (): PortalRect[] => {
        const data = events.invoke('portals.list') as PortalData[];
        return data.map(p => ({
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
    // Mat4.getTranslation() returns the camera's world position as a Vec3.
    events.on('prerender', (cameraWorldTransform: Mat4) => {
        if (!active) {
            return;
        }
        const cur = cameraWorldTransform.getTranslation();
        if (havePrev) {
            const newUid = resolveActiveSplat(
                [prev.x, prev.y, prev.z],
                [cur.x, cur.y, cur.z],
                buildRects(),
                activeUid
            );
            if (newUid !== activeUid) {
                activeUid = newUid;
                applyVisibility();
            }
        }
        prev.copy(cur);
        havePrev = true;
    });

    // If walkthrough is on and all portals get deleted, leaving it on is fine;
    // exiting is the panel toggle's job. Nothing to do on portals.changed here.
};

export { registerPortalsRuntime };
