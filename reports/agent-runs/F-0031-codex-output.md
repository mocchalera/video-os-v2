## Findings — カバレッジ設計、sqrtスケールの根拠、再試行フィードバックの内容設計

`runtime/editorial/coverage.ts` を追加し、品質ゲート後の selects に対して hard coverage を評価するようにしました。クラスタ目標は `min_candidates_per_cluster=1` を下限、`ceil(sqrt(N))` を密クラスタ向けの増分、`max_candidates_per_cluster=4` を上限にしています。18本クラスタは4本、6本クラスタは3本、1本クラスタは1本になります。

`must_have` 判定は `quality-gate.ts` の `mustHaveMatches()` を export して再利用しています。全メンバーが quality gate reject になったクラスタは `exempt_all_rejected` として免除し、理由と rejected segment ids を `coverage.notes` / cluster record に残します。

`/triage` command では品質ゲート、クラスタ補正、coverage 検査を retry loop 内に移し、不足時は既存 `coverageFeedback` に `unmet` 内容、`unused_segment_ids`、前回選定数を入れて1回だけ再選定します。再試行後も未達なら `selects_candidates.yaml` に `coverage.status: failed` を残して promote し、Gate は `GATE_CHECK_FAILED` にします。

unified rough pass も品質ゲート後に coverage を付与し、live LLM 利用時は coverage failed の場合に1回だけ hard coverage retry prompt を送ります。deterministic fallback では再問い合わせ先がないため、coverage 記録のみです。

## Evidence — 変更ファイル一覧、テストコマンドと結果件数

変更ファイル:
`runtime/editorial/coverage.ts` new, `runtime/commands/triage.ts`, `runtime/agents/unified-editorial-agent.ts`, `runtime/agents/llm-triage-agent.ts`, `runtime/editorial/quality-gate.ts`, `runtime/analysis-defaults.yaml`, `runtime/compiler/types.ts`, `runtime/artifacts/types.ts`, `schemas/selects-candidates.schema.json`, `schemas/analysis-policy.schema.json`, `tests/selection-coverage-hard.test.ts` new, `tests/unified-editorial-agent.test.ts`, `tests/commands.test.ts`, `tests/e2e-m3.test.ts`, `tests/phase-commands.test.ts`, `tests/segment-search-index.test.ts`.

Verification:
- `npx tsc --noEmit` passed.
- `npx vitest run tests/unified-editorial-agent.test.ts tests/selection-coverage-hard.test.ts` passed: 2 files, 24 tests.
- `npm test` completed: 143 files passed, 4 skipped; 2520 tests passed, 39 skipped; duration 71.65s.
- `git diff --check` passed.

Scope check: no `.project-loop`, `.env*`, `projects/*/02_media`, or `projects/*/09_output` changes. No git commit made.

<oai-mem-citation>
<citation_entries>
MEMORY.md:4587-4632|note=[prior coverage loop context and old artifact-stability caveat]
</citation_entries>
<rollout_ids>
019eca07-61eb-7e92-867c-d3cf6c0ba2cf
019eca63-c7d0-76d0-a66d-65a4e7dec2f9
</rollout_ids>
</oai-mem-citation>
