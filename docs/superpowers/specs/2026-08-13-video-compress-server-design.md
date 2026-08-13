# Server-side video compression: target a file size

**Date:** 2026-08-13
**Status:** awaiting review
**Source:** session-scratchpad script `encode-web-video.sh` (two-pass VP9 size
targeting, benchmarked over this session) ported to the export server

## Summary

Add a **Compress** checkbox and a **Target size (MB)** input to the video render
dialog. When checked, the browser renders the master exactly as it does today,
then hands it to the export server, which re-encodes it to a WebM/VP9 file at or
under the requested size and hands it back.

Available **only when the export server reports ffmpeg**; the rows stay hidden
otherwise. This mirrors how the "Export on server" toggle already appears only
for a same-origin server.

Motivation: the dialog's bitrate presets are ten times apart at the low end
(Low = 1.55 MB/min, Medium = 15.5 MB/min at 1080p30), so a "6-10 MB per minute"
target is unreachable from the UI. CRF-style ffmpeg recipes miss it in the other
direction — constant *quality* means the size varies 4x with scene content, which
is exactly what made one scene land at 6 MB and another at 25 MB. Only a
size-targeted two-pass encode hits a byte budget reliably.

## Decisions locked during design

| question | decision |
| --- | --- |
| where compression runs | export server only; hidden without ffmpeg |
| ffmpeg delivery | spawn the **host binary**, no npm dependency |
| ffprobe | **not used** — the browser already knows fps and frame count |
| what the other dropdowns mean | the **master**; they are not modified or disabled |
| output format | always WebM/VP9, stated in the hint line |
| master default | MP4/H.264 at the Bitrate preset, default High (~155 MB/min at 1080p30) |
| chunking | auto: `floor(duration / 10)`, min 1, capped at core count |
| pass 1 speed | `-cpu-used 4` (stats-only pass; libvpx VOD recipe) |
| pass 2 speed | `-cpu-used 1` (measured +0.44 VMAF over 2, for ~25% more time) |
| overshoot | auto-retry once at a corrected bitrate |
| save dialog | unchanged from today's fork at `editor.ts:354` |

### Why no npm ffmpeg package

`fluent-ffmpeg` is a command-line *builder* — it spawns the same external binary,
so it removes nothing while adding an unmaintained dependency.
`ffmpeg-static` / `@ffmpeg-installer/ffmpeg` ship a prebuilt binary and solve
deployment, not architecture; they are also exactly the platform-specific-binary
packages that have previously broken this repo's Windows lockfile.
`@ffmpeg/ffmpeg` (WASM) is the only true in-process option and is 10-20x slower.

The child process is load-bearing, not incidental: it keeps a CPU-saturating
encode off the Fastify event loop, makes cancellation a `kill()`, and is what
allows chunks to run in parallel at all.

`FFMPEG_PATH` overrides the binary location. Should deployment friction ever
justify `ffmpeg-static`, it changes one line — where the path comes from.

## 1. Editor UI — `src/ui/video-settings-dialog.ts`

Two rows appended after `bitrateRow`, plus a hint label. All three hidden unless
`probeExportCapabilities()` reports `video: true`.

```
Compress            [x]                     <- BooleanInput
Target size (MB)    [ 6 ]                   <- NumericInput, min 0.1, precision 1
master H.264 High, ~155 MB upload · output WebM/VP9, ≈776 kbps
```

**Every other control is untouched and keeps its current meaning** — resolution,
format, codec, frame rate, bitrate and frame range all describe the master the
browser renders. Only the hint line mentions the output. An earlier draft forced
the format/codec selects to WebM/VP9 and disabled them; that was wrong, because
those selects drive `encodingSettingsFor()` at `:431`, which feeds
`refreshEncoderSupport()` at `:569`. Greying them to VP9 would have probed
support for a codec this path never encodes with, and could have disabled
resolutions that work fine.

Consequence: **no change to the compatibility-probe logic at all.**

### Hint arithmetic

All values come from state the dialog already holds. Frame count uses the same
formula as `render.ts:734` so the two can never disagree:

```ts
const animFrameRate = events.invoke('timeline.frameRate');
const duration      = (endFrame - startFrame) / animFrameRate;
const totalFrames   = Math.floor(duration * frameRate) + 1;   // frameRate = export fps
const seconds       = totalFrames / frameRate;                // true output duration
const kbps          = Math.floor(targetMB * 8000 / seconds * 0.97);
const uploadMB      = bitrate / 8e6 * seconds;                // bitrate from encodingSettingsFor()
```

Note `duration` uses the *timeline* rate while `seconds` uses the *export* rate;
they differ whenever the two rates differ, and only the latter is what ffmpeg
will see.

The hint shows this raw `kbps`; the server clamps it to a 32 kbps floor
(§3). The two can only disagree below the point where the `< 200` warning has
already fired.

The master's container and codec are whatever the user selected — ffmpeg reads
all four combinations the dialog offers, so no validation is needed. The default
(MP4/H.264) is also the fastest to decode; a VP9 or AV1 master merely makes the
server's decode step slower for no benefit, which the hint's "master ..." text
makes visible without forbidding it.

### Validation

| condition | behaviour |
| --- | --- |
| `targetMB <= 0` | OK disabled |
| `kbps < 200` | hint switches to `warning` style — 1080p below ~200 kbps is mush |
| `uploadMB * 1e6 > capabilities.maxUpload` | OK disabled, error-styled message |

The upload check matters: without it a 4K Ultra master silently exceeds the
server's 1 GB `MAX_UPLOAD` and fails *after* a multi-minute render.

### Returned settings

`VideoSettings` (in `src/video-config.ts`) gains one optional field:

```ts
compress?: { targetMB: number };
```

`onOK` at `:689` fills it from the input when the box is checked. Nothing else in
the returned object changes — `format` and `codec` stay whatever the user chose,
because they describe the master.

`render.video` ignores the field entirely; it is consumed by `editor.ts`.

## 2. Save path — `src/ui/editor.ts`

`show.videoSettingsDialog` at `:304` gains a compress branch:

```
                        ┌─ OPFS temp file ──render.video(settings, tempWritable)
  settings dialog ──────┤                                    │
    (+ picker, if any)  │                            master (~155 MB, on disk)
                        │                                    │
                        │         POST /api/video/compress ──┘
                        │                    │
                        │                 SSE progress
                        │                    │
                        └─ picked file  <── result Blob (WebM)
                           or download
```

`navigator.storage.getDirectory()` yields a `FileSystemFileHandle` whose
`createWritable()` returns exactly the `FileSystemWritableFileStream` that
`render.video` already accepts at `:502`. So the master streams to disk through
the existing code path and **`src/render.ts` is not modified** — it is
upstream-owned, and every edit there is future merge-conflict debt.

The temp file is removed in a `finally`, including on cancel and on error.

### Where the save dialog appears

Unchanged from today, in both directions — this is the existing
`if (window.showSaveFilePicker)` fork at `:354`, not new logic:

| browser | today | with compress |
| --- | --- | --- |
| Chrome / Edge | picker before the render | picker before the render; the compressed bytes are written at the end |
| **Brave** (picker disabled by default), Firefox | no picker; browser download dialog at 100% | no picker; browser download dialog at 100%, on the finished small file |

`showSaveFilePicker()` requires transient user activation (~5s in Chrome), so it
*cannot* be moved to the end of a multi-minute job — the gesture has expired.
Verified on the target machine: Brave reports `picker: false` and `OPFS: ok`.

One improvement over today: `createWritable()` moves from `:361` to after
compression, so no write lock is held across the job. On Brave the gain is larger
— today's fallback renders the whole master into a single `BufferTarget`
ArrayBuffer (`render.ts:528`, `:866`) beside a live WebGL context; the compress
path never does.

### Progress and cancel

`render.video` fires its own `progressStart`/`progressEnd`. After it returns,
`editor.ts` fires a second `progressStart` for the compression phase and drives
it from SSE `progress` events, matching the server-export pattern in
`export-server-client.ts`.

Cancel during compression closes the `EventSource`; the existing
`ABANDON_GRACE_MS` path at `jobs.ts:33` cancels the job 5s later, which kills the
ffmpeg processes. **No new cancel endpoint.**

### Client — `src/export-server-client.ts`

