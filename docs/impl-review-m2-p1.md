## M2 Phase 1 実装レビュー結果
- 🔴 FATAL: 1件
- ⚠️ WARNING: 3件
- 📝 NOTE: 0件

## 詳細
### [FATAL] project override を validator が受理できず、設計上の policy resolution を壊している
- 対象ファイル: `scripts/validate-schemas.ts` / `schemas/analysis-policy.schema.json` / `tests/analysis-schemas.test.ts`
- 問題: 設計は `runtime/analysis-defaults.yaml` + `projects/<id>/analysis_policy.yaml` + runtime flags の merge を前提にしているが、validator は project root の `analysis_policy.yaml` を strict な canonical schema で直接 validate している。partial override を置くと必須 root/nested field 欠落で失敗する。
- 根拠: `docs/milestone-2-design.md:670-687` は repo default と optional project override の merge 後に schema validate / hash すると定義している。一方で `scripts/validate-schemas.ts:130-137` と `scripts/validate-schemas.ts:219-305` は `analysis_policy.yaml` を単独 artifact として読み、`schemas/analysis-policy.schema.json:6-10` と `schemas/analysis-policy.schema.json:40-44` ほかの strict required をそのまま適用している。再現確認でも `{ parallelism: { vlm_jobs: 4 } }` の override は `version` / `policy_name` / `classification` などの欠落で失敗した。`tests/analysis-schemas.test.ts:493-630` は full defaults と test helper の `deepMerge()` で作った fully merged document しか見ておらず、この不整合を検出できていない。
- 推奨修正: production-side の policy resolver を実装し、validator は raw override ではなく resolved policy を schema validate する。partial override を受理する回帰テストを追加し、local test helper ではなく本番 merge 実装を通す。

### [WARNING] analysis-policy schema が fixed vocabulary / threshold key を表現できておらず typo を通す
- 対象ファイル: `schemas/analysis-policy.schema.json` / `runtime/analysis-defaults.yaml` / `tests/analysis-schemas.test.ts`
- 問題: `classification.*` / `sampling.*` が open object のまま、`vlm.input_mode` / `vlm.response_format` / `stt.endpoint` / `stt.response_format` / `stt.chunking_strategy` / `stt.speaker_normalization` も free-form string になっている。設計で固定した policy contract と vocabulary を schema が閉じていない。
- 根拠: `docs/milestone-2-design.md:734-819` と `docs/milestone-2-design.md:456-499` は threshold と sampling / STT / VLM contract を machine-readable に固定しているが、`schemas/analysis-policy.schema.json:14-37` と `schemas/analysis-policy.schema.json:46-80` はその枝を実質無制約で受ける。再現確認でも default policy に `sampling.action.sample_fps_typo: 999` を混ぜた文書が validator を通過した。`tests/analysis-schemas.test.ts:510-560` は missing field と extra root field しか見ておらず typo / invalid vocabulary を検出していない。
- 推奨修正: `classification` / `sampling` の sub-object を明示 schema 化し `additionalProperties: false` にする。固定 contract の文字列項目は enum/const で閉じる。少なくとも canonical run に使う vocabulary は schema 上で拒否できるようにする。

### [WARNING] segments schema が `interest_points` contract を未定義のまま通している
- 対象ファイル: `schemas/segments.schema.json` / `tests/analysis-schemas.test.ts`
- 問題: `interest_points` が `items: { "type": "object" }` のみで、設計の `{ frame_us, label, confidence }` 形も segment bounds 制約も表現していない。live output の closed response contract が schema に落ちていない。
- 根拠: `docs/milestone-2-design.md:472-479` と `docs/milestone-2-design.md:512-514` は closed / normalized な `interest_points` を要求しているが、`schemas/segments.schema.json:46-49` は任意 object を受ける。再現確認でも `[{ "totally": "wrong", "outside": true }]` を入れた `segments.json` が validator を通過した。`tests/analysis-schemas.test.ts:271-342` には invalid `interest_points` case がない。
- 推奨修正: `interest_points` 用の `$defs` を追加して `frame_us` / `label` / `confidence` を required にし、`additionalProperties: false` で閉じる。segment 内に収まることは runner check で補完する。

### [WARNING] transcript live-profile / path invariants が schema・runner に反映されていない
- 対象ファイル: `schemas/transcript.schema.json` / `scripts/validate-schemas.ts` / `tests/analysis-schemas.test.ts`
- 問題: live transcript で explicit であるべき `word_timing_mode` が optional のまま、`TR_<asset_id>.json` と `transcript_ref` / `asset_id` の整合も未検証。design が求める asset-scoped transcript contract を validator が保証していない。
- 根拠: `docs/milestone-2-design.md:601-624`, `docs/milestone-2-design.md:991-1039`, `docs/milestone-2-design.md:1393-1397` は asset-scoped `03_analysis/transcripts/TR_<asset_id>.json` と explicit `word_timing_mode` を live profile の done conditionにしている。一方で `schemas/transcript.schema.json:6-28` と `schemas/transcript.schema.json:31-49` は `word_timing_mode` を optional にし、`scripts/validate-schemas.ts:342-367` は `TR_*.json` を走査するだけで filename/content invariant を見ていない。再現確認でも `TR_AST_001.json` の中身を `transcript_ref: TR_AST_999` / `asset_id: AST_999` にしても PASS し、`analysis_status: "ready"` なのに `word_timing_mode` なしでも PASS した。`tests/analysis-schemas.test.ts:388-489` は root/item required fields のみを見ている。
- 推奨修正: live-profile discriminator を設けて `analysis_status` が live state のとき `word_timing_mode` を required にする。runner で filename, `transcript_ref`, `asset_id` の cross-check を追加し、その失敗ケースをテストに入れる。

## テスト結果
- vitest: PASS（92 tests）
- tsc: PASS

## 判定
FAIL
