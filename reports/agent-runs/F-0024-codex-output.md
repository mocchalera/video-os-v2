## Findings — 変更内容の要約、期待仕様の解決順の設計判断

packaging QA に `resolution_valid` を追加しました。`ffprobe` で `width/height/SAR/DAR/fps` を取得し、`qa-report.json` の `metrics.resolution_check`, `actual_video_frame`, `expected_video_frame`, `resolution_mismatches` に記録します。

期待仕様の解決順は以下にしました。

1. `07_package/delivery_profiles/default.yaml`、または単一の delivery profile
2. `05_timeline/timeline.json#sequence`
3. `01_intent/creative_brief.yaml#editorial.aspect_ratio`

複数 delivery profile があり対象が曖昧な場合は、勝手に1つを選ばず timeline にフォールバックします。期待仕様がない場合だけ `resolution_check: "skipped"`、ffprobe frame metadata が取れない場合は `resolution_check: "blocked"` でQA failです。既存 loudness の fallback default 経路は触っていません。

## Evidence — 変更ファイル一覧、テストコマンドと結果件数、影響調査の要点

変更ファイル:

- `runtime/packaging/qa-measure.ts`
- `runtime/packaging/qa.ts`
- `runtime/commands/package.ts`
- `schemas/package-qa-report.schema.json`
- `tests/qa-measure.test.ts`
- `tests/m4-qa.test.ts`
- `tests/e2e-m4.test.ts`
- `tests/package-assembler.test.ts`
- `tests/phase-commands.test.ts`
- `tests/duration-mode.test.ts`

検証結果:

- `npm test` → 138 files passed, 4 skipped / 2469 tests passed, 39 skipped
- `npx tsc --noEmit` → pass
- `pcl validate` → `OK`

影響調査:

- `runtime/packaging/gate10.ts` は前提状態判定のみで、QA fail は既存どおり `packageCommand` の `qaReport.passed=false` で packaged 遷移を止めます。
- macOS Studio 側は `ProjectRenderPackageStatus.swift` の `ProjectPackageQAReport` が `passed/source_of_truth/checks` だけを読む `Decodable` で、追加した `metrics` 内フィールドはdecode対象外です。
- `.project-loop/`, `.env*`, `projects/*/02_media`, `projects/*/09_output` は未変更です。commit はしていません。

<oai-mem-citation>
<citation_entries>
MEMORY.md:1282-1284|note=[project-loop scope for video-os repo]
MEMORY.md:1326-1328|note=[project-loop runtime-state boundaries and validation stack]
</citation_entries>
<rollout_ids>
019f1bb5-512f-75e2-998b-6471acd1bc2b
019f1c26-b244-78b1-b4fd-d2ff61acc04c
</rollout_ids>
</oai-mem-citation>
