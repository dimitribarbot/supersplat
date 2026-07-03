# `.ssproj` Save OOM — Scoping / Handoff Memo

**Status: RESOLVED (pending real-scale E2E).** User confirmed Brave: `typeof window.showSaveFilePicker === 'undefined'`, "Save As", no native dialog → the **fallback download path** is taken, confirming the `MemoryFileSystem` single-buffer concat root cause below (option A). Fixed in commit `98bdae5` on branch `fix/portal-export-start-and-names`: `BrowserDownloadWriter` now assembles the download `Blob` from the chunk array (`new Blob(chunks)`) instead of one contiguous `Uint8Array`, dodging the ~2GB cap and lowering peak memory. Byte-identical output; format unchanged. Still to E2E: actually saving the >2GB 4-scene project in Brave.

Original scoping analysis follows.

Written 2026-07-03 against `main` (`eee0577`).

## Symptom

Saving a 4-scene portal project as `.ssproj` fails with a dialog:

> ÉCHEC DE L'ENREGISTREMENT — `'Array buffer allocation failed'`

The user's browser is **Brave**. They suspect the total size of all scenes serialized as float32 PLY exceeds ~2 GB.

## What the code does (verified)

Save flow (`src/doc.ts`):

- `doc.save` (existing file handle) → `saveDocument({ stream: handle.createWritable() })` — `doc.ts:326-331`.
- `doc.saveAs` → if `window.showSaveFilePicker` exists → `saveDocument({ stream })` (**streaming**); else → `saveDocument({ filename: 'scene.ssproj' })` (**fallback download**) — `doc.ts:343-366`.
- `saveDocument` (`doc.ts:162-228`) builds a small `document.json` (metadata only — `splats.map(s => s.docSerialize())`, NO PLY payload) then loops per scene: `serializePly([splats[i]], …, 'splat_<i>.ply')` (`doc.ts:213-215`). The error is caught at `doc.ts:219` and shown via the `doc.save-failed` popup with message `'${error.message}'` — matches the screenshot exactly.

Where a size-proportional allocation can/can't happen:

- **`serializePly` genuinely streams** — the only buffer is a fixed 1024-gaussian scratch `Uint8Array` (`splat-serialize.ts:563`), flushed repeatedly to the writer (`:601/:609`). It reads from `splat.splatData` (already-resident CPU data), allocating nothing large. **Not the culprit on either path.**
- **`ZipFileSystem` streams** — writes local header + data straight through, CRC32 incremental (vendored `@playcanvas/splat-transform/dist/index.mjs:9156-9292`). Not the culprit.
- **Fallback path only:** `BrowserDownloadWriter` routes every write into a `MemoryFileSystem` (`src/io/write/browser-file-system.ts:68-94`), which on close **concatenates all chunks into ONE contiguous `Uint8Array`**:
  `node_modules/@playcanvas/splat-transform/dist/index.mjs:9113` — `new Uint8Array(result.reduce((t, b) => t + b.byteLength, 0))` — size = total bytes of the whole multi-scene zip. Then a **second** full-size copy as a `Blob` (`browser-file-system.ts:42`). This is the allocation that throws `Array buffer allocation failed` at ~2 GB+.

## The open question (why Brave matters)

`Array buffer allocation failed` on the **streaming** path should be impossible per the code above — it never materializes more than ~5 MB. So either:

1. **Brave is on the fallback path** — i.e. `window.showSaveFilePicker` is absent/disabled in that Brave session (Brave shields or a flag can restrict FSA), OR the user used a code path without a stream. → confirms the `MemoryFileSystem` concat root cause; fix = make the fallback stream / avoid the contiguous concat.
2. **Brave is on the streaming path and the OOM is elsewhere** — then the analysis is incomplete and there's a second allocation I haven't found (e.g. a per-scene GPU readback or a `docSerialize` path for a huge single scene). → need the stack trace to locate it.

**Evidence needed to pin it (from the user, in Brave, at the moment of failure):**
- In DevTools console: `typeof window.showSaveFilePicker` (`'function'` = streaming path available; `'undefined'` = fallback).
- The full error **stack trace** from the console (the popup only shows the message). This tells us exactly which allocation threw.
- Whether it was **Save** (existing file) vs **Save As**, and whether a native "Save" file dialog appeared (dialog appearing ⇒ FSA/streaming).

## Fix directions (do NOT implement until pinned)

If confirmed fallback-path concat:
- **Primary:** make the non-FSA download path stream instead of buffering. Either prefer FSA whenever present, or pipe a `TransformStream`/`WritableStream` to a download so `MemoryFileSystem`'s single concat is never reached.
- **Cheaper interim:** hand `MemoryWriter`'s array of ≤5 MB chunks **directly** to `new Blob(chunks, …)` (Blob assembles an array of parts without a prior contiguous `Uint8Array`), removing the `index.mjs:9113` allocation. But that's in vendored `@playcanvas/splat-transform` — belongs upstream or in a local custom `Writer` in `src/io/write/` that bypasses `MemoryFileSystem` (do NOT patch `node_modules`).

Secondary latent bug (either path): `ZipFileSystem` writes **32-bit** sizes/offsets — no ZIP64 (`index.mjs:9269,9272,9286`). A total ≥4 GB or any single scene ≥4 GB overflows uint32 and silently corrupts the archive. Consider a ZIP64 path or at least a guard + clear error.

Note: none of these change the on-disk `.ssproj` format — they are write-path only, so existing projects stay loadable.

## Key files
- `src/doc.ts:162-228` (save flow, catch → popup)
- `src/io/write/browser-file-system.ts:25-29` (streaming writer), `:41-42` (Blob copy), `:68-94` (MemoryFileSystem), `:114-119` (writer selection)
- `src/splat-serialize.ts:523-614` (per-scene streaming — not the culprit)
- `node_modules/@playcanvas/splat-transform/dist/index.mjs:9104-9126` (the concat that throws), `:9156-9292` (zip streaming)
