# Scene Continuity Verification: ena-promo-ai

Date: 2026-06-20 JST

Project: `projects/ena-promo-ai`

## 1. Pipeline summary

Command:

```bash
DOTENV_CONFIG_PATH=.env.local NODE_OPTIONS="-r dotenv/config" HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 VOS_QWEN3VL_CACHE_DIR=$HOME/.cache/huggingface/hub VOS_QWEN3VL_REQUEST_TIMEOUT_MS=120000 npx tsx scripts/editorial-pipeline.ts --project projects/ena-promo-ai
```

Artifacts cleared before the run:

- `projects/ena-promo-ai/04_plan/selects_candidates.yaml`
- `projects/ena-promo-ai/04_plan/edit_blueprint.yaml`
- `projects/ena-promo-ai/04_plan/visual_search_trace.json`
- `projects/ena-promo-ai/05_timeline/timeline.json`
- `projects/ena-promo-ai/09_output/rough-cut.mp4`

Result:

- Pipeline completed visual retrieval, rough pass, fine pass, compile, and render.
- Wall time: `3:09.29` (`user 320.69s`, `sys 25.14s`).
- Render succeeded; no `--skip-render` fallback was needed.
- After render, the parent process remained alive on `python/qwen3vl_embedding_worker.py`; I sent SIGTERM to that worker and the pipeline shell exited with status 0.

Visual retrieval trace:

- Trace path: `projects/ena-promo-ai/04_plan/visual_search_trace.json`
- Query count: 6
- `qwen_visual` occurrences in trace JSON: 48
- Generated selects: 19 candidates

## 2. Timeline metrics

Timeline path: `projects/ena-promo-ai/05_timeline/timeline.json`

Frame rate: 24fps

| Metric | Value |
| --- | ---: |
| Video clips | 19 |
| Target duration | 2160 frames / 90.00s |
| Timeline span | 2090 frames / 87.08s |
| Total content | 1556 frames / 64.83s |
| Content fill ratio | 0.720370 |
| Compiler `duration_status` | `short` |
| Compiler gap frames | 604 frames / 25.17s |
| Same-beat internal gaps | 0 |
| Cross-beat gaps | 4 gaps / 534 frames |
| Tail shortfall to 90s target | 70 frames / 2.92s |

Beat fill:

| Beat | Clips | Content frames | Seconds | Fill ratio |
| --- | ---: | ---: | ---: | ---: |
| `b01_hook` | 3 | 198 | 8.25 | 0.916667 |
| `b02_discovery` | 5 | 300 | 12.50 | 0.555556 |
| `b03_immersion` | 4 | 303 | 12.63 | 0.561111 |
| `b04_climax` | 4 | 501 | 20.88 | 0.927778 |
| `b05_closing` | 3 | 254 | 10.58 | 0.783951 |

Cross-beat and tail gaps:

| Gap | Frames | Seconds |
| --- | ---: | ---: |
| `b01_hook` -> `b02_discovery` | 18 | 0.75 |
| `b02_discovery` -> `b03_immersion` | 240 | 10.00 |
| `b03_immersion` -> `b04_climax` | 237 | 9.88 |
| `b04_climax` -> `b05_closing` | 39 | 1.63 |
| `b05_closing` tail to 90s target | 70 | 2.92 |

Compared with the saved 82.9s baseline from `/tmp/ena-promo-ai-previous-829-timeline.json`, duration coverage regressed:

| Metric | Previous 82.9s run | New run |
| --- | ---: | ---: |
| Clips | 18 | 19 |
| Content frames | 1990 | 1556 |
| Content seconds | 82.92 | 64.83 |
| Content fill ratio | 0.921296 | 0.720370 |
| Span seconds | 93.71 | 87.08 |
| Gap frames to target/span | 259 | 604 |

The older 58.625s investigation report (`reports/timeline-gap-investigation-ena-promo.md`) preserved metrics but not a full per-beat segment sequence, so the order comparison below uses the saved 82.9s timeline as the concrete before-order baseline.

## 3. Render analysis

Render output:

- Path: `projects/ena-promo-ai/09_output/rough-cut.mp4`
- Render stdout: 19 clips, 15 crossfades, 57.3s, 34.32 MB
- `ffprobe` duration: `57.291667s`
- `ffprobe` size: `35,990,457` bytes

The MP4 is shorter than the raw content duration because the run emitted 15 crossfades. Roughly 7.5s of overlap explains the gap between 64.83s of placed content and the 57.29s rendered file.

## 4. Visual coherence scores

Visual coherence is measured with the available Qwen visual embeddings for adjacent clips. Random baseline is the expected adjacent-pair similarity for a random permutation of the same clips within each beat.

| Scope | Previous 82.9s order | New order | Random expected | Change |
| --- | ---: | ---: | ---: | ---: |
| All adjacent pairs | 0.790 | 0.801 | 0.790 | +0.011 vs previous |
| Same-beat adjacent pairs | 0.775 | 0.807 | 0.790 | +0.032 vs previous; +0.017 vs random |
| Cross-beat adjacent pairs | 0.840 | 0.780 | n/a | -0.059 vs previous |

