# Design: Rough-Cut Render Duration Fix

Date: 2026-06-20 JST
Status: Draft for implementation
Scope: `scripts/render-rough-cut.ts` duration correctness only. No runtime, schema, compiler, project artifact, or media changes in this design.
Primary investigation: `reports/render-duration-investigation-lively-talk-pv.md`

## 1. Current Renderer Flow

`scripts/render-rough-cut.ts` is a reusable rough-cut CLI. It renders `05_timeline/timeline.json` to `09_output/rough-cut.mp4`, optionally muxing BGM from `02_media/`.

Current flow:

```text
timeline.json
  |
  | getTimelineFps()
  | extractVideoClips()
  |   - flattens video tracks
  |   - sorts by timeline_in_frame
  |   - returns clips only; does not emit gap intervals
  |
  | buildRenderClips()
  |   - resolves source_map entries
  |   - durationSec = min(timeline_duration_frames / fps,
  |                       (src_out_us - src_in_us) / 1_000_000)
  |
  v
per-clip ffmpeg extraction
  -ss <src_in>
  -t <durationSec>
  -vf fps=<timeline fps>,scale=1920:1080,pad=1920:1080,setsar=1
  -an -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p
  |
  v
buildRenderGroups()
  - hard cuts are merged into the same group
  - crossfade and match_cut_soft boundaries start a new group
  - positive timeline gaps are ignored, so content is collapsed
  |
  v
renderHardCutGroup()
  - single-clip group: reuse extracted temp clip
  - multi-clip group: concat demuxer with -c copy
  |
  v
assembleVideoFromGroups()
  |
  +-- one group only:
  |     probe duration and use the group output
  |
  +-- multiple groups:
        buildXfadeFilterGraph()
          [i:v]settb=AVTB,setpts=PTS-STARTPTS[vi]
          xfade offset = currentDurationSec - effectiveXfadeDuration
        renderXfadeGraph()
          -filter_complex <graph>
          -an -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p
        if graph output is more than 1s short:
          renderIterativeXfades()
            uses the same settb=AVTB,setpts=PTS-STARTPTS reset
  |
  v
optional BGM mux
  -i video -i bgm -c:v copy -c:a aac -shortest
```

The important detail for the setpts decision is that source clip extraction is already a full re-encode. The current problem is not that raw source clips enter concat unchanged. It is that already-normalized temp clips are then copy-concatenated into a hard-cut group, and that copied group later enters a timestamp-resetting xfade graph.

## 2. Root Cause Analysis

The investigation found two separate duration issues.

### 2.1 Timestamp loss in xfade input normalization

`projects/lively-talk-pv` has 21 rendered clips. The first 20 are hard cuts and the last boundary is one crossfade. The renderer therefore:

1. Extracts 21 normalized temp clips.
2. Copy-concats clips 1-20 into one hard-cut group.
3. Feeds that hard-cut group plus clip 21 into the xfade graph.
4. Applies `settb=AVTB,setpts=PTS-STARTPTS` to both xfade inputs.

The copied hard-cut group probes and decodes as `44.750s / 1074f`. But applying `setpts=PTS-STARTPTS` to that group truncates it to `39.875s / 957f`. The same loss appears in the final rough cut. The iterative retry cannot recover because it applies the same timestamp reset to the same grouped input.

This is an ffmpeg timestamp contract bug in the renderer path:

- The concat demuxer with `-c copy` is fast, but it can carry packet timestamp discontinuities from the MP4 temp clips into the group output.
- `setpts=PTS-STARTPTS` depends on the input PTS values. On the copied group, those values are not a safe monotonic timeline.
- The xfade graph is the first path that filters the copied group, so the loss appears only when a hard-cut group later participates in a crossfade.

`ena-promo-ai` does not currently expose the same unexplained loss because it has many crossfade boundaries. Those boundaries split the edit into smaller groups, so there is no long 20-clip copy-concat group entering one late xfade. A local read on 2026-06-20 shows:

```text
ena-promo-ai timeline span:       87.083s
content duration:                 64.833s
collapsed gaps:                   22.250s
crossfade-like transitions:       15
expected collapsed render:        about 57.333s
current rough-cut.mp4 duration:   57.292s
```

That is within roughly one frame of the current collapsed-content contract.

### 2.2 Timeline gaps are collapsed by design

`lively-talk-pv` has three positive timeline gaps:

```text
CLP_0001 -> CLP_0002:   24 frames
CLP_0003 -> CLP_0007:   44 frames
CLP_0019 -> CLP_0020:  180 frames
total:                 248 frames = 10.333s at 24fps
```

