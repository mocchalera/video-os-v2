---
name: analyze-footage
description: Use when source footage or a material folder is provided and the user asks to analyze footage, inspect material, or generate 03_analysis artifacts such as assets.json and segments.json.
metadata:
  filePattern:
    - '**/03_analysis/assets.json'
    - '**/03_analysis/segments.json'
    - '**/03_analysis/gap_report.yaml'
  bashPattern:
    - 'analyze\.ts'
---
# analyze-footage
## いつ使うか
- 素材フォルダや動画ファイルが指定され、「分析して」「素材を見て」「03_analysis を作って」と言われたとき。
- `projects/<project>/03_analysis/` を初回生成するとき、または素材差し替え後に再解析するとき。

## 前提条件
- `npx tsx`、`ffmpeg`、`ffprobe` が使えること。
- 出力先 `projects/<project>` が決まっていること。
- STT を使うなら `GROQ_API_KEY` か `OPENAI_API_KEY`、VLM を使うなら `GEMINI_API_KEY` を用意する。
- 相対素材パスは repo root ではなく `--project` で渡した project directory 基準で解決される。

## やること（ステップ）
1. 素材パス、project path、必要なヒントを整理する。
2. 必要に応じて `--skip-stt`、`--skip-vlm`、`--skip-diarize`、`--skip-peak`、`--language`、`--stt-provider`、`--content-hint` を決める。
3. 実行する。

```bash
npx tsx scripts/analyze.ts <source-files...> --project projects/<project> --content-hint '...' --skip-stt
```

4. 実行後に `assets.json`、`segments.json`、`gap_report.yaml` を確認し、error / warning を拾う。
5. STT を有効にした場合は `03_analysis/transcripts/TR_<asset_id>.json` を確認する。
6. VLM peak を有効にした場合は `segments.json.items[].peak_analysis` が入っているかを見る。

## 出力 artifact
- `03_analysis/assets.json`
- `03_analysis/segments.json`
- `03_analysis/gap_report.yaml`
- `03_analysis/transcripts/TR_<asset_id>.json` ただし STT 実行時のみ
- `03_analysis/contact_sheets/*.png`
- `03_analysis/posters/*.jpg`
- `03_analysis/filmstrips/*.png`
- `03_analysis/waveforms/*.png`

## 注意事項
- `peak_analysis` は別ファイルではなく `segments.json` に書き戻される。
- `GEMINI_API_KEY` がない場合、`scripts/analyze.ts` は警告を出して VLM を自動スキップする。
- `gap_report.yaml` は canonical artifact なので、後続の Skill に進む前に blocking な欠落がないか必ず見る。