Transition record scores from `projects/ena-promo-ai/05_timeline/adjacency_analysis.json`:

| Metric | Value |
| --- | ---: |
| Adjacent transition records | 18 |
| Average `visual_coherence_score` | 0.801 |
| Min `visual_coherence_score` | 0.689 |
| Max `visual_coherence_score` | 0.884 |
| `crossfade` transitions | 15 |
| `cut` transitions | 3 |
| Visual hints: `dissolve` | 13 |
| Visual hints: none | 5 |

Per-beat visual coherence:

| Beat | Previous score | New score | Random expected | Assessment |
| --- | ---: | ---: | ---: | --- |
| `b01_hook` | 0.706 | 0.725 | 0.726 | Slightly better than previous, effectively random |
| `b02_discovery` | 0.821 | 0.831 | 0.810 | Improved |
| `b03_immersion` / previous `b03_climax` | 0.823 | 0.807 | 0.788 | Above random, lower than previous |
| `b04_climax` / previous `b04_serenity` | 0.759 | 0.803 | 0.779 | Improved |
| `b05_closing` / previous `b05_invitation` | 0.727 | 0.845 | 0.831 | Strongly improved vs previous, modestly above random |

## 5. Before/after clip order

| Beat | Previous clip sequence | New clip sequence | Visual coherence improvement? |
| --- | --- | --- | --- |
| 1 | `SEG_AST_FA1D3DB5_0001` -> `SEG_AST_937E9DF3_0001` -> `SEG_AST_867607E9_0001` | `SEG_AST_FA1D3DB5_0001` -> `SEG_AST_937FB047_0001` -> `SEG_AST_937E9DF3_0001` | Yes, small: 0.706 -> 0.725 |
| 2 | `SEG_AST_DB9645BB_0001` -> `SEG_AST_B28FF61E_0001` -> `SEG_AST_842E9AB2_0001` -> `SEG_AST_02C4A9CB_0001` -> `SEG_AST_1FAEEECE_0001` | `SEG_AST_599E59BD_0001` -> `SEG_AST_DB9645BB_0001` -> `SEG_AST_6BE56C81_0001` -> `SEG_AST_FD61F7FD_0001` -> `SEG_AST_C331F618_0001` | Yes: 0.821 -> 0.831 |
| 3 | `SEG_AST_0C0DA029_0001` -> `SEG_AST_892AC322_0001` -> `SEG_AST_5FB4EC26_0001` | `SEG_AST_0C0DA029_0001` -> `SEG_AST_30B96D6D_0001` -> `SEG_AST_54328ECB_0001` -> `SEG_AST_064CCC70_0001` | No vs previous: 0.823 -> 0.807; still above random |
| 4 | `SEG_AST_FA6BF8D4_0001` -> `SEG_AST_FD61F7FD_0001` -> `SEG_AST_FCB9B51E_0001` -> `SEG_AST_BA264D3E_0001` | `SEG_AST_9258ECBB_0001` -> `SEG_AST_FA6BF8D4_0001` -> `SEG_AST_895EFDB7_0001` -> `SEG_AST_5872EEC6_0001` | Yes: 0.759 -> 0.803 |
| 5 | `SEG_AST_C2CE75D8_0001` -> `SEG_AST_064CCC70_0001` -> `SEG_AST_F87F37B6_0001` | `SEG_AST_02352E6C_0001` -> `SEG_AST_1FAEEECE_0001` -> `SEG_AST_867607E9_0001` | Yes: 0.727 -> 0.845 |

## 6. Per-beat ordering analysis

### `b01_hook`

Order:

1. `SEG_AST_FA1D3DB5_0001` - 2015-08-20 09:17 - rural landscape / human presence
2. `SEG_AST_937FB047_0001` - 2015-07-25 06:14 - greenhouse / serenity
3. `SEG_AST_937E9DF3_0001` - 2015-09-08 15:30 - traditional street / architecture

Assessment:

- Same-source adjacent pairs: 0/2.
- Same-session adjacent pairs: 0/2.
- Timestamp order has 1 backward jump.
- Visual coherence improved slightly over the previous order, but it is effectively equal to random expectation.
- Scene flow is still loose: nature -> greenhouse -> street, not a strong micro-story.

### `b02_discovery`

Order:

1. `SEG_AST_599E59BD_0001` - 2015-08-21 10:11 - kitchen / food preparation
2. `SEG_AST_DB9645BB_0001` - 2015-08-21 10:24 - traditional shop / local life
3. `SEG_AST_6BE56C81_0001` - 2015-09-07 16:57 - traditional street
4. `SEG_AST_FD61F7FD_0001` - 2015-09-07 18:11 - traditional interior / hospitality
5. `SEG_AST_C331F618_0001` - 2015-08-21 11:36 - vineyard / agriculture

