# Pipeline Post-Compiler Fix Verification: ena-promo-ai

Date: 2026-06-20 JST

## 1. Pipeline execution summary

Command:

```bash
DOTENV_CONFIG_PATH=.env.local NODE_OPTIONS="-r dotenv/config" HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 VOS_QWEN3VL_CACHE_DIR=$HOME/.cache/huggingface/hub VOS_QWEN3VL_REQUEST_TIMEOUT_MS=120000 npx tsx scripts/editorial-pipeline.ts --project projects/ena-promo-ai
```

Artifacts cleared before the run:

- `projects/ena-promo-ai/04_plan/selects_candidates.yaml`
- `projects/ena-promo-ai/04_plan/edit_blueprint.yaml`
- `projects/ena-promo-ai/04_plan/visual_search_trace.json`
- `projects/ena-promo-ai/05_timeline/timeline.json`

Result:

- Pipeline completed triage, blueprint, compile, and render.
- Wall time: `428.21s` (`user 426.33s`, `sys 26.89s`).
- Render succeeded; no `--skip-render` fallback was needed.
- After the MP4 was written, the parent process remained alive on the Qwen3VL embedding worker. Sending SIGTERM to that idle worker allowed the command to exit with status 0.

## 2. Timeline analysis

Timeline path: `projects/ena-promo-ai/05_timeline/timeline.json`

Frame rate: `24fps`

Key metrics:

| Metric | Value |
| --- | ---: |
| Video clips | 18 |
| Timeline span | 2249 frames / 93.71s |
| Total content | 1990 frames / 82.92s |
| Target duration | 2160 frames / 90.00s |
| Content delta from target | -170 frames / -7.08s |
| content_fill_ratio | 0.921296 |
| duration_status | pass |
| Same-beat internal gaps | 0 |
| Cross-beat gap count | 3 |
| Cross-beat gap frames | 259 frames / 10.79s |

Compiler duration diagnostics from stdout:

```json
{
  "duration_fit": true,
  "total_frames": 2249,
  "target_frames": 2160,
  "duration_status": "pass",
  "duration_delta_frames": -170,
  "duration_delta_pct": -7.87037037037037,
  "content_frames": 1990,
  "content_fill_ratio": 0.9212962962962963,
  "gap_frames": 259,
  "gap_count": 3
}
```

Beat fill:

| Beat | Clips | Content frames | Seconds | Fill ratio | Same-beat gap frames |
| --- | ---: | ---: | ---: | ---: | ---: |
| b01_hook | 3 | 288 | 12.00 | 0.666667 | 0 |
| b02_discovery | 5 | 526 | 21.92 | 0.974074 | 0 |
| b03_climax | 3 | 540 | 22.50 | 1.000000 | 0 |
| b04_serenity | 4 | 331 | 13.79 | 0.766204 | 0 |
| b05_invitation | 3 | 305 | 12.71 | 1.412037 | 0 |

Cross-beat gaps:

| From | To | Frames | Seconds |
| --- | --- | ---: | ---: |
| b01_hook | b02_discovery | 144 | 6.00 |
| b02_discovery | b03_climax | 14 | 0.58 |
| b04_serenity | b05_invitation | 101 | 4.21 |

Verification notes:

- `b01_hook` is no longer empty: it contains 3 clips and 288 content frames.
- No internal gaps remain within any beat. Each clip starts at the previous clip end inside the same beat.
- Aggregate content fill meets the requested threshold: `0.921296 >= 0.90`.
- Per-beat fill is improved but still uneven. `b01_hook` and `b04_serenity` remain underfilled, while `b05_invitation` overfills its scaled target.

## 3. Before/after comparison

| Metric | Before fix | After fix |
| --- | ---: | ---: |
| Total content frames | 1407 | 1990 |
| Content duration | 58.6s | 82.92s |
| Timeline span | not recorded | 93.71s |
| Rendered duration | not recorded | 81.625s |
| b01_hook clips | 0 | 3 |
| Same-beat internal gaps | not separated | 0 |
| Total gap count | 6 | 3 cross-beat |
| Total gap frames | 753 | 259 cross-beat |
| Video clips | 19 | 18 |
| content_fill_ratio | 0.65 | 0.921296 |
| duration_status | not recorded | pass |

## 4. Candidate fill confirmation

The generated blueprint uses `track_layout: single`. The timeline used 18 distinct candidate refs while the blueprint has 5 primary candidate refs.

Candidate placement breakdown:

| Source type | Clips |
| --- | ---: |
| Blueprint primary refs | 4 |
| Blueprint fallback refs | 11 |
| Broader eligible candidate fill | 3 |

This confirms the single-layout fill path is active: non-primary candidates were used to fill beats instead of placing only one primary clip per beat.

## 5. Visual search trace confirmation

Trace path: `projects/ena-promo-ai/04_plan/visual_search_trace.json`

Visual retrieval remains active after the compiler changes:

- Query count: 6
- Total unique segments: 32
- Trace warnings: 0
- Results with `score_breakdown.qwen_visual`: 32
- Results with `matched_embedding_type: visual_representative`: 32
- Max observed `qwen_visual`: 0.887759

Example score shape:

```json
{
  "score_breakdown": {
    "qwen_visual": 0.884257,
    "qwen_text": 0.855103,
    "e5_text": 0.918869515979233,
    "final": 0.878586
  },
  "matched_embedding_type": "visual_representative"
}
```

## 6. Render output details

Output path: `projects/ena-promo-ai/09_output/rough-cut.mp4`

Render log:

- Clips: 18
- Crossfades: 2
- Duration: 81.6s
- File size: 50.87 MB

`ffprobe`:

```json
{
  "duration": "81.625000",
  "size": "53340122"
}
```

## 7. Remaining issues

- Beat-level fill is not uniformly close to 1.0. `b01_hook` is now populated but only reaches 66.7% of its target, and `b04_serenity` reaches 76.6%.
- Cross-beat timing gaps remain: 259 frames total. These are not internal same-beat clip gaps, but they still explain the difference between timeline span and content duration.
- The pipeline left the Qwen3VL embedding worker alive after render until it was terminated manually. The generated render and artifacts were already complete, and the command then exited with status 0.
