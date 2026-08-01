import { describe, it, expect } from 'vitest';

import { safeAnnotationImageName } from '../src/annotation-images.js';

describe('safeAnnotationImageName', () => {
    it('accepts an exporter-produced name', () => {
        expect(safeAnnotationImageName('annimg_3.jpg')).toBe('annimg_3.jpg');
        expect(safeAnnotationImageName('annimg_0.png')).toBe('annimg_0.png');
        expect(safeAnnotationImageName('annimg_12.webp')).toBe('annimg_12.webp');
        expect(safeAnnotationImageName('annimg_1.jpeg')).toBe('annimg_1.jpeg');
    });

    // A multipart part filename is attacker-controllable and becomes a ZIP
    // entry name, so anything that could escape annotations/ or be served as
    // an active document is rejected outright rather than repaired.
    it('rejects traversal and nested paths', () => {
        expect(safeAnnotationImageName('../evil.jpg')).toBeNull();
        expect(safeAnnotationImageName('a/b.jpg')).toBeNull();
        expect(safeAnnotationImageName('..')).toBeNull();
        expect(safeAnnotationImageName('/etc/passwd')).toBeNull();
    });

    it('rejects active-content extensions', () => {
        expect(safeAnnotationImageName('evil.html')).toBeNull();
        expect(safeAnnotationImageName('evil.js')).toBeNull();
        expect(safeAnnotationImageName('evil.svg')).toBeNull();
    });

    it('rejects dotfiles and missing names', () => {
        expect(safeAnnotationImageName('.htaccess')).toBeNull();
        expect(safeAnnotationImageName('')).toBeNull();
        expect(safeAnnotationImageName(undefined)).toBeNull();
    });

    it('rejects an uppercase extension rather than normalising it', () => {
        expect(safeAnnotationImageName('annimg_0.JPG')).toBeNull();
    });

    // A multipart part filename is fully attacker-controllable, so these pin
    // encoding/metacharacter tricks a relaxed regex (e.g. adding '.' to the
    // character class, or adding an /i or /m flag) could reopen silently.
    it('rejects encoding and metacharacter tricks', () => {
        // Windows path separator
        expect(safeAnnotationImageName('a\\b.jpg')).toBeNull();
        // Windows drive letter
        expect(safeAnnotationImageName('C:\\x.jpg')).toBeNull();
        // NTFS alternate-data-stream colon
        expect(safeAnnotationImageName('annimg_0.jpg:evil.html')).toBeNull();
        // embedded NUL byte
        expect(safeAnnotationImageName('annimg_0.jpg\0')).toBeNull();
        // trailing newline -- pins that '$' (no /m flag) does not permit a
        // trailing newline the way it would in some other regex engines
        expect(safeAnnotationImageName('annimg_0.jpg\n')).toBeNull();
        // percent-encoded traversal
        expect(safeAnnotationImageName('%2e%2e%2fevil.jpg')).toBeNull();
    });

    it('rejects double extensions in either order', () => {
        expect(safeAnnotationImageName('evil.html.jpg')).toBeNull();
        expect(safeAnnotationImageName('evil.jpg.html')).toBeNull();
    });

    it('rejects unicode look-alikes and whitespace padding', () => {
        // fullwidth underscore (U+FF3F), not ASCII '_'
        expect(safeAnnotationImageName('annimg\uFF3F0.jpg')).toBeNull();
        // right-to-left override (U+202E)
        expect(safeAnnotationImageName('annimg_0\u202E.jpg')).toBeNull();
        // no extension at all
        expect(safeAnnotationImageName('annimg_0')).toBeNull();
        // leading / trailing whitespace padding
        expect(safeAnnotationImageName(' annimg_0.jpg')).toBeNull();
        expect(safeAnnotationImageName('annimg_0.jpg ')).toBeNull();
    });
});
