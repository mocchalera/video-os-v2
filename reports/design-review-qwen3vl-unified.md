# Design Review: Qwen3-VL Unified Multimodal Search

Reviewed: `docs/design-multimodal-qwen3vl-unified.md`
Date: 2026-06-19
Verdict: **approve-with-changes**

The design is directionally consistent with the repo architecture: Marlin remains the visual reporter, Claude/Codex remains the editorial planner, and Qwen3-VL is positioned as a derived retrieval layer. It is also correctly additive in intent: SQLite/FTS/E5 search stays available, canonical planning artifacts are not rewritten, and Qwen3-VL failures should warn rather than break basic search.

Do not start implementation from this document as-is. The model choice is plausible, but the implementation contract is underspecified in three critical places: the SQLite embedding schema cannot currently store the proposed visual rows, the TypeScript image-query/search API is deferred even though the migration plan depends on it, and the Python worker bridge is not specified enough to integrate safely with the TypeScript builder/search stack.

## High Findings

### H1. Proposed Qwen embedding types do not fit the current `embeddings` table

Target doc lines 181-190 define `visual_representative`, `visual_keyframe_in`, `visual_keyframe_peak`, `visual_keyframe_out`, `text_combined_qwen`, and `mixed_representative`. Current DDL only allows `field IN ('summary', 'transcript', 'scene', 'combined')`, has a foreign key to `embedding_texts(segment_id, field)`, and keys rows by `(segment_id, field, model_id)` in `runtime/artifacts/footage-db-builder.ts:538-559`.

That means Phase 1 cannot insert any visual embedding rows without a schema change, and it cannot store multiple frame vectors per segment because there is no `source_ref`, `source_timestamp_us`, or `embedding_type`. The design mentions future `segment_embeddings` on lines 278-279, but does not define the actual additive DDL or migration path.

Required change: add a concrete storage contract before implementation. Either introduce a new `segment_embeddings` table with `embedding_type`, `model_ref`, `source_ref`, `source_timestamp_us`, `content_hash`, and vector metadata, or explicitly migrate `embeddings` to the broader prior-design shape. Keep existing E5 rows readable by current search.

### H2. Image-query API is deferred, but Phase 3 and the agent workflow require it

Target doc line 78 says `mode: "visual" | "multimodal"`, `image_query_path`, and `visual_anchor` are a future API change, not part of the document. Later, lines 453-462 require the agent to pass absolute frame paths, and lines 411-427 introduce `visual_search(...)`.

Current `SearchFootageInput` only supports `mode?: "hybrid" | "text" | "semantic" | "structured"` and text fields in `runtime/tools/footage-search.ts:13-92`. The editorial tool adapter is also flat/string-oriented today, so an image path needs a precise parameter and parsing story.

Required change: define the additive TypeScript contract in this design, not later. Include `image_query_path`, optional `visual_anchor_json` or flat helper params, allowed modes, validation rules, absolute/relative path resolution, and fallback behavior when the image path is unreadable or visual embeddings are missing.

### H3. Python worker bridge is not specified enough for a TypeScript-primary codebase

Target doc lines 284-291 choose Python + PyTorch + MPS as the first path, but the document does not define how TypeScript invokes it. The repo currently has a Python worker pattern for Marlin (`python/marlin_worker.py`) and TypeScript connectors, while E5 is fully in-process through `@huggingface/transformers` (`runtime/eval/semantic-match.ts:44-134`).

Qwen's own usage path is not a simple installed Transformers.js pipeline. The official Qwen repository shows a Python `Qwen3VLEmbedder` class from its repo source and model download/setup steps; the Hugging Face model card confirms mixed-modal input and 2048 dimensions, but not a repo-local Node runner. See:

- https://huggingface.co/Qwen/Qwen3-VL-Embedding-2B
- https://github.com/QwenLM/Qwen3-VL-Embedding

Required change: specify the worker protocol before implementation: command name, venv path, Python dependency file, JSON request/response schema, batching, output vector encoding, model cache path, local-only mode, timeout behavior, stderr handling, exit codes, and how TypeScript maps worker failures to `qwen3vl_embedding_status`.

## Medium Findings

