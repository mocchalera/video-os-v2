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
- 現 repo には `scripts/render-video.ts` のような専用 CLI はない。既存実装は `runtime/commands/package.ts` の `packageCommand()` を使う。
- Gate 10 を満たしていること。
  `current_state: approved`
  `approval_record.status: clean` または `creative_override`
  `handoff_resolution.status: decided`
  `handoff_resolution.source_of_truth_decision: engine_render` または `nle_finishing`
  `gates.review_gate: open`
- `engine_render` の場合は `05_timeline/assembly.mp4` が必要。
- caption が有効なら `07_package/caption_approval.json`、BGM が有効なら `07_package/music_cues.json` が必要。

## やること（ステップ）
1. Gate 10 と package 前提を確認する。
2. `engine_render` path なら `packageCommand()` を呼ぶ。

```bash
npx tsx -e 'import { packageCommand } from "./runtime/commands/package.ts";
const result = await packageCommand("projects/<project>", {
  assemblyPath: "projects/<project>/05_timeline/assembly.mp4"
});
if (!result.success) {
  console.error(result.error);
  process.exit(1);
}
console.log(JSON.stringify(result, null, 2));'
```

3. `nle_finishing` path なら supplied final を検証用に渡す。

```bash
npx tsx -e 'import { packageCommand } from "./runtime/commands/package.ts";
const result = await packageCommand("projects/<project>", {
  suppliedFinalPath: "projects/<project>/07_package/video/final.mp4"
});
if (!result.success) {
  console.error(result.error);
  process.exit(1);
}
console.log(JSON.stringify(result, null, 2));'
```

## 出力 artifact
- `07_package/video/final.mp4`
- `07_package/video/raw_video.mp4`
- `07_package/audio/raw_dialogue.wav`
- `07_package/audio/final_mix.wav`
- `07_package/captions/*.srt` / `*.vtt` 必要な場合のみ
- `07_package/qa-report.json`
- `07_package/package_manifest.json`

## 注意事項
- 現在の render pipeline は `timeline.json` から直接 clip extraction / concat を行わない。前提は既に存在する `05_timeline/assembly.mp4`。
- `music_cues.json` がなくても `final_mix.wav` は生成される。no-BGM path では raw dialogue を pass-through する。
- `caption_burn` と `audio_mix` の実行ログは `07_package/logs/*.log` に出る。
