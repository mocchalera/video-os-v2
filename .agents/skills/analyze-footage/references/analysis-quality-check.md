# Analysis Quality Check

`analyze.ts` の実行直後に、artifact が「生成されたか」だけでなく「後続 skill に渡せる品質か」を確認するためのチェックリストです。

## 1. `assets.json` チェック

見る場所:

- `03_analysis/assets.json`

確認項目:

- `display_name` が意味のある名前か
  `a_person_is`、`a_child_is`、`clip` のような generic name が続くなら、VLM summary か `content-hint` が弱い
- `video_stream` が妥当か
  解像度は `width` / `height`、fps は `fps_num / fps_den` で読む
- `duration_us` が妥当か
  source と大きくズレていないかを見る
- `has_transcript` / `transcript_ref` が STT 実行意図と一致しているか
- `role_guess` が素材タイプと大きくズレていないか

実装メモ:

- `display_name` は VLM summary / tags 依存なので、ここが弱いと後続の人間レビューもしづらくなる
- `analysis_status` は ingest 初期値のまま `pending` でもあり得るので、品質判定は主に field の中身で行う

## 2. `segments.json` チェック

見る場所:

- `03_analysis/segments.json`

確認項目:

- `summary` が generic すぎないか
- `tags` が `content-hint` と整合しているか
  実装上の field 名は `visual_tags` ではなく `tags`
- `interest_points` が極端に少なすぎないか
- STT を使った場合、`transcript_excerpt` が空文字ばかりでないか
- `peak_analysis` が期待通り含まれているか
  `--skip-peak` を付けていないのに全 segment で欠落するなら、VLM 未実行、coarse no-candidate、または hint 不足を疑う
- `peak_moments[0].confidence >= 0.3` を一つの目安にする
  0.3 未満なら weak signal とみなして再確認する

## 3. `peak_analysis` の読み方

`peak_analysis` は「どこを見せ場として切り出すべきか」の段階的推定です。

- `coarse_locator`
  asset overview contact sheet 上で、どの tile span が見せ場候補だったか
- `peak_moments`
  最終的に選ばれた peak timestamp。通常は 0 件か 1 件
- `recommended_in_out`
  後続の rough cut で使いやすい切り出し区間
- `visual_energy_curve`
  区間内の盛り上がり推定。複数点が入る
- `support_signals.fused_peak_score`
  VLM と補助 signal の統合スコア。高いほど見せ場の根拠が強い
- `provenance.precision_mode`
  precision pass をどう使ったか

読むときのコツ:

- `peak_moments` の timestamp だけでなく `recommended_in_out` を必ず対で見る
- `confidence` がそこそこあっても、description が文脈を外していれば `content-hint` 改善対象
- `coarse_locator` は asset 全体のどの窓から来た候補かを見るための field で、clip の最終採用可否そのものではない

## 4. `gap_report.yaml` チェック

見る場所:

- `03_analysis/gap_report.yaml`

確認項目:

- blocking な欠落がないか
- warning を許容して進めるか
- 再実行で解消できる gap か

重要な実装挙動:

- `runtime/pipeline/ingest.ts` では STT 失敗は `severity: error` でも、project-level blocking は別判定
- `runtime/mcp/gap-projection.ts` では主に ingest / segment の error を blocking 扱いする
- VLM / peak / diarize の失敗は通常 warning か non-blocking error 相当として `partial` 寄り

実務判断:

- `segment` / `ingest` の error:
  基本は再解析または素材修復が先
- `stt` / `diarize` の問題:
  セリフ依存の企画でなければ一時許容できることがある
- `vlm` / `peak_detection` の warning:
  clip triage 前なら再実行推奨。単純な asset inventory だけなら限定的に許容可

## 5. Schema / Runner Check

`gap_report.yaml` だけでは十分ではありません。後続 gate に進めるなら schema check も走らせます。

```bash
npx tsx scripts/validate-schemas.ts projects/<project>
```

注意:

- この validator は `assets.json` と `segments.json` を検証する
- `gap_report.yaml` 自体は validator 対象ではないので、別途読む必要がある

## 6. STT / VLM の使い分け

### STT を有効にするケース

- セリフあり
- interview / talk / narration が後続編集の主軸
- `transcript_excerpt` を select 根拠に使いたい

### `--skip-stt` を使うケース

- B-roll only
- 無音素材が中心
- 今回は映像理解だけ先にほしい

### `--stt-provider groq` を優先するケース

- 日本語素材
- OpenAI で文字起こしが不安定だった
- pyannote を併用して話者分離を補ってよい

### `--stt-provider openai` を優先するケース

- built-in diarization を 1 provider で完結させたい
- pyannote 依存を増やしたくない

### `--skip-vlm` を避けるケース

- `display_name` を人間が読める形にしたい
- `tags` / `summary` / `peak_analysis` が後続で必要
- `select-clips` に進む予定

### `--skip-peak` を使うケース

- quick ingest だけほしい
- 後で別 run で見せ場解析をやり直す前提

### `--skip-diarize` を使うケース

- single-speaker
- speaker identity が不要
- pyannote unavailable

注意:

- `--skip-diarize` は Groq 経路だけで意味がある
- `GEMINI_API_KEY` が無いと `analyze.ts` は warning を出して VLM を自動スキップする
- その場合、`gap_report.yaml` が空でも VLM 成功とは言えない

## 7. 再実行判断

再実行を勧める兆候:

- `display_name` が generic
- `tags` が主題を捉えていない
- `peak_moments` が空、または confidence が低すぎる
- 期待した `transcript_excerpt` がほぼ空
- `gap_report.yaml` に segment / ingest の blocking gap がある

再実行の優先順:

1. `content-hint` を具体化する
2. `--stt-provider` を切り替える
3. `--skip-diarize` の有無を見直す
4. 必要なら `--skip-peak` を外して full analysis に戻す
