# Unified Footage Database Design: SQLite Search + Agent API

Date: 2026-06-19
Status: Unified design, ready for implementation after the decisions in section 15.
Scope: design only. This document merges `docs/design-footage-database-sqlite.md` and `docs/design-footage-database-agent-api.md` into one implementable plan.

## 1. Executive Decision

Build a derived, project-local SQLite footage database at:

```text
projects/<project-id>/03_analysis/search/footage.db
```

The database is not a canonical planning artifact. It is a rebuildable search artifact over existing files:

- `03_analysis/assets.json`
- `03_analysis/segments.json`
- `03_analysis/marlin_events.json`
- `03_analysis/transcripts/*.json`
- `01_intent/creative_brief.yaml` for query-time context expansion only

The first implementation should support structured filters and FTS5 text search without embeddings. The second implementation step should add local multilingual E5 embeddings using the existing `runtime/eval/semantic-match.ts` path. For fewer than 1,000 segments, vector search should be a brute-force scan over normalized `Float32Array` BLOBs, not `sqlite-vss`.

The agent-facing API should expose one read-only tool first:

```text
search_footage(query, mode, filters_json, limit)
```

Convenience calls such as `similar_to`, `unused_footage`, and `best_for_beat` should be internal TypeScript helpers until usage proves they deserve public tool slots.

## 2. Success Conditions

The implementation is successful when:

- A developer can rebuild `03_analysis/search/footage.db` from existing artifacts without modifying current schemas.
- Search works offline with structured filters and FTS5 even when embedding model files are missing.
- If cached `Xenova/multilingual-e5-small` files are available, semantic search can match Japanese and English evidence in one local embedding space.
- Claude/Codex can ask clean, targeted retrieval questions and receive source ranges, scores, warnings, and evidence fields.
- Search-derived clips are still materialized through existing `selects_candidates.yaml`, `edit_blueprint.yaml`, and compile validation. The database never writes planning artifacts directly.
- Missing or stale search data warns by default and blocks only a search-dependent full-autonomy mode.

## 3. Non-Goals

- Do not make SQLite the source of truth for analysis, candidates, blueprints, or timeline data.
- Do not change `segments.schema.json`, `assets.schema.json`, `selects-candidates.schema.json`, or `edit-blueprint.schema.json` for the MVP.
- Do not require `sqlite-vss`, `sqlite-vec`, a remote vector store, or a remote embedding API.
- Do not infer shooting date, camera type, location, identity, or GPS facts when source artifacts do not provide them.
- Do not let the fine pass churn the whole edit. Search outside selected candidates must be tied to a beat gap, visible weakness, QA issue, or explicit user instruction.

## 4. Resolved Contradictions

| Topic | SQLite-first draft | Agent-first draft | Unified decision |
| --- | --- | --- | --- |
| DB path | `03_analysis/footage.db` | optional `03_analysis/search/*` index | Use `03_analysis/search/footage.db`. Existing search artifacts already live under `03_analysis/search`, so the derived DB belongs there. |
| MVP storage | SQLite from the start | in-memory first, persistent index later | Use SQLite from the start because this task requires exact DDL. Keep direct JSON fallback when DB is missing. |
| Public tools | one `search_footage` | four tools: `search_footage`, `similar_to`, `unused_footage`, `best_for_beat` | Public MVP gets one tool. Add helper functions for the other patterns, then promote only if agent usage stays clean. |
| Embedding failure | fail before writing partial DB when embeddings are required | fail-open to lexical/structured search | Add `embeddingPolicy: "auto" | "skip" | "require"`. Default `auto` builds DB and warns if embeddings are unavailable. Full autonomy can use `require`. |
| Vector engine | BLOB scan, optional `sqlite-vss` later | optional index after behavior is proven | Use BLOB scan. `sqlite-vss` is not active enough to be a required dependency, and <1000 segments does not need ANN. |
| Quality fields | includes `focus` | uses existing `visual_quality.scores` fields | Do not add `focus` to MVP DDL because current `segments.schema.json` does not define it. Use `quality_flags` for blur/focus rejection until a real source field exists. |
| Japanese search | FTS5 with CJK expansion | context expansion and evidence refs | Use stock FTS5 plus build-time CJK character/bigram expansion. Do not require a tokenizer extension. |
| Search index provenance | reuse P4d hash discipline | optional trace/index | Add DB status/hash functions that mirror `p4d-segment-search-index.ts`. Do not overload the existing P4d JSON manifest schema. |

## 5. Existing Repo Integration

The implementation should integrate with these existing surfaces:

- `runtime/eval/semantic-match.ts`: reuse `embedTexts(texts, "query" | "passage")`, `cosineSimilarity()`, `SEMANTIC_EMBEDDING_MODEL`, `SEMANTIC_EMBEDDING_DTYPE`, and `resolveEmbeddingCacheDir()`.
- `runtime/tools/editorial-tools.ts`: add `search_footage` to `EDITORIAL_TOOL_DEFINITIONS` and `createEditorialToolkit(...)`.
- `runtime/mcp/repository.ts`: keep existing `searchSegments(...)` as a compatibility adapter. When the DB exists, route to SQLite search; otherwise preserve the current lexical implementation.
- `runtime/artifacts/p4d-segment-search-index.ts`: reuse the same ideas, not the same artifact schema: normalized input hashes, stale reasons, warning/blocker policy, and status visibility.
- `scripts/rebuild-segment-search-index.ts`: leave intact. The footage DB supersedes it functionally for footage retrieval but does not need to delete or rewrite it in the MVP.

## 6. File Locations

Future implementation should use these exact paths:

```text
runtime/artifacts/footage-db.ts
runtime/artifacts/footage-db-builder.ts
runtime/tools/footage-search.ts
scripts/build-footage-db.ts
tests/footage-db-builder.test.ts
tests/footage-search.test.ts
tests/fixtures/footage_db/
```

Generated project artifacts:

```text
projects/<project-id>/03_analysis/search/footage.db
projects/<project-id>/03_analysis/search/footage-db-build-report.json
```

Do not write generated DB files into the repo root, `docs/`, `schemas/`, or canonical planning directories.

## 7. Dependencies

Recommended MVP dependency:

```json
{
  "dependencies": {
    "better-sqlite3": "^12.11.1"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13"
  }
}
```

Rationale:

- `better-sqlite3` gives a simple synchronous API that matches the current CLI/tool style.
- It supports FTS5 in normal builds and handles BLOB values cleanly.
- It is a native module, so installation can fail on mismatched Node or OS environments. Add a focused smoke test and document `npm rebuild better-sqlite3` as the first troubleshooting step.

Rejected for MVP:

- `sqlite-vss`: not required for <1000 segments, not in active development, pre-v1, and adds extension-loading risk.
- `sqlite-vec`: a better future candidate than `sqlite-vss`, but still pre-v1 and unnecessary for the target scale.
- `node:sqlite`: attractive because it avoids an npm native module, but it is still not the safest repo default unless the project pins a Node version where the API is acceptable. It can be hidden behind a future adapter.

Existing dependency to reuse:

- `@huggingface/transformers` is already present in `devDependencies` and is already used by `runtime/eval/semantic-match.ts`.

## 8. Exact SQLite DDL

The builder must execute this schema on a newly created temp DB. Foreign keys must be enabled for every connection.

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE footage_db_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE footage_db_sources (
  source_name TEXT PRIMARY KEY,
  rel_path TEXT NOT NULL,
  hash TEXT NOT NULL,
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  indexed_at TEXT NOT NULL
);

