# Editorial Pipeline Qwen Ena Promo Observation

## Summary

Run date: 2026-06-19 JST

Project: `projects/ena-promo-ai`

Requested scope: triage -> blueprint -> compile, observational only.

The canonical pipeline completed successfully through compile. I used the new Qwen visual-intent brief from `projects/ena-promo-ai/01_brief/creative_brief.yaml`; because `scripts/editorial-pipeline.ts` hardcodes `01_intent/creative_brief.yaml`, I backed up the old canonical intent brief to `projects/ena-promo-ai/01_intent/backup-pre-qwen/creative_brief.yaml` and copied the new brief into `01_intent/creative_brief.yaml` before running.

Pre-Qwen plan files were moved to:

- `projects/ena-promo-ai/04_plan/backup-pre-qwen/selects_candidates.yaml`
- `projects/ena-promo-ai/04_plan/backup-pre-qwen/edit_blueprint.yaml`

Command run:

```bash
DOTENV_CONFIG_PATH=.env.local NODE_OPTIONS="-r dotenv/config" \
  npx tsx scripts/editorial-pipeline.ts --project projects/ena-promo-ai --skip-render
```

I used `--skip-render` because the requested observation scope ended at compile. The run log was captured at `/tmp/ena-promo-qwen-editorial-pipeline-20260619T213855.log`.

Result:

- Rough pass: completed
- Fine pass: completed
- Compile: completed
- Pipeline post-compile schema validation: passed
- Timeline: `projects/ena-promo-ai/05_timeline/timeline.json`
- Runtime: `real 66.99`
- Non-fatal warnings: four clip-trim midpoint fallbacks for weak Marlin events

## Agent Tool Usage

Actual Qwen visual-search tool use was not observed.

Counts from log/artifact search:

- `visual_search`: 0 calls
- `search_footage` with `mode=visual`: 0 calls
- `search_footage` with `image_query_path`: 0 calls
- `similar_to`: 0 calls
- `qwen_visual` score evidence in generated plan/timeline: 0 occurrences

The generated selects do contain Qwen priority strings, but those are evidence text copied from or influenced by the brief, not tool-call traces. All 44 regenerated candidates include an evidence item beginning with `Qwen3-VL visual search priority:`.

Likely reason: the canonical pipeline invokes `roughCutPlanning()` and `fineCutRefinement()` in headless mode. In that mode, `runtime/agents/unified-editorial-agent.ts` calls `callGeminiJson()` with a JSON prompt and does not run an editorial-tool execution loop. The tool definitions are present in `runtime/tools/editorial-tools.ts`, and interactive prompts mention `visual_search`, `search_footage`, and `similar_to`, but the canonical headless pipeline did not execute those tools or emit per-tool traces.

## Selects Comparison

Old backup:

- Candidates: 43
- Unique segments: 42
- Roles: 35 `support`, 8 `texture`, 0 `hero`
- Project id: `ena-promo`

New regenerated selects:

- Candidates: 44
- Unique segments: 44
- Roles: 26 `support`, 14 `texture`, 4 `hero`
- Project id: `ena-promo-ai`

Overlap:

- Unique overlap: 31 segments
- Overlap as share of new unique selections: 70.5%
- Overlap as share of old unique selections: 73.8%

Newly added unique segments:

`SEG_AST_42069045_0001`, `SEG_AST_5872EEC6_0001`, `SEG_AST_628B1F09_0001`, `SEG_AST_C3CE5B20_0001`, `SEG_AST_C401279B_0001`, `SEG_AST_867607E9_0001`, `SEG_AST_937E9DF3_0001`, `SEG_AST_E4C3E126_0001`, `SEG_AST_DE0A9F85_0001`, `SEG_AST_35552908_0001`, `SEG_AST_6BE56C81_0001`, `SEG_AST_C2CE6439_0001`, `SEG_AST_937FB047_0001`

Removed unique segments:

`SEG_AST_2678B3E0_0001`, `SEG_AST_35871D01_0001`, `SEG_AST_54328ECB_0001`, `SEG_AST_5761722A_0001`, `SEG_AST_A0A53242_0001`, `SEG_AST_A6305A5C_0001`, `SEG_AST_02352E6C_0001`, `SEG_AST_0ABE9883_0001`, `SEG_AST_0C0DA029_0001`, `SEG_AST_3F8739DE_0001`, `SEG_AST_51371FAF_0001`

## Blueprint Structure

The regenerated blueprint has 5 beats totaling 2160 frames / 90.0 sec at 24 fps:

| Beat | Target | Required role | Primary segment | Candidate refs |
| --- | ---: | --- | --- | ---: |
| `b01_hook` | 9.0s | `hero` | `SEG_AST_0CBD2398_0001` | 2 |
| `b02_discovery` | 22.5s | `support` | `SEG_AST_3313BDC1_0001` | 15 |
| `b03_immersion` | 22.5s | `hero` | `SEG_AST_895EFDB7_0001` | 12 |
| `b04_climax` | 22.5s | `support` | `SEG_AST_30B96D6D_0001` | 4 |
| `b05_closing` | 13.5s | `texture` | `SEG_AST_B3E866CA_0001` | 2 |

Compiled timeline:

- Duration: 90.0 sec
- Video tracks: 2
- Audio tracks: 3
- Video clips: 18
- Beat markers: 5
- Compiler resolution: `duration_status=pass`, `duration_delta_frames=0`

One follow-up validation issue remains: full `validate-schemas` reports `b05_closing` requires `texture`, but the primary `texture` candidate `SEG_AST_B3E866CA_0001` is only marked eligible for `b02_discovery`. The compiler still emitted a valid 90-second timeline, so this is a planning consistency issue rather than a compile failure.

## Visual Search Influence

Evidence that the new brief influenced the artifacts:

- 44/44 regenerated candidates include `Qwen3-VL visual search priority` evidence text.
- Category counts in evidence:
  - `人の温かさが伝わるカット`: 22
  - `食文化`: 15
  - `自然の風景`: 14
  - `伝統工芸や文化的な営み`: 11
  - `静かで落ち着いた構図`: 5
  - `料理人の手元`: 2
  - `温かみのある光のシーン`: 1

Example evidence:

- `SEG_AST_0CBD2398_0001`: `representative frame shows a person smiling with produce`; `Qwen3-VL visual search priority: 温かみのある光のシーン, 人の温かさが伝わるカット`
- `SEG_AST_181A13B7_0001`: `representative frame shows a traditional Japanese meal`; `Qwen3-VL visual search priority: 食文化`
- `SEG_AST_2458305F_0001`: `representative frame shows a traditional Japanese street`; `Qwen3-VL visual search priority: 伝統工芸や文化的な営み`

Evidence missing:

- No generated artifact contains `qwen_visual` scores.
- No trace/log file records executed `visual_search`, `search_footage`, `similar_to`, `image_query_path`, or visual-anchor calls.
- The selection changes are real, but the available evidence supports prompt-level visual intent influence, not actual Qwen3-VL retrieval during selection.

## Recommendations

1. Add an actual tool-execution loop to the headless unified editorial agent, or add a deterministic pre-selection visual retrieval stage that calls `search_footage`/`visual_search` before LLM planning.
2. Emit an agent trace artifact under `04_plan/` recording tool name, args, result ids, scores, and selected-candidate linkage.
3. Add `--brief` support or formally promote `01_brief/creative_brief.yaml` into `01_intent/creative_brief.yaml` before planning, so the canonical route cannot silently use an older brief.
4. Tighten planning validation so blueprint `required_roles` and `candidate_plan` refs must match `eligible_beats`, especially for closing beats.
