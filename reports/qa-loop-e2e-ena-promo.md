# QA Loop E2E Report: ena-promo-ai

Run date: 2026-06-21 JST  
Project: `projects/ena-promo-ai/`  
Command: `DOTENV_CONFIG_PATH=.env.local NODE_OPTIONS="-r dotenv/config" HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 VOS_QWEN3VL_CACHE_DIR=$HOME/.cache/huggingface/hub VOS_QWEN3VL_REQUEST_TIMEOUT_MS=120000 VOS_CLAP_CACHE_DIR=$HOME/.cache/huggingface/hub npx tsx scripts/editorial-pipeline.ts --project projects/ena-promo-ai --qa`

## Execution Summary

- Cleared the requested generated artifacts before the run.
- `--qa` is supported by `scripts/editorial-pipeline.ts`.
- Pipeline reached: representative-frame extraction -> visual retrieval -> audio retrieval -> rough pass -> fine pass -> compile -> render -> QA loop.
- Approximate command wall time: 8 minutes 10 seconds, including post-summary Qwen worker cleanup.
- QA loop started at about `2026-06-21 00:00:51 JST`.
- QA loop produced 2 improvement reports and 2 Marlin QA reports.
- CLI summary: `QA loop: 2 iterations, 1 fixes, score 0.70 -> 0.70`.
- Initial render parity passed: expected `62.5s`, actual `62.5s`.
- The parent process did not exit until the idle Qwen worker was terminated. A stale idle CLAP worker was also cleaned up afterward.

## Artifacts

- `projects/ena-promo-ai/06_review/qa-improvement-report-iter1.json`
- `projects/ena-promo-ai/06_review/qa-improvement-report-iter2.json`
- `projects/ena-promo-ai/04_plan/selects_candidates-iter1.yaml`
- `projects/ena-promo-ai/04_plan/edit_blueprint-iter1.yaml`
- `projects/ena-promo-ai/05_timeline/timeline-iter1.json`
- `projects/ena-promo-ai/09_output/rough-cut-iter1.mp4`
- `projects/ena-promo-ai/09_output/rough-cut.mp4`
- `reports/eval/marlin-qa-ena-promo-ai_2026-06-20T15-02-15-924Z.json`
- `reports/eval/marlin-qa-ena-promo-ai_2026-06-20T15-05-06-735Z.json`

## Per-Iteration Breakdown

### Iteration 1

- QA score: `84/100` in the improvement report.
- Normalized loop score contribution led to CLI score `0.70`.
- Marlin QA score: `84/100`.
- Marlin issues: 2 continuity warnings.
  - `40.5s`: repeated non-adjacent train-window scene after `30.5s`.
  - `58.5s`: repeated non-adjacent small-container pickup scene after `8s`.
- Improvement report issues: `total_issues=2`, `fixable_issues=2`, `proposed_fixes=1`.
- Proposed/applied fix: insert/bridge for `b03_climax`, target `CLP_0007`, replacement `SEG_AST_0C0DA029_0001`, visual search score `0.912`.
- Applied artifact mutation observed: `edit_blueprint.yaml` gained `SEG_AST_0C0DA029_0001` in `b03_climax.candidate_plan.fallback_candidate_refs`.

### Iteration 2

- QA score: `84/100` in the improvement report.
- Marlin QA score: `84/100`.
- The second Marlin report still contains the same 2 continuity warnings.
- `qa-improvement-report-iter2.json` says `total_issues=0`, but this is because the QA loop stopped on no score improvement before running issue detection for iteration 2.
- Inferred convergence reason: `no_improvement`.

## Initial vs Final

| Metric | Initial | Final |
|---|---:|---:|
| Timeline span | `85.5s` / `2052` frames | `85.5s` / `2052` frames |
| Timeline content | `64.0s` / `1536` frames | `64.0s` / `1536` frames |
| Timeline occupancy, content/span | `0.748538` | `0.748538` |
| Compiler-style content/90s target | `0.711111` | `0.711111` |
| Gap total | `21.5s` / `516` frames | `21.5s` / `516` frames |
| Gap count | `4` | `4` |
| V1 clips placed | `14` | `14` |
| Rendered duration | `62.500000s` | `62.500000s` |
| QA overall score | `84/100` | `84/100` |
| CLI normalized score | `0.70` | `0.70` |
| Brief alignment composite | `0.531` | `0.531` |
| Marlin issues | `2` continuity warnings | `2` continuity warnings |
| Proposed fixes | `1` insert | `0` |
| Placed clips swapped | `0` | `0` |
| Placed clip list changed | no | no |

`rough-cut-iter1.mp4` and final `rough-cut.mp4` are byte-identical. `timeline-iter1.json` and final `timeline.json` differ only in `created_at`; the V1 clip sequence is unchanged.

## Convergence Analysis

The loop executed end to end mechanically: it rendered, ran QA, detected continuity issues, proposed a visual-search-backed insert, applied an artifact mutation, recompiled, re-rendered, and ran QA again.

It did not improve the actual edit in this run. The score stayed flat, the final Marlin QA still found the same 2 continuity warnings, and the rendered MP4 did not change. The most likely convergence reason is `no_improvement`, matching the flat score and the loop implementation order.

## Effective Fix Types

No fix type was demonstrably effective in the rendered output. The only proposed fix was an `insert`, but it changed the blueprint fallback list without changing the compiled timeline or final MP4.

## Errors And Unexpected Behavior

- The CLI completed successfully, but stayed alive after printing the QA summary until an idle Qwen worker was terminated.
- A stale idle CLAP worker from an older process was also present and was terminated after the run.
- `qa-improvement-report-iter2.json` is potentially misleading: it reports zero issues, while the corresponding Marlin QA report still has 2 warnings. This happens because the loop stops on no score improvement before detecting issues for that iteration.
- The applied fix appended a segment id to a fallback candidate list, but the compiler did not place that segment. The final timeline and final render were unchanged.

## Assessment

The QA auto-improvement loop worked end to end as a control-flow test. It did not prove actual edit improvement on `ena-promo-ai`: the quality score, timeline geometry, placed clips, rendered media, and Marlin issues were unchanged after the loop.
