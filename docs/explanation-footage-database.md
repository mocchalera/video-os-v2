# Footage Database Architecture Explained

This document explains the current footage database in plain language. It is written for understanding the system as it exists now: what it stores, how search works, what semantic/vector search is meant to do, and how the editorial agent uses it.

The short version: the footage database is a project-local SQLite search database built from the analyzed footage artifacts. It is not the source of truth for the edit. It is a searchable index over the footage, so an agent can ask targeted questions like "show me chestnut clips", "find a stable high-quality food closeup", or "find unused material for this beat" without scanning every JSON record by hand.

```text
analysis artifacts
  assets + segments + Marlin events + OCR/appraisal + transcripts
        |
        v
project-local SQLite footage database
        |
        +--> text search
        +--> semantic search when embeddings are present
        +--> structured filters
        |
        v
editorial tools return candidate clips with evidence
```

## 1. Overview

Before this database, the system mostly had flat JSON files. Those files are good as canonical analysis artifacts, but poor as a retrieval surface:

- A user or agent had to scan segment records linearly.
- Search was basically "look through text fields and hope the wording matches."
- Combining conditions was awkward: for example, "find a chestnut clip that is stable, visually decent, and not already used."
- The agent's candidate pool tended to be fixed early. If a later QA pass found a weak clip, the agent had limited ability to go back into the full footage pool.

The footage database changes that. It copies the already-analyzed facts into SQLite tables and adds three retrieval lanes:

- Full-text search for summaries, OCR, tags, place hints, Marlin scene text, and Marlin events.
- Semantic search through local multilingual embeddings, when the database has vectors populated.
- Structured filters over typed columns such as quality score, duration, camera stability, dialogue presence, usability, and date/camera metadata when those source fields are populated.

This keeps the canonical data model simple. The database is derived and rebuildable. It helps the agent find footage; it does not directly write candidates, blueprints, timelines, or final media.

## 2. What Data Is Stored

The current ena-promo-ai database has 89 assets and 89 segments. In this project, each asset currently maps to one segment, but the schema supports multiple segments per asset.

### `assets`

This is the row for each original video file. It stores the asset id, filename, duration, transcript reference if available, source order, tags, quality flags, and optional shooting metadata.

Example from ena:

```text
asset_id: AST_628B1F09
filename: Blackmagic Pocket Cinema Camera_1_2015-08-21_0347_C0005.mov
duration: 12.54 seconds
```

The filenames contain shooting dates. In the current ena database, however, the typed `shooting_date` column is not populated. A readback found 0 assets with `shooting_date`, while filename parsing shows 33 files from 2015-08-21. So date filtering is schema-supported, but this current artifact should not be treated as having clean typed shooting dates yet.

### `asset_technical`

This stores technical media facts for each asset: codec, resolution, frame rate, audio channels, and recording format.

Example:

```text
asset_id: AST_628B1F09
codec: prores
resolution: 1920x1080
fps: 24/1
audio_channels: 2
recording_format: mov
```

This is useful when the editor wants to avoid technically incompatible or low-quality sources later. Right now the ena assets are consistently ProRes MOV at 1920x1080, 24 fps.

### `segments`

This is the searchable clip unit. A segment has an asset id, source in/out time, duration, summary, transcript excerpt, tags, quality flags, and frame/waveform references when available.

Example:

```text
segment_id: SEG_AST_628B1F09_0001
asset: Blackmagic Pocket Cinema Camera_1_2015-08-21_0347_C0005.mov
range: 0.00s to 12.54s
summary: close-up high-angle view of brown fuzzy chestnuts on dry leaves, with a slow steady zoom-in
```

The segment summary is one of the main search surfaces. It lets "chestnut" match this clip even if the original filename says nothing about chestnuts.

### `visual_quality`

This stores numeric visual quality signals from 0 to 1:

- `light_quality`
- `subject_prominence`
- `emotional_expression`
- `composition_score`
- `motion_quality`

Example:

```text
segment_id: SEG_AST_628B1F09_0001
light_quality: 0.60
subject_prominence: 0.90
emotional_expression: 0.40
composition_score: 0.80
motion_quality: 0.85
lighting_style: low_key
composition_tags: medium_shot
```