One new function beside `runServerExport`, same shape:

```ts
export const runVideoCompress = async (
    master: Blob,
    options: { targetMB: number; frameRate: number; frames: number },
    onProgress: (p: ServerProgress) => void
): Promise<Blob>
```

POSTs multipart to `/api/video/compress`, follows `/api/export/:id/events`, then
fetches `/api/export/:id/result`. The last two are reused verbatim.

`Capabilities` gains `video?: boolean` and `maxUpload?: number`.

## 3. Server

### `server/src/video-compress-plan.ts` — pure, no I/O

Kept separate so the arithmetic is unit-testable without ffmpeg installed, the
same split as `src/alignment-solve.ts`.

```ts
type Chunk = { startFrame: number; frames: number };
type Plan  = { kbps: number; seconds: number; chunks: Chunk[] };

computePlan(frames: number, frameRate: number, targetMB: number, cores: number): Plan
correctedKbps(kbps: number, actualBytes: number, targetBytes: number): number
```

- `seconds = frames / frameRate`
- `kbps = max(32, floor(targetMB * 8000 / seconds * 0.97))`
- `n = clamp(floor(seconds / 10), 1, cores)` — the 10s floor is on chunk
  *length*, not count: 10s chunks measured at the edge of noise, 4s chunks cost
  ~0.15 VMAF
- frames split as `floor(frames/n)` with the remainder spread one-each across the
  leading chunks, so **the per-chunk counts sum exactly to `frames`**
- `correctedKbps = max(32, floor(kbps * targetBytes / actualBytes))`

The script's `LC_ALL=C` bug (a comma-decimal locale making `printf` reject
`60.000000`) does not port — all arithmetic here is JS.

### `server/src/video-compress.ts` — spawns

```ts
compressVideo(masterPath, plan, onProgress, signal): Promise<Uint8Array>
```

Per chunk `i`, two sequential passes, all chunks concurrent:

```
ffmpeg -y -ss <startFrame/fps> -i <master>
       -c:v libvpx-vp9 -row-mt 1 -pix_fmt yuv420p
       -cpu-used <4|1> -b:v <kbps>k
       -vf hqdn3d=1.5:1.5:6:6
       -frames:v <chunk.frames> -an
       -pass <1|2> -passlogfile <tmp>/p<i>
       -progress pipe:1 -nostats
       (pass 1) -f null -            (pass 2) <tmp>/c<i>.webm
```

Then concat-demux:

```
ffmpeg -y -f concat -safe 0 -i <tmp>/list.txt -c copy <tmp>/out.webm
```

Details that are load-bearing:

- **`-frames:v`, not `-t`.** Duration-based chunking rounds at the seams; the
  script produced 1351 frames from a 1350-frame source until this changed.
- **`-ss` before `-i`** (input seek) for speed; frame-exactness comes from
  `-frames:v`.
- **`hqdn3d=1.5:1.5:6:6`** — temporal denoise, the single biggest
  quality-per-bit win on splat shimmer. Not exposed; changing it would
  invalidate the tuning.
- **argv arrays only, never a shell string.** All paths are server-generated
  names inside a `mkdtemp` directory; the uploaded filename is never used.
- Progress from `-progress pipe:1` (`frame=N` lines), summed across chunks over
  `2 * frames` total. Parsing stderr `-stats` would be locale- and
  version-fragile.
- Temp dir removed in a `finally`.

### Overshoot retry

After concat, `stat` the output. If `size > targetBytes`, re-run the whole plan
once at `correctedKbps(...)`, emitting a progress line so the extra minute is not
a mystery. If it still overshoots, return it anyway with a warning in the `done`
event rather than failing — a slightly-large file beats no file.

Two-pass VP9 lands close; it was H.264 that overshot in benchmarking (1.20 MB
against a 1 MB target). Expect this path to fire rarely.

### `server/src/index.ts`

```ts
app.post('/api/video/compress', ...)   // multipart: master file + options JSON
```

- Streams the uploaded part **to a temp file** with `pipeline()`, not
  `part.toBuffer()` — a 155 MB+ master must not be buffered in memory the way
  the splat routes buffer their (much smaller) gzipped PLY.
