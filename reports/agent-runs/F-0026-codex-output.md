## Findings — ゲート設計、閾値の根拠、recall保護の実装方法

共有ゲートを [runtime/editorial/quality-gate.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/editorial/quality-gate.ts:17) に新設しました。`visual_quality_measurements`を一次入力にして、`reject` / `warn` / `pass` / `unmeasured`を返し、候補には`quality_gate`と`quality_confidence`、selects全体には`quality_gate.counts/decisions`を記録します。

閾値は [runtime/analysis-defaults.yaml](/Users/mocchalera/Dev/video-os-v2-spec/runtime/analysis-defaults.yaml:90) に追加しました。デフォルトは保守的に、shake `> 0.45`、sharpness `< 0.20`、black/white clip ratio `> 0.80`だけをhard rejectにしています。境界値はrejectせずwarn側に落ちます。合成ffmpeg fixtureでshake/blur/黒潰れ/白飛びがrejectされることも固定しました。

recall保護は [quality-gate.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/editorial/quality-gate.ts:350) に集約しています。`role: hero`、brief `must_have`一致、唯一の`semantic_cluster_id`代表はreject条件でも`warn`へ降格し、`protected_by`に理由を残します。

両パイプラインへ適用済みです。command系は [runtime/commands/triage.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/commands/triage.ts:501) でenrich/refine後に共有ゲートを適用し、分析segment欠損時も`unmeasured`として記録します。unified系は [runtime/agents/unified-editorial-agent.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/agents/unified-editorial-agent.ts:1316) でrough-pass正規化後、schema検証前に同じゲートを通します。

## Evidence — 変更ファイル一覧、テストコマンドと結果件数、両パイプライン適用の確認方法

変更ファイル:
`runtime/editorial/quality-gate.ts`, `runtime/agents/triage-enrichment.ts`, `runtime/commands/triage.ts`, `runtime/agents/unified-editorial-agent.ts`, `runtime/analysis-defaults.yaml`, `runtime/compiler/types.ts`, `runtime/artifacts/types.ts`, `schemas/selects-candidates.schema.json`, `schemas/analysis-policy.schema.json`, `tests/quality-gate.test.ts`, `tests/ffmpeg-motion.test.ts`, `tests/triage-enrichment.test.ts`, `tests/commands.test.ts`, `tests/unified-editorial-agent.test.ts`.

成果物schemaは [schemas/selects-candidates.schema.json](/Users/mocchalera/Dev/video-os-v2-spec/schemas/selects-candidates.schema.json:77) にadditive追加し、候補単位とtop-level summaryの両方で検査可能にしました。

確認済み:
`npm test -- tests/quality-gate.test.ts tests/triage-enrichment.test.ts tests/unified-editorial-agent.test.ts tests/commands.test.ts tests/ffmpeg-motion.test.ts` -> 154 passed  
`npm test` -> 140 files passed, 4 skipped / 2494 passed, 39 skipped  
`npx tsc --noEmit` -> passed  
`python -m pcl validate --json` -> `{"errors":[],"ok":true,"warnings":[]}`

`pcl render`は`.project-loop/`に触れない制約に合わせて実行していません。git commitもしていません。

<oai-mem-citation>
<citation_entries>
MEMORY.md:1307-1353|note=[video-os project loop constraints and validation context]
</citation_entries>
<rollout_ids>
019efd66-3584-7e01-be76-837c1be5d2d2
019f1bb5-512f-75e2-998b-6471acd1bc2b
019f1c26-b244-78b1-b4fd-d2ff61acc04c
</rollout_ids>
</oai-mem-citation>
