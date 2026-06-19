# Design: Unified Multimodal Vector Search With Qwen3-VL-Embedding-2B

Date: 2026-06-19
Status: Design only, implementation gated by local smoke test
Scope: Additive Qwen3-VL multimodal retrieval for the project-local footage database
Non-goals: No runtime code, no canonical schema changes, no model download during normal search, no remote embedding API

This is design document #2. It uses the prior Qwen design and review as context, but the contract below is written independently around the current SQLite builder/search implementation.

Success conditions:

- The existing SQLite/FTS/E5 footage search remains unchanged when Qwen rows are absent.
- Qwen3-VL rows add real visual retrieval: text-to-frame, image-to-image, and later mixed input search.
- Storage, TypeScript API, and Python worker contracts are concrete enough to implement without another design pass.
- Phase 0 proves local Apple Silicon execution before any indexing implementation.
- Search results include evidence, score breakdowns, fallback warnings, and matched frame refs.
- No remote embedding or reranking API is used.

## 1. Why Qwen3-VL Over CLIP

The current footage search path is useful, but it is not true multimodal search. `runtime/eval/semantic-match.ts` embeds text with `Xenova/multilingual-e5-small`, and `runtime/tools/footage-search.ts` compares text query vectors against text bundles stored in SQLite. Marlin and appraiser output may describe visual facts, but the search is still caption text search.

CLIP is a good baseline for image-text retrieval, but it is too narrow as the main design target:

- CLIP is primarily image plus text. It does not natively cover video, screenshots, document-like frames, or arbitrary mixed text plus image inputs as one product surface.
- CLIP variants quickly fragment into separate spaces: English CLIP, Japanese CLIP, SigLIP, MobileCLIP, and other checkpoints are not interchangeable.
- CLIP can retrieve frames from text, but it does not provide the matching Qwen-style multimodal reranker in the same model family.

Qwen3-VL-Embedding-2B is the recommended primary model:

- It handles text, images, screenshots, videos/video frames, and mixed multimodal inputs in one embedding family.
- It maps text and visual inputs into a shared space, so text-to-frame, frame-to-frame, screenshot-to-frame, and mixed query search can use one model identity.
- It is Apache-2.0, which keeps commercial and local redistribution planning cleaner than non-commercial model families.
- The 2B model outputs up to 2048 dimensions and supports Matryoshka/user-defined output dimensions, so 2048 can be benchmarked first and 512 or 256 can be evaluated later for storage and speed.
- Qwen3-VL-Reranker-2B exists as the paired reranker. The architecture can do fast vector recall first, then bounded top-N visual reranking.
- The model is instruction-aware. The instruction string is part of the embedding contract and must be stored with the model row.

Design decision: Qwen3-VL-Embedding-2B is the primary multimodal retrieval model. Existing E5 text embeddings remain the fallback and an independent text channel. CLIP/SigLIP remain useful benchmark baselines, not the target architecture.

## 2. What Becomes Possible

The editorial gain is that the agent can search by how footage looks, not only by what analysis text said.

| Editing need | Query | Behavior |
| --- | --- | --- |
| Visual mood search | `温かみのある光のシーン` | Text query embeds with Qwen3-VL and ranks frame embeddings by actual warm light, color, contrast, and tone. |
| Image-to-image search | Upload or pass a frame path | Finds clips that look like the query frame using the same Qwen vector space. |
| Composition matching | `このクリップと似た構図` with a visual anchor | Finds similar subject placement, shot scale, geometry, and visual mass without relying on labels. |
| Mixed visual plus metadata search | `chestnut close-up from morning shoot` | SQL narrows date/camera/time if available, FTS/E5 preserve text evidence, and Qwen ranks visual close-ups. |
| Continuity repair | frame before cut plus frame after cut | Target later multi-anchor behavior: finds bridge candidates that are visually compatible with both sides. |
| High-confidence selection | top 50 vector results | Qwen3-VL-Reranker-2B can rescore bounded candidates with fuller multimodal understanding after recall. |

The design does not ask Qwen to become the planner. Marlin reports what happens and when. Qwen embeddings capture visual proximity. Claude/Codex decides how to use candidates and cites evidence before modifying any planning artifact.

## 3. Retrieval Pipeline Design

Vector search is one stage in a retrieval pipeline, not the whole system.

```text
Query input (text / image / mixed)
  ->
1. Query analysis: detect modality, classify visual intent, extract filters
  ->
2. SQL filter: date, camera, duration, quality, selected/excluded ids
  ->
3. FTS5: keyword, OCR, transcript, place, tag, and exact term recall
  ->
4. Vector search: Qwen3-VL cosine similarity over eligible embeddings
  ->
5. Score fusion: RRF or weighted per-channel combination
  ->
6. Reranker: Qwen3-VL-Reranker on top-N results, optional and deferred
  ->
7. Return with evidence: score breakdown, frame refs, text refs, warnings
```

### Stage 1: Query Analysis

Classify the input before scoring:

- Text-only: `温かみのある光のシーン`
- Image-only: absolute `image_query_path`
- Mixed: text plus image, such as "find a morning chestnut close-up like this frame"
- Visual anchor: `segment_id` plus frame type, such as `visual_keyframe_peak`
- Structured filters: date, time, camera, source asset, duration, quality, place, selected/unselected state, and exclusions

Visual preferences such as warm light, similar composition, calmness, or palette are soft scoring signals unless the user explicitly asks for hard filtering.

### Stage 2: SQL Filter

SQL remains first because it is cheap and deterministic:

- `asset_ids`, `exclude_segment_ids`, selected or unused constraints
- duration range
- quality minimums and quality flag exclusions
- camera, date, time, reel, card, place, and source metadata when populated
- beat-specific constraints from the editorial agent

Do not invent missing typed metadata. If the user asks for `shooting_date` but the project has no populated date column, return a warning and continue with other available signals.

