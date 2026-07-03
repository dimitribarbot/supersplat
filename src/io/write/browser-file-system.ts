/**
 * Browser FileSystem implementation for splat-transform compatibility.
 * Provides FileSystem abstraction for browser file operations.
 */

import { type FileSystem, type Writer } from '@playcanvas/splat-transform';

/**
 * Writer implementation for FileSystemWritableFileStream (File System Access API).
 */
class BrowserFileWriter implements Writer {
    private stream: FileSystemWritableFileStream;
    private cursor: number = 0;
    private ready: Promise<void>;

    constructor(stream: FileSystemWritableFileStream) {
        this.stream = stream;
        this.ready = this.stream.seek(0);
    }

    get bytesWritten(): number {
        return this.cursor;
    }

    async write(data: Uint8Array): Promise<void> {
        await this.ready;
        this.cursor += data.byteLength;
        await this.stream.write(data as unknown as ArrayBuffer);
    }

    async close(): Promise<void> {
        await this.ready;
        await this.stream.truncate(this.cursor);
        await this.stream.close();
    }
}

/**
 * Trigger a browser download for the given blob.
 */
const triggerDownload = (blob: Blob, filename: string): void => {
    const url = window.URL.createObjectURL(blob);

    const lnk = document.createElement('a');
    lnk.download = filename;
    lnk.href = url;

    // create a "fake" click-event to trigger the download
    if (document.createEvent) {
        const e = document.createEvent('MouseEvents');
        e.initMouseEvent('click', true, true, window,
            0, 0, 0, 0, 0, false, false, false,
            false, 0, null);
        lnk.dispatchEvent(e);
    } else {
        // @ts-ignore
        lnk.fireEvent?.('onclick');
    }

    window.URL.revokeObjectURL(url);
};

/**
 * Writer implementation that triggers a browser download on close.
 *
 * Collects the written chunks and assembles them into a Blob directly, rather
 * than concatenating into one contiguous buffer. A Blob combines its parts
 * without allocating a single ArrayBuffer for the whole archive, so a large
 * multi-scene save is not bound by the ~2GB typed-array cap that a single-buffer
 * concatenation hits ("Array buffer allocation failed"). Used only on the
 * fallback path (browsers without the File System Access API, e.g. Firefox or
 * Brave with its privacy defaults); the stream path never buffers.
 */
class BrowserDownloadWriter implements Writer {
    private chunks: Uint8Array[] = [];
    private cursor: number = 0;
    private filename: string;

    constructor(filename: string) {
        this.filename = filename;
    }

    get bytesWritten(): number {
        return this.cursor;
    }

    write(data: Uint8Array): void {
        // Snapshot: the PLY serializer flushes one reused scratch buffer, and the
        // caller may keep mutating `data` after this call returns.
        this.chunks.push(data.slice());
        this.cursor += data.byteLength;
    }

    close(): void {
        const blob = new Blob(this.chunks as BlobPart[], { type: 'application/octet-stream' });
        this.chunks = [];
        triggerDownload(blob, this.filename);
    }
}

/**
 * FileSystem implementation for browser environments.
 * Supports both File System Access API (stream) and fallback download.
 */
class BrowserFileSystem implements FileSystem {
    private stream?: FileSystemWritableFileStream;
    private filename: string;

    /**
     * Create a BrowserFileSystem.
     * @param filename - The filename for downloads (fallback mode)
     * @param stream - Optional FileSystemWritableFileStream for direct file access
     */
    constructor(filename: string, stream?: FileSystemWritableFileStream) {
        this.filename = filename;
        this.stream = stream;
    }

    createWriter(_filename: string): Writer {
        if (this.stream) {
            return new BrowserFileWriter(this.stream);
        }
        return new BrowserDownloadWriter(this.filename);
    }

    mkdir(_path: string): Promise<void> {
        // No-op in browser - directories not supported
        return Promise.resolve();
    }
}

export { BrowserFileSystem };
