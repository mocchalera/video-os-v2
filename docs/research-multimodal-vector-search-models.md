# Research: Multimodal Vector Search Models

Date: 2026-06-19
Status: Perspective A research
Scope: Vision embedding model choices and local Apple Silicon feasibility for true multimodal footage search.
Non-goal: No code, schema migration, benchmark run, or model download in this document.
Related: [design-multimodal-vector-search-architecture.md](./design-multimodal-vector-search-architecture.md), [research-local-embedding-semantic-match.md](./research-local-embedding-semantic-match.md), [design-footage-database-unified.md](./design-footage-database-unified.md)

## 1. Executive Summary

The best first prototype is not a video-native model. It is a CLIP-family image-text encoder applied to the representative frames and key frames we already extract.

Recommended prototype order:

1. **`Xenova/clip-vit-base-patch16` via Transformers.js** for the smallest integration step in the current Node search stack. It gives 512-dim text and image vectors, runs locally, has quantized ONNX files, and should embed 89 frames comfortably under 60 seconds on CPU.
2. **`llm-jp/llm-jp-clip-vit-base-patch16` or `rinna/japanese-clip-vit-b-16` via Python/PyTorch MPS** for Japanese query quality. These are heavier and less convenient than the Xenova path, but they directly address Japanese text-to-image retrieval.
3. **`google/siglip-base-patch16-224` via Python/PyTorch MPS** as the quality challenger. It is Apache-2.0, strong for image-text retrieval, and likely better than old OpenAI CLIP for visual semantics, but Node/Transformers.js integration is less certain than CLIP.

Avoid as first prototypes:

- VideoCLIP, InternVideo, LanguageBind video, and Marlin-2B internal states. They are interesting for later text-video or span-level retrieval, but they add video decoding, temporal batching, package complexity, larger memory use, and weaker fit with the current SQLite brute-force frame-vector design.
- EVA-CLIP and MobileCLIP as first choices. EVA-CLIP is high-quality but large and less standard in the current stack. MobileCLIP is fast, but Apple AMLR licensing needs review before production use.

Local reality check: `python/.venv-marlin` currently has Python 3.13.12, PyTorch 2.12.0, and `torch.backends.mps.is_available() == True`. PyTorch/MPS is viable, but Python 3.13 may make older research repos harder to install. Prefer `transformers` and `open_clip_torch` paths over bespoke repos.

## 2. Current Architecture Baseline

The current semantic path is text-only:

- `runtime/eval/semantic-match.ts` uses `@huggingface/transformers` with `Xenova/multilingual-e5-small`, `dtype: "q8"`, `query:` / `passage:` prefixes, mean pooling, normalized vectors, and cosine similarity.
- `runtime/artifacts/footage-db-builder.ts` stores embeddings in SQLite as `Float32Array` BLOBs in `embeddings(segment_id, field, model_id, dimension, vector, content_hash, created_at)`.
- `runtime/tools/footage-search.ts` loads only `field = 'combined'` rows for the current E5 model and does brute-force cosine over filtered candidate rows.
- `package.json` already has `@huggingface/transformers` in dev dependencies and `better-sqlite3` in runtime dependencies.

This means the simplest visual search implementation is:

1. Embed representative/key frames into normalized visual vectors.
2. Store them alongside the existing text vectors with explicit model/type identity.
3. Embed a text query with the same image-text model text encoder.
4. Compare text query vector against image vectors with the existing cosine loop.

The key architectural caveat: the current `field` enum is text-shaped (`summary`, `transcript`, `scene`, `combined`). For multimodal storage, use an `embedding_type` concept such as `text_combined`, `visual_representative`, and `visual_keyframe_peak`. This can be implemented as a schema migration later; for this research document, the important point is that text and visual rows must not share ambiguous `field` values.

## 3. Model Survey