### Stage 3: FTS5

FTS5 remains necessary with Qwen:

- It catches exact terms such as `栗`, names, signage, take numbers, product labels, place names, and OCR.
- It works when no model is available.
- It gives an independent recall list for rank fusion.

Existing FTS surfaces should stay: summary, transcript, Marlin scene/events, tags, OCR, place hints, aesthetic notes, and metadata FTS fields.

### Stage 4: Vector Search

Use Qwen3-VL only after SQL filters reduce the candidate set.

For text queries:

- Embed text with Qwen3-VL using the configured instruction.
- Compare against `visual_*`, `mixed_representative`, and optionally `text_combined_qwen` rows.
- Keep E5 text scoring as a separate fallback channel.

For image queries:

- Validate and hash the absolute image path.
- Embed the image with Qwen3-VL.
- Compare against stored visual frame embeddings.
- Return the exact stored frame that produced the best match.

For mixed queries:

- Prefer native Qwen mixed input once local smoke tests prove it.
- Until then, run two channels: text-to-visual and image-to-image, then fuse scores.

Query embedding cache keys must include: normalized text or image content hash, query modality, `embedding_models.id`, output dimension, instruction, preprocess version, normalized flag, and model revision.

### Stage 5: Score Fusion

Weighted scoring is the first implementation target because it maps directly onto the current scorer. RRF can be added later if the FTS/E5/Qwen candidate lists produce better diversity than calibrated scores.

Every score response must expose per-channel values so an agent can tell whether a result matched because of text, visual similarity, quality, peak strength, or reranking.

### Stage 6: Optional Reranker

Reranking is not part of Phase 1. It is Phase 4 and requires a separate spike before implementation.

When enabled later, Qwen3-VL-Reranker-2B should run only on a bounded set, usually top 20 to 50 after SQL/FTS/vector recall. The reranker returns a numeric relevance score only. The search layer exposes evidence from indexed fields; it must not invent explanatory claims.

### Stage 7: Evidence

Each result should include:

- `segment_id`, `asset_id`, source in/out, duration
- best matched embedding type and model row id
- best matched frame path and timestamp
- Qwen visual score, Qwen mixed score, E5 score, FTS score, quality score, peak score, final score
- SQL filters applied
- text evidence refs from summary, transcript, Marlin event, OCR, tag, place hint, and aesthetic notes
- warnings for unavailable models, missing frames, invalid vectors, or fallback behavior

## 4. Embedding Strategy

Qwen3-VL embeddings are additional derived rows. They do not replace E5.

Per segment, store these Qwen vectors:

| Embedding type | Input | Purpose |
| --- | --- | --- |
| `visual_representative` | Representative/appraiser frame | Captures the clip's primary visual appearance. |
| `visual_keyframe_in` | Frame near segment in point | Helps continuity and entry matching. |
| `visual_keyframe_peak` | Marlin peak, visual peak, or midpoint fallback | Captures the most editorially useful moment. |
| `visual_keyframe_out` | Frame near segment out point | Helps exit matching and bridge search. |
| `text_combined_qwen` | Summary, transcript, tags, Marlin events, OCR, place, appraisal notes | Keeps text in Qwen's space for same-family text/mixed comparisons. |
| `mixed_representative` | Representative frame plus Marlin/appraiser description | Combines actual appearance with known scene facts. |

Keep legacy text embedding types readable:

- `summary`
- `transcript`
- `scene`
- `combined`

Minimum first build:

1. Existing E5 `combined` rows when available.
2. Qwen `visual_representative`.
3. Qwen `text_combined_qwen`.

Second build:

1. Add `visual_keyframe_in`.
2. Add `visual_keyframe_peak`.
3. Add `visual_keyframe_out`.
4. Add `mixed_representative` only after native mixed input passes the local smoke gate.

Visual score collapse for normal search:

```text
segment_qwen_visual =
  max(
    visual_representative,
    visual_keyframe_in,
    visual_keyframe_peak,
    visual_keyframe_out,
    mixed_representative
  )
```

Bridge/continuity scoring should be conservative:

```text
bridge_visual =
  0.80 * min(similarity_to_before, similarity_to_after)
  + 0.20 * structured_fit
```

This prevents a candidate that matches only one side of a cut from ranking too high.

Phase boundary: this bridge formula is the target design, not the current API contract. The current TypeScript and flat tool APIs support single-anchor similarity only. True continuity/bridge search requires a future bounded multi-anchor API, such as explicit before/after image paths or visual anchors, before the formula above can be implemented.

E5 rules:

- `Xenova/multilingual-e5-small:q8` stays as the local text fallback.
- Do not compare E5 vectors directly with Qwen vectors.
- Fuse E5 and Qwen at the score/rank level only.
- Search must remain usable when Qwen rows are missing.

## 5. Storage Contract

The current `embeddings` table cannot store visual rows because `field` is restricted to `summary`, `transcript`, `scene`, and `combined`, and it has a foreign key to `embedding_texts(segment_id, field)`. Qwen needs a new additive table.

Target additive DDL:

```sql
CREATE TABLE embedding_models (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  output_dimension INTEGER NOT NULL CHECK (output_dimension >= 0),
  input_modality TEXT NOT NULL CHECK (
    input_modality IN ('text', 'image', 'screenshot', 'video', 'mixed', 'multimodal', 'reranker')
  ),
  instruction TEXT NOT NULL DEFAULT '',
  preprocess_version TEXT NOT NULL,
  runner_name TEXT NOT NULL,
  runner_version TEXT NOT NULL,
  precision TEXT NOT NULL,
  normalized INTEGER NOT NULL CHECK (normalized IN (0, 1)),
  distance_metric TEXT NOT NULL CHECK (distance_metric IN ('cosine', 'dot', 'l2', 'rerank_score')),
  license TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (
    name,
    model_revision,
    output_dimension,
    input_modality,
    instruction,
    preprocess_version,
    runner_name,
    runner_version,
    precision,
    normalized,
    distance_metric
  )
) STRICT;

CREATE TABLE segment_embeddings (
  id INTEGER PRIMARY KEY,
  segment_id TEXT NOT NULL REFERENCES segments(segment_id) ON DELETE CASCADE,
  embedding_type TEXT NOT NULL CHECK (
    embedding_type IN (
      'summary',
      'transcript',
      'scene',
      'combined',
      'visual_representative',
      'visual_keyframe_in',
      'visual_keyframe_peak',
      'visual_keyframe_out',
      'text_combined_qwen',
      'mixed_representative'
    )
  ),
  model_id INTEGER NOT NULL REFERENCES embedding_models(id) ON DELETE RESTRICT,
  source_ref TEXT NOT NULL DEFAULT '',
  source_timestamp_us INTEGER CHECK (source_timestamp_us IS NULL OR source_timestamp_us >= 0),
  content_hash TEXT NOT NULL,
  dimension INTEGER NOT NULL CHECK (dimension > 0),
  vector BLOB NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (segment_id, embedding_type, model_id, source_ref, content_hash)
) STRICT;

CREATE INDEX idx_segment_embeddings_segment
  ON segment_embeddings(segment_id);

CREATE INDEX idx_segment_embeddings_model
  ON segment_embeddings(model_id);

CREATE INDEX idx_segment_embeddings_type_model
  ON segment_embeddings(embedding_type, model_id);
```

Field semantics:

- `model_id` is an integer FK to `embedding_models.id`, not a free-form string.
- `source_ref` is the project-relative frame path for frame embeddings, `embedding_texts:<field>` for copied E5 rows, or `mixed:<frame-path>` for mixed embeddings.
- `source_timestamp_us` is the source media timestamp for extracted frames and `NULL` for text-only embeddings.
- `content_hash` for new rows is a SHA-256 over normalized text, frame bytes, or mixed input payload plus `preprocess_version`.
- Legacy E5 rows copied from `embeddings` keep their original `content_hash`. Comparability relies on `embedding_models.preprocess_version` and `embedding_models.id`, not `content_hash` alone. Do not recompute migrated E5 hashes.
- `dimension` must match `embedding_models.output_dimension`.
- `vector` is little-endian `Float32Array` bytes.
- `created_at` uses the builder-injected `indexedAt`/`now` value, never direct `Date.now()` inside population logic.

Migration path from the current `embeddings` table:

1. Add `embedding_models` and `segment_embeddings` while keeping existing `embedding_texts` and `embeddings`.
2. Insert one model row for current E5:

```text
name = Xenova/multilingual-e5-small
model_revision = pinned or legacy-unpinned
output_dimension = 384
input_modality = text
instruction = e5-query-passage-prefix-v1
preprocess_version = footage-db-text-bundle-v1
runner_name = transformers.js
runner_version = package lock version or unknown
precision = q8
normalized = 1
distance_metric = cosine
license = model-card-verified-before-release
```

3. Copy legacy rows into `segment_embeddings`:

```sql
INSERT INTO segment_embeddings (
  segment_id,
  embedding_type,
  model_id,
  source_ref,
  source_timestamp_us,
  content_hash,
  dimension,
  vector,
  created_at
)
SELECT
  e.segment_id,
  e.field,
  @e5_model_id,
  'embedding_texts:' || e.field,
  NULL,
  e.content_hash,
  e.dimension,
  e.vector,
  e.created_at
FROM embeddings e;
```

Legacy copy semantics:

- Copied E5 rows preserve `e.content_hash` exactly.
- Do not recompute migrated E5 hashes with the new normalized-input-plus-`preprocess_version` recipe.
- New Qwen text, image, and mixed rows use the new hash recipe.

4. Update search to prefer `segment_embeddings` when present and fall back to legacy `embeddings` for current E5-only databases.
5. Do not drop the legacy table until all supported DB builds and tests read the new table.

Build report/status contract:

The current builder result shape at `runtime/artifacts/footage-db-builder.ts:31-50` exposes only `counts.embeddings` and scalar `embedding_status`. Phase 1 adds channel-specific fields while keeping those existing fields as backward-compatible aliases.

```typescript
interface EmbeddingCounts {
  e5_text: number;
  qwen_text: number;
  qwen_visual: number;
  qwen_mixed: number;
  qwen_reranker: number;
}

type EmbeddingChannelStatus = 'ready' | 'skipped' | 'unavailable' | 'error';

interface EmbeddingStatuses {
  e5_text: EmbeddingChannelStatus;
  qwen_text: EmbeddingChannelStatus;
  qwen_visual: EmbeddingChannelStatus;
  qwen_mixed: EmbeddingChannelStatus | 'unsupported';
  qwen_reranker: 'deferred' | EmbeddingChannelStatus;
}
```

`BuildFootageDbResult` and the report JSON add:

```typescript
embedding_counts?: EmbeddingCounts;
embedding_statuses?: EmbeddingStatuses;
```

Compatibility rules:

- `embedding_counts` and `embedding_statuses` are authoritative for multimodal builds.
- `counts.embeddings` remains for existing consumers. In legacy-only builds it equals `embedding_counts.e5_text`; in multimodal builds it is the total persisted embedding rows across E5 and Qwen embedding channels.
- `embedding_status` remains for existing consumers and is a conservative aggregate: `ready` when at least one retrieval embedding channel is ready, `skipped` when all channels are intentionally skipped, `unavailable` when no channel can be produced because required local models or inputs are unavailable, and `error` when a required embedding policy fails.
- `qwen_reranker` stays `deferred` until the Phase 4 spike enables it.

Corrupt vector handling:

