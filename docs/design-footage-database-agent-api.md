# Design: Footage Database Agent API

> Date: 2026-06-19
> Status: Draft
> Scope: Agent-queryable footage search API for the editorial pipeline
> Non-goal: No code, schema, runtime, or project artifact changes in this task
> Related: [design-simplified-two-model-pipeline.md](./design-simplified-two-model-pipeline.md), [p4d-segment-search-index-implementation-notes.md](./p4d-segment-search-index-implementation-notes.md), [research-local-embedding-semantic-match.md](./research-local-embedding-semantic-match.md)

## Design Inputs

This design is anchored to the current repo surfaces:

- `runtime/tools/editorial-tools.ts`: editorial tools are named tool definitions plus async executors; current tools inspect selected clips through Marlin and frame extraction.
- `runtime/tools/marlin-tools.ts`: Marlin already supports bounded range analysis, moment finding, and frame extraction with local cache behavior.
- `runtime/agents/unified-editorial-agent.ts`: rough pass receives all material in compact form, fine pass receives selected clips plus key frames, and interactive prompts expose optional tools.
- `runtime/eval/semantic-match.ts`: local multilingual E5 embeddings are available behind a fail-open loader.
- `docs/design-simplified-two-model-pipeline.md`: the target pipeline is Marlin for perception, Claude/Codex for editorial decisions, deterministic compile/render, and Marlin QA for improvement loops.

Assumptions:

- MVP should read existing artifacts and avoid schema changes.
- Search indexes are derived and optional.
- Search results are evidence for the editorial agent, not direct artifact mutations.

## 1. Agent Query Patterns

The core problem is not that `segments.json` is flat. The core problem is that the editor agent currently receives a bounded evidence packet, makes a first selection, and then cannot ask the full footage pool a concrete follow-up question. The footage database should therefore be designed around questions the editor asks while building and repairing an edit.

### Semantic Queries

Semantic queries are taste and story queries. They should use embeddings, lexical fields, brief context expansion, and quality weighting.

Examples:

- "warm indoor scenes"
- "nature beauty shots"
- "human connection moments"
- "process shots that feel careful and handmade"
- "closing shot with sunset"
- "texture shot for a quiet transition"
- "credible proof moment, not just atmosphere"

Agent intent:

- Fill a beat with an emotionally appropriate clip.
- Find alternatives when a current clip is visually weak.
- Discover material that triage missed because it was not an obvious must-have.
- Balance the arc with a different visual mode, such as detail, place, reaction, or texture.

Required searchable evidence:

- Segment `summary`, `tags`, `interest_points`, `transcript_excerpt`.
- Marlin asset scene and temporal events.
- `visual_quality.labels` such as lighting, composition, expression, and motion tags.
- `visual_appraisal.aesthetic_notes`.
- Brief `context_knowledge` aliases and subject/place terminology.

### Factual Queries

Factual queries ask for visible or known facts. These should prefer exact/fuzzy text match, structured metadata filters, OCR text, place hints, and Marlin event text over pure embeddings.

Examples:

- "clips from the vineyard"
- "shots with visible text/signage"
- "scenes with the elderly man"
- "food preparation closeups"
- "bakery exterior"
- "clips where someone is holding chestnuts"
- "shots where the product label is readable"

Agent intent:

- Satisfy brief must-haves.
- Avoid incorrect subject/place assumptions.
- Recover missing proof shots after QA says the edit lacks context.
- Locate signage or text for credibility, orientation, or a transition.

Required searchable evidence:

- `visual_appraisal.extracted_text`.
- `visual_appraisal.place_hint`.
- Marlin scenes/events.
- Segment summaries/tags.
- Asset/source metadata when available.
- Brief `context_knowledge.location`, `subjects`, `key_items`, and `terminology`.

### Technical Queries

Technical queries select usable footage, not just relevant footage. These should be filterable without relying on model judgment at query time.

Examples:

- "well-composed shots with composition > 0.8"
- "clips without camera shake"
- "clips > 5s duration"
- "stable motion shots for a clean transition"
- "clips with subject prominence above 0.7"
- "avoid dark or blurry material"
- "good light, no quality flags"

Agent intent:

- Keep the fine pass from swapping into unusable footage.
- Choose among semantically similar clips by objective visual quality.
- Find bridge or closing shots that can hold for longer than the average cut.

Required searchable evidence:

- `duration_us`, `src_in_us`, `src_out_us`.
- `quality_flags`.
- `visual_quality.scores.light_quality`.
- `visual_quality.scores.subject_prominence`.
- `visual_quality.scores.emotional_expression`.
- `visual_quality.scores.composition_score`.
- `visual_quality.scores.motion_quality`.
- `peak_analysis.recommended_in_out`.

### Temporal Queries

Temporal queries preserve chronology, shooting order, and location continuity. They should be answerable even when the final edit is not chronological.

Examples:

- "morning shots from day 1"
- "what was filmed after the bakery visit?"
- "clips immediately before the vineyard sequence"
- "same location but later in the day"
- "a bridge between the kitchen and exterior"

Agent intent:

- Repair continuity issues.
- Add an establishing shot before a subject appears.
- Respect a brief with chronological order policy.
- Find source-neighbor material around a selected segment.

Required searchable evidence:

- Source asset order and timestamps.
- Asset creation or shooting date when available.
- Segment `asset_id`, `src_in_us`, `src_out_us`.
- Place hints and any source manifest location metadata.
- Prior selected candidate order from `selects_candidates.yaml` and `timeline.json`.

### Comparative Queries

Comparative queries ask the database to rank candidates for an editorial role.

Examples:

- "which vineyard clip has the best light?"
- "strongest emotion moment across all footage"
- "best closing shot among warm outdoor scenes"
- "best alternative to this clip with less shake"
- "strongest signage shot that still feels natural"

Agent intent:

- Make a choice, not just retrieve a list.
- Find the highest-quality substitute during the improvement loop.
- Resolve QA feedback with the smallest replacement.

Required searchable evidence:

- Combined relevance score.
- Quality score breakdown.
- Peak moment strength.
- Match reason with evidence fields.
- Optional diversity constraints, such as different `asset_id`, place category, or semantic cluster.

### Negative Queries

Negative queries are essential for iteration. The agent should not keep returning clips that are already selected, already rejected, or already used in the timeline.

Examples:

- "anything NOT yet selected"
- "clips we haven't used that show food"
- "unused high-quality transition shots"
- "not the same location as result 3"
- "avoid dialogue"

Agent intent:

- Find real alternatives.
- Avoid repetition during the fine pass.
- Repair QA issues without churn.

Required searchable evidence:

- `exclude_segment_ids`.
- Already selected candidates.
- Timeline clip usage.
- Rejected candidates and their rejection reasons.
- Optional diversity constraints.

## 2. Query API Design

The first API should be small enough for an agent to call reliably. It should accept natural language plus structured filters, and it should return ranked, inspectable results with enough evidence to justify use in `selects_candidates.yaml` and `edit_blueprint.yaml`.

```typescript
interface FootageQuery {
  semantic?: string;           // Natural-language query.
  text_match?: string;         // Exact/fuzzy text search over summaries, events, OCR, tags, transcript.
  filters?: {
    shooting_date?: string;
    time_range?: [string, string];
    min_duration_us?: number;
    max_duration_us?: number;
    quality?: { field: string; min: number };
    place_category?: string;
    has_text?: boolean;
    has_dialogue?: boolean;
    exclude_segment_ids?: string[];
  };
  sort_by?: "relevance" | "quality" | "chronological" | "duration";
  limit?: number;
}

interface FootageResult {
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  duration_us: number;
  score: number;
  match_reason: string;
  summary: string;
  key_frame_path?: string;
  tags?: string[];
  transcript_excerpt?: string;
  quality?: {
    light_quality?: number;
    subject_prominence?: number;
    emotional_expression?: number;
    composition_score?: number;
    motion_quality?: number;
    quality_flags?: string[];
  };
  place_hint?: {
    name?: string | null;
    category?: string;
    confidence?: number;
  };
  extracted_text?: Array<{
    text: string;
    confidence?: number;
  }>;
  peak?: {
    timestamp_us?: number;
    type?: "action_peak" | "emotional_peak" | "visual_peak";
    confidence?: number;
    description?: string;
  };
  evidence_refs?: Array<{
    field: string;
    value: string;
    score?: number;
  }>;
}
```

