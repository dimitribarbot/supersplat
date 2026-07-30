# Exported Viewer iframe Annotation API — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a host page drive the exported viewer from outside its iframe — "go to the Bedroom annotation" — flying the camera (and swapping portal scene if needed) without reloading anything.

**Architecture:** A new `viewer-companion` module bakes a small annotation table plus a stringified runtime into every exported HTML file. The runtime listens for `postMessage`, resolves the host's reference to an index, and fires the viewer's existing `annotation.navigate` event — which already flies the camera and, via the portals companion, swaps scenes. Pure resolution logic lives in unit-tested TypeScript and is injected into the runtime with `Function.prototype.toString()`, the pattern `off-limits-zones.ts` and `portals.ts` already use.

**Tech Stack:** TypeScript, Rollup, Vitest (node environment), PlayCanvas splat-transform viewer bundle.

**Spec:** `docs/superpowers/specs/2026-07-30-viewer-iframe-annotation-api-design.md`

## Global Constraints

- **No backslash escapes in the runtime string.** The companion runtime lives inside a TypeScript template literal, which consumes backslash escapes at build time. No regex literals, no `\n`, no backticks in the runtime body — string operations only. Non-ASCII, if ever needed, must be written as pre-escaped `\\uXXXX` (see `annotation-links.ts`).
- **Helpers injected via `Function.prototype.toString()` must be self-contained.** No references to module-level constants, imports or closure variables.
- **Message type prefix is `supersplat:`.** Inbound types accepted: `supersplat:annotation.goto`, `supersplat:annotation.list`, `supersplat:ping`. Outbound types emitted: `supersplat:annotation.goto.result`, `supersplat:annotation.list.result`, `supersplat:ready`, `supersplat:annotation.activated`, `supersplat:annotation.deactivated`. Nothing else is read or written.
- **Failure `reason` values:** `not-found`, `bad-request`, `unavailable`. No others.
- **Subscriber cap:** 8, oldest dropped.
- **Soft-fail everywhere.** The message handler never throws; a missing viewer handle degrades to `unavailable`, never to a broken export.
- **Lint:** `npm run lint` must pass. Match surrounding import ordering — do NOT reorder imports (ESLint's `import/order` autofix crashes in this repo).
- **Tests:** `npm run test` must pass. Run it in the foreground and never pipe its output to `grep` (vitest hangs when backgrounded or piped).

---

### Task 1: Bake the annotation id into the export

The `{id: 'annotation_3'}` lookup form needs a stable id in the exported settings. The editor already generates and persists `annotation_0`, `annotation_1`, … (`genId`, `src/annotations.ts:129`) but `annotations.export` drops it.

**Files:**
- Modify: `src/annotations.ts:35-41` (the `AnnotationExport` type) and `src/annotations.ts:213-217` (the `extras` object literal)
- Test: `test/annotations.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: exported annotations now carry `extras.id: string`. Task 2's `buildAnnotationIndex` reads it.

- [ ] **Step 1: Write the failing test**

Append to `test/annotations.test.ts` (the `annotation()` factory and `makeEvents()` helper already exist at the top of that file):

```typescript
describe('annotations.export id', () => {
    it('bakes the stable annotation id into extras', () => {
        const events = makeEvents();
        registerAnnotationsEvents(events);
        new AddAnnotationOp(events, annotation({ id: 'annotation_7' })).do();
        const out = events.invoke('annotations.export');
        expect(out[0].extras.id).toBe('annotation_7');
    });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/annotations.test.ts -t "bakes the stable annotation id"`
Expected: FAIL — `expected undefined to be 'annotation_7'`.

- [ ] **Step 3: Add `id` to the export type**

In `src/annotations.ts`, change the `AnnotationExport` type's `extras` field from:

```typescript
    extras: { url?: string, newTab?: boolean, scene?: number }
```

to:

```typescript
    extras: { url?: string, newTab?: boolean, scene?: number, id?: string }
```

- [ ] **Step 4: Emit `id` from `annotations.export`**

In `src/annotations.ts`, inside the `annotations.export` function, change the `extras` object literal from:

```typescript
                extras: {
                    url: a.url || undefined,
                    newTab: a.url ? a.newTab : undefined,
                    scene: scene ?? undefined
                }
```

to:

```typescript
                extras: {
                    url: a.url || undefined,
                    newTab: a.url ? a.newTab : undefined,
                    scene: scene ?? undefined,
                    id: a.id
                }
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run test/annotations.test.ts`
Expected: PASS, including the pre-existing `annotations.export scene index` cases.

- [ ] **Step 6: Lint**

Run: `npm run lint`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/annotations.ts test/annotations.test.ts
git commit -m "feat(annotations): bake the stable annotation id into the export"
```

---

### Task 2: Pure annotation index and reference resolver

The baked table and the resolver are plain data/logic with no DOM or viewer involvement, so they are unit-tested directly. The resolver is written self-contained because Task 3 injects it into the runtime via `Function.prototype.toString()`.

**Files:**
- Create: `src/viewer-companion/iframe-api.ts`
- Create: `test/viewer-iframe-api.test.ts`

**Interfaces:**
- Consumes: `extras.id` from Task 1.
- Produces:
  - `type AnnotationEntry = { index: number, id: string, title: string, text: string, scene: number | null }`
  - `type AnnotationRef = { name?: unknown, id?: unknown, index?: unknown }`
  - `buildAnnotationIndex(annotations: AnyAnnotation[]): AnnotationEntry[]`
  - `resolveAnnotationRef(table: AnnotationEntry[], ref: AnnotationRef): { index: number, reason: string }` — `reason` is `''` on success, `'not-found'` or `'bad-request'` on failure, and `index` is `-1` on failure.

  Task 3 injects `resolveAnnotationRef` into the runtime and re-exports `buildIframeApiInjection` from the same file.

- [ ] **Step 1: Write the failing tests**

Create `test/viewer-iframe-api.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

import { buildAnnotationIndex, resolveAnnotationRef } from '../src/viewer-companion/iframe-api';

describe('buildAnnotationIndex', () => {
    it('produces one entry per annotation in settings order', () => {
        expect(buildAnnotationIndex([
            { title: 'Bedroom', text: 'the bed', extras: { id: 'annotation_0', scene: 1 } },
            { title: 'Kitchen', text: '', extras: { id: 'annotation_1' } }
        ])).toEqual([
            { index: 0, id: 'annotation_0', title: 'Bedroom', text: 'the bed', scene: 1 },
            { index: 1, id: 'annotation_1', title: 'Kitchen', text: '', scene: null }
        ]);
    });

    it('tolerates annotations with no extras and no title', () => {
        expect(buildAnnotationIndex([{}])).toEqual([
            { index: 0, id: '', title: '', text: '', scene: null }
        ]);
    });

    it('ignores non-string titles and non-numeric scenes', () => {
        const table = buildAnnotationIndex([
            { title: 42 as any, extras: { id: 'annotation_0', scene: 'x' as any } }
        ]);
        expect(table[0].title).toBe('');
        expect(table[0].scene).toBeNull();
    });

    it('returns an empty table for an empty annotation list', () => {
        expect(buildAnnotationIndex([])).toEqual([]);
    });
});

describe('resolveAnnotationRef', () => {
    const table = buildAnnotationIndex([
        { title: 'Bedroom', text: '', extras: { id: 'annotation_0', scene: 0 } },
        { title: '  Kitchen  ', text: '', extras: { id: 'annotation_1', scene: 1 } },
        { title: 'Bedroom', text: '', extras: { id: 'annotation_2', scene: 2 } }
    ]);

    it('resolves an exact id', () => {
        expect(resolveAnnotationRef(table, { id: 'annotation_2' })).toEqual({ index: 2, reason: '' });
    });

    it('resolves a numeric index', () => {
        expect(resolveAnnotationRef(table, { index: 1 })).toEqual({ index: 1, reason: '' });
    });

    it('resolves a title ignoring case and surrounding whitespace', () => {
        expect(resolveAnnotationRef(table, { name: '  kITCHEN ' })).toEqual({ index: 1, reason: '' });
    });

    it('resolves a duplicate title to the first matching annotation', () => {
        expect(resolveAnnotationRef(table, { name: 'Bedroom' })).toEqual({ index: 0, reason: '' });
    });

    it('prefers id over index over name', () => {
        expect(resolveAnnotationRef(table, { id: 'annotation_2', index: 1, name: 'Kitchen' }))
        .toEqual({ index: 2, reason: '' });
        expect(resolveAnnotationRef(table, { index: 1, name: 'Bedroom' }))
        .toEqual({ index: 1, reason: '' });
    });

    it('falls through to the next form when an earlier one does not match', () => {
        expect(resolveAnnotationRef(table, { id: 'nope', name: 'Kitchen' }))
        .toEqual({ index: 1, reason: '' });
    });

    it('reports not-found for an unknown name', () => {
        expect(resolveAnnotationRef(table, { name: 'Garage' })).toEqual({ index: -1, reason: 'not-found' });
    });

    it('reports not-found for an out-of-range or negative index', () => {
        expect(resolveAnnotationRef(table, { index: 9 })).toEqual({ index: -1, reason: 'not-found' });
        expect(resolveAnnotationRef(table, { index: -1 })).toEqual({ index: -1, reason: 'not-found' });
    });

    it('ignores a non-finite index rather than treating it as a hit', () => {
        expect(resolveAnnotationRef(table, { index: NaN })).toEqual({ index: -1, reason: 'bad-request' });
    });

    it('reports bad-request when no usable reference is supplied', () => {
        expect(resolveAnnotationRef(table, {})).toEqual({ index: -1, reason: 'bad-request' });
        expect(resolveAnnotationRef(table, { name: '   ' })).toEqual({ index: -1, reason: 'bad-request' });
        expect(resolveAnnotationRef(table, { id: '' })).toEqual({ index: -1, reason: 'bad-request' });
    });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/viewer-iframe-api.test.ts`
Expected: FAIL — cannot resolve `../src/viewer-companion/iframe-api`.

- [ ] **Step 3: Write the module**

Create `src/viewer-companion/iframe-api.ts`:

```typescript
// Export-shaped annotation, as it appears in viewerSettingsJson.annotations
// (produced by annotations.export in src/annotations.ts).
type AnyAnnotation = {
    title?: string,
    text?: string,
    extras?: { id?: string, scene?: number }
};

// One baked table entry. Deliberately the exact shape sent back to the host in
// annotation.list.result / annotation.goto.result, so replies need no field
// stripping. `index` is the join key back into the live viewer array
// (viewer.global.settings.annotations): the viewer's internal scriptMap is keyed
// by object identity, so annotation.navigate must be fired with the viewer's own
// annotation object, not a copy.
type AnnotationEntry = {
    index: number,
    id: string,
    title: string,
    text: string,
    scene: number | null
};

// A host's reference to an annotation, taken straight off the postMessage
// payload -- so every field is untrusted and must be type-checked.
type AnnotationRef = {
    name?: unknown,
    id?: unknown,
    index?: unknown
};

// Bake the table the runtime companion consumes. Order matches
// viewerSettingsJson.annotations exactly, which is what makes `index` a valid
// join key at runtime.
const buildAnnotationIndex = (annotations: AnyAnnotation[]): AnnotationEntry[] => {
    return (annotations || []).map((a, i) => {
        const extras = (a && a.extras) || {};
        return {
            index: i,
            id: typeof extras.id === 'string' ? extras.id : '',
            title: (a && typeof a.title === 'string') ? a.title : '',
            text: (a && typeof a.text === 'string') ? a.text : '',
            scene: typeof extras.scene === 'number' ? extras.scene : null
        };
    });
};

// Pure reference resolver. Tries id, then index, then name (the title, compared
// case- and surrounding-whitespace-insensitively); the first hit wins, so a host
// may send several forms and the strongest available one is used. Duplicate
// titles are legal in the editor: the first match wins, by documented design.
//
// bad-request means no usable reference was supplied at all; not-found means one
// was, but nothing matched. Self-contained (no module-level references) so it is
// also injected verbatim into the runtime via Function.toString().
const resolveAnnotationRef = (table: AnnotationEntry[], ref: AnnotationRef): { index: number, reason: string } => {
    const entries = table || [];
    const r = ref || {};
    let usable = false;
    if (typeof r.id === 'string' && r.id !== '') {
        usable = true;
        for (let i = 0; i < entries.length; i++) {
            if (entries[i].id === r.id) {
                return { index: i, reason: '' };
            }
        }
    }
    if (typeof r.index === 'number' && isFinite(r.index)) {
        usable = true;
        const idx = Math.floor(r.index);
        if (idx >= 0 && idx < entries.length) {
            return { index: idx, reason: '' };
        }
    }
    if (typeof r.name === 'string' && r.name.trim() !== '') {
        usable = true;
        const want = r.name.trim().toLowerCase();
        for (let i = 0; i < entries.length; i++) {
            if (entries[i].title.trim().toLowerCase() === want) {
                return { index: i, reason: '' };
            }
        }
    }
    return { index: -1, reason: usable ? 'not-found' : 'bad-request' };
};

export { buildAnnotationIndex, resolveAnnotationRef };
export type { AnnotationEntry, AnnotationRef, AnyAnnotation };
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/viewer-iframe-api.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/viewer-companion/iframe-api.ts test/viewer-iframe-api.test.ts
git commit -m "feat(viewer): pure annotation index and reference resolver for the iframe API"
```

---

### Task 3: The runtime companion and its injection

The postMessage bridge itself. It ships as a stringified runtime, so it is tested the way `test/annotation-links.test.ts` tests its companion: pull the emitted script out of the injection fragment and execute it against fakes with `new Function`.

**Files:**
- Modify: `src/viewer-companion/iframe-api.ts` (append the runtime and the injection builder)
- Modify: `test/viewer-iframe-api.test.ts` (append the runtime suite)

**Interfaces:**
- Consumes: `buildAnnotationIndex`, `resolveAnnotationRef`, `AnnotationEntry`, `AnyAnnotation` from Task 2.
- Produces: `buildIframeApiInjection(annotations: AnyAnnotation[]): string` — always returns a non-empty fragment (two `<script>` tags: the table assignment to `window.__supersplatIframeApi`, then the runtime). Task 4 calls it.

- [ ] **Step 1: Write the failing tests**

Append to `test/viewer-iframe-api.test.ts`. Also extend the import at the top of the file to:

```typescript
import { buildAnnotationIndex, buildIframeApiInjection, resolveAnnotationRef } from '../src/viewer-companion/iframe-api';
```

Then append:

```typescript
// The bridge ships as a stringified runtime, so the only honest way to test it
// is to execute the string the exporter actually emits. These fakes cover just
// the window/viewer surface it touches.

// A host window. postMessage throws on the string 'null' the way a real browser
// does for an opaque origin, which is what the runtime's '*' fallback exists for.
const makeHost = () => {
    const sent: { message: any, origin: string }[] = [];
    return {
        sent,
        postMessage(message: any, origin: string) {
            if (origin === 'null') {
                throw new SyntaxError('Invalid target origin');
            }
            sent.push({ message, origin });
        }
    };
};

const makeViewer = (annotations: any[]) => {
    const handlers: Record<string, ((...args: any[]) => void)[]> = {};
    const events = {
        on: (name: string, fn: (...args: any[]) => void) => {
            (handlers[name] ??= []).push(fn);
        },
        fire: (name: string, ...args: any[]) => {
            (handlers[name] ?? []).forEach(fn => fn(...args));
        }
    };
    const state = { loaded: false };
    const parent = makeHost();
    const messageListeners: ((e: any) => void)[] = [];

    const window: any = {
        parent,
        __supersplatIframeApi: [] as any[],
        __supersplatViewer: { global: { events, settings: { annotations }, state } },
        addEventListener: (name: string, fn: any) => {
            if (name === 'message') {
                messageListeners.push(fn);
            }
        }
    };

    const document = { readyState: 'complete', addEventListener: () => {} };

    // Deliver a message event to the runtime, as a browser would.
    const send = (source: any, data: any, origin = 'https://host.test') => {
        messageListeners.forEach(fn => fn({ data, source, origin }));
    };

    return { window, document, events, state, parent, send, handlers };
};

// Run the emitted runtime against the fakes. rAF is queued rather than immediate:
// the runtime re-polls itself until the viewer reports ready, so an immediate rAF
// would recurse forever. `tick` drains one frame.
const runBridge = (annotations: any[], v: ReturnType<typeof makeViewer>) => {
    const injection = buildIframeApiInjection(annotations);
    const scripts = [...injection.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    v.window.__supersplatIframeApi = buildAnnotationIndex(annotations);
    let queue: (() => void)[] = [];
    const requestAnimationFrame = (fn: () => void) => {
        queue.push(fn);
    };
    // the last script is the runtime; the first only assigns the table
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'requestAnimationFrame', scripts[scripts.length - 1])(
        v.window, v.document, requestAnimationFrame
    );
    return {
        tick: () => {
            const q = queue;
            queue = [];
            q.forEach(fn => fn());
        }
    };
};

const ANNOTATIONS = [
    { title: 'Bedroom', text: 'the bed', position: [0, 0, 0], extras: { id: 'annotation_0', scene: 0 } },
    { title: 'Kitchen', text: '', position: [1, 0, 0], extras: { id: 'annotation_1', scene: 1 } }
];

const messagesOf = (host: ReturnType<typeof makeHost>, type: string) =>
    host.sent.filter(s => s.message.type === type);

describe('iframe api runtime', () => {
    it('broadcasts ready to the parent on firstFrame', () => {
        const v = makeViewer(ANNOTATIONS);
        runBridge(ANNOTATIONS, v);

        expect(messagesOf(v.parent, 'supersplat:ready')).toHaveLength(0);
        v.events.fire('firstFrame');

        expect(messagesOf(v.parent, 'supersplat:ready')).toHaveLength(1);
        expect(v.parent.sent[0].origin).toBe('*');
    });

    it('treats state.loaded observed on a poll tick as ready', () => {
        const v = makeViewer(ANNOTATIONS);
        const { tick } = runBridge(ANNOTATIONS, v);

        v.state.loaded = true;
        tick();

        expect(messagesOf(v.parent, 'supersplat:ready')).toHaveLength(1);
    });

    it('navigates to an annotation by name with the viewer own annotation object', () => {
        const v = makeViewer(ANNOTATIONS);
        runBridge(ANNOTATIONS, v);
        v.events.fire('firstFrame');
        const navigated: any[] = [];
        v.events.on('annotation.navigate', (ann: any) => navigated.push(ann));

        const host = makeHost();
        v.send(host, { type: 'supersplat:annotation.goto', name: 'kitchen', requestId: 'r1' });

        expect(navigated).toHaveLength(1);
        expect(navigated[0]).toBe(ANNOTATIONS[1]);
        expect(host.sent[0].message).toEqual({
            type: 'supersplat:annotation.goto.result',
            requestId: 'r1',
            ok: true,
            annotation: { index: 1, id: 'annotation_1', title: 'Kitchen', text: '', scene: 1 }
        });
        expect(host.sent[0].origin).toBe('https://host.test');
    });

    it('reports not-found for an unknown annotation and navigates nowhere', () => {
        const v = makeViewer(ANNOTATIONS);
        runBridge(ANNOTATIONS, v);
        v.events.fire('firstFrame');
        const navigated: any[] = [];
        v.events.on('annotation.navigate', (ann: any) => navigated.push(ann));

        const host = makeHost();
        v.send(host, { type: 'supersplat:annotation.goto', name: 'Garage' });

        expect(navigated).toHaveLength(0);
        expect(host.sent[0].message.ok).toBe(false);
        expect(host.sent[0].message.reason).toBe('not-found');
    });

    it('reports bad-request when no reference is supplied', () => {
        const v = makeViewer(ANNOTATIONS);
        runBridge(ANNOTATIONS, v);
        v.events.fire('firstFrame');

        const host = makeHost();
        v.send(host, { type: 'supersplat:annotation.goto' });

        expect(host.sent[0].message.reason).toBe('bad-request');
    });

    it('reports unavailable when the viewer exposes no annotation array', () => {
        const v = makeViewer(ANNOTATIONS);
        runBridge(ANNOTATIONS, v);
        v.events.fire('firstFrame');
        v.window.__supersplatViewer.global.settings = {};

        const host = makeHost();
        v.send(host, { type: 'supersplat:annotation.goto', name: 'Bedroom' });

        expect(host.sent[0].message.reason).toBe('unavailable');
    });

    it('answers a list request with the baked table', () => {
        const v = makeViewer(ANNOTATIONS);
        runBridge(ANNOTATIONS, v);
        v.events.fire('firstFrame');

        const host = makeHost();
        v.send(host, { type: 'supersplat:annotation.list', requestId: 'L' });

        expect(host.sent[0].message).toEqual({
            type: 'supersplat:annotation.list.result',
            requestId: 'L',
            annotations: buildAnnotationIndex(ANNOTATIONS)
        });
    });

    it('answers a ping with ready', () => {
        const v = makeViewer(ANNOTATIONS);
        runBridge(ANNOTATIONS, v);
        v.events.fire('firstFrame');

        const host = makeHost();
        v.send(host, { type: 'supersplat:ping', requestId: 'P' });

        expect(host.sent[0].message).toEqual({ type: 'supersplat:ready', requestId: 'P' });
    });

    it('queues a goto sent before ready and flushes the last one', () => {
        const v = makeViewer(ANNOTATIONS);
        runBridge(ANNOTATIONS, v);
        const navigated: any[] = [];
        v.events.on('annotation.navigate', (ann: any) => navigated.push(ann));

        const host = makeHost();
        v.send(host, { type: 'supersplat:annotation.goto', name: 'Bedroom' });
        v.send(host, { type: 'supersplat:annotation.goto', name: 'Kitchen' });
        expect(navigated).toHaveLength(0);

        v.events.fire('firstFrame');

        expect(navigated).toEqual([ANNOTATIONS[1]]);
    });

    it('queues a list request sent before ready', () => {
        const v = makeViewer(ANNOTATIONS);
        runBridge(ANNOTATIONS, v);

        const host = makeHost();
        v.send(host, { type: 'supersplat:annotation.list' });
        expect(host.sent).toHaveLength(0);

        v.events.fire('firstFrame');

        expect(messagesOf(host, 'supersplat:annotation.list.result')).toHaveLength(1);
    });

    it('notifies subscribers when an annotation is activated from inside the viewer', () => {
        const v = makeViewer(ANNOTATIONS);
        runBridge(ANNOTATIONS, v);
        v.events.fire('firstFrame');
        const host = makeHost();
        v.send(host, { type: 'supersplat:ping' });

        v.events.fire('annotation.activate', ANNOTATIONS[0]);
        v.events.fire('annotation.deactivate');

        expect(messagesOf(host, 'supersplat:annotation.activated')[0].message).toEqual({
            type: 'supersplat:annotation.activated',
            index: 0,
            id: 'annotation_0',
            title: 'Bedroom',
            scene: 0
        });
        expect(messagesOf(host, 'supersplat:annotation.deactivated')).toHaveLength(1);
    });

    it('does not notify a window that has never messaged the viewer', () => {
        const v = makeViewer(ANNOTATIONS);
        runBridge(ANNOTATIONS, v);
        v.events.fire('firstFrame');
        const silent = makeHost();

        v.events.fire('annotation.activate', ANNOTATIONS[0]);

        expect(silent.sent).toHaveLength(0);
    });

    it('caps the subscriber list at 8, dropping the oldest', () => {
        const v = makeViewer(ANNOTATIONS);
        runBridge(ANNOTATIONS, v);
        v.events.fire('firstFrame');
        const hosts = Array.from({ length: 9 }, () => makeHost());
        hosts.forEach(h => v.send(h, { type: 'supersplat:ping' }));

        v.events.fire('annotation.activate', ANNOTATIONS[0]);

        expect(messagesOf(hosts[0], 'supersplat:annotation.activated')).toHaveLength(0);
        expect(messagesOf(hosts[8], 'supersplat:annotation.activated')).toHaveLength(1);
    });

    it('ignores messages that are not supersplat requests', () => {
        const v = makeViewer(ANNOTATIONS);
        runBridge(ANNOTATIONS, v);
        v.events.fire('firstFrame');

        const host = makeHost();
        v.send(host, 'a string');
        v.send(host, { type: 'webpackHotUpdate' });
        v.send(host, { type: 'supersplat:ready' });
        v.send(host, null);

        expect(host.sent).toHaveLength(0);
    });

    it('falls back to a broadcast when the sender origin is not a legal target', () => {
        const v = makeViewer(ANNOTATIONS);
        runBridge(ANNOTATIONS, v);
        v.events.fire('firstFrame');

        const host = makeHost();
        v.send(host, { type: 'supersplat:ping' }, 'null');

        expect(host.sent[0].origin).toBe('*');
    });
});

describe('buildIframeApiInjection', () => {
    it('always emits the bridge, even with no annotations', () => {
        const injection = buildIframeApiInjection([]);
        expect(injection).toContain('window.__supersplatIframeApi = []');
        expect(injection).toContain('supersplat:annotation.goto');
    });

    it('escapes characters that could break out of the script tag', () => {
        const injection = buildIframeApiInjection([
            { title: '</script><img src=x>', text: 'a & b', extras: { id: 'annotation_0' } }
        ]);
        expect(injection).not.toContain('</script><img');
        expect(injection).toContain('\\u003c');
    });

    it('emits a runtime free of backslash escapes', () => {
        // The runtime is a template literal in TypeScript source: backslashes are
        // consumed at build time, so any that survive into the emitted string are
        // a bug waiting to happen.
        const scripts = [...buildIframeApiInjection([]).matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
        expect(scripts[scripts.length - 1]).not.toContain('\\');
    });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/viewer-iframe-api.test.ts`
Expected: FAIL — `buildIframeApiInjection` is not exported.

- [ ] **Step 3: Append the runtime and the injection builder**

Append to `src/viewer-companion/iframe-api.ts`, before the `export` statements, then extend the exports.

```typescript
// The runtime bridge. Kept as a plain string so it is injected verbatim.
//
// The exported viewer keeps its app, camera and annotation objects in a private
// module closure, so the bridge reaches them through window.__supersplatViewer,
// published from the viewer bootstrap by splat-export-core (injectDeviceFallback
// runs unconditionally, so the handle is always there).
//
// Navigation reuses the viewer's own path: firing 'annotation.navigate' with an
// annotation object shows its tooltip, which fires 'annotation.activate', which
// makes the camera manager switch to orbit and fly to the baked pose -- and which
// the portals companion separately listens for to swap portal scene. So a
// cross-scene jump needs nothing here beyond firing the event.
//
// The annotation argument must be object-identical to an entry of
// global.settings.annotations: the viewer's internal scriptMap is keyed by
// identity. The baked table's `index` is the join key.
//
// NOTE: this is a template literal -- backslash escapes are consumed at build
// time. String operations only: no regex literals, no escape sequences.
const companionRuntime = `
(function () {
  var table = window.__supersplatIframeApi || [];
  var resolveAnnotationRef = ${resolveAnnotationRef.toString()};

  var ready = false;
  var pendingGoto = null;   // at most one; the latest press wins
  var pendingReplies = [];
  var subscribers = [];
  var MAX_SUBSCRIBERS = 8;

  // Reply narrowly to the sender's origin. A sandboxed or file:// host reports
  // the origin as the string 'null', which is not a legal targetOrigin and
  // throws -- a ZIP opened straight off disk hits exactly that, so fall back to
  // a broadcast rather than dropping the reply.
  function post(source, origin, message) {
    if (!source) return;
    try {
      source.postMessage(message, origin);
    } catch (e) {
      try { source.postMessage(message, '*'); } catch (e2) {}
    }
  }

  // First contact subscribes a window to activation notifications. Capped so a
  // parent spawning frames cannot grow an unbounded list of window references.
  function subscribe(source, origin) {
    if (!source) return;
    for (var i = 0; i < subscribers.length; i++) {
      if (subscribers[i].source === source) { subscribers[i].origin = origin; return; }
    }
    subscribers.push({ source: source, origin: origin });
    if (subscribers.length > MAX_SUBSCRIBERS) subscribers.shift();
  }

  function notify(message) {
    for (var i = 0; i < subscribers.length; i++) {
      post(subscribers[i].source, subscribers[i].origin, message);
    }
  }

  function getViewer() {
    return window.__supersplatViewer || null;
  }

  function getEvents() {
    var v = getViewer();
    return (v && v.global && v.global.events) || null;
  }

  function getState() {
    var v = getViewer();
    return (v && v.global && v.global.state) ||
           (v && v.debugPanel && v.debugPanel._global && v.debugPanel._global.state) || null;
  }

  // The viewer's own annotation array -- the objects annotation.navigate expects.
  function liveAnnotations() {
    var v = getViewer();
    var settings = v && v.global && v.global.settings;
    var list = settings && settings.annotations;
    return (list && list.length) ? list : null;
  }

  function doGoto(req) {
    var res = resolveAnnotationRef(table, req.ref);
    if (res.index < 0) {
      post(req.source, req.origin, { type: 'supersplat:annotation.goto.result', requestId: req.requestId, ok: false, reason: res.reason });
      return;
    }
    var list = liveAnnotations();
    var ev = getEvents();
    if (!ev || !list || !list[res.index]) {
      post(req.source, req.origin, { type: 'supersplat:annotation.goto.result', requestId: req.requestId, ok: false, reason: 'unavailable' });
      return;
    }
    ev.fire('annotation.navigate', list[res.index]);
    post(req.source, req.origin, { type: 'supersplat:annotation.goto.result', requestId: req.requestId, ok: true, annotation: table[res.index] });
  }

  function answer(req) {
    if (req.type === 'supersplat:annotation.list') {
      post(req.source, req.origin, { type: 'supersplat:annotation.list.result', requestId: req.requestId, annotations: table });
    } else if (req.type === 'supersplat:ping') {
      post(req.source, req.origin, { type: 'supersplat:ready', requestId: req.requestId });
    }
  }

  // Installed at parse time, before the viewer's deferred module bootstrap runs,
  // so no host message can be missed. A handler that throws would be invisible to
  // the host and could disrupt unrelated listeners, hence the blanket catch.
  window.addEventListener('message', function (e) {
    try {
      var d = e && e.data;
      if (!d || typeof d !== 'object') return;
      var type = d.type;
      if (type !== 'supersplat:annotation.goto' &&
          type !== 'supersplat:annotation.list' &&
          type !== 'supersplat:ping') return;
      subscribe(e.source, e.origin);
      var req = { source: e.source, origin: e.origin, requestId: d.requestId, type: type };
      if (type === 'supersplat:annotation.goto') {
        req.ref = { name: d.name, id: d.id, index: d.index };
        if (ready) { doGoto(req); } else { pendingGoto = req; }
        return;
      }
      if (ready) { answer(req); } else { pendingReplies.push(req); }
    } catch (err) {}
  });

  function onReady() {
    if (ready) return;
    ready = true;
    post(window.parent, '*', { type: 'supersplat:ready' });
    for (var i = 0; i < pendingReplies.length; i++) answer(pendingReplies[i]);
    pendingReplies = [];
    if (pendingGoto) { var g = pendingGoto; pendingGoto = null; doGoto(g); }
  }

  var bound = false;
  function start() {
    var ev = getEvents();
    if (!ev) { requestAnimationFrame(start); return; }
    if (!bound) {
      bound = true;
      ev.on('firstFrame', onReady);
      // Fires for every activation whatever the cause: a host goto, a hotspot
      // click, or the viewer's own prev/next chevrons -- which is what lets host
      // UI keep the right button highlighted.
      ev.on('annotation.activate', function (ann) {
        var list = liveAnnotations();
        var idx = list ? list.indexOf(ann) : -1;
        var entry = (idx >= 0) ? table[idx] : null;
        if (!entry) return;
        notify({ type: 'supersplat:annotation.activated', index: entry.index, id: entry.id, title: entry.title, scene: entry.scene });
      });
      ev.on('annotation.deactivate', function () {
        notify({ type: 'supersplat:annotation.deactivated' });
      });
    }
    // Covers the case where firstFrame fired before the listener attached.
    var st = getState();
    if (st && st.loaded) { onReady(); return; }
    if (!ready) requestAnimationFrame(start);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
`;

// The two Unicode separators that are valid in JSON strings but terminate a
// JavaScript line, built by code point so this source file stays plain ASCII.
const SEP_LINE = String.fromCharCode(0x2028);
const SEP_PARAGRAPH = String.fromCharCode(0x2029);

// Produce the full HTML fragment to inject before </body>. Always non-empty: a
// host embedding an annotation-less scene should still get a ready broadcast and
// an empty list rather than silence.
const buildIframeApiInjection = (annotations: AnyAnnotation[]): string => {
    const table = buildAnnotationIndex(annotations || []);
    // Escape characters that are unsafe inside an HTML <script> context so an
    // annotation title containing e.g. "</script>" or a line/paragraph separator
    // cannot break out of the injected script tag.
    const tableJson = JSON.stringify(table)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .split(SEP_LINE).join('\\u2028')
    .split(SEP_PARAGRAPH).join('\\u2029');
    return `<script>window.__supersplatIframeApi = ${tableJson};</script>` +
        `<script>${companionRuntime}</script>`;
};
```

Then change the export statement to:

```typescript
export { buildAnnotationIndex, buildIframeApiInjection, resolveAnnotationRef };
export type { AnnotationEntry, AnnotationRef, AnyAnnotation };
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/viewer-iframe-api.test.ts`
Expected: PASS.

If the "emits a runtime free of backslash escapes" test fails, a backslash has crept into the runtime template literal or into `resolveAnnotationRef` — remove it rather than relaxing the assertion; that constraint is what keeps the built output correct.

- [ ] **Step 5: Run the whole suite and lint**

Run: `npm run test`
Expected: PASS. Run it in the foreground; do not pipe the output.

Run: `npm run lint`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/viewer-companion/iframe-api.ts test/viewer-iframe-api.test.ts
git commit -m "feat(viewer): postMessage bridge for annotation navigation from a host page"
```

---

### Task 4: Wire the bridge into every export path

All HTML production funnels through `writeViewerCore` in `src/splat-export-core.ts`, which has three injector call sites. The export server and S3 publish both reach the same function through `dist-shared`, so wiring these three sites covers every path.

**Files:**
- Modify: `src/splat-export-core.ts` — add the import, add `injectIframeApi`, and extend the chain at lines 785, 880 and 926

**Interfaces:**
- Consumes: `buildIframeApiInjection` from Task 3.
- Produces: every exported `index.html` / `output.html` carries the bridge.

- [ ] **Step 1: Add the import**

In `src/splat-export-core.ts`, add to the existing companion import block (after the `favicon` import, keeping the block's current alphabetical order — do NOT run an import reorder, ESLint's `import/order` autofix crashes in this repo):

```typescript
import { buildIframeApiInjection } from './viewer-companion/iframe-api';
```

- [ ] **Step 2: Add the injector**

In `src/splat-export-core.ts`, immediately after the `injectAnnotationLinks` function, add:

```typescript
// Inject the iframe API bridge into an HTML string before </body>. ALWAYS
// injected, unlike the annotation-link companion: a host page embedding a scene
// that happens to have no annotations should still receive a ready broadcast and
// an empty list rather than silence. It needs no bootstrap soft-replace of its
// own -- injectDeviceFallback runs unconditionally on every path below and
// always publishes window.__supersplatViewer -- and the runtime polls for that
// handle, so chain position does not matter.
const injectIframeApi = (html: string, viewerSettingsJson: any): string => {
    const injection = buildIframeApiInjection(viewerSettingsJson?.annotations ?? []);
    if (html.includes('</body>')) {
        return html.replace('</body>', `${injection}</body>`);
    }
    return html + injection;
};
```

- [ ] **Step 3: Extend the streaming ZIP chain**

In `src/splat-export-core.ts`, change the streaming path's final line (currently `src/splat-export-core.ts:785`) from:

```typescript
    memFs.results.set('index.html', new TextEncoder().encode(applyFavicon(injectDeviceFallback(withPortals), favicon, memFs)));
```

to:

```typescript
    const withApi = injectIframeApi(injectDeviceFallback(withPortals), settingsWithLods);
    memFs.results.set('index.html', new TextEncoder().encode(applyFavicon(withApi, favicon, memFs)));
```

- [ ] **Step 4: Extend the single-file HTML chain**

In `src/splat-export-core.ts`, change the bundled-HTML path's line (currently `src/splat-export-core.ts:880`) from:

```typescript
            const injected = injectDeviceFallback(injectPortals(injectOffLimitsZones(injectAnnotationLinks(withPoster, viewerSettingsJson), viewerSettingsJson), viewerSettingsJson));
```

to:

```typescript
            const injected = injectIframeApi(injectDeviceFallback(injectPortals(injectOffLimitsZones(injectAnnotationLinks(withPoster, viewerSettingsJson), viewerSettingsJson), viewerSettingsJson)), viewerSettingsJson);
```

- [ ] **Step 5: Extend the package ZIP chain**

In `src/splat-export-core.ts`, change the package path's line (currently `src/splat-export-core.ts:926`) from:

```typescript
            const injected = injectDeviceFallback(injectPortals(injectOffLimitsZones(injectAnnotationLinks(withPoster, sogSettings), sogSettings), sogSettings));
```

to:

```typescript
            const injected = injectIframeApi(injectDeviceFallback(injectPortals(injectOffLimitsZones(injectAnnotationLinks(withPoster, sogSettings), sogSettings), sogSettings)), sogSettings);
```

- [ ] **Step 6: Verify the bridge survives into the built bundle**

Run: `npm run build`
Expected: build succeeds.

Run: `grep -rl "supersplat:annotation.goto" dist/`
Expected: at least one file listed. Rollup tree-shakes unreferenced modules, so the runtime string appearing in `dist/` shows the companion is reachable from the export path. This is a smoke check, not proof of correct wiring — Task 6 proves that on a real export.

- [ ] **Step 7: Run the whole suite and lint**

Run: `npm run test`
Expected: PASS.

Run: `npm run lint`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/splat-export-core.ts
git commit -m "feat(export): inject the iframe API bridge into every HTML export path"
```

---

### Task 5: Documentation and host example

The example page is also the E2E harness Task 6 drives, so it must be a working host, not a snippet.

**Files:**
- Create: `docs/viewer-iframe-api.md`
- Create: `docs/examples/iframe-annotations.html`

**Interfaces:**
- Consumes: the protocol implemented in Task 3.
- Produces: `docs/examples/iframe-annotations.html`, which Task 6 opens to run the manual checks.

- [ ] **Step 1: Write the protocol reference**

Create `docs/viewer-iframe-api.md`:

````markdown
# Exported viewer iframe API

Every SuperSplat HTML export (single-file HTML, ZIP package, streaming ZIP,
server export and S3 publish) carries a small `postMessage` bridge. A page that
embeds the viewer in an `<iframe>` can use it to jump the camera to an
annotation, the way an anchor link jumps to a section of a document.

The jump happens inside the running viewer: nothing reloads, and in a multi-scene
portal export an already-loaded scene swaps instantly.

## Quick start

```html
<iframe id="viewer" src="scene/index.html"></iframe>
<button data-goto="Bedroom">Bedroom</button>

<script>
  const frame = document.getElementById('viewer');

  document.querySelectorAll('[data-goto]').forEach((b) => {
      b.onclick = () => frame.contentWindow.postMessage(
          { type: 'supersplat:annotation.goto', name: b.dataset.goto }, '*');
  });

  addEventListener('message', (e) => {
      if (e.source !== frame.contentWindow) return;
      if (e.data?.type === 'supersplat:annotation.activated') {
          console.log('now showing', e.data.title);
      }
  });
</script>
```

Replace the `'*'` target origin with the viewer's own origin once you know it.
The bridge cannot enforce that from inside the frame — it is the host page's
responsibility.

## Messages the viewer accepts

Every message is an object with a `type` string. Anything else is ignored, so the
bridge will not clash with other `postMessage` traffic on your page.

### `supersplat:annotation.goto`

Fly the camera to an annotation.

| field | type | meaning |
| --- | --- | --- |
| `name` | string | Match the annotation title, ignoring case and surrounding whitespace |
| `id` | string | Match the stable annotation id (`annotation_0`, `annotation_1`, …) |
| `index` | number | Match by position in the annotation list, 0-based |
| `requestId` | any | Optional; echoed back on the reply so you can await a specific call |

Supply at least one of `name`, `id`, `index`. If you supply several, the first
one that matches wins, tried in the order `id`, `index`, `name`. Duplicate titles
are allowed in the editor; `name` resolves to the first annotation with that
title.

Reply — `supersplat:annotation.goto.result`:

```js
{ type: 'supersplat:annotation.goto.result', requestId, ok: true,
  annotation: { index, id, title, text, scene } }

{ type: 'supersplat:annotation.goto.result', requestId, ok: false,
  reason: 'not-found' | 'bad-request' | 'unavailable' }
```

- `not-found` — you supplied a reference, but nothing matched it.
- `bad-request` — you supplied no usable `name`, `id` or `index`.
- `unavailable` — the viewer did not expose its annotations. Treat as a bug report.

### `supersplat:annotation.list`

Ask for every annotation, so the host page can build its buttons from the scene
rather than hardcoding them.

Reply — `supersplat:annotation.list.result`:

```js
{ type: 'supersplat:annotation.list.result', requestId,
  annotations: [ { index, id, title, text, scene }, ... ] }
```

`scene` is the portal scene index the annotation belongs to, or `null` in a
single-scene export.

### `supersplat:ping`

Ask whether the viewer is ready. Replies with `supersplat:ready` (carrying your
`requestId`, if you sent one). Useful when your page mounted after the viewer
finished loading and missed the broadcast.

## Messages the viewer sends

### `supersplat:ready`

Broadcast to the parent window once, when the viewer finishes its initial load.
Carries no data. Also sent as the reply to `supersplat:ping`, so a single
`ready` branch covers both.

### `supersplat:annotation.activated`

```js
{ type: 'supersplat:annotation.activated', index, id, title, scene }
```

Sent whenever an annotation is shown — by your `goto`, by a visitor clicking the
hotspot in the scene, or by the viewer's own previous/next arrows. Use it to keep
the matching button highlighted.

### `supersplat:annotation.deactivated`

Sent when the tooltip closes. Carries no data.

Notifications go only to windows that have sent the viewer at least one message.
Send a `supersplat:ping` on startup to subscribe.

## Behaviour notes

- **Clicks during loading are not lost.** A `goto` sent before the viewer is
  ready is held and applied as soon as it finishes loading. If several arrive,
  the last one wins.
- **Cross-scene jumps work.** In a portal export, jumping to an annotation in
  another scene swaps the scene. If that scene is already resident the swap is
  instant; otherwise the usual loading overlay appears while it streams in.
- **Navigating switches the camera to orbit mode**, matching what the viewer's
  own annotation hotspots do.
- **Any parent may drive the viewer.** There is no origin allowlist: the API
  only moves the camera and shows a tooltip. Replies are addressed to the
  sender's own origin.
````

- [ ] **Step 2: Write the working example host**

Create `docs/examples/iframe-annotations.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>SuperSplat viewer — iframe annotation API example</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; display: flex; height: 100vh; }
  nav { width: 240px; padding: 16px; background: #1b1b1b; color: #eee; overflow: auto; }
  nav h1 { font-size: 15px; margin: 0 0 12px; }
  nav button { display: block; width: 100%; margin-bottom: 6px; padding: 8px; cursor: pointer;
               border: 1px solid #444; background: #2a2a2a; color: #eee; border-radius: 4px; text-align: left; }
  nav button.active { background: #4a7dff; border-color: #4a7dff; }
  #log { margin-top: 16px; font-size: 11px; white-space: pre-wrap; color: #999; }
  iframe { flex: 1; border: 0; }
</style>
</head>
<body>
<nav>
  <h1>Annotations</h1>
  <div id="buttons"></div>
  <div id="log"></div>
</nav>
<!-- point this at your exported viewer -->
<iframe id="viewer" src="../../dist/index.html"></iframe>

<script>
  const frame = document.getElementById('viewer');
  const buttons = document.getElementById('buttons');
  const logEl = document.getElementById('log');

  const send = msg => frame.contentWindow.postMessage(msg, '*');
  const log = line => {
      logEl.textContent = `${line}\n${logEl.textContent}`.split('\n').slice(0, 12).join('\n');
  };

  // Subscribe immediately. If the viewer is still loading this is queued and
  // answered on ready; if it already loaded, we get the reply straight away.
  send({ type: 'supersplat:ping' });

  const buildButtons = (annotations) => {
      buttons.textContent = '';
      annotations.forEach((a) => {
          const b = document.createElement('button');
          b.textContent = a.title || `(untitled ${a.index})`;
          b.dataset.id = a.id;
          b.onclick = () => send({ type: 'supersplat:annotation.goto', name: a.title, requestId: a.id });
          buttons.appendChild(b);
      });
  };

  const highlight = (id) => {
      buttons.querySelectorAll('button').forEach((b) => {
          b.classList.toggle('active', b.dataset.id === id);
      });
  };

  addEventListener('message', (e) => {
      if (e.source !== frame.contentWindow) return;
      const d = e.data;
      if (!d || typeof d !== 'object') return;
      switch (d.type) {
          case 'supersplat:ready':
              log('viewer ready');
              send({ type: 'supersplat:annotation.list' });
              break;
          case 'supersplat:annotation.list.result':
              log(`${d.annotations.length} annotations`);
              buildButtons(d.annotations);
              break;
          case 'supersplat:annotation.goto.result':
              log(d.ok ? `goto ok: ${d.annotation.title} (scene ${d.annotation.scene})` : `goto failed: ${d.reason}`);
              break;
          case 'supersplat:annotation.activated':
              log(`activated: ${d.title}`);
              highlight(d.id);
              break;
          case 'supersplat:annotation.deactivated':
              highlight(null);
              break;
      }
  });
</script>
</body>
</html>
```

- [ ] **Step 3: Sanity-check the example parses**

Open `docs/examples/iframe-annotations.html` in a browser. With no viewer at the
`src` path the iframe will 404 — that is expected at this step. The check is that
the page renders, the console shows no syntax errors, and the log panel is empty
rather than showing an exception.

- [ ] **Step 4: Commit**

```bash
git add docs/viewer-iframe-api.md docs/examples/iframe-annotations.html
git commit -m "docs: iframe annotation API reference and host example"
```

---

### Task 6: Manual end-to-end verification

Automated tests cover the resolver and the runtime against fakes. They cannot
cover minification, the real viewer bundle, or portal scene swapping — so this
task is manual, and must run against a **release** build. Debug builds hide
minification bugs in stringified helpers, which is exactly the class of bug this
companion's `Function.toString()` injection can produce.

**Files:**
- No source changes. Record the outcome in the plan or a session memo.

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: a verified feature.

- [ ] **Step 1: Produce a release export with annotations in two portal scenes**

```bash
npm run build
npm run develop
```

In the editor: load two splats, place a portal between them, add at least one
annotation in each scene (give them distinct titles, e.g. `Bedroom` and
`Kitchen`), then export a ZIP package. Unzip it somewhere servable.

- [ ] **Step 2: Point the example host at the export**

Edit the `src` of the iframe in `docs/examples/iframe-annotations.html` to the
unzipped `index.html`, and serve both over the same static server so the iframe
loads.

- [ ] **Step 3: Run the checks**

Confirm each of these:

1. On load, the log shows `viewer ready` and the annotation buttons appear with
   the right titles and scene numbers.
2. Clicking an annotation in the **currently active** scene flies the camera to
   it and shows its tooltip.
3. Clicking an annotation in an **already-loaded** other scene swaps scenes
   immediately — no loading overlay, no reload, no flash of the poster.
4. Clicking an annotation in a **not-yet-loaded** scene shows the normal loading
   overlay, then arrives at the annotation in the correct scene.
5. Reload the page and click a button **while the loading bar is still on
   screen**: the viewer finishes loading and then lands on that annotation.
6. Clicking a hotspot inside the viewer, and using the viewer's own previous/next
   arrows, both highlight the matching button in the host page.
7. Requesting a jump to a name that does not exist logs `goto failed: not-found`
   and does not move the camera.

- [ ] **Step 4: Repeat against a server-produced export**

The export server bakes from `dist-shared`, which is built separately:

```bash
npm run build
# then, from the server/ directory:
npm run dev
```

Export a ZIP through the "Export on server" path (available when the app is
served from the 3334 server, same-origin with `/api/export*`), unzip it, and
repeat checks 1–4 above.

- [ ] **Step 5: Record the result**

If everything passes, note it and move on to squashing the branch. If anything
fails, use `superpowers:systematic-debugging` before changing code — in
particular, a failure that appears only here and not in the unit tests points at
minification of the `Function.toString()`-injected resolver.

---

## Notes for the implementer

- **Do not reorder imports.** ESLint 10 in this repo crashes on `import/order`
  autofix. Add new imports in the position shown and leave everything else alone.
- **Do not pipe or background `npm run test`.** Vitest hangs in this environment
  when its output is piped to `grep` or the command is backgrounded. Run it in the
  foreground.
- **Do not delete `package-lock.json`** for any reason; no dependency changes are
  needed by this plan anyway.
- The viewer event names used here (`annotation.navigate`, `annotation.activate`,
  `annotation.deactivate`, `firstFrame`) come from the bundled viewer in
  `@playcanvas/splat-transform`. If a future upstream bump renames them, the
  bridge degrades to silence rather than breaking the export — that is by design,
  but the E2E checks in Task 6 are what would catch it.
