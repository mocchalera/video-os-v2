# Investigation: Headless Visual Search Integration

Date: 2026-06-19

Scope: investigation and design only. No implementation code was changed.

## Executive Summary

The observation in `reports/editorial-pipeline-qwen-ena-promo.md` is accurate: the canonical headless pipeline does not execute Qwen visual search. It loads `segments.json` and `marlin_events.json`, extracts frames, sends a single text prompt to Gemini JSON for rough planning, sends a second single text prompt for fine refinement, then normalizes the JSON. Tool definitions are exposed only in interactive prompt packets and in tests; there is no production headless tool execution loop.

Recommendation: implement Approach A first, but make it C-compatible. Add a deterministic pre-planning visual retrieval stage that runs `search_footage` over brief-derived visual intent, injects compact Qwen evidence into the rough-pass prompt, and writes a non-canonical trace. Do not start by adding a general tool loop. A native or pseudo tool loop is much more invasive because `callGeminiJson()` currently uses plain `generateContent` with `responseMimeType: "application/json"` and no function-calling support.

Important nuance: brief-derived text queries should not call `mode=visual` unless there is an `image_query_path` or `visual_anchor`. Current search intentionally returns empty for `mode=visual` without a valid visual query. For must-have text such as warm light, use `search_footage` with `mode: "hybrid"` and surface the `qwen_visual` score channel.

## Current Headless Flow

Source evidence:

- `scripts/editorial-pipeline.ts` loads `01_intent/creative_brief.yaml`, `03_analysis/marlin_events.json`, `03_analysis/segments.json`, source map, and BGM duration, then extracts representative frames before calling `roughCutPlanning(...)` with no options (`scripts/editorial-pipeline.ts:169-194`).
- The script writes `selects_candidates.yaml` and `edit_blueprint.yaml`, extracts fine key frames from the selected candidates, then calls `fineCutRefinement(...)` with no options (`scripts/editorial-pipeline.ts:195-239`).
- No footage DB or editorial toolkit is loaded in `scripts/editorial-pipeline.ts`; `loadSourceMap(...)` is used only for frame extraction (`scripts/editorial-pipeline.ts:175-185`, `scripts/editorial-pipeline.ts:211-227`).

Text diagram:

```text
scripts/editorial-pipeline.ts
  |
  |-- loadCreativeBrief(01_intent/creative_brief.yaml)
  |-- loadMarlinEvents(03_analysis/marlin_events.json)
  |-- loadSegments(03_analysis/segments.json)
  |-- loadSourceMap(project).entryMap
  |-- extractRepresentativeFrames(project, segments, marlinEvents, sourceMap)
  |
  |   Injection point A1:
  |   run deterministic visual retrieval here
  |   from brief.must_have/context_knowledge -> search_footage(mode=hybrid)
  |   -> compact visual_search_evidence + trace
  |
  |-- roughCutPlanning(brief, marlinEvents, representativeFrames, segments, bgmDurationSec)
  |     |
  |     |-- buildRoughPrompt(...)
  |     |     includes creative brief
  |     |     includes Marlin asset reports + representative frame paths
  |     |     does not include footage DB/Qwen search results
  |     |
  |     |-- completeJsonWithRetry(headlessLlmCompleter(...), prompt)
  |     |     -> callGeminiJson(prompt, model)
  |     |
  |     |-- normalizeRoughResult(...)
  |
  |-- write selects_candidates.yaml + edit_blueprint.yaml
  |-- extractCraftKeyFrames(project, selected candidates, marlinEvents, sourceMap)
  |
  |   Injection point A2 / C1:
  |   optional deterministic alternates for weak or missing beats
  |   using similar_to visual anchors or search_footage hybrid queries
  |
  |-- fineCutRefinement(...)
  |     |
  |     |-- buildFinePrompt(...)
  |     |     includes selected clips, key frames, Marlin events
  |     |     text says use search_footage when weak, but headless cannot execute it
  |     |
  |     |-- completeJsonWithRetry(headlessLlmCompleter(...), prompt)
  |     |     -> callGeminiJson(prompt, model)
  |     |
  |     |-- normalizeFineBlueprint(...)
  |
  |-- compile
  |-- optional render / QA
```

