// Whitelist for an uploaded annotation-image part filename.
//
// The name arrives from a multipart part and becomes a ZIP entry name under
// annotations/, so it is validated, never repaired: a rejected part fails the
// request. The extension list is deliberately narrower than the browser's
// passthrough set is wide -- an entry that a publish origin would serve as an
// active document (html, js, svg) must not be creatable this way.
const NAME_RE = /^[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/;

export const safeAnnotationImageName = (name: string | undefined): string | null => {
    return (typeof name === 'string' && NAME_RE.test(name)) ? name : null;
};