The renderer does not generate black frames, frozen frames, or silence for those intervals. It sorts clips by timeline position and renders only the clip bodies. Therefore a correct current-semantics render cannot match the timeline span.

For `lively-talk-pv`, the right expected duration under current gap-collapse semantics is:

```text
Timeline span:                    57.333s
- collapsed internal gaps:        10.333s
= timeline content:               47.000s
- source range clamp:              0.198s
- extraction quantization:         0.052s
- one crossfade overlap:           0.500s
= expected collapsed render:      46.250s

Current actual render:            39.875s
Unexpected renderer loss:          6.375s
```

The gap loss and timestamp loss must be handled as different problems. Filling gaps would make the output closer to timeline span, but it would not fix the 6.375s tail loss. Fixing timestamps would make the output about 46.250s, not 57.333s, unless gap fill is explicitly added.

## 3. Setpts Fix Options

Scale:

- Correctness: likelihood of eliminating the 6.375s loss without hiding other timing bugs.
- Speed: relative render cost.
- Quality: risk of extra generational loss.
- Complexity: implementation and test surface.

| Option | Correctness | Speed | Quality | Complexity | Evaluation |
| --- | --- | --- | --- | --- | --- |
| A. Re-encode each clip individually before concat | Low as stated | Current speed if no-op; slower if an extra per-clip pass is added | No extra loss if it is the existing extraction; extra loss if it adds another pass | Low | The renderer already re-encodes each extracted temp clip with `libx264`, `fps=<timeline fps>`, scale/pad, and `setsar=1`. The failing object is the later `-c copy` hard-cut group, not raw source clips. This option is effectively already implemented and is not sufficient. |
| B. Re-encode the concat output before xfade | High if timestamps are regenerated from decoded frame order | Medium | One extra generation for each normalized hard-cut group that enters xfade | Medium | A full normalization pass over the copied group can work if it regenerates timestamps from frame index rather than `PTS-STARTPTS`. It is safe but makes the pipeline copy-concat, then re-encode, then xfade-re-encode. |
| C. Use concat demuxer with `-c:v libx264` instead of `-c copy` for groups that enter xfade | High | Medium | One extra generation for affected hard-cut groups | Low to medium | This fixes the problem at the group boundary and keeps the change local to `renderHardCutGroup()` / `assembleVideoFromGroups()`. It should be targeted to groups that will enter xfade, so all-hard-cut renders can keep the fast copy path. |
| D. Remove setpts and compute xfade offset from extracted clip durations | Medium to low | Fast | No extra loss | Medium | Fastest, but risky. `xfade` still receives an input with discontinuous or non-zero timestamps, and offset math alone does not make the filter graph timestamp-safe. This may shift the failure rather than fix it. |
| E. Re-encode each clip during extraction and add timestamp flags | Low to medium | Current speed for existing re-encode; slower only if extra work is added | No extra loss if flags only | Low | Extraction already re-encodes. Adding flags such as a timeline-fps-derived `video_track_timescale` may make temp files cleaner, but it does not address the copy-concat group that reproduced the loss. Also, do not hard-code `24`; use the timeline fps because generated 30fps sources and 24fps camera sources both need to be normalized by sequence settings. |

### Recommended Setpts Fix

Use a targeted version of Option C:

1. Keep the current per-clip extraction re-encode.
2. Keep `-c copy` for multi-clip hard-cut groups only when the final assembly has no xfade path.
3. When a hard-cut group will become an input to `buildXfadeFilterGraph()` or `renderIterativeXfades()`, render that group with a timestamp-normalizing concat re-encode instead of `-c copy`.
4. Probe the normalized group duration and compare it to the expected group duration before xfade.
5. Keep the xfade graph duration check, but apply it after both the graph attempt and the iterative fallback.

The normalization command should decode every frame and write fresh monotonic timestamps. The implementation should avoid the failing expression on copied group inputs. A practical command shape is:

```text
ffmpeg -y
  -f concat -safe 0 -i <group-list.txt>
  -vf settb=AVTB,setpts=N/(<timeline_fps>*TB),format=yuv420p
  -an
  -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p
  <group.mp4>
```

`setpts=N/(<timeline_fps>*TB)` is frame-index based. It does not trust incoming PTS the way `PTS-STARTPTS` does. If this expression proves incompatible with fractional fps in testing, use an equivalent rational expression derived from `fps_num/fps_den` rather than hard-coding an integer timescale.

