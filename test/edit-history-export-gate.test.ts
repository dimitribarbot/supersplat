import { describe, it, expect } from 'vitest';

import { CommandQueue } from '../src/command-queue';
import { EditHistory } from '../src/edit-history';
import { Events } from '../src/events';

// Minimal EditOp stand-in: records how many times it was applied/reverted so a
// refused undo/redo is distinguishable from one that ran.
const makeOp = () => {
    const calls = { do: 0, undo: 0 };
    return {
        calls,
        name: 'test',
        do() {
            calls.do++;
        },
        undo() {
            calls.undo++;
        }
    };
};

// EditHistory queries the in-flight export state through the 'scene.exporting'
// function that file-handler registers. Register a settable stub here.
const setup = () => {
    const events = new Events();
    let exporting = false;
    events.function('scene.exporting', () => exporting);
    const history = new EditHistory(events, new CommandQueue());
    return { events, history, setExporting: (v: boolean) => { exporting = v; } };
};

describe('EditHistory export gate', () => {
    it('applies an op and undoes it normally when no export is running', async () => {
        const { history } = setup();
        const op = makeOp();

        await history.add(op as any);
        expect(op.calls.do).toBe(1);
        expect(history.canUndo()).toBe(true);

        await history.undo();
        expect(op.calls.undo).toBe(1);
        expect(history.canUndo()).toBe(false);
    });

    it('refuses undo while an export is in flight, leaving the cursor put', async () => {
        const { history, setExporting } = setup();
        const op = makeOp();
        await history.add(op as any);

        setExporting(true);
        await history.undo();

        expect(op.calls.undo).toBe(0);
        expect(history.cursor).toBe(1);
        expect(history.canUndo()).toBe(true);
    });

    it('refuses redo while an export is in flight, leaving the cursor put', async () => {
        const { history, setExporting } = setup();
        const op = makeOp();
        await history.add(op as any);
        await history.undo();
        expect(history.canRedo()).toBe(true);

        setExporting(true);
        await history.redo();

        expect(op.calls.do).toBe(1);   // the initial add only
        expect(history.cursor).toBe(0);
        expect(history.canRedo()).toBe(true);
    });

    it('resumes undo/redo once the export finishes', async () => {
        const { history, setExporting } = setup();
        const op = makeOp();
        await history.add(op as any);

        setExporting(true);
        await history.undo();
        expect(op.calls.undo).toBe(0);

        setExporting(false);
        await history.undo();
        expect(op.calls.undo).toBe(1);
        expect(history.cursor).toBe(0);
    });

    it('routes undo/redo fired on the event bus through the same gate', async () => {
        const { events, history, setExporting } = setup();
        const op = makeOp();
        await history.add(op as any);

        setExporting(true);
        events.fire('edit.undo');
        // the gate returns before touching the queue, so a queue drain is enough
        // to prove nothing was scheduled behind it
        await history.add(makeOp() as any);
        expect(op.calls.undo).toBe(0);
    });
});