Recommended response wrapper:

```typescript
interface FootageSearchResponse {
  query: FootageQuery;
  rewritten_query?: {
    semantic?: string;
    text_terms?: string[];
    context_expansions?: string[];
  };
  results: FootageResult[];
  warnings?: string[];
}
```

### Filter Semantics

The API should keep filter names simple but define them tightly:

- `shooting_date`: source shooting date when asset metadata provides it. If absent, the filter should warn and avoid date-specific claims.
- `time_range`: source shooting time or asset-local time range, depending on available metadata. The response should state which interpretation was used.
- `min_duration_us` / `max_duration_us`: compare against `duration_us` or `src_out_us - src_in_us`.
- `quality.field`: one of `light_quality`, `subject_prominence`, `emotional_expression`, `composition_score`, `motion_quality`, or a future whitelisted score.
- `place_category`: compare against `visual_appraisal.place_hint.category`, context-expanded place descriptions, and source metadata when present.
- `has_text`: true when OCR, transcript, or visible text evidence exists. For signage-only queries, the agent should also pass `text_match` or semantic text such as "visible signage".
- `has_dialogue`: true when `transcript_excerpt` or transcript refs indicate speech/dialogue.
- `exclude_segment_ids`: hard exclusion, used for already selected, rejected, or timeline-used clips.

### Scoring Contract

`score` is a retrieval score, not an editorial mandate. The agent still decides whether a clip fits the beat.

Default `sort_by: "relevance"` should combine:

- Semantic similarity between query and searchable segment text.
- Text/OCR/place exact and fuzzy matches.
- Quality prior from `visual_quality.scores` and `quality_flags`.
- Peak prior when the query asks for action, emotion, or a closing moment.
- Context expansion hits from `context_knowledge`.

`sort_by: "quality"` should prioritize technical/aesthetic scores after applying relevance and filters. It should not return unrelated beautiful footage.

`sort_by: "chronological"` should preserve source order after applying relevance and filters.

`sort_by: "duration"` should rank longer usable ranges first, useful for holds, bridges, and closing beats.

### Match Reason Contract

Every result must include a human-readable `match_reason` that can become candidate evidence. It should name the matching fields, not just say "semantic match".

Good:

- `semantic match "warm indoor scenes" against summary; light_quality=0.84; key frame available`
- `OCR text matched "OPEN"; place_hint.category=storefront; no quality flags`
- `context expansion matched chestnuts -> 栗 in tags and Marlin event`

Bad:

- `matched`
- `high relevance`
- `model says good`

### Failure Behavior

Search must be fail-open for the editorial pipeline:

- If embeddings are unavailable, fall back to lexical and structured search with a warning.
- If key frames are missing, return results without `key_frame_path`.
- If the search index is stale or missing, use direct `segments.json` plus Marlin/appraisal artifacts where available.
- If a filter references a missing field, return a warning and do not invent values.
- Tool failure should not block compile/render unless the agent has made search-derived replacements that cannot be validated.

### API-To-Index Mapping

The storage/index should be derived from the API's evidence needs, not the other way around.

| API need | Primary source | Index shape |
| --- | --- | --- |
| Semantic query | segment summary, tags, transcript excerpt, Marlin scene/events, appraisal notes, context expansions | per-segment passage text plus optional embedding vector |
| Exact/fuzzy text | OCR, transcript, tags, summary, event descriptions | normalized token refs with source field ids |
| Quality filter/sort | `visual_quality.scores`, `quality_flags`, peak support signals | numeric columns or in-memory sortable fields |
| Place query | `visual_appraisal.place_hint`, context locations, source metadata | normalized place tokens plus optional category field |
| Temporal query | asset order, shooting metadata, segment source ranges | sortable source order and timestamp fields |
| Negative query | selected/rejected/timeline-used segment ids | runtime exclusion set, not a persistent index concern |
| Key-frame inspection | representative frames, craft/key frame extraction paths | path resolver from segment/asset id to local frame file |