- If BLOB byte length is not `dimension * 4`, skip the row and warn.
- If decoded values contain `NaN` or infinite numbers, skip the row and warn.
- If a normalized vector has near-zero magnitude, skip the row and warn.
- If `dimension` differs from the model row, skip the row and warn.

## 6. Model Management

`embedding_models` is required because embeddings are only comparable under the same model, revision, output dimension, instruction, preprocessing, normalization, precision, runner, and distance metric.

Recommended initial rows:

| name | revision | dimension | modality | instruction | preprocess | runner | precision | normalized | metric | license |
| --- | --- | ---: | --- | --- | --- | --- | --- | ---: | --- | --- |
| `Qwen/Qwen3-VL-Embedding-2B` | pinned HF snapshot | 2048 | `multimodal` | `Retrieve video footage relevant to the editing query.` | `qwen3vl-frame-v1` | `python-qwen3vl-worker` | `fp16` or `bf16` | 1 | `cosine` | Apache-2.0 |
| `Qwen/Qwen3-VL-Embedding-2B` | same snapshot | 512 | `multimodal` | same | `qwen3vl-frame-v1` | same | same | 1 | `cosine` | Apache-2.0 |
| `Qwen/Qwen3-VL-Reranker-2B` | pinned HF snapshot | 0 | `reranker` | `Score whether the candidate clip satisfies the query.` | `qwen3vl-rerank-v1` | `python-qwen3vl-worker` | `fp16` or `bf16` | 0 | `rerank_score` | Apache-2.0 |
| `Xenova/multilingual-e5-small` | pinned snapshot or legacy-unpinned | 384 | `text` | `query:/passage: prefix` | `footage-db-text-bundle-v1` | `transformers.js` | `q8` | 1 | `cosine` | verify before release |

Operational rules:

- Pin model revisions before non-spike builds.
- Treat a changed instruction as a different model row.
- Treat 2048, 512, and 256 Matryoshka dimensions as different model rows.
- Store build report counts separately: `e5_text`, `qwen_text`, `qwen_visual`, `qwen_mixed`, and `qwen_reranker`.
- Do not compare vectors across different `embedding_models.id` values.

## 7. TypeScript API Contract

The existing search contract must be extended concretely, not deferred.

```ts
export type FootageSearchMode =
  | "hybrid"
  | "text"
  | "semantic"
  | "structured"
  | "visual"
  | "multimodal";

export type VisualFrameType =
  | "visual_representative"
  | "visual_keyframe_in"
  | "visual_keyframe_peak"
  | "visual_keyframe_out";

export interface FootageVisualAnchor {
  segment_id: string;
  frame_type?: VisualFrameType;
  frame_path?: string;
  source_timestamp_us?: number;
}

export interface SearchFootageInput {
  query: string;
  mode?: FootageSearchMode;
  explicitBoolean?: boolean;
  text_match?: string;
  semantic?: string;
  image_query_path?: string;
  visual_anchor?: FootageVisualAnchor;
  visual_goal?: "similarity" | "match_cut" | "palette" | "shot_scale";
  filters?: FootageSearchFilters;
  sort_by?: FootageSortBy;
  limit?: number;
  context?: FootageSearchContext;
  rerank?: {
    enabled?: boolean;
    top_n?: number;
  };
}

export interface SearchScoreBreakdown {
  semantic?: number; // backward-compatible alias for current E5 semantic score
  e5_text?: number;
  lexical?: number;
  qwen_text?: number;
  qwen_visual?: number;
  qwen_mixed?: number;
  reranker?: number;
  quality?: number;
  peak?: number;
  duration?: number;
  final: number;
  weights?: Partial<Record<
    "semantic" | "e5_text" | "lexical" | "qwen_text" | "qwen_visual" | "qwen_mixed" | "quality" | "peak" | "duration",
    number
  >>;
  embedding_matches?: Array<{
    segment_embedding_id: number;
    embedding_type: string;
    model_id: number;
    score: number;
    source_ref?: string;
    source_timestamp_us?: number;
  }>;
  unavailable_channels?: string[];
}
```

The existing `FootageScoreBreakdown` can either be extended in place or aliased to `SearchScoreBreakdown`. Existing consumers must continue to see `scores.semantic`, `scores.lexical`, `scores.quality`, `scores.peak`, and `scores.final`.

`query: string` remains required for backward compatibility with the current text-first tool contract. For `mode: "visual"` or image-only calls, the image-only convention is `query: ""`.

Continuity search is deferred to a Phase 3+ multi-anchor extension. The current API supports one `image_query_path` or one `visual_anchor`, so it can express similarity, match-cut, palette, and shot-scale searches but not bridge scoring against both sides of a cut.

Validation rules:

- `mode` defaults to `hybrid`.
- `visual` mode uses either `image_query_path` or `visual_anchor` as its visual retrieval channel.
- For `mode: "visual"` or image-only calls, `query` may be `""`.
- `multimodal` mode allows text plus image, text plus anchor, or text plus Qwen mixed rows.
- `image_query_path` must be an absolute path.
- `image_query_path` must resolve to a regular readable file under the project root or an approved project-local derived frame directory.
- Symlinks that resolve outside the project root are rejected.
- Allowed image extensions for v1: `.jpg`, `.jpeg`, `.png`, `.webp`.
- If the path is unreadable and the query has text, continue with text/structured search and warn. If the query is image-only, return no results and warn.
- `visual_anchor.segment_id` must exist in the DB. If `frame_type` is omitted, prefer `visual_representative`, then `visual_keyframe_peak`.
- For `mode: "visual"` with no text query and no valid `image_query_path` embedding or `visual_anchor` embedding available, including missing visual inputs, return `[]` with a warning before any structured-only scoring is considered.
- `visual_goal: "continuity"` is not valid in the current API. It requires a future bounded shape with before/after image paths or anchors.
- `limit` remains capped by the existing maximum unless reranking explicitly lowers top-N.

