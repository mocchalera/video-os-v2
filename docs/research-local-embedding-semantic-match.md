# Local Embedding Research for Cross-Language Must-Have Matching

Date: 2026-06-17

## Summary

`mdedit` does have local semantic search, but its default provider is not a multilingual embedding model. It has two local providers:

- `local_concept_v1`: a deterministic 128-dimensional hashed concept vector with a small English synonym table. It is fast and offline, but it is not a trained multilingual model and will not solve Japanese-to-English matching such as `星空` -> `starry sky`.
- `apple_nl_sentence_embedding_v1`: a local macOS Swift helper around Apple NaturalLanguage `NLEmbedding.sentenceEmbedding(for:)`. It is local and produces 512-dimensional vectors when available, but mdedit stores language-specific model ids and searches only the same model id as the query. In the current implementation, Japanese queries will not match English-indexed chunks.

For `video-os-v2-spec`, the best fit is Hugging Face Transformers.js with `Xenova/multilingual-e5-small` or the current package name `@huggingface/transformers`. It is a local ONNX path in Node.js, supports Japanese and English in one embedding space, works offline after model artifacts are cached or vendored, and can handle the target 5-10 must-have strings plus 50-100 evidence strings under 2 seconds after cache warm-up on this machine.

Recommended implementation direction:

1. Keep the current deterministic matcher as the fallback.
2. Add an optional local semantic matcher using multilingual E5, prefixed as `query: <must_have>` and `passage: <candidate evidence>`.
3. Use cosine similarity on L2-normalized vectors.
4. Start with an auto-match threshold around `0.82`, an uncertain band around `0.76-0.82`, and a margin guard of `>= 0.03` over the second-best candidate. Calibrate this with project fixtures before making it a hard gate.

## Current video-os-v2-spec Matching Path

Current matching is lexical and synchronous:

- `runtime/eval/selection-coverage.ts` builds one text blob from active candidates: `why_it_matches`, `evidence`, and selected segment summaries.
- `itemMatchesSearchText()` normalizes text, checks compact substring matches, token inclusion, then short character windows.
- `analyzeSelectionCoverage()` maps each `brief.must_have` item to `matched: itemMatchesSearchText(item, searchText)`.
- `scoreMustHaveCoverage()` in `runtime/eval/brief-alignment-deterministic.ts` turns that report into the `must_have_coverage` axis score.
- `brief-alignment.ts` and `brief-alignment-quick.ts` both depend on this score.

This explains the failure mode: a Japanese must-have like `焚き火のシーン` is never a substring/token match for English VLM evidence like `campfire scene`.

## mdedit Findings

Source inspected: `/Users/mocchalera/Dev/mdedit`.

### Provider registry

`src-tauri/src/semantic_provider.rs` defines:

- `LOCAL_SEMANTIC_PROVIDER = "local_concept_v1"`
- `APPLE_NL_SEMANTIC_PROVIDER = "apple_nl_sentence_embedding_v1"`
- `LOCAL_SEMANTIC_DIMENSION = 128`
- `LOCAL_SCORE_THRESHOLD = 0.12`
- `APPLE_NL_SCORE_THRESHOLD = 0.35`

`embed_batch()` dispatches to `local_semantic_vector()` for `local_concept_v1` and to a Swift helper for Apple NL.

### local_concept_v1

Implementation:

- Tokenizes by non-alphanumeric boundaries.
- Adds a small hard-coded English expansion table for words such as `agent`, `decision`, `context`, `search`, `semantic`, `project`, `document`, and `policy`.
- For non-ASCII tokens longer than four characters, adds 2-character windows.
- Hashes terms into 128 dimensions with signed counts, then L2-normalizes.

Performance and footprint:

- No model load.
- No external dependencies beyond Rust standard code.
- Vector footprint is tiny: 128 `f32` values before SQLite blob overhead.
- Suitable for broad conceptual English repo search, not trained cross-language semantic similarity.

Cross-language suitability:

