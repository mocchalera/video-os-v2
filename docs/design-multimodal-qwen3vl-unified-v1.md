# Design: Unified Multimodal Search With Qwen3-VL-Embedding-2B

Date: 2026-06-19
Status: Design only (v1 — first Codex output, pre-review)
Scope: Additive Qwen3-VL multimodal retrieval design for the project-local footage database.
Non-goals: No runtime code, schema migration, model download, or benchmark in this document.
Related: [research-multimodal-vector-search-models.md](./research-multimodal-vector-search-models.md), [design-multimodal-vector-search-architecture.md](./design-multimodal-vector-search-architecture.md), [design-footage-database-unified.md](./design-footage-database-unified.md), [explanation-footage-database.md](./explanation-footage-database.md)

## 1. Why Qwen3-VL Over CLIP

The current footage search path is useful, but it is not true multimodal search. Marlin describes footage as text, `runtime/eval/semantic-match.ts` embeds that text with multilingual E5, and `runtime/tools/footage-search.ts` compares query text against the stored text vectors. That is caption text search. It only finds visual facts when those facts were written into the summary, Marlin events, OCR, tags, appraisal notes, or transcript fields.

CLIP is a good image-text baseline, but it is too narrow as the primary long-term model:

- CLIP handles image and text retrieval, but not video, screenshots, document pages, or mixed text-plus-image inputs as first-class inputs.
- CLIP-family choices fragment quickly: English CLIP, Japanese CLIP, SigLIP, MobileCLIP, and other variants each create separate embedding spaces.
- CLIP can rank frames by text-to-image similarity, but it does not give us a matching multimodal reranker for the same retrieval family.

Qwen3-VL-Embedding-2B is a better primary target for this project:

- It accepts text, images, screenshots, video frames/video inputs, and mixed-modality inputs.
- It maps those inputs into one shared embedding space, so text-to-frame, frame-to-frame, screenshot-to-frame, and mixed query retrieval use the same model family.
- It is Apache-2.0, which keeps commercial usage and redistribution planning cleaner than non-commercial model families.
- The 2B embedding model emits 2048-dimensional vectors and supports Matryoshka Representation Learning, so we can evaluate 2048-dim quality while retaining the option to truncate to 512 or 256 dimensions for storage and speed.
- Qwen3-VL-Reranker-2B is available as the matching reranker, allowing a coherent pipeline: fast embedding recall first, deeper multimodal relevance scoring on the top results.
- The public Qwen model docs describe the 2B embedding model as MRL-capable and instruction-aware, with a 32K sequence length and a paired 2B reranker.

The design decision is therefore: use Qwen3-VL-Embedding-2B as the primary multimodal vector model, keep E5 text embeddings as fallback, and treat CLIP/SigLIP as benchmark baselines rather than the main architecture.

## 2. What Becomes Possible

With E5-only search, a query like `温かみのある光のシーン` can match clips whose text evidence says "warm", "soft light", or similar words. With Qwen3-VL, the same text query can rank representative frames by visual appearance, even if the caption never named the lighting quality.

Concrete editing examples:

| Need | Query | Retrieval behavior |
| --- | --- | --- |
| Find warm-looking B-roll | `温かみのある光のシーン` | Text query embeds through Qwen3-VL and ranks visual frame embeddings by actual light, palette, and tone. |
| Find clips that look like a selected frame | uploaded frame path | The query frame embeds into the same space as stored representative/key frames. |
| Match composition | `このクリップと似た構図` plus an anchor frame | Image-to-image similarity finds similar subject placement, shot scale, and visual mass without relying on labels. |
| Combine visual and production constraints | `chestnut close-up from morning shoot` | SQL filters constrain date/time/camera if populated, FTS/E5 preserve text evidence, and Qwen3-VL ranks visual close-ups. |
| Repair a weak cut | frame before cut + frame after cut | Search can find a bridge clip that is visually compatible with both sides. |
| Rerank high-stakes results | top 50 vector candidates | Qwen3-VL-Reranker-2B rescoring can inspect query-result pairs with fuller multimodal understanding. |