Flat tool adapter shape:

```text
search_footage(
  query,
  mode,
  filters_json,
  limit,
  image_query_path,
  visual_anchor_segment_id,
  visual_anchor_frame_type,
  visual_goal
)
```

This keeps the current prompt-oriented adapter usable without requiring nested object parsing in the first pass. For `mode: "visual"`, the flat adapter normalizes a missing or `undefined` `query` argument to `""`; for all other modes, existing query validation remains unchanged.

Fallback precedence and backward compatibility:

- Existing calls with `mode: "hybrid" | "text" | "semantic" | "structured"` behave the same when Qwen is absent.
- Existing text-only results keep the current score formula when Qwen channels are unavailable.
- Image-only visual search has precedence over structured fallback: if `mode: "visual"` has no text query and no valid `image_query_path` or anchor embedding, return `[]` with a warning.
- Reserve structured-only fallback for explicitly structured queries or for text/multimodal queries where at least one non-visual retrieval channel exists.
- If visual embeddings are unavailable and the request includes text, `visual` or `multimodal` mode downgrades to the current text/semantic/structured path and adds a warning.
- If visual embeddings are unavailable for an image-only request, return no results with a warning rather than pretending text search was visual search.
- If `visual_anchor` resolves to a segment but no requested frame embedding exists, try `visual_representative`, then `visual_keyframe_peak`, then downgrade according to the same rules.
- JSON fallback remains available when the DB is missing or malformed.
- Search remains read-only. It never writes `selects_candidates.yaml`, `edit_blueprint.yaml`, `timeline.json`, or source media.

## 8. Python Worker Bridge Protocol

Qwen should run through a Python JSONL worker modeled after `python/marlin_worker.py`, with a TypeScript client modeled after `runtime/connectors/marlin-local.ts`.

Proposed files:

```text
python/qwen3vl_embedding_worker.py
python/requirements-qwen3vl.txt
runtime/connectors/qwen3vl-embedding-local.ts
```

Default execution:

```text
python/.venv-qwen3vl/bin/python3 python/qwen3vl_embedding_worker.py \
  --model Qwen/Qwen3-VL-Embedding-2B \
  --device mps \
  --cache-dir ~/.cache/video-os-v2/qwen3vl
```

Environment variables:

| Variable | Purpose |
| --- | --- |
| `VOS_QWEN3VL_PYTHON` | Override Python binary. |
| `VOS_QWEN3VL_WORKER` | Override worker path. |
| `VOS_QWEN3VL_MODEL` | Override embedding model id/path. |
| `VOS_QWEN3VL_RERANKER_MODEL` | Override reranker model id/path. |
| `VOS_QWEN3VL_DEVICE` | `mps`, `cpu`, or `auto`. |
| `VOS_QWEN3VL_CACHE_DIR` | Model cache path. |
| `VOS_QWEN3VL_REQUEST_TIMEOUT_MS` | Per-request timeout. |
| `VOS_QWEN3VL_MOCK` | Deterministic mock mode for connector tests. |

Dependencies file:

```text
transformers>=4.57.0
sentence-transformers
torch
torchvision
qwen-vl-utils>=0.0.14
pillow
accelerate
psutil
```

The exact `torch` version is locked by the Phase 0 smoke test. Do not widen or pin it in production docs until MPS behavior is measured on this machine.

JSONL request envelope:

```json
{"id":1,"method":"embed_text","params":{"texts":["温かみのある光のシーン"],"instruction":"Retrieve relevant video footage for editing.","output_dimension":2048,"normalize":true}}
```

```json
{"id":2,"method":"embed_image","params":{"image_paths":["/abs/project/03_analysis/frames/SEG_1/representative.jpg"],"instruction":"Retrieve visually similar video footage.","output_dimension":2048,"normalize":true,"preprocess_version":"qwen3vl-frame-v1"}}
```

```json
{"id":3,"method":"embed_mixed","params":{"items":[{"text":"chestnut close-up with warm morning light","image_path":"/abs/project/03_analysis/frames/SEG_1/representative.jpg"}],"instruction":"Retrieve matching video clips using text and image.","output_dimension":2048,"normalize":true,"preprocess_version":"qwen3vl-mixed-v1"}}
```

```json
{"id":4,"method":"embed_batch","params":{"items":[{"ref":"SEG_1:visual_representative","kind":"image","image_path":"/abs/project/03_analysis/frames/SEG_1/representative.jpg"},{"ref":"SEG_1:text_combined_qwen","kind":"text","text":"summary and Marlin evidence"}],"instruction":"Retrieve relevant video footage for editing.","output_dimension":2048,"normalize":true,"preprocess_version":"qwen3vl-frame-v1"}}
```

```json
{"id":5,"method":"shutdown","params":{}}
```

Success response:

```json
{
  "id": 1,
  "ok": true,
  "result": {
    "vectors": [
      {
        "ref": "0",
        "vector": "base64-float32-little-endian",
        "vector_encoding": "float32-le-base64",
        "dimension": 2048,
        "normalized": true
      }
    ],
    "model": {
      "name": "Qwen/Qwen3-VL-Embedding-2B",
      "model_revision": "pinned-snapshot",
      "output_dimension": 2048,
      "instruction": "Retrieve relevant video footage for editing.",
      "preprocess_version": "qwen3vl-frame-v1",
      "runner_name": "python-qwen3vl-worker",
      "runner_version": "qwen3vl-worker-v1",
      "precision": "fp16",
      "device": "mps",
      "distance_metric": "cosine"
    },
    "elapsed_ms": 42
  }
}
```

Error response:

```json
{
  "id": 1,
  "ok": false,
  "error": {
    "code": "mps_unavailable",
    "message": "MPS device was requested but torch.backends.mps.is_available() is false",
    "retryable": true
  },
  "elapsed_ms": 12
}
```