| Family | Candidate model IDs | Quality expectation | Local speed expectation | Size / dim | Japanese / multilingual text | License notes | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI CLIP | `openai/clip-vit-base-patch32`, `openai/clip-vit-large-patch14`; Node mirror `Xenova/clip-vit-base-patch16` | Solid baseline, old but well understood. L/14 is better than B/32; B/16/B/32 is fast enough for tests. | B models fast on CPU/MPS; L/14 slower but still fine for 89 frames on MPS. | B/32: 512 dim, PyTorch weight about 605 MB. L/14: 768 dim, safetensors about 1.71 GB. Xenova B/16 quantized ONNX: vision about 87 MB, text about 65 MB. | Original tokenizer is English-centric; Japanese prompts may work inconsistently. | OpenAI repo is MIT; Hugging Face model cards warn about deployment evaluation. | Best integration baseline, not best Japanese answer. |
| OpenCLIP | `laion/CLIP-ViT-B-32-laion2B-s34B-b79K`, `laion/CLIP-ViT-L-14-laion2B-s32B-b82K`, `hf-hub:*` through `open_clip_torch` | Often as good or better than OpenAI CLIP depending on checkpoint. Many variants make selection important. | Good on MPS through PyTorch/OpenCLIP. Node path depends on ONNX exports. | B/32 usually 512 dim; L/14 usually 768 dim. Download ranges from hundreds of MB to multiple GB. | Mostly English unless trained on multilingual data. | OpenCLIP code is MIT; individual weights vary by model card. | Good Python/MPS candidate if we want stronger English visual search than OpenAI CLIP. |
| SigLIP | `google/siglip-base-patch16-224`, possibly SigLIP2 variants later | Strong image-text retrieval; sigmoid loss improves CLIP-style training. Good quality challenger. | ViT-B-sized; should run on MPS via `transformers`. CPU is possible but slower than CLIP B. | Base safetensors about 813 MB; hidden/projection space effectively 768 dim for base. | Uses SentencePiece-like vocab and may handle non-English better than OpenAI CLIP, but not a Japanese-specialized model. | Apache-2.0. | Strong second prototype if Python integration is acceptable. |
| EVA-CLIP | `QuanSun/EVA-CLIP`, EVA02-CLIP L/14 variants | High quality; EVA02-CLIP-L/14 reports very strong zero-shot results. | Large models; MPS should work if dependencies do, but startup and memory cost are higher. | EVA02-CLIP-L/14 class is roughly 430M params; many weights are GB-scale. | Mostly English unless using specialized variants. | HF model card for `QuanSun/EVA-CLIP` declares MIT; verify each checkpoint. | Research later; too heavy for first brute-force local prototype. |
| Japanese CLIP | `rinna/japanese-clip-vit-b-16`, `line-corporation/clip-japanese-base`, `line-corporation/clip-japanese-base-v2`, `llm-jp/llm-jp-clip-vit-base-patch16`, `recruit-jp/japanese-clip-vit-b-32-roberta-base` | Best fit for Japanese text-to-image retrieval. English quality varies by model and training data. | ViT-B class; MPS viable. Some custom packages may be less smooth than standard HF CLIP. | rinna: 512 dim, about 787 MB. llm-jp: 512 dim, about 996 MB, 248M params. LINE base: about 787 MB. | Yes for Japanese; some models may also tolerate English but should be benchmarked. | rinna and llm-jp model cards show Apache-2.0; verify LINE v2 before use. | Necessary benchmark track because Japanese briefs are a hard requirement. |
| VideoCLIP | Facebook/fairseq MMPT VideoCLIP | Designed for video-text tasks, not single-frame visual nuance. Older research stack. | Likely install friction on Python 3.13/MPS; may require fairseq-era dependencies. | Not ideal for simple frame vector storage. | Not Japanese-focused. | Depends on fairseq/model release. | Do not prototype first. |
| InternVideo | OpenGVLab InternVideo2/2.5/3 | Strong video foundation family; useful for video-text and temporal tasks. | Heavier stack, video encoders and sometimes LLM components; not a cheap frame embedder. | InternVideo2 paper scales video encoder up to 6B params; smaller models exist but still more complex than CLIP. | Not Japanese-focused. | GitHub repo Apache-2.0; checkpoint terms should be checked. | Later research for video-native retrieval, not first frame search. |
| LanguageBind | `LanguageBind/LanguageBind_Video_FT`, repo `PKU-YuanGroup/LanguageBind` | Interesting because video/audio/image modalities align to language. | Python-heavy; likely workable on MPS only after dependency triage. Overkill for 89 extracted frames. | Larger than CLIP B; exact checkpoint sizes vary. | Mostly English; not Japanese-specialized. | Project mostly MIT; dataset license is CC-BY-NC 4.0. | Later candidate for text-video or audio-video retrieval. |
| Marlin-2B internal reps | `NemoStation/Marlin-2B` | Marlin is already valuable for captions and temporal grounding; hidden states are not documented as stable retrieval embeddings. | 2B VLM, video preprocessing stack; already usable locally for caption/find, but embedding extraction would be custom and brittle. | 2B params plus video dependencies. | Query behavior depends on Marlin model; not a dedicated shared embedding space. | Verify model license before embedding use. | Do not use internal states as the first embedding vector source. Use Marlin text output plus separate visual embeddings. |
| MobileCLIP | `apple/MobileCLIP-S1-OpenCLIP`, `apple/MobileCLIP-S2-OpenCLIP` | Strong speed/quality tradeoff; S2 claims better average zero-shot than SigLIP ViT-B/16 while smaller/faster. | Excellent local speed expected; OpenCLIP path. | S1 about 340 MB, S2 about 398 MB, 512 dim. | English-centric CLIP tokenizer. | Apple AMLR license. Needs production review. | Good edge-speed candidate after license review, not first if license ambiguity matters. |
| TinyCLIP | `wkcn/TinyCLIP-ViT-61M-32-Text-29M-LAION400M` | Compressed CLIP; useful for speed tests, likely weaker visual semantics. | Fast on CPU/MPS. | 512 dim, about 462 MB for safetensors in this model card. | English-centric. | MIT. | Benchmark only if speed becomes a blocker. |
| Transformers.js CLIP | `Xenova/clip-vit-base-patch16`, `Xenova/clip-vit-base-patch32` | Same family as OpenAI CLIP; lower friction beats quality for first prototype. | Runs in Node through ONNX Runtime. Quantized CPU should be enough for 89 frames. | B/16 quantized ONNX text about 65 MB, vision about 87 MB; 512 dim. | English-centric. | Mirrors OpenAI CLIP model behavior; verify model card/license before shipping. | Best first prototype for current TypeScript architecture. |
| E5-V | Paper/framework: E5-V universal multimodal embeddings | Promising universal multimodal embedding approach based on MLLMs, but not a small drop-in local model. | Too heavy/uncertain for the 89-frame under-60s target unless a compact released checkpoint proves otherwise. | MLLM-based; likely GB-scale. | Potentially strong multilingual if base MLLM supports it. | Depends on released checkpoint. | Track later, not first prototype. |

