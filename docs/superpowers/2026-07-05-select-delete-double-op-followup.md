# Follow-up candidate: `select.delete` double-op when portal / off-limits tool is active

**Status:** Not fixed — logged during E2E of plan #4 (`2026-07-02-editor-zonedepth-gate-and-shape-destroy.md`) on 2026-07-05. Pre-existing defect, unrelated to that plan's changes (confirmed by code trace; the plan's diff never touches these paths).

## Symptom

With the portal (or off-limits-zone) tool active, select a portal/zone and press Delete, then Ctrl+Z. Nothing visibly happens on the first Ctrl+Z (no console error); the portal/zone only reappears on the **second** Ctrl+Z. User-reproduced and confirmed E2E 2026-07-05.

## Root cause

`select.delete` (Delete/Backspace, `shortcut-manager.ts:36`) has multiple listeners, and two of them both push an op onto edit history:

1. `src/tools/portal-tool.ts:701` (and identically `src/tools/off-limits-zone-tool.ts:434`) — fires `edit.add(RemovePortalOp)` for the selected portal/zone. This is the intended delete.
2. `src/editor.ts:546` — the gaussian-delete handler. It early-returns only for the **measure** and **annotation** tools, not for `portals` / `offLimits`. It then runs `selectedSplats().forEach(splat => editHistory.add(new DeleteSelectionOp(splat)))`. `selectedSplats()` (`src/editor.ts:30`) returns the selected *splat element* whenever one is visible — regardless of whether any gaussians are selected — so a `DeleteSelectionOp` is pushed even when it deletes zero gaussians.

Listener order (from `src/main.ts`: tools registered at ~line 267, `registerEditorEvents` at ~line 287) puts the no-op `DeleteSelectionOp` **on top** of the `RemovePortalOp` in history. First Ctrl+Z undoes the invisible zero-gaussian delete; second Ctrl+Z restores the portal/zone.

## Why it matters beyond the confusing undo

If gaussians **are** selected when the user deletes a portal/zone, the `editor.ts` handler silently deletes those gaussians in the same keypress — data loss the user didn't ask for and may not notice (it's recoverable via undo, but only if noticed).

## Suggested fix direction (small, localized)

Extend the early-return in `src/editor.ts:549-552` to also cover the portal and off-limits tools, mirroring the existing measure/annotation guard:

```ts
if (activeTool === 'measure' || activeTool === 'annotation' ||
    activeTool === 'portals' || activeTool === 'offLimits') {
    return;
}
```

Verify the exact tool-id strings against `main.ts` `toolManager.register(...)` calls before implementing (`'portals'` is registered at `main.ts:267`; check the off-limits id the same way). Semantics match the existing tools' intent: while a wall-editing tool is active, Delete means "delete the selected wall", not "delete selected gaussians". Note the tools' own handlers no-op when no portal/zone is selected — decide whether Delete should then fall through to gaussian delete (current measure/annotation guard does NOT fall through; simplest is to match that).

## Verification sketch

- Portal tool active, portal selected, gaussians selected → Delete removes only the portal; gaussian selection intact; ONE Ctrl+Z restores the portal.
- Same for off-limits tool.
- Rect-select tool active, gaussians selected → Delete still deletes gaussians (no regression).
- Measure/annotation behavior unchanged.

Engine/GPU-uncoupled guard logic, but the handler wiring is editor-global — manual E2E as above; no unit test practical (Node vitest has no engine/DOM here).