Error codes:

- `model_not_found`: configured local model path or cache is missing.
- `mps_unavailable`: MPS requested but not available.
- `oom`: model load or inference ran out of memory.
- `invalid_input`: missing text, unreadable image, unsupported extension, non-absolute path, or mixed payload mismatch.
- `timeout`: TypeScript request timeout killed the worker.
- `worker_crash`: worker exited before returning a response.

Timeout policy:

- Model load can take up to 600 seconds during Phase 0 setup.
- Build-time embedding requests default to 300 seconds.
- Search-time query embedding defaults to 60 seconds and should use cache whenever possible.
- The TypeScript client kills and recreates the worker after timeout, mirroring the Marlin connector pattern.

Model cache policy:

- Default cache: `~/.cache/video-os-v2/qwen3vl`.
- Project DB stores only model metadata and vectors, not model weights.
- Normal DB build/search must use local cached weights only.
- A separate explicit setup command may warm the Hugging Face cache. That setup can use network only when the operator opts in.

## 9. Local Execution Plan

Phase 0 is mandatory before Phase 1. Do not implement Qwen indexing until the local Apple Silicon path is proven.

### Phase 0 Smoke-Test Gate

Acceptance:

- Worker starts in mock mode and real mode.
- Real model loads from local cache.
- MPS is used when available.
- CPU fallback works when `VOS_QWEN3VL_DEVICE=cpu`.
- One text embedding returns dimension 2048 and finite values.
- One image embedding returns dimension 2048 and finite values.
- One mixed text plus image embedding runs, or mixed input is explicitly marked unsupported for Phase 1.
- Vector norm is approximately 1.0 when `normalize=true`.
- Peak RSS is recorded for model load and a small batch.
- Batch timing is recorded for 1, 4, and 16 representative frames.
- Failure modes map to the error codes above.

Planning memory estimates:

- 2B parameters are roughly 4 GB in fp16/bf16 before framework overhead.
- MPS runtime allocations, image preprocessing, attention implementation, and cache can push peak RSS well above raw weights.
- CPU fallback is acceptable for small builds but may be too slow for interactive search.
- Batch image embedding should start with batch size 1 to 4 and grow only after RSS is measured.

Execution policy:

- Apple Silicon MPS is the primary target.
- CPU is fallback for build-time only.
- Query-time image embedding should be cached by content hash.
- Reranker is not loaded during ordinary search.

### Frame Extraction And Cache

Frame cache path:

```text
projects/<project-id>/03_analysis/frames/{segment_id}/
```

Recommended files:

```text
representative.jpg
keyframe_in.jpg
keyframe_peak.jpg
keyframe_out.jpg
manifest.json
```

Frame source priority:

1. Existing `visual_appraisal.frame_path` if the file exists.
2. Existing `segments.filmstrip_path` only if it can be mapped to a representative source frame.
3. Existing craft/editorial frames when they cover the segment.
4. Deterministic extraction at `rep_frame_us`.
5. Deterministic extraction at midpoint.
6. Deterministic extraction at in/peak/out timestamps.

Extraction command shape:

```text
ffmpeg -hide_banner -loglevel error \
  -ss <seconds> \
  -i <source_video> \
  -frames:v 1 \
  -vf "scale='min(1024,iw)':-2,setsar=1" \
  -q:v 2 \
  <frame-cache-path>
```

The actual implementation should preserve source rotation/color handling consistently and record the final command in `manifest.json`.

Frame manifest fields:

```json
{
  "segment_id": "SEG_AST_...",
  "frame_type": "visual_representative",
  "source_video_path": "project-relative/source.mov",
  "source_timestamp_us": 1234000,
  "output_path": "03_analysis/frames/SEG_AST_.../representative.jpg",
  "source_hash": "sha256-or-source-fingerprint",
  "frame_content_hash": "sha256",
  "preprocess_version": "qwen3vl-frame-v1",
  "created_at": "builder-injected-now"
}
```

Missing source handling:

- If an existing frame path is missing, warn and try deterministic extraction.
- If the source video is missing, skip visual embeddings for that segment and keep text/FTS rows.
- If ffmpeg fails or emits a zero-byte/corrupt frame, skip that frame and warn.
- Frame cache staleness is based on source hash, timestamp, preprocess version, and output frame hash.

## 10. Score Fusion Compatibility

When Qwen is absent, preserve the current scorer exactly:

```text
semantic + lexical:
  0.55 semantic + 0.30 lexical + 0.10 quality + 0.05 peak

lexical only:
  0.75 lexical + 0.20 quality + 0.05 peak

semantic only:
  0.80 semantic + 0.15 quality + 0.05 peak

structured only:
  0.70 quality + 0.20 peak + 0.10 duration
```

Here `semantic` means the current E5 text channel.

When Qwen is present for a text query:

```text
0.35 qwen_visual
+ 0.10 qwen_text
+ 0.25 semantic
+ 0.15 lexical
+ 0.10 quality
+ 0.05 peak
```

For factual text queries where query analysis sees exact terms, place names, OCR, or transcript intent, lower visual weight:

```text
0.15 qwen_visual
+ 0.10 qwen_text
+ 0.35 semantic
+ 0.25 lexical
+ 0.10 quality
+ 0.05 peak
```

`qwen_text` is the score against `text_combined_qwen`. It is useful for same-family Qwen comparisons, but it is not allowed to replace E5 until fixtures show it improves Japanese and English text evidence retrieval. E5 remains the stable `semantic` channel in the first implementation.

When Qwen is present for an image-only query:

```text
0.80 qwen_visual
+ 0.12 quality
+ 0.05 peak
+ 0.03 duration
```

When Qwen is present for a mixed text plus image query and native mixed embeddings are not yet proven:

```text
0.55 qwen_visual
+ 0.15 semantic
+ 0.15 lexical
+ 0.10 quality
+ 0.05 peak
```

When native `mixed_representative` is proven:

```text
0.35 qwen_visual
+ 0.20 qwen_mixed
+ 0.15 semantic
+ 0.15 lexical
+ 0.10 quality
+ 0.05 peak
```

Fallback redistribution rule:

1. If Qwen channels are entirely unavailable, use the current exact formulas above.
2. If Qwen is configured but a specific Qwen channel is missing, redistribute that channel's weight proportionally across available retrieval channels: `qwen_visual`, `qwen_text`, `qwen_mixed`, `semantic`, and `lexical`.
3. Do not redistribute quality and peak weights into semantic channels. Quality and peak remain bounded editorial priors.
4. If no retrieval channels are available, use the structured-only formula only for explicitly structured queries or for text/multimodal queries where at least one non-visual retrieval channel exists.
5. For image-only visual search with no valid visual retrieval channel, return `[]` with a warning before structured-only scoring.
6. Keep deterministic tie-breakers unchanged: final score, composition score, light quality, duration, asset source order, source in, segment id.

Normalize all cosine scores to `[0, 1]` consistently with the current `(score + 1) / 2` rule unless Phase 0 proves Qwen vectors are already calibrated differently.

## 11. Storage: SQLite vs LanceDB

At current scale, SQLite BLOB scan is fine.

```text
89 segments * 2048 dims * 4 bytes = 729,088 bytes
```

That is about 712 KiB, roughly 700 KB, for one vector per segment before SQLite overhead.

Even six Qwen vectors per segment is small:

```text
89 segments * 6 vectors * 2048 dims * 4 bytes = 4,374,528 bytes
```

That is about 4.2 MiB before overhead. The target project scale of fewer than 1,000 segments does not justify ANN or a separate vector service.

Decision:

- Use project-local SQLite as the first storage layer.
- Store normalized `Float32Array` BLOBs.
- Apply SQL filters before loading vectors.
- Decode and score only eligible rows.
- Keep LanceDB as a future option for thousands of segments, cross-project libraries, many PDF pages, large photo sets, or multi-user asset management.

Matryoshka policy:

- Phase 0 and Phase 1 benchmark full 2048 dimensions first.
- Phase 5 evaluates 512 dimensions.
- Evaluate 256 dimensions only after 512 passes quality checks.
- Store each dimension as a separate `embedding_models` row.
- Treat Matryoshka as a storage/search optimization. Do not assume it reduces model inference cost unless the local runner proves a lower-compute path.

## 12. Integration With The Editorial Agent

Qwen search is a read-only retrieval capability.

### Rough Pass

Use text-to-visual discovery when a beat needs mood, lighting, texture, or visual tone:

```text
Need: warm visual B-roll for an opening
Query: 温かみのある光のシーン
Search: Qwen text-to-visual over representative frames
Return: clips with visual score, frame path, text evidence, quality fields
```

The agent should inspect top frames before adding candidates.

### Fine Pass

Use image-to-image replacement when a selected clip is semantically right but visually weak:

```text
Need: replace dim food close-up
Image anchor: previous warm detail frame
Text: close-up of food preparation
Filters: exclude selected ids, stable camera, composition >= 0.7
Decision: replace only with cited visual and text evidence
```

### QA Loop

Continuity/bridge search is deferred to a Phase 3+ multi-anchor extension. The current API can use one side of a cut as a single visual anchor for similarity, match-cut, palette, or shot-scale search, but it cannot score a candidate against both before and after frames.

Target later behavior after the multi-anchor API exists:

```text
Problem: abrupt cut at 1:30
Inputs: frame before cut, frame after cut
Search: bridge candidate with similarity to both sides
Output: one proposed insert/swap/transition, with evidence
```

### Tool Shape

Future helper around the same backend:

```ts
interface VisualSearchInput {
  image_query_path: string;
  query?: string;
  filters?: FootageSearchFilters;
  exclude_segment_ids?: string[];
  visual_goal?: "similarity" | "match_cut" | "palette" | "shot_scale";
  limit?: number;
}
```

This helper is single-anchor only. A future continuity helper must add an explicit bounded before/after shape before using the bridge formula from Section 4.

Expected output:

- `segment_id`, `asset_id`, source range
- matched `source_ref` frame path and timestamp
- score breakdown
- text evidence refs
- warnings

The public tool can remain `search_footage` initially. `visual_search` can be an internal helper until usage proves it deserves a separate public tool slot.

## 13. Migration Plan

### Phase 0: Local Smoke Test

Gate implementation on local proof:

- worker starts
- model loads
- text/image/mixed embedding behavior is known
- dimensions and normalization verified
- MPS and CPU fallback behavior recorded
- peak RSS and batch timing recorded
- no remote embedding API used

### Phase 1: Add Qwen3-VL Embeddings Alongside E5

Build:

- Add `embedding_models`.
- Add `segment_embeddings`.
- Copy legacy E5 rows into the new table or keep a compatibility reader.
- Extract/cache representative frames.
- Build `visual_representative` and `text_combined_qwen`.

Acceptance:

- Existing structured, FTS, and E5 behavior remains unchanged.
- Missing Qwen warns but does not break DB creation.
- Build report records counts and statuses for E5, Qwen text, Qwen visual, Qwen mixed, and reranker.
- Representative-frame visual search works when Qwen rows exist.

### Phase 2: Hybrid Scoring

Build:

- Add Qwen score channels.
- Preserve current exact formulas when Qwen is absent.
- Return `SearchScoreBreakdown` with weights and matched embeddings.

Acceptance:

- Text-only queries work without Qwen.
- Visual/mood text queries can rank by Qwen visual appearance.
- Image queries rank by Qwen frame similarity.
- Results explain which signal drove the match.

### Phase 3: Agent Image-Query Tools