## 4. Local Execution Feasibility

Estimates below assume cached model weights, pre-extracted JPEG/PNG frames, batch inference, and one embedding per representative/key frame. They are planning estimates, not benchmark results.

| Model | PyTorch/MPS | Transformers.js / ONNX in Node | Download size | 89-frame estimate | Memory footprint | CPU viability |
| --- | --- | --- | ---: | ---: | ---: | --- |
| `Xenova/clip-vit-base-patch16` | Not needed | Yes, direct fit with current `@huggingface/transformers` dependency | About 152 MB for quantized text+vision ONNX; full ONNX variants larger | 10-30s CPU expected; likely faster with available native ONNX acceleration | Low, likely under 1 GB active | Yes |
| `openai/clip-vit-base-patch32` | Yes via `transformers` or OpenAI CLIP | Yes via Xenova B/32 mirror | About 605 MB PyTorch | 5-20s on MPS; 20-60s CPU depending batch/image decode | 1-2 GB | Yes |
| `openai/clip-vit-large-patch14` | Yes via `transformers` | Possible if ONNX exported, not the easiest path | About 1.71 GB safetensors | 15-45s on MPS; CPU may exceed 60s | 2-4 GB | Marginal |
| `google/siglip-base-patch16-224` | Yes via `transformers` | Transformers.js support should be verified before relying on it | About 813 MB safetensors | 10-35s on MPS; CPU maybe near target | 1.5-3 GB | Possible but not ideal |
| `llm-jp/llm-jp-clip-vit-base-patch16` | Yes via `open_clip_torch` | No obvious ready ONNX path | About 996 MB safetensors | 10-35s on MPS | 2-3 GB | Possible, slower |
| `rinna/japanese-clip-vit-b-16` | Yes via HF/`japanese_clip`; MPS needs a smoke test | No obvious ready ONNX path | About 787 MB safetensors | 10-35s on MPS | 1.5-3 GB | Possible, slower |
| `apple/MobileCLIP-S2-OpenCLIP` | Yes via `open_clip_torch` if dependencies install | No obvious ready ONNX path | About 398 MB safetensors | 3-15s on MPS expected | Under 2 GB | Yes |
| `wkcn/TinyCLIP-ViT-61M-32-Text-29M-LAION400M` | Yes via `transformers` | No obvious ready ONNX path | About 462 MB safetensors | 3-15s on MPS expected | Under 2 GB | Yes |
| EVA02-CLIP-L/14 class | Possible, but dependency/config path needs proof | Not first-class | GB-scale | 30-90s depending checkpoint and resolution | 3-6 GB+ | Poor fit |
| LanguageBind video | Possible after dependency triage | No | GB-scale | Likely exceeds simple frame budget if embedding video clips | High | Poor fit |
| InternVideo | Possible after dependency triage | No | GB-scale to many GB | Likely exceeds first-prototype budget | High | Poor fit |
| Marlin-2B | Current venv has PyTorch/MPS, but Marlin requires `transformers >= 5.7.0`, `torchcodec`, `qwen-vl-utils`, `av`, and `pillow` | No | Multi-GB | Not suitable for 89 independent frame embeddings | High | Poor fit |

