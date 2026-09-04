---
name: evaluate-edit
description: Use after changing prompts, skills, the compiler, or editorial policies — or when the user asks to measure edit quality, run regression evals, check agreement with approved edits, or says '評価して', '一致率を測って', 'eval を回して'. Compares agent output against human-approved golden projects.
metadata:
  filePattern:
    - 'reports/eval/**'
  bashPattern:
    - 'scripts/eval.ts'
    - 'npm run eval'
---
# evaluate-edit

## いつ使うか
- select-clips / build-blueprint / compile-timeline / review-roughcut のプロンプトやロジックを変更した直後（回帰チェック）。
- 「編集の精度を測って」「ゴールデンと比較して」と言われたとき。
- 人間編集者が編集を承認した直後（新しいゴールデンとして登録する好機）。

## 前提知識
- **ゴールデン** = `project_state.yaml` に `approval_record.approved_by` がある承認済みプロジェクト。`approved_by: operator` が人間ティアで最も信頼できる正解。
- スコアは 0–100。selects（0.35）/ timeline（0.45）/ blueprint（0.20）の重み付き合成。
- 詳細は `docs/eval-harness.md` を読む。

## やること（ステップ）

### A. コンパイラ/ポリシー変更後の回帰チェック（最頻ユース）
```bash
npm run eval -- --all --min-score <approved-min-score>
```
- `<approved-min-score>` は project/eval suite が承認した gate から渡す。固定値を generic skill の universal law にしない。
- exit 0 なら回帰なし。exit 1 なら下がったプロジェクトの Markdown レポート（`reports/eval/`）を読み、どのメトリクスが落ちたか特定する。
- スコア低下が**意図した改善**なら、人間に再承認を依頼してゴールデンを更新する。意図しない低下なら変更をロールバックまたは修正する。
- 字幕タイミングを変更した場合は構造スコアだけで終わらせず、次も回帰対象にする:
  - 通常字幕は versioned caption timing policy の許容 lead を超えて音声より先に出ていない
  - protected revealの本文がanchor onsetより前のcueに含まれていない
  - word timingのない発話途中anchorが文字数比例で推測されず、`unresolved_reveal_anchor` で止まる
  - `speech_sync` のインタビュー、講義、長尺字幕は過剰先行だけが直り、音声後へ一律遅延されていない
- BGM／音声ミキサーを変更した場合は、ジャンル別の演出評価と分けて次の制作契約を回帰対象にする:
  - 通常BGMがレビュー済みライブラリ／BGM Pack由来で、手続き生成は明示的な `simple_sound` に限定される
  - BGM入力を versioned audio policy の基準へ正規化してから editorial gain を適用する
  - ducking detectorはA1 clip占有区間ではなくdialogue waveformを使う
  - `audio-mix-report.json` が存在し、BGMありでは `waveform_sidechain_v1`、なしでは `dialogue_only_mastering_v1` を記録する
  - 最終実測が versioned delivery/audio profile の loudness と true-peak target に収まる
  - source trimが`adelay`より前、全体尺trimが`amix`より後にあり、同一branchに
    `adelay=...,atrim=start=0`が生成されない
  - 総尺差が1フレーム未満でも`raw_dialogue.wav`の信号配置がtimeline window外なら
    `dialogue_timeline_alignment_valid`がfailする
  - VFR素材の同期補正は選択済み映像フレームを固定し、測定残差を音声側で補正する
- short-social / content element / handoffを変更した場合は、次の横断契約も対象テストで確認する:
  - hook/titleのコピー上限と日本語の折返しが一致し、座布団やsafe areaからはみ出さない
  - CTA要求時は登録済み full-frame `cta-card` が retention policy の指定 window/duration にある
  - `audio_policy` が納品物ごとに明示され、BGM要求時はtimelineにmusic clipがある
  - cold openが「両方」「双方」「どちらも」など未解決のantecedentで始まらない
  - Studioのsource fallbackでtimeline字幕が見え、完成previewでは二重表示されない
  - editor packetへcaption sidecarとcaption approvalが同梱される

### B. LLM ステージ（select-clips / build-blueprint）の変更評価
1. ゴールデンの凍結入力を candidate プロジェクトへコピーする:
```bash
mkdir -p projects/eval-rerun-<name>
cp -R projects/<golden>/01_intent projects/<golden>/03_analysis projects/eval-rerun-<name>/
```
2. 変更後のスキルで対象ステージだけ再実行する（/triage, /blueprint, /compile）。
3. 比較する:
```bash
npm run eval -- --candidate projects/eval-rerun-<name> --golden projects/<golden>
```
4. 判断に迷う差分は LLM ジャッジを足す（`GEMINI_API_KEY` 必須）:
```bash
npm run eval -- --candidate projects/eval-rerun-<name> --golden projects/<golden> --judge
```

### C. ゴールデンの追加
人間編集者が編集を確定したら、そのプロジェクトの `project_state.yaml` に記録する:
```yaml
approval_record:
  approved_by: operator
  approved_at: "<ISO8601>"
  status: clean
```
登録ファイルは不要。`npm run eval -- --list` で検出を確認する。

## 出力 artifact
- `reports/eval/<mode>-<candidate>-<timestamp>.md`（人間向け）
- `reports/eval/<mode>-<candidate>-<timestamp>.json`（機械向け）

## 注意事項
- self モードはゴールデンのファイルに**一切書き込まない**（tmp コピーで再コンパイル）。candidate 比較も読み取り専用。
- メトリクスは「ゴールデンとの一致」を測る。一致しない = 悪い、ではない。明確に改善した逸脱は人間の再承認でゴールデン側を更新するのが正しい運用。
- ゴールデンが3件未満の間はスコアのブレが大きい。結論を断定しない。
- eval の agent QA は human approval、platform preview、publication gate の代替ではない。
