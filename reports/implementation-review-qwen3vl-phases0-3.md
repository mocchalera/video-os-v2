# Implementation Review: Qwen3-VL Multimodal Search Phases 0-3

Date: 2026-06-19

## Summary Verdict

Verdict: **block**.

The implementation compiles and the full Vitest suite passes, but it does not satisfy the design contract in two central areas: Section 10 score fusion and Section 7 image path validation. Those are not style issues. They affect ranking correctness, backward compatibility when Qwen query embedding is unavailable, score explanations, and project-local security boundaries.

Storage is mostly aligned with Section 5, the worker/connector shape is mostly aligned with Section 8, and the implementation is additive/read-only where expected. The current tests cover many happy/fallback paths, but several tests assert behavior that contradicts the design.

## Verification

- `npx tsc --noEmit`: **passed**.
- `npx vitest run`: **passed**. Summary: 125 test files passed, 4 skipped; 2279 tests passed, 39 skipped; duration 100.35s.

## Design Alignment Checklist

| Area | Status | Notes |
| --- | --- | --- |
| Section 5 DDL | Matched | `embedding_models` and `segment_embeddings` names, columns, CHECK constraints, indexes, and FK shape match the target DDL in `runtime/artifacts/footage-db-builder.ts:711`. |
| Section 5 migration | Mostly matched | E5 rows are dual-written into legacy `embeddings` and new `segment_embeddings` with preserved `content_hash` in `runtime/artifacts/footage-db-builder.ts:1299`. Legacy search fallback is preserved when new tables are absent. |
| Section 5 build report/status | Partially matched | `embedding_counts` and `embedding_statuses` exist, but aggregate `embedding_status` ignores Qwen readiness and stays tied to E5 status in `runtime/artifacts/footage-db-builder.ts:1485`. |
| Section 7 TypeScript API | Partially matched | Modes, `image_query_path`, `visual_anchor`, and basic score fields exist. Missing or divergent pieces: `qwen_mixed`, required `segment_embedding_id`, project-local image validation, visual anchor existence/default fallback. |
| Section 8 worker protocol | Mostly matched | JSONL methods and response decoding are present. The smoke gate and worker validation are incomplete for extension/failure/batch timing coverage. |
| Section 10 score fusion | Mismatched | Current weights, channels, fallback redistribution, and Qwen-absent handling do not match the contract. |
| Section 12/13 agent tools | Partially matched | Tool adapters are read-only and pass flat params. Rough-pass prompt does not expose visual retrieval tools; fine-pass does. |

## High Findings

### H1. Score fusion does not implement Section 10 and can change legacy behavior when Qwen query embedding is unavailable

Section 10 requires exact weights for Qwen-absent, Qwen-present text, image-only, and mixed queries, plus a fallback rule that redistributes missing Qwen-channel weight only across retrieval channels. The implementation uses two custom weight maps with a non-contract `structured` channel and never includes `qwen_text` in fusion: `runtime/tools/footage-search.ts:1588`.

Examples:

- Text Qwen-present contract is `0.35 qwen_visual + 0.10 qwen_text + 0.25 semantic + 0.15 lexical + 0.10 quality + 0.05 peak`; implementation uses `0.30 e5_text + 0.25 qwen_visual + 0.25 lexical + 0.10 quality + 0.05 peak + 0.05 structured` in `runtime/tools/footage-search.ts:1612`.
- Mixed text+image contract without native mixed rows is `0.55 qwen_visual + 0.15 semantic + 0.15 lexical + 0.10 quality + 0.05 peak`; implementation uses the visual-query map with `e5_text: 0.10` and `structured: 0.05` in `runtime/tools/footage-search.ts:1603`.
- Image-only contract is `0.80 qwen_visual + 0.12 quality + 0.05 peak + 0.03 duration`; implementation starts from the mixed visual map and redistributes unavailable channels via `weightedScore` in `runtime/tools/footage-search.ts:1672`.
- If stored Qwen rows exist but the Qwen query worker fails, `qwen.present` remains true and `finalScore` does not use the exact legacy formulas, even though the design says entirely unavailable Qwen channels must preserve current scoring. See `runtime/tools/footage-search.ts:731` and `runtime/tools/footage-search.ts:787`.