- Validates `targetMB` (0.05-2000), `frameRate` (1-240), `frames`
  (1-200000); rejects with 400 otherwise.
- Returns `202 { jobId }`.

`/api/export/capabilities` gains:

```ts
{ ..., video: <ffmpeg present>, maxUpload: <MAX_UPLOAD> }
```

probed once at boot by running `ffmpeg -version`, the same shape as the existing
`probeGpu()` at `:39`. No ffmpeg, no checkbox — the feature disappears cleanly.

### `server/src/jobs.ts`

`createJob` currently hardcodes `runExportViaWorker`. Extract the bookkeeping
(id, state, buffered events, listeners, abandon timer, TTL) into an internal
`enqueue(run)`, and express both `createJob` (splat, unchanged signature and
behaviour) and a new `createVideoJob` on top of it.

Video jobs share the **same serial chain** as splat exports. ffmpeg saturating
every core while Dawn busy-polls a GPU worker is a worse failure than waiting.

`job.result` keeps its `{ name, data }[]` shape, so `/api/export/:id/result`
serves the WebM with no change.

## 4. Localization

New keys in `static/locales/*.json`, all 9 locales:

| key | English |
| --- | --- |
| `popup.render-video.compress` | Compress |
| `popup.render-video.target-size` | Target size (MB) |
| `popup.render-video.compress-hint` | master {{codec}} {{bitrate}}, ~{{upload}} MB upload · output WebM/VP9, ≈{{kbps}} kbps |
| `popup.render-video.compress-low-bitrate` | ...quality will be poor at this size |
| `popup.render-video.compress-too-large` | ...master exceeds the server's upload limit |
| `panel.render.compressing` | Compressing video |
| `panel.render.compress-retry` | Over target — re-encoding |

Machine-assisted translations for the eight non-English locales are marked
**pending review**, per the convention used for previous batches.

## 5. Testing

### Unit — `server/test/video-compress-plan.test.ts`

Pure, no ffmpeg needed:

- 60s @ 30fps (1801 frames), 6 MB → 6 chunks; **per-chunk frames sum to exactly
  1801** (the frame-duplication bug the script hit; invisible unless asserted)
- remainder distribution: 1801 frames over 6 chunks → leading chunk gets the odd
  frame
- `seconds < 20` → single chunk; chunk count capped at `cores`
- `kbps` matches `targetMB * 8000 / seconds * 0.97`, floored at 32
- `correctedKbps` shrinks proportionally on overshoot and never returns 0
- argv builder returns an **array**, and no element is a concatenation of an
  attacker-controlled string

### Integration — `server/test/video-compress.test.ts`

`describe.skipIf(!hasFfmpeg)` so machines without ffmpeg stay green. Generates a
3s clip with ffmpeg, compresses to 0.5 MB, asserts the result is under target and
has the expected frame count.

### Manual E2E

Nothing above proves *quality*. Required before merge:

1. 1080p30, High, Compress + 6 MB, ~60s scene → file under 6 MB; compare
   side-by-side against `encode-web-video.sh -s 6 -c vp9 -p 1` output on the same
   source. They should be indistinguishable.
2. Force the retry with an absurd target (1 MB) and confirm the progress line and
   final size.
3. Cancel mid-compression; confirm the job dies server-side and the OPFS temp
   file is gone.
4. Server without ffmpeg → the rows do not appear.
5. Brave (no picker): download dialog appears at the end on the compressed file.

## Non-goals

- No audio (the editor never produces any).
- No exposed denoise, codec, or cpu-used knobs — the tuning is validated as a
  set, and exposing it invites configurations that measure worse.
- No resolution change during compression. The stated requirement is a smaller
  file at the *same* resolution.
- No browser-side compression fallback (ffmpeg.wasm is 10-20x slower).
- Image export is untouched.

## Open item

`-cpu-used 4` on pass 1 follows the documented libvpx VOD recipe — pass 1 emits
no bits, only the stats log that pass 2's rate control reads. It was **not**
isolated in this session's benchmarks, which varied pass 2 only. A coarser pass 1
yields slightly coarser statistics, so a small effect is possible in principle.
It is a single named constant; if a master from a real scene becomes available,
measure 4 vs 1 vs 0 with VMAF and revisit.
