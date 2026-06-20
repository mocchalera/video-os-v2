# Design: Audio Embedding Architecture For Editorial Search

Date: 2026-06-20
Status: Design only
Scope: Add local audio embeddings to the project-local footage database search architecture
Non-goals: No runtime code, no canonical planning schema changes, no remote embedding API, no model download during normal search

## 1. Executive Decision

Add audio retrieval as an additive channel beside the existing text and Qwen visual channels.

Recommended first model:

```text
laion/clap-htsat-fused
```

Use it for audio-to-audio and text-to-audio retrieval over short extracted audio windows. Keep speech topic search on the existing transcript text path: E5 `combined`, Qwen `text_combined_qwen`, FTS5 transcript fields, and future transcript-specific filters. CLAP should answer "what does this segment sound like?", not "what exact topic did the person discuss?" unless that topic is acoustically expressed.

Core decisions:

- Store audio vectors in the existing `embedding_models` plus `segment_embeddings` architecture.
- Extend the footage DB, not canonical source schemas.
- Add audio embedding types and model rows additively.
- Keep `segment_audio_profile` as deterministic metadata for levels, silence, dialogue/music/ambient flags, and QA gates.
- Fuse audio scores at the score-breakdown layer. Do not compare CLAP vectors directly with E5 or Qwen vectors.
- Use a separate Python audio embedding worker that follows the Qwen JSONL worker pattern, but has its own dependency/cache/device lifecycle.
- Fail open: if the audio model or source audio is unavailable, existing text, visual, structured, and metadata search stays unchanged.

Why this direction:

- CLAP is built for text-audio similarity and audio embedding retrieval.
- `laion/clap-htsat-fused` is available through Hugging Face Transformers, has Apache-2.0 model licensing, is about 0.2B parameters, and exposes CPU/GPU usage examples.
- Its 512-dimensional projected embedding is small enough for SQLite BLOB scan at the current project scale.
- ImageBind is the attractive "single audio/image/text space" option, but the released code and weights are non-commercial and explicitly research-oriented.
- Qwen2-Audio is useful for future audio captioning or event extraction, but it is an 8B audio-language model, not a proven embedding model aligned with Qwen3-VL-Embedding-2B.

## 2. Current Repository Fit

Current retrieval surfaces:

- Visual: Qwen3-VL-Embedding-2B, 2048 dimensions, stored in `segment_embeddings`.
- Text: legacy E5 `Xenova/multilingual-e5-small:q8`, 384 dimensions, plus Qwen text rows.
- Audio metadata: `segment_audio_profile` exists in the footage DB builder with role, dialogue/music/ambient flags, peak/RMS/LUFS, silence windows, densities, noise flags, and handles.
- Audio vectors: none.

Relevant implemented constraints:

- `embedding_models.input_modality` currently allows `text`, `image`, `screenshot`, `video`, `mixed`, `multimodal`, and `reranker`. Audio implementation will need an additive DB schema migration to allow `audio` and preferably `audio_text`.
- `segment_embeddings.embedding_type` currently allows text, visual, and mixed Qwen types. Audio implementation will need additive values.
- `runtime/tools/footage-search.ts` already exposes score channels such as `semantic`, `e5_text`, `lexical`, `qwen_text`, `qwen_visual`, `qwen_mixed`, `quality`, `peak`, and `duration`.
- Search already has audio metadata filters including `audio_role`, `has_music`, `has_ambient`, `peak_dbfs_max`, LUFS range, silence ratio, and `noise_flags_exclude`.
- `schemas/creative-brief.schema.json` has `audio_policy` with `ducking`, `bgm_only`, and `original_only`.

Design implication:

Audio embeddings should be a new retrieval channel named `audio_similarity`, backed by audio model rows. The existing audio metadata filters remain structured priors and QA gates. They are not substitutes for audio content embeddings.

## 3. Editorial Use Cases

| Use case | Decision helped | Best signal |
| --- | --- | --- |
| Find quiet nature, busy market, room tone, crowd, water, rain, machines | Rough-pass clip discovery and scene grouping | CLAP text-to-audio plus audio metadata filters |
| Match ambient sound across adjacent clips | Fine-pass continuity and transition repair | Audio-to-audio similarity between out/in windows plus LUFS/silence deltas |
| Find speech about a topic | Beat selection and story coverage | Transcript FTS/E5/Qwen text, not raw audio CLAP |
| Find speech with similar delivery or acoustic setting | Talking-head continuity, same room, same speaker feel | Speech acoustic window embedding plus levels/noise flags |
| Group clips by similar ambient bed | Scene assembly and B-roll clusters | Audio ambient embeddings plus `audio_role` and silence ratio |
| Match footage to BGM energy | Music-driven pacing and clip rhythm | RMS/onset/energy envelope features first, CLAP only as semantic audio mood |
| Audio-visual coherence | QA and candidate reranking | Score-level fusion of Qwen visual mood, CLAP audio mood, and structured level data |
| Detect jarring audio transitions | QA before render | LUFS/peak discontinuity, silence gaps, clip handles, audio-to-audio out/in similarity |

