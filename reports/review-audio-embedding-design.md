# Review: Audio Embedding Architecture Design

Date: 2026-06-20
Reviewed document: `docs/design-audio-embedding-architecture.md`
Verdict: **approve-with-changes**

## Summary Verdict

The design is directionally correct and fits the current Qwen/E5 footage search architecture: audio is additive, stays in `embedding_models` plus `segment_embeddings`, avoids cross-model vector comparisons, keeps transcript topic search separate from acoustic search, and respects local-only execution.

I would not block implementation planning, but I would require changes before Phase 1 build/search work. The biggest gaps are not model choice; they are exact implementation contracts for audio window extraction, score-fusion integration, trim-aware continuity, worker parity with Qwen, and local memory scheduling.

## Findings

### High

1. **Audio window extraction is not yet implementation-ready.**

   The design correctly says to extract deterministic mono windows and prefers a `segment_audio_windows` provenance table (`docs/design-audio-embedding-architecture.md:105-116`, `docs/design-audio-embedding-architecture.md:195-224`). However, Phase 1 still lacks the concrete contract needed to build this safely: cache path, manifest shape, ffmpeg args, audio stream selection, exact sample format, source path resolver, no-audio behavior, and whether `source_start_us/source_end_us` are absolute source-media times.

   This matters because the live builder only has aggregate `segment_audio_profile` analysis over `src_in_us/src_out_us` via `extractAudioLevels(...)`; it does not produce reusable window media or hashes (`runtime/artifacts/footage-db-builder.ts:2372-2418`, `runtime/artifacts/footage-metadata-extractor.ts:274-295`). Without a precise window/cache contract, `segment_embeddings.source_ref` and `content_hash` will vary by implementation and become hard for agents to audit.

2. **Continuity windows need to be aligned to actual edit trims, not only indexed segment bounds.**

   The design proposes `audio_window_in` and `audio_window_out` from segment in/out (`docs/design-audio-embedding-architecture.md:122-130`) and later says fine pass should use windows around actual in/out points (`docs/design-audio-embedding-architecture.md:454-461`). Those are different contracts once the compiler trims a selected clip.

   For Phase 3 continuity QA, precomputed source-segment windows are useful recall signals, but final jarring-cut checks must either extract on-demand windows from the selected timeline clip `src_in_us/src_out_us` or store window rows keyed by exact source start/end. Otherwise a clip can score as continuous at index time and still be sonically wrong after trim.

3. **Score fusion is conceptually compatible, but the implementation seam is underspecified.**

   The audio design's fallback rules match the Qwen design principle: keep legacy scoring unchanged when the new channel is absent and redistribute only retrieval-channel weight (`docs/design-audio-embedding-architecture.md:351-418`; `docs/design-multimodal-qwen3vl-unified.md:799-884`). The live implementation, though, has a Qwen-specific `finalScore(...)` and `qwenWeightedScore(...)` path (`runtime/tools/footage-search.ts:1670-1829`).

   Before coding, the design should call out a generalized retrieval-channel fuser, e.g. `weightedRetrievalScore({ audio_similarity, qwen_visual, qwen_text, e5_text, lexical }, priors)`, with tests proving exact legacy output when audio rows are absent. Otherwise audio integration will likely sprawl through mode-specific branches.

### Medium

4. **Build result, status, CLI, and option names are not concrete enough.**

   The current builder has `EmbeddingCounts` and `EmbeddingStatuses` fields only for `e5_text`, Qwen visual/text/mixed, and reranker (`runtime/artifacts/footage-db-builder.ts:49-87`). The audio design says the build report should include `audio_text` or `clap_audio` counts/status (`docs/design-audio-embedding-architecture.md:629-637`) but does not choose names or show `BuildFootageDbOptions`, CLI flags, progress phases, or aggregate `embedding_status` behavior.

   Pick stable names before implementation. I would use explicit channel names such as `clap_audio` or `audio_representative`, not `audio_text`, because `audio_text` is an `embedding_models.input_modality`, not a result channel.

