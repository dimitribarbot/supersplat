import { Mat4, Quat, Vec3 } from 'playcanvas';

import { solveAlignmentRaw } from './alignment-solve';
import { EntityTransformOp } from './edit-ops';
import { Events } from './events';
import { Scene } from './scene';
import { Splat } from './splat';
import { Transform } from './transform';

type AlignmentMode = 'rigid' | 'similarity';
type AlignmentPickSide = 'source' | 'target';

type AlignmentPoint = {
    position: Vec3;
};

type AlignmentPair = {
    id: number;
    source?: AlignmentPoint;
    target?: AlignmentPoint;
};

type AlignmentSolveResult = {
    rotation: Quat;
    translation: Vec3;
    scale: number;
    rms: number;
    residuals: number[];
};

const tmpMatA = new Mat4();
const tmpMatB = new Mat4();
const tmpMatC = new Mat4();
const tmpVecA = new Vec3();

// thin wrapper over the playcanvas-free solver: pass world points straight
// through (Vec3 satisfies Vec3Like) and lift the raw result back into Quat/Vec3.
const solveAlignment = (source: Vec3[], target: Vec3[], mode: AlignmentMode): AlignmentSolveResult | null => {
    const raw = solveAlignmentRaw(source, target, mode);
    if (!raw) {
        return null;
    }
    return {
        rotation: new Quat(raw.rotation[0], raw.rotation[1], raw.rotation[2], raw.rotation[3]).normalize(),
        translation: new Vec3(raw.translation[0], raw.translation[1], raw.translation[2]),
        scale: raw.scale,
        rms: raw.rms,
        residuals: raw.residuals
    };
};

class AlignmentManager {
    events: Events;
    scene: Scene;
    source: Splat | null = null;
    target: Splat | null = null;
    pairs: AlignmentPair[] = [];
    pickSide: AlignmentPickSide = 'source';
    mode: AlignmentMode = 'rigid';
    previewActive = false;
    previewOld: Transform | null = null;
    lastResult: AlignmentSolveResult | null = null;
    selected: { id: number, side: AlignmentPickSide } | null = null;
    private nextPairId = 1;

    constructor(events: Events, scene: Scene) {
        this.events = events;
        this.scene = scene;

        events.on('scene.elementRemoved', (element) => {
            const removedAlignmentSplat = element === this.source || element === this.target;
            if (removedAlignmentSplat) {
                this.revertPreview();
            }
            if (element === this.source) this.source = null;
            if (element === this.target) this.target = null;
            if (removedAlignmentSplat) {
                this.selected = null;
                this.pairs = [];
                this.changed();
            }
        });

        events.on('edit.apply', () => {
            this.changed();
        });
    }

    private changed() {
        this.lastResult = this.solve();
        this.events.fire('alignment.changed');
        this.scene.forceRender = true;
    }

    completePairs() {
        return this.pairs.filter(pair => pair.source && pair.target);
    }

    setSource(splat: Splat | null) {
        if (this.source !== splat) {
            this.revertPreview();
            this.source = splat;
            this.changed();
        }
    }

    setTarget(splat: Splat | null) {
        if (this.target !== splat) {
            this.revertPreview();
            this.target = splat;
            this.changed();
        }
    }

    setMode(mode: AlignmentMode) {
        if (this.mode !== mode) {
            this.revertPreview();
            this.mode = mode;
            this.changed();
        }
    }

    setPickSide(side: AlignmentPickSide) {
        this.pickSide = side;
        this.events.fire('alignment.changed');
    }

    selectPoint(id: number, side: AlignmentPickSide) {
        this.selected = { id, side };
        this.events.fire('alignment.changed');
    }

    clearSelection() {
        if (this.selected) {
            this.selected = null;
            this.events.fire('alignment.changed');
        }
    }

    // move the selected/given point: convert a world position back into the
    // owning splat's local space (where alignment points are stored). Used by
    // the translate gizmo during a drag — does not re-solve (caller does that
    // on release via commitMove).
    setPointWorld(id: number, side: AlignmentPickSide, world: Vec3) {
        const splat = side === 'source' ? this.source : this.target;
        const pair = this.pairs.find(p => p.id === id);
        if (!splat || !pair || !pair[side]) {
            return;
        }
        tmpMatA.copy(splat.worldTransform).invert();
        tmpMatA.transformPoint(world, tmpVecA);
        pair[side].position.copy(tmpVecA);
    }

    commitMove() {
        this.changed();
    }

    swapSourceTarget() {
        this.revertPreview();
        this.selected = null;

        const source = this.source;
        this.source = this.target;
        this.target = source;

        for (const pair of this.pairs) {
            const point = pair.source;
            pair.source = pair.target;
            pair.target = point;
        }

        this.changed();
    }

    addPickedPoint(splat: Splat, worldPosition: Vec3) {
        if (!this.source || !this.target) {
            return;
        }

        const side = this.pickSide;
        const expectedSplat = side === 'source' ? this.source : this.target;
        if (splat !== expectedSplat) {
            return;
        }

        this.revertPreview();

        tmpMatA.copy(splat.worldTransform).invert();
        tmpMatA.transformPoint(worldPosition, tmpVecA);

        let pair = this.pairs[this.pairs.length - 1];
        if (!pair || pair[side]) {
            pair = { id: this.nextPairId++ };
            this.pairs.push(pair);
        }

        pair[side] = { position: tmpVecA.clone() };
        this.changed();
    }