Do not put PTS-sensitive filters before this frame-index timestamp regeneration. The per-clip extraction step has already normalized fps, resolution, SAR, and pixel format, so the group normalization pass should only need to regenerate timestamps and encode a clean MP4. If later testing requires an `fps=<timeline_fps>` filter in the group pass, place it after `setpts=N/(<timeline_fps>*TB)`.

Why not recommend D:

- It preserves the very input condition that caused the bug.
- `xfade` is timestamp-sensitive. Feeding it copy-concat groups without normalization keeps the renderer dependent on container-specific PTS behavior.
- The speed gain is not worth a latent missing-tail risk in a rough-cut tool whose output is used for human review.

Why not recommend A or E:

- The current extraction command already re-encodes temp clips. The evidence points after extraction, at copy-concat hard-cut grouping.

## 4. Gap Handling Options

| Option | Correctness | Speed | Quality / Editorial Fit | Complexity | Evaluation |
| --- | --- | --- | --- | --- | --- |
| A. Insert black frames for gaps | High for timeline span parity | Medium | Weak default. Black gaps make rough cuts look broken unless the gap is intentional | Medium to high | This would make rendered duration match timeline span, but it changes the editorial meaning of gaps. It also requires silence generation, transition behavior around filler, and BGM handling rules. |
| B. Keep gap collapse, but make it explicit | High for current rough-cut contract | Fast | Best default. Rough cuts should show selected content, not accidental empty space | Low | The renderer should compute `expected_rendered_duration` from rendered content minus effective crossfade overlaps, and report collapsed gap duration separately from unexpected render loss. |
| C. Configurable gap policy: collapse, black, freeze | High if well-specified | Depends on policy | Flexible, but only useful if users need timeline-span debugging or intentional pauses | High | Good future extension. It should not be the first fix because it expands the rendering contract while the timestamp bug is still unresolved. Freeze is especially risky because it can imply footage continuity that does not exist. |

### Recommended Gap Policy

Keep default gap collapse and make it explicit.

For Video OS v2 rough cuts, a positive timeline gap is usually a compiler or planning spacing artifact, not a request to show black. The rough-cut renderer should produce a reviewable content sequence by default. If timeline-span parity is needed later, add an explicit option:

```text
--gap-fill collapse   # default
--gap-fill black      # future diagnostic/export mode
```

Do not add `freeze` in the first implementation. It is more editorially opinionated than black and has higher risk of creating misleading output.

## 5. Recommended Approach

Implement a narrow renderer fix with two contracts:

1. Timestamp contract:
   - Any multi-clip hard-cut group that will feed an xfade graph must be timestamp-normalized by re-encoding the concat step.
   - The renderer must fail or emit a hard duration-parity warning if final video assembly is materially shorter than expected after fallback.

2. Duration accounting contract:
   - Timeline span is not the default expected render duration.
   - Default expected render duration is collapsed content duration after source clamp, extraction/group quantization, and effective crossfade overlaps.
   - Collapsed gaps, source clamps, quantization, crossfade overlaps, and unexpected loss must be reported separately.

This keeps the patch script-local, avoids schema changes, preserves the current rough-cut editorial behavior, and targets the exact `lively-talk-pv` failure mode without rewriting the renderer around a full RenderSpec.

## 6. Implementation Sketch

Target file:

```text
scripts/render-rough-cut.ts
```

Target tests:

```text
tests/render-rough-cut.test.ts
```

No schema changes are required.

### 6.1 Add duration accounting types

Add local-only interfaces:

```ts
interface RenderDurationAccounting {
  timelineSpanSec: number;
  timelineContentSec: number;
  collapsedGapSec: number;
  sourceClampLossSec: number;
  requestedClipTotalSec: number;
  probedGroupTotalSec: number;
  crossfadeOverlapSec: number;
  expectedRenderedDurationSec: number;
  actualRenderedDurationSec?: number;
  unexpectedLossSec?: number;
}
```

To compute this cleanly, `RenderClip` should keep enough timeline metadata to calculate gaps and clamps:

```ts
timelineDurationSec: number;
sourceRangeDurationSec: number;
timelineOutFrame: number;
```

These are script-local TypeScript fields only. They do not alter `timeline.json`.

### 6.2 Preserve gap collapse but report it

Add a helper such as:

```ts
function computeTimelineContentAccounting(clips: RenderClip[], fps: number): Pick<
  RenderDurationAccounting,
  "timelineSpanSec" | "timelineContentSec" | "collapsedGapSec" | "sourceClampLossSec" | "requestedClipTotalSec"
>
```

Rules:

- Sort by `timelineInFrame`, same as extraction.
- `timelineSpanSec = (last timelineOutFrame - first timelineInFrame) / fps`.
- `timelineContentSec = sum(timelineDurationSec)`.
- `collapsedGapSec = sum(max(0, next.timelineInFrame - prev.timelineOutFrame)) / fps`.
- `sourceClampLossSec = sum(max(0, timelineDurationSec - durationSec))`.
- `requestedClipTotalSec = sum(durationSec)`.

The CLI summary should print or warn with these components when a meaningful difference exists:

```text
Timeline span: 57.333s
Collapsed gaps: 10.333s
Source clamp: 0.198s
Crossfade overlap: 0.500s
Expected rendered video: 46.250s
Actual rendered video: 46.250s
```

### 6.3 Normalize hard-cut groups only before xfade

Change `renderHardCutGroup()` to accept normalization context:

```ts
async function renderHardCutGroup(
  group: RenderGroup,
  index: number,
  tempDir: string,
  opts: { fps: number; normalizeTimestamps: boolean },
): Promise<string>
```

Behavior:

- Single-clip group: return the temp clip path.
- Multi-clip group with `normalizeTimestamps: false`: keep current `-c copy`.
- Multi-clip group with `normalizeTimestamps: true`: use concat demuxer plus `libx264` re-encode and frame-index timestamp regeneration.

In `assembleVideoFromGroups()`:

```ts
const willUseXfade = groups.length > 1;
groupPaths.push(await renderHardCutGroup(groups[index], index, tempDir, {
  fps,
  normalizeTimestamps: willUseXfade,
}));
```

This preserves the fast all-hard-cut path and only pays the re-encode cost for groups that would otherwise enter xfade with unsafe PTS.

### 6.4 Strengthen xfade duration validation

Current behavior:

- The first xfade graph warns if output is more than 1s shorter than expected.
- The iterative retry result is returned without being compared against the original expected graph duration.

New behavior:

- Use a frame-based tolerance, for example `max(2 / fps, 0.100)`.
- Compare both graph output and iterative output against the expected graph duration.
- If both are short beyond tolerance, fail the render by default because missing tail content is a data-loss bug.

Suggested helper:

```ts
function assertDurationParity(
  label: string,
  actualSec: number,
  expectedSec: number,
  fps: number,
): void
```

Failure message should include the accounting components:

```text
duration parity failed after iterative xfade:
expected rendered video 46.250s, got 39.875s, unexpected loss 6.375s
timeline span 57.333s, collapsed gaps 10.333s, crossfade overlap 0.500s
```

If preserving non-fatal CLI behavior is preferred, add a flag later such as `--allow-duration-mismatch`. The default should be fail-fast because a successful render with missing clips is worse than a loud failure.

### 6.5 Probe video stream duration, not only container duration

`probeDurationSec()` currently reads `format=duration`. Keep it for BGM discovery, but add a video-specific probe for render validation:

```ts
async function probeVideoDurationSec(filePath: string, fps?: number): Promise<number>
```

Use `ffprobe -select_streams v:0` and prefer stream duration or `nb_read_frames / fps` when frame count is available. The investigation used frame counts to prove `1074f -> 957f`, and the renderer should use the same kind of evidence for validation.

### 6.6 BGM mux validation

BGM is not the cause of the current `lively-talk-pv` loss. Still, `-shortest` can truncate video if an explicit short BGM is supplied.

First implementation:

- Validate video assembly before BGM mux.
- After BGM mux, probe the final video stream and warn or fail if it is shorter than the validated video assembly beyond tolerance.
- Keep auto BGM selection fail-open. Projects without suitable BGM should still render video-only.

Do not redesign audio looping or padding in this fix.

## 7. Test Plan

### 7.1 Unit tests

Add focused tests to `tests/render-rough-cut.test.ts`:

1. `buildRenderClips()` preserves timeline metadata needed for accounting.
2. A timeline with positive gaps computes:
   - timeline span
   - content duration
   - collapsed gap duration
   - requested clip duration after source clamp
3. `buildRenderGroups()` still merges hard cuts and splits crossfade boundaries.
4. The group render command builder uses:
   - `-c copy` for all-hard-cut final assembly
   - `libx264` normalization when the group will feed xfade
5. Duration parity helper passes within tolerance and fails beyond tolerance.
6. `buildXfadeFilterGraph()` expected duration remains content minus effective overlap.

The existing test that checks the xfade filter string may need to change only if the implementation also switches xfade segment normalization from `PTS-STARTPTS` to frame-index `N/(fps*TB)`. If Option C is implemented without changing the xfade graph, that test can remain mostly intact.

