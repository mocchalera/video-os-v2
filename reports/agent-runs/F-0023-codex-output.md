## Findings — 変更内容の要約、鮮度判定と閾値の設計判断

`/review` に実映像 `marlin-qa` Gate を追加し、critic の構造評価だけでは `approved` にならないようにしました。判定は `runtime/review/visual-qa.ts` に集約し、Marlin 側の `isMarlinQAReportVerified()` / `marlinQAStatus()` を再利用しています。

鮮度判定は default render path の `09_output/rough-cut.mp4` と `09_output/render-report.json` を使います。`timeline_hash` / `video_hash` が不整合なら `stale`、メタが無い既存レンダーは timeline mtime より古ければ `stale`、レンダー無しは `blocked` です。`--render` 相当の option では既存 assembler でレンダーしてから QA します。

閾値は `runtime/compiler-defaults.yaml` に `scoring.visual_qa_min_score: 70` を追加しました。`visual_qa.status === verified` かつ score が閾値以上でない限り承認不可です。人間の escape hatch は `--allow-unverified-visual` 相当で、理由必須、`visual_qa_waiver: true` と理由を report に監査記録します。

Gate 10 も最新 `review_report.yaml` の `visual_qa` が verified か、明示 waiver があることを packaging 前提に追加しました。満たさない場合は packaged 遷移しません。

## Evidence — 変更ファイル一覧、テストコマンドと結果件数、影響調査の要点

変更ファイル:
`runtime/review/visual-qa.ts`, `runtime/commands/review/index.ts`, `runtime/commands/package.ts`, `runtime/packaging/gate10.ts`, `runtime/compiler-defaults.yaml`, `schemas/review-report.schema.json`, `scripts/render-rough-cut.ts`, `scripts/editor-job-worker.ts`, `tests/commands.test.ts`, `tests/m4-qa.test.ts`, `tests/e2e-m4.test.ts`, `tests/e2e-m3.test.ts`, `tests/package-assembler.test.ts`, `tests/phase-commands.test.ts`, `tests/golden/sample-timeline.json`

テスト結果:
`CI=1 FORCE_COLOR=0 NO_COLOR=1 npm test -- --reporter=dot --silent` passed: 138 files passed, 4 skipped; 2477 tests passed, 39 skipped.
`npx tsc --noEmit` passed.
`git diff --check` passed.
`pcl validate` passed: `OK`.

追加テストで covered:
verified + score >= 70 は approved 可能、score < 70 / blocked / stale は approved 不可、waiver は理由記録付きで approved 可能、Gate 10 は未 verified で package 不可、waiver ありで package 可。

影響調査:
`review_report.yaml` 消費側を grep しました。macOS Studio 側は `summary_judgment` の scalar 抽出や raw file presence が中心で、strict な ReviewReport YAML decode は見つかりませんでした。editor server は `yaml.load`、client は構造的 TS 型なので、追加フィールドで decode 例外になる形ではありません。コミットはしていません。`.project-loop/`, `.env*`, `projects/*/02_media`, `projects/*/09_output` は変更していません。

<oai-mem-citation>
<citation_entries>
MEMORY.md:1830-1902|note=[QA loop and marlin QA gating context]
MEMORY.md:2788-2842|note=[Marlin QA default path and verified semantics context]
</citation_entries>
<rollout_ids>
019ee53a-9b03-7033-a577-16983fc4c78a
019ee541-15ba-7660-91b7-628b270dfcd3
019ee54b-5aaf-7451-b15e-93fe6c018423
019ee572-7a17-7ea2-8b02-739085ca65f8
019ee5aa-10a8-7271-89be-455a00df6db7
019eda65-f50e-7500-91cf-afe033698e54
019edae8-e284-7e02-9810-2d539ea6d1a7
019edb05-1f35-7c62-8e89-5df3d800f1e5
019edb18-ae39-7432-9951-7757633dbce0
019edb28-d169-7032-9aef-401d878b6375
</rollout_ids>
</oai-mem-citation>
