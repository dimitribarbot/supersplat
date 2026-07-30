import { describe, it, expect, vi } from 'vitest';

import { injectIframeApi } from '../src/splat-export-core';
import { buildAnnotationIndex, buildIframeApiInjection, resolveAnnotationRef } from '../src/viewer-companion/iframe-api';

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
        // `annotations` mirrors the real viewer's own field: null until its
        // post-gsplatLoad continuation constructs the Annotations object (see
        // hasAnnotations() in iframe-api.ts). Tests flip it to simulate that
        // continuation completing. `config` mirrors global.config; noui tests
        // set config.noui directly.
        __supersplatViewer: { global: { events, settings: { annotations }, state, config: {} }, annotations: null },
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

// Run the bridge and drive it past the real navigation-ready signal: the
// viewer's Annotations object appearing (see hasAnnotations() in
// iframe-api.ts). Most tests want this -- only the readiness-gating tests
// below care about the state *before* it appears.
const runReadyBridge = (annotations: any[], v: ReturnType<typeof makeViewer>) => {
    const { tick } = runBridge(annotations, v);
    v.window.__supersplatViewer.annotations = {};
    tick();
    return { tick };
};

const ANNOTATIONS = [
    { title: 'Bedroom', text: 'the bed', position: [0, 0, 0], extras: { id: 'annotation_0', scene: 0 } },
    { title: 'Kitchen', text: '', position: [1, 0, 0], extras: { id: 'annotation_1', scene: 1 } }
];

const messagesOf = (host: ReturnType<typeof makeHost>, type: string) =>
    host.sent.filter(s => s.message.type === type);

