export type ProgressEvent =
    | { kind: 'progress'; message?: string; value?: number }
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
