## Findings — quantizeアルゴリズム、発話保護との統合、beat情報の取得経路

cut quantize を compiler に追加しました。`beat_sync.cut_quantize` は `auto|on|off`、`max_shift_frames` はデフォルト 12 です。`auto` は `music_cues` または BGM analysis から beat grid が読める場合だけ発動し、beat 情報なしでは `metadata.beat_sync` も出さず従来挙動を維持します。

境界処理は adjacent な video clip pair の cut frame を最寄り grid frame へ寄せ、`max_shift_frames` 内かつ両クリップが最小尺を下回らない場合だけ、左 clip の `src_out/timeline_duration` と右 clip の `src_in/timeline_in/timeline_duration` を pair-preserving に調整します。適用・スキップ結果は `timeline.metadata.beat_sync` と `CompileResult.beat_sync`、CLI の compile 出力に出ます。

発話保護は `metadata.talking_head_pacing.snapped_out/snapped_in` を境界単位で見ます。対象 cut は新規 quantize だけでなく既存 transition skill の beat snap もスキップするようにしました。

beat 情報は `music_cues.json` の additive `beat_sync.beats_sec/downbeats_sec/bpm/meter/grid_source` を優先し、なければ `music_asset.analysis_ref`、さらに `03_analysis/bgm_analysis.json`/legacy BGM analysis に fallback します。`scripts/run-bgm-analysis.ts` は既存 `music_cues.json` がある場合だけ grid を追記します。

## Evidence — 変更ファイル一覧、テストコマンドと結果件数

変更ファイル:
[runtime/compiler/beat-sync.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/compiler/beat-sync.ts),
[runtime/compiler/index.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/compiler/index.ts),
[runtime/compiler/types.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/compiler/types.ts),
[runtime/compiler-defaults.yaml](/Users/mocchalera/Dev/video-os-v2-spec/runtime/compiler-defaults.yaml),
[runtime/audio/music-cues.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/audio/music-cues.ts),
[schemas/music-cues.schema.json](/Users/mocchalera/Dev/video-os-v2-spec/schemas/music-cues.schema.json),
[scripts/compile-timeline.ts](/Users/mocchalera/Dev/video-os-v2-spec/scripts/compile-timeline.ts),
[scripts/run-bgm-analysis.ts](/Users/mocchalera/Dev/video-os-v2-spec/scripts/run-bgm-analysis.ts),
[tests/beat-sync-quantize.test.ts](/Users/mocchalera/Dev/video-os-v2-spec/tests/beat-sync-quantize.test.ts),
[tests/golden/sample-timeline.json](/Users/mocchalera/Dev/video-os-v2-spec/tests/golden/sample-timeline.json).

Verification:
`npx vitest run tests/beat-sync-quantize.test.ts` → 1 file passed, 8 tests passed.
`npm test` → 144 files passed, 4 skipped; 2528 tests passed, 39 skipped.
`npx tsc --noEmit` → passed.

`tests/golden/sample-timeline.json` は compiler defaults hash だけ更新しました。禁止領域の `.project-loop/`, `.env*`, `projects/*/02_media`, `projects/*/09_output` には差分なし。コミットはしていません。

<oai-mem-citation>
<citation_entries>
MEMORY.md:4644-4700|note=[talking_head_pacing metadata gate context]
</citation_entries>
<rollout_ids>
019ec8f4-ec8b-7a61-8e95-815226497820
</rollout_ids>
</oai-mem-citation>