The most important editorial shift is that the agent can search by how footage looks, not only by what the analysis text happened to say.

## 3. Retrieval Pipeline Design

The retrieval pipeline should be multi-stage. Vector similarity alone is not enough for daily editorial use because it can ignore hard constraints, exact terms, exclusions, and provenance.

```text
Query input (text / image / mixed)
  ↓
1. Query analysis — detect modality, extract filters
  ↓
2. SQL filter — date, camera, duration, quality, exclusion
  ↓
3. FTS5 — keyword/term matching
  ↓
4. Vector search — Qwen3-VL embedding cosine similarity
  ↓
5. Score fusion — RRF or weighted combination
  ↓
6. Reranker — Qwen3-VL-Reranker on top-N results (optional)
  ↓
7. Return with evidence — why each result matched
```

### Stage 1: Query Analysis

The search tool should classify the input before scoring:

- Text-only: `温かみのある光のシーン`
- Image-only: `query_frame_path`
- Mixed: text plus image, for example "find a morning chestnut close-up like this frame"
- Structured filters: shooting date, camera, duration, selected/unselected state, segment exclusions, minimum quality, place/category, source asset, beat role

The current `SearchFootageInput` can be extended later with `mode: "visual" | "multimodal"`, `image_query_path`, and `visual_anchor`. This is a future API change, not part of this document.

### Stage 2: SQL Filter

SQL filters stay first because they are deterministic and cheap:

- Date, time, camera, asset id, source order
- Duration range
- Quality minimums and quality flag exclusions
- Place hint and metadata filters
- `exclude_segment_ids` and "unused footage" constraints
- Beat or sequence constraints from the editorial agent

Filters should remain hard only when the user or agent explicitly asks for a hard constraint. Visual preferences such as warmer light, similar composition, or calmer energy should usually be soft scoring signals.

### Stage 3: FTS5

FTS5 remains important even with Qwen3-VL:

- It catches exact terms: `栗`, signage text, place names, proper nouns, asset labels, take numbers.
- It works offline without any embedding model loaded.
- It provides a cheap independent recall path that can be fused with vector recall.

The current FTS surfaces should remain: summary, transcript, Marlin scene/events, tags, OCR, place hints, aesthetic notes, and visual metadata.

### Stage 4: Vector Search

Qwen3-VL embeddings should be loaded only after SQL filtering. At the current scale, brute-force cosine over normalized `Float32Array` BLOBs is simpler and good enough.

For text queries:

- Embed the text query with Qwen3-VL.
- Compare against Qwen3-VL visual and mixed segment embeddings.
- Keep E5 text-vector scoring as an independent fallback channel.

For image queries:

- Embed the query frame with Qwen3-VL.
- Compare against stored representative/key-frame embeddings.
- Return the exact stored frame path that produced the best match.

For mixed queries:

- Embed the mixed Qwen3-VL input if the local runner supports it.
- Otherwise run two channels: text-to-visual and image-to-image, then fuse scores.

### Stage 5: Score Fusion

The current hybrid scorer uses semantic, lexical, quality, and peak signals. The Qwen3-VL design should make the channels explicit:

```text
final =
  w_fts * fts_score +
  w_e5_text * e5_text_score +
  w_qwen_visual * qwen_visual_score +
  w_quality * quality_score +
  w_peak * peak_score +
  w_structured * structured_boost
```

Recommended initial weights:

| Query mode | FTS | E5 text | Qwen visual | Quality/peak/structured |
| --- | ---: | ---: | ---: | ---: |
| Text factual | 0.35 | 0.35 | 0.15 | 0.15 |
| Text visual/mood | 0.20 | 0.20 | 0.45 | 0.15 |
| Image similarity | 0.05 | 0.10 | 0.70 | 0.15 |
| Mixed query | 0.20 | 0.20 | 0.45 | 0.15 |
| Bridge/continuity | 0.05 | 0.10 | 0.70 | 0.15 |

