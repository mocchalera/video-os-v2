## Findings

QAループの偽装合格を廃止しました。設計は additive な `visual_qa: "verified" | "blocked" | "unverified"` を採用し、既存成果物の読み込みを壊さないよう既存フィールドは維持しています。

主な変更は以下です。

- レンダー欠如/skip/Marlin不可用時は [qa-loop.ts](/Users/operator/Dev/video-os-v2-spec/runtime/eval/qa-loop.ts:313) で `score: 0`, `visual_qa: "blocked"` の Marlin QA レポートを作成。
- `VOS_MARLIN_MOCK` 由来のQAは [marlin-qa.ts](/Users/operator/Dev/video-os-v2-spec/runtime/eval/marlin-qa.ts:106) で検出し、[mock: true / visual_qa: "unverified"](/Users/operator/Dev/video-os-v2-spec/runtime/eval/marlin-qa.ts:299) として合格扱いしない。
- 合否判定の共通判定を [marlin-qa-types.ts](/Users/operator/Dev/video-os-v2-spec/runtime/eval/marlin-qa-types.ts:10) に追加。旧 `Marlin QA skipped` + `score:100` placeholder も後方互換で blocked 扱いにしました。
- QA改善レポートは blocked/unverified/mock の場合 [overall_qa_score: 0](/Users/operator/Dev/video-os-v2-spec/runtime/eval/qa-improvement-report.ts:43) にし、[qa-issue-detector.ts](/Users/operator/Dev/video-os-v2-spec/runtime/eval/qa-issue-detector.ts:129) で非fixable issueを出すため `no_issues` に見えません。
- スキーマファイル変更は不要でした。TypeScript契約上は任意フィールド追加のみで、既存成果物は読めます。

## Evidence

変更ファイルは8件です。

- `runtime/eval/marlin-qa-types.ts`
- `runtime/eval/marlin-qa.ts`
- `runtime/eval/qa-improvement-report.ts`
- `runtime/eval/qa-issue-detector.ts`
- `runtime/eval/qa-loop.ts`
- `tests/marlin-qa.test.ts`
- `tests/qa-issue-detector.test.ts`
- `tests/qa-loop.test.ts`

テスト結果:

- `npm test`: 138 files passed, 4 skipped; 2465 tests passed, 39 skipped
- `npx tsc --noEmit`: passed
- `npx vitest run tests/qa-loop.test.ts tests/marlin-qa.test.ts tests/qa-issue-detector.test.ts tests/qa-improvement-report.test.ts`: 4 files, 35 tests passed
- `git diff --check`: passed

追加した回帰テストは、レンダー無し `visual_qa: "blocked"`、mock report `visual_qa: "unverified"` / `visual_qa_mock: true`、実レポート `visual_qa: "verified"` の3系統をカバーしています。

影響調査 grep の要点:

- `scripts/editorial-pipeline.ts` は `runQALoop` の結果を読むだけで、blocked 状態でもクラッシュせず warnings と score を出します。
- `scripts/marlin-qa.ts` は summary 表示のみで、未検証QAを pass と表示しない文言に変更済み。
- `runtime/packaging/gate10.ts` / `runtime/packaging/qa.ts` は `07_package/qa-report.json` 系の別QAを見ており、今回の `06_review/qa-improvement-report-*` 追加フィールドには非依存。
- macOS Studio の `QADashboardDocument` は `overall_qa_score` を数値として読む実装で、未知フィールドは無視されます。blocked時も `0/100` と issue count として表示され、decode例外にはなりません。

禁止パス（`.project-loop/`, `.env*`, `projects/*/02_media`, `projects/*/09_output`）は差分にありません。既存の未追跡 `docs/improvement-plan-ux-quality-20260706.md` は今回触っていません。コミットもしていません。

<oai-mem-citation>
<citation_entries>
MEMORY.md:2795-2795|note=[prior optional QA path context]
MEMORY.md:2825-2825|note=[kept QA additive and nonblocking]
MEMORY.md:2834-2839|note=[post-render QA wiring and Marlin QA runtime context]
MEMORY.md:3540-3540|note=[real low Marlin QA score context]
MEMORY.md:3563-3563|note=[compile render success is not QA success]
</citation_entries>
<rollout_ids>
019eda65-f50e-7500-91cf-afe033698e54
019edb3d-81dd-7810-a580-d6dc86c43b24
</rollout_ids>
</oai-mem-citation>
