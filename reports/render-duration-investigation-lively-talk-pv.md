# Render Duration Investigation: lively-talk-pv

Date: 2026-06-20 JST  
Project: `projects/lively-talk-pv`  
Scope: investigation only; no runtime, schema, project artifact, or media changes.

## Summary

The 17.458s shortfall from timeline span to rendered MP4 is a combination of three expected renderer behaviors plus one render bug:

| Component | Seconds | Notes |
| --- | ---: | --- |
| Timeline span | 57.333 | Last video clip ends at frame 1376 at 24fps. |
| Internal gaps collapsed by renderer | -10.333 | Three timeline gaps: 24 + 44 + 180 frames. Renderer does not synthesize black/silence. |
| Source range clamp | -0.198 | Six clips have `src_out_us - src_in_us` about one frame shorter than `timeline_duration_frames / fps`. |
| Extraction frame quantization | -0.052 | Extracted temp clips total 46.750s instead of requested 46.802s. |
| One crossfade overlap | -0.500 | Only `CLP_0020 -> CLP_0021` is a crossfade. |
| `setpts`/xfade tail loss | -6.375 | Hard-cut group probes as 44.750s, but applying `setpts=PTS-STARTPTS` before xfade truncates it to 39.875s. |
| Actual rendered MP4 | 39.875 | `ffprobe` video duration and container duration match. |

Root cause: `scripts/render-rough-cut.ts` first copy-concats the 20 hard-cut clips before the single crossfade, then feeds that copy-concat group through `settb=AVTB,setpts=PTS-STARTPTS` before `xfade`. For this project, applying `setpts=PTS-STARTPTS` to the hard-cut group is enough to collapse 44.750s/1074 frames to 39.875s/957 frames. The iterative xfade retry cannot recover because it applies the same timestamp-reset filter to the same two segments.

This is not the compiler gap/fill issue. The timeline artifact contains the expected 21 clips and 1128 content frames. The renderer currently collapses gaps by design, and then loses additional duration during filtered assembly.

## Evidence Checked

- Timeline: `projects/lively-talk-pv/05_timeline/timeline.json`
- Rendered MP4: `projects/lively-talk-pv/09_output/rough-cut.mp4`
- Source map: `projects/lively-talk-pv/02_media/source_map.json`
- Source metadata: `projects/lively-talk-pv/03_analysis/assets.json`
- First-run report: `reports/lively-talk-pv-first-run.md`
- Renderer source: `scripts/render-rough-cut.ts`
- `ffprobe` on every source MP4, BGM, current rough cut, and reproduced temp intermediates.

## Clip-by-Clip Accounting

`TL sec` is `timeline_duration_frames / 24`. `Src range` is `(src_out_us - src_in_us) / 1e6`. `Render req` is the current `buildRenderClips()` duration: `min(TL sec, Src range)`. `Temp out` is the reproduced extracted clip output duration before concat/xfade.