MVP can build this in memory from existing artifacts. A persistent `03_analysis/search/*` index is a performance and reproducibility optimization after behavior is proven.

## 3. Multi-Modal Query Flow

The tool flow should mirror how a human editor looks for alternatives.

### Step 1: Ask A Semantic Question

The agent calls:

```typescript
search_footage({
  semantic: "warm closing shot with sunset or afterglow",
  filters: {
    min_duration_us: 3000000,
    quality: { field: "light_quality", min: 0.65 },
    exclude_segment_ids: selectedSegmentIds
  },
  sort_by: "relevance",
  limit: 8
})
```

The response returns ranked results with `match_reason`, summary, quality fields, and `key_frame_path` where available.

### Step 2: Inspect Key Frames

In interactive mode, the prompt should tell the repo-side agent:

- Read the top 3-5 `key_frame_path` values before choosing.
- Prefer the first result only if the frame confirms the match.
- If the frame is ambiguous, use existing tools such as `extract_frame`, `compare_frames`, or `analyze_clip_range`.

This extends the existing fine-pass pattern, where key frames are surfaced as absolute paths and the agent uses the Read tool before deciding.

### Step 3: Refine

The agent can ask:

```typescript
similar_to({
  segment_id: "SEG_042",
  different_location: true,
  exclude_segment_ids: selectedSegmentIds,
  limit: 6
})
```

or:

```typescript
search_footage({
  semantic: "more like SEG_042: warm human reaction, but different location and steadier camera",
  filters: {
    exclude_segment_ids: [...selectedSegmentIds, "SEG_042"],
    quality: { field: "motion_quality", min: 0.7 }
  },
  sort_by: "quality",
  limit: 6
})
```

The API does not need to understand every editorial phrase as a structured filter in MVP. It needs to provide enough evidence and diversity metadata for the agent to refine safely.

### Step 4: Select For A Beat

When the agent chooses a result, it must convert it into the existing canonical planning surfaces:

- Add or update a candidate in `selects_candidates.yaml`.
- Cite search evidence in `why_it_matches` and `evidence`.
- Keep `segment_id`, `asset_id`, `src_in_us`, and `src_out_us` from the result.
- Put the chosen candidate into `edit_blueprint.yaml` as a primary or fallback candidate for the relevant beat.
- Preserve schema compatibility. Search metadata should stay in evidence strings, provenance, or optional sidecar traces unless schemas are intentionally expanded later.

The search API should never write `selects_candidates.yaml`, `edit_blueprint.yaml`, `timeline.json`, or media files directly. It supplies evidence; the editorial agent decides and the existing normalizers validate.

## 4. Integration As Editorial Tool

The existing `runtime/tools/editorial-tools.ts` toolkit already exposes fine-pass tools:

- `analyze_clip_range`
- `find_moment`
- `extract_frame`
- `compare_frames`

The footage database should extend that same editorial toolkit with four query tools. These are design targets, not code changes in this document task.

### `search_footage`

Purpose: semantic plus structured search over the full footage pool.

Inputs:

```typescript
{
  semantic?: string;
  text_match?: string;
  filters?: FootageQuery["filters"];
  sort_by?: FootageQuery["sort_by"];
  limit?: number;
}
```

Returns: `FootageSearchResponse`.

Agent use:

- Rough pass: discover initial candidates beyond a compact prompt packet.
- Fine pass: find replacements when key frames show a weak clip.
- QA loop: answer a specific QA revision intent, such as "replace dark closing shot".

### `similar_to`

Purpose: find alternatives similar to a known segment while allowing diversity constraints.

Inputs:

```typescript
{
  segment_id: string;
  different_location?: boolean;
  different_asset?: boolean;
  min_quality?: number;
  exclude_segment_ids?: string[];
  limit?: number;
}
```

Returns: ranked `FootageResult[]`.

Agent use:

- "Show me more like result #3 but from a different location."
- Replace a clip without changing beat intent.
- Find a fallback candidate for the same beat.

### `unused_footage`

Purpose: query good clips that are not already selected or used in the timeline.

Inputs:

```typescript
{
  selected_segment_ids: string[];
  semantic?: string;
  min_quality?: number;
  limit?: number;
}
```

Returns: ranked `FootageResult[]`.

