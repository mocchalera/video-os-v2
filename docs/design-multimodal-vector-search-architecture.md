# Design: Multimodal Vector Search Architecture

Date: 2026-06-19
Status: Perspective B design
Scope: Search architecture and editorial workflow impact for adding visual embeddings to the derived footage database.
Non-goal: No code, schema migration, model benchmark, or runtime implementation in this document.
Related: [design-footage-database-unified.md](./design-footage-database-unified.md), [design-simplified-two-model-pipeline.md](./design-simplified-two-model-pipeline.md)

## 1. Executive Summary

Text-only footage search helps the editor find what Marlin, transcripts, tags, or appraisers described. Multimodal vector search adds a different capability: finding footage by how it looks.

The practical value is not "replace Marlin with embeddings." It is:

- Marlin reports what happens and when.
- Text embeddings retrieve semantic meaning across summary, transcript, scene, and event text.
- Visual embeddings retrieve appearance: composition, palette, lighting, shot scale, texture, and broad visual mood.
- Structured filters keep search grounded in dates, asset ids, place hints, selected/unselected status, quality thresholds, and other deterministic metadata.

This justifies the engineering effort if the editorial agent can use it to make better choices in three places:

1. Rough pass selection: find visually strong alternatives without waiting for perfect labels.
2. Fine pass replacement: fix weak or visually mismatched clips with targeted full-pool search.
3. QA repair: bridge abrupt visual changes using similarity to frames before and after the cut.

At the current project scale, the architecture should stay simple: store normalized vectors as BLOBs in the project-local SQLite search DB and brute-force cosine over the filtered candidate set.

## 2. New Search Capabilities Enabled

### Visual Similarity Search

Visual similarity search starts from an image anchor, not a text phrase.

Examples:

- "Find clips that look like this frame."
- "Find another shot with similar composition to this vineyard frame."
- "Find frames with the same warm side-lighting as the opening."
- "Find a similar closeup, but without using the same asset."

This unlocks edit operations that text search handles poorly:

- **Image-to-image cosine search:** embed an inspected frame and compare it to stored visual frame embeddings.
- **Match cut detection:** find frames with similar composition, subject position, shot scale, or color mass.
- **Visual continuity:** retrieve clips whose palette, contrast, exposure, and tone are close to the neighboring clip.
- **Shot scale matching:** find another closeup, wide, detail shot, or centered subject even when `shot_scale` labels are absent or incomplete.

The important editorial shift is that the agent can react to what it sees. If the rough pass surfaces a beautiful frame, the next question can be "more like this" instead of "which words might describe this?"

### Cross-Modal Search

Cross-modal search uses text as the query but ranks visual embeddings.

Examples:

- `warm sunset scene` finds visually warm clips even when Marlin did not say "warm."
- `柔らかい光` finds soft-lighting clips even when the indexed text is English.
- `quiet, reflective ending` finds low-motion, soft-toned clips that visually express the requested emotion.
- `clean product-like detail shot` finds composed details even if the summary only says "hands preparing food."

This is especially useful for Japanese editorial briefs because the brief often names a mood, texture, or tone rather than a literal object. Text-only embeddings can bridge Japanese and English descriptions, but only if the relevant visual property was described. Visual embeddings reduce dependence on whether Marlin or a captioning pass happened to name the property.

### Hybrid Search

Hybrid search is the normal editor-facing mode. It combines text meaning, visual appearance, and structured constraints.

Examples:

- `closeup of hands, warm light, from Aug 21`
  - text query: closeup of hands
  - visual query: warm light
  - structured filter: `shooting_date = 2026-08-21`

- `similar to clip X but different location`
  - visual anchor: representative or key frame from clip X
  - structured exclusion: same `place_hint_name` or same asset

- `unused clips with similar energy to the opening`
  - visual anchor: opening frames
  - structured exclusion: selected segment ids
  - structured preference: high `motion_quality` or matching camera motion

- `bridge the abrupt cut at 1:30`
  - visual anchors: frame before the cut and frame after the cut
  - scoring: candidate frame should be moderately similar to both sides
  - structured exclusion: clips already used around the cut

