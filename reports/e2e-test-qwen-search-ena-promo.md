# E2E Test: Qwen3-VL Multimodal Search on ena-promo-ai

Generated: 2026-06-19T11:14:25.245Z

## Build Summary

| Item | Value |
| --- | --- |
| Project | `projects/ena-promo-ai` |
| Build command | `HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 VOS_QWEN3VL_CACHE_DIR=$HOME/.cache/huggingface/hub VOS_QWEN3VL_REQUEST_TIMEOUT_MS=120000 npx tsx scripts/build-footage-db.ts --project projects/ena-promo-ai --qwen3vl` |
| Build time | 165.72s real, 90.34s user, 84.57s sys |
| DB path | `projects/ena-promo-ai/03_analysis/search/footage.db` |
| DB realpath | `projects/ena-promo/03_analysis/search/footage.db` |
| 03_analysis symlink target | `../ena-promo/03_analysis` |
| Segment count | 89 |
| DB asset count | 89 |
| Media files under 02_media | 185 |
| Frame cache count | 89 representative frames |
| Build report counts | `{"assets":89,"segments":89,"fts_rows":89,"marlin_events":301,"transcript_segments":0,"asset_technical_metadata":89,"segment_visual_profiles":89,"segment_audio_profiles":89,"segment_logging_profiles":89,"metadata_fts_rows":89,"embeddings":445}` |
| Embedding counts | `{"e5_text":267,"qwen_text":89,"qwen_visual":89,"qwen_mixed":0,"qwen_reranker":0}` |
| Embedding statuses | `{"e5_text":"ready","qwen_text":"ready","qwen_visual":"ready","qwen_mixed":"unsupported","qwen_reranker":"deferred"}` |
| Build warnings | none |

Result: the NaN-vector failure is resolved. `text_combined_qwen` is now built for all 89 segments, and `embedding_statuses.qwen_text` is `ready`.

## DB Verification

`PRAGMA integrity_check`: `ok`

| embedding_type | count |
| --- | ---: |
| `combined` | 89 |
| `scene` | 89 |
| `summary` | 89 |
| `text_combined_qwen` | 89 |
| `visual_representative` | 89 |

## Image Query Path

Image query / anchor frame:
`projects/ena-promo-ai/03_analysis/frames/SEG_AST_02352E6C_0001/representative.jpg`

Resolved realpath:
`projects/ena-promo/03_analysis/frames/SEG_AST_02352E6C_0001/representative.jpg`

Queries 3 and 4 passed the cached frame path directly through `image_query_path`. No temp copy was created or used; `projects/ena-promo-ai/.tmp-qwen-search-query-frame.jpg` did not exist after the run. Both image-query cases completed with no warnings, confirming the symlink-approved realpath fix works for this E2E path.

## Query Results

### 1. Text-to-visual hybrid: 温かみのある光のシーン

- Input: `{"query":"温かみのある光のシーン","semantic":"温かみのある光のシーン","mode":"hybrid","limit":5}`
- Latency: 6485.3 ms
- DB status: ready, mode used: hybrid
- Warnings: none

| rank | segment_id | e5_text | qwen_visual | qwen_text | lexical | quality | peak | final | matched_frame_path |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | `SEG_AST_0C0DA029_0001` | 0.909 | 0.852 | 0.833 |  | 0.780 | 1.000 | 0.867 | `03_analysis/frames/SEG_AST_0C0DA029_0001/representative.jpg` |
| 2 | `SEG_AST_1FAEEECE_0001` | 0.904 | 0.853 | 0.837 |  | 0.750 | 1.000 | 0.864 | `03_analysis/frames/SEG_AST_1FAEEECE_0001/representative.jpg` |
| 3 | `SEG_AST_E98C7A35_0001` | 0.912 | 0.844 | 0.842 |  | 0.750 | 1.000 | 0.863 | `03_analysis/frames/SEG_AST_E98C7A35_0001/representative.jpg` |
| 4 | `SEG_AST_9258ECBB_0001` | 0.912 | 0.841 | 0.850 |  | 0.740 | 1.000 | 0.861 | `03_analysis/frames/SEG_AST_9258ECBB_0001/representative.jpg` |
| 5 | `SEG_AST_ABC69F0E_0001` | 0.910 | 0.815 | 0.822 | 1.000 | 0.660 | 1.000 | 0.861 | `03_analysis/frames/SEG_AST_ABC69F0E_0001/representative.jpg` |