CREATE TABLE footage_db_warnings (
  warning_id TEXT PRIMARY KEY,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  message TEXT NOT NULL,
  source_name TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE assets (
  asset_id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  display_name TEXT,
  role_guess TEXT,
  duration_us INTEGER NOT NULL CHECK (duration_us >= 0),
  has_transcript INTEGER NOT NULL DEFAULT 0 CHECK (has_transcript IN (0, 1)),
  transcript_ref TEXT,
  source_locator TEXT,
  source_fingerprint TEXT,
  poster_path TEXT,
  waveform_path TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  quality_flags_json TEXT NOT NULL DEFAULT '[]',
  source_order INTEGER NOT NULL,
  shooting_date TEXT,
  shooting_time TEXT,
  camera_type TEXT
);

CREATE INDEX idx_assets_source_order ON assets(source_order);
CREATE INDEX idx_assets_shooting_date ON assets(shooting_date);
CREATE INDEX idx_assets_shooting_time ON assets(shooting_time);
CREATE INDEX idx_assets_camera_type ON assets(camera_type);

CREATE TABLE segments (
  segment_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
  src_in_us INTEGER NOT NULL CHECK (src_in_us >= 0),
  src_out_us INTEGER NOT NULL CHECK (src_out_us > src_in_us),
  duration_us INTEGER GENERATED ALWAYS AS (src_out_us - src_in_us) VIRTUAL,
  rep_frame_us INTEGER CHECK (rep_frame_us IS NULL OR rep_frame_us >= 0),
  segment_type TEXT CHECK (
    segment_type IS NULL OR segment_type IN ('dialogue', 'music_driven', 'action', 'static', 'general')
  ),
  summary TEXT NOT NULL DEFAULT '',
  transcript_excerpt TEXT NOT NULL DEFAULT '',
  transcript_ref TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  quality_flags_json TEXT NOT NULL DEFAULT '[]',
  interest_points_json TEXT NOT NULL DEFAULT '[]',
  filmstrip_path TEXT,
  waveform_path TEXT
);

CREATE INDEX idx_segments_asset_time ON segments(asset_id, src_in_us, src_out_us);
CREATE INDEX idx_segments_duration ON segments(duration_us);
CREATE INDEX idx_segments_type ON segments(segment_type);

CREATE TABLE visual_quality (
  segment_id TEXT PRIMARY KEY REFERENCES segments(segment_id) ON DELETE CASCADE,
  light_quality REAL CHECK (light_quality IS NULL OR (light_quality >= 0 AND light_quality <= 1)),
  subject_prominence REAL CHECK (subject_prominence IS NULL OR (subject_prominence >= 0 AND subject_prominence <= 1)),
  emotional_expression REAL CHECK (emotional_expression IS NULL OR (emotional_expression >= 0 AND emotional_expression <= 1)),
  composition_score REAL CHECK (composition_score IS NULL OR (composition_score >= 0 AND composition_score <= 1)),
  motion_quality REAL CHECK (motion_quality IS NULL OR (motion_quality >= 0 AND motion_quality <= 1)),
  lighting_style_json TEXT NOT NULL DEFAULT '[]',
  composition_tags_json TEXT NOT NULL DEFAULT '[]',
  expression_tags_json TEXT NOT NULL DEFAULT '[]',
  motion_tags_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_visual_quality_light ON visual_quality(light_quality);
CREATE INDEX idx_visual_quality_subject ON visual_quality(subject_prominence);
CREATE INDEX idx_visual_quality_emotion ON visual_quality(emotional_expression);
CREATE INDEX idx_visual_quality_composition ON visual_quality(composition_score);
CREATE INDEX idx_visual_quality_motion ON visual_quality(motion_quality);

CREATE TABLE visual_appraisal (
  segment_id TEXT PRIMARY KEY REFERENCES segments(segment_id) ON DELETE CASCADE,
  frame_us INTEGER CHECK (frame_us IS NULL OR frame_us >= 0),
  frame_path TEXT,
  extracted_text_json TEXT NOT NULL DEFAULT '[]',
  extracted_text_flat TEXT NOT NULL DEFAULT '',
  place_hint_name TEXT,
  place_hint_category TEXT,
  place_hint_confidence REAL CHECK (
    place_hint_confidence IS NULL OR (place_hint_confidence >= 0 AND place_hint_confidence <= 1)
  ),
  place_hint_evidence_json TEXT NOT NULL DEFAULT '[]',
  aesthetic_notes_json TEXT NOT NULL DEFAULT '[]',
  aesthetic_notes_flat TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_visual_appraisal_place ON visual_appraisal(place_hint_category, place_hint_name);
CREATE INDEX idx_visual_appraisal_text ON visual_appraisal(extracted_text_flat);

CREATE TABLE peak_analysis (
  segment_id TEXT PRIMARY KEY REFERENCES segments(segment_id) ON DELETE CASCADE,
  recommended_in_us INTEGER CHECK (recommended_in_us IS NULL OR recommended_in_us >= 0),
  recommended_out_us INTEGER CHECK (recommended_out_us IS NULL OR recommended_out_us >= 0),
  recommended_rationale TEXT,
  motion_support_score REAL CHECK (motion_support_score IS NULL OR (motion_support_score >= 0 AND motion_support_score <= 1)),
  audio_support_score REAL CHECK (audio_support_score IS NULL OR (audio_support_score >= 0 AND audio_support_score <= 1)),
  fused_peak_score REAL CHECK (fused_peak_score IS NULL OR (fused_peak_score >= 0 AND fused_peak_score <= 1))
);

CREATE TABLE peak_moments (
  peak_ref TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL REFERENCES segments(segment_id) ON DELETE CASCADE,
  timestamp_us INTEGER NOT NULL CHECK (timestamp_us >= 0),
  type TEXT NOT NULL CHECK (type IN ('action_peak', 'emotional_peak', 'visual_peak')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  description TEXT NOT NULL DEFAULT '',
  source_pass TEXT NOT NULL
);

CREATE INDEX idx_peak_moments_segment ON peak_moments(segment_id);
CREATE INDEX idx_peak_moments_type ON peak_moments(type, confidence);

CREATE TABLE segment_transcripts (
  segment_id TEXT PRIMARY KEY REFERENCES segments(segment_id) ON DELETE CASCADE,
  text TEXT NOT NULL DEFAULT '',
  language TEXT,
  confidence_min REAL CHECK (confidence_min IS NULL OR (confidence_min >= 0 AND confidence_min <= 1)),
  has_dialogue INTEGER NOT NULL DEFAULT 0 CHECK (has_dialogue IN (0, 1)),
  item_refs_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_segment_transcripts_dialogue ON segment_transcripts(has_dialogue);

CREATE TABLE marlin_assets (
  asset_id TEXT PRIMARY KEY REFERENCES assets(asset_id) ON DELETE CASCADE,
  source_path TEXT,
  scene TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT ''
);

CREATE TABLE marlin_events (
  event_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
  start_us INTEGER NOT NULL CHECK (start_us >= 0),
  end_us INTEGER NOT NULL CHECK (end_us >= start_us),
  description TEXT NOT NULL DEFAULT '',
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  source_pass TEXT,
  chunk_index INTEGER,
  chunk_offset_us INTEGER
);

CREATE INDEX idx_marlin_events_asset_time ON marlin_events(asset_id, start_us, end_us);

CREATE TABLE embedding_texts (
  segment_id TEXT NOT NULL REFERENCES segments(segment_id) ON DELETE CASCADE,
  field TEXT NOT NULL CHECK (field IN ('summary', 'transcript', 'scene', 'combined')),
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (segment_id, field)
);

CREATE TABLE embeddings (
  segment_id TEXT NOT NULL REFERENCES segments(segment_id) ON DELETE CASCADE,
  field TEXT NOT NULL CHECK (field IN ('summary', 'transcript', 'scene', 'combined')),
  model_id TEXT NOT NULL,
  dimension INTEGER NOT NULL CHECK (dimension > 0),
  vector BLOB NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (segment_id, field, model_id),
  FOREIGN KEY (segment_id, field) REFERENCES embedding_texts(segment_id, field) ON DELETE CASCADE
);

CREATE INDEX idx_embeddings_model_field ON embeddings(model_id, field);

CREATE TABLE segment_index_state (
  segment_id TEXT PRIMARY KEY REFERENCES segments(segment_id) ON DELETE CASCADE,
  segment_hash TEXT NOT NULL,
  asset_hash TEXT NOT NULL,
  transcript_hash TEXT,
  marlin_hash TEXT,
  appraisal_hash TEXT,
  embedding_combined_hash TEXT,
  indexed_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE segments_fts USING fts5(
  segment_id UNINDEXED,
  asset_id UNINDEXED,
  summary,
  transcript,
  marlin_scene,
  marlin_events,
  tags,
  quality_labels,
  extracted_text,
  place,
  aesthetic_notes,
  tokenize = "unicode61 remove_diacritics 2 tokenchars '_-'"
);
```

Required `footage_db_meta` keys:

| Key | Value |
| --- | --- |
| `schema_version` | `1` |
| `artifact_version` | `footage-db-v1` |
| `project_id` | project id from source artifacts or project directory name |
| `created_at` | ISO timestamp |
| `builder` | `scripts/build-footage-db.ts` |
| `embedding_status` | `ready`, `skipped`, `unavailable`, or `error` |
| `embedding_model_id` | `Xenova/multilingual-e5-small:q8` when applicable |
| `source_hash_policy` | `normalized-json-v1` |

## 9. Source Field Mapping

### Assets

Map from `assets.schema.json`:

| SQLite column | Source |
| --- | --- |
| `asset_id` | `asset.asset_id` |
| `filename` | `asset.filename` |
| `display_name` | `asset.display_name` |
| `role_guess` | `asset.role_guess` |
| `duration_us` | `asset.duration_us` |
| `has_transcript` | `asset.has_transcript ? 1 : 0` |
| `transcript_ref` | `asset.transcript_ref` |
| `source_locator` | `asset.source_locator` |
| `source_fingerprint` | `asset.source_fingerprint` |
| `poster_path` | `asset.poster_path` |
| `waveform_path` | `asset.waveform_path` |
| `tags_json` | JSON string of `asset.tags` |
| `quality_flags_json` | JSON string of `asset.quality_flags` |
| `source_order` | zero-based index in `assets.items` |
| `shooting_date` | optional derived/source metadata, otherwise null |
| `shooting_time` | optional derived/source metadata, otherwise null |
| `camera_type` | optional derived/source metadata, otherwise null |

Do not infer `shooting_date`, `shooting_time`, or `camera_type` from filenames in MVP unless a separate deterministic parser is explicitly approved.

### Segments

Map from `segments.schema.json`:

| SQLite column | Source |
| --- | --- |
| `segment_id` | `segment.segment_id` |
| `asset_id` | `segment.asset_id` |
| `src_in_us` | `segment.src_in_us` |
| `src_out_us` | `segment.src_out_us` |
| `rep_frame_us` | `segment.rep_frame_us` |
| `segment_type` | `segment.segment_type` |
| `summary` | `segment.summary` |
| `transcript_excerpt` | `segment.transcript_excerpt` |
| `transcript_ref` | `segment.transcript_ref` |
| `tags_json` | JSON string of `segment.tags` |
| `quality_flags_json` | JSON string of `segment.quality_flags` |
| `interest_points_json` | JSON string of `segment.interest_points` |
| `filmstrip_path` | `segment.filmstrip_path` |
| `waveform_path` | `segment.waveform_path` |

### Visual Quality

Use the current score names exactly:

| SQLite column | Source |
| --- | --- |
| `light_quality` | `segment.visual_quality.scores.light_quality` |
| `subject_prominence` | `segment.visual_quality.scores.subject_prominence` |
| `emotional_expression` | `segment.visual_quality.scores.emotional_expression` |
| `composition_score` | `segment.visual_quality.scores.composition_score` |
| `motion_quality` | `segment.visual_quality.scores.motion_quality` |
| `lighting_style_json` | `segment.visual_quality.labels.lighting_style` |
| `composition_tags_json` | `segment.visual_quality.labels.composition_tags` |
| `expression_tags_json` | `segment.visual_quality.labels.expression_tags` |
| `motion_tags_json` | `segment.visual_quality.labels.motion_tags` |

### Visual Appraisal

| SQLite column | Source |
| --- | --- |
| `frame_us` | `segment.visual_appraisal.frame_us` |
| `frame_path` | `segment.visual_appraisal.frame_path` |
| `extracted_text_json` | JSON string of `segment.visual_appraisal.extracted_text` |
| `extracted_text_flat` | joined `extracted_text[].text` |
| `place_hint_name` | `segment.visual_appraisal.place_hint.name` |
| `place_hint_category` | `segment.visual_appraisal.place_hint.category` |
| `place_hint_confidence` | `segment.visual_appraisal.place_hint.confidence` |
| `place_hint_evidence_json` | JSON string of `segment.visual_appraisal.place_hint.evidence` |
| `aesthetic_notes_json` | JSON string of `segment.visual_appraisal.aesthetic_notes` |
| `aesthetic_notes_flat` | joined `aesthetic_notes` |

### Peak Analysis

Store `peak_analysis.recommended_in_out`, `peak_analysis.support_signals`, and each `peak_analysis.peak_moments[]`. These fields support "best closing moment", "action peak", and "emotion peak" queries without putting model judgment into prompts.

### Marlin Events

`runtime/connectors/marlin-types.ts` models Marlin at asset level. Store one `marlin_assets` row per asset and one `marlin_events` row per event. At query/build time, associate events with segments by overlap:

```sql
e.asset_id = s.asset_id
AND e.end_us > s.src_in_us
AND e.start_us < s.src_out_us
```

### Transcripts

`segment_transcripts.text` is the text from transcript items overlapping the segment. If the transcript file is missing, use `segments.items[].transcript_excerpt`. `item_refs_json` should contain stable refs with `transcript_ref`, `item_id`, `start_us`, and `end_us` where available.

## 10. FTS5 Build Rules

Each segment gets one `segments_fts` row. Populate fields as:

| FTS field | Source text |
| --- | --- |
| `summary` | segment summary |
| `transcript` | aggregated segment transcript text |
| `marlin_scene` | asset scene/caption from Marlin |
| `marlin_events` | overlapping event descriptions |
| `tags` | segment tags, asset tags, and context-expanded tag aliases |
| `quality_labels` | visual quality label arrays |
| `extracted_text` | OCR/visible text from visual appraisal |
| `place` | place hint name, category, and evidence strings |
| `aesthetic_notes` | appraisal aesthetic notes |

Before insertion, normalize text with:

```ts
function normalizeSearchText(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}
```

For strings containing CJK characters, append searchable expansions:

```ts
function cjkSearchExpansions(value: string): string[] {
  const chars = Array.from(value).filter((char) => /[\u3040-\u30ff\u3400-\u9fff]/u.test(char));
  const bigrams: string[] = [];
  for (let i = 0; i < chars.length - 1; i += 1) bigrams.push(chars[i] + chars[i + 1]);
  return Array.from(new Set([...chars, ...bigrams]));
}
```

FTS query strings must be built with a small query builder. Do not pass raw prompt text directly to `MATCH`.

```ts
export function buildFtsMatchQuery(input: {
  text: string;
  explicitBoolean?: boolean;
  contextTerms?: string[];
}): { match: string; warnings: string[] };
```

MVP behavior:

- Quote phrases unless the caller explicitly requests boolean syntax.
- Preserve uppercase `AND`, `OR`, and `NOT` only when `explicitBoolean` is true.
- Escape embedded quotes.
- Add context terms with `OR`.
- If the query becomes empty, skip FTS and warn.

## 11. Embedding Design

Reuse the existing local E5 path:

```ts
import {
  SEMANTIC_EMBEDDING_DTYPE,
  SEMANTIC_EMBEDDING_MODEL,
  cosineSimilarity,
  embedTexts,
} from "../eval/semantic-match.js";
```

Model id stored in SQLite:

```text
Xenova/multilingual-e5-small:q8
```

Embedding text fields:

| Field | Text bundle |
| --- | --- |
| `summary` | summary, tags, quality labels |
| `transcript` | transcript text, transcript excerpt |
| `scene` | Marlin scene, caption, overlapping events, place hints |
| `combined` | summary, transcript, scene, tags, OCR, place, appraisal notes |

Storage:

```ts
const vectorBuffer = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
```

Rules:

- Stored vectors are normalized `Float32Array` values returned by `embedTexts(..., "passage")`.
- Query vectors use `embedTexts([query], "query")`.
- Compare with `cosineSimilarity(queryVector, storedVector)`.
- Store vectors only when `vector.length > 0`.
- Use `content_hash` to skip unchanged text bundles.
- If embeddings are unavailable under `embeddingPolicy: "auto"`, write no rows to `embeddings`, set `embedding_status = "unavailable"`, and keep FTS/structured search usable.

For <1000 segments, default semantic lookup:

1. Apply structured SQL filters.
2. Load eligible `combined` vectors for the configured model id.
3. Decode each BLOB into `Float32Array`.
4. Compute cosine similarity in TypeScript.
5. Sort by score descending, then deterministic tie-breakers.

Do not add ANN or vector extensions until a real project exceeds the target scale.

## 12. Exact TypeScript Interfaces

Place these in `runtime/tools/footage-search.ts`.

```ts
export type FootageSearchMode = "hybrid" | "text" | "semantic" | "structured";
export type FootageSortBy = "relevance" | "quality" | "chronological" | "duration";

export type FootageQualityField =
  | "light_quality"
  | "subject_prominence"
  | "emotional_expression"
  | "composition_score"
  | "motion_quality";

export interface FootageSearchFilters {
  shooting_date?: string;
  shooting_time_start?: string;
  shooting_time_end?: string;
  camera_type?: string;
  asset_ids?: string[];
  segment_type?: "dialogue" | "music_driven" | "action" | "static" | "general";
  min_duration_us?: number;
  max_duration_us?: number;
  quality_min?: Partial<Record<FootageQualityField, number>>;
  place_hint_name?: string;
  place_hint_category?: string;
  has_text?: boolean;
  has_dialogue?: boolean;
  include_tags_any?: string[];
  exclude_quality_flags?: string[];
  exclude_segment_ids?: string[];
}

export interface FootageSearchContext {
  project_id?: string;
  terminology?: Array<{ term: string; meaning: string; aliases?: string[] }>;
  locations?: Array<{ name: string; description?: string; category?: string; aliases?: string[] }>;
  subjects?: Array<{ name: string; role?: string; appearance?: string; aliases?: string[] }>;
}

export interface SearchFootageInput {
  query: string;
  mode?: FootageSearchMode;
  text_match?: string;
  semantic?: string;
  filters?: FootageSearchFilters;
  sort_by?: FootageSortBy;
  limit?: number;
  context?: FootageSearchContext;
}

export interface FootageScoreBreakdown {
  semantic?: number;
  lexical?: number;
  quality?: number;
  peak?: number;
  final: number;
}

export interface FootageEvidenceRef {
  field:
    | "summary"
    | "transcript"
    | "marlin_scene"
    | "marlin_event"
    | "tag"
    | "quality_label"
    | "quality_score"
    | "quality_flag"
    | "ocr"
    | "place_hint"
    | "aesthetic_note"
    | "peak"
    | "context_expansion";
  value: string;
  score?: number;
}

export interface FootageSearchResult {
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  duration_us: number;
  score: number;
  scores: FootageScoreBreakdown;
  match_reason: string;
  summary: string;
  key_frame_path?: string;
  tags: string[];
  quality_flags: string[];
  transcript_excerpt?: string;
  marlin_events?: string[];
  quality?: Partial<Record<FootageQualityField, number>>;
  place_hint?: {
    name?: string | null;
    category?: string;
    confidence?: number;
  };
  extracted_text?: Array<{
    text: string;
    language?: string;
    confidence?: number;
  }>;
  peak?: {
    timestamp_us?: number;
    type?: "action_peak" | "emotional_peak" | "visual_peak";
    confidence?: number;
    description?: string;
  };
  evidence_refs: FootageEvidenceRef[];
}

export interface FootageSearchResponse {
  query: SearchFootageInput;
  db_path?: string;
  db_status: "ready" | "missing" | "stale" | "malformed" | "fallback";
  mode_used: FootageSearchMode;
  rewritten_query?: {
    semantic?: string;
    text_terms?: string[];
    context_expansions?: string[];
    fts_match?: string;
  };
  results: FootageSearchResult[];
  warnings: string[];
}

export interface SimilarFootageInput {
  segment_id: string;
  different_location?: boolean;
  different_asset?: boolean;
  min_quality?: number;
  exclude_segment_ids?: string[];
  limit?: number;
}

export interface UnusedFootageInput {
  selected_segment_ids: string[];
  semantic?: string;
  min_quality?: number;
  limit?: number;
}

export interface BestForBeatInput {
  beat_id?: string;
  story_role?: "hook" | "setup" | "experience" | "payoff" | "reaction" | "closing";
  beat_purpose: string;
  required_visuals?: string[];
  avoid_segment_ids?: string[];
  limit?: number;
}
```

Place these in `runtime/artifacts/footage-db.ts`.

```ts
export type FootageDbStatusKind = "ready" | "missing" | "stale" | "malformed";

export interface FootageDbStatus {
  status: FootageDbStatusKind;
  path: string;
  exists: boolean;
  schema_version?: string;
  artifact_version?: "footage-db-v1";
  project_id?: string;
  source_hashes?: Record<string, string>;
  stale_reasons?: string[];
  embedding_status?: "ready" | "skipped" | "unavailable" | "error";
  embedding_model_id?: string;
  errors?: string[];
}

export function footageDbPath(projectDir: string): string;
export function readFootageDbStatus(projectDir: string): FootageDbStatus;
export function searchFootageDbStaleReasons(projectDir: string): string[];
```

Place these in `runtime/artifacts/footage-db-builder.ts`.

```ts
export type FootageDbEmbeddingPolicy = "auto" | "skip" | "require";
export type FootageDbRebuildMode = "full" | "incremental";

export interface BuildFootageDbOptions {
  projectDir: string;
  outputPath?: string;
  embeddingPolicy?: FootageDbEmbeddingPolicy;
  rebuildMode?: FootageDbRebuildMode;
  allowRemoteEmbeddingModels?: boolean;
  now?: Date;
}

export interface BuildFootageDbResult {
  db_path: string;
  report_path: string;
  artifact_version: "footage-db-v1";
  schema_version: "1";
  counts: {
    assets: number;
    segments: number;
    fts_rows: number;
    marlin_events: number;
    transcript_segments: number;
    embeddings: number;
  };
  embedding_status: "ready" | "skipped" | "unavailable" | "error";
  warnings: string[];
  source_hashes: Record<string, string>;
}

export async function buildFootageDb(options: BuildFootageDbOptions): Promise<BuildFootageDbResult>;
```

Place these in `runtime/tools/footage-search.ts`.

```ts
export async function searchFootage(
  projectDir: string,
  input: SearchFootageInput,
): Promise<FootageSearchResponse>;

export async function similarFootage(
  projectDir: string,
  input: SimilarFootageInput,
): Promise<FootageSearchResponse>;

export async function unusedFootage(
  projectDir: string,
  input: UnusedFootageInput,
): Promise<FootageSearchResponse>;

export async function bestForBeat(
  projectDir: string,
  input: BestForBeatInput,
): Promise<FootageSearchResponse>;
```

CLI in `scripts/build-footage-db.ts`:

```bash
npx tsx scripts/build-footage-db.ts \
  --project projects/<project-id> \
  --embedding-policy auto
```

Accepted flags:

```text
--project <path>                 required
--output <path>                  default: <project>/03_analysis/search/footage.db
--embedding-policy auto|skip|require
--rebuild-mode full|incremental
--allow-remote-embedding-models  default false
```

## 13. Query Semantics

Default mode is `hybrid`.

Mode behavior:

- `structured`: apply filters only, then sort by `sort_by`.
- `text`: apply filters plus FTS5, no embeddings.
- `semantic`: apply filters plus embeddings. If embeddings are unavailable, fall back to `text` if `text_match` or `query` is usable and add a warning.
- `hybrid`: apply filters, FTS5 when query text exists, embeddings when available, then fuse scores.

Default limit:

```ts
const DEFAULT_FOOTAGE_SEARCH_LIMIT = 12;
const MAX_FOOTAGE_SEARCH_LIMIT = 50;
```

Structured filter rules:

- `exclude_segment_ids` is a hard exclusion.
- `exclude_quality_flags` is a hard exclusion evaluated in TypeScript after coarse SQL unless JSON1 is explicitly used.
- Missing `shooting_date`, `shooting_time`, `camera_type`, or `place_hint_*` fields should not invent values. Return warnings when a requested filter has no indexed data.
- `has_text` is true when OCR text or transcript text is non-empty.
- `has_dialogue` is true when transcript text exists or `segment_type = 'dialogue'`.
- `quality_min` fields must be whitelisted by `FootageQualityField`.

Hybrid scoring:

```text
final_score =
  0.55 * semantic_score_normalized +
  0.30 * lexical_score_normalized +
  0.10 * quality_score_normalized +
  0.05 * peak_score_normalized
```

Fallback weights:

- If semantic score is unavailable, redistribute its weight to lexical and quality: `0.75 lexical`, `0.20 quality`, `0.05 peak`.
- If lexical score is unavailable, use `0.80 semantic`, `0.15 quality`, `0.05 peak`.
- If both are unavailable, structured results use quality, duration, chronology, and deterministic tie-breakers.

Deterministic tie-breakers:

```text
final_score DESC,
composition_score DESC NULLS LAST,
light_quality DESC NULLS LAST,
duration_us DESC,
asset.source_order ASC,
segments.src_in_us ASC,
segments.segment_id ASC
```

`match_reason` must name fields and signals:

Good:

```text
semantic match "warm indoor scenes" against combined text; light_quality=0.84; matched tags: indoor,warm_light
```

Bad:

```text
matched
```

## 14. Agent Tool Adapter

`runtime/tools/editorial-tools.ts` currently models parameters as a flat map of names to `{ type, description }`. The MVP should therefore expose one tool with string/number parameters instead of requiring nested JSON schema support.

Add this tool definition:

```ts
{
  name: "search_footage",
  description: "Search the full analyzed footage pool by natural language, text, and structured filters. Read-only.",
  parameters: {
    query: {
      type: "string",
      description: "Natural-language search intent, such as warm indoor scenes or unused food preparation closeups.",
    },
    mode: {
      type: "string",
      description: "Optional: hybrid, text, semantic, or structured. Defaults to hybrid.",
    },
    filters_json: {
      type: "string",
      description: "Optional JSON object matching FootageSearchFilters.",
    },
    limit: {
      type: "number",
      description: "Optional result limit. Defaults to 12, max 50.",
    },
  },
}
```

Executor behavior:

```ts
const response = await searchFootage(resolvedProjectDir, {
  query,
  mode: parseMode(mode),
  filters: parseFiltersJson(filters_json),
  limit,
});
```

Prompt behavior:

- Rough pass may use `search_footage` when a beat lacks evidence or compact material is insufficient.
- Fine pass defaults to selected clips, but may use `search_footage` for a weak, repetitive, too-short, technically poor, or QA-targeted clip.
- Any new candidate from search must cite the query, result `segment_id`, evidence refs, and inspected frame path if a frame exists.
- Search tools do not write candidates, blueprints, timelines, or media. The agent must still emit schema-compatible artifacts through existing paths.

The current prompt line "Flag clips that should be swapped by using existing fallback candidates only" must be revised when this tool is enabled:

```text
Default to existing selected and fallback candidates. Search the full footage pool only when a beat gap, QA issue, or inspected weakness justifies it, and cite the search result evidence before introducing a new candidate.
```

## 15. Decisions Needed Before Implementation

1. DB driver:
   - Recommendation: `better-sqlite3`.
   - Alternative: `node:sqlite` behind a driver adapter if the repo pins a compatible Node version.

2. DB path:
   - Recommendation: `03_analysis/search/footage.db`.
   - Alternative: keep the SQLite-first draft path `03_analysis/footage.db`.

3. Embedding policy default:
   - Recommendation: `auto`, which builds FTS/structured DB offline and warns when embeddings are absent.
   - Alternative: `require` for all builds, which gives stronger semantic guarantees but blocks more local runs.

4. Existing P4d JSON search index:
   - Recommendation: coexist for one release, then retire if SQLite search covers all P4d use cases.
   - Alternative: migrate P4d status checks immediately to the DB status helper.

5. Tool parameter shape:
   - Recommendation: flat `filters_json` adapter for MVP.
   - Alternative: upgrade `EditorialToolDefinition.parameters` to nested JSON schema before adding search tools.

6. Shooting metadata:
   - Recommendation: leave `shooting_date`, `shooting_time`, and `camera_type` nullable.
   - Alternative: approve a deterministic metadata sidecar or filename parser.

## 16. Gaps Neither Draft Fully Covered

- Exact driver decision and native dependency fallback.
- DB schema versioning and migration policy.
- How the SQLite DB coexists with the existing P4d JSON search manifest during rollout.
- Exact frame path resolution for `key_frame_path` when `visual_appraisal.frame_path` is missing.
- Exact FTS query escaping and boolean syntax handling.
- Deterministic CJK expansion strategy for stock FTS5.
- Missing source fields for shooting date/time/camera and focus/sharpness scores.
- Privacy handling for transcript/OCR text when `footage.db` is shared.
- Corrupt DB handling and atomic replacement policy.
- Test fixtures that prove Japanese/English mixed search, OCR, quality filters, and stale detection.
- How search-derived decisions are traced without expanding planning schemas.

## 17. Concerns And Risks

Practicality for <1000 segments:

- SQLite, FTS5, and brute-force vectors are practical. ANN extensions are over-engineering.
- The main cost is embedding build time and model cache setup, not query latency.

Offline operation:

- FTS and structured search are fully offline.
- Semantic search is offline only after the E5 model is cached. The tool must warn and degrade when local model files are absent.

Existing-code integration:

- `semantic-match.ts` already has the right model, cache, prefix, and fallback behavior.
- `editorial-tools.ts` is flat and prompt-oriented, so nested filters need `filters_json` unless the registry type changes.
- `runtime/mcp/repository.ts` has a basic lexical `searchSegments(...)`; preserve it as fallback and route to SQLite later.

Dependency risks:

- `better-sqlite3` is native. It can fail on unsupported Node versions or missing build tooling.
- `sqlite-vss` should not be required. It is not active enough for a core dependency, needs extension loading, and is unnecessary at this scale.
- `node:sqlite` may become attractive later, but only after the repo pins and tests the target Node runtime.

Search quality risks:

- FTS5 is weak for Japanese morphology. Build-time CJK expansions improve recall but are not full tokenization.
- Semantic search can produce plausible false positives. Require evidence refs and frame inspection before selection.
- Context expansion can over-match. Always expose expansions in `rewritten_query.context_expansions`.

Operational risks:

- Stale DB results can confuse agents. Status checks must compare source hashes before search-dependent automation.
- Derived DB may contain sensitive transcript/OCR text. Treat it like `03_analysis`, not like a public cache.
- Fine-pass search can cause churn. Prompt policy must constrain search to targeted fixes.

## 18. Prioritized Implementation Plan

### Phase 1: SQLite Structured + FTS MVP

Build first:

- Add `better-sqlite3` and `@types/better-sqlite3` if decision 1 is approved.
- Add `runtime/artifacts/footage-db.ts` with path/status/stale helpers.
- Add `runtime/artifacts/footage-db-builder.ts` with the DDL above.
- Add `scripts/build-footage-db.ts`.
- Build `assets`, `segments`, `visual_quality`, `visual_appraisal`, `peak_analysis`, `peak_moments`, `segment_transcripts`, `marlin_assets`, `marlin_events`, and `segments_fts`.
- Write `footage-db-build-report.json`.

Acceptance:

- `npx tsx scripts/build-footage-db.ts --project projects/<id> --embedding-policy skip` creates a DB.
- `PRAGMA integrity_check` returns `ok`.
- `栗 OR chestnut` can match expected Japanese/English evidence when source text exists.
- Duration, quality, place, dialogue, text, and exclusion filters work.

### Phase 2: Search Service And Fallback

Build:

- Add `runtime/tools/footage-search.ts`.
- Implement `searchFootage(...)` for `structured`, `text`, and `hybrid` without embeddings.
- Add direct JSON fallback when DB is missing or malformed.
- Add tests for filter validation, FTS query escaping, CJK expansion, and deterministic sort.

Acceptance:

- `exclude_segment_ids` is a hard exclusion.
- Missing date/time/camera fields return warnings, not fabricated results.
- Fallback returns the same basic shape with `db_status: "fallback"`.

### Phase 3: Local Embeddings

Build:

- Populate `embedding_texts` and `embeddings`.
- Reuse `embedTexts()` and `cosineSimilarity()`.
- Implement semantic and hybrid vector scoring with BLOB scans.
- Add `embeddingPolicy` support.

Acceptance:

- Cached model files produce embedding rows with `model_id = "Xenova/multilingual-e5-small:q8"`.
- Missing model files under `auto` still leave FTS/structured search usable.
- Japanese query can rank English evidence, and English query can rank Japanese evidence, when semantic vectors are available.

### Phase 4: Editorial Tool Integration

Build:

- Add `search_footage` to `EDITORIAL_TOOL_DEFINITIONS`.
- Add executor to `createEditorialToolkit(...)`.
- Update rough/fine prompt language to allow targeted full-pool search.
- Update `runtime/mcp/repository.ts` to route `searchSegments(...)` to SQLite when available.

Acceptance:

- The fine pass can inspect a weak clip, call search, and introduce a schema-valid replacement candidate with evidence.
- If the DB is missing, prompts and tools still work with current selected-pool behavior.

### Phase 5: QA Loop And Optional Acceleration

Build later:

- QA issue to targeted query helpers.
- Search/replacement sidecar trace.
- Optional `similarFootage`, `unusedFootage`, and `bestForBeat` public tools.
- Optional `sqlite-vec` experiment if real project size exceeds the brute-force threshold.

Acceptance:

- A QA continuity issue can produce one targeted replacement and re-render without full candidate churn.
- Optional vector extension results are equivalent to BLOB scan within deterministic tie-break rules.

## 19. Verification Strategy

Unit tests:

- DDL applies cleanly to an empty DB.
- Builder rejects invalid source ranges and reports skipped optional artifacts.
- Filter parser validates quality fields and numeric ranges.
- FTS query builder escapes quotes and unsupported syntax.
- CJK expansion returns characters and bigrams.
- BLOB vector encode/decode preserves vector length and values.

Fixture tests:

- Food/signage/human/scenery/shaky/dark fixture proves semantic, factual, technical, temporal, comparative, and negative query categories.
- Mixed `栗`/`chestnut` fixture proves lexical expansion and semantic fallback.
- Missing embedding fixture proves warnings and non-blocking FTS search.
- Stale input hash fixture proves status reports stale reasons.

Integration tests:

- `scripts/build-footage-db.ts` builds `footage.db` and report for a small project.
- `searchFootage(...)` returns evidence refs and deterministic ranking.
- `createEditorialToolkit(...)` includes `search_footage` and executes read-only search.
- `runtime/mcp/repository.ts searchSegments(...)` preserves old behavior when DB is absent.

Manual verification:

```bash
npm run build
npx vitest run tests/footage-db-builder.test.ts tests/footage-search.test.ts tests/editorial-tools.test.ts tests/mcp-repository.test.ts
npx tsx scripts/build-footage-db.ts --project projects/<id> --embedding-policy skip
sqlite3 projects/<id>/03_analysis/search/footage.db 'PRAGMA integrity_check;'
```

## 20. Build Report Shape

`03_analysis/search/footage-db-build-report.json` should be JSON:

```json
{
  "artifact_version": "footage-db-build-report-v1",
  "project_id": "project-id",
  "db_path": "03_analysis/search/footage.db",
  "created_at": "2026-06-19T00:00:00.000Z",
  "schema_version": "1",
  "embedding_status": "skipped",
  "embedding_model_id": null,
  "source_hashes": {
    "03_analysis/assets.json": "sha256:...",
    "03_analysis/segments.json": "sha256:..."
  },
  "counts": {
    "assets": 0,
    "segments": 0,
    "fts_rows": 0,
    "marlin_events": 0,
    "transcript_segments": 0,
    "embeddings": 0
  },
  "warnings": []
}
```

## 21. Self-Review

Rubric score before final pass: 91/100.

Remaining deductions:

- Driver decision still needs approval before implementation.
- The exact relationship with the existing P4d JSON search index needs a rollout decision.
- Shooting metadata remains nullable because current artifacts do not provide a stable source.

Final check:

- Practical for <1000 segments: yes.
- Offline: yes for structured/FTS; semantic degrades unless cached model exists.
- Existing-code integration: yes, via `semantic-match.ts`, `editorial-tools.ts`, `runtime/mcp/repository.ts`, and P4d-style status helpers.
- Agent API: yes, one primary tool with evidence-rich response; flat adapter matches current registry.
- Dependency risk: flagged, with `sqlite-vss` rejected for MVP.
