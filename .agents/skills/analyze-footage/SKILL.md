---
name: analyze-footage
description: "MUST USE when source footage or a material folder is provided and material understanding or 03_analysis generation is needed. Trigger not only on explicit analysis requests ('分析して', '素材を見て') but also when the user points at footage and says things like 'この動画で', 'この素材で', or any request that requires understanding the provided media before planning or editing."
metadata:
  filePattern:
    - '**/03_analysis/assets.json'
    - '**/03_analysis/segments.json'
    - '**/03_analysis/gap_report.yaml'
  bashPattern:
    - 'analyze\.ts'
---
# analyze-footage — 素材解析

## いつ使うか（必ず発火する条件）

- ユーザーが素材フォルダや動画ファイルを渡し、「分析して」「素材を見て」「03_analysis を作って」と言ったとき
- ユーザーが素材を指して「この動画で」「この素材で」「この映像から」のように依頼し、クリップ内容の理解が必要なとき
- `projects/<project>/03_analysis/` を初回生成するとき、または素材差し替え後に再解析するとき
- `design-intent` や `full-pipeline` から、素材理解の前提 artifact として analysis が必要なとき

## 前提条件

- `npx tsx`、`ffmpeg`、`ffprobe` が使えること
- 出力先 `projects/<project>` が決まっていること
- STT を使うなら `GROQ_API_KEY` か `OPENAI_API_KEY` を用意すること
- VLM を使うなら `GEMINI_API_KEY` を用意すること
- 相対素材パスは repo root ではなく `--project` で渡した project directory 基準で解決されること
- downstream で `select-clips` や peak ベースの判断をしたいなら `--skip-peak` を使わないこと

## やること（ステップ）

### Step 1: 素材と project を特定する

- 対象の source file 群と `--project` を確定する
- 既に `01_intent/creative_brief.yaml` があるか確認する
- 再解析なら既存の `03_analysis/assets.json`、`segments.json`、`gap_report.yaml` を読んで stale / 欠落理由を把握する

### Step 2: `content-hint` を自動抽出する

**`references/content-hint-guide.md` を参照する。**

優先順位:

1. `01_intent/creative_brief.yaml` に `content_hint` があればそれをそのまま使う
2. `content_hint` が無ければ `message.primary` を主軸にし、`must_have`、`project.title`、ユーザーの説明を足して 1-3 文で再構成する
3. brief 自体が無ければ、ユーザーの説明、素材フォルダ名、ファイル名、撮影時期の手掛かりから推定する

抽出ルール:

- 曖昧なラベルではなく、「誰が・何をしている・どんな文脈か」を入れる
- 編集意図だけでなく、映像に実際に映っている対象と文脈を書く
- 短すぎる単語 1-2 個で済ませない
- 確証のない固有名詞や出来事を捏造しない

### Step 3: `skip` / provider オプションを決める

- `--skip-stt`
  セリフ不要の B-roll only、一括素材が無音中心、または今回は映像理解だけで十分なときに使う。asset 単位で無音を自動判定するのとは別で、CLI 全体の STT を止めるフラグ。
- `--stt-provider groq`
  日本語素材を優先したいとき、または OpenAI で文字起こし品質が不安定だったときに first choice として使う。実装は `whisper-large-v3-turbo` を使い、`--skip-diarize` しなければ pyannote で話者推定を追加する。
- `--stt-provider openai`
  `gpt-4o-transcribe-diarize` の built-in diarization を使いたいときに選ぶ。pyannote 依存を増やしたくないときの選択肢。
- `--skip-diarize`
  single-speaker 素材、話者分離が不要、または pyannote が利用できないときに使う。**Groq STT 経路でだけ意味があり、OpenAI STT では実質無効。**
- `--skip-vlm`
  速度優先の技術 ingest だけ欲しいときに使う。これを付けると `summary` / `tags` / `interest_points` / `display_name` / `peak_analysis` の品質が大きく落ちるので、後続で clip triage するなら基本は使わない。
- `--skip-peak`
  quick pass で `assets.json` / `segments.json` だけ先に作りたいときに使う。`peak_analysis.recommended_in_out` が後続で必要なら使わない。**`--skip-vlm` 時は peak も走らないので、この flag はその場合ほぼ意味がない。**
- `--skip-media-link`
  `02_media/source_map.json` と symlink 生成が不要な単発解析時のみ使う。
- `--language`
  言語が明確なときは与える。STT の初期推定を減らせる。

### Step 4: 実行する

```bash
npx tsx scripts/analyze.ts <source-files...> \
  --project projects/<project> \
  --content-hint '子供の自転車練習の成長記録。公園での練習と上達の過程。' \
  --stt-provider groq
```

### Step 5: 実行後に品質チェックする

**`references/analysis-quality-check.md` を参照する。**

最低限やること:

- `03_analysis/assets.json`、`03_analysis/segments.json`、`03_analysis/gap_report.yaml` を読む
- STT 実行時は `03_analysis/transcripts/TR_<asset_id>.json` を確認する
- VLM を使ったつもりなら `segments.json.items[].summary` / `tags` と `assets.json.items[].display_name` が埋まっているか見る
- peak を使ったつもりなら `segments.json.items[].peak_analysis`、`peak_moments`、`recommended_in_out` を確認する
- downstream gate に進める前に `npx tsx scripts/validate-schemas.ts projects/<project>` を走らせ、`assets.json` と `segments.json` の schema / runner check を通す

### Step 6: 結果を要約して次の skill へ渡す

- gap の有無と severity を要約する
- generic な `display_name` や弱い peak が多い場合は `content-hint` 改善再実行を提案する
- 後続が `select-clips` なら `peak_analysis` の有無を明示する

## 出力 artifact

- `03_analysis/assets.json`
- `03_analysis/segments.json`
- `03_analysis/gap_report.yaml`
- `03_analysis/transcripts/TR_<asset_id>.json` ただし STT 実行時のみ
- `03_analysis/contact_sheets/*.png`
- `03_analysis/posters/*.jpg`
- `03_analysis/filmstrips/*.png`
- `03_analysis/waveforms/*.png`
- `02_media/source_map.json` ただし `--skip-media-link` を使わない場合のみ

## 注意事項

- `peak_analysis` は別ファイルではなく `segments.json.items[].peak_analysis` に書き戻される
- 実装上の visual semantic field 名は `visual_tags` ではなく `tags`
- `display_name` は VLM の `summary` / `tags` から生成される。`a_person_is`、`a_child_is`、`clip` のような generic name は hint 不足や VLM 解像度不足の兆候
- `GEMINI_API_KEY` がない場合、`scripts/analyze.ts` は warning を出して VLM を自動スキップする。**このとき `gap_report.yaml` が空でも VLM 成功とは限らないので artifact 本体を必ず見る**
- `gap_report.yaml` は canonical artifact だが、blocking 判定は単純な件数ではない。`runtime/mcp/gap-projection.ts` では ingest / segment の error を主に blocking として扱う
- `scripts/validate-schemas.ts` は `assets.json` / `segments.json` を検証するが、`gap_report.yaml` 自体は検証対象ではない。gap は別途読むこと