Agent use:

- Avoid repetition.
- Recover overlooked support, texture, or bridge material.
- Ask "what good clips haven't we selected yet?"

### `best_for_beat`

Purpose: rank clips for an explicit beat role and intent.

Inputs:

```typescript
{
  beat_id?: string;
  story_role?: "hook" | "setup" | "experience" | "payoff" | "reaction" | "closing";
  beat_purpose: string;
  required_visuals?: string[];
  avoid_segment_ids?: string[];
  limit?: number;
}
```

Returns: ranked `FootageResult[]` with beat-specific reasons.

Agent use:

- "What's the strongest clip for a warmth beat?"
- "Find a better closing shot."
- "Find a bridge for the continuity issue at 1:30."

### Prompt Changes

The current fine pass explicitly says not to add candidates outside Pass 1 selects. With search tools, that rule should change to:

- Default to the selected pool for trim and craft decisions.
- Use `search_footage`, `similar_to`, or `best_for_beat` only when the current candidate is weak, QA requires replacement, or the beat lacks coverage.
- Any new candidate must cite the search result and inspected key frame evidence.
- Prefer the smallest replacement that fixes the issue.

This preserves the stability of the two-pass pipeline while allowing full-pool access when it matters.

## 5. Context-Aware Search

The query layer should treat `creative_brief.yaml` `context_knowledge` as a query-time expansion source. It should not rewrite the canonical footage facts. It should improve recall and then expose the expansion in `rewritten_query.context_expansions` and `match_reason`.

### Terminology Expansion

If the brief says:

```yaml
context_knowledge:
  terminology:
    - term: 栗
      meaning: chestnuts
```

Then:

- Searching "chestnuts" should also match `栗`, `kuri`, and any configured local synonyms.
- Searching `栗` should also match "chestnut" and "chestnuts".
- The result should say `context expansion matched chestnuts -> 栗`.

This aligns with the existing context-knowledge helper pattern, which already normalizes terminology for prompt payloads and misidentification correction.

### Location Expansion

If the brief includes:

```yaml
context_knowledge:
  location:
    primary_location: Ena, Gifu
    specific_places:
      - name: vineyard
        description: hillside grape field visited after the bakery
```

Then:

- Searching "vineyard" should match the place name, description, place hints, Marlin text, tags, and source metadata if present.
- If source media includes GPS, shooting date, or route/timestamp metadata, the search service can expand "near the vineyard" into those structured constraints.
- If only text evidence exists, the API should return text-grounded results and avoid pretending it has GPS certainty.

### Subject Expansion

If the brief includes:

```yaml
context_knowledge:
  subjects:
    - name: the elderly artisan
      role: maker
      appearance: gray hair, apron, careful hand work
```

Then:

- Searching "elderly artisan" should match the name, role, and appearance description.
- It should search Marlin/appraiser descriptions for "gray hair", "apron", "hands", "maker", and similar terms.
- It should not claim biometric identity from a face unless identity was explicitly annotated in the source evidence.

### Context Weighting Rules

Context expansions should boost recall, not override evidence:

- A context-expanded hit still needs footage evidence.
- `match_reason` must name whether the hit came from summary, tags, OCR, place hint, Marlin event, or context expansion.
- If a context expansion creates noisy matches, the agent should refine with filters or inspect frames before selection.

## 6. Editorial Pipeline Changes

### Current Flow

Current two-pass behavior is:

1. Rough pass sees all available material in compact form and selects 30-50 clips when enough material exists.
2. Fine pass inspects selected clips with key frames and tools.
3. If a clip is weak, fine pass can flag it or use existing fallback candidates, but it cannot search the full pool.
4. QA feedback can identify issues, but replacement still depends on what was selected earlier.

This makes the first triage selection too final.

### New Flow

The new flow keeps the same artifact contracts but gives the agent controlled full-pool access:

1. Rough pass still builds initial candidates and beat structure.
2. Rough pass may call `search_footage` or `best_for_beat` for specific beat gaps instead of stuffing every segment into one prompt.
3. Fine pass defaults to selected clips, but can search when a clip is weak, too repetitive, technically poor, or mismatched to the beat.
4. Search results are inspected through key frames and optional Marlin tools.
5. Selected search results are normalized into the existing candidates and blueprint.
6. Compile and render remain deterministic.