Tests currently encode the wrong weights instead of the design weights in `tests/footage-search-qwen.test.ts:125` and `tests/footage-search-qwen.test.ts:193`, so the green suite is not evidence of contract alignment.

### H2. `text_combined_qwen` scores are conflated into `qwen_visual`, while `qwen_text` is ignored by ranking

For text queries, `QWEN_TEXT_QUERY_EMBEDDING_TYPES` includes both `visual_representative` and `text_combined_qwen` in `runtime/tools/footage-search.ts:415`. During scoring, `text_combined_qwen` sets `qwenText`, but the same score is also folded into `qwenVisual` whenever `textQuery` is true in `runtime/tools/footage-search.ts:1264`.

That makes score breakdowns misleading: a text row can appear as visual evidence. The final scorer then receives only `qwenVisual` in `runtime/tools/footage-search.ts:787`, so `qwen_text` is reported but has no ranking weight. This violates the Section 10 rule that `qwen_text` is a separate score against `text_combined_qwen` and must not replace E5 without fixtures.

### H3. `image_query_path` is not constrained to project-local files

The design requires `image_query_path` to be absolute, readable, a regular file, under the project root or an approved project-local derived frame directory, and to reject symlinks resolving outside the project. The search validator only checks absolute path, extension, and existence in `runtime/tools/footage-search.ts:585`.

The worker also accepts any absolute readable image file, with no project-root policy, in `python/qwen3vl_embedding_worker.py:375`. Tool adapters pass caller-provided paths through directly in `runtime/tools/editorial-tools.ts:491`.

This is a security/privacy boundary violation: an agent/tool caller can cause local image files outside the project to be opened and embedded.

## Medium Findings

### M1. Frame cache freshness ignores source identity and timestamp changes

The design says frame cache staleness is based on source hash, timestamp, preprocess version, and output frame hash. The cache reuse check only compares the current output file hash and preprocess version in `runtime/artifacts/footage-db-builder.ts:1721`. If `rep_frame_us`, source media, or source fingerprint changes while the cached JPEG remains, stale visual embeddings can be reused.

Related: `segments.filmstrip_path` is used directly as an image source in `runtime/artifacts/footage-db-builder.ts:1692`, but the design allows filmstrip usage only if it can be mapped to a representative source frame. Embedding a montage/filmstrip as a representative frame can poison visual retrieval.

### M2. Aggregate `embedding_status` is not the conservative multimodal aggregate required by the contract

The design says `embedding_status` remains as a compatibility alias and should be `ready` when at least one retrieval channel is ready. `mergeEmbeddingResults` returns `status: e5.status` regardless of Qwen status in `runtime/artifacts/footage-db-builder.ts:1485`.

That misreports Qwen-only or Qwen-success/E5-unavailable builds as `skipped` or `unavailable`, even when `embedding_statuses.qwen_visual` or `qwen_text` is `ready`.

### M3. Phase 0 smoke gate is incomplete against Section 9 acceptance

The smoke script exercises real text, image, and mixed requests in `scripts/smoke-test-qwen3vl.sh:177`, but it does not cover mock-mode worker start, CPU fallback, batch timing for 1/4/16 frames, failure-mode mapping, or `embed_batch`. Those are explicit Phase 0 acceptance items.

The worker validates image readability but not the allowed extension list in `python/qwen3vl_embedding_worker.py:375`, so direct connector/worker use can accept image types outside the v1 contract.

### M4. Rough-pass interactive prompts do not expose visual retrieval tools

Section 12 says rough pass should use text-to-visual discovery for mood, lighting, texture, and visual tone. The fine-pass interactive prompt includes the tool section and `tools: EDITORIAL_TOOL_DEFINITIONS` in `runtime/agents/unified-editorial-agent.ts:821`, but the rough-pass interactive prompt returns only frame-read instructions and no tools in `runtime/agents/unified-editorial-agent.ts:777`.

## Low Findings

### L1. Score breakdown shape has non-contract and missing fields

`FootageScoreBreakdown` includes a non-contract `structured` field and omits `qwen_mixed` in `runtime/tools/footage-search.ts:121`. `SearchEmbeddingMatch.segment_embedding_id` is optional in `runtime/tools/footage-search.ts:112`, while the design shape makes it part of each match. The tool-level `score_breakdown` alias also drops `qwen_text`, weights, and embedding matches in `runtime/tools/editorial-tools.ts:289`.

