## Findings — 縮退設計、コネクタ統合方法、ダミー値廃止の影響

appraiserを`completeEditorialJson` + images経由に変更しました。画像対応runtimeは`codex_exec`優先、Gemini fallback、最終的にdeterministic到達時は評価成功扱いせず`visual_appraisal.status: "skipped"`として記録します。`claude_cli`は既存connectorどおり画像入力で実行されません。

`emotional_expression: 0.5`は廃止し、`visual_quality.score_measurements.emotional_expression.measured: false`で明示します。`motion_quality`は`focus_sharpness`のコピーをやめ、`visual_quality_measurements.shake.average_energy`がある場合だけ書きます。無い場合は欠損 + `measured: false`です。

quality gateは`visual_appraisal.status: "skipped"`のsegmentでは古いappraiser scoreをfallbackに使わないようにしました。これでappraiser不在時は既存の実測がなければ`quality_confidence: "low"`、一部実測があれば`partial`に落ちます。

## Evidence — 変更ファイル一覧、テストコマンドと結果件数

変更ファイル:
`runtime/connectors/editorial-llm.ts`, `runtime/connectors/gemini-appraiser.ts`, `runtime/pipeline/stages/appraiser.ts`, `runtime/pipeline/ingest.ts`, `runtime/editorial/quality-gate.ts`, `scripts/analyze.ts`, `schemas/analysis-common.schema.json`, `schemas/segments.schema.json`, `tests/gemini-appraiser.test.ts`, `tests/quality-gate.test.ts`, `tests/e2e-m2.test.ts`, `tests/gemini-vlm.test.ts`, `tests/openai-stt.test.ts`, `tests/pipeline-ingest.test.ts`.

検証:
- `npx vitest run tests/gemini-appraiser.test.ts tests/editorial-llm.test.ts tests/quality-gate.test.ts` → 3 files passed, 22 tests passed
- `npm test` → 141 files passed, 4 skipped; 2506 tests passed, 39 skipped
- `npx tsc --noEmit` → passed
- `git diff --check` → passed

`.project-loop/`, `.env*`, `projects/*/02_media`, `projects/*/09_output`は触っていません。commitもしていません。

<oai-mem-citation>
<citation_entries>
MEMORY.md:4431-4440|note=[repo LLM connector and JSON parser context]
MEMORY.md:4508-4536|note=[appraiser role and editorial routing context]
MEMORY.md:1307-1315|note=[project loop harness caution for this repo]
</citation_entries>
<rollout_ids>
019ecb0a-99b2-72e2-8f09-5d2b692ad637
019ecaa6-8380-7c42-8d96-8a30d4d83179
019ed68f-cd8d-7640-a623-a9fe98e3c8ed
019ed6a3-d9c3-73d0-a2db-170471cd03c8
019efd66-3584-7e01-be76-837c1be5d2d2
</rollout_ids>
</oai-mem-citation>