There is no separate numeric focus score in the current table. Focus/blur currently appears indirectly in quality flags or appraisal notes. For example, another chestnut/orchard clip has an appraisal note saying it suffers from severe motion blur, but that is not yet a dedicated `focus_score` column.

### `visual_appraisal`

This stores what the visual appraisal pass saw in a representative frame: OCR text, place hints, place confidence, and aesthetic notes.

Example with Japanese OCR:

```text
segment_id: SEG_AST_42069045_0001
extracted_text: 里の菓 栗 茶房
place_hint_name: 里の菓 栗 茶房
place_hint_category: cafe
place_hint_confidence: 0.90
notes: rustic wooden table, calm atmosphere, dessert and drink framed as the focus
```

Example without OCR but with place/aesthetic context:

```text
segment_id: SEG_AST_628B1F09_0001
place_hint_category: natural_setting
place_hint_confidence: 0.70
notes: central chestnut isolated by shallow depth of field; earthy color palette; natural textures
```

This is why text search can find a Japanese sign such as `栗` even when the English summary is about a meal or cafe scene.

### `marlin_events`

This stores temporal events inside each asset. Instead of only knowing "this clip has a person", the database can know "at 14.5s the man looks at the fruit and smiles slightly."

The current ena database has 301 Marlin events.

Examples:

```text
asset: Blackmagic Pocket Cinema Camera_1_2015-08-21_0307_C0007.mov
14.5s-17.5s: The man looks at the fruit and smiles slightly.

asset: Blackmagic Pocket Cinema Camera_1_2015-07-25_0622_C0010.mov
26.5s-31.5s: The woman looks up and smiles broadly.
```

This is especially useful for editorial timing. A clip summary may say "tomato garden", but Marlin events can identify the exact smile, gesture, turn, or action peak inside that clip.

### `segment_transcripts`

This stores dialogue text per segment when transcript data exists. It also records language, minimum confidence, and whether the segment has dialogue.

Current ena state:

```text
segment_transcripts rows: 89
rows with transcript text: 0
rows marked has_dialogue: 0
example segment: SEG_AST_02352E6C_0001, text: empty, has_dialogue: false
```

So the table is present and ready, but this specific ena database does not currently have dialogue transcript content. Search is therefore relying on visual summaries, OCR, tags, place hints, and Marlin events rather than spoken dialogue.

### `embedding_texts` and `embeddings`

These are the semantic search tables.

`embedding_texts` stores the text that would be embedded for each segment. The current database has 356 embedding text rows: 4 text bundles for each of 89 segments.

The four text bundles are:

- `summary`
- `transcript`
- `scene`
- `combined`

Example:

```text
segment_id: SEG_AST_628B1F09_0001
field: combined
text: summary + tags + Marlin scene/events + OCR/place/appraisal text + visual metadata
```

`embeddings` stores the actual vectors. Each vector is a compact binary blob, with a model id and dimension. When populated, these are 384-dimensional vectors from a local multilingual E5 model.

Current ena state:

```text
embedding_status: skipped
embedding_texts: 356
embeddings: 0
```

That means the current ena database is ready for semantic indexing, but it does not currently contain actual semantic vectors. Text search and structured search work now. True vector search would require rebuilding/populating the embeddings.

### `segment_visual_profile`

This stores editorial/cinematography metadata such as camera motion, shot scale, stability, and subject position.

Example:

```text
segment_id: SEG_AST_628B1F09_0001
camera_motion: static
stability: stable
shot_scale: closeup
```

This lets the agent ask for "stable closeups" or avoid shaky footage without reading prose summaries.

### `segment_audio_profile`

This stores simple audio flags: dialogue, music, ambient audio, silence, and optional loudness fields.

Example:

```text
segment_id: SEG_AST_628B1F09_0001
has_dialogue: false
has_music: false
has_ambient: true
has_silence: false
```

In the current ena data, audio loudness values are not populated, but the dialogue/ambient flags are present.

### `segment_logging`

This stores production/logging-style fields: scene number, shot number, take number, usability, roll type, and user notes.

Example:

```text
segment_id: SEG_AST_628B1F09_0001
take_number: 5
usability: fully_usable
```

For ena, the take number is inferred from filenames like `C0005`. Scene and shot numbers are mostly empty in the current data.

### Search and Provenance Tables

There are also supporting tables:

- `segments_fts`: the full-text search index over summaries, transcripts, Marlin text, tags, OCR, place hints, and aesthetic notes.
- `metadata_fts`: a small full-text index over visual metadata like camera motion and shot scale.
- `footage_db_meta`: build metadata such as artifact version, project id, creation time, and embedding status.
- `footage_db_sources`: hashes of the source artifacts used to build the database.
- `footage_db_warnings`: build warnings. The current ena database has 0 warnings.

These are mostly operational. They explain whether the database is fresh, searchable, and safe to use.

## 3. How Text Search Works: FTS5

FTS5 is SQLite's built-in full-text search engine. It is different from a simple `LIKE` search or grep because it builds an inverted index: a fast lookup table from terms to rows. Instead of scanning every character in every segment summary, SQLite can jump directly to rows containing search terms.

In this database, FTS5 indexes multiple evidence fields at once:

- segment summary
- transcript text, when available
- Marlin scene/caption text
- Marlin temporal event descriptions
- tags and quality labels
- OCR text
- place hints
- aesthetic notes

For Japanese text, stock FTS5 is not a full Japanese tokenizer. The database compensates by adding CJK character and bigram expansions at index time. For example, `里の菓 栗 茶房` is indexed not only as the full phrase, but also with useful Japanese character/bigram pieces. This improves recall for queries like `栗`.

Important distinction: FTS5 itself does not translate. Japanese-English "cross-language" text search works here because the indexed evidence is multilingual:

- OCR may contain Japanese, such as `里の菓 栗 茶房`.
- Generated summaries may contain English, such as `chestnuts`.
- A query can explicitly include both terms, such as `栗 OR chestnut`.
- Project context can add aliases when the agent has them.

Actual ena text query:

```text
query: 栗 OR chestnut
mode: text
boolean OR enabled

top matches:
1. SEG_AST_42069045_0001
   reason: OCR/place contains 里の菓 栗 茶房; summary describes soba/dessert on a wooden table

2. SEG_AST_45CAE530_0001
   reason: English summary says chestnut or hawthorn grove; Marlin events describe fruit picking

3. SEG_AST_628B1F09_0001
   reason: English summary describes fuzzy chestnuts on dry leaves
```

That last detail matters: this is the Boolean text-search form of the query. Plain natural-language mode treats `OR` as an ordinary word for safety.

This differs from grep in three ways:

- It searches several normalized evidence fields together, not one file at a time.
- It can rank matches, rather than only returning "line contains string."
- It can be combined with structured filters, such as `composition_score > 0.7` and `stability = stable`.

## 4. How Vector and Embedding Search Works

An embedding is a list of numbers that represents meaning. Similar meanings end up near each other in the number space.

The architecture uses a local multilingual model:

```text
model: Xenova/multilingual-e5-small
dimension: 384 numbers per vector
storage: binary blob inside SQLite
service: local, no external API required
```

The process is:

1. Each clip's searchable text is combined into a text bundle.
2. That text bundle is converted into a 384-number vector.
3. The user's query, such as `warm indoor scene`, is also converted into a 384-number vector.
4. The system compares the query vector with each clip vector using cosine similarity.
5. Clips with closer vectors are ranked higher.

```text
"warm indoor scene"
        |
        v
query vector [0.03, -0.11, ... 384 numbers ...]
        |
        v
compare against each clip vector
        |
        v
rank by cosine similarity
```

This is the real meaning-level cross-language layer. A multilingual model can place Japanese and English meanings in the same space. In a populated semantic database, `温かい`, `warm`, and visually related descriptions of cozy indoor scenes can be close even when the exact words differ.

The vectors are stored directly in SQLite as BLOB values. There is no Pinecone, Weaviate, pgvector, or remote vector database involved.

Why SQLite is enough here:

- ena has 89 segments.
- The target scale discussed for this system is fewer than about 1,000 clips.
- A brute-force scan over hundreds of 384-dimensional vectors is tiny work for a local machine.
- External vector databases add setup, network, dependency, and sync complexity that is not justified at this scale.

Current ena state matters: this database has 0 vectors. The semantic lane is architecturally present, but the current build says `embedding_status: skipped`. A runtime probe for `warm indoor scene` in semantic mode returned warnings that semantic embeddings were unavailable and fell back to text/structured search. It returned text-search matches such as:

- `SEG_AST_ABC69F0E_0001`: warm indoor market/bakery with bread display
- `SEG_AST_9C822C55_0001`: dimly lit restaurant/private dining scene
- `SEG_AST_E98C7A35_0001`: bright indoor studio/home-like scene

So today, for ena, treat semantic search as not active until embeddings are populated.

## 5. How Structured Filters Work

Structured filters are plain SQL conditions over typed columns. They answer questions like:

- `composition_score > 0.7`
- `stability = stable`
- `has_dialogue = false`
- `shot_scale = closeup`
- `usability = fully_usable`
- `shooting_date = 2015-08-21`, when the date column is populated

Actual ena readbacks:

```text
composition_score > 0.7: 39 segments
stability = stable: 83 segments
composition_score > 0.7 AND stability = stable: 35 segments
```

Sample structured results for `composition_score >= 0.8` and stable camera:

```text
SEG_AST_FA6BF8D4_0001
composition: 0.80
stability: stable
summary: woman picking ripe tomatoes in an outdoor garden or farm

SEG_AST_0CBD2398_0001
composition: 0.80
stability: stable
summary: tomato garden, basket of ripe tomatoes, woman smiling during harvest

SEG_AST_0C0DA029_0001
composition: 0.80
stability: stable
summary: traditional Japanese-style interior with dark wooden beams and lattice windows
```

Text and structured filters can be combined. For example, this query shape:

```text
text: 栗 OR chestnut
filters: composition_score > 0.7, stability = stable
```

returned two ena clips:

```text
SEG_AST_628B1F09_0001
composition: 0.80
stability: stable
summary: close-up view of brown fuzzy chestnuts on dry leaves

SEG_AST_42069045_0001
composition: 0.75
stability: stable
summary: meal/dessert table scene with OCR/place evidence containing 栗
```

The date example is more nuanced. The structured column for `shooting_date` is currently empty in ena, so a typed filter for `2015-08-21` returns 0. But filenames show 33 assets containing `2015-08-21`. This means the current data has date information in filenames, but it has not been normalized into the typed date column yet.

## 6. How The Editorial Agent Uses It

The current editorial tool registry exposes four read-only footage search tools:

- `search_footage`: general search by text, semantic query when available, and structured filters.
- `similar_to`: find clips similar to a known segment, useful for replacement or variation when embeddings are available.
- `unused_footage`: find good clips while excluding already selected segment ids.
- `best_for_beat`: search for footage that fits a beat purpose, such as a bridge, setup, payoff, or reaction.

These tools return candidate segments with evidence: segment id, source range, scores, summary, quality fields, place hint, Marlin events, and match reasons. They do not edit the timeline by themselves.

Concrete workflows:

### Weak clip replacement

The agent inspects a selected clip and finds that it is too blurry or not emotionally clear. Instead of only using the fallback candidates from the original candidate pool, it can search the full footage database:

```text
need: replace weak food closeup
query: warm bakery food closeup
filters: stable camera, composition >= 0.7
result: candidate segment with summary, quality scores, and evidence refs
```

The agent can then propose the replacement and cite why: "this segment has composition 0.80, stable camera, and bread/bakery evidence."

### QA continuity bridge

If QA says the edit jumps too abruptly from one location to another, the agent can search for a bridge clip:

```text
need: bridge from bakery exterior to food/table detail
query: bakery sign table dessert food
filters: exclude already selected segments
```

The important change is that QA no longer has to accept the original candidate pool as fixed. It can trigger a targeted retrieval pass.

### Varying the edit with unused footage

The agent can search for unused good clips:

```text
tool: unused_footage
exclude: already selected segment ids
min_quality: 0.8
```

Actual ena probe, excluding two chestnut-related segments, returned:

```text
SEG_AST_FA6BF8D4_0001
woman picking tomatoes, composition 0.80

SEG_AST_0CBD2398_0001
tomato garden with smiling woman, composition 0.80

SEG_AST_0C0DA029_0001
traditional Japanese interior, composition 0.80
```

### Similar replacement

`similar_to` is meant for "find something like this, but not this exact clip." With embeddings populated, that can find conceptually similar shots even if the wording differs.

In the current ena database, this helper is limited because embeddings are not populated. A probe for clips similar to the chestnut closeup warned that semantic embeddings were unavailable and returned no semantic results. That is expected for the current build state.

## 7. Current Numbers For ena-promo-ai

The database integrity check returned:

```text
ok
```

The requested count query returned:

```text
assets|89
segments|89
marlin_events|301
embeddings|0
visual_profiles|89
```

Full current table counts:

```text
assets: 89
segments: 89
visual_quality: 89
visual_appraisal: 89
marlin_events: 301
segment_transcripts: 89
embedding_texts: 356
embeddings: 0
asset_technical: 89
segment_visual_profile: 89
segment_audio_profile: 89
segment_logging: 89
segments_fts: 89
metadata_fts: 89
build warnings: 0
```

Current build metadata:

```text
artifact_version: footage-db-v1
schema_version: 1
project_id: ena-promo-ai
created_at: 2026-06-19T02:42:26.339Z
embedding_status: skipped
embedding_model_id: empty
```

Actual query examples run against the real ena database:

### Text search: `栗 OR chestnut`

This was run as Boolean text search.

```text
1. SEG_AST_42069045_0001
   OCR/place evidence: 里の菓 栗 茶房
   summary: soba/dessert table scene

2. SEG_AST_45CAE530_0001
   summary: man in a lush orchard, likely chestnut or hawthorn grove
   Marlin event: man looks at fruit and smiles slightly

3. SEG_AST_628B1F09_0001
   summary: dense cluster of brown fuzzy chestnuts on dry leaves
```

### Structured search: stable, composition >= 0.8

```text
1. SEG_AST_FA6BF8D4_0001
   composition: 0.80
   stable camera
   woman picking ripe tomatoes

2. SEG_AST_0CBD2398_0001
   composition: 0.80
   stable camera
   tomato garden and smiling harvest moment

3. SEG_AST_0C0DA029_0001
   composition: 0.80
   stable camera
   traditional Japanese-style interior
```

### Combined text + filters: chestnut, stable, composition > 0.7

```text
1. SEG_AST_628B1F09_0001
   composition: 0.80
   stable camera
   chestnuts on dry leaves

2. SEG_AST_42069045_0001
   composition: 0.75
   stable camera
   OCR/place evidence contains 栗
```

### Semantic probe: `warm indoor scene`

Because this current DB has no embedding vectors, semantic search warned and fell back to text/structured search:

```text
warnings:
- semantic embeddings unavailable; FTS/structured search only
- semantic embeddings unavailable; falling back to text search

top fallback matches:
- SEG_AST_ABC69F0E_0001: warm indoor market/bakery with bread display
- SEG_AST_9C822C55_0001: dimly lit restaurant/private dining scene
- SEG_AST_E98C7A35_0001: bright indoor studio/home-like scene
```

## Practical Takeaway

The footage database is the retrieval layer for the editorial agent. It turns a flat set of analysis artifacts into a searchable footage library.

For ena-promo-ai right now:

- Text search works.
- Japanese OCR plus English summaries work together for mixed queries like `栗 OR chestnut`.
- Structured filters work for quality, stability, shot scale, dialogue flags, usability, and similar typed fields.
- Marlin events make the database useful for action timing, not just clip-level labels.
- Semantic/vector search is architecturally present, but the current ena database has no stored vectors because embeddings were skipped.
- Date filtering is schema-ready, but current ena typed date columns are empty even though dates exist in filenames.

The biggest process change is that the editorial agent is no longer locked into a fixed candidate pool. It can search the full analyzed footage pool when a beat is weak, repetitive, technically poor, missing a bridge, or flagged by QA, and then cite concrete evidence for the replacement.
