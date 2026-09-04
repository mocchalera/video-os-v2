# Editorial Agreement Eval Harness

人間（またはオペレータ）が承認した編集 = **ゴールデン** を正解データとして、
エージェントの出力（selects / blueprint / timeline）がどれだけ人間の編集判断と
一致するかを測る回帰評価ハーネス。

プロンプト・モデル・コンパイラ・スキルを変更したら、このハーネスで
「編集センスの一致率」が上がったか下がったかを必ず確認する。

## クイックスタート

```bash
# ゴールデン一覧（projects/*/project_state.yaml の approval_record から自動検出）
npm run eval -- --list

# 全ゴールデンを自己回帰チェック（同じ入力を現行コンパイラで再コンパイルし承認版と比較）
npm run eval -- --all

# 別プロジェクトとして再実行した candidate をゴールデンと比較
npm run eval -- --candidate projects/my-rerun --golden projects/fumoto-growth

# しきい値ゲート（CI 用）: 80 点未満で exit 1
npm run eval -- --all --min-score 80

# LLM ジャッジも併用（GEMINI_API_KEY 必須。構造スコア 70% + ジャッジ 30%）
npm run eval -- --candidate <dir> --golden <dir> --judge

# 固定3プロジェクトの統合回帰（既定は外部モデルを起動しない）
npm run eval -- --suite golden --no-write

# 統合回帰で live judge / Marlin QA を明示的に有効化
npm run eval -- --suite golden --judge --marlin
```

レポートは `reports/eval/` に JSON + Markdown で出力される（`--no-write` で抑制）。

## ゴールデンの条件

`projects/<id>/project_state.yaml` に `approval_record.approved_by` があり、
selects / blueprint / timeline が揃っていること。

- `approved_by: operator` → **human ティア**（最優先の正解データ）
- それ以外（`codex`, `auto:full_autonomy` 等）→ agent ティア

新しいゴールデンを増やすには: 人間編集者が承認したプロジェクトの
`project_state.yaml` に approval_record を記録するだけ。登録ファイルは不要。

## 測っているもの

| ステージ | 主メトリクス | 重み |
| --- | --- | --- |
| selects | segment F1（精度/再現率）、役割一致、順位相関（Spearman）、beat 適格性 Jaccard | 0.35 |
| timeline | クリップ使用 F1、カット順序一致（LIS）、トリム偏差、総尺偏差、ビート構造 | 0.45 |
| blueprint | ビート数、story_role 系列（LCS）、尺配分、ペーシング、音楽方針 | 0.20 |

- セグメント照合は **ID 完全一致 → 同一アセット内の時間 IoU（≥0.3）** の二段階。
  再トリムされた同一モーメントは temporal マッチとして拾う。
- 各ステージは両側にアーティファクトがある場合のみ評価され、重みは再正規化される。
- 総合スコアは 0–100。`--min-score` で回帰ゲートになる。

## モード

- **compare**: candidate プロジェクト vs ゴールデン。LLM ステージ
  （select-clips / build-blueprint）の変更評価はこれを使う。
  凍結した 03_analysis + creative_brief を candidate 側へコピーして
  該当スキルだけ再実行し、その出力を比較するのが正しい手順。
- **self**: ゴールデン自身の入力を現行コンパイラで再コンパイルして承認版と比較。
  新データ不要で、コンパイラ/ポリシーのドリフトを検出する。
  ゴールデンのファイルには一切書き込まない（tmp にコピーして実行）。
- **suite**: `fumoto-growth` / `togakushi-camp` / `ena-promo` に加え、
  speech-led testimonial の人間承認ゴールデン
  `ax1-komatsu-testimonial-d4892` / `ax1-female-testimonial-d4892` を固定対象に、
  self、brief-alignment、Marlin QA、構造と映像の乖離を単一サマリへ集約する。
  通常実行は決定論的で、live judge は `--judge`、live Marlin QA は `--marlin`
  を指定した場合のみ起動する。旧形式timeline、render欠如、モデル未実行は
  成功として偽装せず、ステージごとの理由付き `skipped` として残す。