### M1. Score fusion needs to map onto the current scorer exactly

Target doc lines 124-148 propose weights for FTS, E5, Qwen visual, quality, peak, and structured boosts. Current code uses a fixed hybrid formula: `0.55 semantic + 0.30 lexical + 0.10 quality + 0.05 peak`, with fallback redistribution in `runtime/tools/footage-search.ts:946-961`.

The proposed weights are reasonable, but the design does not define normalization, per-mode fallback redistribution, or how `structured_boost` differs from hard SQL filters. Without that, Qwen scores can swamp or underweight existing lexical/E5 behavior.

Recommended change: define one concrete first-pass formula that preserves current behavior when Qwen is absent, then adds `qwen_visual` only when available. Include deterministic tie-breakers unchanged from the current search design.

### M2. Model registry is useful, but incomplete for reproducible embeddings

Target doc lines 244-258 add `embedding_models`, and lines 269-277 list model rows. This is the right direction, but the row is not enough to decide comparability. Qwen3-VL is instruction-aware, supports user-defined output dimensions, and can accept mixed modalities; those choices affect vectors.

Recommended change: track at least `model_revision`, `output_dimension`, `input_modality`, `instruction`, `preprocess_version`, `runner_name`, `runner_version`, `precision`, `normalized`, and `distance_metric`. Do not rely on a free-form `version` plus `quantization` string.

### M3. Local execution feasibility needs a smoke-test gate, not just estimates

Target doc lines 282-309 correctly say MPS must be smoke-tested. The memory estimate on line 306 is a reasonable lower bound, but incomplete: 2B fp16/bf16 weights are only the base, and runtime overhead, image preprocessing, framework allocations, and lack of FlashAttention on MPS can dominate.

Recommended change: make Phase 0 a required local smoke test before Phase 1. Acceptance should include model load, one text embedding, one image embedding, one mixed input if intended, vector length, normalization check, peak RSS, elapsed time for a small batch, and CPU fallback behavior.

### M4. Frame extraction/source rules are not implementable yet

Target doc lines 205-211 list frame source priority, but current artifacts do not guarantee durable image files for every segment. The builder has `segments.filmstrip_path` and visual appraisal `frame_path`, while Marlin stores interest point timestamps, not necessarily extracted frame files. Craft/editorial frames are often generated for selected clips, not the full segment pool.

Recommended change: define a deterministic frame cache path and extraction command for representative/in/peak/out frames, including handling for missing source media, rotation/color metadata, corrupt frames, and content hashing.

### M5. Reranker phase is too open-ended

Target doc lines 150-162 and 464-473 make the reranker optional and off by default, which is good. But there is no concrete input packing, timeout, benchmark threshold, cache key, or output schema. The line 161 note that the explanation is generated by the calling agent is also risky: the reranker should return a score only, while the search layer should expose evidence without inventing explanatory claims.

Recommended change: keep reranker out of the initial implementation and add a separate proof doc or spike before Phase 4.

### M6. External API constraint should be explicit in model setup

The design implies local execution, but it should explicitly carry forward the existing constraint that external API usage is VLM-only and embeddings/reranking must be repo-side/local. Current E5 builder controls remote model downloads through `allowRemoteEmbeddingModels` and `VIDEO_OS_ALLOW_REMOTE_EMBEDDING_MODELS` in `runtime/artifacts/footage-db-builder.ts:611-627`.

Recommended change: add a hard rule that Qwen model execution and embedding generation must not call a remote embedding API. Model download/cache warming can be an explicit setup step, not an implicit search/build side effect.

## Low Findings

### L1. `created_at` in model registry can create noisy rebuild diffs

Target doc line 257 includes `created_at`. That is fine for reports, but if model rows participate in source hashes or reproducibility checks, use the builder's injected `now` value and keep tests deterministic. Avoid adding new direct `Date.now()` or `Math.random()` usage in compiler/eval paths.

### L2. Japanese cross-language behavior needs explicit evaluation fixtures

The design names Japanese mood queries, which is correct, and Qwen's model card claims 30+ language support. Still, practical Japanese text-to-visual quality is not proven for this footage domain.