## What The LLM Receives Today

Rough pass:

- `compactBrief(...)` includes project id/title/strategy/runtime, message, emotion curve, `must_have`, `must_avoid`, policies, editorial block, and `context_knowledge` (`runtime/agents/unified-editorial-agent.ts:303-321`).
- `buildRoughAssetEvidence(...)` groups by asset and includes `asset_id`, Marlin scene, `representative_frame`, segment count, up to 12 segments per asset with `segment_id`, source range, summary, and tags, plus up to 8 Marlin events (`runtime/agents/unified-editorial-agent.ts:388-423`).
- `buildRoughPrompt(...)` inserts the brief and asset evidence, and explicitly says headless fallback is text-only (`runtime/agents/unified-editorial-agent.ts:468-489`).
- The rough prompt does not include footage DB rows, search results, `qwen_visual`, `qwen_text`, embedding matches, matched frame paths from search, visual quality scores, place hints, or `search_footage` evidence.

Fine pass:

- `buildFineClipEvidence(...)` only includes already selected candidates with `segment_id`, `asset_id`, candidate ref, role, source range, why, key frames, Marlin scene, and overlapping Marlin events (`runtime/agents/unified-editorial-agent.ts:609-636`).
- `buildFinePrompt(...)` includes current blueprint and selected clip evidence. It tells the model to use `search_footage` or `best_for_beat` for replacements, but this is only text in headless mode (`runtime/agents/unified-editorial-agent.ts:718-760`).

Normalizer/fallback:

- If Gemini is unavailable or fails, `fallbackSelects(...)` ranks raw segments using Marlin overlap confidence, peak analysis count, duration, and quality flags. It does not query Qwen or the DB (`runtime/agents/unified-editorial-agent.ts:921-993`).
- `normalizeRoughResult(...)` uses `compactSegmentsForSelects(...)` after the LLM response to validate/fill candidate data, but that is not retrieval and it does not add Qwen evidence (`runtime/agents/unified-editorial-agent.ts:1147-1192`).

## Current Tool Architecture

`runtime/tools/editorial-tools.ts` defines a real executable toolkit:

- `EDITORIAL_TOOL_DEFINITIONS` includes Marlin tools plus `search_footage`, `visual_search`, `similar_to`, `unused_footage`, and `best_for_beat` (`runtime/tools/editorial-tools.ts:57-144`).
- `createEditorialToolkit(projectDir, sourceMap)` returns tool objects with `execute(...)` functions (`runtime/tools/editorial-tools.ts:405-572`).
- `search_footage` delegates to `searchFootage(...)`, with DB auto-build fallback through `ensureSearchDatabase(...)` (`runtime/tools/editorial-tools.ts:307-337`, `runtime/tools/editorial-tools.ts:475-488`).
- `visual_search` requires `query_frame_path`; it runs `searchFootage(...)` as `mode: "visual"` or `mode: "multimodal"` when a text hint is present (`runtime/tools/editorial-tools.ts:491-503`).
- `similar_to` defaults to visual anchor search using the segment's `visual_representative` embedding, then falls back to text similarity if visual evidence is unavailable (`runtime/tools/editorial-tools.ts:506-545`).

The footage search backend already returns the evidence we need:

- Search result scores include `qwen_visual`, `qwen_text`, `embedding_matches`, `weights`, and unavailable channels (`runtime/tools/footage-search.ts:121-136`, `runtime/tools/footage-search.ts:1595-1610`).
- Search results expose `key_frame_path`, which prefers the matched visual embedding frame (`runtime/tools/footage-search.ts:1587-1614`).
- Hybrid text queries activate Qwen text-to-visual scoring when Qwen rows exist; the E2E report shows `qwen_visual` populated for Japanese text-to-visual queries (`reports/e2e-test-qwen-search-ena-promo.md:50-78`).
- Pure image/anchor visual search is also available and has heavier visual weighting (`reports/e2e-test-qwen-search-ena-promo.md:80-138`).

