## Findings — 接続方法、各指標の実測手法と根拠、フォールバック設計

`ffmpeg-motion` を実装し直し、pipeline に `Stage 10.6` として接続しました。結果は `03_analysis/segments.json` の各 segment に `visual_quality_measurements` として additive に保存されます。

実測方法:
- shake: `tblend=all_mode=difference + signalstats.YAVG` を低fpsサンプリングして motion bins / average / peak を算出。
- blur/sharpness: `blurdetect` の `blur mean` を使用。filter 不可時は `convolution` のラプラシアン相当 + `signalstats.YAVG` に failover。
- exposure: `blackframe` で黒潰れ率、`negate + blackframe` で白飛び率、`signalstats.YAVG` で平均輝度を測定。

`peak.ts` の `motionSupportScore = 0.5` は、`visual_quality_measurements.shake.bins` から `computeMotionSupportScore(...)` する形に置換しました。測定が無い場合だけ従来通り `0.5` に戻し、`motion_support_measured:false` と `motion_support_fallback_reason` を残します。

fail-open は、ffmpeg 不在や解析失敗時に `measured:false`、`metrics_measured:{ shake:false, sharpness:false, exposure:false }` を書き、`shake/sharpness/exposure` 本体は欠損させる設計です。偽の品質数値は入れません。

## Evidence — 変更ファイル一覧、テストコマンドと結果件数、性能の目安

変更ファイル:
- [runtime/connectors/ffmpeg-motion.ts](/Users/operator/Dev/video-os-v2-spec/runtime/connectors/ffmpeg-motion.ts)
- [runtime/pipeline/stages/visual-quality.ts](/Users/operator/Dev/video-os-v2-spec/runtime/pipeline/stages/visual-quality.ts)
- [runtime/pipeline/ingest.ts](/Users/operator/Dev/video-os-v2-spec/runtime/pipeline/ingest.ts)
- [runtime/pipeline/stages/peak.ts](/Users/operator/Dev/video-os-v2-spec/runtime/pipeline/stages/peak.ts)
- [runtime/connectors/ffmpeg-segmenter.ts](/Users/operator/Dev/video-os-v2-spec/runtime/connectors/ffmpeg-segmenter.ts)
- [runtime/connectors/vlm-peak-detector.ts](/Users/operator/Dev/video-os-v2-spec/runtime/connectors/vlm-peak-detector.ts)
- [schemas/segments.schema.json](/Users/operator/Dev/video-os-v2-spec/schemas/segments.schema.json)
- [tests/ffmpeg-motion.test.ts](/Users/operator/Dev/video-os-v2-spec/tests/ffmpeg-motion.test.ts)
- [tests/peak-detection.test.ts](/Users/operator/Dev/video-os-v2-spec/tests/peak-detection.test.ts)
- [tests/pipeline-ingest.test.ts](/Users/operator/Dev/video-os-v2-spec/tests/pipeline-ingest.test.ts)

検証:
- `npx tsc --noEmit`: passed
- `npm test`: 139 files passed, 4 skipped; 2486 tests passed, 39 skipped
- `pcl validate`: OK
- `git diff --check`: passed

性能目安:
- `tests/fixtures/media/test-clip-5s.mp4` の 5秒 segment を default `2fps / width 160` で実測: `606ms`
- pipeline stage は segment concurrency `2` で実行します。

コミットはしていません。`.project-loop/`、`.env*`、`projects/*/02_media`、`projects/*/09_output` は変更していません。

<oai-mem-citation>
<citation_entries>
MEMORY.md:3107-3153|note=[visual_quality segment contract and appraiser placement]
</citation_entries>
<rollout_ids>
019ecf05-c9a9-7022-8111-369b675d17a0
019ecf21-8fda-7c20-b52b-d0633cfe06b3
019ed6a3-60d7-7d22-a0da-e0b3f340d9be
</rollout_ids>
</oai-mem-citation>
