# Review: Approach A Visual Retrieval Integration

Date: 2026-06-19

## Summary Verdict

Approve with changes.

The core Approach A wiring is in place: the pipeline extracts explicit visual priorities, calls `searchFootage` with `mode: "hybrid"`, caps and deduplicates results, injects evidence after the brief and before asset evidence, writes `04_plan/visual_search_trace.json`, and enriches selected candidates additively after rough-result normalization.

The remaining issues are design-fidelity and auditability gaps, not blockers to the basic fail-open integration.

## Findings

### Medium: Prompt evidence format does not match the investigation sketch

`runtime/agents/visual-retrieval-evidence.ts:263-286` formats visual evidence as a Markdown section and per-result list. The investigation sketch expected a compact structured block keyed as `visual_retrieval_evidence`, with result fields such as `asset_id`, source range, `scores`, `matched_frame_path`, and evidence refs (`reports/investigation-headless-visual-search-integration.md:165-198`). The test plan also calls out prompt assertions for `visual_retrieval_evidence` and `matched_frame_path` (`reports/investigation-headless-visual-search-integration.md:375-378`).

The current prompt still contains the most important operational cues (`query_id`, `qwen_visual`, final score, segment id, and frame path), and `runtime/agents/unified-editorial-agent.ts:493-497` places it correctly. But because the block is not machine-shaped, it is weaker for auditability, more fragile for future tests, and easier for raw query text to disturb structurally.

Recommendation: emit the evidence payload as compact JSON under `visual_retrieval_evidence`, using `JSON.stringify` after truncating summaries and query text. Keep the ranked/not-mandatory instruction as prose around the JSON block.

### Low: Trace omits exact search input and selected linkage

`scripts/editorial-pipeline.ts:204-212` writes `04_plan/visual_search_trace.json`, but it writes the trace before rough normalization and candidate enrichment. `runtime/agents/visual-retrieval-evidence.ts:289-310` records project id, timestamp, evidence entries, unique segment count, and warnings, but does not include the exact search input (`query`, `semantic`, `mode`, `limit`) requested by the trace contract, nor selected linkage after enrichment (`reports/investigation-headless-visual-search-integration.md:347-356`).

This does not break the pipeline, but it makes the trace less useful for proving that a selected clip came from a specific Qwen retrieval result.

Recommendation: store the exact search input on each evidence entry or trace query entry. If enrichment is implemented, either update the trace after `roughCutPlanning(...)` or add a second derived linkage section mapping selected `segment_id` values back to `query_id` and scores.

### Low: Test coverage misses several contract edges

`tests/visual-retrieval-evidence.test.ts:93-263` covers extraction from `must_have`, hybrid mode, dedupe, cap, search failure, prompt formatting, and empty prompt output. `tests/unified-editorial-agent.test.ts:474-560` covers prompt injection, unchanged empty-evidence prompt, and enrichment for a selected matching segment.

Missing coverage:

- `buildVisualRetrievalTrace(...)` shape and warning aggregation.
- DB fallback statuses (`missing`, `malformed`, `fallback`) producing empty evidence plus warning.
- Qwen-unavailable hybrid search results without `qwen_visual`.
- `brief.editorial.policy_hint` extraction.
- Candidate enrichment skipped for non-retrieved candidates and duplicate enrichment prevention.
- Pipeline-level trace write to `04_plan/visual_search_trace.json`.

Recommendation: add focused unit tests for the helper gaps and one small pipeline plumbing test with mocked retrieval/writes. These can stay deterministic and do not need a real Qwen model.

## Design Alignment Assessment

Pass:

- `extractVisualQueries(...)` parses the exact `Qwen3-VL visual search priority:` prefix from `brief.must_have` and also supports line-based `brief.editorial.policy_hint` extraction (`runtime/agents/visual-retrieval-evidence.ts:51-100`).
- `runVisualRetrieval(...)` calls `searchFootage(projectDir, { query, semantic: query, mode: "hybrid", limit })`, not `mode: "visual"` (`runtime/agents/visual-retrieval-evidence.ts:207-214`).
- Deduplication keeps the best final score per `segment_id` within and across queries (`runtime/agents/visual-retrieval-evidence.ts:142-193`).
- The default total cap is 40 segments (`runtime/agents/visual-retrieval-evidence.ts:52-53`, `runtime/agents/visual-retrieval-evidence.ts:203-250`).
- Evidence is inserted after the creative brief and before Marlin asset evidence (`runtime/agents/unified-editorial-agent.ts:493-498`).
- Candidate enrichment is additive and skipped when there is no matching retrieval result (`runtime/agents/unified-editorial-agent.ts:1193-1208`, `runtime/agents/unified-editorial-agent.ts:1235-1237`).

Partial:

- Prompt rules say ranked/not mandatory and ask for `query_id` plus `qwen_visual`, but the block is Markdown rather than the structured sketch (`runtime/agents/visual-retrieval-evidence.ts:267-286`).
- Trace path is correct, but trace contents are thinner than the investigation trace contract (`scripts/editorial-pipeline.ts:208-212`, `runtime/agents/visual-retrieval-evidence.ts:289-310`).

## Fail-Open And Compatibility

- Missing or malformed DB: `searchFootage(...)` falls back to JSON search, and `runVisualRetrieval(...)` suppresses non-Qwen fallback rows while preserving warnings (`runtime/tools/footage-search.ts:549-570`, `runtime/agents/visual-retrieval-evidence.ts:215-235`).
- Search failure: caught and converted to empty evidence plus a warning (`runtime/agents/visual-retrieval-evidence.ts:236-247`).
- No visual priorities: `runVisualRetrieval(...)` returns `[]`, and prompt formatting returns an empty string (`runtime/agents/visual-retrieval-evidence.ts:201`, `runtime/agents/visual-retrieval-evidence.ts:263-266`).
- Qwen unavailable: hybrid search still runs through the search backend; when no `qwen_visual` score is available, the helper does not inject evidence and adds a warning if search returned rows (`runtime/tools/footage-search.ts:806-852`, `runtime/agents/visual-retrieval-evidence.ts:220-226`).
- No evidence backward compatibility is covered: prompt output is identical when `visualEvidence` is omitted or empty (`tests/unified-editorial-agent.test.ts:508-540`).

## Verification

- `npx tsc --noEmit`: passed.
- `npx vitest run`: passed. 126 test files passed, 4 skipped; 2302 tests passed, 39 skipped. Duration: 90.38s.

## Recommendations

1. Convert the prompt evidence block to compact JSON with a `visual_retrieval_evidence` key and literal `matched_frame_path` / `score_breakdown` fields.
2. Expand the trace schema to include exact search input and selected linkage after rough normalization.
3. Add missing tests for trace building, DB fallback, Qwen-unavailable results, `policy_hint`, non-match enrichment skip, duplicate enrichment prevention, and pipeline trace writing.
4. Truncate or JSON-escape query text in the prompt evidence block to keep prompt size and structure controlled.
