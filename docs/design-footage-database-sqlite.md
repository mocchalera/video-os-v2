# Footage Database Design: SQLite + FTS5 + Local Embeddings

Date: 2026-06-19
Scope: design only. This document proposes a SQLite-first footage search layer for projects with fewer than 1,000 segments.

## 1. Purpose And Success Conditions

The current editing flow starts from a flat `03_analysis/segments.json` and only gives the editorial agent the candidates that triage already selected. That makes later rough and fine passes weak at recovery: if triage missed a warm indoor scene, a food dialogue moment, or a specific morning exterior, the editor cannot search the full pool.

This design adds one local query engine:

```text
03_analysis/footage.db
```

SQLite is the single storage engine for structured metadata, FTS5 text search, and embedding vectors. Canonical artifacts such as `assets.json`, `segments.json`, `marlin_events.json`, and transcript JSON files remain the portable source artifacts, but all agent search runs through this database once it is built.

Success means:

- `search_footage("warm indoor scenes", filters)` can rank the full segment pool, not only pre-selected candidates.
- Japanese and English evidence can be searched in one text index, for example `栗 OR chestnut`.
- Semantic queries use the existing local `Xenova/multilingual-e5-small` path from `runtime/eval/semantic-match.ts`; no cloud vector database is required.
- Structured filters for date, time, camera, duration, quality scores, and place hints can combine with text or vector ranking.
- The database is rebuildable and can be incrementally refreshed when source artifacts change.

Non-goals for the first implementation:

- Making SQLite the canonical authoring format for analysis artifacts.
- Scaling beyond single-project, sub-1,000-segment libraries.
- Requiring `sqlite-vss`, external vector stores, or remote embedding APIs.
- Changing `segments.schema.json` or the selects/blueprint schemas as part of the database build.

## 2. Existing Inputs

The builder reads the same project-local artifacts that the current pipeline already produces:

| Artifact | Relevant fields |
| --- | --- |
| `03_analysis/assets.json` | `asset_id`, `filename`, `display_name`, `duration_us`, `transcript_ref`, asset tags and quality flags |
| `03_analysis/segments.json` | `segment_id`, `asset_id`, `src_in_us`, `src_out_us`, `summary`, `transcript_excerpt`, `tags`, `quality_flags`, `visual_quality`, `visual_appraisal` |
| `03_analysis/marlin_events.json` | asset-level `scene`, timestamped `events`, descriptions, confidence, find results |
| `03_analysis/transcripts/*.json` | asset-level utterances with `start_us`, `end_us`, `text`, `language`, confidence |

The current segment schema is closed, but already supports optional `visual_quality` and `visual_appraisal`. The database should flatten those fields for query while preserving the original JSON shapes where useful.

### Repo Grounding

This design is based on the current repo contracts:

- `runtime/artifacts/p4d-segment-search-index.ts` already defines a manifest/text-index/stale-hash pattern for search artifacts. The new database should reuse that input-hash discipline, but put searchable text, structured fields, and vectors in SQLite instead of separate JSON indexes.
- `runtime/eval/semantic-match.ts` already exposes `Xenova/multilingual-e5-small`, `q8`, local cache resolution, `query:` / `passage:` prefixes, normalized vector generation, and cosine scoring.
- `schemas/segments.schema.json` requires `segment_id`, `asset_id`, source in/out, `summary`, `transcript_excerpt`, `quality_flags`, and `tags`, and it already allows optional `visual_quality` and `visual_appraisal`.
- `runtime/connectors/marlin-types.ts` models Marlin as asset-level scene text plus timestamped `events`, which is why segment search joins Marlin rows by asset/time overlap rather than copying every event into `segments`.

## 3. SQLite Schema

The database uses normal tables for structured filters, FTS5 for lexical retrieval, and a plain BLOB table for vectors. Foreign keys are enabled. JSON columns store canonical arrays or objects as UTF-8 JSON text so the database remains portable across stock SQLite builds.

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE assets (
  asset_id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  display_name TEXT,
  duration_us INTEGER NOT NULL CHECK (duration_us >= 0),
  shooting_date TEXT,       -- ISO date, e.g. 2026-08-21
  shooting_time TEXT,       -- local HH:MM:SS if known
  camera_type TEXT
);

