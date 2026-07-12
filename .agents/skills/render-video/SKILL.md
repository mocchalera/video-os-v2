---
name: render-video
description: Use when the user wants a final packaged video from an approved project and the project satisfies Gate 10 packaging prerequisites.
metadata:
  filePattern:
    - '**/07_package/video/final.mp4'
    - '**/07_package/audio/final_mix.wav'
    - '**/07_package/package_manifest.json'
  bashPattern: []
---
# render-video
## いつ使うか
- 「レンダーして」「動画を書き出して」と言われたとき。
- rough cut ではなく package 済み deliverable を作る段階のとき。

## 前提条件
- 最終 package/render は `scripts/package.ts` を使う。
- `npm run package -- projects/<project> [options]` と
  `npx tsx scripts/package.ts projects/<project> [options]` は同じ入口。
- Gate 10 を満たしていること。
  `current_state: approved`
  `approval_record.status: clean` または `creative_override`
  `handoff_resolution.status: decided`
  `handoff_resolution.source_of_truth_decision: engine_render` または `nle_finishing`
  `gates.review_gate: open`
- F-0023 の `review_report.visual_qa` が `verified` で min score 以上、または明示 waiver が必要。
- `engine_render` の場合、CLI は `05_timeline/assembly.mp4` が無い/古いときに `timeline.json` から自動生成し、`05_timeline/render-report.json` に freshness metadata を書く。
- caption が有効なら `07_package/caption_approval.json`、BGM が有効なら `07_package/music_cues.json` が必要。

## やること（ステップ）
1. Gate 10 と package 前提を確認する。CLI は実行前に不足と次アクションを表示する。
2. `engine_render` path なら新 CLI を呼ぶ。

```bash
npm run package -- projects/<project> --source-of-truth engine_render
```

3. `nle_finishing` path なら supplied final を検証用に渡す。

```bash
npm run package -- projects/<project> --source-of-truth nle_finishing --supplied-final projects/<project>/07_package/video/final.mp4
```

4. `assembly.mp4` を手動管理する場合だけ `--no-assembly` または `--assembly-path <path>` を使う。
   通常は自動生成に任せる。

## 出力 artifact
- `07_package/video/final.mp4`
- `07_package/video/raw_video.mp4`
- `07_package/audio/raw_dialogue.wav`
- `07_package/audio/final_mix.wav`
- `07_package/captions/*.srt` / `*.vtt` 必要な場合のみ
- `07_package/qa-report.json`
- `07_package/package_manifest.json`
- `09_output/final.mp4`
- `05_timeline/assembly.mp4` と `05_timeline/render-report.json` (`engine_render` 自動生成時)

## 注意事項
- `--skip-render` は検証/テスト用途。通常の deliverable 作成では付けない。
- `--no-assembly` は自動生成を止めるため、`05_timeline/assembly.mp4` が無い場合は packaging が失敗する。
- `music_cues.json` がなくても `final_mix.wav` は生成される。no-BGM path では raw dialogue を pass-through する。
- `caption_burn` と `audio_mix` の実行ログは `07_package/logs/*.log` に出る。