### L2. Builder still calls `Date.now()`

Population timestamps use injected `now`, but the builder still calls `Date.now()` for the temporary DB path in `runtime/artifacts/footage-db-builder.ts:767`. This does not affect `created_at`, but the review criteria asked for injected `now` and never `Date.now()`.

### L3. Worker/connector error-code set diverges from the design

The connector adds `dependency_missing` to the public error-code union in `runtime/connectors/qwen3vl-embedding-local.ts:13`, while Section 8 lists `model_not_found`, `mps_unavailable`, `oom`, `invalid_input`, `timeout`, and `worker_crash`. This is useful operationally, but it is not the documented protocol unless the design is updated.

## Test Coverage Assessment

Covered well:

- Connector mock text/image/batch, timeout, worker error, crash restart, and shutdown paths.
- Storage DDL presence, E5 migration/dual writes, corrupt vector skip warnings, legacy fallback when new tables are absent.
- Qwen build happy path, reuse path, and worker-unavailable degradation.
- Agent adapter mapping for `search_footage`, `visual_search`, and `similar_to`.

Coverage gaps:

- Section 10 exact fusion weights are not tested; current tests assert non-contract weights.
- No test for Qwen rows present but query worker unavailable preserving legacy exact formulas.
- No test that `text_combined_qwen` contributes only to `qwen_text`, not `qwen_visual`.
- No project-root, realpath, symlink-escape, or regular-file tests for `image_query_path`.
- No stale-frame invalidation test for changed timestamp/source fingerprint.
- No Qwen-only aggregate `embedding_status` test.
- No test for worker allowed image extensions or Phase 0 batch timing/failure-code smoke output.
- No visual-anchor segment-existence test or default fallback from `visual_representative` to `visual_keyframe_peak`.

## Cross-Phase Consistency Check

- Phase 1A DDL and Phase 2 reader agree on table and column names for `embedding_models`, `segment_embeddings`, `visual_representative`, and `text_combined_qwen`.
- Phase 1B Qwen writer and Phase 2 reader agree on 2048-dimension `Float32Array` BLOBs; Qwen writes explicit little-endian bytes in `runtime/artifacts/footage-db-builder.ts:1976`, and the reader validates byte length/finiteness/norm in `runtime/tools/footage-search.ts:1112`.
- Phase 0 connector signatures are compatible with Phase 1B build usage (`embedBatch`) and Phase 2 query usage (`embedText`, `embedImage`).
- Phase 2 and Phase 3 score shapes are only partially consistent: core search exposes `qwen_text`, but ranking ignores it; tool aliases drop it.
- Image path policy is inconsistent across phases: adapters pass arbitrary strings, search validates only existence/extension, and the Python worker validates only absolute readable images.

## Recommendations

1. Replace `finalScore` with a Section 10 implementation that includes `qwen_text` and future `qwen_mixed`, removes the `structured` channel from Qwen fusion, applies the exact image-only and mixed weights, and redistributes missing Qwen-channel weight only across available retrieval channels.
2. Treat Qwen as absent for fusion when query embedding fails or no Qwen query channel is available, even if stored Qwen rows exist. Preserve the legacy formulas exactly in that case.
3. Split Qwen scoring by embedding type: only visual embedding types should update `qwen_visual`; `text_combined_qwen` should update only `qwen_text`.
4. Harden `image_query_path` validation with `fs.realpathSync`, project-root/approved-frame-dir checks, regular-file checks, extension checks, and symlink escape rejection. Add direct tests for each rejection path.
5. Fix frame cache freshness to compare source fingerprint/path, source timestamp, preprocess version, and output hash. Do not use filmstrip images unless they are mapped to the representative source frame.
6. Compute aggregate `embedding_status` from all retrieval channels per the contract.
7. Extend Phase 0 smoke coverage for mock mode, CPU fallback, `embed_batch`, 1/4/16 frame timing, and documented error codes.
8. Either expose search tools in rough-pass interactive prompts or update the design to limit Qwen visual retrieval to fine-pass replacement workflows.
