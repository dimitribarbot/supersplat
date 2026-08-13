import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';

describe('capabilities', () => {
    it('reports video support and the upload limit', async () => {
        const app = await buildApp();
        const res = await app.inject({ method: 'GET', url: '/api/export/capabilities' });
        expect(res.statusCode).toBe(200);

        const body = res.json();
        // Whether ffmpeg exists depends on the machine; the contract is that
        // the fields are always present and correctly typed, so the dialog can
        // rely on them without a defensive undefined check.
        expect(typeof body.video).toBe('boolean');
        expect(typeof body.maxUpload).toBe('number');
        expect(body.maxUpload).toBeGreaterThan(0);

        await app.close();
    });
});