RRF is a good first fusion option when mixing candidate lists from FTS, E5, and Qwen3-VL. Weighted scoring is better when all candidates have calibrated score channels. The first implementation can use weighted scoring, then add RRF if result diversity is weak.

### Stage 6: Optional Reranker

Qwen3-VL-Reranker-2B should not run over the full corpus. Use it only on top-N results, usually 20-50 candidates after filtering and vector recall.

Use reranking when:

- The search result will drive a candidate replacement.
- A QA repair needs a high-confidence bridge clip.
- Multiple visually similar results differ in story relevance.
- The query is mixed modality and the initial score fusion is uncertain.

Reranker inputs should include the query text/image and candidate evidence: representative frame, best-matching key frame, summary, Marlin events, OCR/place hints, and source metadata. The output is a relevance score and an explanation field generated by the calling agent, not by the vector store.

### Stage 7: Evidence

Every result should explain why it matched:

- `segment_id`, `asset_id`, source in/out
- Best matched embedding type
- Best matched frame path and timestamp
- Qwen3-VL score, E5 score, FTS score, quality/peak score
- SQL filters applied
- Text evidence refs: summary, Marlin event, OCR, tag, place hint
- Warnings when a model or embedding type was unavailable

This keeps the search output inspectable enough for the editorial agent to cite before changing candidates.

## 4. Embedding Strategy

Qwen3-VL embeddings are additive. They do not replace E5 text embeddings.

For each segment, store these Qwen3-VL vectors:

| Embedding type | Input | Purpose |
| --- | --- | --- |
| `visual_representative` | Representative frame or appraisal frame | Captures the clip's primary visual appearance. |
| `visual_keyframe_in` | Frame near in point | Helps continuity and edit-entry matching. |
| `visual_keyframe_peak` | Marlin/event peak, visual peak, or midpoint fallback | Captures the most editorially useful moment. |
| `visual_keyframe_out` | Frame near out point | Helps continuity and edit-exit matching. |
| `text_combined_qwen` | Summary, tags, Marlin events, OCR, place, appraisal notes | Preserves a Qwen-space text representation. |
| `mixed_representative` | Representative frame plus Marlin description | Combines actual appearance with known scene facts. |

Minimum first build:

1. `visual_representative`
2. `text_combined_qwen`
3. Existing E5 `combined` embedding when available

Second build:

1. Add `visual_keyframe_in`
2. Add `visual_keyframe_peak`
3. Add `visual_keyframe_out`
4. Add `mixed_representative`

Frame source priority:

1. Existing visual appraisal frame path
2. Existing representative frame path or filmstrip-derived frame
3. Existing craft/editorial tool frames
4. Deterministically extracted midpoint frame
5. Deterministically extracted in/peak/out frames

Segment-level score collapse:

```text
segment_visual_score =
  max(
    visual_representative,
    visual_keyframe_in,
    visual_keyframe_peak,
    visual_keyframe_out,
    mixed_representative
  )
```

Bridge/continuity scoring should avoid a candidate that matches only one side:

```text
bridge_score =
  0.80 * min(similarity_to_before, similarity_to_after) +
  0.20 * structured_fit
```

Keep E5:

- `Xenova/multilingual-e5-small:q8` remains the local text fallback.
- E5 remains useful when Qwen3-VL is unavailable, when image files are missing, or when the query is pure text/factual.
- Do not compare E5 vectors directly with Qwen3-VL vectors. They are different spaces and must be fused at the score/rank level.

## 5. Model Management

The current `embeddings` table stores `model_id`, `dimension`, and vector BLOBs, which is enough for the first E5 path but too weak for multimodal model lifecycle management. We need an explicit model registry.

Target model table:

```sql
CREATE TABLE embedding_models (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT,
  modality TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  distance_metric TEXT NOT NULL,
  normalized INTEGER NOT NULL,
  quantization TEXT,
  license TEXT,
  created_at TEXT NOT NULL
) STRICT;
```

Why it matters:

- Embeddings are only comparable when they came from the same model, version, dimension strategy, normalization policy, and distance metric.
- A 2048-dim Qwen3-VL vector, 512-dim Matryoshka-truncated Qwen3-VL vector, 384-dim E5 vector, and 512-dim CLIP vector are not interchangeable.
- Model upgrades invalidate old vectors for direct comparison.
- Quantized and full-precision runs should be tracked separately until benchmarked.
- License and distribution status should be visible in the build report.

Recommended model rows:

| name | version | modality | dimensions | metric | normalized | quantization | license |
| --- | --- | --- | ---: | --- | ---: | --- | --- |
| `Qwen/Qwen3-VL-Embedding-2B` | pinned revision hash | multimodal | 2048 | cosine | 1 | bf16/fp16/q8 TBD | Apache-2.0 |
| `Qwen/Qwen3-VL-Embedding-2B` | pinned revision hash | multimodal | 512 | cosine | 1 | bf16/fp16/q8 TBD | Apache-2.0 |
| `Qwen/Qwen3-VL-Reranker-2B` | pinned revision hash | reranker | 0 | rerank_score | 0 | bf16/fp16/q8 TBD | Apache-2.0 |
| `Xenova/multilingual-e5-small` | pinned revision hash | text | 384 | cosine | 1 | q8 | Apache-2.0-compatible model card check required |

Future `segment_embeddings` should reference `embedding_models.id`, not only a string `model_id`. For an additive migration, the existing string `model_id` can remain while the registry is introduced.

## 6. Local Execution Plan

Qwen3-VL-Embedding-2B must run locally on Apple Silicon for this design to be shippable in the current workflow. This is feasible as a target, but it needs a local smoke test and benchmark before implementation.

Execution options:

| Runner | Fit | Notes |
| --- | --- | --- |
| Python + PyTorch + MPS | Primary first path | Most likely to support Qwen3-VL image/video utilities early. Use it as a build-time embedding worker, not inside hot search. |
| Python CPU fallback | Required fallback | Slower, but acceptable for small one-time project builds if MPS fails. |
| Transformers.js / ONNX | Future option | Good integration with the current TypeScript stack if an official or trustworthy ONNX export exists. Must verify availability and image input support. |
| Quantized GGUF/Ollama-style runner | Future option | Potentially practical, but only after verifying true multimodal embedding output and dimension compatibility. |

Local benchmark questions:

- Does `Qwen/Qwen3-VL-Embedding-2B` load and run on this Mac through PyTorch MPS?
- What precision is stable: bf16, fp16, fp32, or quantized?
- Does image input work through the same code path as text input?
- Does mixed image-plus-text input work locally?
- How long does it take to embed 89 representative frames after weights are cached?
- How long does it take to embed 267-445 in/peak/out/key frames?
- What is peak RSS during batch embedding?
- Does the reranker run locally on top-20 or top-50 candidates within an acceptable interactive delay?

Planning estimates:

- 2B parameters are roughly 4 GB in fp16/bf16 and roughly 8 GB in fp32, before runtime overhead, activations, image preprocessing, and framework memory.
- 89 representative frames should be processed as a build step, not as an interactive search step.
- Search-time query embedding should be cached per query/image hash where possible.
- Reranking is optional and heavier; keep it disabled unless explicitly requested by the agent workflow or user.

Build behavior:

1. Build normal SQLite tables and FTS5 first.
2. Build E5 text embeddings if configured and available.
3. Build Qwen3-VL representative frame embeddings if the model runner is available.
4. Add key-frame and mixed embeddings incrementally.
5. Record per-family statuses: `e5_text_embedding_status`, `qwen3vl_embedding_status`, `qwen3vl_reranker_status`.
6. Warn but keep the DB usable when Qwen3-VL is unavailable.

## 7. Storage: SQLite vs LanceDB

At the current scale, SQLite remains the right default.

Storage math:

```text
89 segments * 2048 dims * 4 bytes = 729,088 bytes
```

That is about 712 KiB for one vector per segment before SQLite overhead. Even with five Qwen3-VL vectors per segment:

```text
89 segments * 5 vectors * 2048 dims * 4 bytes = 3,645,440 bytes
```

That is about 3.5 MiB before overhead. SQLite BLOB storage and brute-force cosine are fine.

Decision:

- Stay with project-local SQLite for now.
- Store normalized `Float32Array` BLOBs.
- Apply SQL filters before vector loading.
- Decode and score only eligible candidate vectors.
- Keep LanceDB as a future option if projects grow to thousands of segments, many assets, PDF pages, photos, screenshots, and cross-project libraries.

LanceDB becomes worth revisiting when:

- A project has tens of thousands of vectors.
- We need ANN indexes instead of brute-force scans.
- We want a dedicated multimodal data layer with vector, metadata, and hybrid search built in.
- Cross-project asset libraries become a first-class product surface.

Matryoshka:

- Default benchmark should start with full 2048-dim vectors.
- Evaluate 512-dim truncation for speed/storage.
- Evaluate 256-dim only if quality remains acceptable for visual mood, lighting, and composition queries.
- Store dimension in the model registry so 2048/512/256 vectors never mix silently.
- Treat Matryoshka as a vector storage/search optimization unless the local runtime proves a lower-compute inference path.

## 8. Integration With The Editorial Agent

Qwen3-VL search should be exposed as a read-only retrieval capability. It should help the agent find candidates, replacements, and bridge clips, but it should not write `selects_candidates.yaml`, `edit_blueprint.yaml`, or `timeline.json` directly.

### Rough Pass

Current rough pass selection relies on Marlin reports, visual appraisal text, and representative frames. Qwen3-VL adds visual recall:

```text
Need: find visually warm clips
Input: "温かみのある光のシーン"
Search: Qwen3-VL text-to-visual search over representative frames
Return: clips whose actual frames have warm light, plus FTS/E5 evidence when available
```

This helps when the brief asks for mood, light, texture, softness, or calmness that may not be consistently named in captions.

### Fine Pass

The fine pass can use inspected key frames as search anchors:

```text
Problem: this clip's lighting does not match the previous clip
Input: previous clip key frame + text condition for the beat
Search: image-to-image similarity with structured exclusions
Decision: replace only if the candidate is semantically equivalent and visually stronger
```

The agent should cite:

- Query text and/or frame path
- Returned `segment_id`
- Best matching frame path
- Score breakdown
- Text evidence that the candidate still serves the beat

### QA Loop

Rendered QA can turn visual problems into retrieval tasks:

```text
Problem: abrupt visual change at 1:30
Input: frame before cut, frame after cut
Search: bridge clip with similarity to both sides
Scoring: min(before similarity, after similarity) plus structured fit
Output: one proposed insert/swap/transition change with evidence
```

This gives the agent a practical repair mechanism after Marlin or a human identifies a visual continuity issue.

### New Tool Shape

Future tool helper:

```text
visual_search(query_frame_path)
```

Expected behavior:

- Embed the query frame with Qwen3-VL.
- Apply optional filters and exclusions.
- Return visually similar clips with frame evidence and score breakdown.
- Fall back to text/structured search only when a text query is also provided.
- Warn clearly when visual embeddings are unavailable.

The public tool can remain `search_footage` at first, with `visual_search(...)` implemented as a helper around the same backend.

## 9. Migration Plan

### Phase 1: Add Qwen3-VL Embeddings Alongside E5

Add Qwen3-VL rows as derived search data. Do not replace E5. Do not modify canonical planning artifacts.

Acceptance criteria:

- Existing structured, FTS, and E5 text search behavior remains unchanged.
- Build report records Qwen3-VL model status, model id, dimension, vector count, and warnings.
- Missing Qwen3-VL model files warn but do not break DB creation.
- Representative-frame visual search can run when Qwen3-VL embeddings exist.

### Phase 2: Hybrid Scoring

Add explicit score channels for FTS, E5 text, Qwen3-VL visual, quality, peak, and structured boosts.

Acceptance criteria:

- Text-only queries still work without Qwen3-VL.
- Visual/mood text queries can rank by Qwen3-VL visual appearance.
- Image queries rank by Qwen3-VL frame similarity.
- Results explain which signal drove the match.

### Phase 3: Agent Tools For Image-Query Search

Extend the search adapter with image-query support.

Acceptance criteria:

- Agent can pass an absolute frame path and receive similar clips.
- Results include `segment_id`, `asset_id`, source range, matched frame path, and score breakdown.
- Fine-pass replacement prompts require visual evidence before replacing a clip.
- Headless/text-only fallback remains available.

### Phase 4: Optional Reranker

Add Qwen3-VL-Reranker-2B for top-N rescoring.

Acceptance criteria:

- Reranker is off by default.
- Reranker runs only over a bounded candidate set.
- Reranker outputs are recorded separately from embedding cosine scores.
- Search remains usable when reranker is unavailable.

### Phase 5: Matryoshka Dimension Tuning

Benchmark full 2048-dim vectors against 512-dim and 256-dim truncation.

Acceptance criteria:

- Evaluate quality on Japanese visual mood queries, image-to-image composition queries, and continuity/bridge queries.
- Record speed, memory, and DB size.
- Choose the smallest dimension that preserves practical editing quality.
- Keep dimension-specific model rows so old vectors never mix with new ones.

## 10. Risks And Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Model size is heavy | Some machines may not load 2B comfortably. | Use build-time worker, benchmark precision/quantization, keep E5/FTS fallback, evaluate Matryoshka dimensions for storage/search speed. Do not assume truncation reduces model inference cost. |
| MPS compatibility is unverified locally | Python runner may fail or fall back to CPU. | Run a smoke test before implementation; CPU fallback should warn and remain usable for small builds. |
| Embedding time is unknown | Build step may become slow. | Benchmark 89 representative frames first; cache by content hash; embed incrementally; do not block text/FTS DB creation. |
| Single-frame embeddings miss temporal video meaning | Visual search may miss action progression. | Keep Marlin as temporal reporter; use key frames in/peak/out; use Marlin events and transcripts for semantic/temporal meaning. |
| Visual similarity can be semantically wrong | A clip may look similar but not serve the beat. | Fuse with FTS/E5/structured filters; require evidence citation and frame inspection before replacement. |
| Model upgrades invalidate vectors | Old and new vectors may be compared incorrectly. | Add `embedding_models`; pin revision, dimension, normalization, quantization, license, and distance metric. |
| Reranker is too slow | Interactive search could stall. | Make reranker optional, top-N only, and disabled in normal searches. |
| Mixed modality local API is immature | Text-plus-image input may be harder than separate channels. | Start with separate text-to-visual and image-to-image channels; add native mixed input only after local proof. |

## 11. Practical Decision

Use Qwen3-VL-Embedding-2B as the primary multimodal embedding model for the next design direction.

Keep the current architecture principles:

- Derived project-local SQLite search DB
- Canonical artifacts unchanged
- SQL and FTS before vector scoring
- Normalized vector BLOBs and brute-force cosine at current scale
- E5 text embeddings as fallback
- Warnings instead of hard failure when optional models are unavailable
- Agent-facing results with evidence, scores, and frame paths

The first valuable implementation target is narrow:

```text
Build Qwen3-VL representative-frame embeddings for the 89 segments,
then support text-to-visual and image-to-image search over those frames.
```

If that improves real rough-pass discovery or fine-pass replacement quality, expand to key frames, mixed embeddings, reranking, and Matryoshka tuning.

## Local Sources Checked

- Local research report: `multimodal-vector.md` (project-local reference)
- Existing design docs: `docs/research-multimodal-vector-search-models.md`, `docs/design-multimodal-vector-search-architecture.md`, `docs/design-footage-database-unified.md`, `docs/explanation-footage-database.md`
- Current footage DB implementation: `runtime/artifacts/footage-db-builder.ts`, `runtime/tools/footage-search.ts`, `runtime/eval/semantic-match.ts`
