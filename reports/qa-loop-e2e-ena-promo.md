# QA Loop E2E Report: ena-promo-ai

Run date: 2026-06-21 JST
Command:

```bash
DOTENV_CONFIG_PATH=.env.local NODE_OPTIONS="-r dotenv/config" HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 VOS_QWEN3VL_CACHE_DIR=$HOME/.cache/huggingface/hub VOS_QWEN3VL_REQUEST_TIMEOUT_MS=120000 VOS_CLAP_CACHE_DIR=$HOME/.cache/huggingface/hub npx tsx scripts/editorial-pipeline.ts --project projects/ena-promo-ai --qa
```

## 1. Execution Summary

- Cleared the requested planning, timeline, render, and QA-loop artifacts before the run.
- Pipeline completed with `--qa`.
- CLI completion line: `QA loop: 3 iterations, 4 fixes, score 0.66 -> 0.70`.
- Generated iteration artifacts:
  - `projects/ena-promo-ai/05_timeline/timeline-iter1.json`
  - `projects/ena-promo-ai/05_timeline/timeline-iter2.json`
  - `projects/ena-promo-ai/05_timeline/timeline.json`
  - `projects/ena-promo-ai/09_output/rough-cut-iter1.mp4`
  - `projects/ena-promo-ai/09_output/rough-cut-iter2.mp4`
  - `projects/ena-promo-ai/09_output/rough-cut.mp4`
  - `projects/ena-promo-ai/06_review/qa-improvement-report-iter1.json`
  - `projects/ena-promo-ai/06_review/qa-improvement-report-iter2.json`
  - `projects/ena-promo-ai/06_review/qa-improvement-report-iter3.json`
- The process printed the completion line but remained open because of `qwen3vl_embedding_worker.py` pid `90265`; sent SIGTERM to that worker only. The parent pipeline then exited with code 0. Follow-up `pgrep` found no remaining Qwen, ffmpeg, ffprobe, or Marlin workers.

## 2. Per-Iteration QA

| Iteration | QA report | Raw Marlin report | Issues in QA loop | Proposed/applied fixes | Fix types | QA score |
| --- | --- | --- | ---: | ---: | --- | ---: |
| 1 | `qa-improvement-report-iter1.json` | `reports/eval/marlin-qa-ena-promo-ai_2026-06-20T15-38-32-687Z.json` | 3 | 2 | insert, insert | 76 |
| 2 | `qa-improvement-report-iter2.json` | `reports/eval/marlin-qa-ena-promo-ai_2026-06-20T15-41-30-379Z.json` | 2 | 2 | insert, insert | 84 |
| 3 | `qa-improvement-report-iter3.json` | `reports/eval/marlin-qa-ena-promo-ai_2026-06-20T15-44-13-461Z.json` | 0 | 0 | none | 84 |

Applied replacements from the QA reports:

| Iteration | Beat | Target clip | Replacement segment |
| --- | --- | --- | --- |
| 1 | `b02_discovery` | `CLP_0002` | `SEG_AST_B20ECEB1_0001` |
| 1 | `b03_connection` | `CLP_0005` | `SEG_AST_30B96D6D_0001` |
| 2 | `b04_serenity` | `CLP_0008` | `SEG_AST_C2CE75D8_0001` |
| 2 | `b04_serenity` | `CLP_0010` | `SEG_AST_BA264D3E_0001` |

Fix type coverage: only `insert` was exercised in this run. No `swap` or `reorder` fixes were proposed.

Blueprint application evidence:

- `SEG_AST_B20ECEB1_0001` became `primary_candidate_ref` in `edit_blueprint-iter2.yaml` and final `edit_blueprint.yaml`.
- `SEG_AST_30B96D6D_0001` became the first fallback in `edit_blueprint-iter2.yaml` and final `edit_blueprint.yaml`.
- `SEG_AST_BA264D3E_0001` became `primary_candidate_ref` in final `edit_blueprint.yaml`.
- `SEG_AST_C2CE75D8_0001` became the first fallback in final `edit_blueprint.yaml`.

## 3. Critical: Timeline Actually Changed

Yes. `timeline-iter1.json` and final `timeline.json` are structurally different.

| Artifact | Video clips | Content frames | Content seconds | Max out frame | Span seconds | Transitions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `timeline-iter1.json` | 14 | 1858 | 77.417 | 2160 | 90.000 | 13 |
| `timeline-iter2.json` | 15 | 1693 | 70.542 | 1995 | 83.125 | 14 |
| `timeline.json` | 12 | 1826 | 76.083 | 1995 | 83.125 | 11 |

Final timeline clip sequence:

```text
01 V1 CLP_0001 b01_hook       SEG_AST_FA1D3DB5_0001 in=0    dur=48
02 V1 CLP_0010 b01_hook       SEG_AST_E4C3E126_0001 in=48   dur=168
03 V1 CLP_0002 b02_discovery  SEG_AST_B20ECEB1_0001 in=216  dur=72
04 V1 CLP_0004 b02_discovery  SEG_AST_842E9AB2_0001 in=288  dur=72
05 V1 CLP_0003 b02_discovery  SEG_AST_867607E9_0001 in=360  dur=120
06 V1 CLP_0005 b02_discovery  SEG_AST_6BE56C81_0001 in=480  dur=107
07 V1 CLP_0006 b03_connection SEG_AST_0C0DA029_0001 in=756  dur=132
08 V1 CLP_0007 b03_connection SEG_AST_5FB4EC26_0001 in=888  dur=312
09 V1 CLP_0008 b03_connection SEG_AST_9258ECBB_0001 in=1200 dur=96
10 V1 CLP_0009 b04_serenity   SEG_AST_BA264D3E_0001 in=1296 dur=540
11 V1 CLP_0011 b05_closing    SEG_AST_1FAEEECE_0001 in=1836 dur=120
12 V1 CLP_0012 b05_closing    SEG_AST_E98C7A35_0001 in=1956 dur=39
```

High-signal diff from `iter1 -> final`:

- Clip 03 changed from `SEG_AST_C331F618_0001` to `SEG_AST_B20ECEB1_0001`.
- Clip 06 moved from `b03_connection / SEG_AST_0C0DA029_0001` to `b02_discovery / SEG_AST_6BE56C81_0001`.
- Clip 10 changed from `SEG_AST_FA6BF8D4_0001` to `SEG_AST_BA264D3E_0001`, with duration expanding from 108 frames to 540 frames.
- `SEG_AST_E4C3E126_0001` moved from closing to hook.
- Iter1 closing clips at frames `1836-2160` were replaced by a shorter final closing section at `1836-1995`.
- Overall clip count changed from 14 to 12.

Conclusion: the QA loop is no longer a timeline no-op.

## 4. Critical: Render Actually Changed

Yes. `rough-cut-iter1.mp4` and final `rough-cut.mp4` differ by file size, duration, and md5.

| Artifact | Size bytes | Duration sec | Bitrate | MD5 |
| --- | ---: | ---: | ---: | --- |
| `rough-cut-iter1.mp4` | 48,409,465 | 76.666667 | 5,051,422 | `71ba75c2a346de07077b11cc5d073f18` |
| `rough-cut-iter2.mp4` | 42,861,233 | 69.875000 | 4,907,189 | `589e2e8e1c79ca0ec592c05f205f474f` |
| `rough-cut.mp4` | 43,946,653 | 75.416667 | 4,661,744 | `bcdf05dfa88b8314dd770bf18798ad65` |

Initial render parity summary printed by the pipeline:

```json
{
  "timeline_span_sec": 90,
  "timeline_content_sec": 77.417,
  "gap_sec": 12.583,
  "gap_count": 2,
  "crossfade_overlap_sec": 0.5,
  "source_clamp_sec": 0.042,
  "expected_rendered_sec": 76.875,
  "actual_rendered_sec": 76.667,
  "parity_delta_sec": -0.208,
  "parity_pass": true
}
```

Conclusion: the QA loop is no longer a render no-op.

## 5. Before/After Comparison

| Dimension | Iter1 / before QA fixes | Final / after QA loop | Changed? |
| --- | ---: | ---: | --- |
| QA loop score printed by CLI | 0.66 | 0.70 | Yes |
| QA report score | 76 | 84 | Yes |
| QA-loop issue count | 3 | 0 | Yes |
| Raw Marlin warning count | 3 | 2 | Partial |
| Fixes applied | 0 before loop | 4 total | Yes |
| Video clips | 14 | 12 | Yes |
| Timeline content seconds | 77.417 | 76.083 | Yes |
| Timeline span seconds | 90.000 | 83.125 | Yes |
| Transitions | 13 | 11 | Yes |
| MP4 duration seconds | 76.666667 | 75.416667 | Yes |
| MP4 size bytes | 48,409,465 | 43,946,653 | Yes |
| MP4 md5 | `71ba75c2a346de07077b11cc5d073f18` | `bcdf05dfa88b8314dd770bf18798ad65` | Yes |

## 6. Assessment

The strengthened QA loop is effective at the core regression target: it now changes the compiled timeline and rendered MP4. The previous failure mode, where the loop proposed a fix but produced byte-identical output, did not reproduce.

The applied fixes are also visible in the planning artifacts, not just in the reports. Replacement segment IDs appear in active blueprint candidate positions, and two replacement segments are present in the final compiled timeline:

- `SEG_AST_B20ECEB1_0001`
- `SEG_AST_BA264D3E_0001`

However, this run only exercised `insert` fixes. It does not prove the `swap` path, because no swap fix was proposed.

## 7. Remaining Issues

- Raw Marlin continuity warnings were reduced but not fully resolved. The latest raw Marlin report still has 2 continuity warnings:
  - `69.5s`: "Scene appears to repeat non-adjacently after 42.5s: A woman stands still while looking out a window."
  - `74.5s`: "Scene appears to repeat non-adjacently after 42.5s: A woman with a headscarf looks down."
- `qa-improvement-report-iter3.json` says `total_issues: 0`, while the latest raw Marlin report still records those 2 warnings. The loop's filtering or issue ingestion appears to diverge from raw Marlin output on iteration 3.
- QA report score improved from 76 to 84, then plateaued at 84.
- Brief-alignment composite remained unchanged at `0.533` across the QA-loop reports; the loop improved continuity/render output, not brief alignment.
- Final timeline span is 83.125s against the 90s guide span from iter1, so duration/span behavior should be tracked separately from QA score.