The search tool should return enough evidence for the editor to act responsibly: `segment_id`, `asset_id`, source range, score breakdown, matched embedding types, frame path, structured filters applied, and warnings when an embedding type was unavailable.

## 3. Embedding Storage Design

The current footage DB design already has text embedding rows keyed by `segment_id`, `field`, and `model_id`. Multimodal search should extend that idea into a single embedding registry that can store text and visual vectors side by side.

Target shape:

```sql
CREATE TABLE embeddings (
  segment_id TEXT NOT NULL REFERENCES segments(segment_id) ON DELETE CASCADE,
  embedding_type TEXT NOT NULL CHECK (
    embedding_type IN (
      'text_summary',
      'text_transcript',
      'text_scene',
      'text_combined',
      'visual_representative',
      'visual_keyframe_in',
      'visual_keyframe_peak',
      'visual_keyframe_out'
    )
  ),
  model_id TEXT NOT NULL,
  dimension INTEGER NOT NULL CHECK (dimension > 0),
  vector BLOB NOT NULL,
  source_ref TEXT NOT NULL DEFAULT '',
  source_timestamp_us INTEGER CHECK (source_timestamp_us IS NULL OR source_timestamp_us >= 0),
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (segment_id, embedding_type, model_id, source_ref)
);

CREATE INDEX idx_embeddings_type_model ON embeddings(embedding_type, model_id);
CREATE INDEX idx_embeddings_segment_type ON embeddings(segment_id, embedding_type);
```

The minimum additive implementation can keep the existing `field` column for text embeddings and add visual rows through a compatible migration later. The design intent is the same either way: one segment can have multiple embeddings.

Per segment, store:

- `text_summary`: summary, tags, quality labels.
- `text_transcript`: transcript excerpt and overlapping transcript text.
- `text_scene`: Marlin scene and overlapping event text.
- `text_combined`: summary, transcript, scene, tags, OCR, place, and appraisal notes.
- `visual_representative`: existing representative or appraisal frame.
- `visual_keyframe_in`: frame near selected or candidate in point.
- `visual_keyframe_peak`: frame at Marlin event peak, visual peak, or segment midpoint fallback.
- `visual_keyframe_out`: frame near out point or end hold.

Frame references should point to durable extracted files when available:

```text
projects/<project-id>/03_analysis/craft_frames/*
projects/<project-id>/03_analysis/editorial_tool_frames/*
segment.visual_appraisal.frame_path
segment.filmstrip_path
```

Store vectors as normalized `Float32Array` BLOBs, matching the current text embedding storage pattern:

```ts
const vectorBuffer = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
```

Query behavior:

1. Determine whether the query is text, image, or hybrid.
2. Embed the query through the matching model path.
3. Apply structured filters first.
4. Load only the relevant embedding types and model ids for eligible segments.
5. Decode BLOBs into `Float32Array`.
6. Compute cosine similarity in TypeScript.
7. Collapse multiple frame scores per segment into a segment score.

Recommended visual score collapse:

```text
segment_visual_score =
  max(
    visual_representative_score,
    visual_keyframe_in_score,
    visual_keyframe_peak_score,
    visual_keyframe_out_score
  )
```

For continuity checks, use a different collapse:

```text
bridge_score =
  min(
    cosine(candidate_visual_vec, before_cut_vec),
    cosine(candidate_visual_vec, after_cut_vec)
  )
```

The `min` rule prevents a bridge clip from matching only one side of the cut.

## 4. Search Scoring Architecture

The search layer should make score fusion explicit and report the breakdown. A high final score is only useful to an editor if the agent can tell whether it came from text meaning, visual appearance, quality metadata, or structured filters.

General formula:

```text
final_score =
  w_text * text_score +
  w_visual * visual_score +
  w_structured * structured_filter_score
```

Where:

- `text_score` is the normalized best text vector score, optionally fused with FTS rank.
- `visual_score` is the normalized best visual frame score for the segment.
- `structured_filter_score` is 1.0 for hard filters that pass, plus optional soft boosts for quality, peak strength, duration fit, and beat-specific metadata.

Default weights should depend on query type:

