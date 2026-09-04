---
name: full-pipeline
description: Use when the user wants an end-to-end run from source footage to a rough cut or final packaged video, or asks "素材から動画を作って", "全自動で", "編集して", or "粗編集を作って". Prefer the official full-pipeline entrypoint, then fall back to individual stage Skills for recovery.
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

**このスキルは orchestration 専用。** 通常は repo 公式の単一エントリ `npm run full-pipeline -- --project <id> --source-dir <dir>` を使う。失敗時や部分再実行だけ、既存 stage Skill を Gate 付きでつなぐ。

## 実行可能契約

- Manifest: `.agents/skills/agent-skill-contracts.json`
- Commands: `npm run full-pipeline -- --project <project-id> --source-dir <source-dir>`, `npx tsx scripts/analyze.ts`, `npx tsx scripts/editorial-agent-task.ts`, `npx tsx scripts/compile-timeline.ts`, `npm run render-route`, `npm run package`
- Public flags: `--project`, `--source-dir`, `--content-hint`, `--lyrics`, `--timing-plan`, `--from`, `--skip-analyze`, `--skip-footage-db`, `--skip-render`, `--skip-qa`, `--no-qwen3vl`, `--no-clap-audio`, `--help`
- Resume stages: `ingest`, `stt`, `marlin`, `visual-quality`, `peak`, `embeddings`, `triage`, `blueprint`, `compile`, `render`, `QA`

上記は生成manifestと契約テストで検証される。`analyze-footage` など個別stageの
フラグを、公開 `full-pipeline` CLIのフラグとして扱わないこと。

## 前提条件

- この repo の正式デフォルトは `npm run full-pipeline`。内部では既存の `analyze -> build-footage-db -> editorial-pipeline` の意味論を保ったまま連結する
- 実行中は staged progress / ETA を表示し、実測時間を `03_analysis/pipeline-timings.json` に追記する
- 次回実行では `pipeline-timings.json` を優先して ETA を出し、履歴が無い stage は `segments.json` のセグメント数から粗く見積もる。どちらも無ければ `計測中` と表示する
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
- fresh run で source dir があるなら、既定では次を使う:
  - `npm run full-pipeline -- --project <project-id> --source-dir <source-dir> --content-hint "<hint>"`
- 既存 project の途中再開なら、失敗 stage に応じて `--from <stage>`、または下記 Gate に対応する個別 skill / CLI を使う
- つぎに Gate 10 から Gate 0 へ逆順で artifact を点検し、**最初に失敗する Gate** を再開地点にする
- 既存 artifact があっても upstream が変わっていれば stale とみなす。`runtime/state/reconcile.ts` の invalidation matrix に従い、以下のように巻き戻す
  - brief または analysis が変わったら `select-clips` からやり直す
  - selects または `STYLE.md` が変わったら `build-blueprint` からやり直す
  - blueprint が変わったら `compile-timeline` からやり直す
  - timeline または `human_notes.yaml` が変わったら `review-roughcut` をやり直す
  - `caption_approval.json`、`music_cues.json`、`qa-report.json` が変わったら package artifact をやり直す
- BGM希望時はBGM Pack Registryとレビュー済みライブラリを先に使う。利用可能曲がなければ人間レビューへ回し、案件内で通常BGMを手続き生成して穴埋めしない。例外は明示的な短い `simple_sound` のみ。
- 複数尺・複数比率を同時制作する場合は、納品物ごとに brief / variant contract を分ける。長尺の `original_only` やBGMなし判断を短尺へ、短尺のaggressive hookを長尺へ暗黙継承しない。

### Step 1: Gate 0 を確認する

- fresh run なら素材ファイルまたは素材フォルダが存在することを確認する
- resume で Gate 1 以降の artifact が valid なら、raw media を再解析しない限り Gate 0 は再通過扱いでよい
- Gate 0 が落ちたら進めない。正しい素材パスを確定してから再開する

### Step 2: Gate 1 を通す

- `03_analysis/assets.json` と `03_analysis/segments.json` が無い、壊れている、または stale なら `analyze-footage` を使う
- `gap_report.yaml` の blocking な欠落で `qc_status` が `blocked` なら先に analysis をやり直す
- `qc_status` が `partial` の場合、matching な `analysis_override` があるときだけ後続に進める
- API key や外部推論が足りない場合は、個別 `analyze-footage` CLI にある `--skip-stt`、`--skip-vlm`、`--skip-diarize`、`--skip-peak` だけを使って degraded path を明示する。これらは公開 `full-pipeline` CLI のフラグではない

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
- brief / user feedback がタイトル、章ラベル、質問カード、強調語、lower third
  などの設計済みグラフィックを要求する場合、それらを `timeline.json` の
  overlay clip に登録済み `content-element/v1` として記録する。プロジェクト固有の
  JSX / HTML / 別タイムラインを作らない