Assessment:

- Same-source adjacent pairs: 0/4.
- Same-session adjacent pairs: 1/4 (`10:11` -> `10:24` on 2015-08-21).
- Timestamp order has 1 backward jump.
- Visual coherence improved over both previous order and random expectation.
- Scene flow is better than the previous mixed train/forest/interior sequence: kitchen -> shop -> street/interior -> vineyard. The final vineyard cut breaks strict chronology but stays within food/agriculture.

### `b03_immersion`

Order:

1. `SEG_AST_0C0DA029_0001` - 2015-07-25 05:36 - traditional interior / interaction
2. `SEG_AST_30B96D6D_0001` - 2015-08-20 09:19 - outdoor conversation
3. `SEG_AST_54328ECB_0001` - 2015-09-07 18:13 - meal presentation
4. `SEG_AST_064CCC70_0001` - 2015-08-21 06:08 - wooden sign / local detail

Assessment:

- Same-source adjacent pairs: 0/3.
- Same-session adjacent pairs: 0/3.
- Timestamp order has 1 backward jump.
- Visual coherence is above random but lower than the previous 82.9s order.
- Scene flow is thematic rather than temporal: human connection -> food -> local detail. It is not random, but it is not a clean scene/time cluster.

### `b04_climax`

Order:

1. `SEG_AST_9258ECBB_0001` - 2015-08-21 06:05 - indoor conversation
2. `SEG_AST_FA6BF8D4_0001` - 2015-07-25 06:17 - tomato picking
3. `SEG_AST_895EFDB7_0001` - 2015-08-21 09:35 - tea shop / craft
4. `SEG_AST_5872EEC6_0001` - 2015-08-21 10:09 - lantern detail

Assessment:

- Same-source adjacent pairs: 0/3.
- Same-session adjacent pairs: 0/3 by the 30-minute window, though the last two clips are both 2015-08-21 morning and visually/culturally related.
- Timestamp order has 1 backward jump.
- Visual coherence improved meaningfully over the previous order and random expectation.
- Scene flow is acceptable as a local-culture montage: person -> agriculture -> tea shop -> lantern. It is not scene-continuous in the strict filming-session sense.

### `b05_closing`

Order:

1. `SEG_AST_02352E6C_0001` - 2015-08-21 10:13 - interior man
2. `SEG_AST_1FAEEECE_0001` - 2015-09-07 18:01 - woman interior profile
3. `SEG_AST_867607E9_0001` - 2015-09-07 15:41 - train profile

Assessment:

- Same-source adjacent pairs: 0/2.
- Same-session adjacent pairs: 0/2.
- Timestamp order has 1 backward jump.
- Visual coherence improved strongly over the previous order and is slightly above random expectation.
- Scene flow is the clearest improvement: interior human presence -> interior/profile -> train/profile. The last two clips are visually similar, but the timestamp order is not chronological.

## 7. Temporal clustering summary

Strict temporal clustering did not materially improve.

| Metric | Previous 82.9s order | New order |
| --- | ---: | ---: |
| Same-source adjacent pairs | 0/13 | 0/14 |
| Same-session adjacent pairs | 0/13 | 1/14 |
| Timestamp backward jumps | 7/13 | 5/14 |

The new order has one real filming-session adjacency in `b02_discovery` and fewer backward timestamp jumps, but most beat-local transitions still jump across different dates and locations.

## 8. Assessment

Scene continuity improved, but only modestly and mostly through visual/thematic similarity rather than true time/session grouping.

What improved:

- Same-beat visual coherence improved from 0.775 to 0.807.
- The new same-beat ordering is above the random-within-beat expectation of 0.790.
- `b02_discovery`, `b04_climax`, and `b05_closing` are less jumbled thematically than the saved 82.9s baseline.
- There are no same-beat internal timing gaps; clips within each beat are contiguous.

What did not improve enough:

- Same-source grouping is still absent: 0 adjacent pairs use the same `asset_id`.
- Same-session grouping is nearly absent: only 1/14 same-beat adjacent pairs fall within the same camera/date 30-minute window.
- Chronology still jumps backward inside every beat.
- Cross-beat visual coherence worsened from 0.840 to 0.780.

Overall answer to the key question: clips are now somewhat grouped by visual similarity inside beats, but not reliably grouped by scene or chronological filming session. The result is less random than the previous jumbled order, but it is not yet strong scene-continuity ordering.

## 9. Remaining issues

1. Duration/fill regressed: the new run renders only 57.29s and has content fill ratio 0.720, much worse than the 82.9s baseline.
2. `b02_discovery` and `b03_immersion` are severely underfilled at 55.6% and 56.1%.
3. 15 crossfades shorten the rendered MP4 substantially relative to raw content duration.
4. Scene continuity appears to optimize visual adjacency, but does not enforce timestamp/session clustering strongly enough.
5. The Qwen worker still needs manual SIGTERM after render completion.
