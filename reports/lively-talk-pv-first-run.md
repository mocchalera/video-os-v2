# LivelyTalk PV First Run

Project: `projects/lively-talk-pv`  
Run date: 2026-06-20 JST  
Goal: create brief, analyze 21 source clips, build Qwen footage DB, run editorial pipeline, render.

## 1. Analysis Summary

- Brief: `01_intent/creative_brief.yaml` was created and validated against `schemas/creative-brief.schema.json`.
- Source material: 21 MP4 clips from `02_media`; `bgm-livelytalk.mp3` was kept as BGM, not analyzed as source footage. Golden PVs in `00_source/golden/` were not used as source material.
- Analysis artifacts:
  - `03_analysis/assets.json`: 21 assets, total source duration 123.607812 sec.
  - `03_analysis/segments.json`: 22 segments.
  - Enrichment: 22/22 summaries, 22/22 tags, 22/22 `peak_analysis`, 22/22 `visual_appraisal`.
  - `03_analysis/gap_report.yaml`: `entries: []`.
- Marlin:
  - `03_analysis/marlin_events.json`: 21 live Marlin asset records.
  - Model: `NemoStation/Marlin-2B`, `inference_mode: live`.
  - Events: 72 caption events.
  - Find results: 84.
- Transcripts:
  - 3 transcript files were generated.
  - `TR_AST_22A8DA32`: `あーーーーーーー`
  - `TR_AST_2F64DC08`: `ん`
  - `TR_AST_BD9CEDB1`: `1日目の駅`

Analysis issues:

- The user-provided `analyze.ts --project ...` form is not valid for this script; it requires source files unless `--vlm-only` is used.
- First analysis attempt used project-prefixed relative paths, which were resolved under `--project` and doubled the path. It produced empty `assets.json`/`segments.json`; rerun used absolute source paths.
- VLM peak detection timed out after 300s and fell back to degraded motion/audio/transcript heuristics. The fallback labeled 22/22 segments.
- Marlin inside the main analysis run was too quiet/long and was stopped; live Marlin was then run separately with `scripts/marlin-evaluate.ts`, producing the final 21-record Marlin artifact.

## 2. DB Build

DB: `projects/lively-talk-pv/03_analysis/search/footage.db`  
Report: `projects/lively-talk-pv/03_analysis/search/footage-db-build-report.json`

- DB counts:
  - assets: 21
  - segments: 22
  - FTS rows: 22
  - Marlin event rows: 72
  - transcript segments: 3
  - total embeddings: 113
- Embedding models:
  - `Qwen/Qwen3-VL-Embedding-2B`, 2048 dim, multimodal, local cache.
  - `Xenova/multilingual-e5-small`, 384 dim, text.
- Segment embeddings:
  - `visual_representative`: 22
  - `text_combined_qwen`: 22
  - `combined`: 22
  - `scene`: 22
  - `summary`: 22
  - `transcript`: 3
- Qwen status:
  - `qwen_visual`: `ready` (22)
  - `qwen_text`: `ready` (22)
  - `qwen_mixed`: `unsupported`
  - `qwen_reranker`: `deferred`
- Warnings: 19 segment audio-analysis warnings: `ffmpeg analysis failed`. Qwen embedding population itself was ready.

## 3. Visual Search Trace

Trace: `projects/lively-talk-pv/04_plan/visual_search_trace.json`

- Queries executed: 8.
- Unique retrieved segments: 18.
- Warnings: none.
- The first four `must_have` Qwen-priority queries returned visual results. The duplicated `policy_hint` priority lines returned 0 after cross-query dedupe.

Top evidence:

| Query | Top segment | qwen_visual | final | embedding |
| --- | --- | ---: | ---: | --- |
| 孤独・疲労 / 電車・オフィス・暗い部屋 | `SEG_AST_BD9CEDB1_0001` | 0.872390 | 0.882966 | `visual_representative` |
| 温かい対話・傾聴 | `SEG_AST_434DDEAC_0001` | 0.876239 | 0.886969 | `visual_representative` |
| 明るい表情・開放感 | `SEG_AST_FBB7667E_0001` | 0.843904 | 0.864474 | `visual_representative` |
| 寒色→暖色 | `SEG_AST_927381FA_0001` | 0.831881 | 0.850491 | `visual_representative` |

Selected-linkage examples:

- `SEG_AST_434DDEAC_0001`: best qwen_visual 0.876, best final 0.887.
- `SEG_AST_BD9CEDB1_0001`: best qwen_visual 0.872, best final 0.883.
- `SEG_AST_726F3798_0001`: best qwen_visual 0.867, best final 0.880.

## 4. Timeline

Timeline: `projects/lively-talk-pv/05_timeline/timeline.json`

- FPS: 24.
- Resolution: 1920x1080, 16:9.
- Tracks: 2 video, 3 audio.
- Clips: 21.
- Markers: 5.
- Transitions: 20.
- Timeline last frame: 1376.
- Timeline duration: 57.333 sec.
- Target: 1440 frames / 60 sec.
- Content frames: 1128.
- Content fill ratio: 0.783333.

Beat fill:

| Beat | Target frames | Actual frames | Fill |
| --- | ---: | ---: | ---: |
| `b01_hook` | 144 | 120 | 0.833 |
| `b02_problem` | 360 | 316 | 0.878 |
| `b03_talk` | 360 | 360 | 1.000 |
| `b04_after` | 360 | 180 | 0.500 |
| `b05_closing` | 216 | 152 | 0.704 |

Gaps:

- Internal gaps: 3 gaps, 248 frames total.
  - `CLP_0001` → `CLP_0002`: 24 frames.
  - `CLP_0003` → `CLP_0007`: 44 frames.
  - `CLP_0019` → `CLP_0020`: 180 frames.
- Tail gap to 60 sec target: 64 frames.
- Compile log gap total: 4 gaps, 312 frames.

Timeline issues:

- Compile passed schema validation.
- Project validator still reports one missing artifact: `04_plan/uncertainty_register.yaml`.
- Several render trims used midpoint fallback because Marlin events were weak for those clips.

## 5. Render

Rendered output: `projects/lively-talk-pv/09_output/rough-cut.mp4`

- Render status: success.
- File size: 30,723,858 bytes (~29.30 MB).
- Video stream: H.264, 1920x1080, 24fps.
- ffprobe duration: 39.875 sec.
- Render log:
  - clips: 21
  - crossfades: 1
  - warning: xfade graph duration 39.875s was shorter than expected 46.250s; renderer retried iterative merge.

Render issue:

- The rendered MP4 is materially shorter than the timeline duration (39.875s vs 57.333s) and the 60s target. Treat this first render as a rough pipeline output, not final delivery.

## 6. Step Errors And Recovery

- Step 1 brief: completed; `project.fps` is not allowed by schema, so the 24fps requirement was preserved in `resolved_assumptions` and verified in the timeline/render.
- Step 2 analysis: initial invalid/no-source and doubled-path attempts were corrected with absolute source paths. Marlin was completed separately via live `marlin-evaluate`.
- Step 3 DB: completed; Qwen visual/text embeddings ready. Non-blocking audio-analysis warnings remain.
- Step 4 editorial: completed through rough/fine/compile/render. Render wrote `09_output/rough-cut.mp4`.
- Cleanup: after render, an idle `qwen3vl_embedding_worker.py` kept the process open; it was terminated after the MP4 was written.
- Validation: `scripts/validate-schemas.ts projects/lively-talk-pv` currently fails only on missing `04_plan/uncertainty_register.yaml`; `compile_gate` is open and `gate2_timeline_valid` is true.