| Query type | w_text | w_visual | w_structured | Use case |
| --- | ---: | ---: | ---: | --- |
| Text-only | 0.5 | 0.3 | 0.2 | `warm sunset scene`, `柔らかい光` |
| Image query | 0.2 | 0.6 | 0.2 | "find clips that look like this frame" |
| Hybrid | 0.3 | 0.4 | 0.3 | "closeup hands, warm light, from Aug 21" |

Text-only queries still get visual weight when the visual embedding model supports text-image alignment. If the selected visual model does not support cross-modal text queries, redistribute visual weight to text and structured signals and include a warning:

```text
visual text-query embedding unavailable; redistributed visual weight to text and structured scores
```

Recommended score breakdown returned by `search_footage`:

```ts
interface MultimodalScoreBreakdown {
  text?: number;
  lexical?: number;
  visual?: number;
  structured?: number;
  quality?: number;
  peak?: number;
  final: number;
  weights: {
    text: number;
    visual: number;
    structured: number;
  };
  embedding_matches?: Array<{
    embedding_type: string;
    model_id: string;
    score: number;
    frame_path?: string;
    timestamp_us?: number;
  }>;
}
```

Hard filters remain hard:

- `exclude_segment_ids`
- `asset_ids`
- `shooting_date`
- `place_hint_name` when explicitly requested
- `min_duration_us` and `max_duration_us`
- selected/unselected constraints

Soft editorial preferences should be boosts, not filters, unless the user or agent explicitly asks for hard exclusion:

- similar color tone
- stronger lighting
- matching motion energy
- better composition
- higher emotional expression
- similar shot scale

This matters because visual embeddings are approximate. They are excellent for ranking candidates to inspect, but they should not silently delete plausible editorial options.

## 5. Editorial Agent Workflow Changes

### Rough Pass

Current rough pass behavior already gives the interactive agent representative frames and Marlin reports. Multimodal search turns those frames into active retrieval anchors.

New workflow:

1. Agent reads representative frames for all assets.
2. Agent identifies a visually strong anchor:
   - "this vineyard shot is beautiful"
   - "this hand-detail shot has the right warmth"
   - "this opening frame has the right calm energy"
3. Agent calls visual similarity search:
   - image anchor: representative frame path
   - filters: exclude rejected/low-quality flags, optionally exclude same asset
   - limit: small, usually 8-12
4. Footage DB returns visually similar frames with score breakdown and frame paths.
5. Agent inspects returned frames before adding or promoting candidates.

What improves:

- Strong shots can seed more strong shots even if text labels are thin.
- Initial selection can include visual variety and continuity earlier.
- The agent can find texture, establishing shots, detail shots, and emotional inserts without guessing the right caption vocabulary.

Guardrail:

The rough pass should not expand search endlessly. It should use visual search when compact evidence is insufficient, when a beat lacks a strong candidate, or when a discovered anchor clearly defines the visual style of the edit.

### Fine Pass

Current fine pass already inspects key frames, Marlin events, and optional tools. Multimodal search adds targeted replacement and continuity repair.

New workflow:

1. Agent reads the selected clip key frames.
2. Agent detects a specific weakness:
   - lighting does not match the previous clip
   - shot scale breaks the sequence
   - composition is weaker than neighboring clips
   - the clip is semantically right but visually flat
3. Agent searches for replacements:
   - text condition: same beat/content need
   - visual condition: better lighting or similarity to adjacent clip
   - structured condition: exclude selected segment ids, exclude same location if needed
4. Agent cites returned `segment_id`, `evidence_refs`, score breakdown, and inspected frame path in `revision_notes`.
5. Agent updates only the affected candidate or beat plan through existing schema-compatible output.

Example:

```text
Selected clip: hands preparing food, but key frames are dim.
Query: "closeup of hands food preparation"
Visual anchor: previous warm detail shot
Filters: exclude selected ids, quality_min.light_quality >= 0.6
Decision: replace only if the result is semantically equivalent and visually stronger.
```

What improves:

- Replacement search is no longer text-only.
- Visual continuity can be checked before compile instead of only after render.
- The fine pass can repair specific weaknesses without churning the whole edit.

### QA Loop