`--no-write` はsuite summaryとMarlin QA reportの書き込みを抑止する。
モデル用の一時ファイルや再利用可能なローカルキャッシュはreportには含まれない。

## Assembly loss 診断CLI（非canonical）

M2A の assembly-loss 診断コア（`runtime/eval/assembly-loss.ts`）を
実プロジェクトのアーティファクトに接続し、hash-pinned な非canonical
レポート（`assembly-loss-report/v1`）を生成するCLI。

```bash
# 基本形: 必須4アーティファクト + transcripts を読み reports/eval/ へ出力
npx tsx scripts/eval-assembly-loss.ts projects/<id>

# 出力先指定 / 書き込みなし評価
npx tsx scripts/eval-assembly-loss.ts projects/<id> --output-dir /tmp/reports
npx tsx scripts/eval-assembly-loss.ts projects/<id> --no-write

# 任意証跡とポリシー上書き
npx tsx scripts/eval-assembly-loss.ts projects/<id> \
  --causal-refs '[{"from_beat_id":"b1","to_beat_id":"b2"}]' \
  --human-reference '{"label":"human","clips":[{"segment_id":"seg1"}]}' \
  --wall-clock '{"select":12.5}' \
  --asr-tolerance-us 100000 \
  --analysis-coverage /path/to/coverage.json
```

- 必須入力は validated loader 経由（brief / selects / blueprint / timeline）。
  欠落・不正は exit 1。
- `03_analysis/transcripts/TR_*.json` はファイル名順で読み、無ければ
  fail-open（unknown）。存在するが不正なら fail-closed。
- analysis coverage は既存 `analysis-coverage-report.schema.json` で検証し、
  `summary.status` を core 用の top-level `status` に正規化する。必須 shape
  欠落は fail-closed。project 外の override ファイルは source_artifacts 上
  `@external/analysis-coverage` という固定論理ロケータ + raw hash で記録される。
- `--output-dir` が project root 内（canonical subtree 含む）に解決される場合は
  書き込み前に拒否する。4出力（JSON/MD/2 sidecar）はローカルトランザクションで
  書かれ、install 失敗時は新規ファイルを除去して全 backup を復元する。
- レポートは canonical アーティファクトではなく診断用。JSON+MD+各 `.sha256`
  sidecar を決定論的な basename で書き出す。同一入力+policy ならバイト一致。
- envelope とcoreの evaluator/input/policy identity はrender/write前に一致検証し、
  いずれかのtamperをfail closedで拒否する。
- coverage 失敗時は verdict `HOLD`（exit 0・有効な診断）。
  スコアやランキングには使わないこと。

## LLM ジャッジ（オプション）

構造メトリクスは「何がズレたか」を測るが、そのズレが編集として
良いか悪いかは判断しない。`--judge` は Gemini にゴールデンと candidate の
両カットとブリーフを渡し、emotion / story / rhythm / agreement_with_golden を
0–10 で採点させる（明確に改善している逸脱は罰しないようプロンプトで指示済み）。
`GEMINI_API_KEY` がなければ静かにスキップされ、決定論パートだけで完結する。

モデルは `EVAL_JUDGE_MODEL` で上書き可（デフォルト `gemini-2.5-flash`。
VLM 分析はコスパ重視で `gemini-2.5-flash-lite` — runtime/analysis-defaults.yaml 参照）。

## 実装

- 本体: `runtime/eval/`（matching / selects-agreement / timeline-agreement /
  blueprint-agreement / golden-registry / llm-judge / report / index）
- CLI: `scripts/eval.ts`
- テスト: `tests/eval-harness.test.ts`
- スキル: `agents/skills/evaluate-edit/SKILL.md`

## 既知の運用メモ

- self モードのスコアが 100 でないのは「現行コンパイラが承認時と違う判断を
  している」ことを意味する。意図的なコンパイラ改善なら、改善後の出力を
  人間が再承認してゴールデンを更新する。意図しないドリフトなら回帰。
- ゴールデンが増えるほど評価の信頼性が上がる。人間編集者が手を入れて
  確定した編集は必ず approval_record を残すこと。
