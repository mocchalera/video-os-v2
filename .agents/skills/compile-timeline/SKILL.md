---
name: compile-timeline
description: Use when edit_blueprint.yaml and selects_candidates.yaml are ready and the user asks to compile the rough cut, generate timeline.json, or apply a review patch.
metadata:
  filePattern:
    - '**/05_timeline/timeline.json'
    - '**/05_timeline/preview-manifest.json'
    - '**/05_timeline/adjacency_analysis.json'
  bashPattern:
    - 'compile-timeline'
---
# compile-timeline
## いつ使うか
- 「コンパイルして」「タイムラインを生成して」と言われたとき。
- `creative_brief.yaml`, `selects_candidates.yaml`, `edit_blueprint.yaml` が揃っているとき。

## 前提条件
- `scripts/compile-timeline.ts` は compile 前後で `scripts/validate-schemas.ts` 相当の gate を見る。
- `01_intent/unresolved_blockers.yaml` に `status: blocker` があると compile gate が落ちる。
- fps を 24 以外にしたい場合は `--fps <num>` を明示する。

## やること（ステップ）
1. 必要 artifact が存在することを確認する。
2. compile を実行する。

```bash
npx tsx scripts/compile-timeline.ts projects/<project> --fps 30
```

3. review patch を適用したい場合は patch mode を使う。

```bash
npx tsx scripts/compile-timeline.ts projects/<project> --patch projects/<project>/06_review/review_patch.json --fps 30
```

4. 出力された `timeline.json`、`preview-manifest.json`、必要なら `adjacency_analysis.json` を確認する。

## 出力 artifact
- `05_timeline/timeline.json`
- `05_timeline/preview-manifest.json`
- `05_timeline/adjacency_analysis.json` ただし active editing skills による transition 解析が走った場合

## 注意事項
- `scripts/compile-timeline.ts` の `createdAt` は `01_intent/creative_brief.yaml.created_at` から決まる。
- patch mode は `timeline.json` を上書きし、同時に `preview-manifest.json` も再生成する。
- `adjacency_analysis.json` は debug / explanation 用 artifact。常に生成されるわけではない。