The current 89-frame target is small. Brute-force cosine over 89 to a few hundred normalized `Float32Array` vectors is negligible; inference and image decode dominate.

## 5. Text-Image Shared Space

The required feature is: **text query in, image/frame results out**.

CLIP-like models support this directly:

1. Encode text query with the text encoder.
2. Encode frames with the image encoder.
3. Normalize both vectors.
4. Rank by dot product / cosine.

OpenAI CLIP explicitly exposes `encode_image()` and `encode_text()` and computes cosine-like image-text scores. Transformers.js CLIP exposes projected `text_embeds` and `image_embeds` for matching 512-dim vectors. SigLIP is also an image-text model and HF exposes it through zero-shot image classification APIs.

E5-V is relevant conceptually because it targets universal multimodal embeddings, but it is not the right first integration unless a compact local checkpoint and stable API are identified. The current local E5 path (`Xenova/multilingual-e5-small`) remains useful for multilingual text-to-text search, but it cannot compare directly against image vectors because the vector spaces differ.

Recommended query flow:

- English visual query: encode with CLIP/SigLIP text encoder and compare against visual frame embeddings.
- Japanese visual query: first try a Japanese CLIP text encoder and compare against that model's frame embeddings.
- Fallback if no Japanese visual model is available: translate/rewrite Japanese query to English, use English CLIP, and keep E5 text search in the hybrid score. This is a fallback, not the primary target.

Do not compare vectors across model families. A 512-dim E5 vector, 512-dim CLIP vector, and 512-dim Japanese CLIP vector are not interchangeable.

## 6. Integration with Current Architecture

Current state:

- Text model: `Xenova/multilingual-e5-small:q8`.
- Text vector storage: SQLite `BLOB` with `dimension`, `model_id`, `field`.
- Search: structured filters first, then FTS and/or semantic cosine over loaded rows.
- Scoring: current hybrid final score is `0.55 semantic + 0.30 lexical + 0.10 quality + 0.05 peak` when both semantic and lexical scores exist.

Recommended additive shape:

```sql
-- Conceptual shape, not an implementation patch in this task.
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
)
```

Store these independently:

- Existing E5 text rows: `model_id = Xenova/multilingual-e5-small:q8`, `embedding_type = text_combined`.
- CLIP visual rows: `model_id = Xenova/clip-vit-base-patch16:onnx-q8` or equivalent, `embedding_type = visual_representative`.
- Japanese CLIP rows: `model_id = llm-jp/llm-jp-clip-vit-base-patch16:fp32` or equivalent, same visual embedding types.

Hybrid scoring should keep independent channels:

```text
final =
  w_text_vector * e5_text_score +
  w_lexical * fts_score +
  w_visual_text_query * clip_text_to_image_score +
  w_quality * quality_score +
  w_peak * peak_score
```

Initial weights for visual query mode:

```text
0.40 visual_text_query
0.25 e5_text_score
0.20 lexical
0.10 quality
0.05 peak
```

Initial weights for image-anchor similarity mode:

```text
0.65 visual_image_to_image
0.15 e5_text_score
0.10 quality
0.05 peak
0.05 duration_or_continuity_fit
```

Frame extraction:

- Use existing representative frames first: `visual_appraisal.frame_path`, `segment.filmstrip_path`, and existing analysis frame folders.
- For each segment, start with one `visual_representative` vector. Add `visual_keyframe_peak` only after the first benchmark shows real retrieval gain.
- Segment-level visual score should be `max(frame_scores)` for ordinary retrieval and `min(before_similarity, after_similarity)` for bridge/continuity retrieval.

## 7. Benchmark Plan

Use the `ena-promo-ai` footage database because it already exercises the real segment/frame/search pipeline.

### Test Set

Create 10 query cases with manually expected top-3 segment IDs. Include both English and Japanese:

1. `warm indoor scene`
2. `soft warm light on people`
3. `clean closeup detail shot`
4. `wide exterior establishing shot`
5. `calm reflective moment`
6. `hands working`
7. `柔らかい室内光`
8. `温かい雰囲気の人物カット`
9. `静かな余韻`
10. `同じ構図の別カット`

For each query, record:

- Expected top-3 segments.
- Expected acceptable alternates.
- Negative examples that should not rank highly.
- Whether the query is about literal object, lighting/color, composition, mood, or continuity.

### Models to Run

Minimum benchmark:

1. Current E5 text-only baseline.
2. `Xenova/clip-vit-base-patch16` visual vectors.
3. `rinna/japanese-clip-vit-b-16` or `llm-jp/llm-jp-clip-vit-base-patch16`.
4. `google/siglip-base-patch16-224`.

Optional:

- `apple/MobileCLIP-S2-OpenCLIP` if license review is acceptable.
- `wkcn/TinyCLIP-ViT-61M-32-Text-29M-LAION400M` if speed is a concern.

### Metrics

- Retrieval quality: Recall@3 against expected top-3, MRR, and a small editorial usefulness score from 1-5.
- Query language split: Japanese vs English quality separately.
- Visual category split: lighting/color, composition, object/action, mood.
- Inference time: cold download excluded, cached startup included separately, frame embedding time for 89 frames, query embedding time.
- Memory: peak RSS for Python or Node process.
- Artifact size: SQLite growth from stored vectors.

### Acceptance Gate

A model is prototype-worthy if:

- It embeds 89 frames in under 60 seconds on this Mac after weights are cached.
- It handles text-to-image retrieval, not image-only similarity.
- Japanese queries are either directly supported or clearly recover through a planned Japanese model track.
- It improves at least 3 of the 5 visual nuance queries over E5 text-only baseline.
- It does not require a production-hosted API.

## 8. Recommendation

### Prototype 1: `Xenova/clip-vit-base-patch16`

Use this first because it fits the current TypeScript architecture:

- Same `@huggingface/transformers` dependency family.
- No Python bridge needed.
- Quantized ONNX text and vision files are small enough for local setup.
- 512-dim vectors keep SQLite storage tiny: 89 frames * 512 floats * 4 bytes is about 182 KB per visual embedding type before SQLite overhead.
- Good enough to prove the storage/search/scoring loop.

Risk: Japanese query quality will be weak. Treat this as an architecture prototype, not the final multilingual retrieval solution.

### Prototype 2: Japanese CLIP on PyTorch/MPS

Benchmark either:

- `llm-jp/llm-jp-clip-vit-base-patch16`: OpenCLIP-format, Apache-2.0, 248M params, 512 dim, about 996 MB.
- `rinna/japanese-clip-vit-b-16`: Japanese CLIP, Apache-2.0, 512 dim, about 787 MB.

Use this to answer the real product question: can Japanese mood and visual prompts retrieve frames directly without relying on Marlin captions?

Risk: Python-side embedding introduces a second runtime path. Keep it build-time/index-time only; search can still consume SQLite vectors from Node.

### Prototype 3: `google/siglip-base-patch16-224`

Run this only after the first two baselines:

- Strong quality candidate.
- Apache-2.0.
- MPS viable through `transformers`.
- Useful comparison against CLIP for color/lighting/composition language.

Risk: if Japanese query performance is only moderate and Node integration is weaker, it may be a quality benchmark rather than a shipping model.

## 9. Sources Checked

- OpenAI CLIP repository: image/text encoders, cosine-style scores, MIT license. https://github.com/openai/CLIP
- OpenCLIP repository and model family. https://github.com/mlfoundations/open_clip
- Google SigLIP model card, Apache-2.0 license and Transformers usage. https://huggingface.co/google/siglip-base-patch16-224
- Apple MobileCLIP S2 model card, OpenCLIP usage and Apple AMLR license. https://huggingface.co/apple/MobileCLIP-S2-OpenCLIP
- rinna Japanese CLIP model card. https://huggingface.co/rinna/japanese-clip-vit-b-16
- llm-jp Japanese CLIP model card. https://huggingface.co/llm-jp/llm-jp-clip-vit-base-patch16
- TinyCLIP model card. https://huggingface.co/wkcn/TinyCLIP-ViT-61M-32-Text-29M-LAION400M
- EVA-CLIP project/model information. https://github.com/baaivision/EVA/tree/master/EVA-CLIP and https://huggingface.co/QuanSun/EVA-CLIP
- VideoCLIP paper. https://aclanthology.org/2021.emnlp-main.544/
- InternVideo repository and InternVideo2 paper. https://github.com/OpenGVLab/InternVideo and https://arxiv.org/html/2403.15377v2
- LanguageBind repository. https://github.com/PKU-YuanGroup/LanguageBind
- Marlin-2B model card. https://huggingface.co/NemoStation/Marlin-2B
- E5-V paper. https://arxiv.org/abs/2407.12580
