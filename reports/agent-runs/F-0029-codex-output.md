## Findings — 共有化の設計、unified適用位置、legacy参照調査の結果

capture-timeクラスタリングは [runtime/editorial/clustering.ts](/Users/operator/Dev/video-os-v2-spec/runtime/editorial/clustering.ts) に抽出しました。`triage-enrichment.ts` は互換exportを残し、command系は従来と同じ enrichment → cluster refinement → quality gate の順序です。

unified系は rough selects 正規化後、品質ゲート前に `refineClusters()` を適用します。`scripts/editorial-pipeline.ts` と `scripts/editorial-agent-task.ts` から `projectDir` を渡すようにしたため、`03_analysis/assets.json` の filename/display_name/source_locator/mtime 系も使えます。`selects_candidates.yaml` へ `semantic_cluster_id` が入った状態で quality gate が走ります。

legacy削除は保留しました。`package.json`、`.agents`、`.claude` には参照なし。ただし tests/docs に直接参照が残っています。特に `tests/llm-triage-agent.test.ts` と `tests/editorial-craft-agent.test.ts` が旧scriptの `parseArgs` をimportしているため、要件どおり削除せず残しました。置換するなら、CLI args coverageを `editorial-pipeline` / `editorial-agent-task` 側へ移してから削除です。

## Evidence — 変更ファイル一覧、テストコマンドと結果件数

変更ファイル:
`runtime/editorial/clustering.ts`, `runtime/agents/triage-enrichment.ts`, `runtime/agents/unified-editorial-agent.ts`, `runtime/commands/triage.ts`, `scripts/editorial-pipeline.ts`, `scripts/editorial-agent-task.ts`, `tests/unified-editorial-agent.test.ts`, `docs/planning-routes.md`

追加テスト:
unified rough正規化で capture-time cluster を付与し、その `semantic_cluster_id` によって `unique_cluster:*` recall保護が quality gate で `reject -> warn` になる回帰を追加。

検証:
`npx tsc --noEmit` passed  
`npx vitest run tests/triage-enrichment.test.ts tests/unified-editorial-agent.test.ts` passed: 35 tests  
`npm test` passed: 141 files passed, 4 skipped; 2507 tests passed, 39 skipped

禁止パス `.project-loop/`, `.env*`, `projects/*/02_media`, `projects/*/09_output` は変更していません。commitもしていません。

<oai-mem-citation>
<citation_entries>
MEMORY.md:1307-1309|note=[video-os-v2-spec project-loop context]
MEMORY.md:1351-1353|note=[project-loop runtime artifact rules]
</citation_entries>
<rollout_ids>
019f1bb5-512f-75e2-998b-6471acd1bc2b
019f1c26-b244-78b1-b4fd-d2ff61acc04c
</rollout_ids>
</oai-mem-citation>
