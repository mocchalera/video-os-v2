# Design Review: Qwen3-VL Unified Multimodal Search v2

## Summary Verdict

Verdict: **approve-with-changes**.

`docs/design-multimodal-qwen3vl-unified.md` substantially addresses the v1 review. The storage contract is now concrete, the TypeScript API is no longer deferred, the Python JSONL worker is specified, Phase 0 is mandatory, reranking is explicitly deferred, and project-local/no-remote constraints are repeated.

The design is consistent with the current architecture: Marlin remains the temporal/visual evidence source, Qwen is positioned as retrieval only, Claude/Codex remains the planner, and existing SQLite/FTS/E5 behavior is intended to remain additive and fail-open.

The remaining issues are implementation-contract gaps, not architectural blockers. Phase 0 can be implemented from this document. Phase 1 is close, but the build report/status shape should be made exact before implementation. Phase 2/3 need fallback and continuity API clarifications before they are safe to code.

## v1 Findings Resolution Checklist

| Finding | Status | Evidence |
| --- | --- | --- |
| H1: concrete `segment_embeddings` DDL and migration path | Addressed | v2 defines additive `embedding_models` and `segment_embeddings` DDL plus legacy copy SQL at `docs/design-multimodal-qwen3vl-unified.md:224-358`. This directly resolves the current `embeddings` table limits in `runtime/artifacts/footage-db-builder.ts:538-559`. |
| H2: concrete `SearchFootageInput` extension, backward compatibility, fallback rules | Partially addressed | v2 adds `visual`/`multimodal`, `image_query_path`, `visual_anchor`, score breakdown fields, validation, flat adapter params, and compatibility rules at `docs/design-multimodal-qwen3vl-unified.md:388-501`. Remaining contradictions are listed in new findings M1/M2. |
| H3: Python worker JSONL protocol, schemas, error codes, dependencies | Addressed | v2 defines files, command, env vars, dependencies, request/response JSONL, error codes, timeout policy, and cache policy at `docs/design-multimodal-qwen3vl-unified.md:503-643`, aligned with the current Marlin worker/client pattern in `python/marlin_worker.py:106-147` and `runtime/connectors/marlin-local.ts:111-172`. |
| M1: score fusion compatible with current weights when Qwen absent | Addressed | v2 copies the current scorer formulas at `docs/design-multimodal-qwen3vl-unified.md:743-825`, matching `runtime/tools/footage-search.ts:944-960`. |
| M2: `embedding_models` fields expanded beyond name/version/modality/dimensions | Addressed | v2 tracks model revision, output dimension, input modality, instruction, preprocess version, runner, precision, normalization, metric, and license at `docs/design-multimodal-qwen3vl-unified.md:231-260` and `docs/design-multimodal-qwen3vl-unified.md:367-386`. |
| M3: Phase 0 smoke-test gate | Addressed | v2 makes Phase 0 mandatory and gives acceptance criteria at `docs/design-multimodal-qwen3vl-unified.md:647-663` and `docs/design-multimodal-qwen3vl-unified.md:928-939`. |
| M4: frame extraction/cache path | Addressed | v2 defines cache path, filenames, priority, ffmpeg shape, manifest fields, and missing-source handling at `docs/design-multimodal-qwen3vl-unified.md:679-741`. |
| M5: reranker explicitly deferred | Addressed | v2 keeps reranking out of Phase 1 and requires a Phase 4 spike at `docs/design-multimodal-qwen3vl-unified.md:141-145`, `docs/design-multimodal-qwen3vl-unified.md:987-1005`, and `docs/design-multimodal-qwen3vl-unified.md:1047`. |
| M6: external API constraint explicit | Addressed | v2 states no remote embedding/reranking API in the header and constraints at `docs/design-multimodal-qwen3vl-unified.md:3-7` and `docs/design-multimodal-qwen3vl-unified.md:1037-1045`; cache warming is opt-in only at `docs/design-multimodal-qwen3vl-unified.md:638-643`. |
| L1: deterministic `created_at` | Addressed | v2 requires builder-injected `indexedAt`/`now` at `docs/design-multimodal-qwen3vl-unified.md:300-308` and `docs/design-multimodal-qwen3vl-unified.md:1044`, matching the current builder pattern at `runtime/artifacts/footage-db-builder.ts:597-603`. |
| L2: Japanese evaluation fixtures | Addressed | v2 requires Japanese fixtures before reliability claims and defines fixture categories at `docs/design-multimodal-qwen3vl-unified.md:1046-1059`. |
| L3: privacy/project-local scope | Addressed | v2 repeats project-local/no external reporting constraints at `docs/design-multimodal-qwen3vl-unified.md:1035-1045`. |

## New Findings

### High

None.

### Medium

#### M1. Image-only fallback behavior contradicts the score-fusion fallback rule

v2 correctly says an image-only request without visual embeddings should return no results with a warning rather than pretending text search was visual search (`docs/design-multimodal-qwen3vl-unified.md:493-500`). But the generic score fallback rule later says that when no retrieval channels are available, the implementation should use the structured-only formula (`docs/design-multimodal-qwen3vl-unified.md:817-823`).

That is unsafe for image-only visual search. The current fallback scorer will rank rows by quality/peak/duration when no lexical or semantic score exists (`runtime/tools/footage-search.ts:944-960`, `runtime/tools/footage-search.ts:1014-1068`). If `visual` mode is added without an explicit image-only guard, a missing Qwen channel could return high-quality clips that never matched the image.

Recommendation: add a precedence rule: for `mode: "visual"` with no text and no valid `image_query_path`/anchor embedding, return `[]` with a warning before structured-only scoring. Reserve structured-only fallback for explicitly structured queries or text/multimodal queries where at least one non-visual retrieval channel exists.