### 2. Visual mood hybrid: 静かな自然の風景

- Input: `{"query":"静かな自然の風景","semantic":"静かな自然の風景","mode":"hybrid","limit":5}`
- Latency: 103.2 ms
- DB status: ready, mode used: hybrid
- Warnings: none

| rank | segment_id | e5_text | qwen_visual | qwen_text | lexical | quality | peak | final | matched_frame_path |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | `SEG_AST_FA1D3DB5_0001` | 0.912 | 0.867 | 0.844 |  | 0.700 | 1.000 | 0.868 | `03_analysis/frames/SEG_AST_FA1D3DB5_0001/representative.jpg` |
| 2 | `SEG_AST_0C0DA029_0001` | 0.907 | 0.843 | 0.835 |  | 0.780 | 1.000 | 0.863 | `03_analysis/frames/SEG_AST_0C0DA029_0001/representative.jpg` |
| 3 | `SEG_AST_30B96D6D_0001` | 0.909 | 0.853 | 0.845 |  | 0.720 | 1.000 | 0.863 | `03_analysis/frames/SEG_AST_30B96D6D_0001/representative.jpg` |
| 4 | `SEG_AST_5FB4EC26_0001` | 0.901 | 0.848 | 0.844 |  | 0.720 | 1.000 | 0.859 | `03_analysis/frames/SEG_AST_5FB4EC26_0001/representative.jpg` |
| 5 | `SEG_AST_CE4A122F_0001` | 0.908 | 0.846 | 0.836 |  | 0.720 | 1.000 | 0.859 | `03_analysis/frames/SEG_AST_CE4A122F_0001/representative.jpg` |

### 3. Image-to-image visual search

- Input: `{"query":"","mode":"visual","image_query_path":"projects/ena-promo-ai/03_analysis/frames/SEG_AST_02352E6C_0001/representative.jpg","limit":5}`
- Latency: 401.7 ms
- DB status: ready, mode used: visual
- Warnings: none

| rank | segment_id | e5_text | qwen_visual | qwen_text | lexical | quality | peak | final | matched_frame_path |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | `SEG_AST_02352E6C_0001` |  | 1.000 |  |  | 0.680 | 1.000 | 0.943 | `03_analysis/frames/SEG_AST_02352E6C_0001/representative.jpg` |
| 2 | `SEG_AST_C3CE5B20_0001` |  | 0.961 |  |  | 0.700 | 1.000 | 0.915 | `03_analysis/frames/SEG_AST_C3CE5B20_0001/representative.jpg` |
| 3 | `SEG_AST_0C0DA029_0001` |  | 0.941 |  |  | 0.780 | 1.000 | 0.908 | `03_analysis/frames/SEG_AST_0C0DA029_0001/representative.jpg` |
| 4 | `SEG_AST_02C4A9CB_0001` |  | 0.962 |  |  | 0.620 | 1.000 | 0.900 | `03_analysis/frames/SEG_AST_02C4A9CB_0001/representative.jpg` |
| 5 | `SEG_AST_FA6BF8D4_0001` |  | 0.911 |  |  | 0.740 | 1.000 | 0.898 | `03_analysis/frames/SEG_AST_FA6BF8D4_0001/representative.jpg` |

### 4. Multimodal text + image search

- Input: `{"query":"この構図に似たカット","semantic":"この構図に似たカット","mode":"multimodal","image_query_path":"projects/ena-promo-ai/03_analysis/frames/SEG_AST_02352E6C_0001/representative.jpg","limit":5}`
- Latency: 334.6 ms
- DB status: ready, mode used: multimodal
- Warnings: none