### QA Improvement Loop

Search is most valuable after QA:

1. Marlin QA reports: `continuity issue at 1:30; bakery exterior cuts directly to vineyard closeup without bridge`.
2. Agent converts this to a query: `best_for_beat({ beat_purpose: "bridge from bakery exterior to vineyard", avoid_segment_ids: selected })`.
3. Agent inspects top key frames.
4. Agent replaces one weak clip or adds a fallback bridge candidate.
5. Compile regenerates `timeline.json`.
6. Render regenerates `rough-cut.mp4`.
7. QA reruns.

The loop requirement is: QA feedback should become a targeted search and a small edit, not a full random re-selection.

### Artifact Boundaries

No new canonical planning artifact is required for MVP.

Reads:

- `01_intent/creative_brief.yaml`
- `03_analysis/segments.json`
- `03_analysis/assets.json`
- Marlin events
- representative/key frame files
- optional `03_analysis/search/*` indexes
- current `selects_candidates.yaml`, `edit_blueprint.yaml`, `timeline.json`, and QA report when revising

Writes:

- Existing `selects_candidates.yaml`
- Existing `edit_blueprint.yaml`
- Existing `timeline.json` through compile
- Optional non-canonical search/revision trace

The search service may use indexes for speed, but those indexes should be rebuildable derived artifacts.

## 7. Implementation Roadmap

### Phase 0: Design Acceptance

Goal: agree that search is an editorial tool, not a new autonomous writer.

Acceptance:

- The API supports semantic, factual, technical, temporal, comparative, and negative query patterns.
- The agent flow supports QA -> search -> replace -> re-render.
- MVP does not require schema changes.

### Phase 1: In-Memory Search Service

Goal: implement `search_footage` over existing artifacts without persistent index requirements.

Work:

- Load `segments.json`, `assets.json`, Marlin events, and available appraisal fields.
- Build per-segment searchable text from summary, tags, transcript excerpt, events, OCR, place hints, and quality labels.
- Apply structured filters for duration, quality, text presence, dialogue, place category, and excluded segment ids.
- Return `FootageSearchResponse` with `match_reason`, `key_frame_path`, and evidence refs.
- Fall back cleanly when fields are missing.

Acceptance:

- A query for unused food clips can exclude selected segment ids.
- A query for visible signage uses OCR when available and text fields otherwise.
- A quality query can filter by `composition_score`, `motion_quality`, or duration.

### Phase 2: Local Semantic Search

Goal: make semantic queries useful across English/Japanese and local terminology.

Work:

- Reuse `runtime/eval/semantic-match.ts` embedding infrastructure where possible.
- Prefix embedding inputs as `query:` and `passage:` to match current E5 usage.
- Cache embeddings per segment text hash.
- Apply `context_knowledge` expansions before embedding and lexical search.
- Degrade to lexical/structured search if the embedding model is unavailable.

Acceptance:

- "chestnuts" can match footage evidence containing `栗`.
- "warm human connection" can rank relevant reaction/person clips above generic scenery.
- Missing local embedding files produce warnings, not pipeline failure.

### Phase 3: Toolkit Integration

Goal: expose search to the editorial agent in the same place as current fine-pass tools.

Work:

- Add tool definitions for `search_footage`, `similar_to`, `unused_footage`, and `best_for_beat`.
- Include tool descriptions in interactive rough and fine prompts.
- Update fine-pass instructions to allow tool-cited new candidates when replacement is justified.
- Normalize selected search results into existing candidate and beat structures.

Acceptance:

- Fine pass can replace a weak clip with a search result and still emit schema-valid selects/blueprint artifacts.
- Every search-derived candidate includes evidence that names the search query and inspected frame or field.
- If tools are unavailable, prompts still work with the selected pool.

### Phase 4: QA-Driven Replacement Loop

Goal: connect rendered-output QA issues to targeted searches.

Work:

- Add a revision prompt pattern that turns QA issues into `best_for_beat` or `search_footage` calls.
- Require the agent to cite the QA issue being addressed.
- Preserve prior strengths and avoid full candidate churn.
- Record search/replacement decisions in a non-canonical trace.