The highest-value first use cases are text-to-audio ambient search and audio continuity QA. BGM beat sync needs deterministic audio-dynamics features in addition to embeddings.

## 4. Model Landscape

### Evaluation Matrix

| Candidate | License | Size | Embedding dimension | Apple Silicon feasibility | Good at | Misses | Fit |
| --- | --- | ---: | ---: | --- | --- | --- | --- |
| LAION CLAP HTSAT fused | Apache-2.0 model card | ~0.2B | 512 projected CLAP space | Good first target through Transformers on CPU/MPS-capable PyTorch; must smoke-test local cache | Text-to-audio search, ambient/event/music-ish similarity, zero-shot labels | Not visual-aligned; weak for exact spoken topic; limited rhythm understanding | Primary |
| Microsoft CLAP | MIT code | Checkpoint-specific, not clearly declared in repo | Usually CLAP projected space, verify selected checkpoint | Likely local CPU; package auto-download defaults must be disabled | General acoustic concept retrieval and captioning-related variants | Less directly integrated with current Transformers path; model metadata less explicit | Benchmark alternative |
| Whisper encoder embeddings | MIT code/weights | 39M to 1.55B plus turbo 809M | Hidden size depends on model size, not a fixed retrieval projection | Already realistic locally for ASR; embeddings require custom extraction | Speech recognition, language robustness, transcript generation | Not a text-audio retrieval embedding; not ambient/music semantic search | Use transcripts, not primary audio vectors |
| MERT | HF weights CC-BY-NC-4.0; code repo Apache-2.0 | 95M or 330M | 768 or 1024 hidden features depending model | Local possible, but music-only and license-limited | Music information retrieval, timbre, pitch, genre-ish music representation | Not text-to-audio; non-commercial weights; 5s music context | Research only |
| Jukebox encoder | Noncommercial license | 1B/5B family plus VQ-VAE stack | Large sequence representations, not compact search vectors | Poor fit for Apple Silicon local search | Long-form music generative representations | Heavy, archived/as-is, non-commercial, not retrieval-oriented | Reject |
| MusicGen / EnCodec | Code MIT, weights CC-BY-NC-4.0 | MusicGen sizes vary; EnCodec tokenizer | Codes/tokens, not semantic embedding by default | Possible for tokenizer/dynamics, but not first retrieval path | Music/audio generation, compression tokens, melody conditioning | Not a general text-audio retrieval embedding; weights non-commercial | Future dynamics/token experiment only |
| BEATs | MIT via Microsoft UniLM | Base-like 12 layer, 768 hidden config | Likely feasible locally | General audio event features and classification | No natural-language retrieval space by itself | Metadata/event classifier candidate, not first search vector |
| AudioMAE | CC-BY 4.0 | ~85.7M ViT-B in repo logs | Typically ViT-B hidden representation | Feasible but repo archived and older dependency stack | Self-supervised general audio representations | No text alignment; requires task-specific pooling/eval | Baseline only |
| Qwen2-Audio | Apache-2.0 | HF reports 8B params, BF16 | Not a compact embedding model; heavy for local interactive work | Audio analysis, ASR, sound understanding, natural-language responses | No proven shared vector space with Qwen3-VL-Embedding-2B; generation-first | Future caption/event extraction, not primary retrieval |
| ImageBind | CC-BY-NC 4.0 / research-only model card | Huge model, 1024 output in released code | Heavy but possible with local PyTorch after setup | True shared text/image/audio/depth/thermal/IMU space | License and model-card scope block practical product use; English text bias | Do not use for product path |

### Notes On CLAP Variants

Treat "CLAP" as a family, not one interchangeable model. LAION CLAP, Microsoft CLAP, HTSAT-based variants, music-specialized checkpoints, and captioning variants should each get distinct `embedding_models` rows. Vectors from different CLAP checkpoints are not comparable.

First implementation should use `laion/clap-htsat-fused` because it is explicit, Transformers-compatible, and small enough. Microsoft CLAP can be benchmarked later if LAION CLAP underperforms on local footage.

### Why Not A Single Audio/Visual Space Now

Only ImageBind clearly offers a released common space across text, image/video, and audio, but its license and model card make it unsuitable as the product-default architecture. CLAP audio vectors and Qwen visual vectors must stay in separate spaces and meet only at score fusion.

Qwen2-Audio sharing a brand family with Qwen3-VL does not imply vector-space compatibility. It should not be used as a bridge unless a future Qwen audio embedding model or an explicit cross-model calibration experiment proves alignment.

## 5. What To Embed Per Segment

### Audio Inputs

Extract mono audio windows from source media with deterministic ffmpeg settings:

```text
sample_rate_hz: 48000 for archival extraction, resample to model-required rate for inference
channel_policy: mono mixdown for embedding v1
format: wav/flac temp file or in-memory PCM, depending worker API
loudness: preserve original level for CLAP; store normalization metadata separately
```

