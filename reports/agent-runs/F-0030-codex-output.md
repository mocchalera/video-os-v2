## Findings — 整列アルゴリズム、制約ポリシー設計、既存adjacencyとの統合方法
実装完了しました。beat 内の並びは `semantic_cluster_id` がある場合に「クラスタ単位 → クラスタ最早 `src_in_us` → クラスタ内 `src_in_us`」で決定論的に整列し、クラスタ情報が無い入力は従来挙動を維持します。同一 asset は `reorder_or_fail` で beat 内の隣接化を試み、beat 跨ぎで解消不能なら `ContinuityConstraintError` としてコンパイル失敗にします。

`runtime/compiler-defaults.yaml` に `continuity.same_asset_repeat: reorder_or_fail` と `continuity.same_cluster_repeat: warn` を追加しました。`allow_revisit` は beat への additive schema として追加し、sample/demo の意図的 callback は blueprint 側で宣言済みです。

検査は `runtime/compiler/adjacency.ts` に統合し、既存の adjacency/review metrics と同じ candidate/source asset 解決基準を使うようにしました。適用結果は `CompileResult.continuity`、CLI 出力、`timeline.json` の additive `metadata.continuity` に記録されます。

## Evidence — 変更ファイル一覧、テストコマンドと結果件数
変更ファイル:
`runtime/compiler/assemble.ts`, `runtime/compiler/adjacency.ts`, `runtime/compiler/index.ts`, `runtime/compiler/types.ts`, `runtime/compiler/normalize.ts`, `runtime/compiler/export.ts`, `runtime/compiler-defaults.yaml`, `scripts/compile-timeline.ts`, `runtime/commands/review/preflight.ts`, `schemas/edit-blueprint.schema.json`, `schemas/timeline-ir.schema.json`, `projects/sample/04_plan/edit_blueprint.yaml`, `projects/demo/04_plan/edit_blueprint.yaml`, `tests/golden/sample-timeline.json`, `tests/compiler-continuity.test.ts`.

検証:
- `npm test` passed: 142 files passed, 4 skipped; 2514 tests passed, 39 skipped.
- `npx tsc --noEmit` passed.
- `git diff --check` passed.
- `.project-loop/`, `.env*`, `projects/*/02_media`, `projects/*/09_output` は差分なし。
- git commit はしていません。

<oai-mem-citation>
<citation_entries>
MEMORY.md:1307-1315|note=[video-os project-loop context]
MEMORY.md:1856-1858|note=[editorial QA loop context]
</citation_entries>
<rollout_ids>
019efd66-3584-7e01-be76-837c1be5d2d2
</rollout_ids>
</oai-mem-citation>