Marlin QA can identify viewer-visible issues in the rendered rough cut. Multimodal search gives the agent a repair mechanism for abrupt visual changes.

New workflow:

1. Marlin QA reports an abrupt visual change at `1:30`.
2. Agent extracts or receives frames before and after the cut.
3. Agent embeds both frames.
4. Agent searches for a bridge clip:
   - high enough similarity to both sides
   - not already used near the cut
   - compatible duration and beat role
5. Agent proposes one local change:
   - insert a short bridge
   - swap the incoming clip
   - adjust transition/craft if a bridge would hurt pacing

Bridge scoring:

```text
bridge_score =
  0.45 * similarity_to_before +
  0.45 * similarity_to_after +
  0.10 * structured_fit
```

Alternative conservative scoring:

```text
bridge_score =
  0.80 * min(similarity_to_before, similarity_to_after) +
  0.20 * structured_fit
```

The conservative scoring is better for continuity because it punishes clips that match only one side.

## 6. Search API Implications

The existing tool names can remain, but the parameter surface needs image-aware inputs.

Possible additive `search_footage` extension:

```ts
interface SearchFootageInput {
  query: string;
  mode?: "hybrid" | "text" | "semantic" | "structured" | "visual" | "multimodal";
  image_query_path?: string;
  visual_anchor?: {
    segment_id?: string;
    frame_path?: string;
    timestamp_us?: number;
    embedding_type?: "visual_representative" | "visual_keyframe_in" | "visual_keyframe_peak" | "visual_keyframe_out";
  };
  visual_goal?: "similarity" | "continuity" | "match_cut" | "palette" | "shot_scale";
  text_match?: string;
  semantic?: string;
  filters?: FootageSearchFilters;
  limit?: number;
}
```

Convenience helpers become more meaningful:

- `similar_to(segment_id)` should default to visual similarity when visual embeddings exist, and text similarity when they do not.
- `unused_footage(...)` can accept a visual anchor from the opening or current beat.
- `best_for_beat(...)` can combine beat purpose text with a visual mood anchor.

Tool responses should preserve current fallback behavior:

- If the DB is missing, use JSON fallback and warn.
- If visual embeddings are missing, run text/structured search and warn.
- If an image path is unreadable, fail that visual part and keep text/structured search available when possible.
- Search tools remain read-only. They never write selects, blueprints, timelines, or media.

## 7. Performance Considerations

The target scale is small:

```text
89 segments * 3-5 visual embeddings each = 267-445 visual vectors
```

At this scale:

- Brute-force cosine is fine.
- SQLite BLOB scan is fine after structured filters.
- ANN, `sqlite-vss`, `sqlite-vec`, or a remote vector store is unnecessary.
- The implementation should optimize correctness, transparency, and fallback behavior before indexing sophistication.

Expected vector counts per segment:

| Type | Count |
| --- | ---: |
| Text summary/scene/combined | 1-4 |
| Representative visual frame | 1 |
| Key visual frames | 2-4 |
| Total per segment | 3-8 |

Vision embedding inference is the main cost. The builder should therefore be incremental:

- Hash source frame bytes or frame extraction metadata.
- Store `content_hash` per embedding row.
- Re-embed only when the source frame or model id changes.
- Keep `embedding_status` separate for text and visual families.
- Allow `embeddingPolicy: "auto"` to build text/structured DB even when visual inference is unavailable.

Recommended metadata keys:

| Key | Example |
| --- | --- |
| `text_embedding_status` | `ready`, `skipped`, `unavailable`, `error` |
| `text_embedding_model_id` | `Xenova/multilingual-e5-small:q8` |
| `visual_embedding_status` | `ready`, `skipped`, `unavailable`, `error` |
| `visual_embedding_model_id` | `clip-vit-b-32`, `siglip-base` |
| `visual_embedding_count` | `356` |

For local editorial workflows, partial availability is acceptable. A project with structured search plus representative visual embeddings is already useful; key-frame embeddings can arrive later.

## 8. Migration From Text-Only To Hybrid

### Phase 1: Add Visual Embeddings Alongside Text

Add visual rows to the derived search DB without changing canonical artifacts.