Do not loudness-normalize the audio before semantic embedding unless the smoke test proves CLAP benefits. Levels are editorially meaningful.

### Implementation Contract: Audio Window Extraction

Derived audio windows are project-local cache artifacts, not canonical media.

Cache path:

```text
03_analysis/audio_windows/{segment_id}/{window_type}.wav
```

Window types:

| `window_type` | Extraction rule | First embedding use |
| --- | --- | --- |
| `full` | Full segment audio bounded by `src_in_us` / `src_out_us` | `audio_representative` |
| `in_region` | First 2 seconds after segment source in, clipped to available duration | `audio_window_in` |
| `out_region` | Last 2 seconds before segment source out, clipped to available duration | `audio_window_out` |
| `peak_region` | 2-second window centered around the strongest known peak/event, clipped to segment bounds | `audio_window_peak` |

Canonical extraction command:

```text
ffmpeg -ss {start} -t {duration} -i {source} -map 0:a:0 -ac 1 -ar 48000 -f wav -acodec pcm_s16le {output}
```

Rules:

- Select the first audio stream with `-map 0:a:0`.
- If the source has no audio stream, skip the window with a build warning and do not block the footage DB build.
- `{start}` and `{duration}` are expressed in absolute source-media time. The resulting manifest `start_us` and `end_us` must match the same source timeline convention as `segments.src_in_us` and `segments.src_out_us`.
- `content_hash = SHA-256(audio_bytes + extraction_policy_version)`. `extraction_policy_version` starts as `clap-audio-window-v1` and changes whenever the window selection, stream selection, sample rate, channel policy, codec, or silence policy changes.
- Silent or near-silent windows should be recorded as skipped with a warning before embedding; do not store a misleading CLAP vector for digital silence.

Each segment window directory contains:

```text
03_analysis/audio_windows/{segment_id}/manifest.json
```

Manifest rows:

```ts
interface AudioWindowManifestRow {
  window_type: "full" | "in_region" | "out_region" | "peak_region";
  source_ref: string;
  start_us: number;
  end_us: number;
  sample_rate: 48000;
  channels: 1;
  content_hash: string;
}
```

The manifest may include skipped rows with a warning reason, but only rows with a concrete WAV path and hash should be embedded.

### Recommended Windows

| Embedding type | Window | Purpose |
| --- | --- | --- |
| `audio_representative` | Whole segment if <= 12s, otherwise centered on `rep_frame_us`, audio peak, or midpoint | General text-to-audio search |
| `audio_window_in` | First 3-6s after segment in, adjusted away from digital silence | J-cuts, opening continuity, room tone entry |
| `audio_window_peak` | Around audio or fused peak, fallback midpoint | Strongest sound event or energy moment |
| `audio_window_out` | Last 3-6s before segment out, adjusted away from silence | Exit continuity and transition QA |
| `audio_ambient` | Lowest-speech non-silent window when `has_ambient=1` | Ambient bed grouping |
| `audio_music` | Music-dominant window when `has_music=1` | Music mood and source-music grouping |
| `audio_speech_acoustic` | Dialogue-dominant window, raw sound not transcript | Speaker/room/prosody continuity |

MVP should store only `audio_representative`. Phase 2 adds `audio_window_in` and `audio_window_out` because they directly support transition QA. `audio_ambient`, `audio_music`, and `audio_speech_acoustic` should wait until `segment_audio_profile` is populated reliably enough to choose those windows deterministically.

Precomputed segment-bound windows are for indexing and recall. Phase 3 continuity QA must be trim-aware: after compile, extract on-demand continuity windows from the actual timeline clip `src_in_us` / `src_out_us`, not only the original indexed segment bounds. Store those QA window rows keyed by exact source start/end and source ref so the same segment can have multiple trim-specific continuity windows without overwriting the segment-level cache.

### Speech Transcript Handling

Speech topic is already better represented by:

- `segment_transcripts.text`
- `segments_fts.transcript`
- E5 `combined`
- Qwen `text_combined_qwen`

Do not add `audio_speech` as a semantic topic channel in v1. Raw speech embeddings may help "same room", "same speaker feel", or "energetic delivery", but transcript text should drive "talks about pricing", "mentions Togakushi", or "explains the process".

### Audio Event Descriptions

Marlin event descriptions that mention sound should stay text evidence first. If future audio captioning produces descriptions such as "distant traffic and footsteps", store them as:

- structured evidence in `segment_audio_profile.evidence_json`
- FTS text in `segment_metadata_fts.audio`
- optional E5/Qwen text bundle content

Do not create a second text embedding channel for audio descriptions until search fixtures show it improves results beyond existing combined text.

## 6. Storage Design

### Additive DB Schema Extension

Extend `embedding_models.input_modality` with:

```text
audio
audio_text
```

Extend `segment_embeddings.embedding_type` with:

```text
audio_representative
audio_window_in
audio_window_peak
audio_window_out
audio_ambient
audio_music
audio_speech_acoustic
```

Recommended first model row:

| Field | Value |
| --- | --- |
| `name` | `laion/clap-htsat-fused` |
| `model_revision` | Pinned HF snapshot |
| `output_dimension` | `512` |
| `input_modality` | `audio_text` |
| `instruction` | Empty string |
| `preprocess_version` | `clap-audio-window-v1` |
| `runner_name` | `python-clap-audio-worker` |
| `runner_version` | `clap-audio-worker-v1` |
| `precision` | `fp32` first, `fp16` only after MPS smoke test |
| `normalized` | `1` |
| `distance_metric` | `cosine` |
| `license` | `apache-2.0` |

`instruction` is empty for CLAP because CLAP is not instruction-tuned. If query prompt wrapping is later added, it must change `preprocess_version` or `instruction` and create a new model row.

### Audio Window Provenance

Add a derived table to keep window extraction auditable:

```sql
CREATE TABLE segment_audio_windows (
  window_ref TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL REFERENCES segments(segment_id) ON DELETE CASCADE,
  window_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  source_start_us INTEGER NOT NULL,
  source_end_us INTEGER NOT NULL,
  duration_us INTEGER NOT NULL,
  sample_rate_hz INTEGER NOT NULL,
  channel_policy TEXT NOT NULL,
  extraction_policy TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

Then store:

```text
segment_embeddings.source_ref = audio_windows:<window_ref>
segment_embeddings.source_timestamp_us = source_start_us or window midpoint
segment_embeddings.content_hash = hash(audio bytes + extraction policy + preprocess version)
```

If an implementation chooses not to add `segment_audio_windows` in MVP, it must still encode enough in `source_ref` and build report warnings to explain where the audio came from. The table is preferred because weak agents need explicit, inspectable structure.

### Dimension And Storage Cost

At current scale, SQLite BLOB scan remains appropriate.

```text
1000 segments * 1 CLAP vector * 512 dims * 4 bytes = about 2.0 MiB
1000 segments * 4 CLAP vectors * 512 dims * 4 bytes = about 7.8 MiB
```

This is smaller than one 2048-dimensional Qwen visual vector per segment. No ANN extension is needed for the first implementation.

### Comparability Rules

- Compare only vectors with the same `embedding_models.id`.
- CLAP text query vectors can be compared with CLAP audio vectors from the same model row.
- CLAP audio vectors cannot be compared with Qwen visual vectors or E5 text vectors.
- ImageBind, if ever used for research, must use a distinct model row and must not be mixed with CLAP or Qwen scores except through fusion.
- If the worker returns a dimension different from `embedding_models.output_dimension`, skip and warn.
- If the decoded vector has non-finite values, zero magnitude after normalization, or wrong byte length, skip and warn.

## 7. Search Integration

### API Extension

Extend search mode and inputs conceptually:

```ts
type FootageSearchMode =
  | "hybrid"
  | "text"
  | "semantic"
  | "structured"
  | "visual"
  | "multimodal"
  | "audio";