- Poor for this task. It has no Japanese-to-English semantic bridge. It can only match overlapping tokens, character windows, or the hard-coded English expansions.

### apple_nl_sentence_embedding_v1

Implementation:

- `src-tauri/src/apple_nl_embedding.swift` imports `NaturalLanguage`.
- It detects English or Japanese using `NLLanguageRecognizer`, falling back to character heuristics.
- It calls `NLEmbedding.sentenceEmbedding(for: language)` and `sentenceEmbedding.vector(for: item.text)`.
- It normalizes the returned vector.
- It returns model ids like `apple_nl_sentence_embedding_v1:en:r1` or `apple_nl_sentence_embedding_v1:ja:r1`.
- `semantic_provider.rs` compiles this Swift helper with `swiftc -O` into `/tmp` on first use and spawns it for status/embed calls.

Storage/search path:

- `search_index.rs` stores vectors in SQLite `embeddings(chunk_id, model_id, dimension, chunk_hash, vector_blob, created_at)`.
- `ensure_semantic_index(provider)` embeds chunks and stores them by actual `embedding.model_id`.
- `search_semantic(query, provider, limit)` embeds the query, takes its `query_model_id`, then selects only rows where `embeddings.model_id = query_model_id`.
- Dot product is used for similarity because vectors are normalized.

Important limitation:

- Even if both English and Japanese sentence embeddings are available, mdedit's current search path compares only matching language-specific model ids. A Japanese query would use `apple_nl_sentence_embedding_v1:ja:r1`, while English VLM evidence would be indexed as `apple_nl_sentence_embedding_v1:en:r1`; those rows are not compared.

Local smoke on this machine:

- `swift apple_nl_embedding.swift status` returned `available: true`, `dimension: 512`, `revision: 1`.
- Embedding English examples worked.
- Embedding `焚き火のシーン` and `星空` was skipped with `sentence embedding unavailable for ja`.

Conclusion for this task:

- Apple NL is not a reliable solution for Japanese-to-English must-have matching. It is macOS-only, can lack Japanese sentence assets, and mdedit's implementation is language-model-id isolated.

## Local Embedding Options on macOS

### Option A: Transformers.js plus multilingual E5

Current package:

- Use `@huggingface/transformers`; `@xenova/transformers` was the v1/v2 package name. Hugging Face moved Transformers.js under the official `@huggingface/transformers` package in v3.
- Transformers.js runs ONNX models locally in JavaScript/TypeScript. It supports Node.js, browser-like runtimes, WASM, and WebGPU where available.

Model:

- `Xenova/multilingual-e5-small` is an ONNX-converted Transformers.js-compatible version of `intfloat/multilingual-e5-small`.
- The base model card says `intfloat/multilingual-e5-small` has 12 layers and embedding size 384.
- The model metadata lists Japanese (`ja`) and English (`en`) among the supported languages.
- E5 expects prefixes. For retrieval-style matching, use:
  - `query: 焚き火のシーン`
  - `passage: campfire scene with people sitting around the fire`

Throwaway benchmark on this machine:

- Location: `/tmp/video-os-embedding-research`, outside the repo.
- Package: `@huggingface/transformers@4.2.0`.
- Model: `Xenova/multilingual-e5-small`, `dtype: "q8"`.
- Cache size after model download: `145M`.
- Throwaway `node_modules`: `381M`.
- Fresh cached process load: about `0.74-0.78s`.
- Embed 110 short strings: about `0.21-0.58s`.
- Second in-process 110-string batch: about `0.25s`.
- RSS after load/embed in one run: about `711-748MB`.
- First ever run with download/cache was about `9s` total, so runtime must assume model artifacts are already cached or vendored for offline checks.

Example scores from the same local smoke:

