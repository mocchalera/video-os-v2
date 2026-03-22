---
name: re-edit
description: Use when the user asks to modify an existing rough cut — shorten, lengthen, remove a clip, reorder, change BGM, adjust pacing. Works by generating a review_patch and re-compiling.
metadata:
  filePattern:
    - '**/06_review/review_patch.json'
  bashPattern: []
---
# re-edit

## いつ使うか（必ず発火する条件）

- ユーザーが「もう少し短くして」「この部分カットして」「順番を変えて」と言ったとき
- 既存 rough cut に対して局所修正を入れたいとき
- `05_timeline/timeline.json` が既に存在し、patch apply で再編集できるとき
- `review_patch.json` を人間指示から直接作り直して再 compile したいとき

## 前提条件

- `05_timeline/timeline.json` が存在すること
- `06_review/review_patch.json` は `schemas/review-patch.schema.json` に従うこと
- `runtime/compiler/patch.ts` の allowed op は以下のみ
  - `replace_segment`
  - `trim_segment`
  - `move_segment`
  - `insert_segment`
  - `remove_segment`
  - `change_audio_policy`
  - `add_marker`
  - `add_note`
- `review_patch.json.timeline_version` には **`timeline.json.version`** を入れること
- `scripts/compile-timeline.ts --patch ...` は `timeline.json` を上書きし、`preview-manifest.json` を再生成し、最後に schema validation を走らせる
- current 実装では patch mode の `--fps` は使われない。fps を変えたい場合は upstream compile 側を見直す
- `replace_segment` / `insert_segment` は unsafe になりやすい。必要なら `review-roughcut/references/patch-patterns.md` も参照すること

## やること（ステップ）

### Step 1: ユーザーの修正指示を patchable な意図に落とす

- 何を短く / 削除 / 入れ替え / 調整したいのかを具体化する
- request が local patch で済むか、selects / blueprint / package の更新が要るかを先に切る
- 詳細な自然言語マッピングは **`references/edit-commands.md` を参照すること**

### Step 2: 現在の timeline を読む

- `05_timeline/timeline.json` の `version` を確認する
- 対象 clip の `clip_id`, `segment_id`, `beat_id`, `role`, `timeline_in_frame`, `timeline_duration_frames` を確認する
- 置換や挿入が必要なら `04_plan/selects_candidates.yaml` と、必要に応じて `06_review/human_notes.yaml` を読む

### Step 3: patch で直せるかを判断する

patch で直せる代表例:

- クリップを少し短くする
- 冗長なクリップを削除する
- 既存クリップの順番や入る frame をずらす
- approved candidate に差し替える
- nat sound / ducking / fade を局所調整する

patch だけでは不正確な代表例:

- approved source や anchor のない新規シーン追加
- beat の再設計が必要な大きな並べ替え
- BGM asset 自体の差し替え

後者は無理に patch 化せず、必要なら `select-clips` / `build-blueprint` / `render-video` 側へ回す。

### Step 4: `06_review/review_patch.json` を生成する

基本 shape:

```json
{
  "timeline_version": "<timeline.json version>",
  "operations": []
}
```

- op 名は schema にあるものだけを使う
- 1 op = 1 つの具体的修正
- `target_clip_id` / `with_segment_id` / `new_timeline_in_frame` / `new_src_in_us` など、必要 field を実データから埋める
- `reason` は必須。可能なら `confidence` と `evidence` も入れる

### Step 5: patch を適用して再 compile する

```bash
npx tsx scripts/compile-timeline.ts projects/<project> --patch projects/<project>/06_review/review_patch.json
```

selects / blueprint を直したあとの full compile が必要なら別途 compile mode を使う。

```bash
npx tsx scripts/compile-timeline.ts projects/<project> --fps 30
```

### Step 6: 結果を確認する

- `Patch errors:` が出ていないか
- `timeline.json.version` が increment されたか
- `05_timeline/preview-manifest.json` が再生成されたか
- `Schema validation: PASSED` になったか

### Step 7: 必要なら render をやり直す

- ユーザーが final packaged video まで求めており、Gate 10 を満たしているなら `render-video` を実行する
- rough cut の再編集だけなら `timeline.json` / preview manifest の更新で止める

## 出力 artifact

- `06_review/review_patch.json`
- `05_timeline/timeline.json`
- `05_timeline/preview-manifest.json`
- 条件が揃っていて render まで進める場合は `07_package/*`

## 注意事項

- `reorder` という patch op はない。現在の repo では並べ替えは主に `move_segment` で表現する
- `change_audio_policy` は ducking / nat sound / fade 調整であり、BGM asset の差し替えではない
- 「長くして」は `move_segment` / `insert_segment` / upstream blueprint 修正になることがある。duration を盲目的に伸ばさない
- patch mode は `selects_candidates.yaml` や `edit_blueprint.yaml` を自動更新しない