- blueprint beat に `viewer_label` がある場合、HyperFrames/Remotionの章ラベル本文には
  構造用 `label` ではなく `viewer_label` を使う。`HOOK` / `LEVEL 1` / `PAYOFF` / `ENDING`
  のような内部設計語を、briefの明示指定なしに画面表示へ流用しない
- content element を追加したら `npm run render-route -- projects/<project-id>` を実行し、
  必要な Remotion / HyperFrames ownership が選ばれていることを Gate 7 前に確認する。
  要素がないのにSNSジャンルという理由だけで Remotion を強制しない
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

- authored lyrics のプロジェクトは、`--lyrics` の本文を唯一の text authority として `caption` draft を作り、`caption_preview.json` を人間に提示する。
- `caption -- approve --approved-by <human>` の明示承認と C1 projection が完了するまで review/render へ進めない。STT/music は timing evidence に限る。

- user が rough cut だけを求めているなら Gate 7 または Gate 8 で止める
- final output が必要なら `references/gate-conditions.md` の Gate 9 前提を確認する
- speech caption はジャンルを問わず **semantic caption timing** を確認する
  - `caption_policy.semantic_timing.mode: speech_sync` を基本とし、字幕cue全体が発話 onset より
    大きく先行しないようにする。読みやすさのための微先行は既定で最大2フレーム
  - オチ・驚き語・結果語がある場合だけ `mode: protect_reveals` に上げ、
    `anchor_text` を setup から分離して、word onset から既定1フレーム後に出す
  - anchor は word timing、発話冒頭、明示 `source_start_us` / `timeline_frame` のいずれかで
    根拠を持たせる。文字数比例で時刻を推測しない
  - `caption_timing_report.json` に block がある、または caption review に
    `unresolved_reveal_anchor` がある場合は承認・burn-in・Remotion renderへ進まない
  - インタビュー、講義、アクセシビリティ字幕にも `speech_sync` は適用するが、
    音声後へ一律遅延はしない。`protect_reveals` と分割は明示anchorがある場合だけに限定する
- 特に operator accept または creative override を経た `approved` state、handoff decision、caption / music prerequisite、`engine_render` なら `assembly.mp4`、`nle_finishing` なら supplied final の有無を確認する

### Step 10: Gate 10 を通す

- Gate 9 が通ったら `render-video` を使う
- `qa-report.json` が fail なら packaged に進めない。失敗した QA 項目を直して Gate 9 からやり直す
- `engine_render` では `audio-mix-report.json` が存在し、`audio_mix_policy_valid` と `loudness_target_valid` がpassしていることを確認する
- `package_manifest.json` と `qa-report.json` が揃い、QA が pass して初めて完了扱いにする
- Studio確認またはPremiere handoffを行う場合は `playback-contract-status` が `exact` であることも確認する。timeline更新後の古いpreviewを完成物として開かない

## 進捗 / ETA

- 表示形式は `[3/10] triage 実行中... 経過 1m32s / 推定残り ~4m (全体 ~7m)` を基準にする
- TTY では同じ行を更新し、非 TTY ではログ行として追記される
- stage は `ingest`, `stt`, `marlin`, `visual-quality`, `peak`, `embeddings`, `triage`, `blueprint`, `compile`, `render`, `QA`
- `03_analysis/pipeline-timings.json` は履歴 artifact。削除せず、次回 ETA の材料として扱う
- エラー時は失敗 stage 名、次に試す再実行コマンド、`troubleshoot-error` skill への誘導を表示する

## 出力 artifact
- `01_intent/*`
- `03_analysis/*`
- `04_plan/*`
- `05_timeline/*`
- `06_review/*`
- 条件が揃っていれば `07_package/*`
- renderをskipしなければ `09_output/rough-cut.mp4`

## 注意事項

- `scripts/editorial-agent-task.ts --mode interactive` を使う場合、rough/fine
  prompt出力時点は応答待ちであり完了ではない。応答適用後は共有downstreamで
  compile/render/QA/statusまで進み、`--skip-qa`時は`QA_SKIPPED` blockerを残す
- current repo の `review.mp4` は placeholder で、実 preview render ではない
- final render は `assembly.mp4` 前提なので、`timeline.json` だけでは `final.mp4` まで進めない
- programmable graphics の authority も `timeline.json`。`remotion-social/entry.tsx`
  のような project-local renderer を完成物の再現経路にしない
- Gate 7 や Gate 8 が落ちたときは、無理に patch を盛るより earliest failing gate へ戻る
- user が「全自動」と言っても、Gate 3 の blocker 解消や Gate 10 の handoff decision のような human decision は残る