#### M2. Continuity search is described, but the API can represent only one visual anchor

v2 defines bridge/continuity scoring as similarity to both sides of a cut (`docs/design-multimodal-qwen3vl-unified.md:207-215`) and the QA loop asks for before/after frames (`docs/design-multimodal-qwen3vl-unified.md:890-899`). The TypeScript contract and flat adapter expose only one `image_query_path` and one `visual_anchor` (`docs/design-multimodal-qwen3vl-unified.md:414-430`, `docs/design-multimodal-qwen3vl-unified.md:476-489`).

That is enough for similarity, palette, shot-scale, and one-anchor replacement, but not enough to implement the stated continuity formula without inventing an unreviewed second parameter.

Recommendation: either defer continuity to a later API phase, or add an explicit bounded multi-anchor shape, for example `image_query_paths?: [string] | [string, string]` and/or `visual_anchors?: [FootageVisualAnchor] | [FootageVisualAnchor, FootageVisualAnchor]`, with a named scoring rule for before/after queries.

#### M3. Phase 1 build report/status additions are not yet copy-pasteable

v2 requires report counts for `e5_text`, `qwen_text`, `qwen_visual`, `qwen_mixed`, and `qwen_reranker` (`docs/design-multimodal-qwen3vl-unified.md:380-386`) and repeats that Phase 1 acceptance depends on these statuses (`docs/design-multimodal-qwen3vl-unified.md:950-955`). The current builder result has only `counts.embeddings` and scalar `embedding_status` (`runtime/artifacts/footage-db-builder.ts:31-50`), populated as a single count/status at `runtime/artifacts/footage-db-builder.ts:627-661`.

This is not a storage blocker, but it is not concrete enough for a developer to update the builder/report/tests without choosing a new schema.

Recommendation: define exact backward-compatible report fields before Phase 1, for example:

```ts
embedding_counts?: {
  e5_text: number;
  qwen_text: number;
  qwen_visual: number;
  qwen_mixed: number;
  qwen_reranker: number;
};
embedding_statuses?: {
  e5_text: "ready" | "skipped" | "unavailable" | "error";
  qwen_text: "ready" | "skipped" | "unavailable" | "error";
  qwen_visual: "ready" | "skipped" | "unavailable" | "error";
  qwen_mixed: "ready" | "skipped" | "unsupported" | "unavailable" | "error";
  qwen_reranker: "deferred" | "skipped" | "unavailable" | "error";
};
```

Keep current `counts.embeddings` and `embedding_status` as compatibility aliases until existing consumers are migrated.

### Low

#### L1. Image-only calls should define whether `query` is optional or explicitly empty

The API calls out image-only search (`docs/design-multimodal-qwen3vl-unified.md:77-85`), but the proposed `SearchFootageInput` still requires `query: string` (`docs/design-multimodal-qwen3vl-unified.md:414-421`), matching the current text-first contract in `runtime/tools/footage-search.ts:82-92`.

Recommendation: state one rule explicitly: either make `query?: string` for visual/image-only mode, or require `query: ""` for image-only calls and ensure the flat adapter normalizes missing query text to an empty string.

#### L2. Legacy `content_hash` migration does not match the new hash semantics

v2 says `content_hash` is over normalized text/frame bytes/mixed payload plus `preprocess_version` (`docs/design-multimodal-qwen3vl-unified.md:300-308`), but the legacy migration copies `e.content_hash` directly (`docs/design-multimodal-qwen3vl-unified.md:330-354`). Current E5 `content_hash` is computed from normalized text only (`runtime/artifacts/footage-db-builder.ts:1061-1067`).

Recommendation: either revise the field semantics to say legacy copied rows keep their original content hash and rely on `embedding_models.preprocess_version` for comparability, or recompute the migrated hash with the new hash recipe.

## Implementation Readiness Assessment

Phase 0: **ready**. The document is specific enough to implement a mock/real Python worker, TS connector, dependency file, local cache policy, timeout behavior, and smoke-test report. The exact `torch` pin is intentionally left to the smoke test, which is appropriate.

Phase 1 storage: **mostly ready**. The DDL is concrete and fits the current additive derived-DB approach. It should be copied into the builder after the existing `segments` table exists. The current `embeddings` table can remain for compatibility while `segment_embeddings` is introduced. Add model-row upsert/retrieval code rather than relying on the illustrative `@e5_model_id` placeholder alone.

Phase 1 frame extraction: **ready enough for representative frames**. The cache path, source priority, ffmpeg shape, manifest fields, and warning behavior are specific enough to implement. The first implementation should restrict itself to `visual_representative` before keyframes/mixed rows.

Phase 1 report/status: **needs one design patch**. Define exact `BuildFootageDbResult` and report JSON additions before coding.

Phase 2/3 search/API: **needs clarification before coding**. Fix the image-only fallback precedence and either defer or formalize multi-anchor continuity search.

## Recommendations

1. Make the three Medium findings explicit in the design before Phase 1/2 implementation.
2. Implement Phase 0 first with mock mode, real local-cache mode, MPS/CPU behavior, vector norm checks, and peak RSS/timing output.
3. In Phase 1, add `embedding_models` and `segment_embeddings` without removing the current `embeddings` reader. Prefer new-table reads only when the new tables and model rows exist; otherwise keep the current E5 path unchanged.
4. Keep initial visual indexing to `visual_representative` and `text_combined_qwen`. Add in/peak/out and mixed rows only after the first retrieval fixtures justify the added build cost.
5. Add tests around the exact failure modes: missing Qwen cache, unreadable image path, image-only with no visual embeddings, corrupted BLOB length, and legacy E5-only DB fallback.
