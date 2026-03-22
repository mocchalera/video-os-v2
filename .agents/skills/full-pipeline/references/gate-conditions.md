# Gate Conditions

## Scope

- このファイルは `full-pipeline` 用の orchestration gate を定義する
- Gate 番号は runtime 内部名とは別レイヤー
  - Gate 1 -> `analysis_gate`
  - Gate 3 -> `compile_gate`
  - Gate 5 の後ろで `planning_gate` を追加確認
  - Gate 7 -> `review_gate`
  - Gate 9-10 -> `packaging_gate` と `checkGate10()`
- resume は **最も下流の artifact からではなく、最初に失敗した Gate から** 行う

## TOC

- Gate 0: 素材存在
- Gate 1: analysis 完了
- Gate 2: creative brief
- Gate 3: unresolved blockers
- Gate 4: selects
- Gate 5: blueprint
- Gate 6: compile
- Gate 7: review
- Gate 8: patch loop
- Gate 9: package 前提
- Gate 10: final QA

## Gate List

| Gate | 通過条件 | 実際の裏付け | 失敗時のリカバリ |
| --- | --- | --- | --- |
| Gate 0 | fresh run なら素材ファイルまたは素材フォルダが存在する。resume なら Gate 1 が既に通っていれば raw media 再確認は不要。 | skill-level check。runtime には専用 gate なし。 | 正しい素材パスを確定し、`analyze-footage` をやり直す。 |
| Gate 1 | `03_analysis/assets.json` と `03_analysis/segments.json` が存在し、analysis schema/runner check を通り、`gap_report.yaml` 由来の QC が `ready`。`partial` の場合は matching な `analysis_override` があって `partial_override` 扱いになっている。 | `runtime/state/reconcile.ts` の `computeAnalysisStatus()`、`runtime/mcp/repository.ts` の `projectSummary()`、`runtime/mcp/gap-projection.ts` の `deriveQcStatus()`。 | `analyze-footage` を再実行する。partial のまま進みたいなら `analysis_override` を更新する。全 asset が blocking gap なら Gate 0 に戻って素材修復。 |
| Gate 2 | `01_intent/creative_brief.yaml` が存在し schema valid。 | `schemas/creative-brief.schema.json`、`runtime/commands/intent.ts` の draft/promote。`triage.ts` は existence を hard check。 | `design-intent` を再実行して brief を再生成する。 |
| Gate 3 | `01_intent/unresolved_blockers.yaml` に `status: blocker` が無い。 | `runtime/state/reconcile.ts` の `compile_gate`、`scripts/validate-schemas.ts` の `runGate1Blockers()`、`runtime/commands/review.ts` preflight。 | `design-intent` に戻り blocker を解消する。仮定で進むなら user 合意を取り、`allowed_temporary_assumption` と status を更新してから再実行。 |
| Gate 4 | `04_plan/selects_candidates.yaml` が存在し、最低 1 candidate があり、`segment_id` / `asset_id` 参照も valid。 | `schemas/selects-candidates.schema.json`、`scripts/validate-schemas.ts` の `src_time_check` と `referential_integrity`、`runtime/commands/triage.ts`。 | `select-clips` を再実行する。brief や analysis が変わっていれば stale とみなして Gate 4 からやり直す。 |
| Gate 5 | `04_plan/edit_blueprint.yaml` が存在する。自動継続するには `04_plan/uncertainty_register.yaml` に `status: blocker` が無いことも確認する。 | `schemas/edit-blueprint.schema.json`、`schemas/uncertainty-register.schema.json`、`runtime/commands/blueprint.ts`、`runtime/state/reconcile.ts` の `planning_gate`。 | `build-blueprint` を再実行する。uncertainty blocker が残るなら `blocked` 扱いで止める。 |
| Gate 6 | compile が成功し、`05_timeline/timeline.json` が schema valid。 | `scripts/compile-timeline.ts` の pre/post validation、`scripts/validate-schemas.ts` の `gate2_timeline_valid`。 | `compile-timeline` を再実行する。schema failure や upstream mismatch なら Gate 5, 4, 2 のどこに原因があるか切り分けて戻る。 |
| Gate 7 | `06_review/review_report.yaml` が存在し、FATAL 相当が無い。実コード上は `fatal_issues.length === 0`。 | `runtime/state/reconcile.ts` の `review_gate`、`schemas/review-report.schema.json`、`runtime/commands/review.ts`。 | `review-roughcut` を再実行する。fatal なら Gate 8 patch loop か upstream stage に戻る。 |
| Gate 8 | `review_patch.json` 適用後の再 compile が成功し、patched `timeline.json` が再び schema valid。patch が不要なら N/A 扱いで Gate 7 の結果を採用してよい。 | `scripts/compile-timeline.ts --patch ...` の patch/apply path と post-patch validation。 | safe patch なら `compile-timeline` patch mode -> `review-roughcut`。unsafe または patch 不可能なら Gate 5 または Gate 4 に戻る。 |
| Gate 9 | package 前提が揃っている。少なくとも `current_state: approved`、`approval_record.status in {clean, creative_override}`、`handoff_resolution.status: decided`、valid な `source_of_truth_decision`、`review_gate: open`。caption が有効なら `caption_approval.json`、BGM が有効なら `music_cues.json`。`engine_render` なら `05_timeline/assembly.mp4`、`nle_finishing` なら supplied final も必要。 | `runtime/state/reconcile.ts` の `packaging_gate`、`runtime/packaging/gate10.ts`、`runtime/commands/package.ts`。 | `review-roughcut` の結果に対して operator accept または creative override で `approved` に進める。handoff decision や caption/music artifact を揃え、`render-video` 前提を満たす。 |
| Gate 10 | final output QA が pass し、`qa-report.json` と `package_manifest.json` が生成される。loudness、A/V sync、caption delivery、package completeness、必要なら strict duration policy が通る。 | `runtime/commands/package.ts`、`runtime/packaging/qa.ts`、`runtime/packaging/manifest.ts`。 | 失敗した QA check を修正し、Gate 9 から `render-video` をやり直す。 |

## Notes By Gate

### Gate 1 note

- `gap_report.yaml` の blocking 判定は `runtime/mcp/gap-projection.ts` で行われる
- blocking gap があっても一部 asset が生きていれば `qc_status` は `partial` で、即 `blocked` ではない
- ただし full-pipeline で自動継続するなら、override なし partial を既定通過にはしない

### Gate 5 note

- user 要件では Gate 5 を `edit_blueprint.yaml` の存在として扱う
- ただし実装上は `uncertainty_register.yaml` の `status: blocker` が残ると `planning_gate` が落ち、`/review` 前に止まる
- そのため full-pipeline では Gate 5 通過判定に planning blocker チェックを含める

### Gate 7 note

- schema に literal の `FATAL` enum は無い
- 実コード上の FATAL 相当は以下
  - `summary_judgment.status: blocked`
  - `fatal_issues` が 1 件以上
  - `review_gate: blocked`

### Gate 10 note

- `engine_render` profile の主な QA check
  - `timeline_schema_valid`
  - `caption_policy_valid`
  - `caption_density_valid`
  - `caption_alignment_valid`
  - `dialogue_occupancy_valid`
  - `av_drift_valid`
  - `loudness_target_valid`
  - `package_completeness_valid`
- `nle_finishing` profile の主な QA check
  - `supplied_export_probe_valid`
  - `caption_delivery_valid`
  - `supplied_av_sync_valid`
  - `loudness_target_valid`
  - `package_completeness_valid`
- `duration_policy_valid` は strict mode のときだけ required