Acceptance:

- A continuity issue can produce a bridge-shot search and a single replacement.
- A weak ending can produce a closing-shot search.
- Re-rendered output can be compared against the prior QA issue.

### Phase 5: Persistent Derived Index

Goal: make search fast and reproducible for larger projects.

Work:

- Reuse or extend the existing `03_analysis/search/segment_search_index_manifest.json` and text index direction.
- Add optional vector shards for segment passages.
- Include hashes of `segments.json`, assets, transcripts, context inputs, and embedding model id.
- Surface stale-index warnings through existing release-safety style checks.

Acceptance:

- Search can run from a valid index when present.
- Search can rebuild or fall back when the index is stale.
- Search-derived candidates can reference the search manifest hash through existing provenance patterns when enabled.

## Verification Strategy

The implementation should be verified at three levels.

Unit-level:

- Query parser rejects invalid filter values and whitelists quality fields.
- Lexical search returns OCR/signage matches before unrelated semantic matches.
- `exclude_segment_ids` is a hard exclusion.
- Missing embeddings fall back with warnings.

Fixture-level:

- A small fixture with food, signage, human reaction, scenery, and shaky/dark clips proves the six query categories.
- A context fixture proves "chestnuts" matches `栗` and reports the expansion.
- A QA fixture proves "replace weak closing shot" returns an unused, higher-quality closing candidate.

Pipeline-level:

- A search-derived replacement normalizes into schema-valid `selects_candidates.yaml` and `edit_blueprint.yaml`.
- Compile and render remain deterministic after replacement.
- The QA loop records the issue, query, selected replacement, and re-render result.

Acceptance for MVP should be based on these behavior tests, not on having a persistent index.

## Risks And Rollback

Risks:

- Search may make the agent churn too many clips. Mitigation: require a QA issue, beat gap, or visible weakness before searching outside the selected pool in fine pass.
- Semantic search may return plausible but wrong footage. Mitigation: require `match_reason`, evidence refs, and key-frame inspection before selection.
- Context expansion may over-match local terminology. Mitigation: expose expansions and let the agent refine with filters.
- Persistent index staleness may create confusing results. Mitigation: treat indexes as derived, hash inputs, and fall back to direct artifact search.
- Query results may pressure schemas. Mitigation: keep search evidence in existing candidate fields or sidecar traces until repeated usage proves a schema need.

Rollback:

- Disable search tools in the editorial prompt.
- Keep the rough/fine pass on the selected pool only.
- Rerun old triage/blueprint or unified pass from existing analysis artifacts.
- Ignore derived `03_analysis/search/*` artifacts and rebuild later.

## Reliability, Safety, And Observability

Reliability:

- Search results must never invent segment ids, source ranges, or visual facts.
- Missing embeddings, missing frames, or stale indexes should warn and degrade.
- Search-derived replacements must pass the same schema validation as ordinary candidates.
- The same query over the same artifacts and index should be deterministic except for explicit model-based semantic embedding differences.

Safety:

- Search tools return data; they do not execute shell commands or mutate artifacts.
- Tool parameters should be treated as data, not file paths to execute.
- OCR and transcript matches can contain arbitrary text and must not become commands.
- Subject search uses provided labels and appearance descriptions; it should not infer sensitive identity beyond project-supplied context.

Observability:

- Each search response should expose rewritten query terms and context expansions.
- Each result should include evidence refs and a concise match reason.
- Replacement decisions should log the source query, selected result, inspected frame paths, and target beat.
- Stale or fallback behavior should be visible in warnings.

## Acceptance Criteria

The design is ready to implement when:

- The editor agent can ask semantic, factual, technical, temporal, comparative, and negative questions.
- The API returns ranked results with evidence, key frames, and source ranges.
- Context knowledge expands search without overriding footage evidence.
- Fine pass can search outside the selected pool only through explicit tool calls and evidence.
- QA feedback can drive targeted replacement searches and re-render loops.
- MVP reads existing artifacts and writes only existing canonical planning artifacts through the editorial pipeline.
- Search indexes remain derived, optional, and rebuildable.