There is no production tool loop:

- `rg` found `createEditorialToolkit(...)` execution only in tests and prompt exposure, not in the canonical pipeline.
- Interactive mode returns prompt packets containing tool definitions, but does not execute tools itself (`runtime/agents/unified-editorial-agent.ts:763-844`).
- `scripts/editorial-agent-task.ts` interactive mode writes `04_plan/agent_tasks/*_pass.md` and expects an external/repo-side agent response file; it does not run tool calls (`scripts/editorial-agent-task.ts:252-367`).
- Headless mode calls `callGeminiJson(...)` once per pass through `completeJsonWithRetry(...)` (`runtime/agents/unified-editorial-agent.ts:847-882`, `runtime/agents/unified-editorial-agent.ts:1237-1244`, `runtime/agents/unified-editorial-agent.ts:1542-1549`).

Marlin on-demand pattern:

- Marlin tools are lazy. `ensureMarlinWorker(...)` constructs/reuses a worker per project and only starts real work when caption/find operations are called (`runtime/tools/marlin-tools.ts:156-173`).
- `marlinAnalyzeRange(...)` creates a cached range proxy under the project, prepares a Marlin proxy, runs caption, and maps events back to source time (`runtime/tools/marlin-tools.ts:76-145`, `runtime/tools/marlin-tools.ts:184-200`).
- The editorial toolkit resolves `asset_id` to a readable source path via the source map before calling Marlin (`runtime/tools/editorial-tools.ts:355-374`, `runtime/tools/editorial-tools.ts:411-472`).
- This pattern is good for optional, fail-open tools, but it is not a loop. It is a set of callable primitives.

## Critical Search Semantics

For Approach A, the safest deterministic call for brief-derived visual intent is:

```ts
searchFootage(projectDir, {
  query,
  semantic: query,
  mode: "hybrid",
  limit,
});
```

or the equivalent `search_footage` toolkit call.

Reason: `mode=visual` requires `image_query_path` or `visual_anchor`. Without one, `validateVisualInput(...)` marks the result empty and warns `visual mode requires image_query_path or visual_anchor` (`runtime/tools/footage-search.ts:581-615`). Hybrid text queries still score against Qwen visual rows when present, because text-query Qwen embedding types include `visual_representative` and `text_combined_qwen` (`runtime/tools/footage-search.ts:419-425`, `runtime/tools/footage-search.ts:1227-1240`, `runtime/tools/footage-search.ts:1358-1367`).

Use `mode=visual` only for:

- image-to-image: `image_query_path` points to an absolute, valid frame path under project-approved roots (`runtime/tools/footage-search.ts:618-655`).
- anchor similarity: `visual_anchor.segment_id` with a frame type such as `visual_representative` (`runtime/tools/footage-search.ts:599-604`, `runtime/tools/footage-search.ts:1423-1437`).

## Evaluation Matrix

| Approach | Value | Effort | Regression risk | Determinism | Approx. code | Fit |
| --- | --- | --- | --- | --- | ---: | --- |
| A. Pre-selection visual retrieval | High. Makes headless actually query Qwen before planning and gives LLM ranked visual evidence. | Low-medium. New helper plus prompt/input plumbing. | Low if fail-open and trace-only/prompt-only first. | High. Same queries from same brief and DB produce same evidence. | 250-450 LOC incl. tests | Best first step |
| B. Headless tool execution loop | High ceiling. Agent can adapt queries and inspect results. | High. Needs connector/tool protocol, loop runner, parser, trace, limits, tests. | Medium-high. More LLM turns, more non-determinism, larger token/cost surface. | Medium-low unless constrained to pseudo-tool JSON and low max turns. | 650-1,100 LOC incl. tests | Do later only if A is insufficient |
| C. Hybrid pre-selection + optional fine loop | Highest ceiling. Deterministic baseline plus adaptive refinement. | Highest. A plus a scoped loop or deterministic fine alternates. | Medium. Safer if the loop is fine-pass-only and disabled by default initially. | Medium-high for baseline, lower for optional loop. | 550-950 LOC incl. tests | Good target architecture, not first patch |

