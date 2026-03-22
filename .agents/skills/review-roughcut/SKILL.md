---
name: review-roughcut
description: Use when timeline.json exists and the user asks to review the rough cut, critique the edit, or generate review_report.yaml and review_patch.json.
metadata:
  filePattern:
    - '**/06_review/review_report.yaml'
    - '**/06_review/review_patch.json'
  bashPattern: []
---
# review-roughcut
## いつ使うか
- 「レビューして」「粗編集を評価して」と言われたとき。
- `05_timeline/timeline.json` がある、または compile 入力が揃っていて review preflight を回せるとき。

## 前提条件
- `schemas/review-report.schema.json` と `schemas/review-patch.schema.json` を守ること。
- `runtime/commands/review.ts` は preflight で compile を再実行し、`05_timeline/review.mp4` と `05_timeline/review-qc-summary.json` を出す。
- `06_review/human_notes.yaml` がある場合は `schemas/human-notes.schema.json` に合わせて読む。

## やること（ステップ）
1. preflight として compile を再実行し、現在の `timeline.json` を正とする。
2. `05_timeline/review.mp4` と `05_timeline/review-qc-summary.json` を用意する。
3. brief と blueprint に対する一致 / 不一致を評価し、`06_review/review_report.yaml` を作る。
4. 修正提案がある場合は `06_review/review_patch.json` を作る。
5. patch は `trim_segment`, `replace_segment`, `add_marker` などの安全な op を優先する。

## 出力 artifact
- `06_review/review_report.yaml`
- `06_review/review_patch.json`
- `05_timeline/review.mp4`
- `05_timeline/review-qc-summary.json`

## 注意事項
- 現在の repo では `review.mp4` は実レンダではなく deterministic placeholder で、中身は JSON stub。
- `replace_segment` は fallback candidate や human note で許可された segment に限定する前提。
- `insert_segment` は `human_notes.yaml` に machine-readable な anchor がない限り安易に出さない。