### 7.2 ffmpeg integration fixture

Add a small fixture test that runs only when `ffmpeg` and `ffprobe` are available:

1. Generate short synthetic MP4 clips with ffmpeg color or testsrc inputs.
2. Build a temp timeline with many hard cuts followed by one late crossfade.
3. Render through `scripts/render-rough-cut.ts`.
4. Assert final video duration is within two frames of expected collapsed render duration.

The fixture should not depend on `projects/lively-talk-pv` media so CI stays portable.

### 7.3 Project smoke checks

Manual or local verification after implementation:

```text
npm test -- tests/render-rough-cut.test.ts
npx tsc --noEmit
npx tsx scripts/render-rough-cut.ts --project projects/lively-talk-pv --output /tmp/lively-fixed.mp4
ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=duration,nb_read_frames -of default=noprint_wrappers=1 /tmp/lively-fixed.mp4
npx tsx scripts/render-rough-cut.ts --project projects/ena-promo-ai --output /tmp/ena-fixed.mp4
ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=duration,nb_read_frames -of default=noprint_wrappers=1 /tmp/ena-fixed.mp4
```

Acceptance criteria:

- `lively-talk-pv` renders around `46.250s` under default gap collapse, not `39.875s`.
- `lively-talk-pv` duration report explicitly shows `10.333s` collapsed gaps and no unexplained `6.375s` loss.
- `ena-promo-ai` remains around `57.292s` to `57.333s` under default gap collapse.
- A render with a real unexpected shortfall fails or emits a hard duration-parity warning after iterative fallback.
- No schema files, runtime compiler files, or project artifacts are modified.

### 7.4 Existing test impact

The existing helper tests should not need broad rewrites if the implementation follows targeted Option C. Expected test changes are limited to:

- Update or add tests for `renderHardCutGroup()` or a command-builder helper so the new normalize-vs-copy branch is covered.
- Keep the current `buildXfadeFilterGraph()` expectations if the xfade graph still uses `PTS-STARTPTS` on already-normalized group inputs.
- Update the xfade filter string assertion only if the implementation also changes xfade segment reset to frame-index `N/(fps*TB)`.
- Preserve existing `buildRenderClips()` clamp behavior; add metadata fields without changing the clamp result.

## 8. Risk Assessment

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Extra re-encode slows xfade renders | Medium | Normalize only multi-clip hard-cut groups that feed xfade. Keep all-hard-cut final assembly on `-c copy`. Clips are short in the known failure case. |
| Extra generation reduces visual quality | Medium | Keep the normalization pass targeted. Use the existing CRF 18 first for consistency; if visual QA shows degradation, raise the intermediate quality for normalized temp groups without changing final output profile. |
| `setpts=N/(fps*TB)` expression mishandles fractional fps | Medium | Build expression from `fps_num/fps_den` or use an ffmpeg-tested rational expression. Add a fractional-fps unit/integration case before broad use. |
| All-hard-cut projects keep copy-concat timestamps | Low | They do not enter xfade, so the known truncation trigger is absent. Still validate final video duration against probed group duration. |
| `ena-promo-ai` duration changes | Medium | Local current artifact is already near expected collapsed duration. Add an `ena-promo-ai` smoke check before merging and compare video stream duration, not just render logs. |
| Timeline-span users expect black gaps | Medium | Document and print default `gap-fill=collapse` semantics. Add `--gap-fill black` later only as an explicit option. |
| BGM `-shortest` hides a video truncation | Medium | Validate video assembly before mux and final video stream after mux. Auto-select only BGM candidates at least as long as video, as current code already does. |
| Existing tests only mock planning helpers | Medium | Add a tiny ffmpeg integration fixture plus duration accounting unit tests. Do not rely only on string checks or successful command exit. |

## 9. Non-Goals

- Do not redesign the compiler placement model.
- Do not change timeline schemas.
- Do not implement freeze-frame gap fill in the first fix.
- Do not make rough-cut render match timeline span by default.
- Do not replace the renderer with a full RenderSpec architecture in this patch.

## 10. Final Recommendation

Implement targeted concat re-encoding for hard-cut groups that feed xfade, keep default gap collapse, and add explicit duration accounting plus parity validation.

This is the smallest practical fix that addresses the actual missing-tail bug while preserving Video OS v2's current rough-cut behavior. It also gives future debugging the right numbers: timeline span, collapsed gaps, clamp/quantization, crossfade overlap, expected rendered duration, and actual probed video duration.