## Approach A: Pre-selection Visual Retrieval

Concrete design:

1. Add a small visual retrieval helper, for example `runtime/agents/visual-retrieval-evidence.ts` or `runtime/tools/brief-visual-retrieval.ts`.
2. Input: `projectDir`, `brief`, optional `sourceMap`, `limitPerQuery`.
3. Derive queries from:
   - `brief.must_have` items that contain visual intent, especially `Qwen3-VL visual search priority: ...`.
   - `brief.editorial.policy_hint` when it explicitly names visual search priorities.
   - Optionally `context_knowledge.subjects/key_items/location` for query expansion, but keep phase 1 conservative.
4. For text visual intent, call `search_footage` or `searchFootage` with `mode: "hybrid"` and `semantic: query`.
5. Keep top 5-8 results per query. Deduplicate by `segment_id`, retaining the best `qwen_visual` or final score.
6. Format a compact prompt block:

```json
{
  "visual_retrieval_evidence": [
    {
      "query_id": "must_have_01",
      "query": "warm natural light, soft indoor light, skin and food texture",
      "mode": "hybrid",
      "results": [
        {
          "segment_id": "SEG_AST_...",
          "asset_id": "AST_...",
          "src_in_us": 0,
          "src_out_us": 3000000,
          "summary": "...",
          "scores": {
            "qwen_visual": 0.852,
            "qwen_text": 0.833,
            "e5_text": 0.909,
            "final": 0.867
          },
          "matched_frame_path": "03_analysis/frames/.../representative.jpg",
          "evidence_refs": ["summary: ...", "marlin_event: ..."]
        }
      ],
      "warnings": []
    }
  ]
}
```

7. Inject that block into `buildRoughPrompt(...)` after the creative brief and before the full Marlin asset evidence.
8. Write a non-canonical trace, for example `04_plan/visual_search_trace.json`, containing query text, tool/search input, warnings, result ids, scores, matched frames, and later selected linkage if enrichment is added.
9. Optional but recommended: after `normalizeRoughResult(...)`, append deterministic evidence strings to selected candidates when their `segment_id` appeared in visual retrieval results:
   - `Qwen visual retrieval: query=... qwen_visual=0.852 final=0.867 matched_frame=...`
   This uses existing `candidate.evidence` and does not require schema changes.

Files likely to change:

- `scripts/editorial-pipeline.ts`: call retrieval after representative frames and before `roughCutPlanning(...)`; write trace. Roughly 25-50 LOC.
- `runtime/agents/unified-editorial-agent.ts`: extend `RoughCutPlanningInput` with optional visual evidence and add a prompt section; optionally enrich selected candidate evidence after normalization. Roughly 50-100 LOC.
- New helper under `runtime/agents/` or `runtime/tools/`: query extraction, execution, compact formatting, trace shaping. Roughly 120-220 LOC.
- Tests:
  - `tests/unified-editorial-agent.test.ts` for prompt injection and no-change behavior when no evidence.
  - new or extended visual retrieval helper tests with mocked `searchFootage`.
  - maybe `tests/editorial-pipeline.test.ts` if pipeline call plumbing is testable.

Backward compatibility:

- Can be fail-open: if DB missing, Qwen unavailable, search warns, or no visual priorities exist, inject nothing or inject warnings only.
- Existing no-API-key behavior remains, because retrieval is local and `roughCutPlanning(...)` can still fallback deterministically if Gemini is absent.
- No canonical schema change is needed. Search evidence can live in prompt, `candidate.evidence`, and sidecar trace.

Risks:

- Prompt grows. Mitigate by top-N per query, dedupe, and cap total injected rows, e.g. 30-40.
- LLM may still ignore evidence. Mitigate by deterministic candidate evidence enrichment and a trace-based test.
- Query extraction can be noisy. Start with explicit `Qwen3-VL visual search priority:` lines and do not over-parse every must-have.

## Approach B: Headless Tool Execution Loop

Concrete design:

1. Add a headless tool runner that receives tool calls, validates tool names/params against `createEditorialToolkit(...)`, executes, and appends results to conversation state.
2. Add a model protocol:
   - Native Gemini function calling would require extending `runtime/connectors/gemini-json.ts` to send function declarations/tools and parse function-call parts.
   - A pseudo-tool JSON protocol could ask Gemini to return either `{ "tool_calls": [...] }` or final JSON, but this is brittle and model-dependent.
3. Add max-turn and max-tool-call limits, e.g. 3 turns rough / 2 turns fine, 8 tool calls total.
4. Add a trace artifact for every call/result/warning.
5. Modify `roughCutPlanning(...)` and `fineCutRefinement(...)` to accept `projectDir` and `sourceMap` or a ready toolkit in headless mode.

Files likely to change:

- `runtime/connectors/gemini-json.ts`: native function calling or explicit multi-turn content support. Roughly 120-250 LOC.
- `runtime/agents/unified-editorial-agent.ts`: loop integration and prompt/protocol changes. Roughly 150-300 LOC.
- New `runtime/agents/editorial-tool-loop.ts` or similar. Roughly 150-250 LOC.
- `scripts/editorial-pipeline.ts`: pass `projectDir`/`sourceMap`, configure loop, write trace. Roughly 30-60 LOC.
- Tests with mocked LLM returning tool calls, malformed calls, and final JSON. Roughly 250-400 LOC.

Backward compatibility:

- Possible if gated behind an option/env and if no-key still falls back to deterministic planning.
- Riskier if enabled by default, because outputs become multi-call and query-adaptive.

Risks:

- The current connector is single-shot JSON only (`runtime/connectors/gemini-json.ts:51-122`).
- More Gemini calls increase latency, rate-limit exposure, and costs.
- Debugging gets harder unless the trace is mandatory and compact.
- Headless planning becomes less reproducible than deterministic retrieval.

## Approach C: Hybrid

Concrete design:

1. Implement Approach A as the default rough-pass baseline.
2. Add fine-pass-only optional search refinement:
   - deterministic variant: for weak selected clips or missing must-have categories, run `similar_to` or `best_for_beat` before `buildFinePrompt(...)` and inject alternates.
   - loop variant: allow only `search_footage`, `similar_to`, and `best_for_beat` in a max-2-turn fine-pass loop.
3. Keep rough pass deterministic; reserve adaptive calls for replacement and refinement after there is already a candidate pool.

Files likely to change:

- All Approach A files.
- Additional fine-pass evidence input in `FineCutRefinementInput`.
- Optional tool loop files if choosing the loop variant.

Backward compatibility:

- Strong if the fine loop is opt-in initially, e.g. `--headless-tool-loop fine` or env flag.
- Better than B because rough selection remains reproducible.

Risks:

- More implementation effort than current need.
- Two retrieval mechanisms may create confusing traces unless the trace schema is designed once up front.

## Recommended Implementation Sketch

Recommended phase 1: Approach A with C-compatible trace.

Data flow:

```text
creative_brief.must_have
  |
  |-- extract explicit visual priorities
  |-- build search queries
  |
  |-- createEditorialToolkit(projectDir, sourceMap)
  |     or direct searchFootage(projectDir, ...)
  |
  |-- search_footage({ query, semantic: query, mode: "hybrid", limit })
  |
  |-- VisualRetrievalEvidence[]
        |
        |-- write 04_plan/visual_search_trace.json
        |-- inject into buildRoughPrompt(...)
        |-- optional candidate.evidence enrichment after normalizeRoughResult(...)
```

Suggested interfaces:

```ts
interface VisualRetrievalEvidence {
  query_id: string;
  source: "brief.must_have" | "brief.editorial.policy_hint";
  query: string;
  mode: "hybrid" | "visual" | "multimodal";
  results: Array<{
    segment_id: string;
    asset_id: string;
    src_in_us: number;
    src_out_us: number;
    summary: string;
    score: number;
    score_breakdown: {
      qwen_visual?: number;
      qwen_text?: number;
      e5_text?: number;
      lexical?: number;
      final: number;
    };
    matched_frame_path?: string;
    matched_embedding_type?: string;
    evidence_refs?: unknown[];
    tags?: string[];
  }>;
  warnings: string[];
}
```