interface SearchFootageInput {
  audio_query_path?: string;
  audio_anchor?: {
    segment_id: string;
    window_type?: "audio_representative" | "audio_window_in" | "audio_window_peak" | "audio_window_out";
  };
  audio_goal?: "semantic" | "continuity" | "room_tone" | "music_mood" | "rhythm_energy";
}
```

The flat tool adapter can add:

```text
audio_query_path
audio_anchor_segment_id
audio_anchor_window_type
audio_goal
```

For `mode: "audio"` with no valid text query, audio file, or anchor, return `[]` with a warning. Do not fall back to structured-only ranking and imply that an audio search happened.

### Score Breakdown Extension

Add these fields:

```ts
interface FootageScoreBreakdown {
  audio_similarity?: number;
  audio_metadata?: number;
  audio_continuity?: number;
  audio_energy?: number;
}
```

`audio_similarity` is CLAP cosine normalized to `[0, 1]`.

`audio_metadata` is deterministic fit from `segment_audio_profile`, for example role match, silence ratio, LUFS range, and noise flag exclusion.

`audio_continuity` is an adjacency-specific score. It should not be used for ordinary search because it requires before/after context.

`audio_energy` is reserved for BGM/rhythm features. Do not fill it with CLAP scores.

### Query Modes

Text-to-audio:

```text
query: "quiet forest ambience"
mode: "audio"
filters: { has_ambient: true, silence_ratio_max: 0.7 }
```

Search behavior:

1. Embed the text with CLAP.
2. Compare against `audio_representative`, then ambient/music/speech windows when available.
3. Fuse with audio metadata and quality/peak priors.
4. Return matched window refs and warnings.

Audio-to-audio:

```text
audio_query_path: /abs/project/reference/room-tone.wav
mode: "audio"
audio_goal: "room_tone"
```

Search behavior:

1. Validate local absolute path and extension.
2. Extract/hash model-normalized query window.
3. Embed with CLAP.
4. Compare against stored audio windows.
5. Return source window refs, not just segment IDs.

`audio_query_path` validation must mirror `image_query_path` validation:

- The path must be absolute.
- Resolve `realpath` before use.
- The resolved path must be a regular readable file.
- The resolved path must be contained under the project root or an explicitly approved audio window/reference directory.
- Allowed extensions for direct audio query files are `.wav`, `.mp3`, and `.flac`.
- Reject symlink escapes before worker invocation.

### Deterministic Audio Intent Routing

Search routing should be explicit and predictable:

- If `audio_query_path` is present and valid, route to audio mode even when `mode` is omitted.
- If `audio_anchor` is present, route to audio mode unless the caller explicitly requests continuity scoring in a later QA context.
- If query text contains audio keywords such as `静か`, `音`, `声`, `BGM`, `環境音`, `room tone`, `ambient`, `music`, `voice`, `sound`, `noise`, `quiet`, or `silence`, keep standard hybrid retrieval but boost the audio channel weight.
- If the query is a speech-topic request without audio keywords, use standard hybrid/text routing and keep transcript channels dominant.
- Otherwise use the existing standard hybrid behavior.

Cross-modal scene continuity:

```text
mode: "multimodal"
query: "warm food prep with calm kitchen ambience"
```

Search behavior:

1. Qwen handles visual similarity.
2. CLAP handles audio similarity.
3. E5/FTS handle transcript and exact terms.
4. Score fusion combines channels. No vector-space mixing.

### Initial Fusion Weights

When audio is absent, keep current formulas unchanged.

Audio-only text-to-audio or audio-to-audio:

```text
0.80 audio_similarity
+ 0.10 audio_metadata
+ 0.05 quality
+ 0.05 peak
```

Hybrid query with explicit audio intent:

```text
0.35 audio_similarity
+ 0.20 qwen_visual
+ 0.15 e5_text
+ 0.10 lexical
+ 0.10 audio_metadata
+ 0.05 quality
+ 0.05 peak
```

Hybrid query without explicit audio intent:

```text
0.15 audio_similarity
+ 0.30 qwen_visual
+ 0.10 qwen_text
+ 0.20 e5_text
+ 0.10 lexical
+ 0.10 quality
+ 0.05 peak
```

Speech-topic query:

```text
0.05 audio_similarity
+ 0.30 e5_text
+ 0.25 lexical
+ 0.15 qwen_text
+ 0.10 qwen_visual
+ 0.10 quality
+ 0.05 peak
```

Dialogue/topic intent should lower audio similarity because CLAP may match acoustic speech, not semantic content.

Continuity candidate between adjacent clips:

```text
0.35 audio_to_audio_similarity
+ 0.25 level_continuity
+ 0.15 silence_and_handle_fit
+ 0.15 qwen_visual_continuity
+ 0.10 editorial_quality
```

Use `min(sim_before_out, sim_after_in)` when searching for a bridge candidate between two clips. This prevents a candidate that only matches one side of the cut from ranking too high.

Fallback redistribution:

- Missing audio retrieval weight redistributes only across retrieval channels: `audio_similarity`, `qwen_visual`, `qwen_text`, `e5_text`, and `lexical`.
- Do not redistribute quality, peak, or audio metadata weights into retrieval channels.
- For audio-only mode with no audio retrieval channel, return no results with a warning.

### Generalized Retrieval-Channel Fuser

Before Phase 2 audio search, replace the Qwen-specific retrieval branch with a unified score fuser:

```ts
function weightedRetrievalScore(channels: {
  e5_text?: number;
  lexical?: number;
  qwen_visual?: number;
  qwen_text?: number;
  audio_similarity?: number;
}, mode: string, available: Set<string>): number
```

Compatibility requirements:

- When audio channels are absent and Qwen channels are absent, the fuser must return the exact same output as the legacy E5/lexical path.
- When audio channels are absent and Qwen channels are present, the fuser must return the exact same output as the current Qwen-aware path.
- `available` is query-channel availability, not merely whether the project has rows somewhere in the database.
- Weight redistribution is limited to retrieval channels. Non-retrieval priors such as quality, peak, duration, and `audio_metadata` remain outside this function and keep their existing formulas.
- Each mode needs fixture tests proving exact old scores when `audio_similarity` is unavailable.

Audio-bearing retrieval weight tables:

| Mode / route | `audio_similarity` | `qwen_visual` | `qwen_text` | `e5_text` | `lexical` |
| --- | ---: | ---: | ---: | ---: | ---: |
| `audio` with audio query or CLAP text query | 1.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| `hybrid` with explicit audio intent | 0.4375 | 0.2500 | 0.0000 | 0.1875 | 0.1250 |
| `hybrid` without explicit audio intent | 0.1765 | 0.3529 | 0.1176 | 0.2353 | 0.1176 |
| speech-topic route | 0.0588 | 0.1176 | 0.1765 | 0.3529 | 0.2941 |

The table values are normalized retrieval-only weights derived from the full score formulas above. Apply quality, peak, `audio_metadata`, and continuity priors after retrieval scoring.

## 8. Interaction With Existing Audio Analysis

`segment_audio_profile` remains essential.

| Field family | Role in audio embedding architecture |
| --- | --- |
| `audio_role`, `has_dialogue`, `has_music`, `has_ambient` | Hard/soft filters and window selection |
| `peak_dbfs`, `rms_dbfs`, `integrated_lufs` | Transition QA, loudness continuity, noisy clip exclusion |
| `silence_ratio`, `silence_head_us`, `silence_tail_us` | Avoid embedding silence-only windows; choose handles for J/L-cuts |
| `speech_density`, `music_density` | Pick speech/music/ambient windows deterministically |
| `noise_flags_json` | Reject or demote unusable clips before embeddings inflate score |
| `audio_handle_head_us`, `audio_handle_tail_us` | Determine whether a clip can support audio transitions |
| `evidence_json` | Explain audio profile decisions and source extraction |

Embeddings should never mask bad deterministic audio facts. A clip with strong CLAP similarity but clipped audio, no handle, or a jarring LUFS jump should stay penalized for continuity or final placement.

## 9. Editorial Agent Integration

### Rough Pass

Use audio search when the brief or beat explicitly cares about natural sound, music, room tone, market bustle, calmness, silence, or voice texture.

Examples:

- For `original_only`, raise audio relevance and continuity weights.
- For `ducking`, prefer useful natural sound and dialogue that can survive under BGM.
- For `bgm_only`, use audio embeddings mostly for rhythm/mood diagnostics and source-sound awareness, not final audio continuity.

The rough pass should add audio evidence lines to candidates:

```text
Audio retrieval: matched "quiet kitchen ambience" via audio_representative score=0.812, LUFS=-28.1, silence_ratio=0.22
```

### Fine Pass

Use audio windows around actual in/out points:

- Replace a visually good but sonically jarring clip.
- Find a bridge clip whose room tone matches both sides.
- Prefer clips with usable audio handles for J/L-cuts.
- Keep transcript topic search separate from acoustic continuity search.

### QA

Add an audio QA pass after timeline assembly:

- Detect high LUFS delta across cuts.
- Detect clipped peaks or noisy clips that survived selection.
- Detect cuts from dense dialogue to unrelated loud ambience.
- Detect dialogue segments placed under `bgm_only` when original audio will be discarded.
- Detect visual continuity swaps that desynchronize nat-sound mirror expectations.

The QA output should cite both deterministic facts and embedding evidence:

```text
Cut c14->c15: audio_continuity=0.31, LUFS delta=14.2, CLAP out/in similarity=0.28, no tail handle on c14.
```

### BGM Sync

Do not rely on CLAP for beat sync. CLAP gives semantic and event-level similarity, not frame-accurate rhythm.

For BGM-footage matching, add a future deterministic `audio_dynamics_profile`:

- RMS envelope
- onset strength
- tempo estimate where reliable
- low/mid/high-band energy
- beat/downbeat confidence
- energy-change timestamps

Then compute `audio_energy` by correlating footage energy windows with the BGM energy curve. CLAP can contribute `music_mood` or `ambient_mood`, but not timing.

## 10. Worker Architecture

Use the same pattern as Qwen3-VL, but a separate worker.

Proposed files for future implementation:

```text
python/clap_audio_worker.py
python/requirements-clap.txt
runtime/connectors/clap-audio-local.ts
```

Default execution:

```text
python/.venv-clap/bin/python3 python/clap_audio_worker.py \
  --model laion/clap-htsat-fused \
  --device auto \
  --cache-dir ~/.cache/video-os-v2/clap