CREATE INDEX idx_assets_shooting_date ON assets(shooting_date);
CREATE INDEX idx_assets_camera_type ON assets(camera_type);

CREATE TABLE segments (
  segment_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
  src_in_us INTEGER NOT NULL CHECK (src_in_us >= 0),
  src_out_us INTEGER NOT NULL CHECK (src_out_us > src_in_us),
  summary TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',          -- JSON string array
  quality_flags TEXT NOT NULL DEFAULT '[]', -- JSON string array
  duration_us INTEGER GENERATED ALWAYS AS (src_out_us - src_in_us) VIRTUAL
);

CREATE INDEX idx_segments_asset_time ON segments(asset_id, src_in_us, src_out_us);
CREATE INDEX idx_segments_duration ON segments(duration_us);

CREATE TABLE marlin_events (
  event_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
  start_us INTEGER NOT NULL CHECK (start_us >= 0),
  end_us INTEGER NOT NULL CHECK (end_us >= start_us),
  description TEXT NOT NULL DEFAULT '',
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

CREATE INDEX idx_marlin_events_asset_time ON marlin_events(asset_id, start_us, end_us);

CREATE TABLE visual_quality (
  segment_id TEXT PRIMARY KEY REFERENCES segments(segment_id) ON DELETE CASCADE,
  composition REAL CHECK (composition IS NULL OR (composition >= 0 AND composition <= 1)),
  light REAL CHECK (light IS NULL OR (light >= 0 AND light <= 1)),
  focus REAL CHECK (focus IS NULL OR (focus >= 0 AND focus <= 1)),
  subject_prominence REAL CHECK (subject_prominence IS NULL OR (subject_prominence >= 0 AND subject_prominence <= 1)),
  emotional_expression REAL CHECK (emotional_expression IS NULL OR (emotional_expression >= 0 AND emotional_expression <= 1)),
  motion REAL CHECK (motion IS NULL OR (motion >= 0 AND motion <= 1))
);

CREATE INDEX idx_visual_quality_composition ON visual_quality(composition);
CREATE INDEX idx_visual_quality_light ON visual_quality(light);

CREATE TABLE visual_appraisal (
  segment_id TEXT PRIMARY KEY REFERENCES segments(segment_id) ON DELETE CASCADE,
  extracted_text TEXT NOT NULL DEFAULT '[]', -- JSON array from visual_appraisal.extracted_text
  place_hint_name TEXT,
  place_hint_category TEXT,
  aesthetic_notes TEXT NOT NULL DEFAULT '[]' -- JSON string array
);

CREATE INDEX idx_visual_appraisal_place ON visual_appraisal(place_hint_category, place_hint_name);

CREATE TABLE transcripts (
  segment_id TEXT PRIMARY KEY REFERENCES segments(segment_id) ON DELETE CASCADE,
  text TEXT NOT NULL DEFAULT '',
  language TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

CREATE TABLE embeddings (
  segment_id TEXT NOT NULL REFERENCES segments(segment_id) ON DELETE CASCADE,
  field TEXT NOT NULL CHECK (field IN ('summary', 'transcript', 'scene', 'combined')),
  vector BLOB NOT NULL,
  model_id TEXT NOT NULL,
  dimension INTEGER NOT NULL CHECK (dimension > 0),
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (segment_id, field, model_id)
);

CREATE INDEX idx_embeddings_model_field ON embeddings(model_id, field);
```

Two small operational tables make incremental rebuild practical:

```sql
CREATE TABLE db_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE segment_index_state (
  segment_id TEXT PRIMARY KEY,
  segment_hash TEXT NOT NULL,
  asset_hash TEXT NOT NULL,
  transcript_hash TEXT,
  marlin_hash TEXT,
  embedding_text_hash TEXT,
  indexed_at TEXT NOT NULL
);
```

### Field Mapping

`assets.shooting_date`, `shooting_time`, and `camera_type` are nullable because the current asset schema does not require them. The first builder should derive them from available source metadata, filename conventions, sidecar metadata, or leave them null. It must not invent values.

`visual_quality` flattens the current schema:

| SQLite column | Source |
| --- | --- |
| `composition` | `visual_quality.scores.composition_score` |
| `light` | `visual_quality.scores.light_quality` |
| `focus` | appraiser `focus_sharpness` if available; otherwise null |
| `subject_prominence` | `visual_quality.scores.subject_prominence` |
| `emotional_expression` | `visual_quality.scores.emotional_expression` |
| `motion` | `visual_quality.scores.motion_quality` |

`transcripts.text` should be the full text overlapping the segment from transcript items. If no transcript file is available, fall back to `segments[].transcript_excerpt`.

Marlin events are asset-level. Segment search joins them by overlap:

```sql
e.asset_id = s.asset_id
AND e.end_us > s.src_in_us
AND e.start_us < s.src_out_us
```

## 4. FTS5 Text Search

The database keeps one segment-level FTS table. Each row is a segment search document assembled from summary, overlapping Marlin event descriptions, transcript text, OCR/extracted text, and tags.

```sql
CREATE VIRTUAL TABLE segments_fts USING fts5(
  segment_id UNINDEXED,
  asset_id UNINDEXED,
  summary,
  marlin_events,
  transcript,
  extracted_text,
  tags,
  tokenize = 'unicode61 remove_diacritics 2 tokenchars ''_-'''
);
```

Build-time population:

```sql
INSERT INTO segments_fts (
  segment_id,
  asset_id,
  summary,
  marlin_events,
  transcript,
  extracted_text,
  tags
)
VALUES (?, ?, ?, ?, ?, ?, ?);
```

The builder flattens JSON before inserting:

- `tags`: joined tag strings, plus CJK unigram/bigram expansions when tags contain Japanese.
- `extracted_text`: joined OCR text values from `visual_appraisal.extracted_text`.
- `marlin_events`: joined descriptions for events overlapping the segment.
- `summary`: the segment summary, which may already be Marlin-owned scene text.

Japanese and English are stored in the same FTS table. FTS5 does not provide high-quality Japanese morphology by default, so the practical first version should expand Japanese text at build time into searchable CJK character and bigram tokens while preserving the original text. That keeps the runtime dependency surface small and allows the query shape the agent needs:

```sql
SELECT *
FROM segments_fts
WHERE segments_fts MATCH '栗 OR chestnut';
```

Ranked form:

```sql
SELECT segment_id, asset_id, bm25(segments_fts) AS lexical_score
FROM segments_fts
WHERE segments_fts MATCH '栗 OR chestnut'
ORDER BY lexical_score
LIMIT 20;
```

If a local SQLite build has a better tokenizer extension available, the builder can expose `--fts-tokenizer` later, but the MVP must work with stock SQLite FTS5.

## 5. Vector Search

The embedding layer reuses the current local semantic path:

- Model: `Xenova/multilingual-e5-small`
- Runtime: `@huggingface/transformers`
- Dtype: `q8`
- Prefixes: `query:` for queries, `passage:` for stored text
- Similarity: cosine similarity over L2-normalized vectors

This matches `runtime/eval/semantic-match.ts`, where vectors are normalized and `cosineSimilarity()` is a dot product.

### Embedded Text Bundles

The builder writes one or more rows per segment:

| `field` | Text bundle |
| --- | --- |
| `summary` | segment summary plus tags |
| `transcript` | segment transcript text plus speaker/utterance context when available |
| `scene` | Marlin scene plus overlapping event descriptions plus tags |
| `combined` | summary, transcript, scene, tags, extracted text, place hint, aesthetic notes |

`combined` is the default semantic retrieval field. Source-specific rows are useful when an agent explicitly asks for dialogue-only or scene-only material.

Vectors are stored as little-endian `Float32Array` bytes:

```text
embeddings.vector = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
embeddings.dimension = 384
embeddings.model_id = "Xenova/multilingual-e5-small:q8"
```

The vector is already normalized before storage. `content_hash` is the normalized hash of the text bundle so incremental rebuild can avoid recomputing unchanged embeddings.

### Brute Force Query

For fewer than 1,000 segments, brute force scanning is the simplest reliable option:

1. Embed the user query with prefix `query:`.
2. Run the structured SQL filter first to get eligible `segment_id`s.
3. Load matching vectors from `embeddings`, normally `field = 'combined'`.
4. Decode each BLOB as `Float32Array`.
5. Compute cosine similarity.
6. Sort by score descending, with deterministic tie-breakers.

Pseudo-SQL for the load step:

```sql
SELECT e.segment_id, e.field, e.vector, s.asset_id, s.src_in_us, s.src_out_us
FROM embeddings e
JOIN segments s ON s.segment_id = e.segment_id
JOIN assets a ON a.asset_id = s.asset_id
LEFT JOIN visual_quality vq ON vq.segment_id = s.segment_id
LEFT JOIN visual_appraisal va ON va.segment_id = s.segment_id
WHERE e.model_id = ?
  AND e.field = 'combined'
  AND (:shooting_date IS NULL OR a.shooting_date = :shooting_date)
  AND (:camera_type IS NULL OR a.camera_type = :camera_type)
  AND (:duration_min_us IS NULL OR s.duration_us >= :duration_min_us)
  AND (:duration_max_us IS NULL OR s.duration_us <= :duration_max_us)
  AND (:composition_min IS NULL OR vq.composition >= :composition_min)
  AND (:place_hint_category IS NULL OR va.place_hint_category = :place_hint_category);
```

At 1,000 segments x 4 fields x 384 dimensions, a full scan is still small enough for an interactive CLI/tool call. If this becomes a bottleneck, add `sqlite-vss` as an optional accelerator without changing the logical schema. The default path must remain the BLOB scan so the feature works offline on stock SQLite.

## 6. Structured Queries

Structured filters should be first-class, not prompt-only instructions. The query layer should support at least:

| Filter | SQL source |
| --- | --- |
| `shooting_date` | `assets.shooting_date` |
| `shooting_time_range` | `assets.shooting_time` |
| `camera_type` | `assets.camera_type` |
| `duration_us` range | `segments.duration_us` |
| `quality_min.composition` | `visual_quality.composition` |
| `quality_min.light` | `visual_quality.light` |
| `quality_min.focus` | `visual_quality.focus` |
| `quality_min.subject_prominence` | `visual_quality.subject_prominence` |
| `quality_min.emotional_expression` | `visual_quality.emotional_expression` |
| `quality_min.motion` | `visual_quality.motion` |
| `place_hint_name` | `visual_appraisal.place_hint_name` |
| `place_hint_category` | `visual_appraisal.place_hint_category` |
| `exclude_quality_flags` | `segments.quality_flags` JSON |

Example: "outdoor scenes from Aug 21 with composition > 0.7":

```sql
SELECT
  s.segment_id,
  s.asset_id,
  s.src_in_us,
  s.src_out_us,
  s.summary,
  vq.composition,
  bm25(segments_fts) AS lexical_score
FROM segments_fts
JOIN segments s ON s.segment_id = segments_fts.segment_id
JOIN assets a ON a.asset_id = s.asset_id
JOIN visual_quality vq ON vq.segment_id = s.segment_id
WHERE segments_fts MATCH 'outdoor OR exterior OR outside'
  AND a.shooting_date = '2026-08-21'
  AND (a.shooting_time IS NULL OR a.shooting_time BETWEEN '05:00:00' AND '11:59:59')
  AND vq.composition > 0.7
ORDER BY vq.composition DESC, lexical_score ASC
LIMIT 20;
```

JSON filters can start with simple application-side checks after a coarse SQL candidate set. For example, `exclude_quality_flags` can load `segments.quality_flags` and reject rows in TypeScript. If JSON1 is guaranteed in the local SQLite package, this can move into SQL later:

```sql
NOT EXISTS (
  SELECT 1
  FROM json_each(s.quality_flags)
  WHERE json_each.value IN ('blurry', 'underexposed')
)
```

## 7. Hybrid Ranking

The agent should not have to choose between exact text and semantic search for normal material lookup. The query tool should support:

- `mode: "text"`: FTS5 only.
- `mode: "semantic"`: embedding scan only.
- `mode: "structured"`: filters only.
- `mode: "hybrid"`: structured prefilter, FTS5 lexical score, vector score, then fused ranking.

Suggested MVP fusion:

```text
final_score =
  0.55 * semantic_score_normalized +
  0.30 * lexical_score_normalized +
  0.15 * quality_score_bonus
```

Where:

- `semantic_score_normalized` is the cosine score clipped to `[0, 1]`.
- `lexical_score_normalized` maps lower BM25 values to higher scores within the candidate set.
- `quality_score_bonus` averages available quality minima relevant to the query, defaulting to 0 when absent.

Every result must include evidence fields so the editor can inspect why a segment ranked:

```json
{
  "segment_id": "SEG_AST_001_0003",
  "asset_id": "AST_001",
  "src_in_us": 12000000,
  "src_out_us": 18000000,
  "score": 0.86,
  "scores": {
    "semantic": 0.84,
    "lexical": 0.72,
    "quality": 0.91
  },
  "evidence": {
    "matched_fields": ["summary", "marlin_events", "tags"],
    "summary": "Warm indoor cooking scene with chestnuts on the table.",
    "marlin_events": ["Person prepares food at an indoor table."],
    "transcript_excerpt": "栗ごはんの話をしています。",
    "tags": ["indoor", "food", "warm_light"]
  }
}
```

## 8. Editorial Agent Integration

Expose one read-only tool to agents:

```ts
type SearchFootageInput = {
  query: string;
  mode?: "hybrid" | "text" | "semantic" | "structured";
  filters?: {
    shooting_date?: string;
    shooting_time_start?: string;
    shooting_time_end?: string;
    camera_type?: string;
    duration_min_us?: number;
    duration_max_us?: number;
    quality_min?: {
      composition?: number;
      light?: number;
      focus?: number;
      subject_prominence?: number;
      emotional_expression?: number;
      motion?: number;
    };
    place_hint_name?: string;
    place_hint_category?: string;
    include_tags_any?: string[];
    exclude_quality_flags?: string[];
  };
  limit?: number;
};
```

Return ranked segment evidence:

```ts
type SearchFootageResult = {
  query: string;
  mode: string;
  db_path: string;
  results: Array<{
    segment_id: string;
    asset_id: string;
    src_in_us: number;
    src_out_us: number;
    score: number;
    scores: {
      semantic?: number;
      lexical?: number;
      quality?: number;
    };
    summary: string;
    tags: string[];
    quality_flags: string[];
    transcript_excerpt?: string;
    marlin_events?: string[];
    place_hint?: {
      name?: string;
      category?: string;
    };
    evidence: string[];
  }>;
};
```

Integration points:

1. Replace the current in-memory `searchSegments` lexical implementation with a SQLite-backed adapter when `03_analysis/footage.db` exists.
2. Keep a compatibility fallback to the current flat JSON search when the DB is missing, but report `footage_db_status: "missing"` so automation can request a rebuild.
3. Let triage use `search_footage` to build `selects_candidates.yaml` from the full pool instead of compacting all segments into one prompt.
4. Let the unified editorial agent call `search_footage` during rough pass when a beat lacks coverage.
5. Let fine pass call `search_footage` for alternates when a selected clip is too short, low quality, repetitive, or does not match the beat after craft review.

This changes the mental model from:

```text
analysis -> triage picks candidates -> editor can only edit candidates
```

to:

```text
analysis -> SQLite footage DB -> triage/editor can search full pool -> selected candidates become working state
```

The editor should still materialize chosen segments into existing candidate and blueprint artifacts. The database is a retrieval layer, not a new planning artifact schema.

## 9. Build And Update Workflow

Add a future builder:

```text
scripts/build-footage-db.ts
```

Command shape:

```bash
npx tsx scripts/build-footage-db.ts --project projects/<id> --output projects/<id>/03_analysis/footage.db
```

Inputs:

- `03_analysis/assets.json`
- `03_analysis/segments.json`
- `03_analysis/marlin_events.json`
- `03_analysis/transcripts/*.json`

Outputs:

- `03_analysis/footage.db`
- optional `03_analysis/footage-db-build-report.json` with counts, skipped rows, embedding status, source hashes, and stale reasons.

Build steps:

1. Open a temp database at `03_analysis/.footage.db.tmp`.
2. Enable foreign keys and create the schema.
3. Read and validate source JSON artifacts with existing schema validators where available.
4. Upsert assets, preserving nullable metadata when it cannot be derived.
5. Upsert segments and flattened visual quality/appraisal rows.
6. Project transcript utterances onto segments by time overlap and write `transcripts`.
7. Import Marlin events and compute segment-overlapping event text.
8. Populate `segments_fts`.
9. Compute or reuse embeddings for changed text bundles.
10. Write `db_meta` and `segment_index_state`.
11. Run integrity checks.
12. Atomically rename the temp database to `03_analysis/footage.db`.

### Incremental Rebuild

Incremental rebuild compares normalized hashes:

- `segment_hash`: stable hash of segment fields that affect search.
- `asset_hash`: stable hash of asset fields that affect filters.
- `transcript_hash`: stable hash of overlapping transcript text.
- `marlin_hash`: stable hash of overlapping Marlin scene/events.
- `embedding_text_hash`: stable hash of each embedded text bundle.

If only structured asset metadata changed, update `assets` and skip embeddings. If segment summary, transcript, Marlin text, tags, extracted text, or place hints changed, refresh FTS and affected embeddings. If a segment disappears from `segments.json`, delete it and rely on cascading deletes.

### Embedding Computation

On first build, batch all segment text bundles through `multilingual-e5-small`:

```text
passage: <summary/tags bundle>
passage: <transcript bundle>
passage: <Marlin scene/events bundle>
passage: <combined bundle>
```

Offline behavior:

- Use `VIDEO_OS_EMBEDDING_CACHE_DIR` when set; otherwise reuse the existing user cache convention from `semantic-match.ts`.
- Default to local files only.
- Do not download model files unless the operator explicitly sets `VIDEO_OS_ALLOW_REMOTE_EMBEDDING_MODELS=1`.
- If the model is absent and embeddings are required, fail with a clear setup error before writing a partial DB.
- If the command is run with a future `--skip-embeddings`, still build structured and FTS search but mark `db_meta.embedding_status = "skipped"`.

## 10. Roadmap

### Phase 1: SQLite MVP

- Add `scripts/build-footage-db.ts`.
- Build `assets`, `segments`, `marlin_events`, `visual_quality`, `visual_appraisal`, `transcripts`, and `segments_fts`.
- Implement structured filters and FTS5 search.
- Add focused tests with a tiny fixture containing Japanese and English text.
- Acceptance: `栗 OR chestnut` returns the expected segment from `segments_fts`; date/time/quality filters work.

### Phase 2: Local Embeddings

- Reuse `embedTexts()` and `cosineSimilarity()` from `runtime/eval/semantic-match.ts`.
- Store normalized `Float32Array` vectors as BLOB rows in `embeddings`.
- Add brute-force vector scan and hybrid ranking.
- Add cache/hash checks so unchanged segment text does not re-embed.
- Acceptance: Japanese queries can rank English scene evidence without FTS token overlap.

### Phase 3: Agent Tool Adapter

- Add a `search_footage(query, filters)` runtime adapter around the DB.
- Replace the current lexical-only `searchSegments` path when `footage.db` exists.
- Return ranked evidence with scores and matched fields.
- Acceptance: the unified editor can request alternates from the full pool during rough or fine pass.

### Phase 4: Workflow And Readiness

- Add a DB status command that reports existence, source hashes, row counts, embedding model id, and stale reasons.
- Add a warning-oriented stale check for search-dependent automation.
- Rebuild automatically after analysis or Marlin-only evaluation when artifacts change.
- Acceptance: a stale or missing DB is visible before agent search, but final render is not blocked unless a full-autonomy search task explicitly requires it.

### Phase 5: Optional Acceleration

- Detect `sqlite-vss` or another local vector extension if installed.
- Keep the same `embeddings` logical table and fall back to BLOB scan when unavailable.
- Acceptance: results remain equivalent within deterministic tie-break rules.

## 11. Security And Reliability Requirements

- Agent-facing search opens SQLite in read-only mode.
- SQL filters use bound parameters. Do not interpolate dates, durations, camera types, place hints, or quality thresholds into SQL strings.
- FTS `MATCH` strings go through a small query builder that quotes user phrases, preserves explicit boolean operators only when requested, and rejects unsupported syntax. The examples in this document are the intended SQL shape, not a license to pass unescaped prompt text directly into `MATCH`.
- Embedding search never sends transcripts, OCR text, tags, summaries, or user queries to a remote API by default.
- Rebuild writes to a temporary database and atomically renames only after `PRAGMA integrity_check`, expected row-count checks, and embedding status checks pass.
- If a rebuild fails, keep the previous `footage.db` and write the failure to the build report. Do not leave a half-populated database at the final path.
- Treat the DB as derived private project data. It can contain transcript text and OCR text, so it should follow the same sharing rules as `03_analysis`.

## 12. Risks And Mitigations

| Risk | Mitigation |
| --- | --- |
| FTS5 default tokenization is weak for Japanese | Expand CJK unigrams/bigrams at build time and preserve original text. Keep embeddings as the main cross-language path. |
| Embedding model is not cached offline | Preflight cache availability. Require explicit opt-in for remote download. Provide `--skip-embeddings` only for text/structured-only DBs. |
| SQLite DB becomes stale relative to JSON artifacts | Store source hashes and expose stale reasons. Rebuild atomically. |
| Agent over-trusts semantic matches | Return evidence snippets and component scores. Use hybrid ranking and quality filters, not vector score alone. |
| Asset shooting metadata is missing | Keep date/time/camera nullable. Do not invent metadata. Query filters simply exclude nulls unless the filter allows unknowns. |
| Future schema changes move fields | Builder maps from canonical artifacts at the boundary; tests should cover missing optional visual fields and older artifacts. |

## 13. Verification Strategy

For the implementation, use fixture-level checks before project-scale tests:

- Schema creation succeeds on stock SQLite with FTS5 enabled.
- Empty optional artifacts still produce a valid DB with structured segment rows.
- `segments_fts MATCH '栗 OR chestnut'` returns the fixture segment.
- Semantic search ranks a Japanese query against English evidence using cached `multilingual-e5-small`.
- Structured filters combine with FTS and semantic modes.
- Incremental rebuild changes only rows whose source hashes changed.
- Deleting a segment removes dependent FTS, transcript, quality, appraisal, and embedding rows.
- Missing embedding cache fails clearly when embeddings are required and does not silently call the network.

## 14. Open Decisions

| Decision | Default for MVP | Resolve when |
| --- | --- | --- |
| Where to derive `shooting_date`, `shooting_time`, and `camera_type` | Nullable columns populated only from reliable metadata | We inventory real project media metadata and filename conventions |
| Whether `combined` embeddings are enough | Store `combined` plus source-specific rows | Benchmarks show whether source-specific rows improve agent choices |
| Whether to require JSON1 | Do not require it for MVP; perform JSON array filters in TypeScript | Local SQLite package guarantees JSON1 |
| Whether stale DB blocks automation | Warn by default; block only for explicit full-autonomy search tasks | Release-safety policy is updated |
