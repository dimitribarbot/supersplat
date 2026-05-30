import { describe, it, expect } from 'vitest';
import { SseProgressSink } from '../src/progress.js';

describe('SseProgressSink', () => {
  it('forwards events to its listener in order', () => {
    const events: any[] = [];
    const sink = new SseProgressSink(e => events.push(e));
    sink.emit({ kind: 'progress', message: 'k-means', value: 0.5 });
    sink.emit({ kind: 'progress', message: 'writing' });
    sink.emit({ kind: 'done' });
    expect(events).toEqual([
      { kind: 'progress', message: 'k-means', value: 0.5 },
      { kind: 'progress', message: 'writing' },
      { kind: 'done' }
    ]);
  });

  it('forwards an error event', () => {
    const events: any[] = [];
    const sink = new SseProgressSink(e => events.push(e));
    sink.emit({ kind: 'error', message: 'boom' });
    expect(events).toEqual([{ kind: 'error', message: 'boom' }]);
  });
});
