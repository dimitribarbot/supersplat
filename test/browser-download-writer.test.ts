import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { BrowserFileSystem } from '../src/io/write/browser-file-system';

// The fallback (non File System Access) save path buffers the whole archive and
// triggers an <a download> of a Blob. These tests pin its observable contract so
// the >2GB-safe refactor (build the Blob from the chunk array instead of one
// contiguous Uint8Array) preserves byte-for-byte output. The OOM fix itself is
// only observable at multi-GB scale, so it is verified by manual E2E.
describe('BrowserFileSystem fallback download writer', () => {
    let capturedBlob: Blob | null;
    let downloadName: string | null;

    beforeEach(() => {
        capturedBlob = null;
        downloadName = null;
        const anchor: any = {
            href: '', download: '',
            dispatchEvent: () => true,
            fireEvent: () => {}
        };
        vi.stubGlobal('document', {
            createElement: () => anchor,
            createEvent: () => ({ initMouseEvent: () => {} })
        });
        vi.stubGlobal('window', {
            URL: {
                createObjectURL: (b: Blob) => { capturedBlob = b; return 'blob:mock'; },
                revokeObjectURL: () => {}
            }
        });
        // capture the requested download filename
        Object.defineProperty(anchor, 'download', {
            get() { return downloadName; },
            set(v: string) { downloadName = v; }
        });
    });

    afterEach(() => vi.unstubAllGlobals());

    it('downloads exactly the bytes written, even when the source buffer is reused/mutated', async () => {
        const fs = new BrowserFileSystem('scene.ssproj'); // no stream -> fallback download writer
        const writer = await fs.createWriter('scene.ssproj');

        // serializePly flushes ONE scratch buffer repeatedly, so the writer must
        // snapshot each chunk. Reuse+mutate the same buffer to catch aliasing.
        const scratch = new Uint8Array(3);
        scratch.set([1, 2, 3]);
        await writer.write(scratch);   // chunk A
        scratch.set([4, 5, 6]);        // mutate the SAME buffer
        await writer.write(scratch);   // chunk B
        expect(writer.bytesWritten).toBe(6);

        await writer.close();

        expect(capturedBlob).not.toBeNull();
        expect(capturedBlob!.size).toBe(6);
        const bytes = new Uint8Array(await capturedBlob!.arrayBuffer());
        // aliased (un-copied) chunks would yield [4,5,6,4,5,6]
        expect([...bytes]).toEqual([1, 2, 3, 4, 5, 6]);
        expect(downloadName).toBe('scene.ssproj');
    });

    it('handles many small chunks (assembled without a single contiguous concat)', async () => {
        const fs = new BrowserFileSystem('big.ssproj');
        const writer = await fs.createWriter('big.ssproj');
        let total = 0;
        for (let i = 0; i < 1000; i++) {
            const chunk = new Uint8Array(64).fill(i & 0xff);
            await writer.write(chunk);
            total += chunk.byteLength;
        }
        expect(writer.bytesWritten).toBe(total);
        await writer.close();
        expect(capturedBlob!.size).toBe(total);
    });
});
