## Findings

- 新設 `runtime/connectors/editorial-llm.ts` で `codex_exec` / `claude_cli` / `gemini` / `deterministic` を抽象化しました。既存の triage / blueprint / unified rough/fine のプロンプトと JSON 契約は維持し、呼び出し口だけ差し替えています。
- `auto` は `codex` CLI → `claude` CLI → `GEMINI_API_KEY` → deterministic の順です。`VOS_EDITORIAL_LLM` で上書き、timeout は `runtime/analysis-defaults.yaml` の `180000ms` デフォルトです。
- JSON parse/schema validation に失敗した場合は1回だけ修復 retry し、それでも失敗したら次 runtime へ進みます。成果物には additive な `decision_runtime` を追加し、`attempted_runtimes` と `fallback_warnings` でフォールバック連鎖を残します。
- `codex exec` スモークは実機で成功しました。`codex exec -s read-only --json --ephemeral --skip-git-repo-check -C <tmp> -o <last> -` が exit 0、最終応答は `VOS_CODEX_SMOKE_OK` でした。

## Evidence

変更ファイル:
- `runtime/connectors/editorial-llm.ts`
- `runtime/analysis-defaults.yaml`
- `runtime/agents/llm-triage-agent.ts`
- `runtime/agents/llm-blueprint-agent.ts`
- `runtime/agents/unified-editorial-agent.ts`
- `runtime/compiler/types.ts`, `runtime/artifacts/types.ts`, `runtime/commands/triage.ts`
- `schemas/analysis-policy.schema.json`, `schemas/selects-candidates.schema.json`, `schemas/edit-blueprint.schema.json`
- `tests/editorial-llm.test.ts`, `tests/llm-triage-agent.test.ts`, `tests/llm-blueprint-agent.test.ts`, `tests/unified-editorial-agent.test.ts`

検証:
- `npm test`: exit 0, `141 passed | 4 skipped`, `2502 passed | 39 skipped`
- `npx tsc --noEmit`: exit 0
- Focused tests: `4 passed`, `55 passed`
- `git diff --check`: no output
- 禁止パス `.project-loop/`, `.env*`, `projects/*/02_media`, `projects/*/09_output`: 差分なし
- Git commit はしていません。

<oai-mem-citation>
<citation_entries>
MEMORY.md:4508-4567|note=[editorial routing architecture memory]
rollout_summaries/2026-06-18T07-28-11-Bp5A-simplified_two_model_pipeline_doc.md:1-42|note=[two model pipeline context]
</citation_entries>
<rollout_ids>
019ed9a1-5d16-7703-af80-b2fff8e64836
</rollout_ids>
</oai-mem-citation>