| rank | segment_id | e5_text | qwen_visual | qwen_text | lexical | quality | peak | final | matched_frame_path |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | `SEG_AST_02352E6C_0001` | 0.896 | 1.000 | 0.833 |  | 0.680 | 1.000 | 0.949 | `03_analysis/frames/SEG_AST_02352E6C_0001/representative.jpg` |
| 2 | `SEG_AST_C3CE5B20_0001` | 0.900 | 0.961 | 0.822 |  | 0.700 | 1.000 | 0.926 | `03_analysis/frames/SEG_AST_C3CE5B20_0001/representative.jpg` |
| 3 | `SEG_AST_0C0DA029_0001` | 0.901 | 0.941 | 0.830 |  | 0.780 | 1.000 | 0.921 | `03_analysis/frames/SEG_AST_0C0DA029_0001/representative.jpg` |
| 4 | `SEG_AST_02C4A9CB_0001` | 0.902 | 0.962 | 0.826 |  | 0.620 | 1.000 | 0.919 | `03_analysis/frames/SEG_AST_02C4A9CB_0001/representative.jpg` |
| 5 | `SEG_AST_892AC322_0001` | 0.908 | 0.932 | 0.828 | 1.000 | 0.680 | 1.000 | 0.917 | `03_analysis/frames/SEG_AST_892AC322_0001/representative.jpg` |

### 5. Backward compatibility text search: 栗

- Input: `{"query":"栗","mode":"text","limit":5}`
- Latency: 89.4 ms
- DB status: ready, mode used: text
- Warnings: none

| rank | segment_id | e5_text | qwen_visual | qwen_text | lexical | quality | peak | final | matched_frame_path |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | `SEG_AST_0C0DA029_0001` | 0.877 | 0.843 | 0.815 |  | 0.780 | 1.000 | 0.852 | `03_analysis/frames/SEG_AST_0C0DA029_0001/representative.jpg` |
| 2 | `SEG_AST_FA6BF8D4_0001` | 0.882 | 0.841 | 0.796 |  | 0.740 | 1.000 | 0.846 | `03_analysis/frames/SEG_AST_FA6BF8D4_0001/representative.jpg` |
| 3 | `SEG_AST_628B1F09_0001` | 0.884 | 0.839 | 0.815 |  | 0.710 | 1.000 | 0.845 | `03_analysis/frames/SEG_AST_628B1F09_0001/representative.jpg` |
| 4 | `SEG_AST_5FB4EC26_0001` | 0.870 | 0.842 | 0.815 |  | 0.720 | 1.000 | 0.843 | `03_analysis/frames/SEG_AST_5FB4EC26_0001/representative.jpg` |
| 5 | `SEG_AST_1FAEEECE_0001` | 0.883 | 0.830 | 0.795 |  | 0.750 | 1.000 | 0.842 | `03_analysis/frames/SEG_AST_1FAEEECE_0001/representative.jpg` |

### 6. Visual anchor search

- Input: `{"query":"","mode":"visual","visual_anchor":{"segment_id":"SEG_AST_02352E6C_0001","frame_type":"visual_representative"},"filters":{"exclude_segment_ids":["SEG_AST_02352E6C_0001"]},"limit":5}`
- Latency: 10.8 ms
- DB status: ready, mode used: visual
- Warnings: none

| rank | segment_id | e5_text | qwen_visual | qwen_text | lexical | quality | peak | final | matched_frame_path |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | `SEG_AST_C3CE5B20_0001` |  | 0.961 |  |  | 0.700 | 1.000 | 0.915 | `03_analysis/frames/SEG_AST_C3CE5B20_0001/representative.jpg` |
| 2 | `SEG_AST_0C0DA029_0001` |  | 0.941 |  |  | 0.780 | 1.000 | 0.908 | `03_analysis/frames/SEG_AST_0C0DA029_0001/representative.jpg` |
| 3 | `SEG_AST_02C4A9CB_0001` |  | 0.962 |  |  | 0.620 | 1.000 | 0.900 | `03_analysis/frames/SEG_AST_02C4A9CB_0001/representative.jpg` |
| 4 | `SEG_AST_FA6BF8D4_0001` |  | 0.911 |  |  | 0.740 | 1.000 | 0.898 | `03_analysis/frames/SEG_AST_FA6BF8D4_0001/representative.jpg` |
| 5 | `SEG_AST_3F8739DE_0001` |  | 0.930 |  |  | 0.700 | 1.000 | 0.892 | `03_analysis/frames/SEG_AST_3F8739DE_0001/representative.jpg` |

