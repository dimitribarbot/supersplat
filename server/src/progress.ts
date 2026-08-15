// Structured, localizable form of a progress line. `message` carries the English
// text (server logs + a fallback); `loc` lets the browser rebuild a localized line
// from i18n keys. Mirrors the progressUpdate `loc` the shared export core emits and
// the composition in the editor's progressUpdate handler.
export type ProgressLoc = {
    segments?: { key: string; params?: Record<string, string | number> }[];
    counter?: { index: number; total: number };
    name?: string;
    nameKey?: string;
};

export type ProgressEvent =
    // `value` is a percentage, 0..100 (not a 0..1 fraction) — the editor
    // (src/ui/progress.ts) interpolates it directly into a CSS gradient stop.
    | { kind: 'progress'; message?: string; value?: number; loc?: ProgressLoc; collision?: { index: number; bytes: number } }
    | { kind: 'done'; url?: string; prefix?: string }
    | { kind: 'error'; message: string };

// Transport-agnostic collector. The export worker pushes ProgressEvents in;
// the SSE route subscribes via the listener to serialize them to the client.
export class SseProgressSink {
    constructor(private readonly onEvent: (e: ProgressEvent) => void) {}

    emit(e: ProgressEvent): void {
        this.onEvent(e);
    }
}
