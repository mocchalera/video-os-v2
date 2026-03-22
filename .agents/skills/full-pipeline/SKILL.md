---
name: full-pipeline
description: Use when the user wants an end-to-end run from source footage to a rough cut or final packaged video, and you need to chain the existing stage Skills without inventing a nonexistent one-shot CLI.
metadata:
  filePattern:
    - '**/03_analysis/assets.json'
    - '**/04_plan/edit_blueprint.yaml'
    - '**/05_timeline/timeline.json'
    - '**/07_package/video/final.mp4'
  bashPattern: []
---
# full-pipeline
## いつ使うか
- 「粗編集を作って」「素材から動画を作って」「全自動で」と言われたとき。
- 素材パスと一言の説明はあるが、各 stage artifact がまだ揃っていないとき。

## 前提条件
- この repo には analyze から package までを一発で回す単独 CLI はない。
- `scripts/demo.ts` は full pipeline ではなく、既存 artifact に対する deterministic compile demo。
- 最終 MP4 まで行くには rough cut pipeline に加えて Gate 10 と package 前提も必要。

## やること（ステップ）
1. `analyze-footage` を使って `03_analysis` を作る。
2. `design-intent` を使って `01_intent/creative_brief.yaml` と `unresolved_blockers.yaml` を作る。
3. `unresolved_blockers.yaml` に `status: blocker` があるならここで止まり、仮置き assumption で進めてよいか確認する。
4. `select-clips` を使って `04_plan/selects_candidates.yaml` を作る。
5. `build-blueprint` を使って `04_plan/edit_blueprint.yaml` と `uncertainty_register.yaml` を作る。
6. `compile-timeline` を使って `05_timeline/timeline.json` を作る。
7. `review-roughcut` を使って `06_review/review_report.yaml` と `review_patch.json` を作る。
8. 最終動画まで必要で、かつ project が `approved` で Gate 10 を満たしているなら `render-video` を実行する。
9. package 前提が足りないなら `review` までで止め、欠けている artifact を明示する。

## 出力 artifact
- `01_intent/*`
- `03_analysis/*`
- `04_plan/*`
- `05_timeline/*`
- `06_review/*`
- 条件が揃っていれば `07_package/*`

## 注意事項
- current repo の `review.mp4` は placeholder で、実 preview render ではない。
- final render は `assembly.mp4` 前提なので、`timeline.json` だけでは `final.mp4` まで進めない。
- まず rough cut まで自動で作るのか、package まで求めるのかを最初に切り分ける。
