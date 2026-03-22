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

## いつ使うか（必ず発火する条件）

- ユーザーが「レビューして」「粗編集を評価して」「review_report.yaml を作って」と言ったとき
- `full-pipeline` の Step 7 として呼ばれたとき
- `compile-timeline` が `05_timeline/timeline.json` を新規作成または更新した直後
- `scripts/compile-timeline.ts --patch ...` で patch apply 後の `timeline.json` が更新された直後
- `timeline.json`、`06_review/human_notes.yaml`、`STYLE.md` のいずれかが変わり、既存 review artifact が stale になったとき

**compile の直後に review を省略してはいけない。** `timeline_version` が変わったら前回の
`review_report.yaml` / `review_patch.json` は再評価対象とみなす。

## 前提条件

- `schemas/review-report.schema.json` と `schemas/review-patch.schema.json` を守ること
- `runtime/commands/review.ts` の preflight / promote / state transition と整合すること
- `/review` preflight は deterministic に以下を行う
  1. compile
  2. placeholder `05_timeline/review.mp4` の生成
  3. `05_timeline/review-qc-summary.json` の生成
  4. roughcut critique
  5. patch safety guard
- `06_review/human_notes.yaml` がある場合は `schemas/human-notes.schema.json` に合わせて読むこと
- current repo の `review.mp4` は実レンダではなく JSON stub。直接視聴ベースの断定は避け、timeline / QC からの推論であることを明示すること
- compile gate / planning gate / timeline schema validation が preflight で落ちた場合、これは critic の `FATAL` 判定ではなく command failure (`GATE_CHECK_FAILED`) として止まる

## 評価の優先順

### 1. evidence の優先順

- `human_notes.yaml`
- brief / blueprint との factual mismatch
- `timeline.json` / `review-qc-summary.json` / markers / quality flags
- AI-only craft / style inference

### 2. critique baseline の順序

- brief mismatch
- blueprint mismatch
- technical deliverability
- craft / style

taste-level のコメントで factual mismatch を覆い隠さない。

### 3. craft 判断の優先順位

craft 上のトレードオフは Walter Murch の Rule of Six で並べる。

- `emotion > story > rhythm > eye_trace > plane_2d > space_3d`

2D / 3D continuity が改善しても、emotion や story を弱めるなら減点する。

**`references/review-rubric.md` を必ず参照すること。**

## やること（ステップ）

### Step 1: preflight の成否と artifact を確認する

- 現在の `05_timeline/timeline.json` を正とする
- `05_timeline/review.mp4` と `05_timeline/review-qc-summary.json` を確認する
- `review.mp4` が placeholder の場合は、`summary_judgment.rationale` や `details` で inference ベースの評価であることを曖昧にしない

### Step 2: factual mismatch を先に切る

- `must_have`, `must_avoid`, `message.primary`, `audience.primary`, `emotion_curve` を確認する
- `edit_blueprint.yaml` の beat purpose, required role coverage, pacing intent と `timeline.json` の実際を照合する
- factual mismatch を見落としたまま taste の話に進まない

### Step 3: rubric に沿って評価する

- `references/review-rubric.md` の構成 / 感情 / リズム / 技術チェックを順番に見る
- 重要な指摘にはできるだけ `evidence`, `affected_beat_ids`, `affected_clip_ids` を付ける
- 直接観測と推論を混ぜない

### Step 4: `review_report.yaml` を作る

必須 section:

- `summary_judgment`
- `strengths`
- `weaknesses`
- `fatal_issues`
- `warnings`
- `mismatches_to_brief`
- `mismatches_to_blueprint`
- `recommended_next_pass`

### Step 5: 判定を決める

#### `PASS`

- 意味:
  technical deliverability に blocker がなく、構成 / 感情 / リズムにも重大な再編集要求がない
- report への書き方:
  - `summary_judgment.status: approved`
  - `fatal_issues: []`
- runtime 上の意味:
  critic judgment が通っただけで、project state は operator accept まで自動で `approved` にならない

#### `needs_revision`

- 意味:
  technical blocker はないが、hook / pacing / beat order / clip choice / audio policy などに改善余地がある
- report への書き方:
  - `summary_judgment.status: needs_revision`
  - `fatal_issues: []`
- 次アクション:
  localized fix が safe op に落ちるなら patch を出す

#### `FATAL`

- 意味:
  preflight 通過後なお、意図した message / coherence / technical deliverability を壊す blocker が残る
- report への書き方:
  - `summary_judgment.status: blocked`
  - `fatal_issues` を必ず埋める
  - `recommended_next_pass.goal` で compile 再実行や blueprint 見直しの要否を明示する
- 次アクション:
  unsafe patch でごまかさず、root cause を report に残す

## `review_patch.json` の生成ルール

- `/review` では `06_review/review_patch.json` を artifact として常に作る
- safe op がない場合も空 patch を作る

基本 shape:

```json
{
  "timeline_version": "<timeline.json version>",
  "operations": []
}
```

`operations` を入れてよい条件:

- 問題が局所的で、safe / deterministic / machine-executable な修正に落ちる
- `reason` が 1 op ごとに明確
- `evidence` が report の指摘と結び付いている

safe rule:

- `replace_segment`
  - `target_clip_id` の `fallback_segment_ids` に含まれる segment
  - または `human_notes.yaml` の `approved_segment_ids` に含まれる segment
- `insert_segment`
  - `human_notes.yaml` に `directive_type: insert_segment` と machine-readable anchor がある場合のみ
- `trim_segment`, `move_segment`, `remove_segment`, `change_audio_policy`, `add_marker`, `add_note`
  - target が一意で、意図と副作用を説明できる場合のみ

safe に直せない場合:

- issue は report に残す
- patch は `operations: []` にする
- 無理に unsafe な `replace_segment` / `insert_segment` を作らない

**`references/patch-patterns.md` を参照し、自然言語の改善提案を schema-valid な op に落とすこと。**

## 出力 artifact

- `06_review/review_report.yaml`
- `06_review/review_patch.json`
- `05_timeline/review.mp4`
- `05_timeline/review-qc-summary.json`

## 注意事項

- `human_notes.yaml` が AI 判断と衝突した場合は human note を優先し、AI 側は `alternative_directions` に退避する
- `PASS` でも warning はありうる。warning だけで `fatal_issues` に昇格させない
- `FATAL` でも、原因が preflight hard failure なら review artifact ではなく command failure になる
- `replace_segment` / `insert_segment` は patch safety guard で filtering される。reject される前提の op に依存した report を書かない
