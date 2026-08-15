import { describe, it, expect } from 'vitest';

import { collisionRows, collisionSceneIndex, formatBytes, COLLISION_OVERSIZE_BYTES } from '../src/collision-size-report';

describe('collisionSceneIndex', () => {
    it('maps the primary scene binary to index 0', () => {
        expect(collisionSceneIndex('index.voxel.bin')).toBe(0);
    });

    it('maps a namespaced extra scene binary to its index', () => {
        expect(collisionSceneIndex('scenes/1/scene.voxel.bin')).toBe(1);
        expect(collisionSceneIndex('scenes/12/scene.voxel.bin')).toBe(12);
    });

    it('ignores the json sidecar, other files and near-misses', () => {
        expect(collisionSceneIndex('index.voxel.json')).toBeNull();
        expect(collisionSceneIndex('scenes/1/scene.voxel.json')).toBeNull();
        expect(collisionSceneIndex('index.html')).toBeNull();
        expect(collisionSceneIndex('scenes/1/lod-meta.json')).toBeNull();
        expect(collisionSceneIndex('a/index.voxel.bin')).toBeNull();
        expect(collisionSceneIndex('scenes/x/scene.voxel.bin')).toBeNull();
    });
});

describe('formatBytes', () => {
    it('formats across units with one decimal', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(1536)).toBe('1.5 KB');
        expect(formatBytes(3682632)).toBe('3.5 MB');
        expect(formatBytes(39375284)).toBe('37.6 MB');
    });
});

describe('COLLISION_OVERSIZE_BYTES', () => {
    it('is 15 MB', () => {
        expect(COLLISION_OVERSIZE_BYTES).toBe(15 * 1024 * 1024);
    });
});

describe('collisionRows', () => {
    it('sorts ascending by scene index from out-of-order input', () => {
        const sizes = new Map<number, number>([
            [2, 300],
            [0, 100],
            [1, 200]
        ]);
        const rows = collisionRows(sizes, ['start', 'middle', 'end']);
        expect(rows.map(r => r.sceneIndex)).toEqual([0, 1, 2]);
        expect(rows).toEqual([
            { sceneIndex: 0, name: 'start', bytes: 100 },
            { sceneIndex: 1, name: 'middle', bytes: 200 },
            { sceneIndex: 2, name: 'end', bytes: 300 }
        ]);
    });

    it('falls back to #N when the scene name is missing', () => {
        const sizes = new Map<number, number>([[0, 100], [3, 400]]);
        const rows = collisionRows(sizes, ['start']);
        expect(rows).toEqual([
            { sceneIndex: 0, name: 'start', bytes: 100 },
            { sceneIndex: 3, name: '#3', bytes: 400 }
        ]);
    });

    it('returns an empty array for an empty map', () => {
        expect(collisionRows(new Map(), [])).toEqual([]);
    });
});