| # | Clip | Beat | Source | TL frames | Gap before | TL sec | Src in-out sec | Src range | Source dur | Render req | Temp out | Final MP4 coverage |
| ---: | --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | `CLP_0001` | `b01_hook` | `21-may-a-person.mp4` | 0-120 | 0 | 5.000 | 1.500-6.500 | 5.000 | 8.000 | 5.000 | 5.000 / 120f | full |
| 2 | `CLP_0002` | `b02_problem` | `04-may-a-person-is.mp4` | 144-180 | 24 | 1.500 | 1.250-2.750 | 1.500 | 4.301 | 1.500 | 1.500 / 36f | full |
| 3 | `CLP_0005` | `b02_problem` | `13-may-a-person-is.mp4` | 180-300 | 0 | 5.000 | 1.500-6.500 | 5.000 | 8.000 | 5.000 | 5.000 / 120f | full |
| 4 | `CLP_0004` | `b02_problem` | `12-may-a-person-is.mp4` | 300-312 | 0 | 0.500 | 2.650-3.150 | 0.500 | 4.301 | 0.500 | 0.500 / 12f | full |
| 5 | `CLP_0006` | `b02_problem` | `06-may-a-person-is.mp4` | 312-356 | 0 | 1.833 | 2.500-4.300 | 1.800 | 4.301 | 1.800 | 1.792 / 43f | full |
| 6 | `CLP_0003` | `b02_problem` | `09-may-a-person-is.mp4` | 356-460 | 0 | 4.333 | 0.000-4.301 | 4.301 | 4.301 | 4.301 | 4.292 / 103f | full |
| 7 | `CLP_0007` | `b03_talk` | `08-may-a-person-is.mp4` | 504-528 | 44 | 1.000 | 2.650-3.650 | 1.000 | 4.301 | 1.000 | 1.000 / 24f | full |
| 8 | `CLP_0015` | `b03_talk` | `20-may-a-person-is.mp4` | 528-580 | 0 | 2.167 | 0.000-5.000 | 5.000 | 8.000 | 2.167 | 2.167 / 52f | full |
| 9 | `CLP_0011` | `b03_talk` | `19-may-a-person-is.mp4` | 580-640 | 0 | 2.500 | 5.500-8.000 | 2.500 | 8.000 | 2.500 | 2.500 / 60f | full |
| 10 | `CLP_0008` | `b03_talk` | `14-may-a-person-is.mp4` | 640-676 | 0 | 1.500 | 4.500-6.000 | 1.500 | 8.000 | 1.500 | 1.500 / 36f | full |
| 11 | `CLP_0012` | `b03_talk` | `16-may-a-person-is.mp4` | 676-700 | 0 | 1.000 | 3.000-4.000 | 1.000 | 8.000 | 1.000 | 1.000 / 24f | full |
| 12 | `CLP_0013` | `b03_talk` | `18-may-a-person-is.mp4` | 700-760 | 0 | 2.500 | 3.000-5.500 | 2.500 | 8.000 | 2.500 | 2.500 / 60f | full |
| 13 | `CLP_0009` | `b03_talk` | `17-may-a-person-is.mp4` | 760-808 | 0 | 2.000 | 2.500-4.500 | 2.000 | 8.000 | 2.000 | 2.000 / 48f | full |
| 14 | `CLP_0010` | `b03_talk` | `03-may-a-person-is.mp4` | 808-832 | 0 | 1.000 | 2.000-3.000 | 1.000 | 4.301 | 1.000 | 1.000 / 24f | full |
| 15 | `CLP_0014` | `b03_talk` | `02-may-a-person-is.mp4` | 832-864 | 0 | 1.333 | 1.850-3.150 | 1.300 | 4.301 | 1.300 | 1.292 / 31f | full |
| 16 | `CLP_0016` | `b04_after` | `07-may-a-person-is.mp4` | 864-968 | 0 | 4.333 | 0.000-4.301 | 4.301 | 4.301 | 4.301 | 4.292 / 103f | full |
| 17 | `CLP_0018` | `b04_after` | `01-may-a-person-is.mp4` | 968-992 | 0 | 1.000 | 2.250-3.250 | 1.000 | 4.301 | 1.000 | 1.000 / 24f | full |
| 18 | `CLP_0017` | `b04_after` | `05-may-a-person-is.mp4` | 992-1016 | 0 | 1.000 | 1.000-2.000 | 1.000 | 4.301 | 1.000 | 1.000 / 24f | full |
| 19 | `CLP_0019` | `b04_after` | `05-may-a-person-is.mp4` | 1016-1044 | 0 | 1.167 | 3.167-4.301 | 1.134 | 4.301 | 1.134 | 1.125 / 27f | partial: about 13/27f |
| 20 | `CLP_0020` | `b05_closing` | `11-may-a-person-is.mp4` | 1224-1328 | 180 | 4.333 | 0.000-4.300 | 4.300 | 4.301 | 4.300 | 4.292 / 103f | missing |
| 21 | `CLP_0021` | `b05_closing` | `10-may-a-person-is.mp4` | 1328-1376 | 0 | 2.000 | 0.000-4.301 | 4.301 | 4.301 | 2.000 | 2.000 / 48f | missing |

Findings:

- Every `src_out_us` is within the actual source file duration. There are no source files too short for their requested source range.
- Six clips have source ranges about one frame shorter than their timeline durations: `CLP_0006`, `CLP_0003`, `CLP_0014`, `CLP_0016`, `CLP_0019`, `CLP_0020`. Total metadata clamp is about 0.198s.
- The AI/generated source MP4s all probe successfully as H.264 1280x720. Some sources are 8.000s at 24fps, while several are 4.300651s with 129 frames and a non-24fps source rate. Those shorter/rate-mismatched files explain one-frame extraction quantization, not the 6.375s tail loss.
- The final MP4 contains the first 18 collapsed clips, then only part of `CLP_0019`; `CLP_0020` and `CLP_0021` are not present in the current rendered output.

## Duration Reconciliation

Timeline and content:

```text
Timeline span:                      1376 frames / 24 = 57.333s
- Internal gaps collapsed:           248 frames / 24 = 10.333s
= Timeline content:                 1128 frames / 24 = 47.000s
- buildRenderClips source clamp:                         0.198s
= Renderer requested clip total:                       46.802s
- ffmpeg extraction quantization:                        0.052s
= Extracted temp clip total:                            46.750s
- One crossfade overlap:               12 frames / 24 = 0.500s
= Expected current-renderer output:                    46.250s
Actual rendered MP4:                                   39.875s
Unaccounted after gap/clamp/crossfade accounting:       6.375s
```

The render log warning is accurate: `xfade graph duration 39.875s was shorter than expected 46.250s`.

The 60s target adds a separate tail gap:

```text
60s target:                         1440 frames
Timeline last frame:                1376 frames
Tail gap to target:                   64 frames / 24 = 2.667s
```

That 2.667s is not part of the 57.333s timeline span, but it explains the first-run report's 60s target gap.

## Render Code Path

Relevant code paths in `scripts/render-rough-cut.ts`:

- Clip extraction ignores timeline gaps as material to render. `extractVideoClips()` flattens/sorts clips by `timeline_in_frame`, but returns only clip records, not gap intervals: `scripts/render-rough-cut.ts:250`.
- Crossfade extraction keeps only `crossfade` and `match_cut_soft`; it intentionally ignores `cut` transitions: `scripts/render-rough-cut.ts:298`.
- Non-crossfade boundaries are merged into one render group by adding durations and appending paths. No check inserts black frames for positive gaps: `scripts/render-rough-cut.ts:335`.
- `buildRenderClips()` uses `Math.min(timeline_duration_frames / fps, (src_out_us - src_in_us) / 1_000_000)`, so source range can shorten the render request: `scripts/render-rough-cut.ts:369`.
- The 20 hard-cut clips are concatenated with `ffmpeg -f concat ... -c copy`: `scripts/render-rough-cut.ts:525`.
- The xfade graph applies `settb=AVTB,setpts=PTS-STARTPTS` to each segment before `xfade`: `scripts/render-rough-cut.ts:428`.
- The xfade offset is computed from probed group duration, here 44.750s - 0.500s = 44.250s: `scripts/render-rough-cut.ts:439`.
- If the graph output is too short, the retry path calls `renderIterativeXfades()`, but that path applies the same `settb=AVTB,setpts=PTS-STARTPTS` filter to the same two inputs: `scripts/render-rough-cut.ts:568`.
- The warning threshold detects the problem but still returns the iterative result without a second duration parity check against the original expected graph duration: `scripts/render-rough-cut.ts:663`.
- Source audio is stripped during clip extraction with `-an`, and xfade outputs are video-only; this is intentional and not the duration cause: `scripts/render-rough-cut.ts:713`, `scripts/render-rough-cut.ts:551`, `scripts/render-rough-cut.ts:601`.
- Optional BGM muxing happens after video assembly with `-shortest`: `scripts/render-rough-cut.ts:740`. The BGM probes at 207.080s, so it is not shortening this output. The current rough cut probes as video-only.

## Xfade and Intermediate Reproduction

I reproduced the renderer's temp pipeline into `/tmp` with the same ffmpeg commands:

| Stage | Duration | Frames | Result |
| --- | ---: | ---: | --- |
| Sum of requested render clips | 46.802s | n/a | `buildRenderClips()` math |
| Sum of extracted temp clips | 46.750s | 1122 | One-frame quantization on several clips |
| Hard-cut group 1, clips 1-20, `-c copy` | 44.750s | 1074 | Probes and decodes as full length |
| Clip 21 group | 2.000s | 48 | Single temp clip |
| Expected xfade graph | 46.250s | 1110 | 44.750 + 2.000 - 0.500 |
| Actual xfade graph output | 39.875s | 957 | Same as bad rough cut |
| Re-encode copied group without filter | 44.750s | 1074 | No loss |
| Re-encode copied group with `setpts=PTS-STARTPTS` | 39.875s | 957 | Exact loss reproduced |
| Re-encode copied group with `settb=AVTB,setpts=PTS-STARTPTS` | 39.875s | 957 | Exact loss reproduced |

The copied hard-cut group can decode to all 1074 frames with a simple null output. The duration loss appears when a timestamp-resetting filter is applied to that group. Since the xfade graph always starts each input with `settb=AVTB,setpts=PTS-STARTPTS`, the single late crossfade triggers the truncation.

The final MP4's 957 frames line up with the collapsed clip sequence ending partway through `CLP_0019`:

```text
Collapsed extracted frames through CLP_0018: 944 frames
Final MP4 frames:                            957 frames
Surviving CLP_0019 frames:                    13 frames
Dropped tail: CLP_0019 remainder + CLP_0020 + CLP_0021
```

## Gap and Transition Handling

The timeline has 20 transition records:

```text
cut:       19
crossfade:  1
```

The report's "crossfades: 1" is correct. The other 19 transitions are cuts, not dropped crossfades.

Gap handling is the bigger expected-duration difference:

- `CLP_0001 -> CLP_0002`: 24-frame gap.
- `CLP_0003 -> CLP_0007`: 44-frame gap.
- `CLP_0019 -> CLP_0020`: 180-frame gap.

The renderer does not insert black/silence for these gaps. It collapses clips into content order, so timeline span parity is impossible even if xfade is fixed. With current semantics, a correct render should be about 46.250s for this artifact, not 57.333s.

## Source Validation

All timeline source files exist through `02_media/source_map.json`, and all required `src_out_us` values fit within the probed source file durations.

The source MP4s do not show a fatal codec/container issue:

- Codec: H.264 for all probed video sources.
- Resolution: 1280x720 for all probed video sources.
- Source durations: either 8.000s/192 frames at 24fps, or 4.300651s/129 frames at about 30fps.
- The 4.300651s sources are the reason some 104-frame timeline clips clamp/extract to 103 frames, but that accounts for frame-level loss only.

The problematic container/timestamp behavior is introduced by the renderer's intermediate hard-cut concat/filter path, not by an unreadable source file.

## Does This Affect ena-promo-ai?

The local current `projects/ena-promo-ai` artifact does not show the same unexplained renderer loss:

```text
Current ena-promo-ai timeline span:       87.083s
Content frames:                           1556 = 64.833s
Timeline gaps:                             534 = 22.250s
Crossfade-like transitions:                 15 = about 7.500s overlap
Expected current-renderer output:          57.333s
Actual local rough-cut.mp4:                57.292s
```

That is consistent with content duration minus crossfade overlaps, within about one frame. It differs from the prompt's earlier ena-promo-ai numbers, so the local artifact appears to have changed since that run.

The bug is not project-specific in code, but lively-talk-pv is the project that exposes it clearly because it has one long hard-cut group of 20 clips followed by a single late crossfade. Current ena-promo-ai has many crossfades, which split rendering into many smaller groups; it does not exercise the same long copy-concat group through one late `setpts`/xfade edge.

Risk condition for other projects:

- Multiple hard-cut clips are copy-concatenated into a long group.
- A later crossfade causes that group to enter `buildXfadeFilterGraph()` or `renderIterativeXfades()`.
- The copy-concat group has timestamp behavior that `setpts=PTS-STARTPTS` truncates.

## Recommendations

1. Add a renderer parity assertion after the iterative retry.
   - If `renderIterativeXfades()` returns output still shorter than the expected graph duration by more than tolerance, fail the render or warn with a hard "duration parity failed" status.
   - Current code detects the initial graph shortfall but accepts the retry result without comparing it back to the original expected duration.

2. Stop feeding copy-concat hard-cut groups through `setpts` unverified.
   - A direct reproduction shows `setpts=PTS-STARTPTS` on the hard-cut group is sufficient to truncate 44.750s to 39.875s.
   - Normalize hard-cut groups in a way that proves frame count/duration before xfade, or avoid the intermediate copy-concat group for xfade boundaries.

3. Prefer a single filter graph for mixed hard cuts and crossfades, or use concat filter with explicit PTS normalization per original extracted clip.
   - The extracted individual temp clips have clean 0-start PTS and known frame counts.
   - Applying transitions at the clip level avoids creating a long copy-concat group that later needs timestamp reset.

4. If timeline span parity is the desired contract, add explicit filler generation for timeline gaps.
   - The current renderer collapses gaps. A fixed xfade path would render about 46.250s, not 57.333s.
   - To render 57.333s, positive gaps need generated black video/silence segments and transition logic that treats them intentionally.

5. Keep the `src_out_us` clamp, but report it separately.
   - The clamp is protective and currently accounts for only about 0.198s here.
   - Duration reports should distinguish source clamp, frame quantization, gap collapse, crossfade overlap, and unexpected filter loss.

6. Add a focused regression fixture.
   - Build or reuse a timeline with a long hard-cut group followed by one late crossfade.
   - Assert extracted clip total, group duration, xfade expected duration, and final probed duration.
   - Include a case where the hard-cut group enters `setpts=PTS-STARTPTS`, because that is the failing operation.