## Ranking Comparison

| Query | Previous top 5 | Current top 5 | Change |
| --- | --- | --- | --- |
| 温かみのある光のシーン | `0C0DA029`, `1FAEEECE`, `ABC69F0E`, `E98C7A35`, `FA6BF8D4` | `0C0DA029`, `1FAEEECE`, `E98C7A35`, `9258ECBB`, `ABC69F0E` | Top 2 unchanged. `E98C7A35` moved 4->3, `9258ECBB` entered at 4, `ABC69F0E` moved 3->5, `FA6BF8D4` dropped out of top 5. |
| 静かな自然の風景 | `FA1D3DB5`, `0C0DA029`, `30B96D6D`, `FA6BF8D4`, `867607E9` | `FA1D3DB5`, `0C0DA029`, `30B96D6D`, `5FB4EC26`, `CE4A122F` | Top 3 unchanged. Two natural/outdoor results entered at ranks 4-5. |
| Image-to-image visual | `02352E6C`, `C3CE5B20`, `0C0DA029`, `02C4A9CB`, `FA6BF8D4` | `02352E6C`, `C3CE5B20`, `0C0DA029`, `02C4A9CB`, `FA6BF8D4` | Unchanged. |
| Multimodal text + image | `02352E6C`, `C3CE5B20`, `0C0DA029`, `02C4A9CB`, `892AC322` | `02352E6C`, `C3CE5B20`, `0C0DA029`, `02C4A9CB`, `892AC322` | Unchanged rankings, but `qwen_text` evidence is now present. |
| 栗 text | `0C0DA029`, `FA6BF8D4`, `628B1F09`, `42069045`, `1FAEEECE` | `0C0DA029`, `FA6BF8D4`, `628B1F09`, `5FB4EC26`, `1FAEEECE` | Top 3 unchanged. `5FB4EC26` replaced `42069045` at rank 4. |
| Visual anchor | `C3CE5B20`, `0C0DA029`, `02C4A9CB`, `FA6BF8D4`, `3F8739DE` | `C3CE5B20`, `0C0DA029`, `02C4A9CB`, `FA6BF8D4`, `3F8739DE` | Unchanged. |

## Observations

- `qwen_text` now appears in text-bearing modes: hybrid queries 1 and 2, multimodal query 4, and text query 5.
- Pure visual query 3 and visual anchor query 6 correctly show only `qwen_visual` among Qwen scores.
- The NaN fix changed hybrid/text rankings modestly, mainly in lower top-5 positions. Pure visual and visual-anchor rankings did not change.
- The direct symlinked frame path is accepted by `image_query_path` validation and resolves to the golden project frame cache realpath.
- Backward-compatible text search still returns the obvious chestnut clip `SEG_AST_628B1F09_0001` at rank 3 for `栗`, matching the previous rank.

## Errors And Unexpected Behavior

- None observed in this rerun.
- Build warnings: none.
- Search warnings: none across all 6 cases.

## Performance

| Step | Time / Latency |
| --- | ---: |
| Full DB rebuild | 165.72s real |
| Text-to-visual hybrid: 温かみのある光のシーン | 6485.3 ms |
| Visual mood hybrid: 静かな自然の風景 | 103.2 ms |
| Image-to-image visual search | 401.7 ms |
| Multimodal text + image search | 334.6 ms |
| Backward compatibility text search: 栗 | 89.4 ms |
| Visual anchor search | 10.8 ms |

