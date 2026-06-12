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
npm run eval -- --all --min-score 80
```
- exit 0 なら回帰なし。exit 1 なら下がったプロジェクトの Markdown レポート（`reports/eval/`）を読み、どのメトリクスが落ちたか特定する。
- スコア低下が**意図した改善**なら、人間に再承認を依頼してゴールデンを更新する。意図しない低下なら変更をロールバックまたは修正する。

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