Prompt rules to add:

- Treat `visual_retrieval_evidence` as ranked evidence, not as mandatory selection.
- Prefer candidates that satisfy both brief intent and strong Qwen visual evidence.
- When selecting a retrieved segment, cite the query id and `qwen_visual` score in `candidate.evidence`.
- Do not invent scores or use segment ids outside the supplied segment/search evidence.

Trace:

- Write `04_plan/visual_search_trace.json`.
- Keep it non-canonical and derived.
- Include:
  - project id
  - timestamp
  - query extraction source
  - exact search input
  - warnings
  - result ids/scores/frames
  - selected linkage after rough pass if enrichment is implemented

CLI/config:

- Default can be enabled when a ready/stale DB exists and fail-open when it does not.
- Add `--skip-visual-retrieval` if old behavior must be exactly reproducible.
- Do not add schema fields unless later evidence proves `candidate.evidence` and sidecar traces are insufficient.

## Test Plan

Unit tests:

1. Query extraction:
   - Given must-have items with `Qwen3-VL visual search priority: ...`, extract stable query ids and clean query text.
   - Ignore non-visual production directives unless explicitly tagged.
2. Retrieval execution:
   - Mock `searchFootage` or toolkit `search_footage`.
   - Verify text visual priorities call `mode: "hybrid"` with `semantic: query`, not invalid `mode: "visual"` without an image/anchor.
   - Verify warnings are preserved and fail-open.
3. Prompt injection:
   - Existing rough prompt remains unchanged when no evidence is provided.
   - With evidence, prompt includes `visual_retrieval_evidence`, `qwen_visual`, `matched_frame_path`, and query ids.
4. Candidate enrichment:
   - If selected candidate id appears in retrieval results, append evidence using existing `candidate.evidence`.
   - If not selected, do not mutate unrelated candidates.
5. Existing interactive prompt tests:
   - Keep tool definitions in interactive prompts unchanged.

Integration tests:

1. Mocked headless rough pass:
   - Run `roughCutPlanning(...)` with visual evidence and mocked Gemini.
   - Assert Gemini prompt includes Qwen evidence.
   - Assert fallback still works when Gemini is absent.
2. Pipeline plumbing:
   - Use a temp project with a mocked/stubbed search result or small DB.
   - Run `runEditorialPipeline({ skipRender: true })`.
   - Assert trace file is written when retrieval runs.
   - Assert no trace or trace warnings when DB is missing/unavailable.

E2E verification on `projects/ena-promo-ai`:

1. Rebuild or verify `03_analysis/search/footage.db` is ready with Qwen counts.
2. Run:

```bash
DOTENV_CONFIG_PATH=.env.local NODE_OPTIONS="-r dotenv/config" \
  npx tsx scripts/editorial-pipeline.ts --project projects/ena-promo-ai --skip-render
```

3. Verify:
   - `04_plan/visual_search_trace.json` exists.
   - Trace has at least one `search_footage` query from a visual must-have.
   - Trace results include non-null `qwen_visual` and `matched_frame_path`.
   - `selects_candidates.yaml` has selected candidate evidence citing Qwen retrieval if enrichment is implemented.
   - `validate-schemas` still passes.
   - Compile still produces `05_timeline/timeline.json`.

Regression tests:

```bash
npx vitest run tests/unified-editorial-agent.test.ts tests/editorial-tools.test.ts tests/editorial-tools-visual.test.ts tests/footage-search-qwen.test.ts
npx tsc --noEmit
```

For final acceptance, compare the new observation report against the previous one:

- Previously: `visual_search`: 0, `search_footage mode=visual`: 0, `similar_to`: 0, `qwen_visual` evidence: 0.
- After Approach A: expected nonzero search trace entries and nonzero `qwen_visual` values in the trace; optional nonzero `qwen_visual` evidence in selected candidates.

