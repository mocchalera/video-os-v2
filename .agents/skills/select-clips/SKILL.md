---
name: select-clips
description: Use when creative_brief.yaml and 03_analysis artifacts exist and the user asks to choose clips, extract candidate segments, or build selects_candidates.yaml.
metadata:
  filePattern:
    - '**/04_plan/selects_candidates.yaml'
  bashPattern: []
---
# select-clips
## いつ使うか
- 「クリップを選んで」「候補を抽出して」と言われたとき。
- `01_intent/creative_brief.yaml` と `03_analysis/assets.json` / `segments.json` が揃っているとき。

## 前提条件
- `schemas/selects-candidates.schema.json` を守ること。
- `runtime/commands/triage.ts` の prerequisite に合わせ、analysis artifacts と `creative_brief.yaml` があること。
- 使える evidence は `segments.json`, `transcripts`, `contact_sheets`, `filmstrips`, `quality_flags`, `peak_analysis`。

## やること（ステップ）
1. brief の message, audience, emotion_curve, must_have, must_avoid を読む。
2. `03_analysis/segments.json` を見て、各 segment の transcript, quality flags, visual tags, `peak_analysis` を確認する。
3. `04_plan/selects_candidates.yaml` を作る。
   各 candidate の必須項目は `segment_id`, `asset_id`, `src_in_us`, `src_out_us`, `role`, `why_it_matches`, `risks`, `confidence`。
4. `peak_analysis` がある segment は `trim_hint` に `source_center_us`, `preferred_duration_us`, `window_start_us`, `window_end_us` などを反映する。
5. `selection_notes` と `editorial_summary` で選定方針を短く残す。
6. reject 候補を入れる場合は `role: reject` にして `rejection_reason` を必ず入れる。

## 出力 artifact
- `04_plan/selects_candidates.yaml`

## 注意事項
- `src_in_us < src_out_us` を守る。schema だけではなく validator でも落ちる。
- `asset_id` は `03_analysis/assets.json` に存在するものだけを使う。
- `candidate_id` は schema 上 optional。安定した生成規則がないなら、適当な ID をでっち上げるより省略する方が安全。
- `trim_hint` は optional だが、あると compiler の adaptive trim が働きやすい。
