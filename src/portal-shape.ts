import {
    BLENDEQUATION_ADD,
    BLENDMODE_ONE,
    BLENDMODE_ONE_MINUS_SRC_ALPHA,
    BLENDMODE_SRC_ALPHA,
    CULLFACE_NONE,
    PRIMITIVE_TRIANGLES,
    BlendState,
    Entity,
    Mesh,
    MeshInstance,
    Quat,
    ShaderMaterial
} from 'playcanvas';

import { Element, ElementType } from './element';
import { vertexShader, fragmentShader } from './shaders/off-limits-zone-shader';

// Quad corners in the wall's local XY plane (normal +Z), unit-sized; scaled to
// width x height by the entity transform. This is the same local frame the
// viewer collision math uses (rectangle in local XY, normal local Z), so the
// editor entity needs no orientation-correction: its rotation IS the zone
// rotation, which is what the gizmos read/write.
const CORNERS = [
    -0.5, -0.5, 0,
    0.5, -0.5, 0,
    0.5, 0.5, 0,
    -0.5, 0.5, 0
];
const INDICES = [0, 1, 2, 0, 2, 3];

// Cyan, semi-transparent; brighter when selected (8-bit alpha for setColors32).
const UNSELECTED_ALPHA = 110;
const SELECTED_ALPHA = 190;

// Rendered as a minimal custom-shader mesh (not a StandardMaterial) on the
// dedicated off-limits layer, which draws in its own pass AFTER the splats. The
// fragment shader manually depth-tests each pixel against a per-frame splat
// depth texture, so the wall is a smooth translucent panel that shows splats
// behind it yet is correctly occluded by splats in front of it.
class PortalShape extends Element {
    pivot: Entity;
    mesh: Mesh;
    material: ShaderMaterial;
    meshInstance: MeshInstance;
    _selected = false;

    constructor() {
        super(ElementType.debug);
        this.pivot = new Entity('portal');
    }

    add() {
        const device = this.scene.graphicsDevice;

        this.material = new ShaderMaterial({
            uniqueName: 'portalMaterial',
            vertexGLSL: vertexShader,
            fragmentGLSL: fragmentShader
        });
        // Rendered in the dedicated zone pass (after the splats). Occlusion is
        // done manually in the fragment shader against the splat depth texture,
        // so the hardware depth test/write are both off here.
        this.material.depthTest = false;
        this.material.depthWrite = false;
        // double-sided: the wall is a thin plane, visible from either side.
        this.material.cull = CULLFACE_NONE;
        this.material.blendState = new BlendState(
            true,
            BLENDEQUATION_ADD, BLENDMODE_SRC_ALPHA, BLENDMODE_ONE_MINUS_SRC_ALPHA,
            BLENDEQUATION_ADD, BLENDMODE_ONE, BLENDMODE_ONE_MINUS_SRC_ALPHA
        );
        this.material.update();

        this.mesh = new Mesh(device);
        this.mesh.setPositions(CORNERS);
        this.mesh.setIndices(INDICES);
        this.writeColors();
        this.mesh.update(PRIMITIVE_TRIANGLES);

        this.meshInstance = new MeshInstance(this.mesh, this.material, null);
        this.meshInstance.cull = false;

        this.pivot.addComponent('render', {
            meshInstances: [this.meshInstance],
            layers: [this.scene.offLimitsLayer.id]
        });

        this.scene.contentRoot.addChild(this.pivot);
    }

    remove() {
        this.scene.contentRoot.removeChild(this.pivot);
    }

    destroy() {
        this.pivot?.destroy();
    }

    // Fill the four quad vertices with cyan at the current selection alpha.
    private writeColors() {
        const alpha = this._selected ? SELECTED_ALPHA : UNSELECTED_ALPHA;
        const colors = new Uint8Array(4 * 4);
        for (let i = 0; i < 4; i++) {
            const o = i * 4;
            colors[o] = 0;
            colors[o + 1] = 200;
            colors[o + 2] = 255;
            colors[o + 3] = alpha;
        }
        this.mesh.setColors32(colors);
    }

    // Place the wall: the entity holds the true position/rotation (gizmo target)
    // and scales the unit quad to width x height.
    setTransform(position: number[], rotation: number[], width: number, height: number) {
        this.pivot.setPosition(position[0], position[1], position[2]);
        this.pivot.setRotation(new Quat(rotation[0], rotation[1], rotation[2], rotation[3]));
        this.pivot.setLocalScale(width, height, 1);
    }

    set selected(value: boolean) {
        if (this._selected === value || !this.mesh) {
            this._selected = value;
            return;
        }
        this._selected = value;
        this.writeColors();
        this.mesh.update(PRIMITIVE_TRIANGLES);
    }

    get selected() {
        return this._selected;
    }
}

export { PortalShape };