Implementation boundaries:

- No changes to `segments.schema.json`, `selects-candidates.schema.json`, or `edit-blueprint.schema.json`.
- No change to where editorial decisions are materialized.
- Keep current text search behavior as the fallback.
- Reuse existing frame extraction products when possible.

Acceptance criteria:

- Existing text and hybrid searches still work.
- Build report shows visual embedding status and count.
- Missing visual model files warn but do not break structured/FTS search.

### Phase 2: Update Hybrid Scoring

Introduce explicit text/visual/structured weights and return score breakdowns.

Acceptance criteria:

- Text-only query can still rank without visual vectors.
- Image query ranks by visual vectors when available.
- Hybrid query applies structured filters before vector scoring.
- Search result explains which signal won.

### Phase 3: Agent Tools Gain Image-Query Capability

Extend the tool adapter with `image_query_path` or `visual_anchor`.

Acceptance criteria:

- Fine pass can search from a key-frame path.
- Returned candidates include inspected frame paths.
- Prompt requires citation of query, result `segment_id`, evidence refs, and frame path before replacement.
- Headless fallback remains text-only or warning-driven when image embedding is unavailable.

### Phase 4: Match Cut And Continuity Checks

Add compile-time or pre-render checks that use visual embeddings for targeted warnings.

Possible checks:

- Adjacent clips with very low visual similarity and no intentional transition.
- Candidate match-cut opportunities between adjacent frames.
- Abrupt color/tone jumps in a calm sequence.
- Repeated visually near-duplicate shots too close together.

Acceptance criteria:

- Checks warn first; they do not block compile by default.
- Warnings cite clip ids, frame paths, and scores.
- Agent can use warnings to run targeted repair search.

## 9. What This Means For The Two-Model Architecture

The two-model architecture still holds.

Marlin remains the primary video reporter:

- temporal events
- scene descriptions
- action boundaries
- visible facts
- post-render QA observations

Visual embeddings are complementary:

- appearance similarity
- color and lighting proximity
- composition and shot-scale proximity
- visually expressed mood
- frame-to-frame continuity

The clean split is:

```text
Marlin understands WHAT happens.
Visual embeddings capture HOW it looks.
Claude/Codex decides WHY and WHERE to use it.
Compile executes the decision deterministically.
```

Examples:

| Need | Best signal |
| --- | --- |
| "Find the chestnut scene" | Marlin/text semantic search |
| "Find the customer smiling" | Marlin events plus text search |
| "Find something that looks like this" | Visual embedding search |
| "Find a warm soft-light ending" | Cross-modal visual search plus quality metadata |
| "Find similar energy but different location" | Visual similarity plus structured exclusion |
| "Bridge this abrupt cut" | Before/after frame embeddings plus structured fit |

This avoids a common architecture mistake: asking a vector model to become a scene reporter. It should not. Marlin produces interpretable facts; visual embeddings produce dense appearance proximity; the editorial agent uses both.

## 10. Practical Recommendation

This is worth building, but only as an additive search-layer upgrade.

High-confidence value:

- Better rough-pass discovery from real visual anchors.
- Better fine-pass replacements when a clip is semantically right but visually weak.
- Better QA repair for abrupt visual changes.
- Less dependence on whether Marlin used the exact adjective the editor has in mind.

Risks:

- Visual similarity can produce plausible but semantically wrong matches.
- Cross-modal mood search depends strongly on the selected visual embedding model.
- Additional frame extraction and embedding status can complicate the build report.
- Agent prompts can over-search unless constrained to beat gaps, inspected weaknesses, or QA issues.

Controls:

- Keep search read-only.
- Keep canonical artifacts unchanged.
- Apply structured filters before vector scoring.
- Return score breakdowns and frame paths.
- Require frame inspection before replacement.
- Warn and degrade to text/structured search when visual embeddings are unavailable.

The MVP should target one editorial behavior first:

```text
Given a selected clip key frame, find unused clips that look visually similar
or visually bridge to an adjacent clip, then cite the returned evidence before
recommending a replacement.
```

If that improves real fine-pass decisions, expand to rough-pass visual discovery and compile-time continuity checks.