```

Environment variables:

| Variable | Purpose |
| --- | --- |
| `VOS_CLAP_PYTHON` | Override Python binary |
| `VOS_CLAP_WORKER` | Override worker path |
| `VOS_CLAP_MODEL` | Override model id or local model path |
| `VOS_CLAP_DEVICE` | `mps`, `cpu`, or `auto` |
| `VOS_CLAP_CACHE_DIR` | Local model cache path |
| `VOS_CLAP_REQUEST_TIMEOUT_MS` | Per-request timeout |
| `VOS_CLAP_MOCK` | Deterministic mock mode for tests |

Required methods:

```json
{"id":1,"method":"embed_text","params":{"texts":["quiet forest ambience"],"normalize":true}}
```

```json
{"id":2,"method":"embed_audio","params":{"audio_paths":["/abs/project/03_analysis/audio_windows/SEG_1/representative.wav"],"normalize":true}}
```

```json
{"id":3,"method":"embed_batch","params":{"items":[{"ref":"SEG_1:audio_representative","kind":"audio","audio_path":"/abs/project/03_analysis/audio_windows/SEG_1/representative.wav"}],"normalize":true}}
```

Success response mirrors Qwen:

```json
{
  "id": 2,
  "ok": true,
  "result": {
    "vectors": [
      {
        "ref": "0",
        "vector": "base64-float32-little-endian",
        "vector_encoding": "float32-le-base64",
        "dimension": 512,
        "normalized": true
      }
    ],
    "model": {
      "name": "laion/clap-htsat-fused",
      "model_revision": "pinned-snapshot",
      "output_dimension": 512,
      "preprocess_version": "clap-audio-window-v1",
      "runner_name": "python-clap-audio-worker",
      "runner_version": "clap-audio-worker-v1",
      "precision": "fp32",
      "device": "mps",
      "distance_metric": "cosine"
    },
    "elapsed_ms": 42,
    "metrics": {
      "rss_mb": 812.4,
      "peak_rss_mb": 812.4,
      "first_embed_peak_rss_mb": 812.4
    }
  }
}
```

Error codes:

- `model_not_found`
- `mps_unavailable`
- `dependency_missing`
- `audio_decode_failed`
- `source_audio_missing`
- `silent_window`
- `oom`
- `timeout`
- `invalid_input`
- `worker_crash`

Protocol parity requirements:

- Every success response includes `elapsed_ms` inside `result`.
- Error responses include structured `{ code, message, retryable }` plus elapsed timing.
- Vectors are `float32-le-base64`, finite, 512-dimensional, and L2-normalized unless the caller explicitly disables normalization for diagnostics.
- RSS metrics include `rss_mb`, `peak_rss_mb`, and `first_embed_peak_rss_mb` on the first successful embed.
- `shutdown` returns a JSONL success response and exits with status 0.
- TypeScript timeouts kill the worker, clear pending requests, and allow the next request to start a fresh worker.
- TypeScript mock mode returns deterministic 512-dimensional vectors without spawning Python.
- Real model and processor loading must set `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, and `local_files_only=True`; the worker must never download model weights during normal build/search.
- Missing Python packages return `dependency_missing` with the setup command.