// Execute the emitted table-assignment script (the first <script>, not the
// runtime) exactly as a browser would, so the escaping path itself is
// exercised rather than assumed. Returns whatever ends up on
// window.__supersplatIframeApi after JSON parsing/unescaping by the engine.
const runTableScript = (injection: string): any => {
    const scripts = [...injection.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    const window: any = {};
    // eslint-disable-next-line no-new-func
    new Function('window', scripts[0])(window);
    return window.__supersplatIframeApi;
};

describe('iframe api runtime', () => {
    it('broadcasts ready to the parent once the viewer constructs its annotations object', () => {
        const v = makeViewer(ANNOTATIONS);
        const { tick } = runBridge(ANNOTATIONS, v);

        expect(messagesOf(v.parent, 'supersplat:ready')).toHaveLength(0);
        v.window.__supersplatViewer.annotations = {};
        tick();

        expect(messagesOf(v.parent, 'supersplat:ready')).toHaveLength(1);
        expect(v.parent.sent[0].origin).toBe('*');
    });

    it('does not become ready from firstFrame or state.loaded alone -- the annotations object is the real signal', () => {
        const v = makeViewer(ANNOTATIONS);
        const { tick } = runBridge(ANNOTATIONS, v);

        // Both fire routinely well before the viewer's post-gsplatLoad
        // continuation constructs Annotations; readiness must not jump the gun
        // on either, or a queued goto gets flushed with no listener registered
        // to hear it (the CRITICAL bug this test guards against).
        v.events.fire('firstFrame');
        v.state.loaded = true;
        tick();

        expect(messagesOf(v.parent, 'supersplat:ready')).toHaveLength(0);
    });

    it('declares ready via a bounded watchdog when the annotations object never appears, flushing queued list/ping requests', () => {
        vi.useFakeTimers();
        try {
            const v = makeViewer(ANNOTATIONS);
            const { tick } = runBridge(ANNOTATIONS, v);

            const host = makeHost();
            v.send(host, { type: 'supersplat:annotation.list' });
            expect(host.sent).toHaveLength(0);

            // The annotations object is never observed: only the watchdog's
            // bounded backstop can unstick this.
            vi.advanceTimersByTime(14999);
            expect(messagesOf(v.parent, 'supersplat:ready')).toHaveLength(0);

            vi.advanceTimersByTime(1);
            expect(messagesOf(v.parent, 'supersplat:ready')).toHaveLength(1);
            expect(messagesOf(host, 'supersplat:annotation.list.result')).toHaveLength(1);

            // The rAF poll must terminate once ready: draining the already-queued
            // frame must not enqueue another one.
            tick();
            tick();
            expect(messagesOf(v.parent, 'supersplat:ready')).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('flushes a goto queued before the watchdog backstop fires as unavailable, not ok: true', () => {
        vi.useFakeTimers();
        try {
            const v = makeViewer(ANNOTATIONS);
            runBridge(ANNOTATIONS, v);
            const navigated: any[] = [];
            v.events.on('annotation.navigate', (ann: any) => navigated.push(ann));

            const host = makeHost();
            v.send(host, { type: 'supersplat:annotation.goto', name: 'Bedroom', requestId: 'g1' });
            expect(host.sent).toHaveLength(0);

            vi.advanceTimersByTime(15000);

            expect(navigated).toHaveLength(0);
            expect(host.sent[0].message).toEqual({
                type: 'supersplat:annotation.goto.result',
                requestId: 'g1',
                ok: false,
                reason: 'unavailable'
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('replies unavailable (not ok: true) for a goto received after the watchdog backstop fires without annotations', () => {
        vi.useFakeTimers();
        try {
            const v = makeViewer(ANNOTATIONS);
            runBridge(ANNOTATIONS, v);

            vi.advanceTimersByTime(15000);
            expect(messagesOf(v.parent, 'supersplat:ready')).toHaveLength(1);

            const host = makeHost();
            v.send(host, { type: 'supersplat:annotation.goto', name: 'Bedroom', requestId: 'g2' });

            expect(host.sent).toHaveLength(1);
            expect(host.sent[0].message).toEqual({
                type: 'supersplat:annotation.goto.result',
                requestId: 'g2',
                ok: false,
                reason: 'unavailable'
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('a goto succeeds once the annotations object appears after the watchdog backstop already fired ready', () => {
        vi.useFakeTimers();
        try {
            const v = makeViewer(ANNOTATIONS);
            const { tick } = runBridge(ANNOTATIONS, v);

            vi.advanceTimersByTime(15000);
            expect(messagesOf(v.parent, 'supersplat:ready')).toHaveLength(1);

            // A real (if very slow) load finally finishes after the backstop
            // already declared ready. doGoto checks hasAnnotations() live, not a
            // cached flag, so this is not permanently stuck at unavailable.
            v.window.__supersplatViewer.annotations = {};
            tick();
            const navigated: any[] = [];
            v.events.on('annotation.navigate', (ann: any) => navigated.push(ann));

            const host = makeHost();
            v.send(host, { type: 'supersplat:annotation.goto', name: 'Bedroom', requestId: 'g3' });

            expect(navigated).toEqual([ANNOTATIONS[0]]);
            expect(host.sent[0].message.ok).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('reports ready immediately under config.noui (no annotations object will ever be constructed)', () => {
        const v = makeViewer(ANNOTATIONS);
        v.window.__supersplatViewer.global.config.noui = true;
        runBridge(ANNOTATIONS, v);

        // No tick() needed: isNoUi() is detected on the very first poll, which
        // runs synchronously as the runtime starts (document.readyState is
        // 'complete' in the fake).
        expect(messagesOf(v.parent, 'supersplat:ready')).toHaveLength(1);
    });

    it('keeps goto unavailable under config.noui even after ready, since annotations never exist there', () => {
        const v = makeViewer(ANNOTATIONS);
        v.window.__supersplatViewer.global.config.noui = true;
        runBridge(ANNOTATIONS, v);

        const host = makeHost();
        v.send(host, { type: 'supersplat:annotation.goto', name: 'Bedroom', requestId: 'g4' });

        expect(host.sent[0].message).toEqual({
            type: 'supersplat:annotation.goto.result',
            requestId: 'g4',
            ok: false,
            reason: 'unavailable'
        });
    });

    it('still answers list and ping under config.noui', () => {
        const v = makeViewer(ANNOTATIONS);
        v.window.__supersplatViewer.global.config.noui = true;
        runBridge(ANNOTATIONS, v);

        const host = makeHost();
        v.send(host, { type: 'supersplat:annotation.list', requestId: 'L' });
        v.send(host, { type: 'supersplat:ping', requestId: 'P' });

        expect(messagesOf(host, 'supersplat:annotation.list.result')).toHaveLength(1);
        expect(messagesOf(host, 'supersplat:ready')).toHaveLength(1);
    });

    it('navigates to an annotation by name with the viewer own annotation object', () => {
        const v = makeViewer(ANNOTATIONS);
        runReadyBridge(ANNOTATIONS, v);
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
        runReadyBridge(ANNOTATIONS, v);
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
        runReadyBridge(ANNOTATIONS, v);

        const host = makeHost();
        v.send(host, { type: 'supersplat:annotation.goto' });

        expect(host.sent[0].message.reason).toBe('bad-request');
    });

    it('reports unavailable when the viewer exposes no annotation array', () => {
        const v = makeViewer(ANNOTATIONS);
        runReadyBridge(ANNOTATIONS, v);
        v.window.__supersplatViewer.global.settings = {};

        const host = makeHost();
        v.send(host, { type: 'supersplat:annotation.goto', name: 'Bedroom' });

        expect(host.sent[0].message.reason).toBe('unavailable');
    });

    it('answers a list request with the baked table', () => {
        const v = makeViewer(ANNOTATIONS);
        runReadyBridge(ANNOTATIONS, v);

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
        runReadyBridge(ANNOTATIONS, v);

        const host = makeHost();
        v.send(host, { type: 'supersplat:ping', requestId: 'P' });

        expect(host.sent[0].message).toEqual({ type: 'supersplat:ready', requestId: 'P' });
    });

    it('queues a goto sent before ready and flushes the last one', () => {
        const v = makeViewer(ANNOTATIONS);
        const { tick } = runBridge(ANNOTATIONS, v);
        const navigated: any[] = [];
        v.events.on('annotation.navigate', (ann: any) => navigated.push(ann));

        const host = makeHost();
        v.send(host, { type: 'supersplat:annotation.goto', name: 'Bedroom' });
        v.send(host, { type: 'supersplat:annotation.goto', name: 'Kitchen' });
        expect(navigated).toHaveLength(0);

        v.window.__supersplatViewer.annotations = {};
        tick();

        expect(navigated).toEqual([ANNOTATIONS[1]]);
    });

    it('queues a list request sent before ready', () => {
        const v = makeViewer(ANNOTATIONS);
        const { tick } = runBridge(ANNOTATIONS, v);

        const host = makeHost();
        v.send(host, { type: 'supersplat:annotation.list' });
        expect(host.sent).toHaveLength(0);

        v.window.__supersplatViewer.annotations = {};
        tick();

        expect(messagesOf(host, 'supersplat:annotation.list.result')).toHaveLength(1);
    });

    it('notifies subscribers when an annotation is activated from inside the viewer', () => {
        const v = makeViewer(ANNOTATIONS);
        runReadyBridge(ANNOTATIONS, v);
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
        runReadyBridge(ANNOTATIONS, v);
        const silent = makeHost();

        v.events.fire('annotation.activate', ANNOTATIONS[0]);

        expect(silent.sent).toHaveLength(0);
    });

    it('caps the subscriber list at 8, dropping the oldest', () => {
        const v = makeViewer(ANNOTATIONS);
        runReadyBridge(ANNOTATIONS, v);
        const hosts = Array.from({ length: 9 }, () => makeHost());
        hosts.forEach(h => v.send(h, { type: 'supersplat:ping' }));

        v.events.fire('annotation.activate', ANNOTATIONS[0]);

        expect(messagesOf(hosts[0], 'supersplat:annotation.activated')).toHaveLength(0);
        expect(messagesOf(hosts[8], 'supersplat:annotation.activated')).toHaveLength(1);
    });

    it('ignores messages that are not supersplat requests', () => {
        const v = makeViewer(ANNOTATIONS);
        runReadyBridge(ANNOTATIONS, v);

        const host = makeHost();
        v.send(host, 'a string');
        v.send(host, { type: 'webpackHotUpdate' });
        v.send(host, { type: 'supersplat:ready' });
        v.send(host, null);

        expect(host.sent).toHaveLength(0);
    });

    it('falls back to a broadcast when the sender origin is not a legal target', () => {
        const v = makeViewer(ANNOTATIONS);
        runReadyBridge(ANNOTATIONS, v);

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

    it('escapes characters that could break out of the script tag, and the table round-trips exactly', () => {
        // Built by code point (rather than as literal characters in this test
        // file) for the same reason the source under test does it: U+2028/U+2029
        // are valid inside a JSON string but terminate a JavaScript line, so an
        // annotation whose text contains one is exactly the case this escaping
        // exists for.
        const sepLine = String.fromCharCode(0x2028);
        const sepParagraph = String.fromCharCode(0x2029);
        const annotations = [
            {
                title: '</script><img src=x>',
                text: 'a & b' + sepLine + 'c' + sepParagraph + 'd',
                extras: { id: 'annotation_0' }
            }
        ];
        const injection = buildIframeApiInjection(annotations);
        expect(injection).not.toContain('</script><img');
        expect(injection).toContain('\\u003c');

        // Assert directly on the emitted table script for the U+2028/U+2029
        // case too, rather than relying only on round-trip execution: modern
        // V8 (Node's Vitest runtime) accepts raw U+2028/U+2029 inside string
        // literals (the ES2019 "JSON superset" change), so new Function would
        // happily parse the table below even if this escaping were removed --
        // the round-trip alone cannot fail on that regression. The escaping
        // exists for engines that predate that change, since the exported
        // viewer is a standalone file that can be opened anywhere.
        const [tableScript] = [...injection.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
        expect(tableScript).not.toContain(sepLine);
        expect(tableScript).not.toContain(sepParagraph);
        expect(tableScript).toContain('\\u2028');
        expect(tableScript).toContain('\\u2029');

        // Run the actual emitted table-assignment script rather than trusting
        // the substring checks alone: a regression that emitted syntactically
        // broken or over-escaped JSON would fail here even if it slipped past
        // the substring assertions above.
        const table = runTableScript(injection);
        expect(table).toEqual(buildAnnotationIndex(annotations));
    });

    it('emits a runtime free of backslash escapes', () => {
        // The runtime is a template literal in TypeScript source: backslashes are
        // consumed at build time, so any that survive into the emitted string are
        // a bug waiting to happen.
        const scripts = [...buildIframeApiInjection([]).matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
        expect(scripts[scripts.length - 1]).not.toContain('\\');
    });
});

// CRITICAL: injectIframeApi (src/splat-export-core.ts) splices its fragment
// before </body> with html.replace(). A STRING passed as the second argument
// to replace() is itself a pattern language -- $&, $`, $' and $$ are expanded
// by the engine, not inserted literally. buildIframeApiInjection HTML-escapes
// </>/&/U+2028/U+2029 so a title cannot break out of the <script> tag via
// markup, but that escaping does nothing against $: a title containing "$`"
// survives verbatim into the JSON table and, under a naive
// `html.replace('</body>', `${injection}</body>`)` call, expands to "everything
// in html before the match" -- for a bundled single-file export, the whole
// engine + base64 splat payload, which contains its own </script> and so
// truncates the injected tag early: a blank or garbled export produced
// silently at export time. "$&" (the match itself) and "$'" (everything after
// the match) corrupt the baked title the same way. injectIframeApi must insert
// the fragment literally regardless of what characters an annotation contains.
describe('injectIframeApi ($-substitution safety, CRITICAL)', () => {
    it('keeps an annotation title containing $` and $& intact through the injection step', () => {
        const title = 'Price is $' + '`5 and $& should stay literal';
        const annotations = [{ title, text: '', extras: { id: 'annotation_0' } }];

        const precedingContent = 'PRECEDING-CONTENT-MARKER';
        const html = `<html><head></head><body><div>${precedingContent}</div></body></html>`;

        const result = injectIframeApi(html, { annotations });

        // The content before </body> must survive exactly once: a $`-triggered
        // splice would duplicate it inside the injected script (or, for a real
        // export, would splice the whole preceding document -- engine bundle
        // and base64 payload included -- into that spot).
        expect(result.split(precedingContent)).toHaveLength(2);
        // Exactly one </body> must remain: a $&-triggered splice would insert
        // an extra literal copy of the matched text into the fragment.
        expect(result.split('</body>')).toHaveLength(2);

        // Execute the emitted table-assignment script exactly as a browser
        // would (as the U+2028/U+2029 test above does) and assert the title
        // round-trips byte-for-byte, $ patterns included, rather than trusting
        // the substring checks alone.
        const [tableScript] = [...result.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
        const window: any = {};
        // eslint-disable-next-line no-new-func
        new Function('window', tableScript)(window);
        expect(window.__supersplatIframeApi[0].title).toBe(title);
    });
});