Add fixtures for Japanese mood/light/composition queries, English source evidence, image anchors, and false positives where visually similar clips are semantically wrong.

### L3. Privacy/reporting rules should be repeated

The derived DB may contain OCR/transcript text and frame paths. The unified footage DB design already treats this as project-local derived data; the Qwen design should repeat that Qwen embedding reports and model caches must not expose source media paths or text externally.

## Section Comments

- Lines 19-28: Good model positioning. Qwen is used as retrieval, not planning. Add a source note that the official model card says dimensions are user-defined from 64 to 2048 and instructions matter.
- Lines 47-67: Pipeline order matches the current SQLite-first design. Keep SQL/FTS before vectors.
- Lines 78 and 411-427: Contradiction. The search API extension cannot be both future/out-of-scope and required by the migration plan.
- Lines 105-123: Good build/search split. Add query embedding cache keys for text, image bytes/hash, model row id, output dimension, and instruction.
- Lines 124-148: Needs concrete compatibility with the current scorer and fallback redistribution.
- Lines 181-190: Embedding types are sensible editorially, but not compatible with current DDL.
- Lines 205-211: Frame priority is useful, but missing deterministic extraction/cache details.
- Lines 244-279: Model registry is the right addition. It needs stronger fields and an actual FK path from embedding rows.
- Lines 282-309: Correctly flags MPS as unverified. Promote this to a Phase 0 gate.
- Lines 311-319: Good fail-open build behavior. Add separate counts/statuses for `e5_text`, `qwen_text`, `qwen_visual`, `qwen_mixed`, and `qwen_reranker`.
- Lines 361-427: Agent integration is aligned with the two-model architecture and read-only tool boundary.
- Lines 431-484: Migration order is broadly correct, but Phase 1 is not safe until storage DDL and worker protocol are defined.
- Lines 486-498: Risks are relevant. Add corrupted embeddings, unreadable image files, worker crashes/timeouts, stale frame caches, and dimension mismatches.

## Missing Items To Add

1. Exact additive DDL for visual/multimodal embeddings.
2. TypeScript interfaces for visual/multimodal search input and output score breakdown.
3. Editorial tool parameter shape for image queries under the current flat tool adapter.
4. Python worker request/response JSON schema and invocation command.
5. Qwen dependency/setup file and model cache policy.
6. Deterministic frame extraction/cache path for representative and key frames.
7. Corrupt/missing vector handling: dimension mismatch, NaN values, zero vectors, unreadable BLOBs.
8. Local smoke-test acceptance before implementation.
9. Japanese text-to-visual evaluation fixtures.
10. Reranker timeout/cache/output schema, or an explicit statement that it is deferred pending a spike.

## Implementation Priority

1. **Phase 0: Qwen local spike only.** Prove model load and text/image embeddings on this Mac. Record vector dimensions, normalization, speed, memory, and dependency constraints.
2. **Phase 1A: Storage contract.** Add `embedding_models` plus a new visual-capable embedding table without touching existing E5 rows.
3. **Phase 1B: Build representative visual embeddings.** Use deterministic frame cache and fail-open status reporting.
4. **Phase 2: Search fusion.** Preserve current FTS/E5 behavior when Qwen is absent; add explicit `qwen_visual` score channel when present.
5. **Phase 3: Agent image-query tool.** Add absolute-frame-path search with evidence and warnings. Keep it read-only.
6. **Later: keyframes, mixed embeddings, reranker, Matryoshka tuning.** Do these only after representative-frame retrieval improves real edit decisions.

## Sources Checked

- Local design: `docs/design-multimodal-qwen3vl-unified.md`
- Current DB/search implementation: `runtime/artifacts/footage-db-builder.ts`, `runtime/tools/footage-search.ts`, `runtime/eval/semantic-match.ts`
- Current agent/Marlin surfaces: `runtime/agents/unified-editorial-agent.ts`, `runtime/pipeline/stages/marlin.ts`
- Current schemas: `schemas/edit-blueprint.schema.json`, `schemas/selects-candidates.schema.json`
- Qwen model card: https://huggingface.co/Qwen/Qwen3-VL-Embedding-2B
- Qwen implementation repo: https://github.com/QwenLM/Qwen3-VL-Embedding