Separate worker rationale:

- Audio dependencies differ from Qwen VLM dependencies.
- Audio preprocessing needs `ffmpeg`, waveform decode, resampling, and possibly `torchaudio`/`librosa`.
- CLAP query-time model load should not keep the heavier Qwen worker resident.
- Audio can later add dynamics extraction without touching Qwen.

## 11. Build-Time vs Search-Time

Build time:

- Extract deterministic audio windows.
- Populate `segment_audio_windows`.
- Run CLAP audio embeddings for selected embedding types.
- Store vectors in `segment_embeddings`.
- Populate build report counts and statuses.
- Use `clap_audio` as the concrete `embedding_counts` and `embedding_statuses` channel name.
- Add CLI flags `--clap-audio` and `--no-clap-audio`.
- Add `BuildFootageDbOptions.clapAudioEnabled?: boolean`.
- Aggregate `embedding_status` remains backward compatible: audio warnings do not make the whole DB unusable when E5/Qwen/text search is otherwise ready.

Memory scheduling:

- CLAP and Qwen workers must not run simultaneously.
- Builder order is sequential: populate Qwen rows first, shut down the Qwen worker in `finally`, then start CLAP population.
- Never keep both workers resident unless a later explicit peak-RSS gate approves concurrent loading.

Search time:

- Embed text audio queries with CLAP.
- Embed `audio_query_path` references with CLAP.
- Reuse stored anchor vectors for `audio_anchor`.
- Cache query embeddings by model row, normalized text or audio hash, preprocess version, and output dimension.

Default policy:

- Build-time audio embedding runs under `embeddingPolicy: "auto"` when audio model setup exists.
- If model is unavailable, write warnings and keep DB usable.
- `embeddingPolicy: "require"` should fail the build if requested audio embedding types cannot be produced.
- Search-time `mode: "audio"` with unavailable model returns no audio results and warns, unless there is a text query and the caller allows hybrid fallback.

## 12. Phased Implementation Plan

### Phase 0: Smoke Test And Fixture Design

Acceptance:

- CLAP worker starts in mock mode and real local-cache mode.
- Model load succeeds from local cache or returns structured `model_not_found`; no network access is attempted during worker startup.
- Text embedding for `"quiet ambient sound"` returns a finite 512-dimensional normalized vector.
- Audio embedding for a non-silent fixture returns a finite 512-dimensional normalized vector.
- `embed_batch` returns the expected count for 1, 4, and 16 audio windows.
- A silent window returns `silent_window`, not a misleading vector.
- CPU is required and must pass; MPS is opportunistic and may either pass or fail clearly with `mps_unavailable` / CPU fallback when `--device auto`.
- Peak RSS and `elapsed_ms` are reported for 1, 4, and 16 windows.
- `shutdown` exits cleanly and leaves no resident worker.

### Phase 1: Storage And `audio_representative`

Acceptance:

- Add derived DB schema extension for `audio` / `audio_text` model rows and `audio_representative`.
- Add audio window provenance.
- Populate one vector per segment when audio exists.
- Preserve current search behavior when audio rows are absent.
- Build report includes `clap_audio` counts/status without breaking existing `embedding_status`.

### Phase 2: Audio Search Mode

Acceptance:

- `mode: "audio"` supports text-to-audio and audio-to-audio search.
- Results include `audio_similarity`, `audio_metadata`, matched `source_ref`, and unavailable-channel warnings.
- Audio-only search with no audio channel returns empty with a warning.
- Hybrid searches only use audio weight when audio intent or audio query input is present.

### Phase 3: Continuity Windows And QA

Acceptance:

- Add `audio_window_in` and `audio_window_out`.
- Fine-pass helper can score adjacent cuts with CLAP out/in similarity plus LUFS/silence/handle deltas.
- QA reports jarring cuts with evidence.
- No timeline mutation happens from search alone.

### Phase 4: Ambient/Music/Speech Specialized Windows

Acceptance:

- Add `audio_ambient`, `audio_music`, and `audio_speech_acoustic` only when `segment_audio_profile` has enough density/role confidence.
- Search can target room tone, music mood, or speech acoustics.
- Speech-topic tests prove transcript channels still dominate semantic speech queries.

### Phase 5: BGM Dynamics

Acceptance:

- Add deterministic audio dynamics profile for source audio and BGM.
- Compute energy/onset correlation separately from CLAP.
- Expose `audio_energy` in score breakdown only when dynamics exist.
- Validate against rendered edits with `ffprobe` or audio analysis, not just search logs.

### Phase 6: Optional Model Benchmarks

Benchmark against fixed fixtures:

- Microsoft CLAP
- BEATs plus text-label classifier path
- AudioMAE pooled representations
- MERT for music-only projects
- Qwen2-Audio for caption/event extraction, not vector search

Do not promote a model unless it improves editorial fixtures and preserves local/offline constraints.

## 13. Fixture And Evaluation Requirements

Create a small labeled audio retrieval fixture before implementation:

- quiet room tone
- forest/nature ambience
- busy street or market
- dialogue in quiet room
- dialogue in noisy room
- source music
- silence or near-silence
- clipped/noisy unusable audio

Required queries:

- "quiet nature ambience"
- "busy market crowd"
- "room tone similar to this reference"
- "dialogue in a quiet room"
- "music with high energy"
- "silence"
- Japanese equivalents for at least three queries

Metrics:

- top-1 and top-5 retrieval sanity
- false positives for silence
- transcript-topic query dominance
- continuity score correlation with human-labeled jarring cuts
- cold and warm local timings on Apple Silicon

The benchmark should compare CLAP similarity, audio metadata, and fused score separately. If fusion hides bad CLAP behavior, the design fails the "quality through structure" principle.

## 14. Risks And Mitigations

| Risk | Mitigation |
| --- | --- |
| CLAP retrieves speech by acoustic feel instead of spoken topic | Route topic queries to transcript channels and lower `audio_similarity` for speech-topic intent |
| Silent windows get embedded as meaningful clips | Detect silence before embedding; skip with `silent_window` |
| Audio levels are normalized away before embedding | Preserve source levels for metadata; do not normalize waveform unless benchmarked |
| Model unavailable on local machine | Fail open, structured warning, mock mode tests |
| Audio/visual vectors are accidentally compared directly | Strict `embedding_models.id` comparability and score-level fusion only |
| ImageBind looks attractive but violates product constraints | Keep as research-only note, not implementation path |
| Qwen2-Audio assumed compatible with Qwen3-VL | Require explicit alignment proof before any shared-space claim |
| BGM sync overpromised from embeddings | Use deterministic dynamics features for rhythm, CLAP only for semantic mood |

## 15. Source Notes

Primary sources used for model evaluation:

- LAION CLAP repository and `laion/clap-htsat-fused` model card: https://github.com/LAION-AI/CLAP and https://huggingface.co/laion/clap-htsat-fused
- Microsoft CLAP repository: https://github.com/microsoft/CLAP
- Hugging Face Transformers CLAP docs: https://huggingface.co/docs/transformers/en/model_doc/clap
- OpenAI Whisper repository: https://github.com/openai/whisper
- MERT repository and HF model card: https://github.com/yizhilll/MERT and https://huggingface.co/m-a-p/MERT-v1-330M
- BEATs official implementation: https://github.com/microsoft/unilm/tree/master/beats
- AudioMAE official implementation: https://github.com/facebookresearch/AudioMAE
- Qwen2-Audio repository and HF model card: https://github.com/qwenlm/qwen2-audio and https://huggingface.co/Qwen/Qwen2-Audio-7B
- ImageBind repository and model card: https://github.com/facebookresearch/ImageBind
- AudioCraft/MusicGen repository: https://github.com/facebookresearch/audiocraft
- OpenAI Jukebox repository: https://github.com/openai/jukebox