| Must-have | Top English evidence | Cosine |
| --- | --- | ---: |
| `焚き火のシーン` | `campfire scene with people sitting around the fire` | 0.850 |
| `星空` | `starry sky above the campsite` | 0.790 |
| `子供の表情` | `child facial expression in close-up` | 0.891 |
| `家族が笑っている場面` | `family laughing together` | 0.877 |
| `戸隠キャンプ場の自然` | `forest and mountain nature around Togakushi campsite` | 0.850 |

The rankings were correct, but E5 cosine scores cluster high. For example, unrelated or weakly related campsite/visual candidates can still appear around `0.75-0.80`. This should not be implemented as a naive single threshold without a margin or calibration fixtures.

Offline behavior:

- After caching or vendoring model files, set `env.allowRemoteModels = false`.
- Set `env.cacheDir` or `env.localModelPath` explicitly for deterministic eval behavior.
- If strict offline operation is required in CI, add a setup/check command that verifies model files exist before running semantic eval.

Assessment:

- Best option for this repo because it is TypeScript-friendly, local, multilingual, and fast enough after cache warm-up.
- Main cost is memory and dependency/model footprint.

### Option B: Apple NaturalLanguage framework

Implementation route:

- Use Swift or Objective-C bridge to `NLEmbedding.sentenceEmbedding(for:)`.
- Similar to mdedit, a Node/Rust process can compile or call a small Swift helper.

Pros:

- No npm ML dependency.
- Native macOS API.
- Fully local when the OS language assets are available.

Cons:

- macOS-only.
- Availability varies by language and machine. On this machine, English sentence embeddings were available but Japanese sentence vectors were unavailable.
- The API is language-specific. Apple docs describe embeddings for a selected language; they do not provide a clear guarantee that English and Japanese sentence embeddings share one cross-lingual vector space.
- Bridging adds process/compile complexity.

Assessment:

- Not recommended for Japanese-to-English eval matching.
- Could remain a local fallback for same-language English or Japanese matching if we already have a Swift helper, but it is not a robust cross-language solution.

### Option C: llama.cpp or llamafile embedding server

Implementation route:

- Run a local GGUF embedding model with `llama-server --embedding` or `--embeddings`.
- Call `/v1/embeddings` from Node using local HTTP.
- Use a multilingual embedding GGUF model, not a chat model.

Pros:

- Excellent local runtime ecosystem on macOS, including Metal.
- OpenAI-compatible local endpoint can make integration simple.
- Good when a project already standardizes on a local model server.

Cons:

- Adds a server lifecycle to an eval check.
- Requires choosing/downloading/converting a suitable multilingual embedding model.
- More operational surface than needed for 5-10 queries and 50-100 evidence strings.
- Harder to make deterministic in CI unless the server/model lifecycle is controlled.

Assessment:

- Feasible, but heavier than Transformers.js for this repo.
- Better as an alternate provider later if the project already introduces local model-serving infrastructure.

### Option D: npm packages that bundle or catalog embedding models

Findings:

- `fastembed` for npm exists and supports Node embeddings with ONNX Runtime, but its GitHub repo was archived on 2026-01-15. Its listed model catalog includes `intfloat/multilingual-e5-large`, not `multilingual-e5-small`.
- Qdrant's current FastEmbed documentation is strongest for Python; it supports a set of ONNX models including multilingual models, but bringing Python into this TypeScript eval path is unnecessary.
- I did not find a better-maintained npm package that bundles a small multilingual Japanese-English embedding model directly as package payload. Most options download/cache model weights separately.

Assessment:

- Do not use `fastembed` npm as the first implementation path.
- Prefer `@huggingface/transformers` because it is current, well-documented, and directly supports the target ONNX model.

## Feasibility for video-os-v2-spec

### Workload

Target workload:

- 5-10 Japanese must-have strings.
- 50-100 English candidate/evidence strings.
- About 55-110 total embeddings.
- Pairwise comparison count is tiny: at most about 1,000 cosine scores for 10 x 100.

The comparison math is negligible. Runtime is dominated by model load and embedding inference.

### Speed

With cached `Xenova/multilingual-e5-small` in Transformers.js:

- Fresh Node process: roughly 1.0-1.4s total for load plus 110-string embedding in observed local runs.
- Reused in-process pipeline: a few hundred milliseconds for the batch.

So the target can run under 2 seconds if:

- model files are already cached or vendored,
- the pipeline singleton is reused within the eval process,
- evidence strings stay short, which they are.

It will not run under 2 seconds on the first ever download/cache path.

### Memory

Observed RSS after loading and embedding with q8 was roughly `700-750MB`. The cached model files were about `145MB`; runtime memory is much higher than file size.

This is acceptable for an optional local eval check on a development machine, but too heavy to silently add to every test invocation. It should be opt-in or scoped to brief-alignment eval, not imported by default in lightweight deterministic tests.

### Offline

Yes, after artifacts are cached or vendored. For strict offline use:

- configure `env.allowRemoteModels = false`,
- set `env.cacheDir` to a repo- or user-cache path,
- fail with a clear message if the model is absent,
- optionally add a one-time setup command to populate the cache.

### Threshold

Initial recommendation:

- `score >= 0.82`: auto-match if the margin over the second-best evidence string is at least `0.03`.
- `0.76 <= score < 0.82`: mark as semantic-uncertain and include best evidence in the report.
- `< 0.76`: no semantic match.

Why not a lower single threshold:

- The local smoke showed correct matches, but weakly related visual/campsite candidates can still land around `0.75-0.80`.
- E5 model cards also warn through usage examples that the model should be treated as a retrieval model with query/passage prefixes, not as an absolute universal truth score.

Calibration needed:

- Add fixture pairs for known positives and negatives from `togakushi-camp`, `fumoto-growth`, and `ena-promo`.
- Tune threshold and margin using those fixtures.
- Preserve the existing lexical matcher as a positive signal, so exact Japanese evidence remains matched without model load.

## Recommended Integration Sketch

This is research only; no implementation was made.

### Dependencies

Add an optional/local eval dependency:

```json
{
  "dependencies": {
    "@huggingface/transformers": "^4.2.0"
  }
}
```

If we want to avoid making normal install heavier, consider adding it only when we introduce a dedicated semantic eval command. The simpler path is to add it as a normal dependency because eval runtime imports are server-side Node only.

### New module

Add `runtime/eval/local-semantic-embedding.ts`:

- Lazily imports `@huggingface/transformers`.
- Creates one singleton feature-extraction pipeline:

```ts
pipeline("feature-extraction", "Xenova/multilingual-e5-small", { dtype: "q8" })
```

- Sets:

```ts
env.cacheDir = process.env.VIDEO_OS_EMBEDDING_CACHE_DIR ?? ".cache/transformers";
if (process.env.VIDEO_OS_EMBEDDING_OFFLINE === "1") env.allowRemoteModels = false;
```

- Exposes:

```ts
embedTexts(texts: string[]): Promise<number[][]>
cosine(a: number[], b: number[]): number
```

The output should use `{ pooling: "mean", normalize: true }`.

### New matcher

Add `runtime/eval/must-have-semantic-match.ts`:

- Inputs: `brief.must_have`, active candidates, segment summaries.
- Evidence string per candidate:
  - `candidate.why_it_matches`
  - `candidate.evidence`
  - `candidate.transcript_excerpt`
  - `candidate.motif_tags`
  - matching segment summary
- Prefix must-haves with `query:`.
- Prefix evidence strings with `passage:`.
- Embed one combined batch.
- For each must-have, compute top evidence match and second-best margin.
- Return structured results:

```ts
interface SemanticMustHaveMatch {
  item: string;
  matched: boolean;
  score: number;
  margin: number;
  candidate_segment_id?: string;
  evidence?: string;
  note: "semantic" | "semantic-uncertain" | "semantic-no-match";
}
```

### Keep deterministic APIs stable

Avoid making `analyzeSelectionCoverage()` async. Instead:

1. Leave deterministic lexical coverage as-is.
2. Add a semantic override path in the async brief-alignment orchestration.
3. Split `scoreMustHaveCoverage()` internally so it can score a prepared coverage report, for example:

```ts
function scoreMustHaveCoverageReport(coverage: SelectionCoverageReport): AxisScore
```

Then the full eval path can:

1. Run lexical coverage.
2. If semantic matching is enabled, patch only selectable unmatched items that have confident semantic matches.
3. Score the resulting coverage report.

This keeps current quick tests and deterministic behavior stable while allowing the full brief-alignment eval to become semantic-aware.

### Files likely to change in an implementation

- `package.json`: add `@huggingface/transformers`.
- `runtime/eval/local-semantic-embedding.ts`: new local model loader/embedder.
- `runtime/eval/must-have-semantic-match.ts`: new matching logic and thresholds.
- `runtime/eval/selection-coverage.ts`: optionally extend `MustHaveCoverage` with semantic metadata, or accept a match override map.
- `runtime/eval/brief-alignment-deterministic.ts`: split coverage report scoring from coverage construction.
- `runtime/eval/brief-alignment.ts`: wire optional semantic coverage in the async full eval path.
- `runtime/eval/brief-alignment-quick.ts`: either stay deterministic or gain a separate async semantic quick path later.
- `tests/selection-coverage.test.ts`: keep deterministic tests unchanged.
- New tests for semantic matcher with a mocked embedder, plus one skipped/manual integration smoke for the real local model.

### Feature flag

Recommended flags:

- `VIDEO_OS_SEMANTIC_MUST_HAVE=1`: enable semantic matching.
- `VIDEO_OS_EMBEDDING_OFFLINE=1`: disallow remote model loading.
- `VIDEO_OS_EMBEDDING_CACHE_DIR=<path>`: cache/model location.
- `VIDEO_OS_SEMANTIC_THRESHOLD=0.82`: override auto-match threshold.
- `VIDEO_OS_SEMANTIC_MARGIN=0.03`: override margin threshold.

Default should remain deterministic lexical matching until the fixture calibration is done.

## Sources

Local code:

- `/Users/mocchalera/Dev/mdedit/src-tauri/src/semantic_provider.rs`
- `/Users/mocchalera/Dev/mdedit/src-tauri/src/apple_nl_embedding.swift`
- `/Users/mocchalera/Dev/mdedit/src-tauri/src/search_index.rs`
- `/Users/mocchalera/Dev/mdedit/CONTINUITY.md`
- `runtime/eval/selection-coverage.ts`
- `runtime/eval/brief-alignment-deterministic.ts`
- `runtime/eval/brief-alignment.ts`
- `runtime/eval/brief-alignment-quick.ts`
- `package.json`

External references checked:

- Hugging Face Transformers.js docs: https://huggingface.co/docs/transformers.js/en/index
- Transformers.js environment/offline config: https://huggingface.co/docs/transformers.js/en/api/env
- Transformers.js v3 package migration and WebGPU/Node support: https://huggingface.co/blog/transformersjs-v3
- `Xenova/multilingual-e5-small` ONNX model for Transformers.js: https://huggingface.co/Xenova/multilingual-e5-small
- `intfloat/multilingual-e5-small` model card: https://huggingface.co/intfloat/multilingual-e5-small
- Multilingual E5 technical report: https://arxiv.org/abs/2402.05672
- Apple `NLEmbedding`: https://developer.apple.com/documentation/naturallanguage/nlembedding
- Apple sentence embedding API: https://developer.apple.com/documentation/naturallanguage/nlembedding/sentenceembedding%28for%3A%29
- llama.cpp server embeddings docs: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
- llama.cpp embedding tutorial: https://github.com/ggml-org/llama.cpp/discussions/7712
- FastEmbed supported models: https://qdrant.github.io/fastembed/examples/Supported_Models/
- `fastembed-js` repository: https://github.com/Anush008/fastembed-js
