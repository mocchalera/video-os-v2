---
name: full-pipeline
description: Use when the user wants an end-to-end run from source footage to a rough cut or final packaged video, or asks "素材から動画を作って", "全自動で", "編集して", or "粗編集を作って", and you need to chain the existing stage Skills without inventing a nonexistent one-shot CLI.
metadata:
  filePattern:
    - '**/03_analysis/assets.json'
    - '**/04_plan/edit_blueprint.yaml'
    - '**/05_timeline/timeline.json'
    - '**/07_package/video/final.mp4'
  bashPattern: []
---
# full-pipeline

## いつ使うか（必ず発火する条件）

- ユーザーが「素材から動画を作って」「全自動で」「編集して」「粗編集を作って」と言ったとき
- rough cut まで、または final package までを途中 stage を跨いで進めたいとき
- 既存 project に artifact はあるが、「途中から再開して」「続きから直して」と言われたとき

**このスキルは orchestration 専用。** analyze から package までを一発で回す架空の CLI を作らず、既存 stage Skill を Gate 付きでつなぐ。

## 前提条件

- この repo には analyze から package までを一発で回す単独 CLI はない
- 開始前に `references/gate-conditions.md` を読むこと
- 失敗時や再実行時は `references/recovery-playbook.md` を読むこと
- Gate 番号は full-pipeline 用の orchestration 定義であり、runtime の内部 gate 名とは 1 対 1 ではない
  - Gate 1 は実質 `analysis_gate`
  - Gate 3 は実質 `compile_gate`
  - Gate 5 の後ろで `planning_gate` も確認する
  - Gate 7 は実質 `review_gate`
  - Gate 9-10 は `packaging_gate` と `checkGate10()` に対応する
- 進行判断は「一番下流の file があるか」ではなく「最も早く失敗した Gate はどこか」で決める

## やること（ステップ）

### Step 0: ゴールと再開地点を決める

- まず user が rough cut (`06_review/*` まで) を欲しいのか、final package (`07_package/*` まで) を欲しいのかを切り分ける
- つぎに Gate 10 から Gate 0 へ逆順で artifact を点検し、**最初に失敗する Gate** を再開地点にする
- 既存 artifact があっても upstream が変わっていれば stale とみなす。`runtime/state/reconcile.ts` の invalidation matrix に従い、以下のように巻き戻す
  - brief または analysis が変わったら `select-clips` からやり直す
  - selects または `STYLE.md` が変わったら `build-blueprint` からやり直す
  - blueprint が変わったら `compile-timeline` からやり直す
  - timeline または `human_notes.yaml` が変わったら `review-roughcut` をやり直す
  - `caption_approval.json`、`music_cues.json`、`qa-report.json` が変わったら package artifact をやり直す

### Step 1: Gate 0 を確認する

- fresh run なら素材ファイルまたは素材フォルダが存在することを確認する
- resume で Gate 1 以降の artifact が valid なら、raw media を再解析しない限り Gate 0 は再通過扱いでよい
- Gate 0 が落ちたら進めない。正しい素材パスを確定してから再開する

### Step 2: Gate 1 を通す

- `03_analysis/assets.json` と `03_analysis/segments.json` が無い、壊れている、または stale なら `analyze-footage` を使う
- `gap_report.yaml` の blocking な欠落で `qc_status` が `blocked` なら先に analysis をやり直す
- `qc_status` が `partial` の場合、matching な `analysis_override` があるときだけ後続に進める
- API key や外部推論が足りない場合は、repo にある `--skip-stt`、`--skip-vlm`、`--skip-diarize`、`--skip-peak` だけを使って degraded path を明示する

### Step 3: Gate 2 と Gate 3 を通す

- `creative_brief.yaml` が無い、schema invalid、または stale なら `design-intent` を使う
- `unresolved_blockers.yaml` に `status: blocker` があれば Gate 3 失敗。勝手に compile に進まない
- blocker を消す場合は `design-intent` を再実行して brief / blockers を更新する
- 仮置き assumption で進める場合も、user 合意を取ったうえで blocker 側に反映してから進む

### Step 4: Gate 4 を通す

- `04_plan/selects_candidates.yaml` が無い、schema invalid、candidate が 0 件、または brief / analysis 更新で stale なら `select-clips` を使う
- referential integrity まで含めて通す。`segment_id` / `asset_id` が analysis artifact に存在しないならやり直す

### Step 5: Gate 5 を通す

- `04_plan/edit_blueprint.yaml` が無い、schema invalid、または stale なら `build-blueprint` を使う
- さらに `04_plan/uncertainty_register.yaml` を確認し、`status: blocker` が残るなら planning blocker とみなして止める
- blueprint file が存在しても uncertainty blocker がある状態では、そのまま review / package まで自動で進めない

### Step 6: Gate 6 を通す

- `compile-timeline` を使って `05_timeline/timeline.json` を作る
- compile 後は必ず post-compile validation を見る。`timeline.json` が schema invalid なら Gate 6 失敗
- 失敗時は compile error をそのまま downstream patch でごまかさず、`references/recovery-playbook.md` に従って upstream stage に戻る

### Step 7: Gate 7 を通す

- `review-roughcut` を使って `06_review/review_report.yaml` と `review_patch.json` を作る
- `timeline.json` が変わった直後の review は省略しない
- `fatal_issues` が 1 件でもあれば Gate 7 失敗。package には進まない

### Step 8: Gate 8 を通す

- `review_patch.json` に safe op があるなら `compile-timeline` の patch mode で適用する
- patch 後は `timeline.json` を再検証し、必ず `review-roughcut` を再実行する
- patch が empty、unsafe、または compile 後 schema invalid の場合は Gate 8 失敗。report の root cause に従って `build-blueprint` か `select-clips` に戻る

### Step 9: Gate 9 を通す

- user が rough cut だけを求めているなら Gate 7 または Gate 8 で止める
- final output が必要なら `references/gate-conditions.md` の Gate 9 前提を確認する
- 特に operator accept または creative override を経た `approved` state、handoff decision、caption / music prerequisite、`engine_render` なら `assembly.mp4`、`nle_finishing` なら supplied final の有無を確認する

### Step 10: Gate 10 を通す

- Gate 9 が通ったら `render-video` を使う
- `qa-report.json` が fail なら packaged に進めない。失敗した QA 項目を直して Gate 9 からやり直す
- `package_manifest.json` と `qa-report.json` が揃い、QA が pass して初めて完了扱いにする

## 出力 artifact
- `01_intent/*`
- `03_analysis/*`
- `04_plan/*`
- `05_timeline/*`
- `06_review/*`
- 条件が揃っていれば `07_package/*`

## 注意事項

- current repo の `review.mp4` は placeholder で、実 preview render ではない
- final render は `assembly.mp4` 前提なので、`timeline.json` だけでは `final.mp4` まで進めない
- Gate 7 や Gate 8 が落ちたときは、無理に patch を盛るより earliest failing gate へ戻る
- user が「全自動」と言っても、Gate 3 の blocker 解消や Gate 10 の handoff decision のような human decision は残る