5. **Worker protocol mirrors Qwen in spirit but misses several parity details.**

   The proposal has JSONL methods, env vars, base64 float vectors, and error codes (`docs/design-audio-embedding-architecture.md:494-583`). To match the actual Qwen connector pattern, it should also specify `dependency_missing`, `elapsed_ms`, metrics/RSS fields, shutdown behavior, timeout kill/restart semantics, deterministic TypeScript mock mode, `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, and `local_files_only=True` model/processor loading (`runtime/connectors/qwen3vl-embedding-local.ts:13-20`, `runtime/connectors/qwen3vl-embedding-local.ts:231-276`, `runtime/connectors/qwen3vl-embedding-local.ts:279-455`; `python/qwen3vl_embedding_worker.py:181-211`).

6. **Local execution is correctly required, but dependency and MPS risk need sharper gates.**

   CLAP is a reasonable first model. The Hugging Face model card lists `laion/clap-htsat-fused` as Apache-2.0, about 0.2B parameters, and suitable for extracting audio/text features; Transformers documents CLAP projection dimension as 512. That supports the design's recommendation.

   The risk is the local stack: `torch` + Transformers + audio decoding on Apple Silicon can still fail because of package or operation support. Phase 0 should lock the exact dependency path and prefer ffmpeg-extracted PCM plus minimal Python audio decode over a broad `librosa`/`torchaudio` dependency unless the smoke test proves those are stable.

7. **Memory scheduling with Qwen is missing.**

   The design says CLAP should have a separate worker so it does not keep the heavier Qwen worker resident (`docs/design-audio-embedding-architecture.md:584-589`), but it does not state build/search lifecycle rules. The current Qwen builder creates a client inside population and shuts it down in `finally` (`runtime/artifacts/footage-db-builder.ts:1364-1478`). Audio build should explicitly run sequentially and dispose the previous worker before loading the next model. Do not allow Qwen3-VL and CLAP to be loaded simultaneously unless a Phase 0/1 peak-RSS gate proves it is acceptable.

8. **`audio_query_path` validation should mirror visual query validation.**

   The design says to validate a local absolute path and extension (`docs/design-audio-embedding-architecture.md:321-335`). The existing image query path validation also resolves real paths, requires regular readable files, and restricts them to the project root or approved derived directories (`runtime/tools/footage-search.ts:581-651`). Audio query validation needs the same containment rule, with an explicit allowed project-local reference directory if external room-tone files are supported.

9. **Audio intent routing needs deterministic rules.**

   The design gives different weights for explicit audio, speech-topic, and hybrid queries (`docs/design-audio-embedding-architecture.md:364-400`), but it does not define how search decides which route applies. Phase 2 needs a small deterministic query classifier or explicit `audio_goal` precedence rules, especially for Japanese queries where CLAP text alignment may be weaker than English.

### Low

10. **`audio_metadata` is useful but not yet formula-defined.**

    The design correctly keeps `segment_audio_profile` as a structured gate (`docs/design-audio-embedding-architecture.md:420-434`), but `audio_metadata` needs a bounded formula and missing-data behavior before it becomes part of scoring.

11. **The model/license note should distinguish selected HF weights from the LAION repo.**

    The selected Hugging Face model card currently says Apache-2.0, while the LAION GitHub repository page shows CC0 for the repository code. This is not a blocker, but the design should state that the implementation pins and records the selected HF model artifact/revision/license in `embedding_models`.

12. **BGM treatment is appropriately conservative.**

    The design does not overclaim CLAP for beat sync and defers rhythm to deterministic dynamics (`docs/design-audio-embedding-architecture.md:479-492`, `docs/design-audio-embedding-architecture.md:665-672`). That is the right editorial architecture.

## Missing Items

- Exact `segment_audio_windows` DDL with `CHECK` values, indexes, uniqueness, and whether `window_ref` is deterministic.
- Audio window cache path and manifest contract, likely `03_analysis/audio_windows/{segment_id}/{window_type}.wav` plus a JSON manifest.
- Canonical ffmpeg extraction args, audio stream selection policy, sample format, sample rate, channel mixdown policy, and source timestamp convention.
- Explicit reuse of existing `resolveSourceMediaPath(...)` behavior or a documented replacement.
- On-demand continuity extraction for actual timeline trims.
- Build options, CLI flags, progress phases, `embedding_counts`, and `embedding_statuses` field names.
- Worker dependency file contents and no-network enforcement details.
- Worker parity details: `dependency_missing`, `elapsed_ms`, metrics, shutdown, timeout restart, mock mode, vector validation, and local-only cache behavior.
- Query-path containment rules for `audio_query_path`.
- Deterministic audio intent routing, including Japanese query strategy.
- Peak RSS thresholds and sequential worker lifecycle when Qwen and CLAP are both enabled.
- Fixture paths and expected top-k outcomes, not only fixture categories.

## Recommendations

1. Patch the design before implementation with an "Implementation Contract" subsection for audio extraction:
   - window cache path
   - ffmpeg args
   - absolute source timestamp convention
   - manifest JSON fields
   - `content_hash = hash(audio bytes + extraction policy + preprocess version)`
   - no-audio and silent-window warnings

2. Generalize search fusion before adding audio scoring. Keep `legacyScore(...)` byte-for-byte compatible, then add a tested retrieval-channel fuser that can handle `audio_similarity`, Qwen, E5, and lexical channels uniformly.

3. Add exact builder/search API changes to the design:
   - `FootageSearchMode = ... | "audio"`
   - `audio_query_path`, `audio_anchor`, `audio_goal`
   - `EmbeddingCounts` and `EmbeddingStatuses` audio fields
   - CLI flags such as `--audio-embedding`, `--no-audio-embedding`, and `--audio-embed-types`

4. Make Phase 0 prove more than model import:
   - mock and real local-cache worker
   - text and audio embeddings finite, 512-dimensional, normalized
   - silent window returns `silent_window`
   - CPU is required; MPS is opportunistic
   - no network during startup
   - peak RSS/timing for 1, 4, and 16 windows
   - shutdown leaves no resident worker

5. Keep CLAP as the first model, but pin the HF snapshot and record license/revision in `embedding_models`. Do not mix CLAP, Qwen, or E5 vectors directly; only fuse scores.

6. For continuity, separate "indexed recall windows" from "final edit QA windows." The former can be stored in `segment_audio_windows`; the latter should be extracted/scored against actual selected trims.

7. Preserve the north-star shape: weak agents should see explicit structure. Return matched audio window refs, source timestamps, CLAP score, audio metadata facts, unavailable channels, and warnings so candidate evidence is inspectable rather than opaque.

## Sources Checked

- `docs/design-audio-embedding-architecture.md`
- `docs/design-multimodal-qwen3vl-unified.md`
- `runtime/artifacts/footage-db-builder.ts`
- `runtime/tools/footage-search.ts`
- `runtime/connectors/qwen3vl-embedding-local.ts`
- `python/qwen3vl_embedding_worker.py`
- `runtime/artifacts/footage-metadata-extractor.ts`
- Hugging Face `laion/clap-htsat-fused` model card: https://huggingface.co/laion/clap-htsat-fused
- Hugging Face Transformers CLAP docs: https://huggingface.co/docs/transformers/en/model_doc/clap
- LAION CLAP GitHub repository: https://github.com/LAION-AI/CLAP