    deletePair(id: number) {
        this.revertPreview();
        if (this.selected?.id === id) {
            this.selected = null;
        }
        this.pairs = this.pairs.filter(pair => pair.id !== id);
        this.changed();
    }

    // remove a single point of a pair (used to redo just one side); the pair is
    // dropped entirely only if it ends up with neither a source nor a target.
    removePoint(id: number, side: AlignmentPickSide) {
        this.revertPreview();
        const pair = this.pairs.find(p => p.id === id);
        if (!pair || !pair[side]) {
            return;
        }
        if (this.selected?.id === id && this.selected.side === side) {
            this.selected = null;
        }
        delete pair[side];
        if (!pair.source && !pair.target) {
            this.pairs = this.pairs.filter(p => p.id !== id);
        }
        this.changed();
    }

    movePair(id: number, direction: -1 | 1) {
        const index = this.pairs.findIndex(pair => pair.id === id);
        const next = index + direction;
        if (index < 0 || next < 0 || next >= this.pairs.length) {
            return;
        }
        const pair = this.pairs[index];
        this.pairs[index] = this.pairs[next];
        this.pairs[next] = pair;
        this.changed();
    }

    clearPairs() {
        this.revertPreview();
        this.selected = null;
        this.pairs = [];
        this.changed();
    }

    pairWorldPoint(pair: AlignmentPair, side: AlignmentPickSide, result: Vec3) {
        const splat = side === 'source' ? this.source : this.target;
        const point = pair[side];
        if (!splat || !point) {
            return null;
        }
        return splat.worldTransform.transformPoint(point.position, result);
    }

    solve() {
        if (!this.source || !this.target) {
            return null;
        }

        const pairs = this.completePairs();
        if (pairs.length < 4) {
            return null;
        }

        const sourcePoints: Vec3[] = [];
        const targetPoints: Vec3[] = [];
        for (const pair of pairs) {
            sourcePoints.push(this.pairWorldPoint(pair, 'source', new Vec3()));
            targetPoints.push(this.pairWorldPoint(pair, 'target', new Vec3()));
        }

        return solveAlignment(sourcePoints, targetPoints, this.mode);
    }

    private calculateNewTransform(result: AlignmentSolveResult) {
        if (!this.source) {
            return null;
        }

        const oldWorld = this.source.worldTransform.clone();
        tmpMatA.setTRS(result.translation, result.rotation, tmpVecA.set(result.scale, result.scale, result.scale));
        tmpMatB.mul2(tmpMatA, oldWorld);
        tmpMatC.copy(this.scene.contentRoot.getWorldTransform()).invert();
        tmpMatB.mul2(tmpMatC, tmpMatB);

        const position = new Vec3();
        const rotation = new Quat();
        const scale = new Vec3();
        tmpMatB.getTranslation(position);
        rotation.setFromMat4(tmpMatB);
        tmpMatB.getScale(scale);

        return new Transform(position, rotation, scale);
    }

    preview() {
        if (!this.source) {
            return;
        }

        if (!this.previewActive) {
            this.previewOld = new Transform(
                this.source.entity.getLocalPosition().clone(),
                this.source.entity.getLocalRotation().clone(),
                this.source.entity.getLocalScale().clone()
            );
        } else if (this.previewOld) {
            this.source.move(this.previewOld.position, this.previewOld.rotation, this.previewOld.scale);
        }

        const result = this.solve();
        if (!result) {
            this.previewActive = false;
            this.previewOld = null;
            this.changed();
            return;
        }

        const next = this.calculateNewTransform(result);
        if (next) {
            this.source.move(next.position, next.rotation, next.scale);
            this.previewActive = true;
            this.lastResult = result;
            this.events.fire('alignment.changed');
            this.scene.forceRender = true;
        }
    }

    revertPreview() {
        if (this.previewActive && this.source && this.previewOld) {
            this.source.move(this.previewOld.position, this.previewOld.rotation, this.previewOld.scale);
        }
        this.previewActive = false;
        this.previewOld = null;
    }

    apply() {
        if (!this.source) {
            return;
        }

        if (this.previewActive && this.previewOld) {
            const op = new EntityTransformOp({
                splat: this.source,
                oldt: this.previewOld,
                newt: new Transform(
                    this.source.entity.getLocalPosition().clone(),
                    this.source.entity.getLocalRotation().clone(),
                    this.source.entity.getLocalScale().clone()
                )
            });
            this.previewActive = false;
            this.previewOld = null;
            this.events.fire('edit.add', op, true);
            this.changed();
            return;
        }

        const result = this.solve();
        if (!result) {
            return;
        }

        const next = this.calculateNewTransform(result);
        if (!next) {
            return;
        }

        const oldt = new Transform(
            this.source.entity.getLocalPosition().clone(),
            this.source.entity.getLocalRotation().clone(),
            this.source.entity.getLocalScale().clone()
        );
        this.source.move(next.position, next.rotation, next.scale);

        this.events.fire('edit.add', new EntityTransformOp({
            splat: this.source,
            oldt,
            newt: next
        }), true);
        this.changed();
    }
}

export {
    AlignmentManager,
    AlignmentMode,
    AlignmentPair,
    AlignmentPickSide,
    AlignmentSolveResult
};