Build:

- Extend `search_footage` with `image_query_path` and `visual_anchor`.
- Add flat adapter parameters for prompt/tool use.
- Require absolute project-local frame paths.
- Keep continuity/bridge search deferred until a future multi-anchor API is specified.

Acceptance:

- Agent can pass a frame path and get similar clips.
- Results include matched frame path and score breakdown.
- Fine-pass replacement prompts require visual evidence before replacement.
- Continuity repair is limited to single-anchor candidate discovery; bridge scoring against both sides is not accepted until the multi-anchor API exists.
- Headless/text-only fallback remains available.

### Phase 4: Optional Reranker

Deferred to a spike before implementation.

Spike must define:

- reranker worker method and model row
- input packing for query plus candidate frame/text evidence
- timeout and top-N limit
- cache key
- numeric output schema
- benchmark threshold for latency and quality

Acceptance after spike:

- Reranker is off by default.
- Reranker runs only over bounded top-N candidates.
- Reranker failure warns and falls back to fused scores.
- Reranker score is stored separately from cosine scores.

### Phase 5: Matryoshka Tuning

Benchmark 2048 vs 512 vs 256 dimensions.

Acceptance:

- Japanese visual mood queries retain quality.
- Image-to-image composition queries retain quality.
- Bridge/continuity queries retain quality only after the deferred multi-anchor API is implemented.
- DB size, RSS, and scoring time are recorded.
- The smallest acceptable dimension becomes the default for new builds only.

## 14. Risks And Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| MPS compatibility fails | Qwen cannot run interactively on Apple Silicon. | Phase 0 gate, CPU fallback for build-time, keep E5/FTS path. |
| Model size is too heavy | Build/search may exhaust memory. | Batch size 1 to 4 first, record peak RSS, use build-time worker, keep Qwen optional. |
| Embedding time is slow | DB build becomes painful. | Cache frames and query embeddings by content hash, incremental rebuild, representative frames before keyframes. |
| Single-frame temporal gap | A clip's action may not be captured by one frame. | Add in/peak/out frames, keep Marlin events and transcripts for temporal meaning. |
| Visual similarity is semantically wrong | Similar-looking clip may not serve the beat. | Fuse text/FTS/structured signals and require inspected evidence before replacement. |
| Model upgrade invalidates vectors | Old and new vectors can be compared incorrectly. | `embedding_models` FK with pinned revision, dimension, instruction, preprocess, runner, precision, normalization, metric. |
| Reranker latency is high | Interactive search stalls. | Phase 4 only, off by default, top-N only, timeout and cache required. |
| Mixed modality is immature locally | Native text plus image input may fail. | Start with separate text-to-visual and image-to-image channels, mark mixed unsupported until Phase 0 proves it. |
| Corrupted embeddings | Bad BLOBs can poison scores. | Dimension, byte length, finite value, and norm checks before scoring. |
| Worker crash or timeout | Search/build can hang or fail. | JSONL request timeout, kill/restart worker, map errors to warnings under auto policy. |
| Missing or stale frame cache | Visual rows do not match source media. | Frame manifest with source hash, timestamp, preprocess version, and content hash. |
| Japanese visual quality is unproven | Japanese prompts may underperform despite model claims. | Add Japanese fixtures for mood, light, composition, image anchors, and false positives. |
| Privacy leakage | DB contains OCR/transcripts/frame paths. | Project-local storage only, no remote embedding API, no external reporting of source paths/text. |

## 15. Constraints

- Qwen3-VL embedding and reranking must run locally. No remote embedding or reranking API is allowed.
- Explicit model cache warming may download weights only when the operator opts in. Normal build/search uses local cached weights.
- Existing E5 text embeddings stay as fallback.
- The footage DB remains derived, rebuildable, and project-local.
- No canonical artifact schemas change for this design.
- `created_at` values in new rows use the builder-injected `now`/`indexedAt` value.
- Reports and metadata must not expose source media, OCR text, transcript text, or frame paths outside the project scope.
- Japanese evaluation fixtures are required before treating Qwen visual search as reliable for editorial use.
- Reranker implementation is blocked until the Phase 4 spike defines input packing, timeout, cache, output schema, and latency threshold.

## Evaluation Fixtures

Minimum fixture set before Phase 2, plus deferred continuity coverage:

| Query type | Examples | Required checks |
| --- | --- | --- |
| Japanese mood/light | `温かみのある光のシーン`, `柔らかい室内光`, `静かな余韻` | Expected top segments, false positives, E5-only comparison. |
| English visual | `warm indoor food close-up`, `quiet wide exterior`, `hands working in soft light` | Expected top segments and alternates. |
| Image anchor | representative frame from a strong clip | Similar composition and palette should outrank text-only matches. |
| Mixed | `chestnut close-up from morning shoot` plus frame | SQL/FTS and Qwen visual channels both contribute. |
| Continuity | before/after cut frames | Deferred Phase 3+ coverage: candidate must score reasonably against both sides after the multi-anchor API exists. |

## Sources Checked

- `/Users/mocchalera/Desktop/multimodal-vector.md`
- `docs/design-multimodal-qwen3vl-unified-v1.md`
- `reports/design-review-qwen3vl-unified.md`
- `docs/research-multimodal-vector-search-models.md`
- `docs/design-multimodal-vector-search-architecture.md`
- `docs/design-footage-database-unified.md`
- `docs/explanation-footage-database.md`
- `runtime/artifacts/footage-db-builder.ts`
- `runtime/tools/footage-search.ts`
- `runtime/eval/semantic-match.ts`
- `python/marlin_worker.py`
- `runtime/connectors/marlin-local.ts`
- Official Qwen model card: https://huggingface.co/Qwen/Qwen3-VL-Embedding-2B
- Official Qwen implementation repo: https://github.com/QwenLM/Qwen3-VL-Embedding
